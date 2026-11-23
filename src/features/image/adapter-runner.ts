// Adapter driver shared by the `dsh-agy-image` CLI, `agy_image` tool, and `/agy image`.
// Turns one `AgyAdapter` stream into `ImageService`'s `ImageAgentResult` contract
// so account pool selection, quota/region failover, proxy and failure classification
// behave identically across headless and in-session invocations.
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PROVIDER_ID, type AgyEvent } from '../../common/types.ts'
import type { ImageAgentCall, ImageAgentResult, ImageAgentToolCall } from './types.ts'

export interface AdapterLike {
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

function toolCallFrom(ev: AgyEvent): ImageAgentToolCall | null {
  if (ev.kind !== 'step' || ev.tool === undefined) return null
  return {
    name: ev.tool.name,
    ...(ev.tool.args === undefined ? {} : { args: ev.tool.args }),
    ...(ev.tool.output === undefined ? {} : { output: String(ev.tool.output) }),
    ...(ev.tool.error === undefined ? {} : { error: ev.tool.error }),
  }
}

function subagentsFrom(ev: AgyEvent): Array<{ conversationId?: string; logUri?: string }> {
  if (ev.kind !== 'step') return []
  const raw = ev.raw as { subagent_info?: { subagents?: unknown[] } } | undefined
  const list = raw?.subagent_info?.subagents
  if (!Array.isArray(list)) return []
  const out: Array<{ conversationId?: string; logUri?: string }> = []
  for (const d of list) {
    const one = d as { conversation_id?: unknown; log_uri?: unknown }
    out.push({
      ...(typeof one.conversation_id === 'string' ? { conversationId: one.conversation_id } : {}),
      ...(typeof one.log_uri === 'string' ? { logUri: one.log_uri } : {}),
    })
  }
  return out
}

/**
 * Drive one image generation attempt through the real adapter.
 */
export async function runViaAdapter(adapter: AdapterLike, call: ImageAgentCall): Promise<ImageAgentResult> {
  const started = Date.now()
  const toolCalls: ImageAgentToolCall[] = []
  const subagents: Array<{ conversationId?: string; logUri?: string }> = []
  const textParts: string[] = []
  let responseText = ''
  let conversationId: string | undefined
  let home: string | undefined
  let accountId: string | undefined
  let failure: { code?: string; message?: string } | null = null
  let timedOut = false
  const controller = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, call.timeoutMs)
  timer.unref?.()
  const signal = call.signal === undefined ? controller.signal : AbortSignal.any([call.signal, controller.signal])

  const options = {
    provider: PROVIDER_ID,
    model: call.model,
    ...(call.effort === '' ? {} : { reasoningEffort: call.effort }),
    messages: [{ role: 'user', content: [{ type: 'text', text: call.prompt }], source: { kind: 'user' } }],
    maxTokens: 4096,
    purpose: 'image',
    signal,
    agyImagePrompt: call.prompt,
    agyPermissionMode: call.permissionMode,
    ...(call.quotaModel === undefined ? {} : { agyQuotaModel: call.quotaModel }),
    ...(call.excludeAccountIds === undefined || call.excludeAccountIds.length === 0
      ? {}
      : { agyAvoidAccountIds: call.excludeAccountIds }),
    agyOnAccount: (info: { id?: string; home?: string }) => {
      if (accountId !== undefined && typeof info.id === 'string' && info.id !== accountId) {
        toolCalls.length = 0
        subagents.length = 0
        textParts.length = 0
        responseText = ''
        conversationId = undefined
        failure = null
      }
      if (typeof info.id === 'string') accountId = info.id
      if (typeof info.home === 'string' && info.home !== '') home = info.home
    },
    agyOnEvent: (ev: AgyEvent) => {
      if (ev.kind === 'init' && ev.conversationId !== undefined) conversationId = ev.conversationId
      if (ev.kind === 'step') {
        if (ev.stepKind === 'text' && ev.text !== '') textParts.push(ev.text)
        const tc = toolCallFrom(ev)
        if (tc !== null) toolCalls.push(tc)
        for (const s of subagentsFrom(ev)) subagents.push(s)
      }
      if (ev.kind === 'result') {
        if (ev.conversationId !== '') conversationId = ev.conversationId
        if (ev.response !== '') responseText = ev.response
        const err = (ev.raw as { result?: { error?: unknown } } | undefined)?.result?.error
        if (typeof err === 'string' && err !== '') failure = { message: err }
      }
    },
  } as unknown as Record<string, unknown>

  try {
    for await (const chunk of adapter.stream(options as unknown as GenerateOptions)) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') textParts.push(chunk.text)
      if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          failure = {
            ...(typeof reason.failure?.code === 'string' ? { code: reason.failure.code } : {}),
            ...(typeof reason.failure?.message === 'string' ? { message: reason.failure.message } : {}),
          }
        }
      }
    }
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown }
    const message = typeof err.message === 'string' ? err.message : String(e)
    const code = typeof err.code === 'string'
      ? err.code
      : /accounts are unavailable|no account/i.test(message)
        ? 'RATE_LIMIT'
        : undefined
    failure = {
      ...(code === undefined ? {} : { code }),
      message,
    }
  } finally {
    clearTimeout(timer)
  }

  const text = (textParts.join('\n').trim() || responseText).trim()
  if (failure !== null) {
    const code = timedOut ? 'TIMEOUT' : (failure.code ?? 'AGY_ERROR')
    return {
      ok: false,
      text,
      toolCalls,
      subagents,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(home === undefined ? {} : { home }),
      ...(accountId === undefined ? {} : { accountId }),
      code,
      error: timedOut ? 'timed out after ' + call.timeoutMs + 'ms' : (failure.message ?? 'image generation failed'),
      durationMs: Date.now() - started,
    }
  }
  return {
    ok: true,
    text,
    toolCalls,
    subagents,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(home === undefined ? {} : { home }),
    ...(accountId === undefined ? {} : { accountId }),
    durationMs: Date.now() - started,
  }
}
