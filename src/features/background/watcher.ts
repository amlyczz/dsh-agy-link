// Cross-turn background wakeup watcher: keeps one-shot `schedule` timers,
// detached task-log / subagent completions, and persistent ACP updates able to
// wake an idle DSH session cleanly via `sessionController.resolveAgent` +
// `agent.followup(createUserMessage(...))`.
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  BackgroundAttemptSettledInfo,
  BackgroundTurnObserver,
  BackgroundWakeStatus,
} from '../../common/background-types.ts'
import type { PluginConfig } from '../../common/types.ts'
import { findBrainDir } from '../../runtime/agy/db/paths.ts'
import { attachAcpWatch, noteAcpReport, type AcpWatchHost } from './acp-watch.ts'
import { baselineSessionBrain, pollSessionBrainDir } from './brain-poll.ts'
import {
  buildWakeupMessageText,
  extractAttemptBackgroundSignals,
  matchesTimerCondition,
  type WakeNoticeItem,
} from './schedule-parse.ts'
import { createWatchState, type SessionWatchState } from './watch-state.ts'

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
  /**
   * Keep an ACP session retained so its background work can still report.
   * `sessionKey` is the DSH session the transcript belongs to; drain notices
   * need it because agy's own session id means nothing to the host.
   */
  retainAcpSession?: (sessionId: string, sessionKey: string) => () => void
  /**
   * 方案 A: write an ACP post-turn report straight into the session transcript.
   * Returns true when the host accepted it, in which case no model turn is
   * spent re-reading text the agent already produced. Returning false (host
   * without a writable session, or a failed append) degrades to exactly one
   * coalesced followup — never one wake per chunk.
   */
  presentAcpReport?: (sessionId: string, text: string) => Promise<boolean | number>
  /**
   * True when the session holds an armed goal. Goal-driven sessions always get
   * a real turn: a goal is only advanced by the model reading the report.
   */
  hasArmedGoal?: (sessionId: string) => boolean | Promise<boolean>
  log?: (msg: string) => void
  pollIntervalMs?: number
  coalesceMs?: number
  /** Silence after the last agent_message_chunk before the report is delivered. */
  acpReportSilenceMs?: number
  /** Shortened window used once a usage_update proves the report is complete. */
  acpReportUsageGraceMs?: number
  /** Grace window after a post-turn tool completion, for the agent's own report. */
  acpToolGraceMs?: number
  /**
   * How long the ACP watch stays armed after the last thing it was waiting for
   * reported. The agent narrates its own completion a beat later; releasing the
   * watch the instant the tool call lands loses that sentence.
   */
  acpReportWindowMs?: number
}

export class BackgroundWakeWatcher implements BackgroundTurnObserver, AcpWatchHost {
  private readonly sessions = new Map<string, SessionWatchState>()
  private pollTimer: NodeJS.Timeout | null = null
  disposed = false
  private readonly pollIntervalMs: number
  private readonly coalesceMs: number

  readonly acpReportSilenceMs: number
  readonly acpReportUsageGraceMs: number
  readonly acpToolGraceMs: number
  readonly acpReportWindowMs: number
  private directPresentations = 0
  private followupWakes = 0

  get log(): (msg: string) => void {
    return (msg: string) => this.opts.log?.(msg)
  }

  get presentAcpReport(): ((sessionKey: string, text: string) => Promise<boolean | number>) | undefined {
    return this.opts.presentAcpReport
  }

  get hasArmedGoal(): ((sessionKey: string) => boolean | Promise<boolean>) | undefined {
    return this.opts.hasArmedGoal
  }

  get retainAcpSession(): ((sessionId: string, sessionKey: string) => () => void) | undefined {
    return this.opts.retainAcpSession
  }

  isArchived(sessionKey: string): boolean {
    return this.opts.isArchived?.(sessionKey) ?? false
  }

  countDirectPresentation(): void {
    this.directPresentations += 1
  }

  constructor(private readonly opts: BackgroundWakeWatcherOptions) {
    this.pollIntervalMs = Math.max(50, opts.pollIntervalMs ?? 2_500)
    this.coalesceMs = Math.max(20, opts.coalesceMs ?? 350)
    this.acpReportSilenceMs = Math.max(50, opts.acpReportSilenceMs ?? 700)
    this.acpReportUsageGraceMs = Math.max(50, opts.acpReportUsageGraceMs ?? 350)
    this.acpToolGraceMs = Math.max(0, opts.acpToolGraceMs ?? 2_200)
    this.acpReportWindowMs = Math.max(0, opts.acpReportWindowMs ?? 4_000)
  }

