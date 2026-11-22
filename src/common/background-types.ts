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

export interface BackgroundAttemptSettledInfo {
  readonly sessionKey: string
  readonly conversationId: string | null
  readonly accountHome?: string
  readonly transport: AgyTransportMode
  readonly recording: ReadableRecordingLike
  readonly failure: unknown
  readonly superseded: boolean
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
}
