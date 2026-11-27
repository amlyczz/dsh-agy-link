// Classifying a failed ACP prompt.
//
// Split out of ./run-attempt.ts (size budget): the transport loop must stay
// readable, and this block is pure classification — it reads evidence and
// decides what the turn was, without touching the session.
//
// Note the two pieces of evidence that used to be mishandled here:
//   - `keyringJitter` was hard-coded false, so "the keyring helper timed out"
//     blips became real auth failures and rotated the account away;
//   - a transport failure returned WITHOUT a backoff, so the CLI fallback
//     retried instantly into the same dead egress (the CLI path stamps one).
import type { ModelFamily } from '../../common/pool-types.ts'
import {
  Err,
  isTransportFailure,
  looksLikeAuthFailure,
  looksLikeAuthVerificationJitter,
  looksLikeRateLimit,
  networkRetryDelayMs,
} from '../../common/types.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { RunRecording } from '../../host/recording.ts'
import type { RunOutcome } from '../../host/runner.ts'
import type { AttemptDeps, AttemptInput } from '../../provider/attempt.ts'
import { classifyFailure } from '../../provider/failure.ts'
import type { LiveQuotaFailoverState } from '../../provider/quota-failover.ts'
import type { AcpPromptOutcome } from './settle.ts'

export interface PromptFailureInput {
  cfg: AttemptInput['cfg']
  deps: AttemptDeps
  input: AttemptInput
  rec: RunRecording
  /** The thrown error (or anything else the transport threw). */
  err: unknown
  /** This turn's stderr slice, already trimmed to the prompt's window. */
  stderrText: string
  /** This turn's agy --log-file slice. */
  logText: string
  /** Live quota state when the quota controller triggered the kill. */
  quotaFailover: LiveQuotaFailoverState | null
  /** The turn was killed by the quota controller (not a timeout, not a cancel). */
  quotaCancelled: boolean
  /** At least one event reached the transcript. */
  emittedAny: boolean
  /** The model produced real output (text, thinking or a tool call). */
  sawRealOutput: boolean
  /** Families the live quota controller cooled down during the turn. */
  cooledInLiveFamilies: ReadonlySet<ModelFamily>
  startedAt: number
}

/** Turn one thrown prompt error into the attempt outcome the pool understands. */
export function buildPromptFailure(opts: PromptFailureInput): AcpPromptOutcome {
  const { cfg, deps, input, rec, stderrText: errText, logText, quotaFailover: liveQf } = opts
  const msg = opts.err instanceof Error ? opts.err.message : String(opts.err)
  const rawErrText = [msg, errText, liveQf?.rawErrorText].filter(Boolean).join(' ').trim()
  // A quota-triggered kill is not a timeout and not the user aborting: its
  // classification comes from the quota evidence, not from the error text.
  const timedOut = liveQf === null && /timed out/i.test(msg)
  const aborted = !opts.quotaCancelled && liveQf === null
    && (Boolean(input.signal?.aborted) || rec.isAbortRequested || /aborted|cancelled|canceled/i.test(msg))
  const outcome: RunOutcome = {
    code: 1,
    signal: null,
    timedOut,
    aborted,
    capped: false,
    stdout: '',
    stderrTail: errText,
    durationMs: Date.now() - opts.startedAt,
  }
  const evidence = {
    rawErrText,
    authFailureText: '',
    stderrTail: errText,
    stdoutHead: '',
    runLogText: logText,
  }
  const networkStreak = isTransportFailure(evidence) ? deps.noteNetworkFailure(input.sessionKey) : 0
  const failure = classifyFailure({
    cfg,
    outcome,
    parser: new StreamJsonParser(),
    sawAuthFailure: looksLikeAuthFailure(rawErrText),
    consumable: false,
    transportFailure: isTransportFailure(evidence),
    keyringJitter: looksLikeAuthVerificationJitter(`${errText} ${logText}`),
    rawErrText,
    isRateLimit: looksLikeRateLimit(rawErrText),
    silentTimeout: timedOut && !opts.emittedAny,
  }) ?? { kind: aborted ? 'aborted' : 'error', code: Err.AGY_ERROR, message: msg }
  // A transport failure that reaches the caller without a backoff makes the CLI
  // fallback retry instantly into the same dead egress.
  if (networkStreak > 0 && failure.retryAfterMs === undefined) {
    failure.retryAfterMs = networkRetryDelayMs(networkStreak)
  }
  return {
    failure,
    durationMs: outcome.durationMs,
    stderr: errText,
    rawErrText,
    runLogText: logText,
    silentTimeout: timedOut && !opts.emittedAny,
    outcomeOverride: outcome,
    quotaFailover: liveQf,
    cooledInLiveFamilies: opts.cooledInLiveFamilies,
    empty: !opts.sawRealOutput,
    keyringJitter: looksLikeAuthVerificationJitter(`${errText} ${logText}`),
  }
}

