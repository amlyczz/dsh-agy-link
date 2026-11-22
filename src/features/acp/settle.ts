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
      ...(result.outcomeOverride === undefined ? {} : { outcomeOverride: result.outcomeOverride }),
    })
  } finally {
    recorder.stop()
    deps.unregisterActiveRun(sessionKey, recorder.rec)
    slot.releaseOnce()
    deps.clearInFlightPrompt(sessionKey, input.prompt)
    recorder.rec.settle(result.failure)
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

export async function settleEarlyAbort(
  deps: AttemptDeps,
  input: AttemptInput,
  slot: AttemptSlot,
  sid: string | null,
  message: string,
): Promise<RunRecording> {
  const recorder = createAttemptRecorder(deps, input.cfg, input.account, sid ?? input.binding?.conversationId, false)
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
