// RunRecording — the durable spine of native tool mirroring (v0.3).
//
// One agy child process maps to ONE recording. The process pump appends every
// normalized AgyEvent here; each DSH model call (a "span") consumes events
// monotonically from a message-derived cursor and stops at the next cut point
// (a completed tool step), emitting a native tool-call block + finish:tool-calls.
// DSH then dispatches the registered agy_tool mirror, which reads the recorded
// output by callId — so the tool card, its pending/result styling, and the
// turn/step bookkeeping all come from DSH's own machinery, not from text
// annotations (the v0.2.8/v0.2.9 presentations the user rejected).
//
// Event indices are append-only and stable, so callIds of the form
// `agytc-<runId>-<eventIndex>` are enough to re-derive a span cursor from the
// DSH message list alone — retries and replays stay idempotent with no
// mutable per-stream state.
import { randomUUID } from 'node:crypto'
import type { AgyEvent } from '../common/types.ts'

/** Terminal failure recorded when the process ended without a usable result. */
export interface RecordingFailure {
  kind: 'error' | 'aborted'
  code: string
  message: string
}

const waiters: unique symbol = Symbol('waiters')

/** One agy run's append-only event log plus its settlement state. */
export class RunRecording {
  readonly runId: string
  private readonly events: AgyEvent[] = []
  private settled = false
  private failure: RecordingFailure | null = null
  private resultConversationId: string | null = null
  private [waiters] = new Set<() => void>()

  constructor(runId: string = randomUUID()) {
    this.runId = runId
  }

  /** Append one pump event and wake every span consumer. */
  append(ev: AgyEvent): void {
    if (this.settled) return
    this.events.push(ev)
    if (ev.kind === 'result') this.resultConversationId = ev.conversationId ?? null
    this.wake()
  }

  /** Settle the recording: no further events will arrive. */
  settle(failure: RecordingFailure | null): void {
    if (this.settled) return
    this.settled = true
    this.failure = failure
    this.wake()
  }

  private wake(): void {
    for (const w of this[waiters]) w()
    this[waiters].clear()
  }

  get isSettled(): boolean {
    return this.settled
  }

  /** Terminal failure, when the run ended without a consumable result. */
  get failureInfo(): RecordingFailure | null {
    return this.failure
  }

  /** Conversation id from the result envelope, once seen. */
  get conversationId(): string | null {
    return this.resultConversationId
  }

  /** Whether a result event (ok or error-with-response) was recorded. */
  get hasResult(): boolean {
    return this.resultConversationId !== null || this.events.some((e) => e.kind === 'result')
  }

  /** The last result envelope's finish-relevant projection, when one arrived. */
  getResultEvent(): { ok: boolean; response: string } | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]
      if (ev !== undefined && ev.kind === 'result') return { ok: ev.ok, response: ev.response }
    }
    return null
  }

  /** Event at an absolute index (bounds-checked). */
  eventAt(index: number): AgyEvent | undefined {
    return this.events[index]
  }

  /** Number of recorded events so far. */
  get length(): number {
    return this.events.length
  }

  /**
   * Whether any assistant-visible text streamed before (not including) the
   * given index. Carried into each span's mapper so the result-envelope
   * fallback never duplicates text earlier spans already streamed.
   */
  sawTextBefore(index: number): boolean {
    for (let i = 0; i < Math.min(index, this.events.length); i++) {
      const ev = this.events[i]
      if (ev !== undefined && ev.kind === 'step' && ev.stepKind === 'text' && ev.text !== '') return true
    }
    return false
  }

  /**
   * Yield events at or after `from`, waiting for the pump while the run is
   * live. The iterator ends once every recorded event was yielded AND the
   * recording settled — spans then inspect failureInfo to finish or fail.
   */
  async *eventsFrom(from: number): AsyncGenerator<AgyEvent> {
    let cursor = from
    for (;;) {
      while (cursor < this.events.length) {
        yield this.events[cursor] as AgyEvent
        cursor++
      }
      if (this.settled) return
      await new Promise<void>((resolve) => {
        this[waiters].add(resolve)
      })
    }
  }

  /**
   * Recorded tool step for a mirror-tool call: the event at `eventIndex` must
   * be the completed tool step the callId was minted from.
   */
  toolEventAt(eventIndex: number): { name: string; args?: unknown; output?: unknown; error?: string } | null {
    const ev = this.events[eventIndex]
    if (ev === undefined || ev.kind !== 'step' || ev.stepKind !== 'tool' || !ev.tool) return null
    return ev.tool
  }
}

/** Prefix every mirrored agy tool callId carries; continuation detection key. */
export const AGY_CALL_PREFIX = 'agytc-'

/** Mint the callId for one recorded tool event. */
export function mirrorCallId(runId: string, eventIndex: number): string {
  return AGY_CALL_PREFIX + runId + '-' + String(eventIndex)
}

/** Parse a callId back into its run coordinates; null when not ours. */
export function parseMirrorCallId(callId: string): { runId: string; eventIndex: number } | null {
  if (!callId.startsWith(AGY_CALL_PREFIX)) return null
  const rest = callId.slice(AGY_CALL_PREFIX.length)
  // runId is a uuid (hyphens included), so split from the RIGHT: the last
  // hyphen separates the event index.
  const idx = rest.lastIndexOf('-')
  if (idx <= 0) return null
  const runId = rest.slice(0, idx)
  const n = Number(rest.slice(idx + 1))
  if (!Number.isSafeInteger(n) || n < 0) return null
  return { runId, eventIndex: n }
}

const MAX_RETAINED_RUNS = 8

/** Bounded registry keeping the most recent runs for continuation spans. */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecording>()

  create(): RunRecording {
    const rec = new RunRecording()
    this.remember(rec)
    return rec
  }

  remember(rec: RunRecording): void {
    this.runs.set(rec.runId, rec)
    while (this.runs.size > MAX_RETAINED_RUNS) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
    }
  }

  get(runId: string): RunRecording | undefined {
    return this.runs.get(runId)
  }

  /** Drop a settled run early (called when its final span finished stop). */
  forget(runId: string): void {
    this.runs.delete(runId)
  }
}
