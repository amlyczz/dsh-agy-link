// Tool-call identity bookkeeping: stable ToolCallId minting plus per-call
// binding disambiguation for the event mapper.
import * as dshLlm from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

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
