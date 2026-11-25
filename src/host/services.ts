// Shared host services for dsh-agy-link.
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../common/atomic-write.ts'
import { dshHome, overridesPath, readOverrides, resolveConfig, stateDir } from '../common/config.ts'
import { PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import { BridgeSteps, enterHostStep } from './bridge-steps.ts'
import { AgyAdapter } from './adapter.ts'
import { AuthHelper } from './auth.ts'
import { TranslationService, TRANSLATION_RECORD_TYPE, type TranslationRecord } from './translate.ts'
import { TranslationWorkerPool } from '../features/translation/worker.ts'
import { ModelCatalog } from './models.ts'
import { RunRegistry } from './recording.ts'
import { resolveAgyBin, probeProcess, isolatedHomeEnv, parseVersion } from './runner.ts'
import { supportsSshIsolation } from '../runtime/agy/env.ts'
import { SessionStore } from './sessions.ts'
import { AccountPoolManager } from './pool.ts'
import { AccountQuotaRefresher } from '../features/quota/freshness.ts'
import { PoolAuthFlow } from './pool-auth.ts'
import { QuotaService } from './quota.ts'
import { createEffortUnsupportedStore } from './effort-unsupported-store.ts'
import { WarmupService } from './warmup.ts'
import { detectSystemProxy } from './wincred.ts'
import { buildAgyEnv } from '../runtime/net/account-env.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir } from './media.ts'
import { ImageService, runViaAdapter } from './image.ts'
import { EcosystemService } from '../features/ecosystem/index.ts'
import { AcpSessionPool, runAcpAttempt } from '../features/acp/index.ts'
import { createPoolQuotaHooks } from '../provider/quota-failover.ts'
import { PREFERRED_IMAGE_QUOTA_MODEL } from '../common/model-lineup.ts'
import { BackgroundWakeWatcher, type AgentLike } from '../features/background/watcher.ts'
import { agyMcpConfigPath, mcpServerKey, registerBridgeMcpConfig, type BridgeRegistryState } from './mcp-bridge.ts'
import { readAccountCredential } from './credential-backup.ts'
import { acquireCredentialSlot, readPrimaryCredential, recoverPrimaryCredential, reinstallCredential } from './credential-slot.ts'
import { buildCliQuotaDeps } from './quota-cli-deps.ts'
import { ACP_REPORT_RECORD_TYPE, createSessionRecords } from './session-records.ts'
import {
  Semaphore,
  createBtwServiceForHost,
  createForcedPlanGuard,
  findSessionLogFile,
  readSessionImage,
  resolveSessionGoal,
  resolveSessionPendingModel,
  resolveSessionPlanMode,
  runTranslationStream,
  syncSessionModelSelection,
} from './service-helpers.ts'

function safeCtxGet<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name as never) as T | undefined
  } catch {
    return undefined
  }
}