  private getOrCreateSession(sessionKey: string): SessionWatchState {
    let st = this.sessions.get(sessionKey)
    if (!st) {
      st = createWatchState(sessionKey)
      this.sessions.set(sessionKey, st)
    }
    return st
  }

  onHumanTurn(sessionKey: string): void {
    if (this.disposed || sessionKey === '') return
    const st = this.sessions.get(sessionKey)
    if (!st) return
    st.generation += 1
    st.wakesUsed = 0
    this.clearSessionWatches(st)
  }

  /**
   * Record a report that was written into the transcript, plus the record seq
   * it landed at. agy ALSO writes the same narration into the conversation's
   * .system_generated/messages, so the brain-poll scanner sees it a second time
   * and would wake the model over a sentence the user already has on screen.
   * The text is the cross-source dedup key; the seq lets the digest tell the
   * card apart from the model turn.
   */
  noteAcpReport(sessionKey: string, text: string, seq: number): void {
    const st = this.sessions.get(sessionKey)
    if (!st) return
    noteAcpReport(st, text, seq)
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
      this.opts.log?.(`[background-wakeup] session=${info.sessionKey}: recurring cron schedule does not persist across CLI -p exit; use one-shot DurationSeconds or ACP transport`)
    }

    const ttlMs = Math.max(1, cfg.backgroundWakeupTtlMinutes) * 60_000
    const brainDir = info.conversationId ? findBrainDir(info.conversationId, info.accountHome) : null
    if (brainDir) st.brainDir = brainDir

    const aliveSubagents = brainDir ? this.baselineBrainDir(st, brainDir) : false
    const hasPendingTasks = signals.backgroundTools.length > 0 || aliveSubagents
    const maxScheduleDelay = signals.schedules.reduce((m, s) => Math.max(m, s.delayMs), 0)
    const watchWindow = Math.min(ttlMs, Math.max(ttlMs, maxScheduleDelay + 5_000))

    const keepsAcpAlive = hasPendingTasks || signals.schedules.length > 0
    if (signals.schedules.length === 0 && !hasPendingTasks) {
      // Nothing new to watch — but a previous turn's background tool may still
      // be live, or a report may still be waiting out its silence window.
      // Releasing here would silence the rest of its reports.
      if (
        st.schedules.size === 0
        && !st.hasActiveTasks
        && st.acpOutstanding.size === 0
        && st.acpReportTimer === null
        && st.acpToolGraceTimer === null
      ) {
        this.releaseAcp(st)
      }
      return
    }

    st.expiresAt = Math.max(st.expiresAt, Date.now() + watchWindow)
    st.hasActiveTasks = st.hasActiveTasks || hasPendingTasks

    const turnGen = st.generation
    for (const s of signals.schedules) {
      this.armScheduleTimer(st, turnGen, s.stepKey, Math.min(s.delayMs, ttlMs), s.prompt, s.timerCondition, info.transport)
    }

    // Keep the ACP session retained whenever ANYTHING is still outstanding —
    // a background task, a live subagent, or a pending one-shot timer. A pure
    // timer used to fall through here, so the process could be reaped by the
    // pool before the timer fired and the wake was lost.
    if (info.transport === 'acp' && info.acpProcess && info.acpSessionId && keepsAcpAlive) {
      const outstanding = signals.backgroundTools.map((t) => t.stepKey)
      this.attachAcpWatch(st, info.acpProcess, info.acpSessionId, turnGen, outstanding)
    }

