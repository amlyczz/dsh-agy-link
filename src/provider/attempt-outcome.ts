// Credential-slot dispatch + the async outcome closure for one agy attempt.
//
// Split out of AgyAdapter.streamAttempt. Dispatch is an async generator
// because it yields session-visible queue notices while waiting; the outcome
// closure runs detached (exactly like the former inline `void (async () => …)`),
// waits for the child, flushes the parser, classifies the failure and calls
// finalizeAttempt.
import { LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  Err,
  isTransportFailure,
  looksLikeAuthFailure,
  looksLikeAuthVerificationJitter,
  looksLikeRateLimit,
  networkRetryDelayMs,
  type PluginConfig,
} from '../common/types.ts'
import { readAgyRunLogText } from '../host/agy-log.ts'
import type { RunRecording } from '../host/recording.ts'
import type { StreamJsonParser } from '../host/parser.ts'
import type { RunningProcess } from '../host/runner.ts'
import {
  AbortedWaitError,
  WaitTimeoutError,
  acquireCredentialSlot,
  credentialSlotMutex,
  SlotUnavailableError,
} from '../host/credential-slot.ts'
import { detectSystemProxy } from '../host/wincred.ts'
import { classifyFailure, type AttemptFailure } from './failure.ts'
import { finalizeAttempt } from './finalize.ts'
import { STATUS_NOTICE_BLOCK_INDEX, awaitWithNotices } from './notices.ts'
import {
  abortableDelay,
  brief,
  buildSpawnArgs,
  createAttemptRecorder,
  createAttemptSlot,
  startAttemptProcess,
  type AttemptDeps,
  type AttemptInput,
  type AttemptRecorder,
  type AttemptSlot,
  type SpawnPlan,
  type SpawnedAttempt,
} from './attempt.ts'

function describeDispatchTimeoutNotice(cfg: PluginConfig, attempt: number, maxAttempts: number, backoffMs: number): string {
  return '[agy] 等待 agy 凭据槽已超过 ' + cfg.dispatchTimeoutMinutes + ' 分钟，正在重新排队（' +
    Math.round(backoffMs / 1000) + ' 秒后重试 ' + (attempt + 1) + '/' + maxAttempts +
    '）。\n[agy] credential-slot wait exceeded ' + cfg.dispatchTimeoutMinutes + 'm — re-queueing (attempt ' +
    (attempt + 1) + '/' + maxAttempts + ').\n'
}

