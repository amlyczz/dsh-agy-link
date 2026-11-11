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
  /** Last per-call usage sample, read at cut time (pure). */
  finalUsage: () => RawUsage | undefined
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
  const effectiveArgs = fullArgs !== undefined
    ? { ...fullArgs, ...(typeof input.args === 'object' ? input.args as Record<string, unknown> : {}) }
    : input.args
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
  // Forward the last per-call context sample instead of a hard 0/0: DSH's
  // token meter treats the last reported sample as current context occupancy,
  // so a zero here reset the meter on every tool hop of an agentic turn.
  const trackedCut = input.finalUsage()
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
    {
      type: 'usage',
      usage: trackedCut !== undefined && Object.keys(trackedCut).length > 0
        ? usageFromRaw(trackedCut)
        : { inputTokens: 0, outputTokens: 0 },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  return { chunks, nextBlockIdx: idx + 1 }
}
