// Per-session state for the background wakeup watcher.
//
// Split out of watcher.ts so the ACP report half can be its own module: the two
// halves share exactly this shape and nothing else.
import type { WatchedTaskLog } from './brain-poll.ts'
import type { WakeNoticeItem } from './schedule-parse.ts'

export interface PendingScheduleTimer {
  key: string
  prompt: string
  timerCondition: string
  timer: NodeJS.Timeout
}

export interface SessionWatchState {
  sessionKey: string
  generation: number
  wakesUsed: number
  activeTurn: boolean
  expiresAt: number
  brainDir: string | null
  hasActiveTasks: boolean
  seenMessageKeys: Set<string>
  knownTaskLogs: Map<string, WatchedTaskLog>
  knownSubagents: Map<string, string>
  seenWakeKeys: Set<string>
  schedules: Map<string, PendingScheduleTimer>
  acpCleanups: Array<() => void>
  pendingNotices: WakeNoticeItem[]
  coalesceTimer: NodeJS.Timeout | null
  deferTimer: NodeJS.Timeout | null
  dispatching: boolean
  /** Accumulated post-turn ACP report text, flushed as one unit. */
  acpReportText: string
  acpReportTimer: NodeJS.Timeout | null
  /** Tool completions held back during the agent's own-report grace window. */
  acpDeferredTools: WakeNoticeItem[]
  acpToolGraceTimer: NodeJS.Timeout | null
  /**
   * Background tool calls that were still live when the last turn ended and
   * have not reported a terminal status yet. The ACP watch must survive until
   * this drains: dropping it on the first wake silently loses every later
   * completion of a command or subagent that outlives one turn.
   */
  acpOutstanding: Set<string>
  /**
   * Turn generation the accumulated report belongs to. A report may only be
   * delivered while the session is still on that generation: the flush awaits
   * the host, and a human turn that lands meanwhile owns the transcript now.
   */
  acpReportGen: number
  /** Last report text handed to the session; the brain-poll dedup baseline. */
  acpLastReport: string
  /** Pending release of the ACP watch once nothing is outstanding any more. */
  acpIdleTimer: NodeJS.Timeout | null
  /** Transcript seq that report was written at (0 when it went via a wake). */
  acpLastReportSeq: number
}

/** A fresh state block for one session. */
export function createWatchState(sessionKey: string): SessionWatchState {
  return {
    sessionKey,
    generation: 0,
    wakesUsed: 0,
    activeTurn: false,
    expiresAt: 0,
    brainDir: null,
    hasActiveTasks: false,
    seenMessageKeys: new Set(),
    knownTaskLogs: new Map(),
    knownSubagents: new Map(),
    seenWakeKeys: new Set(),
    schedules: new Map(),
    acpCleanups: [],
    pendingNotices: [],
    coalesceTimer: null,
    deferTimer: null,
    dispatching: false,
    acpReportText: '',
    acpReportTimer: null,
    acpDeferredTools: [],
    acpToolGraceTimer: null,
    acpOutstanding: new Set(),
    acpReportGen: 0,
    acpIdleTimer: null,
    acpLastReport: '',
    acpLastReportSeq: 0,
  }
}