/** Console heartbeat for a dispatch stuck behind the credential slot. */
function createDispatchHeartbeat(deps: AttemptDeps, startedAt: number): { start: () => void; stop: () => void } {
  const DISPATCH_HEARTBEAT_MS = 2 * 60_000
  let timer: NodeJS.Timeout | null = null
  return {
    start: () => {
      if (timer !== null) return
      timer = setInterval(() => {
        const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
        const mutex = credentialSlotMutex
        deps.log?.(
          'agy dispatch still waiting: ' + mins + 'm — credential slot queue: ' + mutex.waiting +
          ' waiter(s), ' + (mutex.pending - mutex.waiting) + ' holder(s) (another session may be running a long agy tool)' +
          ' — the turn is waiting for the slot; press Stop to cancel',
        )
      }, DISPATCH_HEARTBEAT_MS)
      timer.unref?.()
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

/** Acquire the machine-wide credential slot (skipped under node:test). */
function acquireSlotLease(
  deps: AttemptDeps,
  input: AttemptInput,
  dispatchHardCapMs: number,
): Promise<Awaited<ReturnType<typeof acquireCredentialSlot>>> {
  // Never engage the real Credential Manager from a test run: node:test sets
  // NODE_TEST_CONTEXT, and the fake-agy pool tests build accounts that do not
  // own the machine's system login. Their credential-slot unit tests inject a
  // fake IO and still exercise the handoff directly.
  if (process.env.NODE_TEST_CONTEXT !== undefined) return Promise.resolve(undefined)
  const { cfg, account, signal } = input
  // Windows has ONE process-global credential slot that every agy process
  // reads. Ownership is serialized for the whole run and only handed over when
  // it can provably be handed back. This throws instead of signing in as the
  // wrong account, which would silently spend that account's quota.
  return acquireCredentialSlot(account ?? undefined, deps.pool, {
    baseDir: deps.pool?.dir,
    proxyUrl: account?.proxyUrl || cfg.proxyUrl || detectSystemProxy() || undefined,
    log: (msg) => deps.log?.(msg),
    signal,
    dispatchTimeoutMs: dispatchHardCapMs,
    parallel: cfg.parallelSameAccount,
  })
}

type DispatchFailurePlan =
  | { kind: 'abort' }
  | { kind: 'retry'; logMessage: string; notice: string }
  | { kind: 'timeout' }
  | { kind: 'fatal'; error: LlmError }

/** Turn a dispatch rejection into the same decisions the inline catch made. */
function planDispatchFailure(
  e: unknown,
  cfg: PluginConfig,
  attempt: number,
  maxAttempts: number,
  backoffMs: number,
): DispatchFailurePlan {
  if (e instanceof AbortedWaitError) return { kind: 'abort' }
  if (e instanceof WaitTimeoutError) {
    // The slot never arrived within the hard cap. Retry if allowed, otherwise
    // fail the turn VISIBLY — never park it silently.
    if (attempt < maxAttempts) {
      return {
        kind: 'retry',
        logMessage: 'agy dispatch attempt ' + attempt + '/' + maxAttempts + ' timed out after ' +
          cfg.dispatchTimeoutMinutes + 'm waiting for the credential slot — releasing and retrying in ' +
          Math.round(backoffMs / 1000) + 's',
        notice: describeDispatchTimeoutNotice(cfg, attempt, maxAttempts, backoffMs),
      }
    }
    return { kind: 'timeout' }
  }
  const detail = e instanceof SlotUnavailableError ? e.message : brief(String(e))
  return { kind: 'fatal', error: new LlmError(detail, Err.AGY_ERROR) }
}

/**
 * Acquire the concurrency semaphore, then the machine-wide credential slot.
 * Yields session-visible queue notices while waiting. On success returns the
 * slot handles; on a fatal/abort/timeout error clears the in-flight marker and
 * throws the same errors as before (timeouts retry up to dispatchRetries).
 */
export async function* dispatchCredentialSlot(
  deps: AttemptDeps,
  input: AttemptInput,
): AsyncGenerator<StreamChunk, AttemptSlot, void> {
  const { cfg, sessionKey, prompt } = input
  const dispatchHardCapMs = cfg.dispatchTimeoutMinutes > 0 ? cfg.dispatchTimeoutMinutes * 60_000 : 0
  const heartbeat = createDispatchHeartbeat(deps, Date.now())
  let release: (() => void) | null = null
  let slotLease: Awaited<ReturnType<typeof acquireCredentialSlot>>
  let granted = false
  let currentAccount = input.account
  let dispatchBackoffMs = 2_000
  const maxDispatchAttempts = 1 + Math.max(0, cfg.dispatchRetries)
  // Set when the CALLER abandons this generator (Stop / stream closed) while
  // the wait below is suspended. A grant that lands after that point has
  // nobody left to release it, so it is handed straight back — otherwise one
  // semaphore slot leaks per abandoned wait and the pool dead-locks.
  let abandonedDuringDispatch = false
  let dispatchSettled = false
  try {
    for (let attempt = 1; attempt <= maxDispatchAttempts && !granted; attempt++) {
      try {
        const pendingConcurrencySlot = deps.acquire(input.signal)
        void pendingConcurrencySlot.then(
          (late) => {
            if (abandonedDuringDispatch) {
              try {
                late()
              } catch {
                // best-effort
              }
            }
          },
          () => {},
        )
        release = yield* awaitWithNotices(pendingConcurrencySlot, {
          // Fast dispatches never emit anything: the notice only exists for
          // waits the user would otherwise read as a freeze. The cadence
          // escalates (20s → 60s → 3m → 9m) so a 15-minute queue leaves a
          // handful of lines instead of a wall of them.
          intervalMs: 20_000,
          escalate: 3,
          maxIntervalMs: 9 * 60_000,
          notice: (waitedMs) =>
            '[agy] 正在等待 agy 凭据槽：另一个会话正在运行（已等待 ' + Math.max(1, Math.round(waitedMs / 60_000)) +
            ' 分钟）。同一台机器同一时刻只能有一个 agy 身份占用系统凭据槽；稍候会自动开始，按 Stop 可取消。\n' +
            '[agy] waiting for the agy credential slot: another session is running (' +
            Math.max(1, Math.round(waitedMs / 60_000)) + 'm elapsed).',
        })
        heartbeat.start()
        slotLease = await acquireSlotLease(deps, { ...input, account: currentAccount }, dispatchHardCapMs)
        granted = true
      } catch (e) {
        // Return the concurrency slot before deciding: a retry re-acquires.
        release?.()
        release = null
        if (e instanceof SlotUnavailableError && currentAccount && deps.pool) {
          deps.pool.markAuthRequired(currentAccount.id, e.message)
          const next = attempt < maxDispatchAttempts ? deps.pool.selectAccount(input.family, input.activeModel) : undefined
          if (next && next.id !== currentAccount.id) {
            deps.log?.(`slot unavailable on ${currentAccount.id}: ${e.message} — failed over to ${next.id}`)
            yield {
              type: 'reasoning-delta',
              index: STATUS_NOTICE_BLOCK_INDEX,
              text: `[agy] 账号凭据不可用，正在自动切换至可用账号 ${next.alias || next.id}...\n`,
            }
            currentAccount = next
            input.account = next
            heartbeat.stop()
            await abortableDelay(dispatchBackoffMs, input.signal, 'request aborted during dispatch backoff')
            dispatchBackoffMs = Math.min(dispatchBackoffMs * 2, 15_000)
            continue
          }
        }
        const plan = planDispatchFailure(e, cfg, attempt, maxDispatchAttempts, dispatchBackoffMs)
        if (plan.kind === 'abort') {
          throw new LlmError('request aborted while waiting for the agy credential slot', Err.AGY_ERROR)
        }
        if (plan.kind === 'retry') {
          deps.log?.(plan.logMessage)
          // Console-only logs are invisible in the session; say it in the
          // transcript too, or the turn looks hung for another full cap.
          yield { type: 'reasoning-delta', index: STATUS_NOTICE_BLOCK_INDEX, text: plan.notice }
          heartbeat.stop()
          await abortableDelay(dispatchBackoffMs, input.signal, 'request aborted during dispatch backoff')
          dispatchBackoffMs = Math.min(dispatchBackoffMs * 2, 15_000)
          continue
        }
        if (plan.kind === 'timeout') {
          throw new LlmError(
            'could not take the agy credential slot within ' + cfg.dispatchTimeoutMinutes +
            'm (another run may be wedged holding it). Check the console for the dispatch heartbeat, restart DSH if a run is truly stuck.',
            Err.TIMEOUT,
          )
        }
        throw plan.error
      }
    }
    dispatchSettled = true
  } catch (e) {
    dispatchSettled = true
    heartbeat.stop()
    deps.clearInFlightPrompt(sessionKey, prompt)
    throw e
  } finally {
    // Reached with dispatchSettled still false ONLY when the caller
    // abandoned this generator mid-wait (Stop / stream closed): flag it so a
    // grant that lands afterwards is handed back instead of leaking.
    if (!dispatchSettled) abandonedDuringDispatch = true
  }
  heartbeat.stop()
  return createAttemptSlot(release, slotLease, deps.log)
}

/** Evidence + failure for one settled run (pure classification inputs). */
function classifyRun(input: {
  cfg: PluginConfig
  outcome: Awaited<RunningProcess['outcome']>
  parser: StreamJsonParser
  rec: RunRecording
  runLogHome: string
  runLogsBefore: ReadonlySet<string>
}): { failure: AttemptFailure | null; rawErrText: string; runLogText: string; silentTimeout: boolean } {
  const { cfg, outcome, parser, rec, runLogHome, runLogsBefore } = input
  // A result envelope the mapper will finish on: ok, or an error that still
  // carries a usable response. Anything else leaves the live span un-finished,
  // so the failure below reaches it through the recording.
  const r = rec.getResultEvent()
  const consumable = r !== null && (r.ok || r.response !== '')
  // Error classification scans ONLY stderr and the result envelope's error
  // field. stdout is model prose + event JSON: a run whose streamed text merely
  // MENTIONED "rate limit"/"quota" (or contained a hash with "429") used to be
  // misclassified as a quota failure.
  const rawErrText = [outcome.stderrTail, parser.stats.lastResultError].filter(Boolean).join(' ')
  const isRateLimit = looksLikeRateLimit(rawErrText)
  const runLogText = readAgyRunLogText(runLogHome, runLogsBefore)
  const keyringJitter = looksLikeAuthVerificationJitter(runLogText)
  // One pure decision seam (issue #71): the wide transport regex used to miss
  // the run log, so a proxy blip that agy logs as "token validation failed due
  // to network error" was classified AUTH and quarantined a healthy account.
  const transportFailure = isTransportFailure({
    rawErrText,
    authFailureText: parser.stats.authFailureText ?? '',
    stderrTail: outcome.stderrTail,
    stdoutHead: outcome.stdout,
    runLogText,
  })
  // A timeout that never produced a single stdout event is an account-level
  // black hole (unreachable Google / wedged credential), not a long tool.
  const silentTimeout = outcome.timedOut === true && outcome.stdout.trim() === ''
  const failure = classifyFailure({
    cfg,
    outcome,
    parser,
    sawAuthFailure: sawAuthFailure(parser, outcome),
    consumable,
    transportFailure,
    keyringJitter,
    rawErrText,
    isRateLimit,
    silentTimeout,
  })
  return { failure, rawErrText, runLogText, silentTimeout }
}

function sawAuthFailure(parser: StreamJsonParser, outcome: { stderrTail: string }): boolean {
  if (parser.stats.sawAuthFailure) return true
  if (looksLikeAuthFailure(outcome.stderrTail)) return true
  if (parser.stats.lastResultError && looksLikeAuthFailure(parser.stats.lastResultError)) return true
  return false
}

export interface OutcomeContext extends SpawnedAttempt {
  recorder: AttemptRecorder
  slot: AttemptSlot
  spawn: SpawnPlan
}

/**
 * The concurrent outcome closure: wait for the child, release the slot, flush
 * the parser, classify the failure, settle the recording, and finalize.
 * Ordering matches the former inline closure exactly.
 */
export async function handleAttemptOutcome(
  deps: AttemptDeps,
  input: AttemptInput,
  ctx: OutcomeContext,
): Promise<void> {
  const { recorder, slot, spawn, runLogHome, runLogsBefore } = ctx
  const { rec, parser } = recorder
  const { cfg, sessionKey } = input
  const outcome = await ctx.proc.outcome
  slot.releaseOnce()
  recorder.stop()
  deps.unregisterActiveRun(sessionKey, rec)
  deps.clearInFlightPrompt(sessionKey, spawn.prompt)
  recorder.drain(input.agyOnEvent)
  const conversationId = recorder.conversationId()
  const { failure, rawErrText, runLogText, silentTimeout } = classifyRun({
    cfg,
    outcome,
    parser,
    rec,
    runLogHome,
    runLogsBefore,
  })
  // Transport failures carry their own backoff. DSH's generic schedule
  // (2s, doubling) cannot outlast an egress outage: the streak resets on
  // success and on any non-transport failure, so only a sustained outage
  // escalates.
  if (failure !== null) {
    if (failure.code === Err.NETWORK) {
      failure.retryAfterMs = networkRetryDelayMs(deps.noteNetworkFailure(sessionKey))
    } else {
      deps.clearNetworkStreak(sessionKey)
    }
  }
  rec.settle(failure)
  // A newer run may already own this session (steer preemption whose bounded
  // settle wait expired). Its own handler writes the authoritative binding —
  // letting this stale closure write afterwards used to regress
  // lastMessageCount/sentImageIds and re-digest or re-attach old images.
  const superseded = deps.isSuperseded(sessionKey, rec)
  await finalizeAttempt({
    rec,
    outcome,
    failure,
    store: deps.store,
    ...(deps.pool === undefined ? {} : { pool: deps.pool }),
    ...(input.account === undefined ? {} : { account: input.account }),
    family: input.family,
    persistBinding: input.persistBinding,
    sessionAccountKey: input.sessionAccountKey,
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    conversationId,
    messages: input.messages,
    model: input.model,
    activeModel: input.activeModel,
    superseded,
    newlySentImageIds: input.newlySentImageIds,
    rawErrText,
    runLogText,
    silentTimeout,
    sessionKey,
    clearNetworkStreak: (key) => deps.clearNetworkStreak(key),
    dropFailoverBudget: (key) => deps.dropFailoverBudget(key),
    clearRateLimitFailover: (key) => deps.clearRateLimitFailover(key),
    sharesSingleEgress: () => deps.sharesSingleEgress(),
    ...(deps.onRun === undefined ? {} : { onRun: deps.onRun }),
  })
}

/**
 * Run one attempt: recorder → slot dispatch → spawn → concurrent outcome.
 * Returns the recording whose spans driveSpan consumes. Yields the dispatch
 * queue notices; the outcome closure runs detached exactly as before.
 */
export async function* runAgyAttempt(
  deps: AttemptDeps,
  input: AttemptInput,
): AsyncGenerator<StreamChunk, RunRecording, void> {
  const recorder = createAttemptRecorder(deps, input.cfg, input.account)
  // Build the argv (and tail-trim an over-budget prompt) BEFORE waiting for
  // the slot, exactly as the former inline block did — the trim warning is
  // logged even when the dispatch later aborts.
  const spawn = buildSpawnArgs(input, recorder.printTimeoutMinutes, deps.log)
  // Dispatch sees the NUL-sanitized prompt: its failure path clears the
  // in-flight marker with the same string the former inline block used.
  const slot = yield* dispatchCredentialSlot(deps, { ...input, prompt: spawn.prompt })
  const spawned = await startAttemptProcess(deps, input, spawn, recorder, slot)
  void handleAttemptOutcome(deps, input, { ...spawned, recorder, slot, spawn }).catch((err) => {
    slot.releaseOnce()
    recorder.rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
  })
  return recorder.rec
}