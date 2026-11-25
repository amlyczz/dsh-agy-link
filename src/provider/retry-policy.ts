// Retry policy + the effort self-healing stream wrapper (issue #67).
//
// Extracted verbatim from AgyAdapter.providerRetryPolicy and AgyAdapter.stream.
// The adapter keeps the public overrides as thin delegates so behaviour and
// signatures are unchanged.
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { modelFamilyOf } from '../common/pool-types.ts'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import { Err, looksLikeTosViolation, NETWORK_RETRY_DELAYS_MS } from '../common/types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import { pickAuxFallbackCandidate } from './account-selection.ts'
import { parseEffortUnsupported, parseModelNotRecognized } from './effort-policy.ts'

/**
 * Fail fast on auth and abort; allow retries for transient process failures
 * (timeout, crash, malformed stream) per ADR-11.
 *
 * Account-scoped failures (RATE_LIMIT / ELIGIBILITY / NETWORK / OVERLOADED)
 * are retryable on purpose: the failed account was cooled down or skipped and
 * the sticky pointer advanced BEFORE the error surfaced, so the retry is
 * served by the NEXT account in the pool — quota exhaustion used to dead-end
 * in a user-visible error even though a healthy account was idle.
 *
 * The budget follows the pool: a 3-account pool gets 2 retries, because one
 * hop is not enough to survive a spent account followed by a second account
 * whose token expired mid-flight (observed live: primary ELIGIBILITY → g98
 * "not signed in" → turn lost, 2026-10-10 14:17). A single-account pool keeps
 * the old single retry.
 */
export function providerRetryPolicyFor(pool: AccountPoolManager | undefined) {
  const enabledAccounts = (pool?.getAccounts() ?? []).filter((a) => a.enabled).length
  const retryableCodes: string[] = [
    Err.TIMEOUT,
    Err.PROCESS_EXIT,
    Err.INVALID_OUTPUT,
    Err.RATE_LIMIT,
    Err.ELIGIBILITY,
    Err.NETWORK,
    Err.OVERLOADED,
  ]
  // A genuine sign-out is only worth retrying when the pool has ANOTHER
  // account that may still be signed in: the failed one is flagged
  // authRequired (excluded from rotation) and the retry continues the session
  // on the next account instead of interrupting it. With one account the
  // retry would just burn a second request against the same dead login.
  if (enabledAccounts >= 2) retryableCodes.push(Err.AUTH)
  // Two budgets in one number:
  //  - the pool needs one hop per spare account (a spent/expired account must
  //    not dead-end the turn while a healthy one sits idle), capped at 16 to
  //    preserve single-account fallback (1) while scaling with pool depth,
  //  - transport failures need enough hops to survive the 5s/15s/30s schedule
  //    stated as providerRetryAfterMs.
  // Whichever is larger wins; every extra hop is bounded (pool depth for the
  // account-scoped codes, the fixed schedule for NETWORK).
  const poolHops = Math.min(Math.max(1, enabledAccounts - 1), 16)
  return {
    mode: 'normal' as const,
    maxRetries: Math.max(poolHops, NETWORK_RETRY_DELAYS_MS.length),
    retryableCodes,
    initialDelayMs: 2_000,
    // Must stay at or above the longest transport delay: the retry plugin
    // DROPS a retry whose providerRetryAfterMs exceeds maxDelayMs.
    maxDelayMs: 45_000,
    jitterRatio: 0.1,
  }
}

/**
 * Codes whose recording is DEAD for good: the process that owned the run is
 * gone or produced nothing usable, so replaying the recording can only repeat
 * the identical error. A fresh attempt, on the other hand, spawns a new
 * `agy acp` and can still finish the turn.
 */
const REVIVABLE_FAILURE_CODES: ReadonlySet<string> = new Set([Err.TIMEOUT, Err.PROCESS_EXIT, Err.INVALID_OUTPUT])

