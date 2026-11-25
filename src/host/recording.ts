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
import type { AgyEvent, RawUsage } from '../common/types.ts'
import {
  AGY_CALL_PREFIX,
  classifyToolError,
  hasUsageBreakdown,
  isConsumableResult,
  mergeSpanUsage,
  mirrorCallId,
  buildZeroDeltaUsage,
  isFinishableEvent,
  selectSpanUsage,
  usageBucketsOf,
  parseMirrorCallId,
  type EmittedUsageBuckets,
  type ToolErrorKind,
} from './recording-helpers.ts'

export {
  AGY_CALL_PREFIX,
  classifyToolError,
  hasUsageBreakdown,
  mirrorCallId,
  parseMirrorCallId,
  type ToolErrorKind,
}

/** Terminal failure recorded when the process ended without a usable result. */
export interface RecordingFailure {
  kind: 'error' | 'aborted'
  code: string
  message: string
  /**
   * Delay the failure asks DSH to wait before retrying (ms). Only transport
   * failures state one: the generic exponential schedule is far too short to
   * outlast an egress outage (see NETWORK_RETRY_DELAYS_MS).
   */
  retryAfterMs?: number
}

const waiters: unique symbol = Symbol('waiters')

/** One agy run's append-only event log plus its settlement state. */
export class RunRecording {
  readonly runId: string
  private readonly events: AgyEvent[] = []
  /** Arrival timestamp for every recorded event (same index as `events`). */
  private readonly eventTimes: number[] = []
  private settled = false
  private failure: RecordingFailure | null = null
  private resultConversationId: string | null = null
  private lastStepUsageRaw: RawUsage | null = null
  /**
   * Unconsumed per-span usage merged across internal LLM responses within the
   * current DSH span (issue #161):
   *   - Prompt-side fields (`input_tokens`, `cache_read_tokens`, `cache_write_tokens`,
   *     `total_tokens`) take the LAST call so `contextPressure` never doubles.
   *   - Generation-side fields (`output_tokens`, `thinking_tokens`) sum across
   *     distinct `stepKey`s (replacing if the same `stepKey` updates cumulatively).
   * Consumed once by the first cut/result so parallel tool cuts 2..N never
   * double-bill the same LLM call.
   */
  private pendingSpanUsage: RawUsage | null = null
  private readonly pendingSpanStepGen = new Map<string, { output: number; thinking: number }>()
  private anyUsageEmitted = false
  private lastEmittedUsageBuckets: EmittedUsageBuckets | null = null
  /**
   * Per-step generation timing for token-speed statistics: stepKey ->
   * { startedAt, lastAt, outputTokens }. The last usage sample of a step wins
   * (updates are cumulative snapshots of one internal call), so replacing —
   * not accumulating — keeps the numbers honest.
   */
  private readonly stepSpeed = new Map<string, { startedAt: number; lastAt: number; outputTokens: number }>()
  private [waiters] = new Set<() => void>()
  /** DB-resolved full tool args keyed by event index (set during span driving). */
  private fullArgs: Map<number, Record<string, unknown>> | null = null
  /** DB-resolved thoughts keyed by event index (set during span driving). */
  private thoughts: Map<number, string> | null = null
  /** Isolated pool-account HOME used for this run's agy conversation DB. */
  accountHome: string | undefined = undefined

  /**
   * Index of the event where the most recent span CUT (the last event the
   * previous run_code call yielded), or null while no span has finished on
   * this recording. Lets the duplicate-request debounce RESCUE an identical
   * prompt by re-driving the live recording from the cut point instead of
   * throwing BUSY at a mid-flight agentic turn (2026-10-10 23:0x incident:
   * a span whose mirror result did not parse as a continuation fell through
   * to full prompt assembly and the debounce killed the whole turn).
   */
  lastCutIndex: number | null = null

  /**
   * Set by the adapter right after spawn. A mid-turn user steer makes DSH
   * open a NEW stream() call for the same session while this run's process
   * is still alive; without aborting it, two agy processes would append to
   * the SAME conversation concurrently.
   */
  private abortRequested = false
  requestAbort: (() => void) | null = null
  get isAbortRequested(): boolean { return this.abortRequested }
  markAbortRequested(): void { this.abortRequested = true }

  constructor(runId: string = randomUUID(), private readonly now: () => number = Date.now) {
    this.runId = runId
  }

