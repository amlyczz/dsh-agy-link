// Tool-result correlation + continuation-span detection.
//
// Moved verbatim out of src/host/adapter.ts. `detectContinuation` is re-exported
// from the adapter because tests and the host import it from there.
import type { Message } from '@deepseek-ai/dsh-llm'
import { parseMirrorCallId } from '../host/recording.ts'
import { isSyntheticHarnessMessage, isToolResultMessage, type ForeignSource, type UnknownBlock } from './prompt-text.ts'

/**
 * Correlation id of a tool-result message. Accepts `message.toolCallId`
 * (0.1.7+), `source.callId` (0.1.x), and nested `tool-result` blocks.
 */
export function toolCallIdOf(m: Message): string | null {
  const direct = (m as { toolCallId?: unknown }).toolCallId
  if (typeof direct === 'string' && direct !== '') return direct
  const src = (m as unknown as ForeignSource).source
  if (typeof src?.callId === 'string' && src.callId !== '') return src.callId
  for (const raw of (m.content as readonly UnknownBlock[] | undefined) ?? []) {
    const b = raw as UnknownBlock | undefined
    if (b?.type === 'tool-result' && typeof b.toolCallId === 'string' && b.toolCallId !== '') {
      return b.toolCallId
    }
  }
  return null
}

/**
 * Detect a continuation span: the request's LAST message is the tool result
 * of one of our mirrored agy tool calls. Its callId encodes the recording
 * run and the event index to resume after.
 *
 * Accepts both dsh-llm tool-result shapes: `role: 'user'` + `source.callId`
 * (0.1.x) and `role: 'tool'` + `message.toolCallId` (0.1.7+). Rejecting the
 * latter made every post-tool hop spawn a fresh agy process with a
 * digest-only prompt (issues #34 / #35).
 */
export function detectContinuation(messages: readonly Message[]): { runId: string; eventIndex: number } | null {
  // DSH appends context messages after it stores a tool result. Each producer
  // uses its OWN kind (`time-context`, `agent-instructions`, `plugin:<name>`)
  // and form, so matching only `plugin`+`snapshot` left every other one looking
  // like a human steer: the adapter aborted the live agy run and told the model
  // not to continue (issue #138). Skip anything the harness itself injected —
  // the same predicate the prompt builder uses — and stop at everything else.
  //
  // Some hosts append the mid-turn context as `role: 'system'` / `'developer'`
  // instead of `'user'` (system-prompt and tool-registry refreshes). Those
  // roles cannot be a human boundary — a person cannot type them — so a tail of
  // them must not hide the tool result underneath (issue #205). A real user
  // message, another provider's tool result, an assistant reply, or any
  // unknown boundary still stops the scan: continuing past one could replay a
  // run for the wrong request instead of spawning the requested turn.
  let i = messages.length - 1
  while (i >= 0) {
    const candidate = messages[i] as unknown as { role?: string }
    if (candidate.role === 'system' || candidate.role === 'developer') {
      i--
      continue
    }
    if (candidate.role !== 'user') break
    if (!isSyntheticHarnessMessage(messages[i] as Message)) break
    i--
  }
  const last = messages[i]
  if (last === undefined) return null
  const role = (last as { role?: string }).role
  if (role !== 'user' && role !== 'tool') return null
  if (!isToolResultMessage(last)) return null
  const callId = toolCallIdOf(last)
  if (callId === null) return null
  return parseMirrorCallId(callId)
}