/** True when a settled recording died of a process-level failure a fresh spawn can survive. */
export function isRevivableFailure(code: string | undefined): boolean {
  return code !== undefined && REVIVABLE_FAILURE_CODES.has(code)
}

export interface EffortRetryDeps {
  streamAttempt: (options: AgyGenerateOptions, suppressEffort: boolean) => AsyncIterable<StreamChunk>
  learnEffortUnsupported: (model: string) => void
  /** True when the live discovered catalog says this model accepts efforts. */
  catalogAdvertisesEffort?: (model: string) => boolean
  onModelUnsupported?: (model: string) => void
  pool?: AccountPoolManager
  defaultModel?: () => string
}

function isAuxCall(options: AgyGenerateOptions): boolean {
  return ((options.purpose as string | undefined) ?? 'chat') !== 'chat'
    || (typeof options.system === 'string' && options.system.includes('REVIEW_POLICY'))
}

function isAuxModelFallbackPurpose(options: AgyGenerateOptions): boolean {
  return options.purpose === 'compaction' || options.purpose === 'session-title'
}

function canFallbackAuxModel(
  deps: EffortRetryDeps,
  options: AgyGenerateOptions,
  emitted: boolean,
  finish: StreamChunk & { type: 'finish' },
  auxModelFallbacksUsed: number,
  rawMsg: string,
): { activeModel: string } | null {
  if (!isAuxModelFallbackPurpose(options) || emitted || options.signal?.aborted) return null
  if (auxModelFallbacksUsed >= 2 || finish.reason.kind !== 'error' || looksLikeTosViolation(rawMsg)) return null
  const code = (finish.reason as { failure?: { code?: string } }).failure?.code
  if (code !== Err.RATE_LIMIT && code !== Err.ELIGIBILITY && code !== Err.AUTH && code !== Err.OVERLOADED) return null
  if (!deps.pool) return null
  const model = options.model || deps.defaultModel?.() || 'gemini'
  const fb = pickAuxFallbackCandidate(deps.pool, modelFamilyOf(model), model)
  return fb ? { activeModel: fb.activeModel } : null
}

function canRetryAuxQuota(
  deps: EffortRetryDeps,
  options: AgyGenerateOptions,
  emitted: boolean,
  finish: StreamChunk & { type: 'finish' },
  quotaHops: number,
  rawMsg: string,
): boolean {
  if (!isAuxCall(options) || emitted || options.signal?.aborted) return false
  if (finish.reason.kind !== 'error' || looksLikeTosViolation(rawMsg)) return false
  const failure = (finish.reason as { failure?: { code?: string } }).failure
  const code = failure?.code
  if (code !== Err.RATE_LIMIT && code !== Err.ELIGIBILITY && code !== Err.AUTH) return false
  const pool = deps.pool
  if (!pool) return false
  const enabledCount = pool.getAccounts().filter((a) => a.enabled).length
  const maxHops = Math.min(Math.max(0, enabledCount - 1), 16)
  if (quotaHops >= maxHops) return false
  const model = options.model || deps.defaultModel?.() || 'gemini'
  const fam = modelFamilyOf(model)
  return pool.selectAccount(fam, model) !== null
}

/**
 * Effort self-healing wrapper around streamAttempt (issue #67).
 *
 * agy refuses an ENTIRE invocation when `--effort` is passed to a model that
 * does not accept one, and that refusal arrives before any output — so the call
 * is safe to replay. On the refusal the model is learned as effort-less (the
 * host persists it, so its picker row disappears and later runs never ask) and
 * the same call is replayed once without `--effort`: a hard turn failure
 * becomes one extra spawn. The refusal text itself is the evidence that WE
 * passed the flag, so the replay does not depend on who requested the effort
 * (an explicit request, `defaultEffort`, or the aux channel's pinning).
 *
 * Also rotates across spare pool accounts for auxiliary routes (`isAux`) that
 * bypass `dsh-llm-retry`, and switches accounts when a model is unrecognized.
 */
