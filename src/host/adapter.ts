// AgyAdapter — the LlmAdapter implementation at the heart of the plugin
// (spec section 3). Translates one DSH model call into a short-lived
// `agy -p --output-format stream-json` child process, maps the NDJSON event
// stream onto StreamChunks, and binds DSH sessions to agy conversations for
// multi-turn continuity (ADR-4). Only the trailing user messages become the
// prompt; earlier context rides agy-native history plus a digest prefix on
// first bind (ADR-7).
import { homedir } from 'node:os'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { modelFamilyOf } from '../common/pool-types.ts'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import { resolveCallContext } from '../provider/call-context.ts'
import { purposePolicy } from '../provider/purpose-policy.ts'
import { driveSpan as driveSpanImpl } from '../provider/span.ts'
import { EffortPolicy } from '../provider/effort-policy.ts'
import { FailoverBudget } from '../provider/failover-budget.ts'
import { listAvailableModels, resolveModelInfo, type ModelResolutionDeps } from '../provider/model-resolution.ts'
import { providerRetryPolicyFor, streamWithEffortRetry } from '../provider/retry-policy.ts'
import { deliverContext } from '../provider/context-delivery.ts'
export { calcPromptTokens, mergeSentImageIds } from '../provider/finalize.ts'
import { selectSessionAccount } from '../provider/account-selection.ts'
import { buildPromptPlan } from '../provider/prompt.ts'
import { buildAgyArgs, waitForRunSettle, type AttemptDeps, type AttemptInput } from '../provider/attempt.ts'
import { runAgyAttempt } from '../provider/attempt-outcome.ts'
export { STATUS_NOTICE_BLOCK_INDEX, awaitWithNotices } from '../provider/notices.ts'
export { AGY_PROMPT_SAFE_BYTES, AGY_SINGLE_MESSAGE_MAX_BYTES, buildDigest, collectUnsentImageRefs, elideMiddle, isRealUserMessage, isSyntheticHarnessMessage, latestUserMessageAny, latestUserTaskText, utf8Bytes } from '../provider/prompt-text.ts'
import { Err, accountsShareSingleEgress, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import type { RunRecording } from './recording.ts'
import { defaultEffortFor, findEntry, resolveModelSlug } from './models.ts'
import { detectSystemProxy } from './wincred.ts'
import { isGoalToolContinuation, isPlanToolContinuation, isPlanMode, resolveGoalContext } from './dsh-goal.ts'

import type { AgyAdapterDeps } from '../provider/adapter-contract.ts'
export type { AgyAdapterDeps } from '../provider/adapter-contract.ts'
export { parseEffortUnsupported, parseModelNotRecognized } from '../provider/effort-policy.ts'
import { detectContinuation } from '../provider/continuation.ts'
export { detectContinuation, toolCallIdOf } from '../provider/continuation.ts'

// ---- stream() -------------------------------------------------------------

export class AgyAdapter extends LlmAdapter {
  private readonly recentlyCompactedSessions = new Map<string, number>()
  /** Effort-refusal cache (learned from agy refusals; issue #67). */
  private readonly effortPolicy: EffortPolicy
  /** Failover / rate-limit / network-streak retry budgets. */
  private readonly failover = new FailoverBudget()

  private readonly warnedKeys = new Set<string>()
  /** sessionKey -> in-flight run, for steer-time preemption. */
  private readonly activeRuns = new Map<string, RunRecording>()
  /**
   * sessionKey -> prompt info for duplicate submission debounce.
   * `inFlight` is true from submit until the run settles (or spawn throws),
   * so a settled failure can never wall a legitimate retry.
   */
  private readonly activeSessionPrompts = new Map<string, { prompt: string; startedAt: number; inFlight: boolean }>()
  /** accountId -> timestamp of last spawn for spacing throttling */
  private readonly lastAccountSpawnTime = new Map<string, number>()
  private readonly minSpawnIntervalMs = 500
  /** Global sliding window timestamps for batch rate-limiting protection */
  private readonly requestTimestamps: number[] = []

  constructor(private readonly deps: AgyAdapterDeps) {
    super()
    if (deps.pool && deps.catalog && typeof (deps.pool as any).setCatalog === 'function') {
      (deps.pool as any).setCatalog(deps.catalog)
    }
    this.effortPolicy = new EffortPolicy(
      () => this.deps.effortUnsupported?.(),
      this.deps.log,
      this.deps.onEffortUnsupported,
    )
  }

  /** Models currently known to reject `--effort` (persisted seed + learned). */
  effortUnsupportedModels(): string[] {
    return this.effortPolicy.unsupportedModels()
  }

  /** True when `--effort` must not be passed to this model. */
  isEffortUnsupported(model: string): boolean {
    return this.effortPolicy.isUnsupported(model)
  }

  /** Learn a refusal: remember it, tell the host to persist + refresh the picker. */
  learnEffortUnsupported(model: string): void {
    this.effortPolicy.learn(model)
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return
    this.warnedKeys.add(key)
    this.deps.log?.('WARNING: ' + msg)
  }

  private noteNetworkFailure(sessionKey: string): number {
    return this.failover.noteNetworkFailure(sessionKey)
  }

  private clearNetworkStreak(sessionKey: string): void {
    this.failover.clearNetworkStreak(sessionKey)
  }

  /**
   * Whether every enabled account leaves through the same proxy.
   *
   * A shared egress makes a transport failure a property of the machine's
   * network, not of the account: rotating the sticky pointer repoints the
   * session for nothing and spends the rotation budget a real quota or
   * eligibility hop needs (live 2026-10-21: one flapping proxy produced EOFs
   * on every account and the turn still rotated the pool).
   */
  private sharesSingleEgress(): boolean {
    // A pool account is seeded with a COPY of the system proxy while the
    // primary account keeps an empty override, so the account comparison needs
    // the same fallback the spawn path uses: config proxy, else detected system.
    const cfg = this.deps.getConfig()
    const fallback = (cfg.proxyUrl ?? '').trim() || (detectSystemProxy() ?? '')
    return accountsShareSingleEgress(this.deps.pool?.getAccounts() ?? [], fallback)
  }

  /** Mark a session prompt as no longer in flight so retries are not debounced. */
  private clearInFlightPrompt(sessionKey: string, prompt: string): void {
    if (sessionKey === '') return
    const ap = this.activeSessionPrompts.get(sessionKey)
    if (ap === undefined || ap.prompt !== prompt) return
    this.activeSessionPrompts.set(sessionKey, { ...ap, inFlight: false })
  }

  private claimFailover(sessionKey: string, code: string | undefined): boolean {
    return this.failover.claim(sessionKey, code, {
      enabledAccounts: () => (this.deps.pool?.getAccounts() ?? []).filter((a) => a.enabled).length,
      sharesSingleEgress: () => this.sharesSingleEgress(),
    })
  }

  /** Retry policy: fail fast on auth/abort, retry transient/account-scoped failures. */
  override providerRetryPolicy(_provider: string) {
    return providerRetryPolicyFor(this.deps.pool)
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (agy CLI)' }
  }

  private modelDeps(): ModelResolutionDeps {
    return {
      catalog: this.deps.catalog,
      pool: this.deps.pool,
      getConfig: () => this.deps.getConfig(),
      isEffortUnsupported: (model: string) => this.isEffortUnsupported(model),
      warnOnce: (key: string, msg: string) => this.warnOnce(key, msg),
    }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return listAvailableModels(this.modelDeps())
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return resolveModelInfo(this.modelDeps(), model)
  }

  /**
   * Bind exact model metadata and dispatch to ONE adapter generation.
   * Required by dsh-llm >= 0.1.1-rc.2: LlmRuntime.prepareCall calls
   * registration.adapter.prepareCall(provider, model, signal) unconditionally,
   * so an adapter compiled against the old base class (no prepareCall) crashed
   * with "registration.adapter.prepareCall is not a function" on new hosts.
   * Implemented explicitly here so both old and new runtimes work: the old
   * runtime never calls it, the new runtime gets the capability-bound handle.
   * Declared without `override`/imported types on purpose: the plugin still
   * typechecks against dsh-llm ^0.1.0-rc.6 (no prepareCall in the base), while
   * the runtime contract matches the 0.1.1-rc.2 PreparedAdapterCall shape
   * { model: LlmResolvedModelInfo; stream(options): AsyncIterable<StreamChunk> }.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }> {
    if (signal?.aborted) throw signal.reason ?? new LlmError('aborted', 'ABORTED')
    const modelInfo = await this.resolveModel(provider, model, signal)
    return {
      model: modelInfo,
      stream: (options) => this.stream({ ...options, signal: options.signal ?? signal }),
    }
  }

  /** Build the agy argv for one call. Exported for tests. */
  buildArgs(opts: Parameters<typeof buildAgyArgs>[0]): string[] {
    return buildAgyArgs(opts)
  }

  /** Effort and model self-healing wrapper around streamAttempt (issue #67, PR #100). */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* streamWithEffortRetry({
      streamAttempt: (opts, suppressEffort) => this.streamAttempt(opts, suppressEffort),
      learnEffortUnsupported: (model) => this.learnEffortUnsupported(model),
      onModelUnsupported: (unrecog) => {
        const fam = modelFamilyOf(unrecog)
        const pool = this.deps.pool
        if (pool) {
          const currentId = pool.getActiveAccountId(fam)
          if (currentId) {
            pool.markModelUnsupported(currentId, unrecog)
          }
          pool.selectAccount(fam, unrecog)
        }
      },
    }, options as AgyGenerateOptions)
  }

  private async *streamAttempt(options: AgyGenerateOptions, suppressEffort = false): AsyncIterable<StreamChunk> {
    const ctx = resolveCallContext({
      options,
      cfg: this.deps.getConfig(),
      bin: this.deps.bin(),
      ...(this.deps.sessionCwd === undefined
        ? {}
        : { sessionCwd: (id: string) => this.deps.sessionCwd?.(id) }),
      warnOnce: (key: string, message: string) => this.warnOnce(key, message),
    })
    const { cfg, bin, isReview, isTitle, isCompaction, isTranslate, isImage, isAux } = ctx
    const { permissionMode, sessionKey, workspaceRoot, isCodeMode, hasToolSupport } = ctx
    const policy = purposePolicy(ctx)
    // Keep the local alias: TypeScript's aliased-condition narrowing makes
    // `else if (isTranslateSession)` narrow `translateSession` below.
    const translateSession = ctx.translateSession
    const isTranslateSession = translateSession !== null
    // DSH synthetic lifecycle tool continuation: if the trailing message is
    // the tool-result of an update_goal or exit_plan_mode bridge call, the
    // DSH state machine has accepted the transition. Finish cleanly without
    // re-spawning an agy process.
    if (isGoalToolContinuation(options.messages) || isPlanToolContinuation(options.messages)) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // Goal completion is synthesized only for an active, armed goal round.
    // The live goal view is authoritative; history detection is a fallback for
    // hosts without it. Do not resurrect a completed goal from old history:
    // that re-emitted `update_goal` with the same deterministic call id on every
    // later turn and ended in `400 Duplicate 'call_id'` on HTTP providers
    // (2026-11-07 incident).
    const liveGoal = sessionKey !== '' && this.deps.sessionGoal ? this.deps.sessionGoal(sessionKey) : undefined
    const goalContext = resolveGoalContext(options.messages, liveGoal)
    const supportsGoalUpdate = Boolean(options.tools?.some((t) => t.name === 'update_goal'))
    const supportsPlanExit = Boolean(options.tools?.some((t) => t.name === 'exit_plan_mode')) && isPlanMode(options.messages)

    // ---- native tool mirroring: continuation spans (v0.3) ----
    // When the previous span cut on a completed agy tool step, DSH dispatched
    // the agy_tool mirror (which replayed the recorded output) and is now
    // calling us again to continue the SAME run. Resume the recording from
    // the cursor encoded in the trailing tool-result callId — no new process,
    // no prompt assembly, no digest.
    const continuation = detectContinuation(options.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      // A SETTLED recording that ended in an ACCOUNT-scoped failure must not be
      // re-driven: DSH re-issues the same step (same trailing tool result), so
      // resuming it merely replays the identical failure. That is why quota
      // exhaustion AFTER a tool call used to dead-end the turn while a healthy
      // account sat idle — the fix is to forget the dead run and fall through,
      // which re-assembles the prompt and re-selects an account.
      //
      // Only account-scoped codes qualify, and only up to the pool's spare
      // depth: a deterministic failure (or a pool with nothing left to try)
      // must still surface as the turn's error instead of re-running the work
      // forever on rotating accounts.
      const deadFailure = rec !== undefined && rec.isSettled ? rec.failureInfo : null
      if (rec !== undefined && !(deadFailure !== null && this.claimFailover(sessionKey, deadFailure.code))) {
        yield* driveSpanImpl(this.deps, rec, continuation.eventIndex + 1, hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal)
        return
      }
      if (rec !== undefined) {
        this.deps.runs.forget(continuation.runId)
        this.warnOnce(
          'dead-continuation:' + continuation.runId,
          'agy run ' + continuation.runId + ' settled in ' + (deadFailure?.code ?? '') + ' — retrying this step instead of replaying it'
            + (deadFailure?.code === Err.NETWORK && this.sharesSingleEgress() ? ' on the same account (shared egress)' : ' on another account'),
        )
      } else {
        this.warnOnce(
          'stale-continuation:' + continuation.runId,
          'agy run ' + continuation.runId + ' is no longer available in memory (server restarted?) — falling back to fresh turn prompt assembly',
        )
      }
    }
    // Session ownership (steer preemption + duplicate debounce) is decided
    // AFTER prompt assembly below, so an identical retry can never abort a
    // live long-running tool (issue #33), while a true steer still can.
    const catalog = this.deps.catalog.get()
    const rawModel = options.model
    const model = resolveModelSlug(rawModel)
    const entry = findEntry(catalog, model)
    const isGemini = (model === '' ? cfg.defaultModel : model).toLowerCase().startsWith('gemini')
    // The catalog is advisory (the fallback list may be stale): accept unknown
    // ids, but validate explicit reasoning efforts against known entries.
    let effort: string | undefined
    if (isGemini && !suppressEffort) {
      if (this.isEffortUnsupported(model)) {
        // agy told us this model takes no --effort (issue #67). Asking again
        // would fail the whole invocation, so the flag is dropped silently —
        // the requested level is simply not selectable on this agy build.
        effort = undefined
      } else if (policy.pinLowEffort) {
        effort = 'low'
      } else if (options.reasoningEffort !== undefined) {
        const wanted = String(options.reasoningEffort)
        if (entry && entry.efforts === null) {
          throw new LlmError('model ' + model + ' has no selectable reasoning efforts', Err.UNSUPPORTED_REASONING_EFFORT)
        }
        if (entry && entry.efforts && !entry.efforts.includes(wanted)) {
          throw new LlmError('reasoning effort ' + wanted + ' is not supported by ' + model, Err.UNSUPPORTED_REASONING_EFFORT)
        }
        effort = wanted
      } else if (entry && entry.efforts) {
        effort = defaultEffortFor(entry, cfg)
      }
    }

    // ---- prompt assembly (ADR-7) is handled by buildPromptPlan below ----
    const messages = options.messages

    // Sliding-window rate limit protection per minute (for overnight batch / /goal stability)
    if (!isAux && cfg.rateLimitPerMinute > 0) {
      const now = Date.now()
      const windowStart = now - 60_000
      while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < windowStart) {
        this.requestTimestamps.shift()
      }
      if (this.requestTimestamps.length >= cfg.rateLimitPerMinute) {
        const delayMs = this.requestTimestamps[0]! + 60_000 - now
        if (delayMs > 0) {
          // Abort-aware: a Stop during the rate-limit sleep must end the turn,
          // not silently finish the sleep and spawn anyway.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              options.signal?.removeEventListener('abort', onAbort)
              resolve()
            }, delayMs)
            const onAbort = () => {
              clearTimeout(timer)
              reject(new LlmError('aborted during rate-limit spacing', Err.AGY_ERROR))
            }
            options.signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
      }
      this.requestTimestamps.push(Date.now())
    }

    const selection = await selectSessionAccount({
      deps: {
        ...(this.deps.pool === undefined ? {} : { pool: this.deps.pool }),
        store: this.deps.store,
        ...(this.deps.syncSessionModel === undefined
          ? {}
          : { syncSessionModel: (id: string, m: string, effort?: string) => this.deps.syncSessionModel?.(id, m, effort) }),
      },
      cfg,
      model,
      isAux,
      sessionKey,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
    })
    const account = selection.account
    let family = selection.family
    let activeModel = selection.activeModel
    // The account is final here: record it as *the* in-use account so the
    // console shows exactly one badge (per-family pointers may point at
    // families the user is not currently running).
    if (account && !isAux) this.deps.pool?.markAccountActive(account.id)
    // Image callers need the account's HOME to find agy's artifact directory
    // (`<home>/.gemini/antigravity-cli/brain/<conversation>/`). The hook is
    // advisory: a throwing listener must never break a run.
    const onAccount = options.agyOnAccount
    if (typeof onAccount === 'function' && account) {
      try {
        onAccount({ id: account.id, home: account.dir || process.env.HOME || homedir() })
      } catch {
        // contained
      }
    }

    const plan = await buildPromptPlan({
      options,
      cfg,
      ctx,
      policy,
      account,
      model,
      activeModel,
      deps: {
        store: this.deps.store,
        ...(this.deps.readImage === undefined ? {} : { readImage: this.deps.readImage }),
        getActiveRun: (key: string) => {
          const rec = this.activeRuns.get(key)
          if (rec === undefined) return undefined
          return {
            isSettled: rec.isSettled,
            conversationId: rec.conversationId,
            ...(rec.accountHome === undefined ? {} : { accountHome: rec.accountHome }),
          }
        },
        recentlyCompactedSessions: this.recentlyCompactedSessions,
        deliverContext: (digest: string, key: string, extraAddDirs: string[]) => deliverContext(digest, key, extraAddDirs, cfg),
      },
    })
    let prompt = plan.prompt
    let binding = plan.binding
    const bindingKey = plan.bindingKey
    const persistBinding = plan.persistBinding
    const sessionAccountKey = plan.sessionAccountKey
    const currentModel = plan.currentModel
    const compactionNotice = plan.compactionNotice
    const newlySentImageIds = plan.newlySentImageIds
    const lastAssistantIdx = plan.lastAssistantIdx

    // Intentionally no prompt-side "recovery boundary" injection: keyword
    // matching on user text (missing/not found/enoent) false-positives and
    // is a plugin-side prompt injection. Guidance for missing_file lives in
    // /agy status via classifyToolError (commands.ts).

    // Session ownership: steer preemption + duplicate-submission debounce.
    //
    // - Identical prompt while a live run owns the session → BUSY. Never
    //   abort it: a mid-maven/compile agy tool is silent on stdout for many
    //   minutes (issue #33), and killing it to "retry" destroys the work.
    // - Different prompt while a live run owns the session → preempt (steer).
    // - Once a run has settled (success / error / abort) a retry of the same
    //   prompt must go through: DSH auto-retries after failures, and a
    //   time-only wall turned every fast agy failure into a BUSY dead-end
    //   (issue #32).
    if (!isAux && sessionKey !== '') {
      const now = Date.now()
      if (this.activeSessionPrompts.size > 100) {
        for (const [k, v] of this.activeSessionPrompts) {
          if (now - v.startedAt >= 30_000) this.activeSessionPrompts.delete(k)
        }
      }
      const prevPrompt = this.activeSessionPrompts.get(sessionKey)
      const liveRun = this.activeRuns.get(sessionKey)
      const runLive = liveRun !== undefined && !liveRun.isSettled
      const samePrompt = prevPrompt !== undefined && prevPrompt.prompt === prompt
      if (runLive && samePrompt) {
        // RESCUE before BUSY: an identical prompt for a session whose run is
        // still alive is normally a continuation span — but when the trailing
        // mirror result failed to parse as one (malformed callId, harness-side
        // re-send after a mirror dispatch hiccup), full prompt assembly lands
        // here and the old behaviour threw BUSY, killing a mid-flight agentic
        // turn that was perfectly healthy (2026-10-10 23:0x incident). If the
        // live recording has already cut a span we know exactly where DSH's
        // consumption stopped: re-drive it from there. Without a cut point
        // (first span still streaming, nothing consumed yet) a duplicate
        // really is a duplicate → BUSY stands.
        const rescueFrom = liveRun.lastCutIndex !== null ? liveRun.lastCutIndex + 1 : null
        if (rescueFrom !== null) {
          this.deps.log?.(
            'duplicate-debounce rescue: identical prompt for a live agy run ' + liveRun.runId + ' — re-driving from event ' + rescueFrom + ' instead of throwing BUSY',
          )
          this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: now, inFlight: true })
          yield* driveSpanImpl(this.deps, liveRun, rescueFrom, hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal)
          return
        }
        throw new LlmError(
          'Duplicate request ignored: an identical request is already running for this session.',
          Err.BUSY,
        )
      }
      // Pre-spawn race: identical prompt, still marked inFlight, no run
      // record yet. Keep the window tight so a user re-send after a fast
      // failure is never swallowed.
      if (
        samePrompt &&
        prevPrompt !== undefined &&
        prevPrompt.inFlight &&
        liveRun === undefined &&
        now - prevPrompt.startedAt < 2_000
      ) {
        throw new LlmError(
          'Duplicate request ignored: an identical request is already running for this session.',
          Err.BUSY,
        )
      }
      // Steer: a NEW prompt arrives while the previous run is still live.
      // Abort it so two agy processes never append to the same conversation.
      if (runLive && !samePrompt) {
        // Harvest the live conversation id BEFORE aborting: a tool-cut or
        // caller abort used to drop the binding entirely, so the replacement
        // process started a brand-new agy conversation with digest-only
        // prompt (issue #35 root cause ②).
        const liveCid = (liveRun.accountHome ?? '') === (account?.dir ?? '') ? liveRun.conversationId : null
        if (
          liveCid !== null &&
          binding === undefined &&
          !isAux &&
          sessionAccountKey !== ''
        ) {
          binding = {
            conversationId: liveCid,
            lastMessageCount: Math.max(0, lastAssistantIdx + 1),
            updatedAt: Date.now(),
            model: currentModel,
            interrupted: true,
          }
        } else if (binding !== undefined) {
          binding.interrupted = true
        }
        // A run whose result was ALREADY consumed is just finishing its own
        // shutdown: killing it there cut agy mid-finalize (re-creating the
        // server-side divergence that makes it answer the previous message)
        // and recorded a false ABORTED for a turn that actually answered.
        // Give it a moment to exit on its own; only a still-running turn is
        // actually preempted.
        if (liveRun.hasResult) {
          const exited = await waitForRunSettle(liveRun, 1_500)
          if (!exited) this.deps.log?.('previous agy run did not exit within 1.5s after producing its result — preempting it')
        }
        if (!liveRun.isSettled) {
          liveRun.requestAbort?.()
          // Two agy processes must never append to one conversation at the same
          // time. Give the aborted process a bounded moment to actually exit
          // (SIGTERM, then the SIGKILL escalation) before the replacement spawns.
          const exited = await waitForRunSettle(liveRun, 3_500)
          if (!exited) {
            this.warnOnce(
              'settle-timeout:' + sessionKey,
              'the preempted agy run did not exit within 3.5s — starting the replacement anyway; its late write-back is ignored because the newer run owns the session',
            )
          }
          if (!prompt.includes('the previous turn was interrupted')) {
            prompt = '[the previous turn was interrupted before it finished — do not continue or answer that unfinished work; respond only to the newest request below]\n\n' + prompt
          }
        }
      }
      this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: now, inFlight: true })
    }

    // ---- spawn + parse + outcome: delegated to provider/attempt-outcome.ts ----
    // The attempt machinery owns argv/transport, the credential-slot dispatch,
    // child spawn, parser feed and the detached outcome closure. The adapter
    // injects its private state as callbacks so it stays the single owner of
    // activeRuns, failover budgets and network streaks.
    const attemptDeps: AttemptDeps = {
      acquire: (signal?: AbortSignal) => this.deps.acquire(signal),
      pool: this.deps.pool,
      runs: this.deps.runs,
      store: this.deps.store,
      log: this.deps.log,
      onParser: this.deps.onParser,
      onRun: this.deps.onRun,
      clearInFlightPrompt: (key: string, p: string) => this.clearInFlightPrompt(key, p),
      registerActiveRun: (key: string, r: RunRecording) => this.activeRuns.set(key, r),
      unregisterActiveRun: (key: string, r: RunRecording) => {
        if (this.activeRuns.get(key) === r) this.activeRuns.delete(key)
      },
      isSuperseded: (key: string, r: RunRecording) =>
        this.activeRuns.get(key) !== undefined && this.activeRuns.get(key) !== r,
      noteNetworkFailure: (key: string) => this.noteNetworkFailure(key),
      clearNetworkStreak: (key: string) => this.clearNetworkStreak(key),
      dropFailoverBudget: (key: string) => this.failover.dropBudget(key),
      clearRateLimitFailover: (key: string) => this.failover.clearRateLimit(key),
      sharesSingleEgress: () => this.sharesSingleEgress(),
      lastAccountSpawnTime: this.lastAccountSpawnTime,
      minSpawnIntervalMs: this.minSpawnIntervalMs,
    }
    const attemptInput: AttemptInput = {
      cfg,
      bin,
      permissionMode,
      sessionKey,
      workspaceRoot,
      isAux,
      account,
      prompt,
      model,
      activeModel,
      effort,
      addDirs: plan.addDirs,
      persistBinding,
      binding,
      messages,
      newlySentImageIds,
      sessionAccountKey,
      family,
      signal: options.signal,
      agyOnEvent: options.agyOnEvent,
    }
    const rec = yield* runAgyAttempt(attemptDeps, attemptInput)

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
    yield* driveSpanImpl(this.deps, rec, 0, policy.mirrorTools && hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal, compactionNotice)
  }
}
