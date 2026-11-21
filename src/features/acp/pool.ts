// Pool of warm persistent `agy acp` processes keyed by account/mode/sandbox/agent.
import type { PermissionMode, PluginConfig } from '../../common/types.ts'
import { slotGuardStats } from '../../domain/credentials/guards.ts'
import { AcpProcess, type AcpProcessOptions } from './client.ts'

/** Default grace window before a draining process is force-closed. */
const DEFAULT_DRAIN_MS = 10 * 60_000

export interface AcpDrainExpiredInfo {
  /** Pool keys of the processes that hit the drain deadline and were closed. */
  keys: readonly string[]
  /** Session ids that were still retained on those processes. */
  sessions: readonly string[]
  /** Why they were drained in the first place ('account-switch' | 'capacity'). */
  reason: string
}

export interface AcpDrainClosedInfo {
  keys: readonly string[]
  /** Sessions that were still retained when the process was closed. */
  sessions: readonly string[]
  reason: string
  /** True when the drain hit its budget instead of finishing on its own. */
  expired: boolean
}

export interface AcpPoolOptions {
  bin: () => string | null
  cfg: () => PluginConfig
  log?: (msg: string) => void
  maxProcesses?: number
  idleTtlMs?: number
  createProcess?: (opts: AcpProcessOptions) => AcpProcess
  /** Called when a drained process hits its deadline and had to be closed. */
  onDrainExpired?: (info: AcpDrainExpiredInfo) => void
  /**
   * Called whenever a draining process is closed (finished or expired). The
   * host uses it to put the primary credential back into the Windows slot.
   */
  onDrainClosed?: (info: AcpDrainClosedInfo) => void
  /** Called when the last live or draining process is gone. */
  onIdle?: () => void
}

interface DrainingEntry {
  proc: AcpProcess
  startedAt: number
  deadline: number
  reason: string
  /**
   * Sessions that still had background work on this process when it started
   * draining. Snapshotted here because the caller that reports the closure is
   * the very retain that just let go — by then the live refcount is gone, and
   * the host still needs to know WHICH sessions lost their background work.
   */
  sessions: readonly string[]
}

