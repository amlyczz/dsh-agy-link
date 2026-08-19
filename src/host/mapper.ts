// EventMapper: normalized agy events -> DSH StreamChunk protocol (spec
// section 3.3). Contract obligations honored here: usage precedes finish
// and nothing follows it; one content block open at a time; repeated step
// updates grow text by suffix-delta so both snapshot and delta payload
// styles stream correctly.
//
// v0.3 native tool mirroring: a COMPLETED agy tool step cuts the span —
// the mapper emits a tool-call block addressed to the registered agy_tool
// mirror and finishes with reason "tool-calls". DSH's agent loop then
// dispatches the mirror, records real tool/call + tool/result session
// events, and renders the activity with its native tool-card UI. The
// mirror returns instantly with the output agy already recorded, and the
// adapter's next span (a new stream() call) resumes from the message-
// derived cursor. Text/reasoning streaming and the result envelope behave
// as before; thinking-only turns stay token-annotated because agy print
// mode never streams the thoughts themselves.
import { CallId, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AgyEvent, RawUsage } from '../common/types.ts'
import { mirrorCallId } from './recording.ts'
import { buildMirrorRunCode, WRAPPER_TOOL_NAME } from './mirror-tool.ts'

export function usageFromRaw(raw: RawUsage): TokenUsage {
  // The DSH session layer rejects chunks carrying undefined-valued fields
  // (lossless-JSON boundary), so optional counters are omitted, not set to
  // undefined.
  const usage: TokenUsage = {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
  }
  if (raw.cache_read_tokens !== undefined) usage.cacheReadTokens = raw.cache_read_tokens
  if (raw.cache_write_tokens !== undefined) usage.cacheWriteTokens = raw.cache_write_tokens
  if (raw.thinking_tokens !== undefined) usage.reasoningTokens = raw.thinking_tokens
  return usage
}

/** Suffix-delta: emit only what grew; fall back to a newline + full text. */
export function suffixDelta(prev: string, next: string): string {
  if (next === prev) return ''
  if (prev === '') return next
  if (next.startsWith(prev)) return next.slice(prev.length)
  return '\n' + next
}

export interface EventMapperOptions {
  /** Run whose event indices mint mirror callIds. */
  runId: string
  /** Cut spans on completed tool steps (main turns). False for auxiliary calls. */
  cutOnTool: boolean
  /** Whether an earlier span of this run already streamed assistant text. */
  initialSawText?: boolean
}

export class EventMapper {
  private blockIdx = 0
  private openType: 'text' | 'reasoning' | null = null
  private openAcc = ''
  private readonly emittedByKey = new Map<string, string>()
  private readonly announcedTools = new Set<string>()
  private readonly thinkingAnnounced = new Set<string>()
  private sawTextStep: boolean
  private finished = false

  constructor(private readonly opts: EventMapperOptions) {
    this.sawTextStep = opts.initialSawText === true
  }

  /** Whether a terminal finish chunk has been emitted. */
  get isFinished(): boolean {
    return this.finished
  }

  private *ensureBlock(type: 'text' | 'reasoning'): Generator<StreamChunk> {
    if (this.openType === type) return
    const close = this.closeOpen()
    if (close) yield close
    this.openType = type
    this.openAcc = ''
    yield { type: 'block-start', index: this.blockIdx, blockType: type }
  }

  private closeOpen(): StreamChunk | null {
    if (this.openType === null) return null
    const block =
      this.openType === 'text'
        ? { type: 'text' as const, text: this.openAcc }
        : { type: 'reasoning' as const, text: this.openAcc }
    const chunk: StreamChunk = { type: 'block-end', index: this.blockIdx, block: block }
    this.blockIdx++
    this.openType = null
    this.openAcc = ''
    return chunk
  }

  private appendDelta(delta: string): StreamChunk | null {
    if (delta === '') return null
    this.openAcc += delta
    return this.openType === 'text'
      ? { type: 'text-delta', index: this.blockIdx, text: delta }
      : { type: 'reasoning-delta', index: this.blockIdx, text: delta }
  }

