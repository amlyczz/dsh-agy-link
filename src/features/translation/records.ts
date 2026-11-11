// Durable translation records and the in-memory cache key. Pure helpers used by
// the orchestration service; the record shape itself lives in types.ts.
import { createHash } from 'node:crypto'
import { PROVIDER_ID } from '../../common/types.ts'
import type { TranslateResult, TranslationRecord, TurnAnswer } from './types.ts'

/** Keep the durable record bounded: the card only needs the source for a diff-style read. */
export function capOriginal(text: string): string {
  return text.length <= 8_000 ? text : text.slice(0, 8_000) + '…'
}

export function cacheKey(model: string, effort: string, language: string, text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 32)
  return model + '|' + effort + '|' + language + '|' + hash
}

/**
 * Build the durable record for one translated answer. Optional fields are only
 * present (and appended in the same order) when their source existed, so the
 * persisted JSON stays byte-compatible with the pre-split writer.
 */
export function buildTranslationRecord(params: {
  turn: number
  answer: TurnAnswer
  res: TranslateResult
  now: number
}): TranslationRecord {
  const { turn, answer, res, now } = params
  const record: TranslationRecord = {
    version: 1,
    turn,
    anchorSeq: answer.anchorSeq,
    text: res.text,
    ...(answer.text.trim() === '' ? {} : { original: capOriginal(answer.text) }),
    model: res.model,
    effort: res.effort,
    provider: PROVIDER_ID,
    durationMs: res.durationMs,
    createdAt: now,
  }
  if (answer.messageId !== undefined) record.messageId = answer.messageId
  if (res.accountId !== undefined) record.accountId = res.accountId
  if (answer.sourceModel !== undefined) record.sourceModel = answer.sourceModel
  return record
}