export async function* streamWithEffortRetry(
  deps: EffortRetryDeps,
  options: AgyGenerateOptions,
): AsyncIterable<StreamChunk> {
  let suppressEffort = false
  let effortSelfHealed = false
  let modelSelfHealed = false
  let quotaHops = 0
  let auxModelFallbacksUsed = 0
  let currentOptions = options
  const isAux = isAuxCall(options)
  const poolEnabled = deps.pool ? deps.pool.getAccounts().filter((a) => a.enabled).length : 0
  const maxAuxHops = Math.min(Math.max(0, poolEnabled - 1), 16)
  for (;;) {
    // A refused attempt emits a bare `usage` chunk before its error finish
    // (measured on agy 1.4.6). Usage is telemetry, not output: hold it back so
    // a replayed attempt cannot double-count tokens, and treat only real
    // content as "the caller has already seen something".
    let emitted = false
    const bufferAux = isAux && (quotaHops < maxAuxHops || (isAuxModelFallbackPurpose(currentOptions) && auxModelFallbacksUsed < 2))
    const buffered: StreamChunk[] = []
    const telemetry: StreamChunk[] = []
    let finish: (StreamChunk & { type: 'finish' }) | null = null
    for await (const chunk of deps.streamAttempt(currentOptions, suppressEffort)) {
      if (chunk.type === 'finish') {
        // Hold the finish back one step: a refusal must not reach the caller
        // when the replay is about to succeed.
        finish = chunk
        continue
      }
      if (chunk.type === 'usage') {
        telemetry.push(chunk)
        continue
      }
      if (bufferAux) {
        buffered.push(chunk)
        continue
      }
      emitted = true
      yield chunk
    }
    if (finish === null) {
      for (const chunk of buffered) yield chunk
      for (const chunk of telemetry) yield chunk
      return
    }
    if (!emitted && finish.reason.kind === 'error') {
      const failure = (finish.reason as { failure?: { message?: string } }).failure
      const rawMsg = String(failure?.message ?? '')
      if (buffered.length === 0) {
        const refused = parseEffortUnsupported(rawMsg)
        if (!effortSelfHealed && refused !== null) {
          effortSelfHealed = true
          suppressEffort = true
          // A refusal that CONTRADICTS the live discovered catalog is transient,
          // not a capability fact: agy emits the same text when its model-config
          // fetch fails. Replay without --effort (the #67 invariant) but do NOT
          // persist — persisting hides the model's effort row forever and makes
          // DSH reject later turns with UNSUPPORTED_REASONING_EFFORT (issue #115).
          if (deps.catalogAdvertisesEffort?.(refused) !== true) {
            deps.learnEffortUnsupported(refused)
          }
          continue
        }
        const unrecog = parseModelNotRecognized(rawMsg)
        if (!modelSelfHealed && unrecog !== null) {
          modelSelfHealed = true
          if (deps.onModelUnsupported) {
            deps.onModelUnsupported(unrecog)
            continue
          }
          if (deps.pool) {
            const fam = modelFamilyOf(unrecog)
            // finalizeAttempt already marked the failing account unsupported and advanced the pool.
            // Replay only if another eligible account can serve the model, without clobbering it.
            if (deps.pool.selectAccount(fam, unrecog) !== null) {
              continue
            }
          }
        }
      }
      if (canRetryAuxQuota(deps, currentOptions, emitted, finish, quotaHops, rawMsg)) {
        quotaHops++
        continue
      }
      const auxModelFb = canFallbackAuxModel(deps, currentOptions, emitted, finish, auxModelFallbacksUsed, rawMsg)
      if (auxModelFb !== null) {
        auxModelFallbacksUsed++
        currentOptions = { ...currentOptions, model: auxModelFb.activeModel }
        continue
      }
    }
    for (const chunk of buffered) yield chunk
    for (const chunk of telemetry) yield chunk
    yield finish
    return
  }
}