  /**
   * Map one event. `absIndex` is the event's position in the run recording;
   * it mints the mirror callId and is what continuation detection parses
   * back out of the DSH message list.
   */
  *map(ev: AgyEvent, absIndex: number): Generator<StreamChunk> {
    if (this.finished) return
    if (ev.kind === 'init') return
    if (ev.kind === 'garbage') return
    if (ev.kind === 'step') {
      if (ev.stepKind === 'text') {
        // agy ≥1.1.15 thinking turns: agent_response steps with usage but no
        // text_delta. The thoughts themselves are not streamed in print mode,
        // so surface the turn honestly as a token-annotated reasoning line.
        //
        // Covers every arrival shape: a thinking-only turn (text empty), a
        // one-shot answer (a single DONE envelope carrying text AND usage —
        // trivial questions never get a separate thinking step, which is why
        // first turns used to show no thinking at all), and a streamed
        // answer whose DONE tail carries the final usage.
        //
        // Placement guard: annotate only while THIS step has not yet
        // streamed any text. A streamed answer's DONE tail carries usage
        // after fragments already went out — annotating there wedged the
        // chip mid-text (reported on v0.3.2); those turns get no annotation.
        const thoughtTokens = ev.usage?.thinking_tokens ?? 0
        const stepTextEmitted = (this.emittedByKey.get(ev.stepKey) ?? '') !== ''
        if (thoughtTokens > 0 && !stepTextEmitted && !this.thinkingAnnounced.has(ev.stepKey)) {
          this.thinkingAnnounced.add(ev.stepKey)
          yield* this.ensureBlock('reasoning')
          const d = this.appendDelta('[agy thinking turn · ' + thoughtTokens + ' thinking tokens]\n')
          if (d) yield d
        }
        if (ev.text === '' && !ev.fragment) return
        this.sawTextStep = true
        yield* this.ensureBlock('text')
        let d: StreamChunk | null
        if (ev.fragment === true) {
          // Sequential fragment (text_delta): append in arrival order.
          const acc = (this.emittedByKey.get(ev.stepKey) ?? '') + ev.text
          this.emittedByKey.set(ev.stepKey, acc)
          d = this.appendDelta(ev.text)
        } else {
          // Cumulative snapshot: emit only the grown suffix.
          const prev = this.emittedByKey.get(ev.stepKey) ?? ''
          const delta = suffixDelta(prev, ev.text)
          this.emittedByKey.set(ev.stepKey, ev.text)
          d = this.appendDelta(delta)
        }
        if (d) yield d
        return
      }
      if (ev.stepKind === 'thinking' || ev.stepKind === 'subagent') {
        yield* this.ensureBlock('reasoning')
        if (ev.stepKind === 'thinking') {
          const prev = this.emittedByKey.get(ev.stepKey) ?? ''
          const delta = suffixDelta(prev, ev.text)
          this.emittedByKey.set(ev.stepKey, ev.text)
          const d = this.appendDelta(delta)
          if (d) yield d
        } else {
          const d = this.appendDelta('[agy subagent] ' + ev.text + '\n')
          if (d) yield d
        }
        return
      }
      if (ev.stepKind === 'tool' && ev.tool) {
        // Only a COMPLETED step (output or error recorded) becomes a card.
        // ACTIVE envelopes arrive first with name/args only; the span waits
        // for the DONE update that carries the payload.
        if (!(ev.tool.output !== undefined || ev.tool.error !== undefined)) return
        if (this.announcedTools.has(ev.stepKey)) return
        this.announcedTools.add(ev.stepKey)
        if (!this.opts.cutOnTool) return // auxiliary calls show no tool detail
        // Cut the span: close any open block, then one tool-call block
        // addressed to run_code — the only tool the deployment's dispatch
        // policy lets a model call directly — wrapping a generated program
        // whose single statement invokes the registered agy_tool mirror.
        // The inner dispatch renders the native tool card; the callId still
        // encodes the (run, eventIndex) cursor for continuation detection.
        const close = this.closeOpen()
        if (close) yield close
        const idx = this.blockIdx
        const argumentsJson = JSON.stringify(
          buildMirrorRunCode(this.opts.runId, absIndex, ev.tool.name),
        )
        yield { type: 'block-start', index: idx, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: idx,
          block: {
            type: 'tool-call',
            id: CallId(mirrorCallId(this.opts.runId, absIndex)),
            name: WRAPPER_TOOL_NAME,
            arguments: argumentsJson,
          },
        }
        this.blockIdx++
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        this.finished = true
        return
      }
      // title / user-input / unknown: ignored (forward compatibility).
      return;
    }
    // result
    if (!ev.ok) {
      // agy reports status=ERROR even when a usable response exists (e.g. a
      // tool timed out mid-run). Keep the answer, surface the error as a
      // reasoning annotation, and finish normally. A bare error with no
      // response stays passive here — the adapter owns terminal failures
      // (auth / process / invalid-output) and reads the envelope error from
      // the parser.
      if (ev.response === '') return
      if (!this.sawTextStep) {
        yield* this.ensureBlock('text')
        const d = this.appendDelta(ev.response)
        if (d) yield d
      }
      if (ev.error !== undefined && ev.error !== '') {
        yield* this.ensureBlock('reasoning')
        const d = this.appendDelta('[agy finished with error] ' + ev.error + '\n')
        if (d) yield d
      }
      const closeErr = this.closeOpen()
      if (closeErr) yield closeErr
      yield { type: 'usage', usage: usageFromRaw(ev.usage) }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        ...(ev.conversationId !== '' ? { replayState: { response: { conversationId: ev.conversationId } } } : {}),
      }
      this.finished = true
      return
    }
    if (!this.sawTextStep && ev.response !== '') {
      yield* this.ensureBlock('text')
      const d = this.appendDelta(ev.response)
      if (d) yield d
    }
    const close = this.closeOpen()
    if (close) yield close
    yield { type: 'usage', usage: usageFromRaw(ev.usage) }
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      ...(ev.conversationId !== '' ? { replayState: { response: { conversationId: ev.conversationId } } } : {}),
    }
    this.finished = true
  }

  /** Terminal error/abort: close what is open, zero usage, failure finish. */
  *emitFailure(kind: 'error' | 'aborted', code: string, message: string): Generator<StreamChunk> {
    if (this.finished) return
    const close = this.closeOpen()
    if (close) yield close
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield {
      type: 'finish',
      reason:
        kind === 'error'
          ? { kind: 'error', failure: { message, code } }
          : { kind: 'aborted', failure: { message, code } },
    };
    this.finished = true
  }
}
