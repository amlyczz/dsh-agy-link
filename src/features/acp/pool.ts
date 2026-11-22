// Pool of warm persistent `agy acp` processes keyed by account/mode/sandbox/agent.
import type { PermissionMode, PluginConfig } from '../../common/types.ts'
import { slotGuardStats } from '../../domain/credentials/guards.ts'
import { AcpProcess, type AcpProcessOptions } from './client.ts'

/** Default grace window before a draining process is force-closed. */
const DEFAULT_DRAIN_MS = 10 * 60_000
/**
 * How long a closed process gets to flush its own state before the tree is
 * killed. agy keeps its conversation in SQLite; `/F` straight away can cut a
 * write in half.
 */
const GRACEFUL_EXIT_MS = 400

/** One session still owed background work by a draining process. */
export interface AcpDrainSession {
  /** agy-side ACP session id (what the pool knows). */
  acpSessionId: string
  /** DSH session key the user actually sees ('' when unknown). */
  sessionKey: string
}

export interface AcpDrainExpiredInfo {
  /** Pool keys of the processes that hit the drain deadline and were closed. */
  keys: readonly string[]
  /** Sessions that were still retained on those processes. */
  sessions: readonly string[]
  /** Same sessions, with the DSH key needed to address the transcript. */
  targets: readonly AcpDrainSession[]
  /** Why they were drained in the first place ('account-switch' | 'capacity'). */
  reason: string
}

export interface AcpDrainClosedInfo {
  keys: readonly string[]
  /** Sessions that were still retained when the process was closed. */
  sessions: readonly string[]
  targets: readonly AcpDrainSession[]
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
   * host uses it to put the primary credential back into the Windows slot; it
   * must not raise its own user-visible notice (onDrainExpired owns that).
   */
  onDrainClosed?: (info: AcpDrainClosedInfo) => void
  /** Called when the last live or draining process is gone. */
  onIdle?: () => void
}

interface DrainingEntry {
  /** Unique per drain: a key can be drained more than once over a session. */
  id: string
  key: string
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
  sessions: readonly AcpDrainSession[]
}

interface RetainedSession {
  acpSessionId: string
  sessionKey: string
  count: number
}