  /** Append one pump event and wake every span consumer. */
  append(ev: AgyEvent): void {
    if (this.settled) return
    this.events.push(ev)
    const now = this.now()
    this.eventTimes.push(now)
    if (ev.kind === 'result') this.resultConversationId = ev.conversationId ?? null
    if (ev.kind === 'init' && typeof ev.conversationId === 'string' && ev.conversationId !== '') {
      // init can carry the conversation id before the result envelope; prefer
      // the earliest known id so continuation spans can resolve the agy DB.
      this.resultConversationId = this.resultConversationId ?? ev.conversationId
    }
    if (ev.kind === 'step' && ev.usage) {
      const out = typeof ev.usage.output_tokens === 'number' && Number.isFinite(ev.usage.output_tokens)
        ? ev.usage.output_tokens
        : 0
      if (out > 0) {
        const prev = this.stepSpeed.get(ev.stepKey)
        if (prev === undefined) this.stepSpeed.set(ev.stepKey, { startedAt: now, lastAt: now, outputTokens: out })
        else {
          prev.lastAt = now
          prev.outputTokens = out
        }
      }
    }
    this.wake()
  }

  /**
   * Token-speed statistics over the generation steps recorded so far
   * (tokens/second of model OUTPUT, thinking included where agy reports it).
   *
   * `avgTps` is the output-weighted mean (Σ tokens / Σ seconds) over steps
   * with a measurable window (≥ 500 ms); `lastTps` is the most recently
   * measured step. Tool-only and instantaneous steps are excluded, so the
   * numbers reflect actual generation speed rather than tool wait time.
   */
  speedStats(): {
    lastTps: number | null
    avgTps: number | null
    outputTokens: number
    measuredSteps: number
    generatingMs: number
  } {
    let tokens = 0
    let ms = 0
    let steps = 0
    let lastTps: number | null = null
    for (const s of this.stepSpeed.values()) {
      tokens += s.outputTokens
      const windowMs = s.lastAt - s.startedAt
      if (s.outputTokens > 0 && windowMs >= 500) {
        ms += windowMs
        steps++
      }
    }
    // `lastTps` comes from the LAST generation step in event-arrival order.
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]
      if (ev === undefined || ev.kind !== 'step') continue
      const s = this.stepSpeed.get(ev.stepKey)
      if (s === undefined) continue
      if (s.outputTokens > 0 && s.lastAt - s.startedAt >= 500) {
        lastTps = s.outputTokens / ((s.lastAt - s.startedAt) / 1000)
      }
      break
    }
    if (tokens === 0) {
      // No step ever reported output tokens (agy's ACP `usage_update` does not
      // carry them). Fall back to the run's own output count so the turn is not
      // reported as 0 tok/s; the window is the span from the first recorded
      // event to the last one, which is the closest honest denominator left.
      const envelope = this.envelopeOutputTokens()
      const spanMs = this.eventSpanMs()
      if (envelope > 0 && spanMs >= 500) {
        return {
          lastTps: envelope / (spanMs / 1000),
          avgTps: envelope / (spanMs / 1000),
          outputTokens: envelope,
          measuredSteps: 1,
          generatingMs: spanMs,
        }
      }
    }
    return {
      lastTps,
      avgTps: ms > 0 ? tokens / (ms / 1000) : null,
      outputTokens: tokens,
      measuredSteps: steps,
      generatingMs: ms,
    }
  }

  /** Output tokens reported by the last result envelope (0 when it has none). */
  private envelopeOutputTokens(): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]
      if (ev === undefined || ev.kind !== 'result' || ev.usage === undefined) continue
      const out = ev.usage.output_tokens
      return typeof out === 'number' && Number.isFinite(out) && out > 0 ? out : 0
    }
    return 0
  }

  /** Wall-clock span between the first and the last recorded event. */
  private eventSpanMs(): number {
    const first = this.eventTimes[0]
    const last = this.eventTimes[this.eventTimes.length - 1]
    if (first === undefined || last === undefined) return 0
    return last - first
  }

  /**
   * Usage accounting (verified against agy 1.1.16 stream-json): step_update
   * usage is PER-CALL (the current context size at that internal LLM call),
   * while the result envelope's usage is CUMULATIVE across the whole agy
   * conversation. DSH's token meter treats the last reported sample as
   * current context occupancy, so forwarding the cumulative result makes
   * pressure explode quadratically and fires compaction within a few turns.
   * We therefore remember the last per-call step sample and report IT at
   * result time instead of the cumulative envelope.
   */
  noteStepUsage(raw: RawUsage, stepKey?: string): void {
    this.lastStepUsageRaw = raw
    if (Object.keys(raw).length === 0) return
    const cur = this.pendingSpanUsage
    const key = stepKey && stepKey !== '' ? stepKey : `__anon_${this.pendingSpanStepGen.size}`
    const prevGen = this.pendingSpanStepGen.get(key)
    const nextOut = typeof raw.output_tokens === 'number' && Number.isFinite(raw.output_tokens) ? raw.output_tokens : 0
    const nextThink = typeof raw.thinking_tokens === 'number' && Number.isFinite(raw.thinking_tokens) ? raw.thinking_tokens : 0
    this.pendingSpanStepGen.set(key, { output: nextOut, thinking: nextThink })
    this.pendingSpanUsage = mergeSpanUsage(cur, raw, prevGen, nextOut, nextThink)
  }

  get lastUsage(): RawUsage | null {
    return this.lastStepUsageRaw
  }

  /**
   * Consume the pending usage for the current DSH span (issues #158 & #161).
   * Returns null when no unconsumed step usage exists (e.g. concurrent tool
   * cuts 2..N, empty tails, or failure with no sample), so callers omit the
   * `{ type: 'usage' }` chunk instead of double-billing or flashing 0/0.
   * When a bare input-only sample was recorded and a full result envelope
   * arrived, yield to the envelope so context occupancy never shadows real
   * cached-read / output counts.
   */
  consumeSpanUsage(resultRaw?: RawUsage): RawUsage | null {
    const pending = this.pendingSpanUsage
    if (pending !== null) {
      this.pendingSpanUsage = null
      this.pendingSpanStepGen.clear()
    }
    const out = selectSpanUsage(pending, resultRaw, this.anyUsageEmitted)
    if (out !== null) {
      this.anyUsageEmitted = true
      this.lastEmittedUsageBuckets = usageBucketsOf(out)
    }
    return out
  }

  /** Zero-delta bucket-preserving usage for concurrent tool cuts 2..N (#210). */
  zeroDeltaUsageForCut(): RawUsage | null {
    return this.anyUsageEmitted ? buildZeroDeltaUsage(this.lastEmittedUsageBuckets) : null
  }

  /**
   * The usage to report for the result envelope: the last per-call step sample
   * when it actually carries a token breakdown, otherwise the envelope's own
   * usage (issue #158).
   *
   * The sample is only preferred when it reports output / cache / thinking
   * tokens. A sample that carries nothing but an input figure is a context
   * occupancy reading, not a usage sample: agy's ACP `usage_update` sends
   * `{ used, size }`, and promoting that to `{inputTokens: used, outputTokens: 0}`
   * used to shadow the real `PromptResponse.usage` (0% cache hit, 0 tok/s,
   * inflated uncached input — issue #158).
   */
  finalUsage(resultRaw: RawUsage): RawUsage {
    const step = this.lastStepUsageRaw
    if (step === null) return resultRaw
    return hasUsageBreakdown(step) ? step : resultRaw
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
    // NOT `resultConversationId !== null`: `init` sets that id from the very
    // first frame, which made this true before any result envelope arrived and
    // turned the synthetic result on an idle-grace kill into dead code
    // (issue #124). Conversation-id lookups use `conversationId` instead.
    return this.events.some((e) => e.kind === 'result')
  }

  /** Whether a result event that EventMapper will finish on (ok, or non-empty consumable error response) was recorded. */
  get hasConsumableResult(): boolean {
    const r = this.getResultEvent()
    return r !== null && isConsumableResult(r)
  }

  /**
   * Whether any recorded event at or after `from` can finish a span cleanly
   * (a consumable result envelope, or a completed tool step when `cutOnTool`
   * is enabled). A settled recording with `failureInfo === null` and no such
   * event would otherwise replay `INVALID_OUTPUT: agy stream ended without a
   * result event` on every continuation retry.
   */
  hasFinishableEventFrom(from: number, cutOnTool = true): boolean {
    for (let i = Math.max(0, from); i < this.events.length; i++) {
      const ev = this.events[i]
      if (ev !== undefined && isFinishableEvent(ev, cutOnTool)) return true
    }
    return false
  }

  /** The last result envelope's finish-relevant projection, when one arrived. */
  getResultEvent(): { ok: boolean; response: string; error?: string } | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]
      if (ev !== undefined && ev.kind === 'result') {
        return {
          ok: ev.ok,
          response: ev.response,
          ...(ev.error === undefined ? {} : { error: ev.error }),
        }
      }
    }
    return null
  }

  /**
   * True when at least one consumable `result` event (`ok` or non-empty
   * `response`, excluding hard quota / policy errors) exists at index >= `from`.
   */
  hasConsumableResultFrom(from: number): boolean {
    const start = Math.max(0, from)
    for (let i = start; i < this.events.length; i++) {
      const ev = this.events[i]
      if (ev !== undefined && ev.kind === 'result' && isConsumableResult(ev)) {
        return true
      }
    }
    return false
  }

  /** Event at an absolute index (bounds-checked). */
  eventAt(index: number): AgyEvent | undefined {
    return this.events[index]
  }

  /** Arrival timestamp (ms) of the event at `index`, when recorded. */
  eventTimestampAt(index: number): number | undefined {
    return this.eventTimes[index]
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
    const full = this.fullArgs?.get(eventIndex)
    if (full !== undefined && full !== null) {
      // Merge DB-resolved args (which include the content fields agy strips
      // from the stream) over the stream-carried args. Stream fields win so the
      // mirror always sees the freshest live values.
      return { ...ev.tool, args: { ...full, ...(typeof ev.tool.args === 'object' ? ev.tool.args as Record<string, unknown> : {}) } }
    }
    return ev.tool
  }

  /** Raw errors reported by completed agy tool steps, in event order. */
  toolErrors(): string[] {
    const errors: string[] = []
    for (const ev of this.events) {
      if (ev.kind === 'step' && ev.stepKind === 'tool' && ev.tool?.error !== undefined) {
        errors.push(ev.tool.error)
      }
    }
    return errors
  }

  /** Store full DB-resolved tool args for a step (set during span driving). */
  setFullArgs(eventIndex: number, args: Record<string, unknown>): void {
    this.fullArgs ??= new Map()
    this.fullArgs.set(eventIndex, args)
  }

  /** Store DB-resolved thoughts for a step (set during span driving). */
  setThoughts(eventIndex: number, text: string): void {
    this.thoughts ??= new Map()
    this.thoughts.set(eventIndex, text)
  }

  /** Retrieve DB-resolved thoughts for a step if previously resolved. */
  getThoughts(eventIndex: number): string | undefined {
    return this.thoughts?.get(eventIndex)
  }
}