    if (hasPendingTasks && st.brainDir) {
      this.ensurePollLoop()
    }
  }

  private baselineBrainDir(st: SessionWatchState, brainDir: string): boolean {
    return baselineSessionBrain(st, brainDir)
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

  private attachAcpWatch(
    st: SessionWatchState,
    proc: NonNullable<BackgroundAttemptSettledInfo['acpProcess']>,
    sid: string,
    turnGen: number,
    outstanding: readonly string[] = [],
  ): void {
    attachAcpWatch(this, st, proc, sid, turnGen, outstanding)
  }

  private ensurePollLoop(): void {
    if (this.pollTimer !== null || this.disposed) return
    this.pollTimer = setInterval(() => this.pollAll(), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPollLoopIfIdle(): void {
    const anyActive = Array.from(this.sessions.values()).some((s) => s.hasActiveTasks && !s.activeTurn)
    if (!anyActive && this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  pollNow(): void {
    this.pollAll()
  }

  private pollAll(): void {
    if (this.disposed) return
    const cfg = this.opts.getConfig()
    if (!cfg.enabled || !cfg.backgroundWakeup) return
    const now = Date.now()
    for (const st of Array.from(this.sessions.values())) {
      if (this.opts.isArchived?.(st.sessionKey)) {
        this.clearSessionWatches(st)
        continue
      }
      if (st.expiresAt > 0 && now > st.expiresAt) {
        this.clearSessionWatches(st)
        continue
      }
      if (!st.hasActiveTasks || st.activeTurn || !st.brainDir) continue
      this.pollSessionBrain(st, st.brainDir)
    }
    this.stopPollLoopIfIdle()
  }

  private pollSessionBrain(st: SessionWatchState, brainDir: string): void {
    const delivered = st.acpLastReport === '' ? [] : [st.acpLastReport]
    const res = pollSessionBrainDir(st, brainDir, (item) => this.enqueueWake(st, item), delivered)
    if (res.stoppedByServer) {
      st.hasActiveTasks = false
      this.releaseAcp(st)
    }
  }

  cancelMatchingScheduleTimers(st: SessionWatchState, item: WakeNoticeItem): void {
    if (item.kind === 'schedule') return
    for (const [k, s] of Array.from(st.schedules.entries())) {
      if (matchesTimerCondition(s.timerCondition, item.sender ?? item.label)) {
        clearTimeout(s.timer)
        st.schedules.delete(k)
      }
    }
  }

  enqueueWake(st: SessionWatchState, item: WakeNoticeItem): void {
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
      // Keep the ACP watch while any background tool call is still live. One
      // wake is not the end of the turn's work: an 18s command and a subagent
      // each report separately, and releasing here dropped every report after
      // the first (the timer wake beat the command's own completion).
      if (st.schedules.size === 0 && st.acpOutstanding.size === 0) {
        st.hasActiveTasks = false
        this.releaseAcp(st)
      }
      this.followupWakes += 1
      agent.followup(msg)
      this.opts.log?.(`[background-wakeup] woken session=${sessionKey} (${summary})`)
    } finally {
      st.dispatching = false
      this.stopPollLoopIfIdle()
    }
  }

  releaseAcp(st: SessionWatchState): void {
    for (const fn of st.acpCleanups.splice(0, st.acpCleanups.length)) {
      try { fn() } catch { /* ignore */ }
    }
  }

  private clearSessionWatches(st: SessionWatchState): void {
    st.hasActiveTasks = false
    st.expiresAt = 0
    st.acpOutstanding.clear()
    st.pendingNotices = []
    st.acpReportText = ''
    st.acpReportGen = 0
    st.acpDeferredTools = []
    if (st.acpReportTimer !== null) { clearTimeout(st.acpReportTimer); st.acpReportTimer = null }
    if (st.acpToolGraceTimer !== null) { clearTimeout(st.acpToolGraceTimer); st.acpToolGraceTimer = null }
    if (st.acpIdleTimer !== null) { clearTimeout(st.acpIdleTimer); st.acpIdleTimer = null }
    for (const s of st.schedules.values()) clearTimeout(s.timer)
    st.schedules.clear()
    if (st.coalesceTimer !== null) { clearTimeout(st.coalesceTimer); st.coalesceTimer = null }
    if (st.deferTimer !== null) { clearTimeout(st.deferTimer); st.deferTimer = null }
    this.releaseAcp(st)
    this.stopPollLoopIfIdle()
  }

  status(): BackgroundWakeStatus {
    const cfg = this.opts.getConfig()
    let pendingTimers = 0
    let pendingTasks = 0
    let pendingAcpTools = 0
    let activeWatches = 0
    for (const st of this.sessions.values()) {
      if (st.schedules.size > 0 || st.hasActiveTasks) activeWatches += 1
      pendingTimers += st.schedules.size
      if (st.hasActiveTasks) pendingTasks += 1
      if (st.acpOutstanding.size > 0) pendingAcpTools += st.acpOutstanding.size
    }
    return {
      enabled: cfg.enabled && cfg.backgroundWakeup,
      activeWatches,
      pendingTimers,
      pendingTasks,
      directPresentations: this.directPresentations,
      followupWakes: this.followupWakes,
      pendingAcpTools,
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    for (const st of this.sessions.values()) {
      this.clearSessionWatches(st)
    }
    this.sessions.clear()
  }
}