export class AcpSessionPool {
  private readonly procs = new Map<string, AcpProcess>()
  private readonly retainedSessions = new Map<string, number>()
  private readonly draining = new Map<string, DrainingEntry>()
  private readonly maxProcesses: number
  private readonly idleTtlMs: number
  private sweepTimer: NodeJS.Timeout | null = null
  private slotOverwriteDetectedCount = 0
  private lastSlotRecoveryAt: number | null = null

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
    if (this.procs.size === 0 && this.draining.size === 0 && this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
      try {
        this.opts.onIdle?.()
      } catch {
        /* a failing idle hook must not break the pool */
      }
    }
  }

  private keyFor(opts: { accountId?: string; mode: PermissionMode; sandbox: boolean; agent: string }): string {
    return `${opts.accountId || 'primary'}|${opts.mode}|${opts.sandbox ? '1' : '0'}|${opts.agent}`
  }

  /** Grace window for draining: the same budget background tasks get to finish. */
  private drainBudgetMs(): number {
    let minutes = 0
    try {
      minutes = this.opts.cfg().backgroundWakeupTtlMinutes
    } catch {
      minutes = 0
    }
    return minutes > 0 ? minutes * 60_000 : DEFAULT_DRAIN_MS
  }

  /**
   * Stop routing NEW requests to `key` while leaving the process alive so its
   * in-flight background work (scheduled timers, subagents, long commands) can
   * still report. Closing it outright would silently kill those tasks.
   */
  private drain(key: string, proc: AcpProcess, reason: string): void {
    const startedAt = Date.now()
    this.procs.delete(key)
    const sessions = this.sessionsOn(proc)
    this.draining.set(key, { proc, startedAt, deadline: startedAt + this.drainBudgetMs(), reason, sessions })
    proc.lastUsedAt = startedAt
    this.opts.log?.(`[acp-pool] draining ${key} (${reason}) — background work keeps running`)
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
    /** Account this process must authenticate as (gate 2 identity check). */
    expectedEmail?: string
  }): AcpProcess {
    if (process.platform === 'win32') {
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
      const victimKey = this.pickCapacityVictim()
      if (victimKey === null) break
      const victim = this.procs.get(victimKey)
      if (!victim) break
      if (this.hasRetainedSession(victim)) {
        // Never kill a process that still owes background work to a session.
        this.drain(victimKey, victim, 'capacity')
      } else {
        this.procs.delete(victimKey)
        victim.close()
      }
    }

    const procOpts: AcpProcessOptions = {
      bin: req.bin,
      cwd: req.cwd,
      ...(req.env ? { env: req.env } : {}),
      permissionMode: req.mode,
      sandbox: req.sandbox,
      ...(req.agent ? { agent: req.agent } : {}),
      ...(req.preemptAutoUpdate !== undefined ? { preemptAutoUpdate: req.preemptAutoUpdate } : {}),
      ...(req.expectedEmail ? { expectedEmail: req.expectedEmail } : {}),
      ...(this.opts.log ? { log: this.opts.log } : {}),
    }
    const proc = this.opts.createProcess ? this.opts.createProcess(procOpts) : new AcpProcess(procOpts)
    proc.once('exit', () => {
      if (this.procs.get(key) === proc) this.procs.delete(key)
      const drain = this.draining.get(key)
      if (drain?.proc === proc) this.draining.delete(key)
      this.stopSweepTimerIfEmpty()
    })
    this.procs.set(key, proc)
    this.ensureSweepTimer()
    return proc
  }

  /** Oldest process first, but idle (unretained) ones take priority over retained. */
  private pickCapacityVictim(): string | null {
    let oldestFree: string | null = null
    let oldestFreeAt = Infinity
    let oldestAny: string | null = null
    let oldestAnyAt = Infinity
    for (const [k, p] of this.procs) {
      if (p.lastUsedAt < oldestAnyAt) {
        oldestAnyAt = p.lastUsedAt
        oldestAny = k
      }
      if (!this.hasRetainedSession(p) && p.lastUsedAt < oldestFreeAt) {
        oldestFreeAt = p.lastUsedAt
        oldestFree = k
      }
    }
    return oldestFree ?? oldestAny
  }

  evictOtherAccounts(keepAccountId?: string): number {
    const prefix = `${keepAccountId || 'primary'}|`
    let evicted = 0
    for (const [k, p] of [...this.procs.entries()]) {
      if (k.startsWith(prefix)) continue
      if (this.hasRetainedSession(p)) {
        // Account switch: keep serving the old session's background work in a
        // draining slot, but never hand it new prompts (the credential slot now
        // holds the new account — a new prompt would bill the wrong account).
        this.drain(k, p, 'account-switch')
      } else {
        this.procs.delete(k)
        p.close()
      }
      evicted++
    }
    this.stopSweepTimerIfEmpty()
    return evicted
  }

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
      this.closeFinishedDrains()
    }
  }

  private hasRetainedSession(proc: AcpProcess): boolean {
    if (this.retainedSessions.size === 0) return false
    const fn = (proc as unknown as { hasOpenSession?: (sid: string) => boolean }).hasOpenSession
    if (typeof fn !== 'function') return false
    for (const sid of this.retainedSessions.keys()) {
      if (proc.hasOpenSession(sid)) return true
    }
    return false
  }

  /** Retained session ids that still have an open session on `proc`. */
  private sessionsOn(proc: AcpProcess): string[] {
    const out: string[] = []
    for (const sid of this.retainedSessions.keys()) {
      if (proc.hasOpenSession(sid)) out.push(sid)
    }
    return out
  }

  private fireDrainClosed(keys: readonly string[], sessions: readonly string[], reason: string, expired: boolean): void {
    try {
      this.opts.onDrainClosed?.({ keys, sessions, reason, expired })
    } catch {
      /* a failing hook must not break the pool sweep */
    }
  }

  /** Draining processes whose last retained session let go can be closed at once. */
  private closeFinishedDrains(now = Date.now()): number {
    let closed = 0
    for (const [k, entry] of [...this.draining.entries()]) {
      if (!entry.proc.isAlive()) {
        this.draining.delete(k)
        continue
      }
      if (!this.hasRetainedSession(entry.proc)) {
        this.draining.delete(k)
        const sessions = entry.sessions
        entry.proc.close()
        this.opts.log?.(`[acp-pool] closed drained ${k} — no background work left`)
        this.fireDrainClosed([k], sessions, entry.reason, false)
        closed++
      } else if (now >= entry.deadline) {
        this.draining.delete(k)
        const sessions = entry.sessions
        entry.proc.close()
        this.opts.log?.(
          `[acp-pool] drained ${k} hit its ${Math.round((now - entry.startedAt) / 1000)}s budget — force-closed`,
        )
        try {
          this.opts.onDrainExpired?.({ keys: [k], sessions, reason: entry.reason })
        } catch {
          /* a failing notice hook must not break the pool sweep */
        }
        this.fireDrainClosed([k], sessions, entry.reason, true)
        closed++
      }
    }
    this.stopSweepTimerIfEmpty()
    return closed
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
    evicted += this.closeFinishedDrains(now)
    this.stopSweepTimerIfEmpty()
    return evicted
  }

  /**
   * Drop a process that can no longer be trusted (a turn that died without a
   * single event). It is closed immediately — draining would only keep a broken
   * child alive — and its slot is freed for a fresh spawn.
   */
  discardProcess(proc: AcpProcess): void {
    for (const [k, p] of [...this.procs.entries()]) {
      if (p === proc) this.procs.delete(k)
    }
    for (const [k, entry] of [...this.draining.entries()]) {
      if (entry.proc === proc) this.draining.delete(k)
    }
    proc.close()
    this.stopSweepTimerIfEmpty()
  }

  /** Record that the credential slot was found holding a foreign account. */
  noteSlotOverwrite(): void {
    this.slotOverwriteDetectedCount += 1
  }

  /** Record that the primary credential was re-asserted into the slot. */
  noteSlotRecovery(at = Date.now()): void {
    this.lastSlotRecoveryAt = at
  }

  status(): {
    activeProcesses: number
    sessions: number
    keys: readonly string[]
    drainingProcesses: number
    drainingKeys: readonly string[]
    slotOverwriteDetectedCount: number
    lastSlotRecoveryAt: number | null
  } {
    let sessions = 0
    const keys: string[] = []
    for (const [k, p] of this.procs) {
      if (!p.isAlive()) continue
      sessions += p.sessionCount
      keys.push(k)
    }
    const drainingKeys = [...this.draining.keys()]
    // The credential-slot state machine observes overwrites/recoveries itself;
    // report the union so a host-level recovery is visible from this endpoint.
    const guards = slotGuardStats()
    return {
      activeProcesses: keys.length,
      sessions,
      keys,
      drainingProcesses: drainingKeys.length,
      drainingKeys,
      slotOverwriteDetectedCount: Math.max(this.slotOverwriteDetectedCount, guards.overwriteDetected),
      lastSlotRecoveryAt: Math.max(this.lastSlotRecoveryAt ?? 0, guards.lastRecoveryAt ?? 0) || null,
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const p of this.procs.values()) p.close()
    this.procs.clear()
    for (const entry of this.draining.values()) entry.proc.close()
    this.draining.clear()
  }
}