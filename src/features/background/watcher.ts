// Cross-turn background wakeup watcher: keeps one-shot `schedule` timers alive
// past the end of a turn and wakes the idle DSH session when they fire, via
// `sessionController.resolveAgent` + `agent.followup(createUserMessage(...))`.
//
// Slice 1 covers timers only. Detached task logs, brain messages, subagent
// completions, and ACP session retention arrive in later slices.
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  BackgroundAttemptSettledInfo,
  BackgroundTurnObserver,
  BackgroundWakeStatus,
} from '../../common/background-types.ts'
import type { PluginConfig } from '../../common/types.ts'
import {
  buildWakeupMessageText,
  extractAttemptBackgroundSignals,
  matchesTimerCondition,
  type WakeNoticeItem,
} from './schedule-parse.ts'

export interface AgentLike {
  readonly status?: string
  readonly inbox?: { readonly nextTurn?: ReadonlyArray<{ readonly source?: { readonly plugin?: unknown; readonly form?: unknown } }> }
  followup?(msg: ReturnType<typeof createUserMessage>): void
  whenIdle?(): Promise<void>
}

export interface BackgroundWakeWatcherOptions {
  getConfig: () => PluginConfig
  resolveAgent: (sessionId: string) => Promise<AgentLike | null>
  isArchived?: (sessionId: string) => boolean
  getActiveRun?: (sessionId: string) => { isSettled: boolean } | undefined
  log?: (msg: string) => void
  coalesceMs?: number
}

interface PendingScheduleTimer {
  key: string
  prompt: string
  timerCondition: string
  timer: NodeJS.Timeout
}

interface SessionWatchState {
  sessionKey: string
  generation: number
  wakesUsed: number
  activeTurn: boolean
  expiresAt: number
  seenWakeKeys: Set<string>
  schedules: Map<string, PendingScheduleTimer>
  pendingNotices: WakeNoticeItem[]
  coalesceTimer: NodeJS.Timeout | null
  deferTimer: NodeJS.Timeout | null
  dispatching: boolean
}

export class BackgroundWakeWatcher implements BackgroundTurnObserver {
  private readonly sessions = new Map<string, SessionWatchState>()
  private disposed = false
  private readonly coalesceMs: number

  constructor(private readonly opts: BackgroundWakeWatcherOptions) {
    this.coalesceMs = Math.max(20, opts.coalesceMs ?? 350)
  }

  private getOrCreateSession(sessionKey: string): SessionWatchState {
    let st = this.sessions.get(sessionKey)
    if (!st) {
      st = {
        sessionKey,
        generation: 0,
        wakesUsed: 0,
        activeTurn: false,
        expiresAt: 0,
        seenWakeKeys: new Set(),
        schedules: new Map(),
        pendingNotices: [],
        coalesceTimer: null,
        deferTimer: null,
        dispatching: false,
      }
      this.sessions.set(sessionKey, st)
    }
    return st
  }

  /** Reuse an existing state object (later slices keep the same record in a leaf module). */
  adopt(st: SessionWatchState): void {
    if (this.disposed) return
    const prev = this.sessions.get(st.sessionKey)
    if (prev !== undefined && prev !== st) this.clearSessionWatches(prev)
    this.sessions.set(st.sessionKey, st)
  }

  /**
   * Feed one background notice into a session's queue.
   *
   * Slice 1 only uses this for tests and for the TimerCondition cancel path;
   * later slices call it from the task-log / brain / ACP watchers.
   */
  noteNotice(sessionKey: string, item: WakeNoticeItem): void {
    if (this.disposed || sessionKey === '') return
    const cfg = this.opts.getConfig()
    if (!cfg.enabled || !cfg.backgroundWakeup) return
    const st = this.getOrCreateSession(sessionKey)
    this.enqueueWake(st, item)
  }

  onHumanTurn(sessionKey: string): void {
    if (this.disposed || sessionKey === '') return
    const st = this.sessions.get(sessionKey)
    if (!st) return
    st.generation += 1
    st.wakesUsed = 0
    this.clearSessionWatches(st)
  }

  onAttemptStart(sessionKey: string): void {
    if (this.disposed || sessionKey === '') return
    const st = this.getOrCreateSession(sessionKey)
    st.activeTurn = true
    if (st.deferTimer !== null) {
      clearTimeout(st.deferTimer)
      st.deferTimer = null
    }
  }

  onAttemptSettled(info: BackgroundAttemptSettledInfo): void {
    if (this.disposed || info.sessionKey === '') return
    const st = this.getOrCreateSession(info.sessionKey)
    st.activeTurn = false

    const cfg = this.opts.getConfig()
    if (!cfg.enabled || !cfg.backgroundWakeup) return
    if (this.opts.isArchived?.(info.sessionKey)) {
      this.clearSessionWatches(st)
      return
    }
    if (info.superseded || info.failure !== null) return

    const signals = extractAttemptBackgroundSignals(info.recording)
    if (signals.ignoredRecurringCron && info.transport === 'cli') {
      this.opts.log?.(`[background-wakeup] session=${info.sessionKey}: recurring cron schedule does not persist across CLI -p exit; use one-shot DurationSeconds`)
    }
    if (signals.schedules.length === 0) return

    const ttlMs = Math.max(1, cfg.backgroundWakeupTtlMinutes) * 60_000
    const maxScheduleDelay = signals.schedules.reduce((m, s) => Math.max(m, s.delayMs), 0)
    st.expiresAt = Math.max(st.expiresAt, Date.now() + Math.min(ttlMs, Math.max(ttlMs, maxScheduleDelay + 5_000)))

    const turnGen = st.generation
    for (const s of signals.schedules) {
      this.armScheduleTimer(st, turnGen, s.stepKey, Math.min(s.delayMs, ttlMs), s.prompt, s.timerCondition, info.transport)
    }
  }

