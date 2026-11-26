// Tool-block assembly: turn one COMPLETED agy tool step into the streamed
// tool-call block (plus the context usage sample and the tool-calls finish).
//
// Code Mode addresses a run_code wrapper around tools['agy_tool']; Native Mode
// addresses agy_tool directly. Either way the callId encodes the
// (run, eventIndex) cursor for continuation detection.
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { RawUsage } from '../../common/types.ts'
import { mirrorCallId } from '../../host/recording.ts'
import { buildMirrorRunCode, MIRROR_TOOL_NAME, WRAPPER_TOOL_NAME, toolStepBrief, unwrapMcpTool } from '../../host/mirror-tool.ts'
import { rememberToolCallId, toToolCallId, type ToolCallState } from './tool-calls.ts'
import { usageFromRaw } from './usage.ts'

export interface ToolCallBlockInput {
  runId: string
  /** Event position in the run recording; mints the mirror callId. */
  absIndex: number
  toolName: string
  /** Stream args as delivered by agy (may be stripped by its tool filter). */
  args: unknown
  /** DB-resolved full args for this event index, when available. */
  resolvedFullArgs?: Record<string, unknown>
  useCodeWrapper: boolean
  /** Current open-block cursor; the tool block occupies this index. */
  blockIdx: number
  toolCallStates: Map<string, ToolCallState>
  /** Unconsumed per-call usage sample for this cut, or null/undefined to omit usage (#161). */
  finalUsage: () => RawUsage | null | undefined
  /** Zero-delta bucket-preserving usage for concurrent cuts 2..N (#210). */
  zeroDeltaUsage?: () => RawUsage | null | undefined
}

export interface ToolCallBlockResult {
  chunks: StreamChunk[]
  nextBlockIdx: number
}

export function buildToolCallBlock(input: ToolCallBlockInput): ToolCallBlockResult {
  const idx = input.blockIdx
  const useCode = input.useCodeWrapper
  const toolName = useCode ? WRAPPER_TOOL_NAME : MIRROR_TOOL_NAME
  // Prefer DB-resolved full args (which include CodeContent / TargetContent /
  // ReplacementContent stripped from the stream by agy's filterToolParameters);
  // otherwise fall back to whatever survived the stream so the card still
  // renders what it has.
  const fullArgs = input.resolvedFullArgs
  const streamArgsObj = typeof input.args === 'object' && input.args !== null ? input.args as Record<string, unknown> : undefined
  const mergedArgs = fullArgs !== undefined
    ? { ...fullArgs, ...(streamArgsObj ?? {}) }
    : input.args
  if (
    fullArgs !== undefined &&
    mergedArgs !== null &&
    typeof mergedArgs === 'object' &&
    Array.isArray(fullArgs.steps) &&
    fullArgs.steps.length > 0 &&
    (!Array.isArray((mergedArgs as Record<string, unknown>).steps) || ((mergedArgs as Record<string, unknown>).steps as unknown[]).length === 0)
  ) {
    ;(mergedArgs as Record<string, unknown>).steps = fullArgs.steps
    if (typeof fullArgs.markdown === 'string' && typeof (mergedArgs as Record<string, unknown>).markdown !== 'string') {
      ;(mergedArgs as Record<string, unknown>).markdown = fullArgs.markdown
    }
  }
  const effectiveArgs = mergedArgs
  const unwrapped = unwrapMcpTool(input.toolName, effectiveArgs)
  const brief = toolStepBrief(unwrapped.tool, unwrapped.input, unwrapped.server)
  const argumentsJson = useCode
    ? JSON.stringify(buildMirrorRunCode(input.runId, input.absIndex, unwrapped.tool, brief))
    : JSON.stringify({
        run: input.runId,
        step: input.absIndex,
        tool: unwrapped.tool,
        ...(unwrapped.server !== undefined ? { server: unwrapped.server } : {}),
        ...(unwrapped.input !== undefined ? { input: unwrapped.input } : {}),
      })
  const rawCallId = mirrorCallId(input.runId, input.absIndex)
  const assignedCallId = rememberToolCallId(input.toolCallStates, rawCallId, toolName)
  // Forward the last per-call sample when there is one. With no sample the
  // usage chunk is OMITTED rather than sent as 0/0: DSH treats a missing
  // usage chunk as "no new measurement" (it keeps the previous context
  // pressure and does not count the step towards decode time), while an
  // explicit 0/0 resets the meter and drags token speed down (issue #158).
  // Concurrent tool cuts 2..N of the same turn therefore forward no sample at
  // all, so DSH neither double-bills totals nor flashes context pressure (#161).
  const trackedCut = input.finalUsage() ?? input.zeroDeltaUsage?.()
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: idx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: idx,
      block: {
        type: 'tool-call',
        id: toToolCallId(assignedCallId),
        name: toolName,
        arguments: argumentsJson,
      },
    },
    ...(trackedCut !== undefined && trackedCut !== null && Object.keys(trackedCut).length > 0
      ? [{ type: 'usage' as const, usage: usageFromRaw(trackedCut) }]
      : []),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  return { chunks, nextBlockIdx: idx + 1 }
}
