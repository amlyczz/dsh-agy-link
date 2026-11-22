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
  isNonConsumableResultError,
  isTransportFailure,
  looksLikeAuthFailure,
  looksLikeAuthVerificationJitter,
  looksLikeRateLimit,
  networkRetryDelayMs,
} from '../../common/types.ts'
import { logSize, readLogSlice } from '../../host/agy-log.ts'
import { StreamJsonParser } from '../../host/parser.ts'
import type { RunRecording } from '../../host/recording.ts'
import { resolveModelSlug } from '../../host/models.ts'
import { ensureIsolatedKeychain, type RunOutcome } from '../../host/runner.ts'
import { supportsSshIsolation } from '../../runtime/agy/env.ts'
import { buildAgyEnv } from '../../runtime/net/account-env.ts'
import { createAttemptRecorder, type AttemptDeps, type AttemptInput, type AttemptSlot } from '../../provider/attempt.ts'
import { deliverContext } from '../../provider/context-delivery.ts'
import { classifyFailure, type AttemptFailure } from '../../provider/failure.ts'
import { finalizeAttempt } from '../../provider/finalize.ts'
import { buildDigest, wrapLiveRequest } from '../../provider/prompt-text.ts'
import {
  createLiveQuotaController,
  reportDirectToolQuota,
  type LiveQuotaFailoverState,
} from '../../provider/quota-failover.ts'
import { SubagentTracker } from '../subagent/tracker.ts'
import type { AcpProcess } from './client.ts'
import type { AcpSessionPool } from './pool.ts'
import { acpPromptResultToAgyEvent, acpUpdateToAgyEvents, createAcpStreamState } from './protocol.ts'
import { rebuildAcpSession } from './rebuild.ts'
import {
  finishAcpAttempt,
  settleEarlyAbort,
  type AcpPromptOutcome,
} from './settle.ts'
import { AcpTranscriptUsageTailer } from './transcript-usage.ts'

/**
 * How long we watch a fresh ACP turn for its first event before handing the
 * recording back to the caller. A turn that dies without emitting anything is
 * the signature of a transport that is up but cannot reach Google; waiting for
 * the whole idle budget first would make the CLI fallback feel like a hang.
 */
const FIRST_OUTPUT_GATE_MS = 20_000

const INVALID_OUTPUT_RE = /model produced invalid output/i

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')
  return (line ?? text).trim().slice(0, 240)
}

/**
 * True when an ACP prompt ended with either an empty thinking-only turn (no
 * visible text and no tool calls) or agy's transient `⚠ Model produced invalid
 * output.` error, making a single same-session warm nudge worthwhile while
 * preserving Google's prompt cache.
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

/**
 * agy prints its own infrastructure failures into the message stream and then
 * closes the turn normally, so an unreachable upstream arrives as a perfectly
 * successful end_turn whose only text is this banner. Recognise it as "no model
 * output" instead of showing the user a fake answer.
 */
const AGY_INFRA_BANNER =
  /(failed to construct executor|plan model not specified|failed to fetch user info|proxyconnect|failed to construct (?:the )?executor)/i

export function isAgyFailureBanner(text: string): boolean {
  const body = text.trim()
  if (body === '') return false
  // Only agy's OWN infrastructure lines, and only when they are the whole
  // message. The old rule ("starts with ⚠ and is at most two lines") also ate
  // legitimate one-line answers such as "⚠ 端口 8080 已被占用，请先停掉旧服务。"
  // and turned a good reply into a discarded process plus a CLI re-run.
  const lines = body.split('\n').filter((l) => l.trim() !== '')
  return lines.length <= 2 && AGY_INFRA_BANNER.test(body)
}

