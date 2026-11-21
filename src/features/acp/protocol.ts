// Pure ACP (Agent Client Protocol) JSON-RPC types and wire-to-AgyEvent mapping,
// verified against `agy acp` (1.5.12).
import type { AgyEvent, PermissionMode, RawUsage } from '../../common/types.ts'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

export interface AcpStreamState {
  textSeq: number
  thoughtSeq: number
  accumulatedText: string
  lastUsage: RawUsage
  toolArgsByCallId: Map<string, { name: string; args: unknown }>
}

export function createAcpStreamState(): AcpStreamState {
  return {
    textSeq: 0,
    thoughtSeq: 0,
    accumulatedText: '',
    lastUsage: {},
    toolArgsByCallId: new Map(),
  }
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** ACP tool statuses that end a tool's lifecycle (anything else is still live). */
const ACP_TERMINAL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled'])

/**
 * True when an ACP tool status is terminal. agy 1.5.x only ever reports
 * `in_progress`, `pending` (transient) and `completed`; `failed`/`cancelled`
 * are accepted defensively. An absent status is NOT terminal — the first
 * `tool_call` for a background command carries no status at all.
 */
export function isAcpTerminalStatus(rawStatus: string | undefined): boolean {
  if (rawStatus === undefined || rawStatus === '') return false
  return ACP_TERMINAL_STATUSES.has(rawStatus)
}

export function extractAcpToolOutput(update: Record<string, unknown>): string | undefined {
  const rawOutput = update.rawOutput
  if (typeof rawOutput === 'string') return rawOutput
  const ro = asObj(rawOutput)
  if (ro) {
    if (typeof ro.output === 'string') return ro.output
    if (typeof ro.text === 'string') return ro.text
    if (typeof ro.result === 'string') return ro.result
  }
  const content = update.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      const it = asObj(item)
      const inner = asObj(it?.content)
      if (typeof inner?.text === 'string') parts.push(inner.text)
      else if (typeof it?.text === 'string') parts.push(it.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (ro) {
    try {
      return JSON.stringify(ro)
    } catch {
      return undefined
    }
  }
  return undefined
}

function extractAcpToolError(update: Record<string, unknown>, status: string): string | undefined {
  const ro = asObj(update.rawOutput)
  if (typeof ro?.error === 'string' && ro.error !== '') return ro.error
  const errObj = asObj(ro?.error)
  if (typeof errObj?.message === 'string' && errObj.message !== '') return errObj.message
  if (status === 'failed') return extractAcpToolOutput(update) || 'tool execution failed'
  if (status === 'cancelled' || status === 'canceled') return 'tool execution canceled'
  return undefined
}

/** Map one `session/update` payload onto normalized `AgyEvent`s. */
export function acpUpdateToAgyEvents(
  sessionId: string,
  update: Record<string, unknown>,
  state: AcpStreamState,
): AgyEvent[] {
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
  if (kind === 'agent_message_chunk') {
    const content = asObj(update.content)
    if (content?.type === 'text' && typeof content.text === 'string' && content.text !== '') {
      state.accumulatedText += content.text
      const usage = Object.keys(state.lastUsage).length > 0 ? { ...state.lastUsage } : undefined
      return [{
        kind: 'step',
        stepKey: `acp-text-${state.textSeq}`,
        stepKind: 'text',
        fragment: true,
        text: content.text,
        conversationId: sessionId,
        ...(usage ? { usage } : {}),
      }]
    }
    return []
  }
  if (kind === 'agent_thought_chunk') {
    const content = asObj(update.content)
    if (content?.type === 'text' && typeof content.text === 'string' && content.text !== '') {
      return [{
        kind: 'step',
        stepKey: `acp-thought-${state.thoughtSeq}`,
        stepKind: 'thinking',
        text: content.text,
        conversationId: sessionId,
      }]
    }
    return []
  }
  if (kind === 'usage_update') {
    const used = num(update.used)
    if (used !== undefined) state.lastUsage.input_tokens = used
    // Cache-read tokens tell a replayed conversation apart from a fresh one:
    // a resumed session that actually rehydrated history reports them.
    const cachedRead = num(update.cachedReadTokens) ?? num(update.cache_read_tokens) ?? num(update.cached_read_tokens)
    if (cachedRead !== undefined) state.lastUsage.cache_read_tokens = cachedRead
    return []
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const callId = typeof update.toolCallId === 'string' && update.toolCallId !== '' ? update.toolCallId : `acp-tc-${Date.now()}`
    const prev = state.toolArgsByCallId.get(callId)
    const name = typeof update.name === 'string' && update.name !== ''
      ? update.name
      : (prev?.name ?? (typeof update.title === 'string' ? update.title : 'tool'))
    const args = update.rawInput ?? update.args ?? prev?.args ?? {}
    state.toolArgsByCallId.set(callId, { name, args })
    const rawStatus = typeof update.status === 'string' ? update.status.toLowerCase() : ''
    let stepState = 'ACTIVE'
    if (rawStatus === 'completed') stepState = 'DONE'
    else if (rawStatus === 'failed' || rawStatus === 'error') stepState = 'ERROR'
    else if (rawStatus === 'cancelled' || rawStatus === 'canceled') stepState = 'CANCELED'
    if (stepState !== 'ACTIVE') {
      state.textSeq++
      state.thoughtSeq++
    }
    const output = stepState !== 'ACTIVE' ? extractAcpToolOutput(update) : undefined
    const error = stepState === 'ERROR' || stepState === 'CANCELED' ? extractAcpToolError(update, rawStatus) : undefined
    return [{
      kind: 'step',
      stepKey: callId,
      stepKind: 'tool',
      state: stepState,
      ...(rawStatus !== '' ? { rawStatus } : {}),
      text: output ?? '',
      conversationId: sessionId,
      tool: {
        name,
        args,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      },
      raw: update,
    }]
  }
  return []
}

export function acpUsageToRawUsage(u: unknown): RawUsage {
  const o = asObj(u)
  if (!o) return {}
  const out: RawUsage = {}
  const inT = num(o.inputTokens) ?? num(o.input_tokens)
  const outT = num(o.outputTokens) ?? num(o.output_tokens)
  const cr = num(o.cachedReadTokens) ?? num(o.cache_read_tokens)
  const cw = num(o.cachedWriteTokens) ?? num(o.cache_write_tokens)
  const th = num(o.thoughtTokens) ?? num(o.thinking_tokens)
  const tot = num(o.totalTokens) ?? num(o.total_tokens)
  if (inT !== undefined) out.input_tokens = inT
  if (outT !== undefined) out.output_tokens = outT
  if (cr !== undefined) out.cache_read_tokens = cr
  if (cw !== undefined) out.cache_write_tokens = cw
  if (th !== undefined) out.thinking_tokens = th
  if (tot !== undefined) out.total_tokens = tot
  return out
}

export function acpPromptResultToAgyEvent(
  sessionId: string,
  result: Record<string, unknown>,
  accumulatedText: string,
): AgyEvent {
  const stopReason = typeof result.stopReason === 'string' ? result.stopReason : 'end_turn'
  const ok = stopReason !== 'error' && stopReason !== 'refusal'
  const usage = acpUsageToRawUsage(result.usage)
  const errMsg = !ok && typeof result.error === 'string' ? result.error : undefined
  return {
    kind: 'result',
    conversationId: sessionId,
    ok,
    response: accumulatedText,
    ...(errMsg ? { error: errMsg } : {}),
    usage,
    raw: result,
  }
}

/** Choose an optionId for ACP `session/request_permission` honoring `PermissionMode`. */
export function pickPermissionOption(
  params: Record<string, unknown>,
  mode: PermissionMode,
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const options = Array.isArray(params.options) ? params.options : []
  const parsed = options
    .map((x) => asObj(x))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x.optionId === 'string')
  if (parsed.length === 0) return { outcome: 'cancelled' }
  const findKind = (...kinds: string[]) => {
    for (const k of kinds) {
      const hit = parsed.find((o) => o.kind === k)
      if (hit) return hit
    }
    return undefined
  }
  if (mode === 'plan') {
    const deny = findKind('reject_once', 'reject_always', 'deny')
    return deny ? { outcome: 'selected', optionId: String(deny.optionId) } : { outcome: 'cancelled' }
  }
  if (mode === 'skip' || mode === 'auto') {
    const allow = findKind('allow_always', 'allow_once', 'allow')
    if (allow) return { outcome: 'selected', optionId: String(allow.optionId) }
  }
  const allowOnce = findKind('allow_once', 'allow_always', 'allow')
  if (mode === 'accept-edits' && allowOnce) {
    return { outcome: 'selected', optionId: String(allowOnce.optionId) }
  }
  return allowOnce ? { outcome: 'selected', optionId: String(allowOnce.optionId) } : { outcome: 'cancelled' }
}
