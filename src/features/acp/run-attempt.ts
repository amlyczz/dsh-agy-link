// Execute one AttemptInput over the persistent `agy acp` session pool,
// populating the same RunRecording + finalizeAttempt lifecycle as the CLI path.
// Failure evidence is per-turn: the process outlives a single prompt, so its
// stderr ring and its --log-file are sliced from the offsets captured before the
// prompt. Feeding the whole tail into classifyFailure made an old proxy blip
// blame a later healthy turn.
import { readFile } from 'node:fs/promises'
import type { ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import {
  Err,
  extractAgyQuotaBanner,
  isNonConsumableResultError,
  isTransportFailure,
  looksLikeAuthFailure,
} from '../../common/types.ts'
import { logSize, readLogSlice } from '../../host/agy-log.ts'
import type { RunRecording } from '../../host/recording.ts'
import { ensureIsolatedKeychain } from '../../host/runner.ts'
import { resolveModelSlug } from '../../host/models.ts'
import { readAccountCredential } from '../../domain/credentials/backup.ts'
import { accountTokenFilePath } from '../../domain/credentials/docs.ts'

import { supportsSshIsolation } from '../../runtime/agy/env.ts'
import { accountHome, buildAgyEnv } from '../../runtime/net/account-env.ts'
import { prepareOrchestratorSettingsForAcp } from './orchestrator-prep.ts'
import { createAttemptRecorder, type AttemptDeps, type AttemptInput, type AttemptSlot } from '../../provider/attempt.ts'
import { deliverContext } from '../../provider/context-delivery.ts'
import { finalizeAttempt } from '../../provider/finalize.ts'
import { buildDigest, wrapLiveRequest } from '../../provider/prompt-text.ts'
import {
  createLiveQuotaController,
  reportDirectToolQuota,
  type LiveQuotaFailoverState,
} from '../../provider/quota-failover.ts'
import { SubagentTracker } from '../subagent/tracker.ts'
import { beginOrchestrationTurn, instrumentTurn } from '../orchestration/instrument.ts'

import { noteContextWindow } from './context-window.ts'
import type { AcpProcess } from './client.ts'
import type { AcpSessionPool } from './pool.ts'
import { buildPromptFailure } from './prompt-failure.ts'
import { acpPromptResultToAgyEvent, acpUpdateToAgyEvents, createAcpStreamState } from './protocol.ts'
import { rebuildAcpSession } from './rebuild.ts'
import {
  finishAcpAttempt,
  identityFailureKind,
  isAgyFailureBanner,
  buildAcpPromptOutcome,
  settleEarlyAbort,
  settleIdentityFailure,
  shouldSelfHealAcpResult,
  type AcpPromptOutcome,
} from './settle.ts'
export { isAgyFailureBanner, shouldSelfHealAcpResult } from './settle.ts'
import { AcpTranscriptUsageTailer } from './transcript-usage.ts'
import { reportAcpCacheTurn } from './cache-turn.ts'
import { FIRST_OUTPUT_GATE_MS, firstLine } from './turn-format.ts'
import { createBackgroundWaitMonitor, persistInterimAcpBinding } from './bg-wait-notice.ts'
import { healAcpAuthOnce, isAcpPreStreamAuthError } from './auth-heal.ts'

/** Drive one prompt and classify what happened. Never settles, never cleans up. */
async function runAcpPrompt(opts: {
  deps: AttemptDeps
  input: AttemptInput
  recorder: ReturnType<typeof createAttemptRecorder>
  proc: AcpProcess
  sid: string
  prompt: string
  onFirstOutput?: () => void
  sessionStatus: 'created' | 'resumed' | 'loaded' | 'cached' | 'rebuilt'
}): Promise<AcpPromptOutcome> {
  const { deps, input, recorder, proc, sid, prompt, onFirstOutput, sessionStatus } = opts
  const { cfg, account } = input
  const startedAt = Date.now()
  const streamState = createAcpStreamState()
  /** Anything at all arrived for this turn (including agy's own banners). */
  let emittedAny = false
  /** Real model output arrived (text that is not an infrastructure banner, or a tool call). */
  let sawRealOutput = false
  let sawText = false
  let sawThinking = false
  let sawTools = false
  const stderrOffset = proc.stderrOffset()
  const logFile = proc.logFilePath
  const logOffset = logSize(logFile)
  const roundStderr = (): string => proc.readStderrSince(stderrOffset)
  const roundLog = (): string => (logFile === null ? '' : readLogSlice(logFile, logOffset))
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
        sessionKey: input.sessionKey,
        resumed: Boolean(input.binding?.conversationId),
        accountHome: recorder.rec.accountHome,
        log: deps.log,
        onEvent: (ev) => wiring.onEvent(ev),
        onQuotaExhausted: (info) => quotaCtrl.handleQuotaExhausted(info),
      })
    : null

  const usageTailer = !input.isAux && sid !== ''
    ? new AcpTranscriptUsageTailer(sid, recorder.rec.accountHome)
    : null
  const bgWait = createBackgroundWaitMonitor(subTracker, recorder)
  // Orchestration ledger: the only place that knows which seat is speaking, what
  // the agent's plan/checklist is, and the real context window. ACP sends the
  // seat attribution only inside transcript.jsonl, which the tailer above reads,
  // so every transport event goes through the instrumentation as well.
  const wiring = instrumentTurn({
    isAux: input.isAux,
    sessionKey: input.sessionKey,
    conversationId: sid,
    activeModel: input.activeModel,
    append: (ev) => recorder.rec.append(ev),
    learnWindow: (model, size) => noteContextWindow(model, size),
  })
  wiring.resume()
  const flushTranscriptUsage = (): number => {
    if (!usageTailer) return 0
    const samples = usageTailer.poll()
    for (const s of samples) {
      recorder.rec.append({
        kind: 'step',
        stepKey: s.stepKey,
        stepKind: 'text',
        text: '',
        state: 'DONE',
        usage: s.usage,
        raw: { source: 'acp-transcript' },
      })
      wiring.noteTranscriptSample(s)
    }
    return samples.length
  }

  try {
    subTracker?.start()
    bgWait?.start()
    // Align ACP's generation idle floor with the CLI watchdog (15m minimum when
    // configured timeout >= 60s) so large tool-argument generation never trips a
    // premature 600s idle timeout (#183).
    const idleMs = !input.isAux && cfg.timeoutMs >= 60_000 ? Math.max(cfg.timeoutMs, 15 * 60_000) : cfg.timeoutMs
    const longToolIdleMs = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes * 60_000 : 0
    const maxTurnMs = cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : 0
    // Issue #225: a turn that only waits on a one-shot agy `schedule` timer is
    // released after `scheduleReleaseSeconds` of quiet, and the host re-arms
    // the timer and wakes the session itself. Only with backgroundWakeup: with
    // it off there is no DSH-side wake-up, so the turn must stay open for agy's.
    const scheduleReleaseMs = !input.isAux && cfg.backgroundWakeup && cfg.scheduleReleaseSeconds > 0
      ? cfg.scheduleReleaseSeconds * 1000
      : 0
    const inlineImages: Array<{ data: string; mimeType: string }> = []
    if (proc.supportsImageBlocks && input.stagedImages && input.stagedImages.length > 0) {
      for (const img of input.stagedImages) {
        try {
          const buf = await readFile(img.path)
          if (buf.length > 0 && buf.length <= cfg.mediaMaxBytes) {
            inlineImages.push({ data: buf.toString('base64'), mimeType: img.mediaType })
          }
        } catch {
          // keep path-based fallback already in prompt
        }
      }
    }
    const runOnePrompt = (promptText: string, includeImages: boolean) =>
      proc.prompt({
        sessionId: sid,
        text: promptText,
        ...(includeImages && inlineImages.length > 0 ? { images: inlineImages } : {}),
        timeoutMs: idleMs,
        idleTimeoutMs: idleMs,
        longToolIdleMs,
        maxTurnMs,
        ...(scheduleReleaseMs > 0 ? { scheduleReleaseMs } : {}),
        onScheduleRelease: ({ delayMs }) => {
          const secs = Math.round(delayMs / 1000)
          const text =
            `[定时巡检] 已设置 ${secs}s 后的一次性定时器，本轮提前结束以释放会话（用户消息可立即发送）；到点由后台唤醒自动开启新回合汇报。\n` +
            `[Schedule release] A one-shot timer (${secs}s) is armed and this turn is released so the session is free; the background wakeup opens a new turn when it fires.\n`
          recorder.rec.append({ kind: 'step', stepKey: `acp-schedule-release-${secs}s`, stepKind: 'subagent', text, state: 'DONE', raw: { kind: 'schedule-release', delayMs } })
          deps.log?.(`acp: released the turn for a pending one-shot schedule (${secs}s); background wakeup will re-open it`)
        },
        ...(input.signal ? { signal: input.signal } : {}),
        onUpdate: (update) => {
          const updateKind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
          if (updateKind === 'tool_call' || updateKind === 'tool_call_update' || updateKind === 'usage_update') {
            flushTranscriptUsage()
          }
          // Session updates the event mapper drops because they carry no
          // assistant text — and they are exactly the orchestration signal:
          // the agent's plan, its live mode, the session title, and the real
          // context window of THIS model (learned on every turn, see
          // instrument.ts).
          wiring.noteUpdate(update)
          for (const ev of acpUpdateToAgyEvents(sid, update, streamState)) {
            if (
              !sawRealOutput &&
              ev.kind !== 'init' &&
              !isAgyFailureBanner(streamState.accumulatedText) &&
              extractAgyQuotaBanner(streamState.accumulatedText) === undefined
            ) {
              sawRealOutput = true
              onFirstOutput?.()
            }
            emittedAny = true
            if (ev.kind === 'step') {
              if (ev.stepKind === 'text' && ev.text.trim() !== '') sawText = true
              else if (ev.stepKind === 'thinking' && ev.text.trim() !== '') sawThinking = true
              else if (ev.stepKind === 'tool') sawTools = true
            }
            recorder.rec.append(ev)
            bgWait?.noteEvent(ev)
            wiring.noteStep(ev, update)
            input.agyOnEvent?.(ev)
            reportDirectToolQuota(quotaCtrl, ev)
          }
        },
      })
    let result = await runOnePrompt(prompt, true)
    subTracker?.flush()
    // Flush async transcript.jsonl usage entries before falling back to envelope usage.
    if (usageTailer) {
      for (let attempt = 0; attempt < 4 && flushTranscriptUsage() === 0; attempt++) {
        await new Promise((r) => setTimeout(r, 40))
      }
    }
    let liveQf = quotaCtrl.failoverState()
    if (liveQf !== null) {
      throw new Error(liveQf.rawErrorText)
    }
    const isCancelled = () => recorder.rec.isAbortRequested || result.stopReason === 'cancelled' || result.stopReason === 'canceled'
    let selfHealed = false
    let resEv = acpPromptResultToAgyEvent(sid, result, streamState.accumulatedText, streamState.lastContextUsed)
    if (
      !input.isAux &&
      !input.signal?.aborted &&
      !quotaCancelled &&
      !isCancelled() &&
      shouldSelfHealAcpResult(resEv, { sawText, sawThinking, sawTools })
    ) {
      selfHealed = true
      deps.log?.(`acp self-heal: retrying empty/invalid model output on same session ${sid}`)
      streamState.accumulatedText = ''
      result = await runOnePrompt('Continue and provide your response.', false)
      subTracker?.flush()
      flushTranscriptUsage()
      liveQf = quotaCtrl.failoverState()
      if (liveQf !== null) {
        throw new Error(liveQf.rawErrorText)
      }
      resEv = acpPromptResultToAgyEvent(sid, result, streamState.accumulatedText, streamState.lastContextUsed)
    }
    if (!input.isAux) {
      reportAcpCacheTurn({
        deps,
        input,
        sessionStatus,
        lastUsage: recorder.rec.lastUsage,
        envelopeUsage: resEv.kind === 'result' ? resEv.usage : undefined,
        selfHealed,
      })
    }
    const quotaBanner = resEv.kind === 'result'
      ? (extractAgyQuotaBanner(resEv.response) ?? extractAgyQuotaBanner(resEv.error))
      : undefined
    if (quotaBanner !== undefined) {
      throw new Error(quotaBanner)
    }
    if (!quotaCancelled && isCancelled()) {
      return buildAcpPromptOutcome({ kind: 'aborted', code: Err.AGY_ERROR, message: 'ACP prompt cancelled' }, startedAt, roundStderr(), quotaCtrl.cooledFamilies())
    }
    if (resEv.kind === 'result' && !resEv.ok && (resEv.response === '' || isNonConsumableResultError(resEv.ok, resEv.error, resEv.response))) {
      throw new Error(resEv.error ?? 'ACP prompt returned error without response')
    }
    recorder.rec.append(resEv)
    input.agyOnEvent?.(resEv)
    // An "end_turn" with no event and no text is NOT a successful empty answer:
    // a broken proxy produces exactly that, with the real cause only in the
    // agy log. Look there before believing the stopReason.
    //
    // The same is true when the only "answer" is agy's own failure banner
    // ("⚠ failed to construct executor: ..."): agy reports end_turn with that
    // text when it cannot reach Google, so treating it as a model reply turned a
    // dead proxy into a green turn. Such a turn carries no model output at all.
    // A turn that only ran tools is a SUCCESS: the model answered by acting, and
    // demanding prose from it turned every such turn into a failed attempt (the
    // old condition used ||, so an empty text half alone was enough to fail).
    const textOnly = streamState.accumulatedText.trim()
    if (!sawRealOutput) {
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
    return buildAcpPromptOutcome(null, startedAt, roundStderr(), quotaCtrl.cooledFamilies())
  } catch (err) {
    subTracker?.flush()
    // Classification lives in ./prompt-failure.ts: it only reads evidence.
    return buildPromptFailure({
      cfg,
      deps,
      input,
      rec: recorder.rec,
      err,
      stderrText: roundStderr(),
      logText: roundLog(),
      quotaFailover: quotaCtrl.failoverState(),
      quotaCancelled,
      emittedAny,
      sawRealOutput,
      cooledInLiveFamilies: quotaCtrl.cooledFamilies(),
      startedAt,
    })
  } finally {
    bgWait?.stop()
    // Subagents belong to this round: stopping detaches the tracker from the
    // live registry so the header stops reporting them the moment the turn ends.
    subTracker?.stop()
    // Freeze the orchestration snapshot for the round; the sidebar keeps showing
    // the last turn, it just stops claiming to be live.
    wiring.settle()
    // The streak is counted where the failure is classified (above), so this
    // only has to clear it on a turn that actually produced model output.
    if (sawRealOutput) deps.clearNetworkStreak(input.sessionKey)
  }
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

  if (account && account.dir) {
    ensureIsolatedKeychain(account.dir)
    if (!account.systemHome) readAccountCredential(accountTokenFilePath(account, account.dir), deps.log)
  }
  const env = buildAgyEnv({
    ...(account === undefined ? {} : { account }),
    cfg,
    ...(sessionKey === '' ? {} : { sessionId: sessionKey }),
    telemetryFlags: cfg.disableTelemetry,
  })
  if (input.bridgeRoute) env.DSH_MCP_ROUTE = input.bridgeRoute
  else delete env.DSH_MCP_ROUTE

  // Persist orchestrator seats into `<home>/.gemini/antigravity-cli/settings.json` (#204).
  let settingsTag: string | undefined
  if (!input.isAux) {
    const prep = prepareOrchestratorSettingsForAcp({
      cfg,
      activeModel: input.activeModel,
      account,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    })
    if (!prep.ok) return null
    settingsTag = prep.settingsTag
  }

  // Refresh/sync credentials for both primary (WSL disk token) and isolated accounts before spawn.
  if (account && deps.ensureFreshToken) {
    const fresh = await deps.ensureFreshToken(account).catch(() => false)
    if (!fresh) deps.log?.('acp: token pre-flight for ' + account.id + ' could not be refreshed')
  }
  let proc!: AcpProcess
  let sid = ''
  let prompt = input.prompt
  let openedStatus: 'created' | 'resumed' | 'loaded' | 'cached' | 'rebuilt' = 'created'
  const usesSharedSlot =
    process.platform === 'win32'
    && !(account?.dir && !account.systemHome && supportsSshIsolation(deps.agyVersion?.() ?? null))
  // Gate 2 allows one self-heal on wrong-account mismatch, plus one retry after pre-stream auth refresh.
  let identityRetried = false
  let authRetried = false
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
        ...(cfg.mediaDir !== '' ? { addDirs: [cfg.mediaDir] } : {}),
        preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
        ...(account?.email ? { expectedEmail: account.email } : {}),
        ...(account?.dir && !account.systemHome ? { expectedIsolated: true } : {}),
        ...(settingsTag === undefined ? {} : { settingsTag }),
        usesSharedSlot,
      })
      const resumeId = input.persistBinding ? input.binding?.conversationId : undefined
      // Returning to the original cwd preserves agy's system-prompt prefix and
      // keeps Google prompt cache hit rate high across turns.
      const sessionCwd = resumeId && input.binding?.cwd ? input.binding.cwd : workspaceRoot
      const opened = await proc.openSession({
        cwd: sessionCwd,
        ...(resumeId ? { resumeId } : {}),
        addDirs: input.addDirs,
        model: resolveModelSlug(input.activeModel || cfg.defaultModel),
        ...(input.effort ? { effort: input.effort } : {}),
        mode: input.permissionMode,
      })
      sid = opened.sessionId
      openedStatus = opened.resumeFailed ? 'rebuilt' : opened.status
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
      const identityFailure = identityFailureKind(msg)
      // mismatch = another account in the log (AUTH); unproven = userinfo died on the network (NETWORK).
      if (identityFailure !== null && !identityRetried && account && deps.reinstallCredentialSlot) {
        identityRetried = true
        deps.log?.(`${msg} — reinstalling the credential slot and retrying the ACP process once`)
        pool.discardProcess(proc)
        if (deps.reinstallCredentialSlot(account)) continue
        return await settleIdentityFailure(deps, input, slot, sid || null, msg, identityFailure)
      }
      if (identityFailure !== null) {
        deps.log?.(`${msg} — ${identityFailure === 'mismatch' ? 'refusing to run on the wrong account' : 'retrying without quarantining the account'}`)
        pool.discardProcess(proc)
        return await settleIdentityFailure(deps, input, slot, sid || null, msg, identityFailure)
      }
      if (isAcpPreStreamAuthError(msg)) {
        pool.discardProcess(proc)
        if (!authRetried && account) {
          authRetried = true
          deps.log?.(`acp pre-stream auth failure (${msg}) — discarding process, refreshing credentials for ${account.alias || account.id}, and retrying once`)
          if (await healAcpAuthOnce({ deps, account, usesSharedSlot })) continue
        }
        deps.log?.(`acp pre-stream auth failure (${msg}) — discarded unauthenticated process, falling back to CLI -p`)
        return null
      }
      if (!proc.isAlive() || proc.sessionCount === 0) pool.discardProcess(proc)
      deps.log?.(`acp pre-stream failure (${msg}) — falling back to CLI -p transport`)
      return null
    }
  }

  if (input.signal?.aborted) {
    proc.cancelSession(sid)
    return settleEarlyAbort(deps, input, slot, sid, 'request aborted after ACP session opened')
  }

  const recorder = createAttemptRecorder(deps, cfg, account, sid, !input.isAux)
  // One DSH turn = one orchestration turn: the panel starts from a clean slate
  // (seats, steps, plan, checklist) and keeps the last one readable afterwards.
  beginOrchestrationTurn(input.isAux, sessionKey, sid)
  recorder.rec.family = input.family
  recorder.setTrackerSession?.(input.sessionKey)
  recorder.streamCid = sid
  recorder.startTracker?.()
  recorder.rec.requestAbort = () => {
    recorder.rec.markAbortRequested()
    proc.cancelSession(sid)
  }
  if (!input.isAux && sessionKey !== '') {
    deps.registerActiveRun(sessionKey, recorder.rec)
  }
  // Fallback path returns `null` keeping the slot held so CLI -p re-runs on the same account.
  const handoff = slot.armHandoff()

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
    sessionStatus: openedStatus,
    onFirstOutput: () => {
      persistInterimAcpBinding({ deps, input, recorder, sid })
      settleGate('stream')
    },
  })
  const finishGate = (): void => {
    clearTimeout(gateTimer)
    settleGate('done')
  }
  promptPromise.then(finishGate, finishGate)

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
      // AUTH / RATE_LIMIT / ELIGIBILITY are account-scoped: CLI fallback runs the
      // same account without settling cooldown/rotation, so let finishAcpAttempt handle it.
      failure.code !== Err.AUTH &&
      failure.code !== Err.RATE_LIMIT &&
      failure.code !== Err.ELIGIBILITY &&
      // A keyring blip would simply repeat on the other transport, and the retry
      // would pay a second credential hand-off for nothing.
      result.keyringJitter !== true &&
      !input.signal?.aborted
    if (failure !== null && retryOnCli) {
      deps.log?.(`acp turn produced no output (${failure.code}) — discarding the process and retrying over CLI -p`)
      recorder.stop()
      deps.unregisterActiveRun(sessionKey, recorder.rec)
      recorder.rec.settle(failure)
      pool.discardProcess(proc)
      // Keep the slot held: the CLI re-run is the same turn and must read the
      // same account. releaseOnce() below is the single release point.
      return null
    }
    handoff?.onFirstEvent()
    await finishAcpAttempt({ deps, input, recorder, slot, proc, sid, result })
    return recorder.rec
  }

  handoff?.onFirstEvent()
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
