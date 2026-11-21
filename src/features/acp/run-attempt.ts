// Execute one AttemptInput over the persistent `agy acp` session pool,
// populating the same RunRecording + finalizeAttempt lifecycle as the CLI path.
//
// Failure evidence is per-turn: the process outlives a single prompt, so its
// stderr ring and its --log-file are sliced from the offsets captured before the
// prompt. Feeding the whole tail into classifyFailure made an old proxy blip
// blame a later healthy turn.
import type { ManagedAccount } from '../../common/pool-types.ts'
import {
  Err,
  isTransportFailure,
  looksLikeAuthFailure,
  looksLikeAuthVerificationJitter,
  looksLikeRateLimit,
} from '../../common/types.ts'
import {
  agyHomeDirFor,
  logSize,
  readAgyRunLogText,
  readLogSlice,
  snapshotAgyLogs,
  type AgyLogSnapshot,
} from '../../host/agy-log.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { RunRecording } from '../../host/recording.ts'
import { resolveModelSlug } from '../../host/models.ts'
import { ensureIsolatedKeychain, type RunOutcome } from '../../host/runner.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import { createAttemptRecorder, type AttemptDeps, type AttemptInput, type AttemptSlot } from '../../provider/attempt.ts'
import { deliverContext } from '../../provider/context-delivery.ts'
import { classifyFailure, type AttemptFailure } from '../../provider/failure.ts'
import { finalizeAttempt } from '../../provider/finalize.ts'
import { buildDigest, wrapLiveRequest } from '../../provider/prompt-text.ts'
import type { AcpProcess } from './client.ts'
import type { AcpSessionPool } from './pool.ts'
import { acpPromptResultToAgyEvent, acpUpdateToAgyEvents, createAcpStreamState } from './protocol.ts'

/**
 * How long we watch a fresh ACP turn for its first event before handing the
 * recording back to the caller. A turn that dies without emitting anything is
 * the signature of a transport that is up but cannot reach Google; waiting for
 * the whole idle budget first would make the CLI fallback feel like a hang.
 */
const FIRST_OUTPUT_GATE_MS = 20_000

interface AcpPromptOutcome {
  failure: AttemptFailure | null
  durationMs: number
  /** This turn's stderr slice only. */
  stderr: string
  rawErrText: string
  runLogText: string
  silentTimeout: boolean
  outcomeOverride?: RunOutcome
  /** Nothing at all was emitted — safe to re-run on the CLI transport. */
  empty: boolean
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')
  return (line ?? text).trim().slice(0, 240)
}

/**
 * agy prints its own infrastructure failures into the message stream and then
 * closes the turn normally, so an unreachable upstream arrives as a perfectly
 * successful end_turn whose only text is this banner. Recognise it as "no model
 * output" instead of showing the user a fake answer.
 */
export function isAgyFailureBanner(text: string): boolean {
  const body = text.trim()
  if (body === '') return false
  if (/failed to construct executor/i.test(body)) return true
  if (/plan model not specified/i.test(body)) return true
  // A short message that is nothing but the warning glyph carries no content.
  return /^[⚠✖]/.test(body) && body.split('\n').filter((l) => l.trim() !== '').length <= 2
}

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
  outcomeOverride?: RunOutcome
}): Promise<void> {
  const { deps, input, rec, account, sid, failure, durationMs, stderr, rawErrText, runLogText, silentTimeout, outcomeOverride } = opts
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
    clearNetworkStreak: (k) => deps.clearNetworkStreak(k),
    dropFailoverBudget: (k) => deps.dropFailoverBudget(k),
    clearRateLimitFailover: (k) => deps.clearRateLimitFailover(k),
    sharesSingleEgress: () => deps.sharesSingleEgress(),
    ...(deps.onRun === undefined ? {} : { onRun: deps.onRun }),
  })
}

