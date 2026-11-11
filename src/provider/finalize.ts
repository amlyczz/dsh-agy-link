// Finalize side effects for one agy attempt (success or failure).
//
// Extracted verbatim from the tail of AgyAdapter.streamAttempt: everything that
// happens AFTER the run settled and after the pure failure classification
// (provider/failure.ts) has been computed. Splitting it out keeps the spawn /
// parser loop readable while preserving the exact ordering and object identity
// of every store write:
//
//   - success: record account success, drop failover/rate-limit budgets, clear
//     the network streak, and persist the conversation binding (message count,
//     model, sent image ids, input tokens).
//   - failure: rotate/quarantine the account per the pool policy, then either
//     delete a stale conversation binding or persist a resumable (interrupted)
//     one.
//   - always: emit the run telemetry (`onRun`) that feeds /agy status.
//
// This module owns no adapter state: every piece of mutable adapter-private
// state it touches is passed in as a callback or a value, so the adapter keeps
// being the single owner of activeRuns / failoverBudget / rateLimitFailover /
// networkStreak.
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  Err,
  isAuthoritativeAuthError,
  looksLikeHardRateLimit,
  shouldMarkAuthRequired,
  type RawUsage,
} from '../common/types.ts'
import type { ManagedAccount, ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import { SENT_IMAGE_IDS_MAX, type SessionBinding, type SessionStore } from '../host/sessions.ts'
import type { RunRecording } from '../host/recording.ts'
import type { RunOutcome } from '../host/runner.ts'
import type { AttemptFailure } from './failure.ts'

/** Shape of the /agy status last-run telemetry callback. */
export interface RunTelemetry {
  processOk: boolean
  processCode: string
  toolErrors: readonly string[]
  durationMs: number
  model: string
  /** Output-token speed over this run's generation steps (see RunRecording.speedStats). */
  tokenSpeed: ReturnType<RunRecording['speedStats']>
}

/**
 * Everything the finalize block reads. Values are copied as-is from
 * streamAttempt; `binding` keeps object identity so the same references the
 * caller held flow through untouched.
 */
export interface FinalizeInput {
  rec: RunRecording
  outcome: RunOutcome
  /** null = success; the classified failure otherwise. */
  failure: AttemptFailure | null
  store: SessionStore
  pool?: AccountPoolManager
  account?: ManagedAccount
  family: ModelFamily
  persistBinding: boolean
  sessionAccountKey: string
  binding?: SessionBinding
  conversationId: string | null
  messages: readonly Message[]
  /** Model slug reported to onRun (resolved model id). */
  model: string
  /** Active model recorded on the binding. */
  activeModel: string
  /** True when a newer run already owns the session — this closure's write is stale. */
  superseded: boolean
  /** Attachment ids forwarded during THIS attempt (success-path watermark merge). */
  newlySentImageIds: readonly string[]
  /** Raw error text used only by the failure-path auth/rate-limit heuristics. */
  rawErrText: string
  /** This run's agy log text used only by the authoritative-auth check. */
  runLogText: string
  /** Silent timeout: no stdout event at all — rotate without a cooldown. */
  silentTimeout: boolean
  sessionKey: string
  /** Adapter-private state, injected as callbacks. */
  clearNetworkStreak: (sessionKey: string) => void
  dropFailoverBudget: (sessionKey: string) => void
  clearRateLimitFailover: (sessionKey: string) => void
  sharesSingleEgress: () => boolean
  onRun?: (info: RunTelemetry) => void
}

/**
 * Apply the post-run side effects for one settled attempt. Declared async to
 * sit naturally in the caller's async closure; the body is synchronous, so all
 * effects land in the same turn exactly as the inline block did.
 */
export async function finalizeAttempt(input: FinalizeInput): Promise<void> {
  if (input.failure === null) {
    applySuccess(input)
  } else {
    applyFailure(input, input.failure)
  }
  emitRunTelemetry(input)
}

// ---- success path ---------------------------------------------------------

function applySuccess(input: FinalizeInput): void {
  if (input.account) input.pool?.recordSuccess(input.account.id, input.family)
  input.dropFailoverBudget(input.sessionKey)
  input.clearRateLimitFailover(input.sessionKey)
  input.clearNetworkStreak(input.sessionKey)
  if (input.persistBinding && input.sessionAccountKey !== '' && !input.superseded) {
    writeSuccessBinding(input)
  }
}

function writeSuccessBinding(input: FinalizeInput): void {
  const finalId = input.binding !== undefined ? input.binding.conversationId : input.conversationId
  if (!finalId) return
  const inputTokens = resolveInputTokens(input.rec, input.binding)
  input.store.set(input.sessionAccountKey, {
    conversationId: finalId,
    lastMessageCount: input.messages.length,
    updatedAt: Date.now(),
    model: input.activeModel,
    sentImageIds: mergeSentImageIds(input.binding?.sentImageIds, input.newlySentImageIds),
    ...(typeof inputTokens === 'number' && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
  })
}

// ---- failure path ---------------------------------------------------------

function applyFailure(input: FinalizeInput, failure: AttemptFailure): void {
  rotateOnFailure(input, failure)
  persistFailureBinding(input, failure)
}

/**
 * Account rotation / quarantine policy for a failed attempt. Moved verbatim;
 * the ordering of these mutating pool calls is load-bearing.
 */
function rotateOnFailure(input: FinalizeInput, failure: AttemptFailure): void {
  const { account, pool, family, outcome } = input
  // Cooldown is a costly local penalty (account leaves rotation): only
  // HARD server-issued signatures may trigger it. Soft signals (model
  // overloaded) shape the message above but never cool the account.
  // Caller-aborted runs (stop button / steer preemption) are NOT server
  // rate limits and must never slap a cooldown on the account.
  if (account && !outcome.aborted && looksLikeHardRateLimit(input.rawErrText)) {
    pool?.recordFailure(account.id, family, failure.message)
  }
  // Silent timeout: rotate to the next account for the automatic retry
  // WITHOUT a cooldown. A 15-minute penalty for what may be a transient
  // network blip would pull every account out of rotation and turn the
  // accurate "cannot reach Google" hint into a misleading "all accounts
  // in cooldown".
  if (account && input.silentTimeout) {
    pool?.advanceAccount(account.id, family)
  }
  // Region refusal is scoped to the account's own egress (skip the
  // primary's direct connection, take a proxied account). Rotate so the
  // automatic retry cannot land back on the refused account.
  if (account && failure.code === Err.ELIGIBILITY) {
    pool?.advanceAccount(account.id, family)
  }
  // Account-scoped failures must not let the retry land back on the
  // account that could not serve this turn. One rotation per failure:
  //  - NETWORK / OVERLOADED: transport blip or capacity refusal. Nothing
  //    was spent, so NO cooldown — a 15-minute penalty would only shrink
  //    the pool.
  //  - AUTH: the account is marked authRequired below, which already
  //    excludes it from rotation; rotating here makes the intent explicit.
  // Account-scoped failures that must advance the pointer so the retry tries another account:
  //  - RATE_LIMIT: account quota spent (cooldown applied in recordFailure above)
  //  - NETWORK / AUTH: transport blip or dead login for this specific account
  // Server capacity overload (OVERLOADED / 503 / 529): Google-side pressure.
  // We deliberately STAY on the current account with exponential backoff rather
  // than rotating, protecting healthy accounts in the pool from cascaded exhaustion.
  //
  // A transport failure only belongs on that list when the accounts have
  // SEPARATE egress. With one shared proxy the failure says nothing about
  // the account: rotating repoints the session, drops the conversation
  // binding and spends the rotation budget a quota hop needs.
  const sharedEgressNetwork = failure.code === Err.NETWORK && input.sharesSingleEgress()
  const rotateAway = !outcome.aborted && failure.code !== Err.RATE_LIMIT
    && failure.code !== Err.OVERLOADED
    && !sharedEgressNetwork
    && (failure.code === Err.NETWORK
      || failure.code === Err.AUTH)
  if (rotateAway && account) pool?.advanceAccount(account.id, family)
  // Only authoritative auth states may flag an account: the old
  // /auth/i substring matched "oauth2.googleapis.com … i/o timeout"
  // transport noise and quarantined healthy accounts until a manual
  // quota refresh disproved the flag. NETWORK is not AUTH, and
  // shouldMarkAuthRequired additionally exempts transport-shaped text.
  if (account && shouldMarkAuthRequired(failure.code, failure.message)) {
    // Authoritative OAuth evidence (invalid_grant, revoked…) or the
    // explicit re-login paths quarantine immediately. A bare "not signed
    // in" banner carries no such proof — it is byte-identical for a real
    // sign-out and a keyring validation that lost the network race — so
    // it needs a second independent confirmation before it may take the
    // account out of rotation.
    const authoritative = isAuthoritativeAuthError(input.rawErrText + ' ' + input.runLogText)
    if (failure.code === Err.AUTH && !authoritative) {
      pool?.noteAuthFailure(account.id, failure.message)
    } else {
      pool?.markAuthRequired(account.id, failure.message)
    }
  }
}

/**
 * Decide whether the failed turn's conversation binding is dropped (stale) or
 * persisted as resumable-interrupted, then write it.
 */
function persistFailureBinding(input: FinalizeInput, failure: AttemptFailure): void {
  // A conversation only becomes unusable when the login died or agy
  // itself rejected the id. Rate limits / overload / transport blips do
  // NOT invalidate it: deleting the binding there threw away a resumable
  // native conversation (and its tool history) for a 15-minute cooldown,
  // forcing a fresh 660K-char digest seed on the next turn.
  const staleConversation =
    failure.code === Err.AUTH ||
    (failure.message !== '' && /conversation.*(not found|invalid|not recognized|expired|does not exist)|session.*(expired|invalid)/i.test(failure.message))
  // The run was cut mid-flight (Stop button / steer preemption / idle
  // watchdog) or aborted before it finished. agy's server-side turn has
  // no finalized reply, so the NEXT prompt must say so explicitly —
  // otherwise the model treats the interrupted user turn as the live
  // question and answers it instead of the newest message (the "latest
  // input ignored" bug, reproduced from session-c65a826e turns 17→19).
  const interruptedTurn = failure.kind === 'aborted' || input.outcome.timedOut === true
  if (input.persistBinding && input.sessionAccountKey !== '' && staleConversation) {
    // If auth expired or conversation rejected, drop stale binding
    input.store.delete(input.sessionAccountKey)
  } else if (input.persistBinding && input.sessionAccountKey !== '' && !input.superseded) {
    // Abort / timeout / process-exit still leave a usable agy
    // conversation behind once init or the result envelope named one.
    // Persisting it here is what lets the next hop continue instead of
    // starting a fresh conversation with a digest-only prompt
    // (issue #35 root cause ②: "aborted 分支永远存不下来").
    const finalId = input.binding !== undefined ? input.binding.conversationId : input.conversationId
    if (!finalId) return
    const inputTokens = resolveInputTokens(input.rec, input.binding)
    input.store.set(input.sessionAccountKey, {
      conversationId: finalId,
      lastMessageCount: input.messages.length,
      updatedAt: Date.now(),
      model: input.activeModel,
      // Images are only "delivered" when the run actually consumed
      // them. A killed run used to mark its staged screenshots as sent,
      // so re-sending the same image after a Stop was silently deduped
      // away and an image-only follow-up died with "request carries no
      // user text or images".
      sentImageIds: mergeSentImageIds(input.binding?.sentImageIds, []),
      ...((interruptedTurn || input.binding?.interrupted === true) ? { interrupted: true } : {}),
      ...(typeof inputTokens === 'number' && inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
    })
  }
}

// ---- telemetry ------------------------------------------------------------

function emitRunTelemetry(input: FinalizeInput): void {
  const { outcome } = input
  input.onRun?.({
    // A response can be usable even when agy reports an individual tool
    // failure. Keep process health distinct from those raw tool errors:
    // collapsing them into one "ok" bit hid real denials in /agy status.
    processOk: !outcome.aborted && !outcome.timedOut && !outcome.capped && outcome.code === 0,
    processCode: outcome.aborted
      ? 'ABORTED'
      : outcome.timedOut
        ? Err.TIMEOUT
        : outcome.code === 0
          ? 'OK'
          : 'EXIT_' + String(outcome.code),
    toolErrors: input.rec.toolErrors(),
    durationMs: outcome.durationMs,
    model: input.model,
    tokenSpeed: input.rec.speedStats(),
  })
}

// ---- shared helpers (moved verbatim from adapter.ts) ----------------------

/** Input-token count to persist: last per-call step sample, else envelope. */
function resolveInputTokens(rec: RunRecording, binding: SessionBinding | undefined): number | undefined {
  const finalUsage = rec.lastUsage ?? rec.finalUsage({})
  const promptTokens = calcPromptTokens(finalUsage)
  return promptTokens ?? (
    typeof finalUsage?.input_tokens === 'number' && finalUsage.input_tokens > 0
      ? finalUsage.input_tokens
      : binding?.lastInputTokens
  )
}

export function calcPromptTokens(usage: RawUsage | null | undefined): number | undefined {
  if (!usage) return undefined
  const input = typeof usage.input_tokens === 'number' && usage.input_tokens > 0 ? usage.input_tokens : 0
  const cacheRead = typeof usage.cache_read_tokens === 'number' && usage.cache_read_tokens > 0 ? usage.cache_read_tokens : 0
  const cacheWrite = typeof usage.cache_write_tokens === 'number' && usage.cache_write_tokens > 0 ? usage.cache_write_tokens : 0
  const totalPrompt = input + cacheRead + cacheWrite
  return totalPrompt > 0 ? totalPrompt : undefined
}

/** Merge newly forwarded attachment ids into a bounded, oldest-first list. */
export function mergeSentImageIds(
  existing: readonly string[] | undefined,
  added: readonly string[],
  max = SENT_IMAGE_IDS_MAX,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...(existing ?? []), ...added]) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > max ? out.slice(out.length - max) : out
}
