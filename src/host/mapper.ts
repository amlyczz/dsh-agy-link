// EventMapper: normalized agy events -> DSH StreamChunk protocol (spec
// section 3.3). Contract obligations honored here: usage precedes finish
// and nothing follows it; one content block open at a time; repeated step
// updates grow text by suffix-delta so both snapshot and delta payload
// styles stream correctly. agy tool activity surfaces as reasoning
// annotations (ADR-6): there is no toolUse stopReason to honor because agy
// runs its own closed tool loop.
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AgyEvent, RawUsage } from '../common/types.ts'

export type ToolAnnounceRenderer = (name: string, args: unknown) => string
export type ToolOutputRenderer = (name: string, args: unknown, output: unknown) => string | null

function briefArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args)
    return s.length > 300 ? s.slice(0, 300) + '...' : s
  } catch {
    return String(args).slice(0, 120)
  }
}

function defaultAnnounce(name: string, args: unknown): string {
  const brief = briefArgs(args)
  return brief === '' ? '[agy tool: ' + name + ']\n' : '[agy tool: ' + name + '] ' + brief + '\n'
}

function defaultOutput(output: unknown): string | null {
  if (output === undefined || output === null) return null
  let s: string
  try {
    s = typeof output === 'string' ? output : JSON.stringify(output)
  } catch {
    s = String(output)
  }
  if (s === '') return null
  const trimmed = s.length > 2048 ? s.slice(0, 2048) + '... (+' + (s.length - 2048) + ' chars)' : s
  return '-> ' + trimmed + '\n'
}

export function usageFromRaw(raw: RawUsage): TokenUsage {
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: raw.cache_read_tokens ?? undefined,
    cacheWriteTokens: raw.cache_write_tokens ?? undefined,
    reasoningTokens: raw.thinking_tokens ?? undefined,
  }
}

/** Suffix-delta: emit only what grew; fall back to a newline + full text. */
export function suffixDelta(prev: string, next: string): string {
  if (next === prev) return ''
  if (prev === '') return next
  if (next.startsWith(prev)) return next.slice(prev.length)
  return '\n' + next
}

export class EventMapper {
  private blockIdx = 0
  private openType: 'text' | 'reasoning' | null = null
  private openAcc = ''
  private readonly emittedByKey = new Map<string, string>()
  private readonly toolPhaseSeen = new Set<string>()
  private sawTextStep = false
  private finished = false

  constructor(
    private readonly opts: {
      announce?: ToolAnnounceRenderer
      toolOutput?: ToolOutputRenderer
    } = {},
  ) {}

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

  *map(ev: AgyEvent): Generator<StreamChunk> {
    if (this.finished) return
    if (ev.kind === 'init') return
    if (ev.kind === 'garbage') return
    if (ev.kind === 'step') {
      if (ev.stepKind === 'text') {
        this.sawTextStep = true
        yield* this.ensureBlock('text')
        const prev = this.emittedByKey.get(ev.stepKey) ?? ''
        const delta = suffixDelta(prev, ev.text)
        this.emittedByKey.set(ev.stepKey, ev.text)
        const d = this.appendDelta(delta)
        if (d) yield d
        return
      }
      if (ev.stepKind === 'thinking' || ev.stepKind === 'tool' || ev.stepKind === 'subagent') {
        yield* this.ensureBlock('reasoning')
        if (ev.stepKind === 'thinking') {
          const prev = this.emittedByKey.get(ev.stepKey) ?? ''
          const delta = suffixDelta(prev, ev.text)
          this.emittedByKey.set(ev.stepKey, ev.text)
          const d = this.appendDelta(delta)
          if (d) yield d
        } else if (ev.stepKind === 'tool' && ev.tool) {
          const announceKey = ev.stepKey + ':a'
          if (!this.toolPhaseSeen.has(announceKey)) {
            this.toolPhaseSeen.add(announceKey)
            const line = (this.opts.announce ?? defaultAnnounce)(ev.tool.name, ev.tool.args)
            const d = this.appendDelta(line)
            if (d) yield d
          }
          const outKey = ev.stepKey + ':o'
          if (ev.tool.output !== undefined && !this.toolPhaseSeen.has(outKey)) {
            this.toolPhaseSeen.add(outKey)
            const rendered = this.opts.toolOutput
              ? this.opts.toolOutput(ev.tool.name, ev.tool.args, ev.tool.output)
              : defaultOutput(ev.tool.output)
            if (rendered !== null) {
              const d = this.appendDelta(rendered)
              if (d) yield d
            }
          }
        } else if (ev.stepKind === 'subagent') {
          const d = this.appendDelta('[agy subagent] ' + ev.text + '\n')
          if (d) yield d
        }
        return
      }
      // title / user-input / unknown: ignored (forward compatibility).
      return;
    }
    // result
    if (!ev.ok) return // error finish is emitted by the adapter via emitFailure
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
      replayState: ev.conversationId !== '' ? { response: { conversationId: ev.conversationId } } : undefined,
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