/** Drive one prompt and classify what happened. Never settles, never cleans up. */
async function runAcpPrompt(opts: {
  deps: AttemptDeps
  input: AttemptInput
  recorder: ReturnType<typeof createAttemptRecorder>
  proc: AcpProcess
  sid: string
  prompt: string
  runLogHome: string
  runLogsBefore: AgyLogSnapshot
  onFirstOutput?: () => void
}): Promise<AcpPromptOutcome> {
  const { input, recorder, proc, sid, prompt, runLogHome, runLogsBefore, onFirstOutput } = opts
  const { cfg } = input
  const startedAt = Date.now()
  const streamState = createAcpStreamState()
  let emittedAny = false
  // Captured BEFORE the prompt: everything the process wrote earlier belongs to
  // another turn and must not colour this failure.
  const stderrOffset = proc.stderrOffset()
  const logFile = proc.logFilePath
  const logOffset = logSize(logFile)
  const roundStderr = (): string => proc.readStderrSince(stderrOffset)
  const roundLog = (): string => (logFile === null ? '' : readLogSlice(logFile, logOffset))

  try {
    const idleMs = cfg.timeoutMs
    const longToolIdleMs = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes * 60_000 : 0
    const maxTurnMs = cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : 0
    const result = await proc.prompt({
      sessionId: sid,
      text: prompt,
      timeoutMs: idleMs,
      idleTimeoutMs: idleMs,
      longToolIdleMs,
      maxTurnMs,
      ...(input.signal ? { signal: input.signal } : {}),
      onUpdate: (update) => {
        for (const ev of acpUpdateToAgyEvents(sid, update, streamState)) {
          // agy's own failure banner is not "the turn is alive": keeping the
          // first-output gate closed lets a dead upstream finish, be classified
          // and be retried over the CLI instead of streaming a fake answer.
          if (!emittedAny && !isAgyFailureBanner(streamState.accumulatedText)) onFirstOutput?.()
          emittedAny = true
          recorder.rec.append(ev)
          input.agyOnEvent?.(ev)
        }
      },
    })
    const resEv = acpPromptResultToAgyEvent(sid, result, streamState.accumulatedText)
    recorder.rec.append(resEv)
    input.agyOnEvent?.(resEv)
    if (resEv.kind === 'result' && !resEv.ok && resEv.response === '') {
      throw new Error(resEv.error ?? 'ACP prompt returned error without response')
    }
    // An "end_turn" with no event and no text is NOT a successful empty answer:
    // a broken proxy produces exactly that, with the real cause only in the
    // agy log. Look there before believing the stopReason.
    //
    // The same is true when the only "answer" is agy's own failure banner
    // ("⚠ failed to construct executor: ..."): agy reports end_turn with that
    // text when it cannot reach Google, so treating it as a model reply turned a
    // dead proxy into a green turn. Such a turn carries no model output at all.
    const textOnly = streamState.accumulatedText.trim()
    if (!emittedAny || textOnly === '' || isAgyFailureBanner(textOnly)) {
      const errText = roundStderr()
      const logText = roundLog()
      const combined = `${errText} ${logText}`
      const transport = isTransportFailure({
        rawErrText: errText,
        authFailureText: '',
        stderrTail: errText,
        stdoutHead: '',
        runLogText: logText,
      })
      if (transport) throw new Error(`ACP prompt returned an empty turn: ${firstLine(combined) || 'transport failure'}`)
      if (looksLikeAuthFailure(combined)) {
        throw new Error(`ACP prompt returned an empty turn (authentication): ${firstLine(combined)}`)
      }
      throw new Error(`ACP prompt returned an empty turn: ${firstLine(textOnly) || 'agy produced no output for this request'}`)
    }
    return {
      failure: null,
      durationMs: Date.now() - startedAt,
      stderr: roundStderr(),
      rawErrText: '',
      runLogText: '',
      silentTimeout: false,
      empty: false,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const errText = roundStderr()
    const logText = roundLog()
    const rawErrText = `${msg} ${errText}`.trim()
    const timedOut = /timed out/i.test(msg)
    const aborted = Boolean(input.signal?.aborted) || /aborted/i.test(msg)
    const outcome: RunOutcome = {
      code: 1,
      signal: null,
      timedOut,
      aborted,
      capped: false,
      stdout: '',
      stderrTail: errText,
      durationMs: Date.now() - startedAt,
    }
    const failure =
      classifyFailure({
        cfg,
        outcome,
        parser: new StreamJsonParser(),
        sawAuthFailure: looksLikeAuthFailure(rawErrText),
        consumable: false,
        transportFailure: isTransportFailure({
          rawErrText,
          authFailureText: '',
          stderrTail: errText,
          stdoutHead: '',
          runLogText: logText,
        }),
        // keyringJitter used to be hard-coded false here, which silently turned
        // every "the keyring helper timed out" blip into a real auth failure and
        // rotated the account away.
        keyringJitter: looksLikeAuthVerificationJitter(`${errText} ${logText}`),
        rawErrText,
        isRateLimit: looksLikeRateLimit(rawErrText),
        silentTimeout: timedOut && !emittedAny,
      }) ?? { kind: aborted ? 'aborted' : 'error', code: Err.AGY_ERROR, message: msg }
    return {
      failure,
      durationMs: outcome.durationMs,
      stderr: errText,
      rawErrText,
      runLogText: logText,
      silentTimeout: timedOut && !emittedAny,
      outcomeOverride: outcome,
      empty: !emittedAny || isAgyFailureBanner(streamState.accumulatedText),
    }
  }
}

/** Settle the attempt and release everything the ACP path borrowed. */
async function finishAcpAttempt(opts: {
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
 * A session id that no longer exists must never be silently replaced by an
 * empty one: rebuild it with the same ADR-7 history digest the first-turn path
 * uses, and say so in the conversation so the user knows why the context looks
 * new.
 */
async function rebuildAcpSession(opts: {
  deps: AttemptDeps
  input: AttemptInput
  proc: AcpProcess
  previousSid: string
  workspaceRoot: string
}): Promise<{ sid: string; prompt: string }> {
  const { deps, input, proc, previousSid, workspaceRoot } = opts
  const { cfg } = input
  deps.log?.(`acp session ${previousSid} could not be restored — rebuilding with a full history digest`)
  deps.appendAcpNotice?.(input.sessionKey, {
    kind: 'acp-reset',
    text:
      '原常驻会话已重置（agy 侧已找不到该会话），已自动携历史上下文重建新会话。' +
      '\nThe persistent ACP session was reset; a new one was created with the conversation history carried over.',
  })
  const digest = buildDigest(input.messages, 0, cfg.contextTransferMaxChars, {
    maxBytes: cfg.contextTransferFileMaxBytes,
    maxLineBytes: 40_000,
    includeTaskLine: false,
  })
  const extraDirs: string[] = []
  const delivered = digest === '' ? '' : await deliverContext(digest, input.sessionKey, extraDirs, cfg)
  const prompt = delivered === '' ? input.prompt : wrapLiveRequest(input.prompt) + delivered
  let sid = previousSid
  if (extraDirs.length > 0) {
    // The digest was spilled to a file; agy needs that directory in scope.
    const reopened = await proc.openSession({
      cwd: workspaceRoot,
      addDirs: [...input.addDirs, ...extraDirs],
      model: resolveModelSlug(input.activeModel || cfg.defaultModel),
      ...(input.effort ? { effort: input.effort } : {}),
      mode: input.permissionMode,
    })
    sid = reopened.sessionId
  }
  return { sid, prompt }
}

/**
 * Open or resume an ACP session and fall back cleanly (`null`, keeping `slot`
 * held) on pre-stream failures. Once the session is ready, stream the prompt in
 * the background and return the live `RunRecording`.
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

  let proc!: AcpProcess
  let sid = ''
  let prompt = input.prompt
  // Gate 2 allows exactly ONE self-heal: a second mismatch means the slot keeps
  // being stolen (another agy refreshing it hourly), and retrying forever would
  // just burn the wrong account's quota.
  let identityRetried = false
  for (;;) {
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
        ...(account?.email ? { expectedEmail: account.email } : {}),
      })
      const resumeId = input.persistBinding ? input.binding?.conversationId : undefined
      const opened = await proc.openSession({
        cwd: workspaceRoot,
        ...(resumeId ? { resumeId } : {}),
        addDirs: input.addDirs,
        model: resolveModelSlug(input.activeModel || cfg.defaultModel),
        ...(input.effort ? { effort: input.effort } : {}),
        mode: input.permissionMode,
      })
      sid = opened.sessionId
      if (opened.resumeFailed) {
        const rebuilt = await rebuildAcpSession({ deps, input, proc, previousSid: sid, workspaceRoot })
        sid = rebuilt.sid
        prompt = rebuilt.prompt
      }
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (input.signal?.aborted) {
        return settleEarlyAbort(deps, input, slot, input.binding?.conversationId ?? null, msg)
      }
      const mismatch = /^ACP identity mismatch/i.test(msg)
      if (mismatch && !identityRetried && account && deps.reinstallCredentialSlot) {
        identityRetried = true
        deps.log?.(`${msg} — reinstalling the credential slot and retrying the ACP process once`)
        // The process that loaded the wrong identity must die: its in-run token
        // refreshes would keep writing the other account back into the slot.
        pool.discardProcess(proc)
        if (deps.reinstallCredentialSlot(account)) continue
        deps.log?.('credential slot could not be reinstalled — failing the turn instead of spending the wrong account')
        return null
      }
      if (mismatch) {
        deps.log?.(`${msg} — refusing to run on the wrong account`)
        pool.discardProcess(proc)
        return null
      }
      deps.log?.(`acp pre-stream failure (${msg}) — falling back to CLI -p transport`)
      return null
    }
  }

  if (input.signal?.aborted) {
    proc.cancelSession(sid)
    return settleEarlyAbort(deps, input, slot, sid, 'request aborted after ACP session opened')
  }

  const recorder = createAttemptRecorder(deps, cfg, account, sid, !input.isAux)
  recorder.streamCid = sid
  recorder.startTracker?.()
  recorder.rec.requestAbort = () => proc.cancelSession(sid)
  if (!input.isAux && sessionKey !== '') {
    deps.registerActiveRun(sessionKey, recorder.rec)
  }
  const handoff = slot.armHandoff()
  handoff?.onFirstEvent()

  const initEv = { kind: 'init' as const, conversationId: sid, raw: { transport: 'acp' } }
  recorder.rec.append(initEv)
  input.agyOnEvent?.(initEv)

  // Watch only until the first sign of life: after that the turn is genuinely
  // streaming and must be handed back immediately.
  let gateSettled = false
  let releaseGate: (value: 'stream' | 'done' | 'timeout') => void = () => {}
  const gate = new Promise<'stream' | 'done' | 'timeout'>((resolve) => {
    releaseGate = resolve
  })
  const settleGate = (value: 'stream' | 'done' | 'timeout'): void => {
    if (gateSettled) return
    gateSettled = true
    releaseGate(value)
  }
  const gateTimer = setTimeout(() => settleGate('timeout'), FIRST_OUTPUT_GATE_MS)
  gateTimer.unref?.()

  const promptPromise = runAcpPrompt({
    deps,
    input,
    recorder,
    proc,
    sid,
    prompt,
    runLogHome,
    runLogsBefore,
    onFirstOutput: () => settleGate('stream'),
  })
  promptPromise.then(
    () => {
      clearTimeout(gateTimer)
      settleGate('done')
    },
    () => {
      clearTimeout(gateTimer)
      settleGate('done')
    },
  )

  const started = await gate
  if (started === 'done') {
    const result = await promptPromise
    // A turn that never emitted anything and then failed is a dead transport,
    // not a model answer. Drop the bad process and let the caller re-run the
    // same prompt over the CLI instead of surfacing a fake empty reply.
    const failure = result.failure
    const retryOnCli =
      failure !== null &&
      result.empty &&
      failure.kind !== 'aborted' &&
      failure.code !== Err.TIMEOUT &&
      !input.signal?.aborted
    if (failure !== null && retryOnCli) {
      deps.log?.(`acp turn produced no output (${failure.code}) — discarding the process and retrying over CLI -p`)
      recorder.stop()
      deps.unregisterActiveRun(sessionKey, recorder.rec)
      recorder.rec.settle(failure)
      pool.discardProcess(proc)
      return null
    }
    await finishAcpAttempt({ deps, input, recorder, slot, proc, sid, result })
    return recorder.rec
  }

  void promptPromise
    .then((result) => finishAcpAttempt({ deps, input, recorder, slot, proc, sid, result }))
    .catch((e: unknown) => {
      recorder.stop()
      deps.unregisterActiveRun(sessionKey, recorder.rec)
      slot.releaseOnce()
      deps.clearInFlightPrompt(sessionKey, input.prompt)
      recorder.rec.settle({ kind: 'error', code: Err.AGY_ERROR, message: String(e) })
    })
  return recorder.rec
}
