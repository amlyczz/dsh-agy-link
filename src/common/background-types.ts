// Leaf interfaces shared across host, provider, and features/background
// so background wake observation stays free of dependency cycles.
import type { AgyEvent, AgyTransportMode } from './types.ts'

export interface ReadableRecordingLike {
  readonly length: number
  readonly accountHome?: string
  readonly isSettled?: boolean
  eventAt(index: number): AgyEvent | undefined
  eventTimestampAt?(index: number): number | undefined
}

/**
 * The slice of `AcpProcess` a background watch needs: keep the session open
 * and listen to what it pushes after the turn returned.
 */
export interface RetainableAcpProcess {
  isAlive(): boolean
  subscribeSession(sessionId: string, listener: (update: Record<string, unknown>) => void): () => void
}

export interface BackgroundAttemptSettledInfo {
  readonly sessionKey: string
  readonly conversationId: string | null
  readonly accountHome?: string
  readonly transport: AgyTransportMode
  readonly recording: ReadableRecordingLike
  readonly failure: unknown
  readonly superseded: boolean
  readonly acpProcess?: RetainableAcpProcess
  readonly acpSessionId?: string
}

export interface BackgroundTurnObserver {
  onHumanTurn?(sessionKey: string): void
  onAttemptStart?(sessionKey: string): void
  onAttemptSettled?(info: BackgroundAttemptSettledInfo): void
}

export interface BackgroundWakeStatus {
  readonly enabled: boolean
  readonly activeWatches: number
  readonly pendingTimers: number
  readonly pendingTasks: number
  /** Post-turn ACP reports written straight into the session (no model re-read). */
  readonly directPresentations?: number
  /** Post-turn ACP reports that had to go through a followup turn. */
  readonly followupWakes?: number
  /** Background ACP tool calls still live after the turn (each reports later). */
  readonly pendingAcpTools?: number
  /**
   * Turns that ended on a status announcement ("正在运行 …，完成后立即 …") and
   * were answered with one bounded continuation nudge. Independent of
   * `backgroundWakeup`: a promise is not a result whether or not wakeups are on.
   */
  readonly announcementNudges?: number
}