export function createHostServices(ctx: Context, entryConfig: Record<string, unknown> = {}) {
  const tag = '[dsh-agy-link] '
  const log = (msg: string) => {
    const logger = (ctx as unknown as { logger?: { info?: (m: string) => void } }).logger
    logger?.info?.(tag + msg)
  }

  let binCache: string | null | undefined = undefined
  let versionCache: string | null = null
  let dormantReason: string | null = null
  let lastRun: {
    processOk: boolean
    processCode: string
    toolErrors: readonly string[]
    durationMs: number
    model: string
    tokenSpeed: { lastTps: number | null; avgTps: number | null; outputTokens: number; measuredSteps: number; generatingMs: number }
  } | null = null
  let lastParser = new StreamJsonParser()
  const getConfig = (): PluginConfig => resolveConfig(entryConfig)

  const notifyPicker = (): void => {
    try {
      ;(ctx.emit as (event: string, ...args: unknown[]) => void)('llm/models-updated', PROVIDER_ID)
    } catch {
      // Host without the event — fall through to adapters-updated.
    }
    try {
      ctx.emit('llm/adapters-updated')
    } catch {
      // Host without the event — the picker simply stays on its snapshot.
    }
  }

  const bin = (): string | null => {
    if (binCache === undefined || binCache === null) binCache = resolveAgyBin(getConfig())
    return binCache
  }
  const version = () => versionCache
  // One `agy --version` probe shared by the boot probe and lease acquisition
  // (a lease must never guess whether SSH isolation applies). A failed probe
  // rejects and is retried by the next caller.
  let versionProbe: Promise<string | null> | null = null
  const resolveVersion = (): Promise<string | null> => {
    if (versionCache !== null) return Promise.resolve(versionCache)
    const b = bin()
    if (!b) return Promise.resolve(null)
    versionProbe ??= probeProcess(b, ['--version'], 10_000, undefined, undefined, getConfig().suppressAgyAutoUpdate)
      .then((v) => (versionCache = parseVersion(v.stdout)))
      .finally(() => { versionProbe = null })
    return versionProbe
  }
  const store = new SessionStore(join(stateDir(), 'sessions.json'))
  const pool = new AccountPoolManager()
  for (const account of pool.getAccounts()) {
    if (account.dir && !account.systemHome) {
      readAccountCredential(join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), log)
    }
  }
  const quota = new QuotaService(
    pool,
    () => getConfig().proxyUrl || detectSystemProxy() || '',
    version,
    // On Windows the CLI reads Credential Manager, so a token refreshed for the
    // safety window has to land in the slot too — QuotaService already holds
    // credentialSlotMutex for this read. Other platforms have no slot: agy reads
    // the token document itself, which the refresh just rewrote.
    buildCliQuotaDeps({
      bin: () => bin(),
      viaCli: () => getConfig().quotaViaCli,
      preemptAutoUpdate: () => getConfig().suppressAgyAutoUpdate,
      poolDir: () => pool.dir,
      respectExternalSignIn: () => getConfig().respectExternalSignIn,
      log,
    }),
  )
  // Keep the account actually in use fresh. `recordSuccess`/a switch fires
  // `onAccountUsed`; we refresh just that account (throttled) instead of waiting
  // for the next full sweep, so the panel reflects real consumption within
  // minutes. Fire-and-forget: a quota probe must never delay or fail a turn.
  const quotaRefresher = new AccountQuotaRefresher(
    async (accountId) => { const acc = pool.getAccount(accountId); if (acc !== undefined) await quota.refreshAccountQuota(acc, false) },
    undefined, undefined, { isBusy: () => adapter !== undefined && adapter.activeRunCount() > 0 },
  )
  const semaphore = new Semaphore(() => getConfig().maxConcurrent)

  const getDiscoveryEnv = (account?: ManagedAccount): NodeJS.ProcessEnv => {
    const env = buildAgyEnv({
      ...(account === undefined ? {} : { account }),
      cfg: getConfig(),
      telemetryFlags: true,
    })
    // Prevent a user's AI Studio API key in shell env from polluting `agy models`
    // subscription model discovery.
    delete env.GEMINI_API_KEY
    delete env.GOOGLE_API_KEY
    return env
  }

  const effortStore = createEffortUnsupportedStore({ stateDir, notifyPicker, log })

  // Constructed after `effortStore` so the probe can honour (and extend) the
  // learned `--effort` refusal list: agy rejects the whole invocation when the
  // flag is not valid for a model, and a warmup that never learns will fail for
  // that family forever (observed on claude-sonnet-5-5, 2026-11-23).
  const warmup = new WarmupService(
    pool,
    quota,
    () => getConfig().proxyUrl || detectSystemProxy() || '',
    version,
    getConfig,
    log,
    undefined,
    {
      bin: () => bin(),
      effortUnsupported: () => effortStore.read(),
      onEffortUnsupported: (model) => effortStore.remember(model),
    },
  )

  const sessionWorkspace = (sessionId: string): string | undefined => {
    const sessions = ctx.get('sessions') as { get(id: unknown): { header?: { cwd?: string } } | undefined } | undefined
    return sessions?.get(sessionId)?.header?.cwd
  }

  type SessionLike = {
    id?: string
    log?: readonly { type: string; seq?: number; data?: unknown }[]
    events?: readonly { type: string; seq?: number; data?: unknown }[]
    snapshotEvents?: (fromSeq?: unknown, toSeqExclusive?: unknown) => readonly { type: string; seq?: number; data?: unknown }[]
    ownEvents?: () => readonly { type: string; seq?: number; data?: unknown }[]
    append?: (type: string, data: unknown) => { seq?: number } | number
    header?: { cwd?: string }
  }
  type SessionsServiceLike = { get(id: unknown): SessionLike | undefined }
  const sessionsSvc = (): SessionsServiceLike | undefined =>
    (ctx.get('sessions') as SessionsServiceLike | undefined) ?? ((ctx as unknown as { sessions?: SessionsServiceLike }).sessions)
  const sessionAuto = new Map<string, boolean>()

  const { appendRecordTo, appendPluginRecordTo, appendAcpNotice } = createSessionRecords({
    session: (id) => sessionsSvc()?.get(id),
    log,
  })

  const status = {
    get version(): string | null { return versionCache },
    set version(v: string | null) { versionCache = v },
    get dormantReason(): string | null { return dormantReason },
    set dormantReason(v: string | null) { dormantReason = v },
  }

  const catalog = new ModelCatalog(
    async (signal, accountId) => {
      const b = bin()
      if (!b) throw new Error('agy binary not found')
      const poolData = pool.getPoolData()
      let candidateAccount: ManagedAccount | undefined
      if (accountId) {
        const targetAcc = pool.getAccount(accountId)
        if (!targetAcc || !targetAcc.enabled || targetAcc.authRequired) {
          throw new Error(`account ${accountId} is unavailable for model discovery`)
        }
        candidateAccount = targetAcc
      } else {
        const pickEnabled = (id?: string): ManagedAccount | undefined => {
          if (!id) return undefined
          const acc = pool.getAccount(id)
          return acc && acc.enabled && !acc.authRequired ? acc : undefined
        }
        candidateAccount =
          pickEnabled(pool.getActiveAccountId('google'))
          ?? pickEnabled(poolData.lastActiveAccountId)
          ?? pickEnabled(poolData.primaryAccountId)
          ?? pool.getAccounts().find((a) => a.enabled && !a.authRequired)
        if (!candidateAccount && pool.getAccounts().length > 0) {
          throw new Error('no enabled account available for model discovery')
        }
      }

      const probeModelsFor = async (acc: ManagedAccount | undefined) => {
        const needsWinSlot =
          process.platform === 'win32'
          && process.env.NODE_TEST_CONTEXT === undefined
          && Boolean(acc && acc.dir && !acc.systemHome)
          && !supportsSshIsolation(version())
        const lease = needsWinSlot
          ? await acquireCredentialSlot(acc, pool, {
              baseDir: pool.dir,
              proxyUrl: acc?.proxyUrl || getConfig().proxyUrl || detectSystemProxy() || undefined,
              log,
              signal,
              dispatchTimeoutMs: 8_000,
              parallel: getConfig().parallelSameAccount,
              respectExternalSignIn: getConfig().respectExternalSignIn,
            })
          : undefined
        try {
          return await probeProcess(b, ['models'], 30_000, signal, getDiscoveryEnv(acc), getConfig().suppressAgyAutoUpdate)
        } finally {
          lease?.release()
        }
      }

      let probedAccount = candidateAccount
      let out = await probeModelsFor(candidateAccount)
      if (
        !accountId
        && (out.code !== 0 || out.stdout.includes('Please sign in') || /sign in|auth|not logged in/i.test(out.stderrTail))
        && (!candidateAccount || !candidateAccount.dir)
      ) {
        const secondary = pool.getAccounts().find((a) => a.enabled && !a.authRequired && a.dir)
        if (secondary) {
          const secondaryOut = await probeModelsFor(secondary)
          if (secondaryOut.code === 0 && secondaryOut.stdout.trim() !== '') {
            out = secondaryOut
            probedAccount = secondary
          }
        }
      }
      if (out.code !== 0 && out.stdout.trim() === '') {
        throw new Error('agy models failed: ' + (out.stderrTail.trim() !== '' ? out.stderrTail.trim().slice(-200) : 'exit ' + String(out.code)))
      }
      return {
        stdout: out.stdout,
        stderr: out.stderrTail,
        ...(probedAccount ? { accountId: probedAccount.id } : {}),
      }
    },
    getConfig().fallbackModels,
    getConfig().modelsCacheTtlMs,
    notifyPicker,
    {
      cacheFile: join(stateDir(), 'model-catalog.json'),
      agyVersion: version,
    },
  )

  pool.setCatalog(catalog)
  pool.onAccountSwitch = (newActiveId: string) => {
    if (process.platform === 'win32' && !supportsSshIsolation(version())) {
      acpPool.evictOtherAccounts(newActiveId)
    }
    notifyPicker()
    void catalog.forceRefreshAndNotify(newActiveId).catch(() => undefined)
  }

  const bridgeSteps = new BridgeSteps()
  const bridgeState: BridgeRegistryState = { bridge: null, restores: [], log }
  const ecosystem = new EcosystemService({ pool, getConfig, log })
  const auth = new AuthHelper(bin, () => getConfig().suppressAgyAutoUpdate)
  const poolAuth = new PoolAuthFlow(pool, quota, log, {
    onUpdate: () => {
      notifyPicker()
      const activeId = pool.getActiveAccountId('google')
      if (activeId) void catalog.forceRefreshAndNotify(activeId).catch(() => undefined)
    },
    onIsolatedAccountCommitted: (acc) => {
      if (getConfig().syncAccountCustomizations) {
        ecosystem.syncAccount(acc)
      }
      if (bridgeState.bridge !== null && acc.dir) {
        const cfg = getConfig()
        if (cfg.mcpConfigScope === 'global' || cfg.mcpConfigScope === 'both') {
          registerBridgeMcpConfig(bridgeState, agyMcpConfigPath('', isolatedHomeEnv(acc.dir)))
        }
      }
    },
  })
  const runs = new RunRegistry()
  const webServerPort: { current?: number } = {}
  // Gate 3: an account switch (or a crashed secondary) can leave the machine-wide
  // Windows credential slot holding another account's login. Once no run holds it
  // any more, put the primary back — otherwise the user's next turn silently
  // authenticates as someone else and spends their quota.
  let restoringSlot = false
  const restorePrimarySlot = async (trigger: string): Promise<void> => {
    if (restoringSlot || process.platform !== 'win32') return
    restoringSlot = true
    try {
      const res = await recoverPrimaryCredential(pool, {
        baseDir: pool.dir,
        log,
        respectExternalSignIn: getConfig().respectExternalSignIn,
        ...(getConfig().proxyUrl?.trim() ? { proxyUrl: getConfig().proxyUrl.trim() } : {}),
      })
      if (res.reason === 'restored') {
        acpPool.noteSlotRecovery()
        log('[agy-link] restored the primary credential in the Windows slot (' + trigger + ')')
      }
    } catch (e) {
      log('credential slot recovery failed (' + trigger + '): ' + String(e))
    } finally {
      restoringSlot = false
    }
  }
  const acpPool = new AcpSessionPool({
    bin,
    cfg: getConfig,
    log,
    // A drained process that ran out of budget is killed mid-flight; say so in
    // the conversation instead of letting the background task vanish silently.
    onDrainExpired: (info) => {
      // Only the deadline branch speaks: a drain that ends on its own is the
      // normal path, and warning about it would be a false alarm. The target's
      // sessionKey is the DSH session (info.sessions holds agy's UUIDs, which
      // the transcript service cannot resolve).
      for (const target of info.targets) {
        appendAcpNotice(target.sessionKey, {
          kind: 'acp-drain-aborted',
          text: '因账号切换，旧账号上仍在运行的后台任务已被中止。\nBackground tasks on the previous account were stopped because the credential slot switched accounts.',
        })
      }
    },
    // Gate 3: once the last process of the OLD account is gone, nothing else can
    // legitimately own the machine-wide slot — put the primary back so the next
    // interactive turn authenticates as the user's own account.
    onDrainClosed: () => {
      void restorePrimarySlot('drain-closed')
    },
    onIdle: () => {
      void restorePrimarySlot('idle')
    },
  })
  let adapter!: AgyAdapter
  const forcedPlan = createForcedPlanGuard()
  const backgroundWakeup = new BackgroundWakeWatcher({
    getConfig,
    log,
    getActiveRun: (sessionId) => adapter.getActiveRun(sessionId),
    retainAcpSession: (sid, sessionKey) => acpPool.retainSession(sid, sessionKey),
    isArchived: (sessionId) => {
      try {
        const reg = safeCtxGet<{ archivedSessionIds?: Iterable<string> | { has?: (id: string) => boolean } }>(ctx, 'workspaceRegistry')
        const archived = reg?.archivedSessionIds
        if (!archived) return false
        if (typeof (archived as { has?: (id: string) => boolean }).has === 'function') {
          return (archived as { has: (id: string) => boolean }).has(sessionId)
        }
        for (const id of archived as Iterable<string>) {
          if (id === sessionId) return true
        }
      } catch {
        // ignore optional workspaceRegistry errors
      }
      return false
    },
    resolveAgent: async (sessionId) => {
      try {
        const agents = safeCtxGet<{ get?: (id: unknown) => unknown }>(ctx, 'agents')
        const live = agents?.get?.(sessionId) as AgentLike | undefined
        if (live && typeof live.followup === 'function') return live
        const ctrl = safeCtxGet<{
          resolveAgent?: (id: string) => Promise<{ agent?: AgentLike } | null | undefined>
        }>(ctx, 'sessionController')
        if (ctrl && typeof ctrl.resolveAgent === 'function') {
          const res = await ctrl.resolveAgent(sessionId)
          if (res && typeof res === 'object' && res.agent && typeof res.agent.followup === 'function') {
            return res.agent
          }
        }
      } catch (err) {
        log('background-wakeup resolveAgent error: ' + String(err))
      }
      return null
    },
    // 方案 A: the ACP turn already produced its own report; write it straight
    // into the transcript so no model turn is spent repeating it.
    presentAcpReport: async (sessionId, text) => {
      const seq = await appendPluginRecordTo(sessionId, ACP_REPORT_RECORD_TYPE, { text, at: Date.now() })
      // The seq travels back to the watcher, which uses it to recognise the same
      // narration when agy also writes it to .system_generated/messages.
      return seq === null ? false : seq
    },
    hasArmedGoal: (sessionId) => resolveSessionGoal(ctx, sessionId) != null,
  })

  let mirrorToolCheck: ((sessionId?: string) => boolean) | undefined = undefined

  adapter = new AgyAdapter({
    enterBridgeStep: options => bridgeState.bridge ? enterHostStep(ctx, bridgeSteps, options, mcpServerKey(bridgeState.bridge.port)) : undefined,
    getConfig,
    catalog,
    store,
    pool,
    bin,
    acquire: (signal) => semaphore.acquire(signal),
    log,
    runs,
    isMirrorToolAvailable: (sessionId) => (mirrorToolCheck ? mirrorToolCheck(sessionId) : true),
    getMediaBaseUrl: () => (webServerPort.current ? `http://127.0.0.1:${webServerPort.current}/plugins/agy-link/media` : null),
    // Non-forced: honours per-account cooldowns so a heal cannot stampede the
    // pool. Catalog re-discovery repairs `agy models` in the same pass.
    onAccountUsed: (accountId) => { quotaRefresher.trigger(accountId) },
    ensureFreshToken: (acc) => quota.getValidAccessToken(acc).then((t) => t !== null).catch(() => false),
    refreshQuota: async () => {
      await quota.refreshAllQuotas(false).catch(() => undefined)
      await catalog.forceRefreshAndNotify().catch(() => undefined)
      await catalog.warmAccounts(pool.getAccounts()).catch(() => undefined)
    },
    effortUnsupported: () => effortStore.read(),
    onEffortUnsupported: (model) => effortStore.remember(model),
    sessionCwd: (sessionId) => sessionWorkspace(sessionId),
    sessionGoal: (sessionId) => resolveSessionGoal(ctx, sessionId),
    sessionPlanMode: (sessionId) => resolveSessionPlanMode(ctx, sessionId),
    consumeForcedPlanMode: forcedPlan.consume,
    sessionPendingModel: (sessionId) => resolveSessionPendingModel(ctx, sessionId),
    syncSessionModel: (sessionId, model, effort) => syncSessionModelSelection(ctx, sessionId, model, effort),
    onRun: (info) => { lastRun = info },
    onParser: (p) => { lastParser = p },
    readImage: (ref) => readSessionImage(ctx, dshHome(), ref),
    runAcp: (attemptDeps, attemptInput, slot) => runAcpAttempt(acpPool, attemptDeps, attemptInput, slot),
    agyVersion: version,
    backgroundObserver: backgroundWakeup,
    appendAcpNotice,
    noteAcpReport: (sessionKey, text, seq) => backgroundWakeup.noteAcpReport(sessionKey, text, seq),
    // Gate 2 recovery: agy proved it loaded a different account than the one we
    // dispatched, so the slot must be rewritten before the single retry.
    reinstallCredentialSlot: (account) => {
      if (process.platform !== 'win32') return false
      // The primary has no isolated dir: its token lives in the durable primary
      // store, so read that instead. Falling through to null here used to make
      // the whole gate-2 self-heal a no-op for the user's own account.
      const raw =
        account.systemHome || !account.dir
          ? (readPrimaryCredential(pool.dir)?.raw ?? null)
          : readAccountCredential(join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), log)
      if (raw === null || raw === '') return false
      const ok = reinstallCredential(raw, { baseDir: pool.dir, log }, account.alias || account.id)
      if (ok) acpPool.noteSlotOverwrite()
      return ok
    },
  })

  const translationWorkers = new TranslationWorkerPool({
    cfg: getConfig,
    bin,
    pool,
    log,
    isEffortUnsupported: (model) => effortStore.read().includes(model),
    rememberEffortUnsupported: (model) => {
      if (catalog.advertisedEfforts(model).length === 0) {
        effortStore.remember(model)
        notifyPicker()
      }
    },
  })

  const quotaHooks = createPoolQuotaHooks(pool)

  const translation = new TranslationService({
    cfg: getConfig,
    catalog: () => catalog.get(),
    getSession: (id) => sessionsSvc()?.get(id),
    autoEnabled: (id) => sessionAuto.get(id) ?? getConfig().autoTranslate,
    sessionCwd: (id) => sessionWorkspace(id),
    sessionLogPath: (id) => findSessionLogFile(dshHome(), id),
    poolQuotaHops: quotaHooks.poolQuotaHops,
    log,
    run: (req) => runTranslationStream(ctx, getConfig, log, req, translationWorkers),
    appendRecord: (sessionId, record: TranslationRecord) =>
      appendRecordTo(sessionId, TRANSLATION_RECORD_TYPE, record, 'persist translation record'),
  })

  const setOverride = (key: string, value: unknown): void => {
    binCache = undefined
    const file = overridesPath()
    const current = readOverrides(file)
    if (key in current && JSON.stringify(current[key]) === JSON.stringify(value)) return
    current[key] = value
    try {
      writeFileAtomicSync(file, JSON.stringify(current, null, 2))
    } catch (e) {
      log('failed to persist override: ' + String(e))
    }
  }

  const mediaDir = (): string => {
    const cfg = getConfig()
    return cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
  }

  const activeCwds = (): string[] => {
    const list: string[] = []
    try {
      // DSH's session store exposes `list()`; `values()` never existed on it, so
      // asserting it here produced an always-empty whitelist and every open/media
      // request for a session workspace was refused (issue #139). Keep `values()`
      // as a fallback for hosts that only publish that shape.
      const svc = sessionsSvc() as unknown as
        | { list?: () => Iterable<SessionLike>; values?: () => Iterable<SessionLike> }
        | undefined
      const source = typeof svc?.list === 'function' ? svc.list() : typeof svc?.values === 'function' ? svc.values() : []
      for (const s of source) {
        const cwd = s?.header?.cwd
        if (cwd && !list.includes(cwd)) list.push(cwd)
      }
    } catch {
      // ignore
    }
    return list
  }

  const imageService = new ImageService({
    cfg: getConfig,
    bin,
    run: (call) => runViaAdapter(adapter, call),
    catalog: () => catalog.get(),
    ...quotaHooks,
    // Prefer the advertised image model, fall back to the one agy 1.5.x ships.
    imageQuotaModel: () =>
      catalog.get().models.find((m) => /image/i.test(m.id))?.id ?? PREFERRED_IMAGE_QUOTA_MODEL,
    log,
  })

  const btw = createBtwServiceForHost({
    cfg: getConfig, bin, pool, catalog, semaphore, log,
    effortUnsupported: () => effortStore.read(),
    onEffortUnsupported: (model) => effortStore.remember(model),
    sessions: sessionsSvc,
    activeRun: (id) => adapter.activeRun(id),
  })

  return {
    getConfig, log, notifyPicker, bin, version, resolveVersion, status, store, pool, quota, warmup, semaphore,
    catalog, auth, poolAuth, runs, adapter, acpPool, backgroundWakeup, ecosystem, imageService, translation, translationWorkers, btw, setOverride, armForcedPlan: forcedPlan.arm,
    readEffortUnsupported: effortStore.read,
    rememberEffortUnsupported: effortStore.remember,
    sessionsSvc, sessionAuto,
    get lastRun() { return lastRun },
    get lastParser() { return lastParser },
    mediaDir, bridgeState, bridgeSteps, webServerPort, activeCwds,
    hostDir: '',
    setMirrorToolCheck: (fn: (sessionId?: string) => boolean): void => { mirrorToolCheck = fn },
    onConfigWritten: (_key: string, _value: unknown): void => undefined,
  }
}

export type HostServices = ReturnType<typeof createHostServices>