/** Drive one prompt and classify what happened. Never settles, never cleans up. */
async function runAcpPrompt(opts: {
  deps: AttemptDeps
  input: AttemptInput
  recorder: ReturnType<typeof createAttemptRecorder>
  proc: AcpProcess
  sid: string
  prompt: string
  onFirstOutput?: () => void
}): Promise<AcpPromptOutcome> {
  const { deps, input, recorder, proc, sid, prompt, onFirstOutput } = opts
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
        resumed: Boolean(input.binding?.conversationId),
        accountHome: recorder.rec.accountHome,
        log: deps.log,
        onEvent: (ev) => recorder.rec.append(ev),
        onQuotaExhausted: (info) => quotaCtrl.handleQuotaExhausted(info),
      })
    : null

  const usageTailer = !input.isAux && sid !== ''
    ? new AcpTranscriptUsageTailer(sid, recorder.rec.accountHome)
    : null
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
    }
    return samples.length
  }

  try {
    subTracker?.start()
    const idleMs = cfg.timeoutMs
    const longToolIdleMs = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes * 60_000 : 0
    const maxTurnMs = cfg.maxTurnMinutes > 0 ? cfg.maxTurnMinutes * 60_000 : 0
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
        ...(input.signal ? { signal: input.signal } : {}),
        onUpdate: (update) => {
          const updateKind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
          if (updateKind === 'tool_call' || updateKind === 'tool_call_update' || updateKind === 'usage_update') {
            flushTranscriptUsage()
          }
          for (const ev of acpUpdateToAgyEvents(sid, update, streamState)) {
            if (!sawRealOutput && ev.kind !== 'init' && !isAgyFailureBanner(streamState.accumulatedText)) {
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
            input.agyOnEvent?.(ev)
            reportDirectToolQuota(quotaCtrl, ev)
          }
        },
      })
    let result = await runOnePrompt(prompt, true)
    subTracker?.flush()
    if (usageTailer && flushTranscriptUsage() === 0 && recorder.rec.lastUsage !== null) {
      await new Promise((r) => setTimeout(r, 60))
      flushTranscriptUsage()
    }
    let liveQf = quotaCtrl.failoverState()
    if (liveQf !== null) {
      throw new Error(liveQf.rawErrorText)
    }
    let resEv = acpPromptResultToAgyEvent(sid, result, streamState.accumulatedText, streamState.lastContextUsed)
    if (
      !input.isAux &&
      !input.signal?.aborted &&
      !quotaCancelled &&
      shouldSelfHealAcpResult(resEv, { sawText, sawThinking, sawTools })
    ) {
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
    recorder.rec.append(resEv)
    input.agyOnEvent?.(resEv)
    if (resEv.kind === 'result' && !resEv.ok && (resEv.response === '' || isNonConsumableResultError(resEv.ok, resEv.error, resEv.response))) {
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
    return {
      failure: null,
      durationMs: Date.now() - startedAt,
      stderr: roundStderr(),
      rawErrText: '',
      runLogText: '',
      silentTimeout: false,
      empty: false,
      cooledInLiveFamilies: quotaCtrl.cooledFamilies(),
    }
  } catch (err) {
    subTracker?.flush()
    const liveQf = quotaCtrl.failoverState()
    const msg = err instanceof Error ? err.message : String(err)
    const errText = roundStderr()
    const logText = roundLog()
    const rawErrText = [msg, errText, liveQf?.rawErrorText].filter(Boolean).join(' ').trim()
    // A quota-triggered kill is not a timeout and not the user aborting: its
    // classification comes from the quota evidence, not from the error text.
    const timedOut = liveQf === null && /timed out/i.test(msg)
    const aborted = !quotaCancelled && liveQf === null && (Boolean(input.signal?.aborted) || /aborted/i.test(msg))
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
    const networkStreak = isTransportFailure({
      rawErrText,
      authFailureText: '',
      stderrTail: errText,
      stdoutHead: '',
      runLogText: logText,
    })
      ? deps.noteNetworkFailure(input.sessionKey)
      : 0
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
    // A transport failure that reaches the caller without a backoff makes the
    // CLI fallback retry instantly into the same dead egress; the CLI path
    // already stamps this delay, so the ACP path must too.
    if (networkStreak > 0 && failure.retryAfterMs === undefined) {
      failure.retryAfterMs = networkRetryDelayMs(networkStreak)
    }
    return {
      failure,
      durationMs: outcome.durationMs,
      stderr: errText,
      rawErrText,
      runLogText: logText,
      silentTimeout: timedOut && !emittedAny,
      outcomeOverride: outcome,
      empty: !sawRealOutput,
      keyringJitter: looksLikeAuthVerificationJitter(`${errText} ${logText}`),
    }
  } finally {
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

  if (account && account.dir) ensureIsolatedKeychain(account.dir)
  const env = buildAgyEnv({
    ...(account === undefined ? {} : { account }),
    cfg,
    ...(sessionKey === '' ? {} : { sessionId: sessionKey }),
    telemetryFlags: cfg.disableTelemetry,
  })

  let proc!: AcpProcess
  let sid = ''
  let prompt = input.prompt
  const usesSharedSlot =
    process.platform === 'win32'
    && !(account?.dir && !account.systemHome && supportsSshIsolation(deps.agyVersion?.() ?? null))
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
  // Arm the narrow hand-off now, but do NOT fire onFirstEvent yet. ACP reads the
  // credential when the child starts, however this turn can still be abandoned
  // below and re-run over the CLI — and the CLI path spawns a NEW agy that must
  // read the slot again. Releasing the lease here would let the slot be
  // rewritten (typically back to the primary) before that second spawn, so the
  // fallback would silently run as a different account.
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
