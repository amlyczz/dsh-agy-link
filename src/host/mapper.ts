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
import type { LlmFailure, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as dshLlm from '@deepseek-ai/dsh-llm'
import type { AgyEvent, RawUsage } from '../common/types.ts'
import { mirrorCallId } from './recording.ts'
import { buildMirrorRunCode, MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME, toolStepBrief, unwrapMcpTool } from './mirror-tool.ts'
import { type GoalContext, buildGoalCompleteToolCallBlock, buildPlanExitToolCallBlock } from './dsh-goal.ts'

export const toToolCallId: (id: string) => ToolCallId =
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).ToolCallId ??
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).CallId ??
  ((id: string) => id as unknown as ToolCallId)

export interface ToolCallBinding {
  readonly id: string
  readonly name: string
}

export interface ToolCallState {
  last: ToolCallBinding
  pending: ToolCallBinding[]
}

/**
 * Disambiguate duplicate tool-call IDs across turns or multiple calls in a session.
 * Reusing a call ID across different tool names triggers INVALID_ARGS in DSH; suffixing
 * with #${name} keeps each call uniquely addressable and self-healing.
 */
export function rememberToolCallId(
  toolNames: Map<string, ToolCallState>,
  rawCallId: string,
  name: string,
): string {
  const state = toolNames.get(rawCallId)
  const assigned = state === undefined ? rawCallId : state.last.name === name ? state.last.id : `${rawCallId}#${name}`
  const binding = { id: assigned, name }
  toolNames.set(rawCallId, { last: binding, pending: [...(state?.pending ?? []), binding] })
  return assigned
}

export function consumeToolBinding(
  toolNames: Map<string, ToolCallState>,
  callId: string,
): ToolCallBinding | undefined {
  const state = toolNames.get(callId)
  if (!state) return undefined
  const next = state.pending.shift()
  return next ?? state.last
}

export function expirePendingToolCalls(toolNames: Map<string, ToolCallState>): void {
  for (const state of toolNames.values()) {
    if (state.pending.length > 0) state.pending = []
  }
}

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
  if (raw.total_tokens !== undefined) usage.totalTokens = raw.total_tokens
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
  /**
   * True if DSH is in Code Mode (options.tools has 'run_code').
   * False if DSH is in Native / Standard Mode (options.tools has 'agy_tool' or standard tools).
   */
  useCodeWrapper?: boolean
  /**
   * Shared per-run usage tracker (lives on the recording, spans share it).
   * Step usage is per-call (current context); the result envelope is
   * conversation-cumulative and must never reach DSH's token meter.
   */
  usage?: {
    noteStepUsage(raw: RawUsage): void
    finalUsage(resultRaw: RawUsage): RawUsage
  }
  /**
   * Resolve FULL tool args for a recorded step from the agy conversation DB
   * (stream args are stripped by agy's filterToolParameters). Called when the
   * mapper cuts a tool span; resolved args are stored back on the recording so
   * the mirror's enrichArgs/execute see the same full payload.
   */
  fullArgsAt?: (eventIndex: number) => Promise<Record<string, unknown> | null>
  /**
   * Synchronously-available full args, keyed by event index. driveSpan
   * pre-resolves these (awaiting fullArgsAt) and hands them to the mapper so
   * the emitted tool-call arguments carry the complete payload without making
   * map() async.
   */
  resolvedFullArgs?: ReadonlyMap<number, Record<string, unknown>>
  /**
   * Synchronously-available thoughts, keyed by event index. driveSpan
   * pre-resolves these from the agy conversation DB so reasoning blocks stream
   * real thought text instead of token-count annotations.
   */
  resolvedThoughts?: ReadonlyMap<number, string>
  /** Base URL for the media route, e.g. http://127.0.0.1:5173/plugins/agy-link/media */
  mediaBaseUrl?: string
  /** Active DSH goal context for the current turn, if running under <goal_round>. */
  goalContext?: GoalContext | null
  /** Whether the host provides the `update_goal` tool to mark the goal completed. */
  supportsGoalUpdate?: boolean
  /** Whether the host provides the `exit_plan_mode` tool for DSH plan mode. */
  supportsPlanExit?: boolean
}