  private armScheduleTimer(
    st: SessionWatchState,
    turnGen: number,
    key: string,
    delayMs: number,
    prompt: string,
    timerCondition: string,
    transport: string,
  ): void {
    const existing = st.schedules.get(key)
    if (existing) clearTimeout(existing.timer)
    // An ACP turn can be followed immediately by the next span; give the
    // session a moment to settle before the timer is allowed to fire.
    const effectiveDelay = transport === 'acp' ? delayMs + 2_000 : delayMs
    const timer = setTimeout(() => {
      st.schedules.delete(key)
      if (this.disposed || st.generation !== turnGen) return
      const wakeKey = `sched:${key}:${turnGen}`
      if (st.seenWakeKeys.has(wakeKey)) return
      st.seenWakeKeys.add(wakeKey)
      this.enqueueWake(st, {
        kind: 'schedule',
        label: 'Scheduled timer',
        detail: prompt,
      })
    }, effectiveDelay)
    timer.unref?.()
    st.schedules.set(key, { key, prompt, timerCondition, timer })
  }

  private cancelMatchingScheduleTimers(st: SessionWatchState, item: WakeNoticeItem): void {
    if (item.kind === 'schedule') return
    for (const [k, s] of Array.from(st.schedules.entries())) {
      if (matchesTimerCondition(s.timerCondition, item.sender ?? item.label)) {
        clearTimeout(s.timer)
        st.schedules.delete(k)
      }
    }
  }

  private enqueueWake(st: SessionWatchState, item: WakeNoticeItem): void {
    if (this.disposed || this.opts.isArchived?.(st.sessionKey)) return
    this.cancelMatchingScheduleTimers(st, item)
    st.pendingNotices.push(item)
    if (st.coalesceTimer !== null) return
    st.coalesceTimer = setTimeout(() => {
      st.coalesceTimer = null
      void this.tryDispatch(st.sessionKey)
    }, this.coalesceMs)
    st.coalesceTimer.unref?.()
  }

  private scheduleDefer(st: SessionWatchState, delayMs: number): void {
    if (this.disposed || st.deferTimer !== null) return
    st.deferTimer = setTimeout(() => {
      st.deferTimer = null
      void this.tryDispatch(st.sessionKey)
    }, delayMs)
    st.deferTimer.unref?.()
  }

  private async tryDispatch(sessionKey: string): Promise<void> {
    const st = this.sessions.get(sessionKey)
    if (!st || this.disposed || st.dispatching || st.pendingNotices.length === 0) return
    const cfg = this.opts.getConfig()
    if (!cfg.enabled || !cfg.backgroundWakeup || this.opts.isArchived?.(sessionKey)) {
      this.clearSessionWatches(st)
      return
    }
    const maxWakes = Math.max(1, cfg.backgroundWakeupMaxPerSession)
    if (st.wakesUsed >= maxWakes) {
      st.pendingNotices = []
      this.clearSessionWatches(st)
      this.opts.log?.(`[background-wakeup] session=${sessionKey}: reached max wakes (${maxWakes}); pausing until next human turn`)
      return
    }

    st.dispatching = true
    try {
      const liveRun = this.opts.getActiveRun?.(sessionKey)
      if (liveRun && !liveRun.isSettled) {
        this.scheduleDefer(st, 1_500)
        return
      }
      const agent = await this.opts.resolveAgent(sessionKey).catch(() => null)
      if (!agent || typeof agent.followup !== 'function') {
        st.pendingNotices = []
        return
      }
      if (agent.status === 'running') {
        if (typeof agent.whenIdle === 'function') {
          void Promise.race([
            agent.whenIdle(),
            new Promise((r) => setTimeout(r, 2_000)),
          ]).then(() => this.tryDispatch(sessionKey)).catch(() => undefined)
        } else {
          this.scheduleDefer(st, 1_500)
        }
        return
      }
      const nextTurn = agent.inbox?.nextTurn
      if (Array.isArray(nextTurn) && nextTurn.some((m) => m?.source?.plugin === 'agy-link' && m?.source?.form === 'notice')) {
        return
      }

      const items = st.pendingNotices.splice(0, st.pendingNotices.length)
      const { summary, text } = buildWakeupMessageText(items)
      const msg = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: 'agy-link',
          form: 'notice',
          summary: boundContextSummary(summary),
        },
      })
      st.wakesUsed += 1
      agent.followup(msg)
      this.opts.log?.(`[background-wakeup] woken session=${sessionKey} (${summary})`)
    } finally {
      st.dispatching = false
    }
  }

  private clearSessionWatches(st: SessionWatchState): void {
    st.expiresAt = 0
    st.pendingNotices = []
    for (const s of st.schedules.values()) clearTimeout(s.timer)
    st.schedules.clear()
    if (st.coalesceTimer !== null) { clearTimeout(st.coalesceTimer); st.coalesceTimer = null }
    if (st.deferTimer !== null) { clearTimeout(st.deferTimer); st.deferTimer = null }
  }

  status(): BackgroundWakeStatus {
    const cfg = this.opts.getConfig()
    let pendingTimers = 0
    let activeWatches = 0
    for (const st of this.sessions.values()) {
      if (st.schedules.size > 0) activeWatches += 1
      pendingTimers += st.schedules.size
    }
    return {
      enabled: cfg.enabled && cfg.backgroundWakeup,
      activeWatches,
      pendingTimers,
      pendingTasks: 0,
    }
  }

  dispose(): void {
    this.disposed = true
    for (const st of this.sessions.values()) {
      this.clearSessionWatches(st)
    }
    this.sessions.clear()
  }
}
