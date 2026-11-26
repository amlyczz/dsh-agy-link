// AgyAdapter — turns one DSH model call into an agy process/ACP session,
// maps its event stream onto StreamChunks, and binds DSH sessions to agy
// conversations for multi-turn continuity (spec §3, ADR-4/ADR-7).
import { diagnoseBridge, type BridgeDiagnostic } from '../common/bridge-tools.ts'
import { homedir } from 'node:os'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { withBridgeStep } from './bridge-steps.ts'
import type { AgyGenerateOptions, BridgeLease } from '../common/protocol.ts'
import { resolveCallContext, effectivePermissionMode } from '../provider/call-context.ts'
import { purposePolicy } from '../provider/purpose-policy.ts'
import { driveSpan as driveSpanImpl } from '../provider/span.ts'
import { EffortPolicy } from '../provider/effort-policy.ts'
import { FailoverBudget } from '../provider/failover-budget.ts'
import { SpawnLimiter } from '../provider/spawn-limiter.ts'
import { listAvailableModels, resolveModelInfo, type ModelResolutionDeps } from '../provider/model-resolution.ts'
import { providerRetryPolicyFor, streamWithEffortRetry, isRevivableFailure } from '../provider/retry-policy.ts'
import { deliverContext } from '../provider/context-delivery.ts'
export { calcPromptTokens, mergeSentImageIds } from '../provider/finalize.ts'
import { selectSessionAccount } from '../provider/account-selection.ts'
import { buildPromptPlan } from '../provider/prompt.ts'
import { extractLeadingAgySlash, formatWithLeadingAgySlash } from '../provider/leading-slash.ts'
import { INTERRUPTION_NOTICE, hasNewHumanTask, promptIdentity } from '../provider/prompt-identity.ts'
import { warnOnce } from '../provider/warn-once.ts'
export { hasNewHumanTask } from '../provider/prompt-identity.ts'
import { buildAgyArgs, resolveAttemptOverrides, waitForRunSettle, type AttemptDeps, type AttemptInput } from '../provider/attempt.ts'
import { runAgyAttempt } from '../provider/attempt-outcome.ts'
export { STATUS_NOTICE_BLOCK_INDEX, awaitWithNotices } from '../provider/notices.ts'
export { AGY_PROMPT_SAFE_BYTES, AGY_SINGLE_MESSAGE_MAX_BYTES, buildDigest, collectUnsentImageRefs, elideMiddle, isRealUserMessage, isSyntheticHarnessMessage, latestUserMessageAny, latestUserTaskText, utf8Bytes } from '../provider/prompt-text.ts'
import { Err, accountsShareSingleEgress, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { isAgyLinkNoticeSource } from '../common/agy-link-source.ts'
import type { RunRecording } from './recording.ts'
import { defaultEffortFor, findEntry, resolveModelSlug } from './models.ts'
import { detectSystemProxy } from './wincred.ts'
import { classifyPlanToolContinuation, isGoalToolContinuation, isPlanMode, resolveGoalContext } from './dsh-goal.ts'

import type { AgyAdapterDeps } from '../provider/adapter-contract.ts'
export type { AgyAdapterDeps } from '../provider/adapter-contract.ts'
export { parseEffortUnsupported, parseModelNotRecognized } from '../provider/effort-policy.ts'
import { detectContinuation } from '../provider/continuation.ts'
export { detectContinuation, toolCallIdOf } from '../provider/continuation.ts'

export class AgyAdapter extends LlmAdapter {
  private readonly recentlyCompactedSessions = new Map<string, number>()
  /** Effort-refusal cache (learned from agy refusals; issue #67). */
  private readonly effortPolicy: EffortPolicy
  /** Failover / rate-limit / network-streak retry budgets. */
  private readonly failover = new FailoverBudget()

  bridgeDiagnostic: BridgeDiagnostic | null = null
  private readonly warnedKeys = new Set<string>()
  /** sessionKey -> in-flight run, for steer-time preemption. */
  private readonly activeRuns = new Map<string, RunRecording>()
  /** sessionKey -> canonical prompt + in-flight flag for duplicate debounce/steer. */
  private readonly activeSessionPrompts = new Map<string, { prompt: string; startedAt: number; inFlight: boolean }>()
  /** accountId -> timestamp of last spawn for spacing throttling */
  private readonly lastAccountSpawnTime = new Map<string, number>()
  private readonly minSpawnIntervalMs = 500
  private readonly spawnLimiter = new SpawnLimiter()

  constructor(private readonly deps: AgyAdapterDeps) {
    super()
    deps.pool?.setCatalog?.(deps.catalog)
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

  /** In-flight recording for a session (used by /agy btw to inspect live turn progress). */
  activeRun(sessionKey: string): RunRecording | undefined {
    return this.activeRuns.get(sessionKey)
  }

  /** Live in-flight recording for `sessionKey`, if any. */
  getActiveRun(sessionKey: string): RunRecording | undefined {
    return this.activeRuns.get(sessionKey)
  }

  /** Turns in flight: boot probes yield to real work instead of competing. */
  activeRunCount(): number {
    return this.activeRuns.size
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
    warnOnce(this.warnedKeys, key, msg, this.deps.log)
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
    if (ap === undefined || ap.prompt !== promptIdentity(prompt)) return
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

  buildArgs(opts: Parameters<typeof buildAgyArgs>[0]): string[] {
    return buildAgyArgs(opts)
  }

  /** Effort, model, and aux-quota self-healing wrapper around streamAttempt (issue #67, PR #100). */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let effective = options as AgyGenerateOptions
    if (effective.purpose === 'compaction' && effective.sessionId !== undefined && this.deps.sessionPendingModel) {
      const pending = this.deps.sessionPendingModel(String(effective.sessionId))
      if (pending && pending !== '' && pending !== effective.model) {
        effective = { ...effective, model: pending }
      }
    }
    yield* streamWithEffortRetry({
      streamAttempt: (opts, suppressEffort) => {
        const cfg = this.deps.getConfig()
        return withBridgeStep(cfg.mcpBridge ? this.deps.enterBridgeStep?.(opts) : undefined,
          lease => this.streamAttempt(opts, cfg, suppressEffort, lease))
      },
      learnEffortUnsupported: (model) => this.learnEffortUnsupported(model),
      catalogAdvertisesEffort: (model) => this.deps.catalog.advertisedEfforts(model).length > 0,
      pool: this.deps.pool,
      defaultModel: () => this.deps.getConfig().defaultModel,
    }, effective)
  }

  private async *streamAttempt(options: AgyGenerateOptions, cfg: PluginConfig, suppressEffort: boolean, lease?: BridgeLease): AsyncIterable<StreamChunk> {
    const ctx = resolveCallContext({
      options, cfg,
      bin: this.deps.bin(),
      ...(this.deps.sessionCwd === undefined ? {} : { sessionCwd: (id: string) => this.deps.sessionCwd?.(id) }),
      warnOnce: (key: string, message: string) => this.warnOnce(key, message),
    })
    const { bin, isReview, isTitle, isCompaction, isTranslate, isImage, isAux } = ctx
    const { permissionMode, sessionKey, workspaceRoot, isCodeMode, hasToolSupport } = ctx
    if (!isAux) this.bridgeDiagnostic = diagnoseBridge(cfg, options.tools, (key, msg) => this.warnOnce(key, msg))
    const policy = purposePolicy(ctx)
    const translateSession = ctx.translateSession
    const isTranslateSession = translateSession !== null
    // DSH synthetic lifecycle continuations: short-circuit on goal completion
    // or dismissed plan review; approved/keep-planning must run agy next.
    if (isGoalToolContinuation(options.messages) || classifyPlanToolContinuation(options.messages) === 'dismissed') {
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
    const livePlanMode = sessionKey !== '' && this.deps.sessionPlanMode ? this.deps.sessionPlanMode(sessionKey) : undefined
    const supportsPlanExit = Boolean(options.tools?.some((t) => t.name === 'exit_plan_mode'))
      && isPlanMode(options.messages, options.system, livePlanMode)
    // Native tool mirroring continuation spans (v0.3): resume live RunRecording without re-running prompt assembly.
    const continuation = detectContinuation(options.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      // Do not re-drive a settled recording that failed account-scoped or lacks finishable events:
      // forget it so prompt assembly can rotate accounts or retry cleanly.
      const deadFailure = rec !== undefined && rec.isSettled ? rec.failureInfo : null
      const mirrorLive = policy.mirrorTools && hasToolSupport && (this.deps.isMirrorToolAvailable?.(sessionKey) ?? true)
      const deadNoResult = rec !== undefined && rec.isSettled && deadFailure === null && !rec.hasFinishableEventFrom(continuation.eventIndex + 1, mirrorLive)
      const deadRevivable = deadFailure !== null && isRevivableFailure(deadFailure.code)
      if (rec !== undefined && !deadNoResult && !deadRevivable && !(deadFailure !== null && this.claimFailover(sessionKey, deadFailure.code))) {
        lease?.resume()
        yield* driveSpanImpl(this.deps, rec, continuation.eventIndex + 1, policy.mirrorTools && hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal, undefined, false, sessionKey)
        return
      }
      if (rec !== undefined) {
        this.deps.runs.forget(continuation.runId)
        this.warnOnce(
          'dead-continuation:' + continuation.runId,
          deadNoResult
            ? 'agy run ' + continuation.runId + ' settled without a consumable result — retrying this step instead of replaying it'
            : 'agy run ' + continuation.runId + ' settled in ' + (deadFailure?.code ?? '') + ' — retrying this step instead of replaying it'
              + (deadRevivable ? ' with a fresh process' : (deadFailure?.code === Err.NETWORK && this.sharesSingleEgress() ? ' on the same account (shared egress)' : ' on another account')),
        )
      } else {
        this.warnOnce(
          'stale-continuation:' + continuation.runId,
          'agy run ' + continuation.runId + ' is no longer available in memory (server restarted?) — falling back to fresh turn prompt assembly',
        )
      }
    }
    // Session ownership: steer preemption + duplicate debounce AFTER prompt assembly.
    const forcedPlan = !isAux && sessionKey !== '' && (this.deps.consumeForcedPlanMode?.(sessionKey) ?? false)
    const agyPermissionMode = effectivePermissionMode(permissionMode, supportsPlanExit || forcedPlan, isAux)
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

    // Sliding-window TAT rate limit protection per minute (zero thundering herd)
    if (!isAux && cfg.rateLimitPerMinute > 0) {
      const { delayMs, slotAt } = this.spawnLimiter.reserveRateLimitSlot(cfg.rateLimitPerMinute)
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            options.signal?.removeEventListener('abort', onAbort)
            resolve()
          }, delayMs)
          const onAbort = () => {
            clearTimeout(timer)
            this.spawnLimiter.cancelRateLimitSlot(slotAt)
            reject(new LlmError('aborted during rate-limit spacing', Err.AGY_ERROR))
          }
          options.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
    }

    const selection = await selectSessionAccount({
      deps: {
        ...(this.deps.pool === undefined ? {} : { pool: this.deps.pool }),
        store: this.deps.store,
        ...(this.deps.syncSessionModel === undefined ? {}
          : { syncSessionModel: (id: string, m: string, effort?: string) => this.deps.syncSessionModel?.(id, m, effort) }),
        ...(this.deps.refreshQuota === undefined ? {} : { refreshQuota: this.deps.refreshQuota }),  // #125 heal
      },
      cfg,
      model,
      isAux,
      allowAuxModelFallback: isCompaction || isTitle,
      sessionKey,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
      ...(options.agyQuotaModel === undefined ? {} : { quotaModel: options.agyQuotaModel }),
      ...(options.agyAvoidAccountIds === undefined ? {} : { avoidAccountIds: options.agyAvoidAccountIds }),
    })
    const account = selection.account
    let family = selection.family
    let activeModel = selection.activeModel
    // The account is final here: record it as *the* in-use account for Google
    // (or bootstrap when none is set) without hijacking it on Argon/Claude/GPT turns.
    if (account && !isAux) this.deps.pool?.markAccountActive(account.id, family)
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
      bridgeServer: lease?.serverName,
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
        deliverContext: (digest: string, key: string, extraAddDirs: string[], opts?: import('../provider/context-delivery.ts').DeliverContextOptions) =>
          deliverContext(digest, key, extraAddDirs, cfg, opts),
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
      const runLive = liveRun !== undefined && !liveRun.isSettled && !liveRun.isAbortRequested
      // Compare the CANONICAL prompt: the interruption notice injected below is transport metadata
      // and used to poison the stored baseline, so continuation replays used to look like steers.
      // (issue #205).
      const identity = promptIdentity(prompt)
      // A harness lifecycle hop (tool result / context append, no new typed
      // turn) is never a steer: it is a continuation of the live run. Treat it
      // as the same request so the rescue below resumes the cut span instead of
      // aborting the run that produced it (issue #205).
      const lifecycleHop = !hasNewHumanTask(messages)
      const samePrompt = prevPrompt !== undefined && (prevPrompt.prompt === identity || lifecycleHop)
      if (runLive && samePrompt) {
        // Rescue an identical prompt if the live run already cut a span instead of failing BUSY.
        const rescueFrom = liveRun.lastCutIndex !== null ? liveRun.lastCutIndex + 1 : null
        if (rescueFrom !== null) {
          this.deps.log?.(
            (lifecycleHop ? 'lifecycle-continuation rescue: no new human turn for live agy run ' : 'duplicate-debounce rescue: identical prompt for a live agy run ')
              + liveRun.runId + ' — re-driving from event ' + rescueFrom + ' instead of throwing BUSY',
          )
          this.activeSessionPrompts.set(sessionKey, { prompt: identity, startedAt: now, inFlight: true })
          lease?.resume()
          yield* driveSpanImpl(this.deps, liveRun, rescueFrom, policy.mirrorTools && hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal, undefined, false, sessionKey)
          return
        }
        throw new LlmError(
          lifecycleHop
            ? 'Duplicate request ignored: a harness continuation arrived while the same request is still running for this session.'
            : 'Duplicate request ignored: an identical request is already running for this session.',
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
        // Wait briefly if a result was already emitted before preempting leftover shutdown;
        // only genuinely interrupted runs mark the binding or inject the warning banner.
        if (liveRun.hasResult) {
          const exited = await waitForRunSettle(liveRun, 1_500)
          if (!exited) this.deps.log?.('previous agy run did not exit within 1.5s after producing its result — preempting it')
        }
        const wasConsumable = liveRun.hasConsumableResult
        if (!liveRun.isSettled) {
          const liveCid = (liveRun.accountHome ?? '') === (account?.dir ?? '') ? liveRun.conversationId : null
          if (!wasConsumable) {
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
          }
          liveRun.markAbortRequested()
          liveRun.requestAbort?.()
          const exited = await waitForRunSettle(liveRun, 3_500)
          if (!exited) {
            this.warnOnce(
              'settle-timeout:' + sessionKey,
              'the preempted agy run did not exit within 3.5s — starting the replacement anyway; its late write-back is ignored because the newer run owns the session',
            )
          }
          if (!wasConsumable && !prompt.includes(INTERRUPTION_NOTICE)) {
            const slash = extractLeadingAgySlash(prompt)
            prompt = slash ? formatWithLeadingAgySlash(slash, INTERRUPTION_NOTICE) : `${INTERRUPTION_NOTICE}\n\n${prompt}`
          }
        }
      }
      if (liveRun !== undefined && !liveRun.isSettled && liveRun.isAbortRequested) await waitForRunSettle(liveRun, 1_500)
      this.activeSessionPrompts.set(sessionKey, { prompt: identity, startedAt: now, inFlight: true })
    }

    // Dispatch to attempt-outcome.ts. Inject private state callbacks so adapter owns activeRuns/failover.
    if (!isAux && sessionKey !== '') {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user') as { source?: { kind?: unknown; form?: unknown } } | undefined
      const isWakeNotice = isAgyLinkNoticeSource(lastUser?.source)
      if (!isWakeNotice) this.deps.backgroundObserver?.onHumanTurn?.(sessionKey)
      this.deps.backgroundObserver?.onAttemptStart?.(sessionKey)
    }
    const attemptDeps: AttemptDeps = {
      acquire: (signal?: AbortSignal) => this.deps.acquire(signal),
      pool: this.deps.pool,
      runs: this.deps.runs,
      store: this.deps.store,
      log: this.deps.log,
      onParser: this.deps.onParser,
      onRun: this.deps.onRun,
      ...(this.deps.onAccountUsed === undefined ? {} : { onAccountUsed: this.deps.onAccountUsed }),
      ...(this.deps.ensureFreshToken === undefined ? {} : { ensureFreshToken: this.deps.ensureFreshToken }),
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
      spawnLimiter: this.spawnLimiter,
      ...(this.deps.runAcp === undefined ? {} : { runAcp: this.deps.runAcp }),
      ...(this.deps.agyVersion === undefined ? {} : { agyVersion: this.deps.agyVersion }),
      ...(this.deps.backgroundObserver === undefined ? {} : { backgroundObserver: this.deps.backgroundObserver }),
      ...(this.deps.appendAcpNotice === undefined ? {} : { appendAcpNotice: this.deps.appendAcpNotice }),
      ...(this.deps.noteAcpReport === undefined ? {} : { noteAcpReport: this.deps.noteAcpReport }),
      ...(this.deps.reinstallCredentialSlot === undefined ? {} : { reinstallCredentialSlot: this.deps.reinstallCredentialSlot }),
    }
    const attemptInput: AttemptInput = {
      bridgeRoute: lease?.bind(JSON.stringify([account?.id, permissionMode, options.agyTransport ?? cfg.transport, options.agySandbox ?? cfg.sandbox, options.agyAgent ?? cfg.agent, cfg.mcpBridgeScope, cfg.mcpToolAllowlist])),
      cfg,
      bin,
      permissionMode: agyPermissionMode,
      sessionKey,
      workspaceRoot,
      isAux,
      isBackgroundAux: isCompaction || isTitle || isReview,
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
      ...(plan.stagedImages.length > 0 ? { stagedImages: plan.stagedImages } : {}),
      sessionAccountKey,
      family,
      signal: options.signal,
      agyOnEvent: options.agyOnEvent,
      ...(options.agyQuotaModel === undefined ? {} : { quotaModel: options.agyQuotaModel }),
      ...(options.agyAvoidAccountIds === undefined ? {} : { avoidAccountIds: options.agyAvoidAccountIds }),
      ...resolveAttemptOverrides(options, cfg),
    }
    const rec = yield* runAgyAttempt(attemptDeps, attemptInput)

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
    yield* driveSpanImpl(this.deps, rec, 0, policy.mirrorTools && hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal, compactionNotice, false, sessionKey)
  }
}
