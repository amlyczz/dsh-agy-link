// The ACP half of the background wakeup watcher.
//
// An `agy acp` process outlives the turn: background commands, subagents and
// one-shot timers keep narrating after `session/prompt` returned. Those frames
// are the model's OWN words, so spending a fresh model turn to re-read them is
// pure waste — and on a busy session it doubles the visible reply (方案 A: write
// the report into the transcript directly). Only an armed goal or a host that
// cannot write into the transcript still needs a real wake.
//
// Split out of watcher.ts to keep both files inside the module size budget. The
// watcher supplies the shared plumbing through `AcpWatchHost`.
import type { BackgroundAttemptSettledInfo } from '../../common/background-types.ts'
import type { SessionWatchState } from './watch-state.ts'
import type { WakeNoticeItem } from './schedule-parse.ts'

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled'])

/** What this module needs from the watcher (structural, no circular import). */
export interface AcpWatchHost {
  readonly disposed: boolean
  readonly acpReportSilenceMs: number
  readonly acpReportUsageGraceMs: number
  readonly acpToolGraceMs: number
  readonly acpReportWindowMs: number
  log?(msg: string): void
  isArchived?(sessionKey: string): boolean
  presentAcpReport?: (sessionKey: string, text: string) => Promise<boolean | number>
  hasArmedGoal?: (sessionKey: string) => boolean | Promise<boolean>
  retainAcpSession?: (sessionId: string, sessionKey: string) => () => void
  enqueueWake(st: SessionWatchState, item: WakeNoticeItem): void
  releaseAcp(st: SessionWatchState): void
  cancelMatchingScheduleTimers(st: SessionWatchState, item: WakeNoticeItem): void
  /** Count one report that went straight into the transcript (no wake spent). */
  countDirectPresentation(): void
}

/** Subscribe to the process's post-turn stream and retain the session. */
export function attachAcpWatch(
  host: AcpWatchHost,
  st: SessionWatchState,
  proc: NonNullable<BackgroundAttemptSettledInfo['acpProcess']>,
  sid: string,
  turnGen: number,
  outstanding: readonly string[] = [],
): void {
  host.releaseAcp(st)
  st.acpReportText = ''
  st.acpReportGen = turnGen
  st.acpDeferredTools = []
  st.acpOutstanding = new Set(outstanding)
  const unsub = proc.subscribeSession(sid, (update) => {
    if (host.disposed || st.generation !== turnGen || st.activeTurn) return
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    if (kind === 'tool_call_update') onToolUpdate(host, st, turnGen, update)
    else if (kind === 'agent_message_chunk') {
      const content = update.content as { text?: unknown } | undefined
      const text = typeof content?.text === 'string' ? content.text : ''
      if (text !== '') {
        // 方案 A: merge every chunk of one post-turn report into a single
        // delivery instead of waking once per chunk. Whitespace-only chunks are
        // kept: a lone "\n\n" is a paragraph break, and dropping it glued
        // separate paragraphs together.
        st.acpReportText += text
        armAcpReportFlush(host, st, turnGen, host.acpReportSilenceMs)
      }
    } else if (kind === 'usage_update') {
      // A usage_update is the last frame of an autonomous report burst, so it
      // can shorten the silence window without cutting the text short.
      if (st.acpReportText.trim() !== '') armAcpReportFlush(host, st, turnGen, host.acpReportUsageGraceMs)
    }
  })
  st.acpCleanups.push(unsub)
  if (st.acpIdleTimer !== null) {
    clearTimeout(st.acpIdleTimer)
    st.acpIdleTimer = null
  }
  if (host.retainAcpSession) st.acpCleanups.push(host.retainAcpSession(sid, st.sessionKey))
}

function onToolUpdate(
  host: AcpWatchHost,
  st: SessionWatchState,
  turnGen: number,
  update: Record<string, unknown>,
): void {
  const status = typeof update.status === 'string' ? update.status.toLowerCase() : ''
  if (!TERMINAL_TOOL_STATUS.has(status)) return
  const title = typeof update.title === 'string' && update.title !== '' ? update.title : 'ACP background tool'
  const callId = typeof update.toolCallId === 'string' ? update.toolCallId : title
  const wakeKey = `acp-tool:${callId}:${status}`
  if (st.seenWakeKeys.has(wakeKey)) return
  st.seenWakeKeys.add(wakeKey)
  // A terminal status is the only proof that this call is done. Only then may
  // the ACP watch be released — after the report window.
  st.acpOutstanding.delete(callId)
  if (st.acpOutstanding.size === 0) armAcpIdleRelease(host, st, turnGen)
  const item: WakeNoticeItem = {
    kind: 'acp',
    label: `${title} (${status})`,
    detail: `ACP tool ${status}`,
    sender: callId,
  }
  // The agent usually narrates its own completion right after the tool
  // finishes. Hold the mechanical notice for a short grace window: if that
  // narration arrives it becomes the single report, and the tool notice is
  // dropped instead of racing it into a second wake.
  st.acpDeferredTools.push(item)
  if (st.acpToolGraceTimer !== null) return
  st.acpToolGraceTimer = setTimeout(() => {
    st.acpToolGraceTimer = null
    if (host.disposed || st.generation !== turnGen || st.activeTurn) return
    const pending = st.acpDeferredTools.splice(0, st.acpDeferredTools.length)
    for (const it of pending) host.enqueueWake(st, it)
  }, host.acpToolGraceMs)
  st.acpToolGraceTimer.unref?.()
}

