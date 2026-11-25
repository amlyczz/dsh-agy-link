// Stable prompt identity for the duplicate/steer bookkeeping.
//
// The adapter prepends (or appends, behind a leading agy slash command) an
// interruption boundary notice after it preempts a live run. That notice is
// transport metadata, NOT part of the request: if it enters the stored
// baseline, the very next harness hop builds the same logical prompt WITHOUT
// the notice, `samePrompt` turns false, and the adapter aborts the live run it
// just started a continuation for. That was the `!samePrompt` session/cancel
// loop in issue #205.
//
// `promptIdentity` is the canonical form used for every comparison;
// `hasNewHumanTask` is the other half of the same decision — a hop with no new
// typed turn must never preempt the run that produced it.
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  collectMediaRefs,
  isMemorySnapshotMessage,
  isSyntheticHarnessMessage,
  isToolResultMessage,
  textOf,
  type MediaRefLike,
} from './prompt-text.ts'

/** The boundary notice injected when a live agy run is preempted by a steer. */
export const INTERRUPTION_NOTICE =
  '[the previous turn was interrupted before it finished — do not continue or answer that unfinished work; respond only to the newest request below]'

/**
 * Canonical prompt identity: the prompt with the interruption notice removed
 * and surrounding whitespace collapsed. Deterministic for both sides of a
 * comparison, so a notice-carrying dispatch and its notice-free replay hash to
 * the same string.
 */
export function promptIdentity(prompt: string): string {
  const withoutNotice = prompt.split(INTERRUPTION_NOTICE).join('')
  return withoutNotice.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * True when the request carries a REAL human turn after the last assistant
 * reply — the user typed something or attached media.
 *
 * Appending a tool result, a system/developer context refresh, a memory
 * snapshot or any other harness lifecycle message is NOT a steer: aborting the
 * run that is producing that continuation is a self-inflicted cancel loop
 * (issue #205).
 */
export function hasNewHumanTask(messages: readonly Message[]): boolean {
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  for (let i = messages.length - 1; i > lastAssistantIdx; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'user') continue
    if (isToolResultMessage(m) || isSyntheticHarnessMessage(m) || isMemorySnapshotMessage(m)) continue
    if (textOf(m).trim() !== '') return true
    // An image-only / attachment-only turn is still a human task.
    const refs: MediaRefLike[] = []
    collectMediaRefs(m, refs)
    if (refs.length > 0) return true
  }
  return false
}