export class AcpSessionPool {
  private readonly procs = new Map<string, AcpProcess>()
  /** Retained sessions keyed by agy session id, remembering the DSH session. */
  private readonly retainedSessions = new Map<string, RetainedSession>()
  private readonly draining = new Map<string, DrainingEntry>()
  private readonly maxProcesses: number
  private readonly idleTtlMs: number
  private sweepTimer: NodeJS.Timeout | null = null
  private drainSeq = 0
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
      this.fireIdle()
    }
  }

  private fireIdle(): void {
    try {
      this.opts.onIdle?.()
    } catch {
      /* a failing idle hook must not break the pool */
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
    this.drainSeq += 1
    // Keyed by a unique id, NOT by the pool key: the same account can be
    // drained twice (switch away, run background work again, switch again) and
    // keying by `key` used to overwrite — and orphan — the earlier entry.
    this.draining.set(`drain-${this.drainSeq}`, {
      id: `drain-${this.drainSeq}`,
      key,
      proc,
      startedAt,
      deadline: startedAt + this.drainBudgetMs(),
      reason,
      sessions,
    })
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
      const victimKey = this.pickCapacityVictim()
      if (victimKey === null) break
      const victim = this.procs.get(victimKey)
      if (!victim) break
      this.procs.delete(victimKey)
      if (this.hasRetainedSession(victim)) {
        // Never kill a process that still owes background work to a session:
        // hand it to the drain list, which keeps it alive until the work is done
        // (or its budget expires) and notifies that session either way.
        this.drain(victimKey, victim, 'capacity')
      } else {
        this.closeProc(victim, false)
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
      for (const [id, entry] of [...this.draining.entries()]) {
        if (entry.proc === proc) this.draining.delete(id)
      }
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

  /**
   * Close a process, giving it a short window to flush before the tree is
   * killed. `force` skips the window (a process we no longer trust).
   */
  private closeProc(proc: AcpProcess, force: boolean): void {
    if (force || !proc.isAlive()) {
      proc.close()
      return
    }
    const graceful = (proc as { closeGracefully?: (ms: number) => Promise<void> }).closeGracefully
    if (typeof graceful === 'function') {
      void graceful
        .call(proc, GRACEFUL_EXIT_MS)
        .catch(() => {
          try {
            proc.close()
          } catch {
            /* the process may already be gone */
          }
        })
      return
    }
    proc.close()
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
    expectedEmail?: string
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
      if (k.startsWith(prefix)) continue
      if (this.hasRetainedSession(p)) {
        // Account switch: keep serving the old session's background work in a
        // draining slot, but never hand it new prompts (the credential slot now
        // holds the new account — a new prompt would bill the wrong account).
        this.drain(k, p, 'account-switch')
      } else {
        this.procs.delete(k)
        this.closeProc(p, false)
      }
      evicted++
    }
    // Deliberately no stopSweepTimerIfEmpty() here: this runs at the START of
    // acquiring a process for the incoming account, so an empty pool is
    // transient and firing onIdle would race the new spawn into a slot restore.
    if (evicted > 0) this.ensureSweepTimer()
    return evicted
  }

  /**
   * Hold a session open across turns so its background work can still report.
   * `sessionKey` is the DSH session the user sees; drain notices need it
   * because the agy session id means nothing to the transcript service.
   */
  retainSession(acpSessionId: string, sessionKey = ''): () => void {
    if (acpSessionId === '') return () => {}
    const cur = this.retainedSessions.get(acpSessionId)
    if (cur) {
      cur.count += 1
      if (sessionKey !== '' && cur.sessionKey === '') cur.sessionKey = sessionKey
    } else {
      this.retainedSessions.set(acpSessionId, { acpSessionId, sessionKey, count: 1 })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const live = this.retainedSessions.get(acpSessionId)
      if (live) {
        if (live.count <= 1) this.retainedSessions.delete(acpSessionId)
        else live.count -= 1
      }
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

  /** Retained sessions that still have an open session on `proc`. */
  private sessionsOn(proc: AcpProcess): AcpDrainSession[] {
    const out: AcpDrainSession[] = []
    for (const [sid, info] of this.retainedSessions) {
      if (proc.hasOpenSession(sid)) out.push({ acpSessionId: sid, sessionKey: info.sessionKey })
    }
    return out
  }

  private fireDrainClosed(
    keys: readonly string[],
    targets: readonly AcpDrainSession[],
    reason: string,
    expired: boolean,
  ): void {
    try {
      this.opts.onDrainClosed?.({
        keys,
        sessions: targets.map((t) => t.acpSessionId),
        targets,
        reason,
        expired,
      })
    } catch {
      /* a failing hook must not break the pool sweep */
    }
  }

  /** Draining processes whose last retained session let go can be closed at once. */
  private closeFinishedDrains(now = Date.now()): number {
    let closed = 0
    for (const [id, entry] of [...this.draining.entries()]) {
      if (!entry.proc.isAlive()) {
        this.draining.delete(id)
        continue
      }
      if (!this.hasRetainedSession(entry.proc)) {
        this.draining.delete(id)
        const targets = entry.sessions
        this.closeProc(entry.proc, false)
        this.opts.log?.(`[acp-pool] closed drained ${entry.key} — no background work left`)
        this.fireDrainClosed([entry.key], targets, entry.reason, false)
        closed++
      } else if (now >= entry.deadline) {
        this.draining.delete(id)
        const targets = entry.sessions
        this.closeProc(entry.proc, true)
        this.opts.log?.(
          `[acp-pool] drained ${entry.key} hit its ${Math.round((now - entry.startedAt) / 1000)}s budget — force-closed`,
        )
        try {
          this.opts.onDrainExpired?.({
            keys: [entry.key],
            sessions: targets.map((t) => t.acpSessionId),
            targets,
            reason: entry.reason,
          })
        } catch {
          /* a failing notice hook must not break the pool sweep */
        }
        this.fireDrainClosed([entry.key], targets, entry.reason, true)
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
        this.closeProc(p, false)
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
    for (const [id, entry] of [...this.draining.entries()]) {
      if (entry.proc === proc) this.draining.delete(id)
    }
    this.closeProc(proc, true)
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
    const drainingKeys = [...this.draining.values()].map((e) => e.key)
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
