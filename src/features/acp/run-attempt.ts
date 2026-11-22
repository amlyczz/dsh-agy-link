// Execute one AttemptInput over the persistent `agy acp` session pool,
// populating the same RunRecording + finalizeAttempt lifecycle as the CLI path.
import type { ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import {
  Err,
  isNonConsumableResultError,
  isTransportFailure,
  looksLikeAuthFailure,
  looksLikeRateLimit,
} from '../../common/types.ts'
import { agyHomeDirFor, readAgyRunLogText, snapshotAgyLogs, type AgyLogSnapshot } from '../../host/agy-log.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { RunRecording } from '../../host/recording.ts'
import { resolveModelSlug } from '../../host/models.ts'
import { ensureIsolatedKeychain, type RunOutcome } from '../../host/runner.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import { createAttemptRecorder, type AttemptDeps, type AttemptInput, type AttemptSlot } from '../../provider/attempt.ts'
import { classifyFailure, type AttemptFailure } from '../../provider/failure.ts'
import { finalizeAttempt } from '../../provider/finalize.ts'
import {
  createLiveQuotaController,
  reportDirectToolQuota,
  type LiveQuotaFailoverState,
} from '../../provider/quota-failover.ts'
import { SubagentTracker } from '../subagent/tracker.ts'
import type { AcpProcess } from './client.ts'
import type { AcpSessionPool } from './pool.ts'
import { acpPromptResultToAgyEvent, acpUpdateToAgyEvents, createAcpStreamState } from './protocol.ts'

async function settleAcpOutcome(opts: {
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

async function driveAcpPrompt(opts: {
  deps: AttemptDeps
  input: AttemptInput
  recorder: ReturnType<typeof createAttemptRecorder>
  slot: AttemptSlot
  proc: AcpProcess
  sid: string
  runLogHome: string
  runLogsBefore: AgyLogSnapshot
}): Promise<void> {
  const { deps, input, recorder, slot, proc, sid, runLogHome, runLogsBefore } = opts
  const { cfg, account, sessionKey } = input
  const startedAt = Date.now()
  const streamState = createAcpStreamState()
  let emittedAny = false
  let terminalFailure: AttemptFailure | null = null
  let quotaCancelled = false
  const quotaCtrl = createLiveQuotaController({
    pool: deps.pool,
    account,
    inputFamily: input.family,
    activeModel: input.activeModel,
    emitNotice: (stepKey, text) => recorder.rec.append({ kind: 'step', stepKey, stepKind: 'subagent', text, raw: {} }),
    onTriggerKill: () => {
      quotaCancelled = true
      proc.cancelSession(sid)
    },
  })
  const subTracker = !input.isAux && sid !== ''
    ? new SubagentTracker({
        conversationId: sid,
        resumed: Boolean(input.binding?.conversationId),
        accountHome: recorder.rec.accountHome,
        log: deps.log,
        onEvent: (ev) => recorder.rec.append(ev),
        onQuotaExhausted: (info) => quotaCtrl.handleQuotaExhausted(info),
      })
    : null

  try {
    subTracker?.start()
    const idleMs = cfg.timeoutMs
    const longToolIdleMs = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes * 60_000 : 0
    const maxTurnMs = cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : 0
    const result = await proc.prompt({
      sessionId: sid,
      text: input.prompt,
      timeoutMs: idleMs,
      idleTimeoutMs: idleMs,
      longToolIdleMs,
      maxTurnMs,
      ...(input.signal ? { signal: input.signal } : {}),
      onUpdate: (update) => {
        for (const ev of acpUpdateToAgyEvents(sid, update, streamState)) {
          emittedAny = true
          recorder.rec.append(ev)
          input.agyOnEvent?.(ev)
          reportDirectToolQuota(quotaCtrl, ev)
        }
      },
    })
    subTracker?.flush()
    const liveQf = quotaCtrl.failoverState()
    if (liveQf !== null) {
      throw new Error(liveQf.rawErrorText)
    }
    const resEv = acpPromptResultToAgyEvent(sid, result, streamState.accumulatedText)
    recorder.rec.append(resEv)
    input.agyOnEvent?.(resEv)
    if (resEv.kind === 'result' && !resEv.ok && (resEv.response === '' || isNonConsumableResultError(resEv.ok, resEv.error, resEv.response))) {
      throw new Error(resEv.error ?? 'ACP prompt returned error without response')
    }
    await settleAcpOutcome({
      deps, input, rec: recorder.rec, account, sid,
      failure: null, durationMs: Date.now() - startedAt,
      stderr: proc.stderr, rawErrText: '', runLogText: '', silentTimeout: false,
      cooledInLiveFamilies: quotaCtrl.cooledFamilies(),
    })
  } catch (err) {
    subTracker?.flush()
    const liveQf = quotaCtrl.failoverState()
    const msg = err instanceof Error ? err.message : String(err)
    const rawErrText = [msg, proc.stderr, liveQf?.rawErrorText].filter(Boolean).join(' ').trim()
    const runLogText = readAgyRunLogText(runLogHome, runLogsBefore)
    const timedOut = liveQf === null && /timed out/i.test(msg)
    const aborted = !quotaCancelled && liveQf === null && (Boolean(input.signal?.aborted) || /aborted/i.test(msg))
    const outcome: RunOutcome = {
      code: 1, signal: null, timedOut, aborted,
      capped: false, stdout: '', stderrTail: proc.stderr, durationMs: Date.now() - startedAt,
    }
    terminalFailure = classifyFailure({
      cfg, outcome, parser: new StreamJsonParser(),
      sawAuthFailure: liveQf === null && looksLikeAuthFailure(rawErrText),
      consumable: false,
      transportFailure: liveQf === null && isTransportFailure({ rawErrText, authFailureText: '', stderrTail: proc.stderr, stdoutHead: '', runLogText }),
      keyringJitter: false, rawErrText, isRateLimit: liveQf !== null || looksLikeRateLimit(rawErrText), silentTimeout: timedOut && !emittedAny,
    }) ?? { kind: aborted ? 'aborted' : 'error', code: Err.AGY_ERROR, message: msg }
    await settleAcpOutcome({
      deps, input, rec: recorder.rec, account, sid,
      failure: terminalFailure, durationMs: outcome.durationMs, stderr: proc.stderr, rawErrText, runLogText,
      silentTimeout: timedOut && !emittedAny, quotaFailover: liveQf,
      cooledInLiveFamilies: quotaCtrl.cooledFamilies(), outcomeOverride: outcome,
    })
  } finally {
    subTracker?.stop()
    recorder.stop()
    deps.unregisterActiveRun(sessionKey, recorder.rec)
    slot.releaseOnce()
    deps.clearInFlightPrompt(sessionKey, input.prompt)
    recorder.rec.settle(terminalFailure)
    // Tell the background watcher only after cooldowns, rotation, and bindings
    // have landed: a wakeup can re-enter the attempt and must see settled state.
    if (!input.isAux && sessionKey !== '') {
      deps.backgroundObserver?.onAttemptSettled?.({
        sessionKey,
        conversationId: sid,
        ...(recorder.rec.accountHome === undefined ? {} : { accountHome: recorder.rec.accountHome }),
        transport: 'acp',
        recording: recorder.rec,
        failure: terminalFailure,
        superseded: deps.isSuperseded(sessionKey, recorder.rec),
        acpProcess: proc,
        acpSessionId: sid,
      })
    }
  }
}

async function settleEarlyAbort(
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

/**
 * Open or resume an ACP session (Phase 1) and fall back cleanly (`null`, keeping
 * `slot` held) on pre-stream failures. Once the session is ready, stream the
 * prompt in the background (Phase 2) and return the live `RunRecording`.
 */
export async function runAcpAttempt(
  pool: AcpSessionPool,
  deps: AttemptDeps,
  input: AttemptInput,
  slot: AttemptSlot,
): Promise<RunRecording | null> {
  const { cfg, account, sessionKey, workspaceRoot } = input
  if (input.signal?.aborted) {
    return settleEarlyAbort(deps, input, slot, input.binding?.conversationId ?? null, 'request aborted before ACP session opened')
  }

  if (account && account.dir) ensureIsolatedKeychain(account.dir)
  const runLogHome = agyHomeDirFor(account)
  const runLogsBefore: AgyLogSnapshot = snapshotAgyLogs(runLogHome)
  const env = buildAgyEnv({
    ...(account === undefined ? {} : { account }),
    cfg,
    ...(sessionKey === '' ? {} : { sessionId: sessionKey }),
    telemetryFlags: cfg.disableTelemetry,
  })

  let proc: AcpProcess
  let sid: string
  try {
    proc = pool.acquireProcess({
      bin: input.bin,
      cwd: workspaceRoot,
      env,
      ...(account ? { accountId: account.id } : {}),
      mode: input.permissionMode,
      sandbox: input.sandbox ?? cfg.sandbox,
      agent: (input.agent ?? cfg.agent).trim(),
      preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
    })
    const resumeId = input.persistBinding ? input.binding?.conversationId : undefined
    sid = await proc.openSession({
      cwd: workspaceRoot,
      ...(resumeId ? { resumeId } : {}),
      addDirs: input.addDirs,
      model: resolveModelSlug(input.activeModel || cfg.defaultModel),
      ...(input.effort ? { effort: input.effort } : {}),
      mode: input.permissionMode,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (input.signal?.aborted) {
      return settleEarlyAbort(deps, input, slot, input.binding?.conversationId ?? null, msg)
    }
    deps.log?.(`acp pre-stream failure (${msg}) — falling back to CLI -p transport`)
    return null
  }

  if (input.signal?.aborted) {
    proc.cancelSession(sid)
    return settleEarlyAbort(deps, input, slot, sid, 'request aborted after ACP session opened')
  }

  const recorder = createAttemptRecorder(deps, cfg, account, sid, false)
  recorder.streamCid = sid
  recorder.rec.requestAbort = () => proc.cancelSession(sid)
  if (!input.isAux && sessionKey !== '') {
    deps.registerActiveRun(sessionKey, recorder.rec)
  }
  const handoff = slot.armHandoff()
  handoff?.onFirstEvent()

  const initEv = { kind: 'init' as const, conversationId: sid, raw: { transport: 'acp' } }
  recorder.rec.append(initEv)
  input.agyOnEvent?.(initEv)

  void driveAcpPrompt({ deps, input, recorder, slot, proc, sid, runLogHome, runLogsBefore }).catch((e) => {
    recorder.stop()
    deps.unregisterActiveRun(sessionKey, recorder.rec)
    slot.releaseOnce()
    deps.clearInFlightPrompt(sessionKey, input.prompt)
    recorder.rec.settle({ kind: 'error', code: Err.AGY_ERROR, message: String(e) })
  })
  return recorder.rec
}
