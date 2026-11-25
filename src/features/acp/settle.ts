// Settling one ACP attempt: finalize the recording exactly like the CLI path
// and release everything the ACP transport borrowed (slot, active run, watcher).
//
// Split out of ./run-attempt.ts to keep that file inside the size budget; the
// semantics are unchanged.
import type { ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import { Err } from '../../common/types.ts'
import type { RunRecording } from '../../host/recording.ts'
import type { RunOutcome } from '../../host/runner.ts'
import { createAttemptRecorder, type AttemptDeps, type AttemptInput, type AttemptSlot } from '../../provider/attempt.ts'
import type { AttemptFailure } from '../../provider/failure.ts'
import { finalizeAttempt } from '../../provider/finalize.ts'
import type { LiveQuotaFailoverState } from '../../provider/quota-failover.ts'
import type { AcpProcess } from './client.ts'
import type { acpPromptResultToAgyEvent } from './protocol.ts'

const INVALID_OUTPUT_RE = /model produced invalid output/i
const AGY_INFRA_BANNER =
  /(failed to construct executor|plan model not specified|failed to fetch user info|proxyconnect|failed to construct (?:the )?executor)/i

/**
 * True when an ACP prompt ended with either an empty thinking-only turn (no
 * visible text and no tool calls) or agy's transient `⚠ Model produced invalid
 * output.` error, making a single same-session warm nudge worthwhile.
 */
export function shouldSelfHealAcpResult(
  resEv: ReturnType<typeof acpPromptResultToAgyEvent>,
  flags: { sawText: boolean; sawThinking: boolean; sawTools: boolean },
): boolean {
  if (resEv.kind !== 'result') return false
  if (flags.sawTools) return false
  if (INVALID_OUTPUT_RE.test(resEv.error ?? '') || INVALID_OUTPUT_RE.test(resEv.response)) return true
  return resEv.ok && !flags.sawText && flags.sawThinking && resEv.response.trim() === ''
}

/** Recognise agy's own 1-2 line infrastructure banners sent as end_turn text. */
export function isAgyFailureBanner(text: string): boolean {
  const body = text.trim()
  if (body === '') return false
  const lines = body.split('\n').filter((l) => l.trim() !== '')
  return lines.length <= 2 && AGY_INFRA_BANNER.test(body)
}

export interface AcpPromptOutcome {
  failure: AttemptFailure | null
  durationMs: number
  /** This turn's stderr slice only. */
  stderr: string
  rawErrText: string
  runLogText: string
  silentTimeout: boolean
  outcomeOverride?: RunOutcome
  /** Live quota failover state when the turn was ended by a quota trigger. */
  quotaFailover?: LiveQuotaFailoverState | null
  /** Model families the live quota controller cooled down during the turn. */
  cooledInLiveFamilies?: ReadonlySet<ModelFamily>
  /** Nothing at all was emitted — safe to re-run on the CLI transport. */
  empty: boolean
  /**
   * The failure was only a keyring/token-refresh blip. Retrying it on the CLI
   * transport would just re-trigger the same blip AND spend a second credential
   * handoff, so this one is surfaced instead of retried.
   */
  keyringJitter?: boolean
}

export function buildAcpPromptOutcome(
  failure: AttemptFailure | null,
  startedAt: number,
  stderr: string,
  cooledInLiveFamilies: AcpPromptOutcome['cooledInLiveFamilies'],
): AcpPromptOutcome {
  return {
    failure,
    durationMs: Date.now() - startedAt,
    stderr,
    rawErrText: '',
    runLogText: '',
    silentTimeout: false,
    empty: false,
    cooledInLiveFamilies,
  }
}


export async function settleAcpOutcome(opts: {
  deps: AttemptDeps
  input: AttemptInput
  rec: RunRecording
  account: ManagedAccount | undefined
  sid: string | null
  failure: AttemptFailure | null
  durationMs: number
  stderr: string
  rawErrText: string
  runLogText: string
  silentTimeout: boolean
  quotaFailover?: LiveQuotaFailoverState | null
  cooledInLiveFamilies?: ReadonlySet<ModelFamily>
  outcomeOverride?: RunOutcome
}): Promise<void> {
  const {
    deps, input, rec, account, sid, failure, durationMs, stderr, rawErrText, runLogText, silentTimeout,
    quotaFailover, cooledInLiveFamilies, outcomeOverride,
  } = opts
  const outcome: RunOutcome = outcomeOverride ?? {
    code: failure ? 1 : 0,
    signal: null,
    timedOut: failure?.code === Err.TIMEOUT,
    aborted: failure?.kind === 'aborted' || Boolean(input.signal?.aborted),
    capped: false,
    stdout: '',
    stderrTail: stderr,
    durationMs,
  }
  await finalizeAttempt({
    rec,
    outcome,
    failure,
    store: deps.store,
    ...(deps.pool === undefined ? {} : { pool: deps.pool }),
    ...(account === undefined ? {} : { account }),
    family: input.family,
    persistBinding: input.persistBinding,
    sessionAccountKey: input.sessionAccountKey,
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    conversationId: sid,
    cwd: input.binding?.cwd || input.workspaceRoot,
    messages: input.messages,
    model: input.model,
    activeModel: input.activeModel,
    superseded: deps.isSuperseded(input.sessionKey, rec),
    newlySentImageIds: input.newlySentImageIds,
    rawErrText,
    runLogText,
    silentTimeout,
    sessionKey: input.sessionKey,
    ...(quotaFailover === undefined ? {} : { quotaFailover }),
    ...(cooledInLiveFamilies === undefined ? {} : { cooledInLiveFamilies }),
    clearNetworkStreak: (k) => deps.clearNetworkStreak(k),
    dropFailoverBudget: (k) => deps.dropFailoverBudget(k),
    clearRateLimitFailover: (k) => deps.clearRateLimitFailover(k),
    sharesSingleEgress: () => deps.sharesSingleEgress(),
    ...(deps.onRun === undefined ? {} : { onRun: deps.onRun }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })
}

/** Settle the attempt and release everything the ACP path borrowed. */
export async function finishAcpAttempt(opts: {
  deps: AttemptDeps
  input: AttemptInput
  recorder: ReturnType<typeof createAttemptRecorder>
  slot: AttemptSlot
  proc: AcpProcess
  sid: string
  result: AcpPromptOutcome
}): Promise<void> {
  const { deps, input, recorder, slot, proc, sid, result } = opts
  const { sessionKey } = input
  try {
    await settleAcpOutcome({
      deps,
      input,
      rec: recorder.rec,
      account: input.account,
      sid,
      failure: result.failure,
      durationMs: result.durationMs,
      stderr: result.stderr,
      rawErrText: result.rawErrText,
      runLogText: result.runLogText,
      silentTimeout: result.silentTimeout,
      ...(result.quotaFailover === undefined ? {} : { quotaFailover: result.quotaFailover }),
      ...(result.cooledInLiveFamilies === undefined ? {} : { cooledInLiveFamilies: result.cooledInLiveFamilies }),
      ...(result.outcomeOverride === undefined ? {} : { outcomeOverride: result.outcomeOverride }),
    })
    if (!input.isAux && input.account !== undefined && result.failure === null) {
      deps.onAccountUsed?.(input.account.id, input.family)
    }
  } finally {
    recorder.stop()
    deps.unregisterActiveRun(sessionKey, recorder.rec)
    slot.releaseOnce()
    deps.clearInFlightPrompt(sessionKey, input.prompt)
    recorder.rec.settle(result.failure)
    if (input.isAux && !input.persistBinding && typeof proc.closeSession === 'function') {
      void proc.closeSession(sid)
    }
    if (!input.isAux && sessionKey !== '') {
      deps.backgroundObserver?.onAttemptSettled?.({
        sessionKey,
        conversationId: sid,
        ...(recorder.rec.accountHome === undefined ? {} : { accountHome: recorder.rec.accountHome }),
        transport: 'acp',
        recording: recorder.rec,
        failure: result.failure,
        superseded: deps.isSuperseded(sessionKey, recorder.rec),
        acpProcess: proc,
        acpSessionId: sid,
      })
    }
  }
}

/**
 * Settle a turn that must NOT be retried on the CLI transport (an identity /
 * credential failure). Re-running it over CLI would pick the same wrong
 * account and burn more quota; surface an actionable AUTH error instead.
 */
export async function settleEarlyFailure(
  deps: AttemptDeps,
  input: AttemptInput,
  slot: AttemptSlot,
  sid: string | null,
  failure: AttemptFailure,
): Promise<RunRecording> {
  const recorder = createAttemptRecorder(deps, input.cfg, input.account, sid ?? input.binding?.conversationId, false)
  try {
    await settleAcpOutcome({
      deps, input, rec: recorder.rec, account: input.account, sid,
      failure, durationMs: 0, stderr: '', rawErrText: failure.message, runLogText: '', silentTimeout: false,
    })
  } finally {
    recorder.stop()
    slot.releaseOnce()
    deps.clearInFlightPrompt(input.sessionKey, input.prompt)
    recorder.rec.settle(failure)
  }
  return recorder.rec
}

/** Which identity gate fired, from its message prefix. */
export function identityFailureKind(message: string): 'mismatch' | 'unproven' | null {
  if (/^ACP identity unproven/i.test(message)) return 'unproven'
  if (/^ACP identity mismatch/i.test(message)) return 'mismatch'
  return null
}

/**
 * Settle an identity-gate failure.
 *
 * `mismatch` — the log names ANOTHER account (or proves a keyring fallback with
 * no transport excuse): that login is unusable, so it is AUTH and the account is
 * flagged. `unproven` — agy fell back to the keyring and its own userinfo lookup
 * died on the network: nothing is known about the login, so it is a retryable
 * NETWORK failure that rotates the turn and never writes a 需重新登录 flag (a
 * false positive there used to cost ~70 minutes of red badge).
 */
export async function settleIdentityFailure(
  deps: AttemptDeps,
  input: AttemptInput,
  slot: AttemptSlot,
  sid: string | null,
  message: string,
  kind: 'mismatch' | 'unproven',
): Promise<RunRecording> {
  return settleEarlyFailure(deps, input, slot, sid, {
    kind: 'error',
    code: kind === 'unproven' ? Err.NETWORK : Err.AUTH,
    message,
  })
}

export async function settleEarlyAbort(
  deps: AttemptDeps,
  input: AttemptInput,
  slot: AttemptSlot,
  sid: string | null,
  message: string,
): Promise<RunRecording> {
  const recorder = createAttemptRecorder(deps, input.cfg, input.account, sid ?? input.binding?.conversationId, false)
  recorder.setTrackerSession?.(input.sessionKey)
  const failure: AttemptFailure = { kind: 'aborted', code: Err.AGY_ERROR, message }
  try {
    await settleAcpOutcome({
      deps, input, rec: recorder.rec, account: input.account, sid,
      failure, durationMs: 0, stderr: '', rawErrText: '', runLogText: '', silentTimeout: false,
    })
  } finally {
    recorder.stop()
    slot.releaseOnce()
    deps.clearInFlightPrompt(input.sessionKey, input.prompt)
    recorder.rec.settle(failure)
  }
  return recorder.rec
}
