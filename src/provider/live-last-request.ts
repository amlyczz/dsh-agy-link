// Protecting the final message of a "live-last" request (issue #221).
//
// A request made only of user messages carries what it is FOR at the very end.
// This module owns the rule that keeps it inside agy's single-message budget
// without moving it: elide the middle, never the tail.
import type { Message } from '@deepseek-ai/dsh-llm'
import { elideMiddle, textOf, trimToUtf8Bytes, utf8Bytes } from './prompt-text.ts'

/** Room kept for the start of a request's head (policy, environment). */
export const REQUEST_HEAD_RESERVE_BYTES = 24_000

/**
 * Keep the FINAL message of a request when the prompt is over budget (issue #221).
 *
 * Some requests are "live-last": DSH's auto-review sends the environment, the
 * retained session items in order and the pending tool call LAST — its policy
 * even states "The final message is the pending tool call". With no assistant
 * message to wrap the live request first and no binding to continue, the whole
 * history goes out in order, and a tail trim deletes exactly the one thing the
 * request is for: the reviewer then fails closed and every tool call in a long
 * session becomes an approval prompt.
 *
 * The order is a contract here, so nothing is moved. Instead the MIDDLE is
 * elided: the head (policy, environment, oldest items) and the final message
 * both survive whenever that message fits the budget on its own. A request that
 * nearly fills the budget by itself keeps its two ends and loses its middle.
 * Prompts that already fit, or whose last message is not recognisably at the
 * end, are returned untouched for the generic trim.
 */
export function protectTrailingRequest(prompt: string, messages: readonly Message[], maxBytes: number): string {
  if (utf8Bytes(prompt) <= maxBytes) return prompt
  let live = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = textOf(messages[i] as Message)
    const text = raw.trim() && prompt.endsWith(raw) ? raw : raw.trim()
    if (text !== '' && prompt.endsWith(text)) {
      live = text
      break
    }
  }
  if (live === '') return prompt
  const liveBytes = utf8Bytes(live)
  const headPart = prompt.slice(0, prompt.length - live.length)
  // The head is never squeezed below this — but it must scale with the budget,
  // or a fixed reserve larger than a small budget would crowd the request out.
  const minHead = Math.min(REQUEST_HEAD_RESERVE_BYTES, Math.floor(maxBytes / 4))
  if (liveBytes <= maxBytes - minHead) {
    // The request fits: the head gets what is left, elided in ITS middle so the
    // policy (head) and the newest history (just before the request) both stay.
    const headBudget = maxBytes - liveBytes - MARKER_SLACK_BYTES
    const head = utf8Bytes(headPart) <= headBudget ? headPart : elideMiddle(headPart, headBudget)
    return head + live
  }
  // The request alone nearly fills the budget: reserve the head's start and
  // elide the middle of the request rather than dropping the policy or its tail.
  const head = utf8Bytes(headPart) <= minHead ? headPart : trimToUtf8Bytes(headPart, minHead, false)
  return head + elideMiddle(live, maxBytes - utf8Bytes(head) - MARKER_SLACK_BYTES)
}

/** elideMiddle's own marker is ~25 bytes; leave room so the result stays within budget. */
const MARKER_SLACK_BYTES = 64