/** Rewrite local image paths and file:// URLs to point to the local media route. */
export function rewriteImageMarkdown(text: string, mediaBaseUrl?: string): string {
  if (!mediaBaseUrl || !text) return text
  return text.replace(
    /!\[(.*?)\]\((file:\/\/\/[^\s)]+|file:\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+|\/home\/[^\s)]+|\/mnt\/[a-zA-Z]\/[^\s)]+|\\\\wsl\.localhost\\[^\s)]+)\)/g,
    (_match, alt, target) => {
      const cleanTarget = target.trim()
      const mediaUrl = `${mediaBaseUrl}?path=${encodeURIComponent(cleanTarget)}`
      return `![${alt}](${mediaUrl})`
    },
  )
}

export class EventMapper {
  private blockIdx = 0
  private openType: 'text' | 'reasoning' | null = null
  private openAcc = ''
  private readonly emittedByKey = new Map<string, string>()
  private readonly announcedTools = new Set<string>()
  private readonly pendingAnnounced = new Set<string>()
  private readonly thinkingAnnounced = new Set<string>()
  /**
   * Steps whose banner already streamed WITHOUT prose (issue #43: desktop
   * hosts with no sqlite reader). Separate from `thinkingAnnounced` on
   * purpose: DB prose can resolve AFTER the banner streamed, and marking the
   * step announced there would drop the real text (the exact regression
   * issue #43 fixed). When prose arrives later it is appended WITHOUT the
   * banner and the entry is consumed.
   */
  private readonly bannerOnlyShown = new Set<string>()
  private bannerOnlyThinkingEmitted = false
  private sawTextStep: boolean
  private finished = false
  private totalTextOutput = ''
  private readonly toolCallStates = new Map<string, ToolCallState>()

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
    if (this.openType === 'text') this.totalTextOutput += delta
    return this.openType === 'text'
      ? { type: 'text-delta', index: this.blockIdx, text: delta }
      : { type: 'reasoning-delta', index: this.blockIdx, text: delta }
  }

  /**
   * Emit thinking: always retain the [agy · ... tokens] banner.
   * When real thought prose is present, place the banner and thought
   * text on the same initial line so DSH's collapsed summary renders:
   *   [agy · *** tokens] [Chain-of-Thought body]
   *
   * With `allowBannerOnly` the bare banner is emitted when the DB prose never
   * arrived (desktop hosts without any sqlite reader, issue #43): the user
   * then at least SEES that a thinking turn happened and how large it was —
   * previously high-effort turns rendered nothing at all.
   */
  private *emitThinking(stepKey: string, absIndex: number, thoughtTokens: number, allowBannerOnly = false): Generator<StreamChunk> {
    const text = this.opts.resolvedThoughts?.get(absIndex)
    const hasText = text !== undefined && text.trim() !== ''
    if (!hasText && !allowBannerOnly) return

    // A banner-only chip already streamed for this step: continue with the
    // prose alone instead of printing the banner twice.
    const bannerAlreadyShown = this.bannerOnlyShown.has(stepKey)
    // Consume the flag only when prose is present — the banner-only emission
    // itself must keep it set for the later prose append.
    if (hasText) this.bannerOnlyShown.delete(stepKey)

    yield* this.ensureBlock('reasoning')
    const banner =
      thoughtTokens > 0
        ? '[agy · ' + thoughtTokens + ' tokens]'
        : '[agy]'
    const combined = !hasText
      ? `${banner}\n`
      : bannerAlreadyShown
        ? `${text!.trim()}\n`
        : `${banner} ${text!.trim()}\n`
    const d = this.appendDelta(combined)
    if (d) yield d
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
      if (ev.usage) this.opts.usage?.noteStepUsage(ev.usage)
      if (ev.stepKind === 'text') {
        const thoughtTokens = ev.usage?.thinking_tokens ?? 0
        const stepTextEmitted = (this.emittedByKey.get(ev.stepKey) ?? '') !== ''
        const dbThought = this.opts.resolvedThoughts?.get(absIndex)
        const hasRealThought = dbThought !== undefined && dbThought.trim() !== ''

        // If real thoughts are available and no text has been emitted yet,
        // stream the reasoning block FIRST before answer text. Do not prematurely
        // mark thinkingAnnounced when DB thoughts have not arrived yet (issue #43).
        if (hasRealThought && !stepTextEmitted && !this.thinkingAnnounced.has(ev.stepKey)) {
          this.thinkingAnnounced.add(ev.stepKey)
          yield* this.emitThinking(ev.stepKey, absIndex, thoughtTokens)
        }
        const deferred = hasRealThought && stepTextEmitted && !this.thinkingAnnounced.has(ev.stepKey)
        if (ev.text === '' && !ev.fragment) {
          // DONE tail carrying usage with no text: the step is already
          // complete — flush the deferred annotation now.
          if (deferred) {
            this.thinkingAnnounced.add(ev.stepKey)
            yield* this.emitThinking(ev.stepKey, absIndex, thoughtTokens)
          } else if (!this.sawTextStep && thoughtTokens > 0 && !this.thinkingAnnounced.has(ev.stepKey)) {
            // Thinking-only turn with no DB prose available (issue #43):
            // surface the banner so high-effort turns are not invisible.
            this.bannerOnlyShown.add(ev.stepKey)
            yield* this.emitThinking(ev.stepKey, absIndex, thoughtTokens, true)
          }
          return
        }
        // First visible text of the run with no DB prose: emit the banner-only
        // chip before the answer so thinking stays visible (issue #43). Gated
        // on `!sawTextStep` so later tool-heavy steps are not cluttered.
        if (!hasRealThought && !this.sawTextStep && thoughtTokens > 0 && !this.thinkingAnnounced.has(ev.stepKey)) {
          this.bannerOnlyShown.add(ev.stepKey)
          yield* this.emitThinking(ev.stepKey, absIndex, thoughtTokens, true)
        }
        this.sawTextStep = true
        yield* this.ensureBlock('text')
        let d: StreamChunk | null
        const processedText = this.opts.mediaBaseUrl ? rewriteImageMarkdown(ev.text, this.opts.mediaBaseUrl) : ev.text
        if (ev.fragment === true) {
          // Sequential fragment (text_delta): append in arrival order.
          const acc = (this.emittedByKey.get(ev.stepKey) ?? '') + processedText
          this.emittedByKey.set(ev.stepKey, acc)
          d = this.appendDelta(processedText)
        } else {
          // Cumulative snapshot: emit only the grown suffix.
          const prev = this.emittedByKey.get(ev.stepKey) ?? ''
          const delta = suffixDelta(prev, processedText)
          this.emittedByKey.set(ev.stepKey, processedText)
          d = this.appendDelta(delta)
        }
        if (d) yield d
        if (deferred) {
          // This DONE closed the step's text: the chip lands after the
          // complete sentence, never between two of its fragments.
          this.thinkingAnnounced.add(ev.stepKey)
          yield* this.emitThinking(ev.stepKey, absIndex, thoughtTokens)
        }
        return
      }
      if (ev.stepKind === 'thinking' || ev.stepKind === 'subagent') {
        yield* this.ensureBlock('reasoning')
        if (ev.stepKind === 'thinking') {
          const dbThought = this.opts.resolvedThoughts?.get(absIndex)
          if (dbThought && dbThought.trim() !== '') {
            const prev = this.emittedByKey.get(ev.stepKey) ?? ''
            const delta = suffixDelta(prev, dbThought)
            this.emittedByKey.set(ev.stepKey, dbThought)
            const d = this.appendDelta(delta)
            if (d) yield d
          } else {
            const prev = this.emittedByKey.get(ev.stepKey) ?? ''
            const delta = suffixDelta(prev, ev.text)
            this.emittedByKey.set(ev.stepKey, ev.text)
            const d = this.appendDelta(delta)
            if (d) yield d
          }
        } else {
          // agy re-delivers subagent progress as cumulative snapshots of the
          // same step; emitting the banner + full text on every update used to
          // duplicate the whole transcript. Track the step's accumulated text
          // and emit only the grown suffix (same contract as the thinking
          // branch), with the banner on the first emission only.
          const prev = this.emittedByKey.get(ev.stepKey) ?? ''
          const deltaText = suffixDelta(prev, ev.text)
          this.emittedByKey.set(ev.stepKey, ev.text)
          const banner = prev === '' ? '[agy subagent] ' : ''
          const d = this.appendDelta(banner + deltaText)
          if (d) yield d
        }
        return
      }
      if (ev.stepKind === 'tool' && ev.tool) {
        // Only a COMPLETED step becomes a card.
        // agy ≥1.1.15 stream-json emits two envelopes per tool step:
        //  1. state: 'ACTIVE' with name and metadata args only (payload in progress)
        //  2. state: 'DONE' when complete. Some tools (run_command, view_file)
        //     carry an output string in tool_info; others (replace_file_content,
        //     write_to_file) emit no output property on success.
        // Therefore, a step is complete if state is DONE/ERROR, or if output/error
        // was recorded (for older agy versions or mocks where state is omitted).
        const isCompleted =
          ev.state === 'DONE' ||
          ev.state === 'ERROR' ||
          (ev.state === undefined && (ev.tool.output !== undefined || ev.tool.error !== undefined))
        if (!isCompleted) {
          // Live progress for long-running agy tools: while a step is ACTIVE
          // (a maven build can hold the turn for many minutes) nothing else
          // streams, so the turn looked frozen. Emit the pending note once per
          // step into the reasoning block; the completed step still cuts the
          // span with the real tool card below.
          if (
            this.opts.cutOnTool &&
            !this.finished &&
            ev.state === 'ACTIVE' &&
            !this.pendingAnnounced.has(ev.stepKey)
          ) {
            this.pendingAnnounced.add(ev.stepKey)
            yield* this.ensureBlock('reasoning')
            const unwrapped = unwrapMcpTool(ev.tool.name, ev.tool.args)
            const label = unwrapped.server ? `${unwrapped.tool} (${unwrapped.server})` : unwrapped.tool
            const d = this.appendDelta(
              '[agy tool running: ' + label + ' — the result card streams when it finishes]\n',
            )
            if (d) yield d
          }
          return
        }
        if (this.announcedTools.has(ev.stepKey)) return
        this.announcedTools.add(ev.stepKey)
        if (!this.opts.cutOnTool) return // auxiliary calls show no tool detail
        // Cut the span: close any open block, then one tool-call block.
        // In Code Mode: addressed to run_code wrapping tools['agy_tool']({ run, step }).
        // In Native Mode: addressed to agy_tool directly with { run, step, tool, input }.
        // The callId still encodes the (run, eventIndex) cursor for continuation detection.
        const close = this.closeOpen()
        if (close) yield close
        const idx = this.blockIdx
        const useCode = this.opts.useCodeWrapper === true
        const toolName = useCode ? WRAPPER_TOOL_NAME : MIRROR_TOOL_NAME
        // Prefer DB-resolved full args (which include CodeContent /
        // TargetContent / ReplacementContent stripped from the stream by agy's
        // filterToolParameters); otherwise fall back to whatever survived the
        // stream so the card still renders what it has.
        const fullArgs = this.opts.resolvedFullArgs?.get(absIndex)
        const effectiveArgs = fullArgs !== undefined
          ? { ...fullArgs, ...(typeof ev.tool.args === 'object' ? ev.tool.args as Record<string, unknown> : {}) }
          : ev.tool.args
        const unwrapped = unwrapMcpTool(ev.tool.name, effectiveArgs)
        const brief = toolStepBrief(unwrapped.tool, unwrapped.input, unwrapped.server)
        const argumentsJson = useCode
          ? JSON.stringify(buildMirrorRunCode(this.opts.runId, absIndex, unwrapped.tool, brief))
          : JSON.stringify({
              run: this.opts.runId,
              step: absIndex,
              tool: unwrapped.tool,
              ...(unwrapped.server !== undefined ? { server: unwrapped.server } : {}),
              ...(unwrapped.input !== undefined ? { input: unwrapped.input } : {}),
            })
        const rawCallId = mirrorCallId(this.opts.runId, absIndex)
        const assignedCallId = rememberToolCallId(this.toolCallStates, rawCallId, toolName)
        yield { type: 'block-start', index: idx, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: idx,
          block: {
            type: 'tool-call',
            id: toToolCallId(assignedCallId),
            name: toolName,
            arguments: argumentsJson,
          },
        }
        this.blockIdx++
        // Forward the last per-call context sample instead of a hard 0/0: DSH's
        // token meter treats the last reported sample as current context
        // occupancy, so a zero here reset the meter on every tool hop of an
        // agentic turn (the same bug emitFailure already fixed for failures).
        const trackedCut = this.opts.usage?.finalUsage({})
        yield {
          type: 'usage',
          usage: trackedCut !== undefined && Object.keys(trackedCut).length > 0
            ? usageFromRaw(trackedCut)
            : { inputTokens: 0, outputTokens: 0 },
        }
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
      // tool timed out mid-run or network closed after generation). Keep the answer,
      // surface the error as a reasoning annotation, and finish normally. A bare error
      // with no response stays passive here — the adapter owns terminal failures
      // (auth / process / invalid-output) and reads the envelope error from the parser.
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
    } else if (!this.sawTextStep && ev.response !== '') {
      yield* this.ensureBlock('text')
      const d = this.appendDelta(ev.response)
      if (d) yield d
    }
    const close = this.closeOpen()
    if (close) yield close
    yield { type: 'usage', usage: usageFromRaw(this.opts.usage?.finalUsage(ev.usage) ?? ev.usage) }

    // If running in a DSH goal continuation round and DSH provided the update_goal tool:
    // Emit a synthetic update_goal call to mark the goal complete and prevent infinite loop continuation rounds.
    if (this.opts.supportsGoalUpdate && this.opts.goalContext) {
      for (const ch of buildGoalCompleteToolCallBlock(this.opts.goalContext, this.blockIdx)) yield ch
      this.blockIdx++
      yield {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        ...(ev.conversationId !== '' ? { replayState: { response: { conversationId: ev.conversationId } } } : {}),
      }
      this.finished = true
      return
    }

    // If running in DSH plan mode and DSH provided the exit_plan_mode tool:
    if (this.opts.supportsPlanExit && this.totalTextOutput.trim() !== '') {
      for (const ch of buildPlanExitToolCallBlock(this.totalTextOutput, this.blockIdx)) yield ch
      this.blockIdx++
      yield {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        ...(ev.conversationId !== '' ? { replayState: { response: { conversationId: ev.conversationId } } } : {}),
      }
      this.finished = true
      return
    }

    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      ...(ev.conversationId !== '' ? { replayState: { response: { conversationId: ev.conversationId } } } : {}),
    }
    this.finished = true
  }

  /**
   * Terminal error/abort: close what is open and finish with the failure.
   *
   * The usage sample is the last per-call context size when agy reported one,
   * NOT a hard-coded 0/0: DSH's token meter treats the last sample as current
   * context occupancy, so a failed turn used to reset the meter and could fire
   * a bogus compaction a step later.
   */
  *emitFailure(
    kind: 'error' | 'aborted',
    code: string,
    message: string,
    /**
     * Provider-requested retry delay (ms). Only transport failures state one:
     * the generic 2s-doubling schedule cannot outlast an egress outage, and the
     * retry plugin honours this value verbatim (up to the policy's maxDelayMs).
     */
    retryAfterMs?: number,
  ): Generator<StreamChunk> {
    if (this.finished) return
    const close = this.closeOpen()
    if (close) yield close
    const tracked = this.opts.usage?.finalUsage({})
    yield {
      type: 'usage',
      usage: tracked !== undefined && Object.keys(tracked).length > 0
        ? usageFromRaw(tracked)
        : { inputTokens: 0, outputTokens: 0 },
    }
    const failure: LlmFailure = {
      message,
      code,
      ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? { providerRetryAfterMs: Math.trunc(retryAfterMs) }
        : {}),
    }
    yield {
      type: 'finish',
      reason: kind === 'error' ? { kind: 'error', failure } : { kind: 'aborted', failure },
    };
    this.finished = true
  }
}