/** Full-args resolver injected into RunRecording (set in RunRegistry.create). */
export type FullArgsResolver = (eventIndex: number) => Promise<Record<string, unknown> | null>

const MAX_RETAINED_RUNS = 8

/**
 * Bounded registry keeping the most recent runs for continuation spans.
 *
 * Eviction is deliberately conservative: a run is only dropped when it is
 * SETTLED, UNPINNED and is not the most recently used entry. A wedged agy
 * tool step can keep a run alive for hours while other DSH sessions create
 * their own runs (flash-blast incident, 2026-10-10): a pure FIFO cap evicted
 * that run mid-flight, and the mirror call the span had already queued —
 * `agy_tool({run, step})` — could no longer be resolved, so the model lost
 * the tool result and burned the turn debugging the bridge instead.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecording>()
  /** runId -> pin count while a span is actively driving that recording. */
  private readonly pinned = new Map<string, number>()

  create(): RunRecording {
    const rec = new RunRecording()
    this.remember(rec)
    return rec
  }

  /**
   * Insert a run, or refresh one that is about to be consumed again (a
   * continuation span re-registers its recording so a long-lived run is the
   * most recent entry and survives the eviction that follows its cut).
   */
  remember(rec: RunRecording): void {
    // Map.set keeps an existing key's original position, so delete first to
    // make this a true most-recently-used refresh.
    if (this.runs.has(rec.runId)) this.runs.delete(rec.runId)
    this.runs.set(rec.runId, rec)
    this.evict()
  }

  get(runId: string): RunRecording | undefined {
    return this.runs.get(runId)
  }

  /**
   * Pin a run for the duration of a span drive. Pinned (and unsettled) runs
   * are exempt from eviction, so a span that waits hours for a wedged tool
   * step can still resolve the mirror calls it emits afterwards.
   */
  pin(runId: string): void {
    this.pinned.set(runId, (this.pinned.get(runId) ?? 0) + 1)
  }

  unpin(runId: string): void {
    const n = this.pinned.get(runId)
    if (n === undefined) return
    if (n <= 1) this.pinned.delete(runId)
    else this.pinned.set(runId, n - 1)
  }

  /** Drop a settled run early (called when its final span finished stop). */
  forget(runId: string): void {
    this.runs.delete(runId)
    this.pinned.delete(runId)
  }

  /** Retained run ids, oldest first (diagnostics / tests). */
  get runIds(): readonly string[] {
    return [...this.runs.keys()]
  }

  /** Number of retained runs. */
  get size(): number {
    return this.runs.size
  }

  /** Number of currently pinned run ids (diagnostics / tests). */
  get pinnedCount(): number {
    return this.pinned.size
  }

  /**
   * Trim back to the cap without ever breaking an in-flight run: evict the
   * oldest SETTLED, UNPINNED entry, never the most recent one (the next
   * mirror dispatch or continuation addresses it). Live (unsettled) and
   * pinned runs are exempt, so the registry may temporarily exceed the cap
   * while several runs are in flight — strictly better than failing a replay.
   */
  private evict(): void {
    while (this.runs.size > MAX_RETAINED_RUNS) {
      let newest: string | undefined
      for (const id of this.runs.keys()) newest = id
      let victim: string | undefined
      for (const [id, rec] of this.runs) {
        if (id === newest) continue
        if (!rec.isSettled) continue
        if (this.pinned.has(id)) continue
        victim = id
        break
      }
      if (victim === undefined) return
      this.runs.delete(victim)
    }
  }
}
