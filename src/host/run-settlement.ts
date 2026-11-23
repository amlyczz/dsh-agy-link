// How a finished agy run settles the account pool. One classification shared by
// the one-shot runner (src/host/oneshot.ts) and external credential leases
// (src/host/external-lease.ts), so a run reported by an external process moves
// the pool exactly the way the same failure inside this plugin would.
import {
  extractQuotaErrorModel,
  isHardQuotaResultError,
  isNonConsumableResultError,
  isTransientBurstRateLimit,
  looksLikeAuthFailure,
  looksLikeEligibilityFailure,
  looksLikeHardRateLimit,
  isModelScopedQuotaFailure,
  looksLikeTosViolation,
  parseResetDurationMs,
  shouldMarkAuthRequired,
} from '../common/types.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import { parseModelNotRecognized } from '../provider/effort-policy.ts'
import type { AccountPoolManager } from './pool.ts'
import type { SlotUnavailableError } from './credential-slot.ts'

export type SettlementPool = Pick<
  AccountPoolManager,
  'markAuthRequired' | 'recordFailure' | 'advanceAccount' | 'noteAuthFailure'
> & Partial<Pick<AccountPoolManager, 'markModelUnsupported'>>

export interface RunFailureFacts {
  /** Every error signal of the run joined: envelope error, last result error, stderr tail, failed response. */
  rawErr: string
  /** The result envelope's response text. */
  resultText: string
  /** The result envelope's ok flag; null when no envelope arrived. */
  resultOk: boolean | null
  resultError?: string
  /** Usable output of the run; '' when it produced none. */
  text: string
  sawAuthFailure?: boolean
  /** Model named by an `--effort` refusal (only when the run passed --effort). */
  effortRefusedModel?: string | null
}

export type RunFailure =
  | { kind: 'tos'; error: string }
  | { kind: 'effort'; refusedModel: string }
  | { kind: 'quota'; error: string }
  | { kind: 'model_unsupported'; error: string }
  | { kind: 'eligibility'; error: string }
  | { kind: 'auth'; error: string }
  | { kind: 'non_consumable'; error: string }

export const NOT_SIGNED_IN_ERROR = 'agy is not signed in — run /agy auth'

/**
 * Classify a finished run and apply its pool side effects. Returns null when
 * the run is not one of the classified failures (the caller decides between
 * success, an exit-code error and empty output). Order matters and mirrors the
 * original inline one-shot checks: TOS, effort refusal, hard quota, model not
 * recognized, then eligibility / auth / other non-consumable failures.
 */
export function settleRunFailure(
  pool: SettlementPool | undefined,
  account: ManagedAccount | undefined,
  family: ModelFamily,
  model: string | undefined,
  facts: RunFailureFacts,
): RunFailure | null {
  const { rawErr, resultText, resultOk, resultError, text } = facts
  if (looksLikeTosViolation(rawErr) || looksLikeTosViolation(resultText)) {
    if (pool && account) pool.markAuthRequired(account.id, rawErr || resultText)
    return { kind: 'tos', error: rawErr || resultText || 'TOS_VIOLATION' }
  }

  if (facts.effortRefusedModel !== undefined && facts.effortRefusedModel !== null) return { kind: 'effort', refusedModel: facts.effortRefusedModel }

  const hardQuota =
    isHardQuotaResultError(resultOk !== false, resultError, resultText)
    || (looksLikeHardRateLimit(rawErr) && !isTransientBurstRateLimit(rawErr))
  const modelScopedQuota = isModelScopedQuotaFailure(rawErr)
  if (hardQuota) {
    const errModel = extractQuotaErrorModel(rawErr)
    const modelFam = errModel ? modelFamilyOf(errModel) : undefined
    const targetFam: ModelFamily = modelFam && modelFam !== 'unknown' ? modelFam : family
    const resetMs = parseResetDurationMs(rawErr)
    const resetIso = resetMs && resetMs > 0 ? new Date(Date.now() + resetMs).toISOString() : undefined
    if (pool && account) {
      if (modelScopedQuota) pool.advanceAccount(account.id, targetFam, model)
      else pool.recordFailure(account.id, targetFam, rawErr || 'quota exhausted', resetIso)
      if (targetFam !== family) pool.advanceAccount(account.id, family, model)
    }
    return { kind: 'quota', error: rawErr || 'Antigravity quota / rate limit reached' }
  }

  if (rawErr !== '' && (text === '' || resultOk === false)) {
    const badModel = parseModelNotRecognized(rawErr)
    if (badModel !== null && pool && account) {
      if (typeof pool.markModelUnsupported === 'function') pool.markModelUnsupported(account.id, badModel)
      pool.advanceAccount(account.id, family, model)
      return { kind: 'model_unsupported', error: rawErr }
    }
  }

  const nonConsumable = resultOk === false && isNonConsumableResultError(false, resultError, resultText)
  if (nonConsumable || text === '') {
    if (looksLikeEligibilityFailure(rawErr)) {
      if (pool && account) pool.advanceAccount(account.id, family, model)
      return { kind: 'eligibility', error: rawErr }
    }
    if (looksLikeAuthFailure(rawErr) || facts.sawAuthFailure === true) {
      if (pool && account && shouldMarkAuthRequired('AUTH', rawErr)) {
        pool.noteAuthFailure(account.id, rawErr)
        pool.advanceAccount(account.id, family, model)
      }
      return { kind: 'auth', error: NOT_SIGNED_IN_ERROR }
    }
    if (nonConsumable) return { kind: 'non_consumable', error: rawErr || resultText }
  }
  return null
}

/**
 * The slot refused to hand over: quarantine the account, except when only the
 * primary re-assertion failed for an isolated secondary (then just move on).
 */
export function settleSlotUnavailable(
  pool: SettlementPool,
  account: ManagedAccount,
  family: ModelFamily,
  model: string | undefined,
  err: SlotUnavailableError,
): void {
  const isPrimaryAccount = Boolean(account.systemHome) || !account.dir
  if (err.target !== 'primary' || isPrimaryAccount) pool.markAuthRequired(account.id, err.message)
  else pool.advanceAccount(account.id, family, model)
}
