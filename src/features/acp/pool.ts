// Pool of warm persistent `agy acp` processes keyed by account/mode/sandbox/agent.
import type { PermissionMode, PluginConfig } from '../../common/types.ts'
import { AcpProcess, type AcpProcessOptions } from './client.ts'

export interface AcpPoolOptions {
  bin: () => string | null
  cfg: () => PluginConfig
  log?: (msg: string) => void
  maxProcesses?: number
  idleTtlMs?: number
  createProcess?: (opts: AcpProcessOptions) => AcpProcess
}

export class AcpSessionPool {
  private readonly procs = new Map<string, AcpProcess>()
  /**
   * Sessions pinned by a live background watch. Reference counted so two
   * watchers on the same session cannot release each other's pin.
   */
  private readonly retainedSessions = new Map<string, number>()
  private readonly maxProcesses: number
  private readonly idleTtlMs: number
  private sweepTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: AcpPoolOptions) {
    this.maxProcesses = opts.maxProcesses ?? 4
    this.idleTtlMs = opts.idleTtlMs ?? 15 * 60_000
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer !== null) return
    this.sweepTimer = setInterval(() => this.evictIdle(), 60_000)
    this.sweepTimer.unref?.()
  }

  private stopSweepTimerIfEmpty(): void {
    if (this.procs.size === 0 && this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  private keyFor(opts: { accountId?: string; mode: PermissionMode; sandbox: boolean; agent: string }): string {
    return `${opts.accountId || 'primary'}|${opts.mode}|${opts.sandbox ? '1' : '0'}|${opts.agent}`
  }

  acquireProcess(req: {
    bin: string
    cwd: string
    env?: NodeJS.ProcessEnv
    accountId?: string
    mode: PermissionMode
    sandbox: boolean
    agent: string
    preemptAutoUpdate?: boolean
    /** True when this process depends on the shared Windows Credential Manager slot (legacy agy < 1.5). */
    usesSharedSlot?: boolean
  }): AcpProcess {
    if (process.platform === 'win32' && req.usesSharedSlot === true) {
      this.evictOtherAccounts(req.accountId)
    }
    const key = this.keyFor(req)
    const existing = this.procs.get(key)
    if (existing && existing.isAlive()) {
      existing.lastUsedAt = Date.now()
      return existing
    }
    if (existing) this.procs.delete(key)

    while (this.procs.size >= this.maxProcesses) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [k, p] of this.procs) {
        if (p.lastUsedAt < oldestAt) {
          oldestAt = p.lastUsedAt
          oldestKey = k
        }
      }
      if (!oldestKey) break
      const victim = this.procs.get(oldestKey)
      this.procs.delete(oldestKey)
      victim?.close()
    }

    const procOpts: AcpProcessOptions = {
      bin: req.bin,
      cwd: req.cwd,
      ...(req.env ? { env: req.env } : {}),
      permissionMode: req.mode,
      sandbox: req.sandbox,
      ...(req.agent ? { agent: req.agent } : {}),
      ...(req.preemptAutoUpdate !== undefined ? { preemptAutoUpdate: req.preemptAutoUpdate } : {}),
      ...(this.opts.log ? { log: this.opts.log } : {}),
    }
    const proc = this.opts.createProcess ? this.opts.createProcess(procOpts) : new AcpProcess(procOpts)
    proc.once('exit', () => {
      if (this.procs.get(key) === proc) this.procs.delete(key)
      this.stopSweepTimerIfEmpty()
    })
    this.procs.set(key, proc)
    this.ensureSweepTimer()
    return proc
  }

  /**
   * Pre-warm one idle ACP process for the given account/mode key so the next
   * turn adopts an already-initialized stdio server with zero startup delay.
   * Performs only the local JSON-RPC `initialize` handshake (zero model calls).
   */
  async warmSpare(req: {
    bin: string
    cwd: string
    env?: NodeJS.ProcessEnv
    accountId?: string
    mode: PermissionMode
    sandbox: boolean
    agent: string
    preemptAutoUpdate?: boolean
    usesSharedSlot?: boolean
  }): Promise<boolean> {
    const key = this.keyFor(req)
    const existing = this.procs.get(key)
    if (existing && existing.isAlive()) return true
    try {
      const proc = this.acquireProcess(req)
      await proc.ensureInitialized()
      return proc.isAlive()
    } catch {
      return false
    }
  }

  evictOtherAccounts(keepAccountId?: string): number {
    const prefix = `${keepAccountId || 'primary'}|`
    let evicted = 0
    for (const [k, p] of [...this.procs.entries()]) {
      if (!k.startsWith(prefix)) {
        this.procs.delete(k)
        p.close()
        evicted++
      }
    }
    this.stopSweepTimerIfEmpty()
    return evicted
  }

  /** Pin a session so the idle sweeper leaves its process alone; returns the release. */
  retainSession(sessionId: string): () => void {
    if (sessionId === '') return () => {}
    this.retainedSessions.set(sessionId, (this.retainedSessions.get(sessionId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const cur = this.retainedSessions.get(sessionId) ?? 0
      if (cur <= 1) this.retainedSessions.delete(sessionId)
      else this.retainedSessions.set(sessionId, cur - 1)
    }
  }

  /** True when this process hosts a pinned session (its background job is still running). */
  private hasRetainedSession(proc: AcpProcess): boolean {
    if (this.retainedSessions.size === 0) return false
    const fn = (proc as unknown as { hasOpenSession?: (sid: string) => boolean }).hasOpenSession
    if (typeof fn !== 'function') return false
    for (const sid of this.retainedSessions.keys()) {
      if (proc.hasOpenSession(sid)) return true
    }
    return false
  }

  evictIdle(now = Date.now()): number {
    let evicted = 0
    for (const [k, p] of [...this.procs.entries()]) {
      if (!p.isAlive() || (now - p.lastUsedAt > this.idleTtlMs && !this.hasRetainedSession(p))) {
        this.procs.delete(k)
        p.close()
        evicted++
      }
    }
    this.stopSweepTimerIfEmpty()
    return evicted
  }

  status(): { activeProcesses: number; sessions: number; keys: readonly string[] } {
    let sessions = 0
    const keys: string[] = []
    for (const [k, p] of this.procs) {
      if (!p.isAlive()) continue
      sessions += p.sessionCount
      keys.push(k)
    }
    return { activeProcesses: keys.length, sessions, keys }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const p of this.procs.values()) p.close()
    this.procs.clear()
  }
}