/**
 * Nothing is outstanding any more, but the agent has not spoken yet. Hold the
 * watch open for a short window so its own narration still reaches the session;
 * if the window closes silently, release everything.
 */
export function armAcpIdleRelease(host: AcpWatchHost, st: SessionWatchState, turnGen: number): void {
  if (st.acpIdleTimer !== null) clearTimeout(st.acpIdleTimer)
  st.acpIdleTimer = setTimeout(() => {
    st.acpIdleTimer = null
    if (host.disposed || st.generation !== turnGen) return
    if (st.acpOutstanding.size > 0 || st.schedules.size > 0 || st.acpReportTimer !== null) return
    st.hasActiveTasks = false
    host.releaseAcp(st)
  }, host.acpReportWindowMs)
  st.acpIdleTimer.unref?.()
}

/**
 * (Re)arm the single delivery timer for the accumulated post-turn report. Every
 * new chunk pushes the deadline back, so one burst of 1–4 chunks is delivered
 * exactly once, after the burst has gone quiet.
 */
export function armAcpReportFlush(
  host: AcpWatchHost,
  st: SessionWatchState,
  turnGen: number,
  delayMs: number,
): void {
  if (st.acpReportTimer !== null) clearTimeout(st.acpReportTimer)
  st.acpReportTimer = setTimeout(() => {
    st.acpReportTimer = null
    if (host.disposed || st.generation !== turnGen || st.activeTurn) return
    void flushAcpReport(host, st)
  }, delayMs)
  st.acpReportTimer.unref?.()
}

/**
 * 方案 A: hand the agent's own post-turn report to the session.
 *
 * Two cases still need a real turn: an armed goal (only a model turn advances
 * it) and a host that cannot write into the transcript.
 */
export async function flushAcpReport(host: AcpWatchHost, st: SessionWatchState): Promise<void> {
  const text = st.acpReportText.trim()
  if (text === '') return
  st.acpReportText = ''
  // The agent already narrated what these tools did; the mechanical notices
  // would only repeat it.
  st.acpDeferredTools = []
  if (st.acpToolGraceTimer !== null) {
    clearTimeout(st.acpToolGraceTimer)
    st.acpToolGraceTimer = null
  }
  const reportGen = st.acpReportGen
  const goalArmed = await Promise.resolve(host.hasArmedGoal?.(st.sessionKey) ?? false).catch(() => false)
  // Both awaits above can outlive the session state they were armed for: a
  // human turn may have started (and taken the transcript over), or the whole
  // watch may have been cleared. Re-check before writing anything.
  if (!stillOwns(host, st, reportGen)) return
  if (!goalArmed && host.presentAcpReport) {
    const shown = await host.presentAcpReport(st.sessionKey, text).catch(() => false as const)
    if (!stillOwns(host, st, reportGen)) return
    if (shown !== false) {
      st.acpLastReport = text
      st.acpLastReportSeq = typeof shown === 'number' ? shown : 0
      host.countDirectPresentation()
      host.log?.(`[background-wakeup] presented ACP report directly in session=${st.sessionKey} (${text.length} chars)`)
      // agy already narrated the timer that just fired, so the fallback wake
      // timer for the same schedule would only repeat it.
      host.cancelMatchingScheduleTimers(st, {
        kind: 'acp',
        label: 'ACP post-turn report',
        detail: text.slice(0, 240),
      })
      // A direct presentation spends no wake, so it must release the watch
      // itself once nothing else is still running.
      if (st.schedules.size === 0 && st.acpOutstanding.size === 0) {
        st.hasActiveTasks = false
        host.releaseAcp(st)
      }
      return
    }
  }
  st.acpLastReport = text
  host.enqueueWake(st, {
    kind: 'acp',
    label: goalArmed ? 'ACP post-turn report (goal armed)' : 'ACP post-turn message',
    detail: text.slice(0, 240),
  })
}

/** The watch is still the one that armed this delivery. */
export function stillOwns(host: AcpWatchHost, st: SessionWatchState, turnGen: number): boolean {
  return !host.disposed && st.generation === turnGen && !st.activeTurn && !host.isArchived?.(st.sessionKey)
}

/**
 * Record a report that was written into the transcript, plus the record seq it
 * landed at. agy ALSO writes the same narration into the conversation's
 * .system_generated/messages, so the brain-poll scanner sees it a second time
 * and would wake the model over a sentence the user already has on screen.
 */
export function noteAcpReport(st: SessionWatchState, text: string, seq: number): void {
  const want = text.trim()
  st.acpLastReport = want
  st.acpLastReportSeq = seq
  if (want === '') return
  if (st.acpReportText.trim() !== want) return
  // The same text is still queued for a wake: drop it, it is on screen now.
  st.acpReportText = ''
  if (st.acpReportTimer !== null) {
    clearTimeout(st.acpReportTimer)
    st.acpReportTimer = null
  }
}
