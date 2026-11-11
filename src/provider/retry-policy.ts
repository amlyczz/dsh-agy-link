// Retry policy + the effort self-healing stream wrapper (issue #67).
//
// Extracted verbatim from AgyAdapter.providerRetryPolicy and AgyAdapter.stream.
// The adapter keeps the public overrides as thin delegates so behaviour and
// signatures are unchanged.
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import { Err, NETWORK_RETRY_DELAYS_MS } from '../common/types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
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
  //    not dead-end the turn while a healthy one sits idle),
  //  - transport failures need enough hops to survive the 5s/15s/30s schedule
  //    stated as providerRetryAfterMs. A 14-minute egress outage (live
  //    2026-10-21 16:43) exhausted the old 2-hop/4s budget instantly.
  // Whichever is larger wins; every extra hop is bounded (pool depth for the
  // account-scoped codes, the fixed schedule for NETWORK).
  const poolHops = enabledAccounts >= 3 ? 2 : 1
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

export interface EffortRetryDeps {
  streamAttempt: (options: AgyGenerateOptions, suppressEffort: boolean) => AsyncIterable<StreamChunk>
  learnEffortUnsupported: (model: string) => void
  onModelUnsupported?: (model: string) => void
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
 */
export async function* streamWithEffortRetry(
  deps: EffortRetryDeps,
  options: AgyGenerateOptions,
): AsyncIterable<StreamChunk> {
  for (let attempt = 0; ; attempt++) {
    // A refused attempt emits a bare `usage` chunk before its error finish
    // (measured on agy 1.4.6). Usage is telemetry, not output: hold it back so
    // a replayed attempt cannot double-count tokens, and treat only real
    // content as "the caller has already seen something".
    let emitted = false
    const telemetry: StreamChunk[] = []
    let finish: StreamChunk | null = null
    for await (const chunk of deps.streamAttempt(options, attempt > 0)) {
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
      emitted = true
      yield chunk
    }
    if (finish === null) {
      for (const chunk of telemetry) yield chunk
      return
    }
    if (attempt === 0 && !emitted && finish.reason.kind === 'error') {
      const failure = (finish.reason as { failure?: { message?: string } }).failure
      const rawMsg = String(failure?.message ?? '')
      const refused = parseEffortUnsupported(rawMsg)
      if (refused !== null) {
        deps.learnEffortUnsupported(refused)
        continue
      }
      const unrecog = parseModelNotRecognized(rawMsg)
      if (unrecog !== null && deps.onModelUnsupported) {
        deps.onModelUnsupported(unrecog)
        continue
      }
    }
    for (const chunk of telemetry) yield chunk
    yield finish
    return
  }
}