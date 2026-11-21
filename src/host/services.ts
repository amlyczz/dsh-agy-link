// Shared host services for dsh-agy-link.
//
// Constructs config/log/bin/version, session store, pool, quota, warmup, model
// catalog, adapter, translation, override writer and live boot status. Session
// & translation runtime helpers live in ./service-helpers.ts.
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { writeFileAtomicSync } from '../common/atomic-write.ts'
import { dshHome, overridesPath, readOverrides, resolveConfig, stateDir } from '../common/config.ts'
import { PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import { AgyAdapter } from './adapter.ts'
import { AuthHelper } from './auth.ts'
import { TranslationService, TRANSLATION_RECORD_TYPE, type TranslationRecord } from './translate.ts'
import { TranslationWorkerPool } from '../features/translation/worker.ts'
import { ModelCatalog } from './models.ts'
import { RunRegistry } from './recording.ts'
import { resolveAgyBin, probeProcess, isolatedHomeEnv } from './runner.ts'
import { SessionStore } from './sessions.ts'
import { AccountPoolManager } from './pool.ts'
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
import { agyMcpConfigPath, registerBridgeMcpConfig, type McpBridge } from './mcp-bridge.ts'
import { readAccountCredential } from './credential-backup.ts'
import { acquireCredentialSlot } from './credential-slot.ts'
import {
  Semaphore,
  findSessionLogFile,
  readSessionImage,
  resolveSessionGoal,
  resolveSessionPlanMode,
  runTranslationStream,
  syncSessionModelSelection,
} from './service-helpers.ts'

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
    {
      bin: () => bin(),
      viaCli: () => getConfig().quotaViaCli,
      preemptAutoUpdate: () => getConfig().suppressAgyAutoUpdate,
    },
  )
  const warmup = new WarmupService(
    pool,
    quota,
    () => getConfig().proxyUrl || detectSystemProxy() || '',
    version,
    getConfig,
    log,
    undefined,
    { bin: () => bin() },
  )
  const semaphore = new Semaphore(() => getConfig().maxConcurrent)

  const getDiscoveryEnv = (account?: ManagedAccount): NodeJS.ProcessEnv =>
    buildAgyEnv({
      ...(account === undefined ? {} : { account }),
      cfg: getConfig(),
      telemetryFlags: true,
    })

  const effortStore = createEffortUnsupportedStore({ stateDir, notifyPicker, log })

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

  type AppendPluginRecord = (session: unknown, type: string, data: unknown) => number
  let appendPluginRecordPromise: Promise<AppendPluginRecord | null> | null = null
  const loadAppendPluginRecord = (): Promise<AppendPluginRecord | null> => {
    if (appendPluginRecordPromise === null) {
      appendPluginRecordPromise = (async () => {
        try {
          const spec = '@deepseek-ai/dsh-session'
          const mod = (await import(spec)) as { appendPluginRecord?: AppendPluginRecord }
          return typeof mod.appendPluginRecord === 'function' ? mod.appendPluginRecord : null
        } catch (e) {
          log('translation records unavailable: ' + String(e))
          return null
        }
      })()
    }
    return appendPluginRecordPromise
  }

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
        const lease = needsWinSlot
          ? await acquireCredentialSlot(acc, pool, {
              baseDir: pool.dir,
              proxyUrl: acc?.proxyUrl || getConfig().proxyUrl || detectSystemProxy() || undefined,
              log,
              signal,
              dispatchTimeoutMs: 8_000,
              parallel: getConfig().parallelSameAccount,
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
    if (process.platform === 'win32') acpPool.evictOtherAccounts(newActiveId)
    notifyPicker()
    void catalog.forceRefreshAndNotify(newActiveId).catch(() => undefined)
  }

  const bridgeState: { bridge: McpBridge | null; restores: Array<() => void> } = { bridge: null, restores: [] }
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
  const acpPool = new AcpSessionPool({ bin, cfg: getConfig, log })

  const adapter = new AgyAdapter({
    getConfig,
    catalog,
    store,
    pool,
    bin,
    acquire: (signal) => semaphore.acquire(signal),
    log,
    runs,
    getMediaBaseUrl: () => (webServerPort.current ? `http://127.0.0.1:${webServerPort.current}/plugins/agy-link/media` : null),
    // Non-forced: honours per-account cooldowns so a heal cannot stampede the
    // pool. Catalog re-discovery repairs `agy models` in the same pass.
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
    syncSessionModel: (sessionId, model, effort) => syncSessionModelSelection(ctx, sessionId, model, effort),
    onRun: (info) => { lastRun = info },
    onParser: (p) => { lastParser = p },
    readImage: (ref) => readSessionImage(ctx, dshHome(), ref),
    runAcp: (attemptDeps, attemptInput, slot) => runAcpAttempt(acpPool, attemptDeps, attemptInput, slot),
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

  const translation = new TranslationService({
    cfg: getConfig,
    catalog: () => catalog.get(),
    getSession: (id) => sessionsSvc()?.get(id),
    autoEnabled: (id) => sessionAuto.get(id) ?? getConfig().autoTranslate,
    sessionCwd: (id) => sessionWorkspace(id),
    sessionLogPath: (id) => findSessionLogFile(dshHome(), id),
    log,
    run: (req) => runTranslationStream(ctx, getConfig, log, req, translationWorkers),
    appendRecord: async (sessionId, record: TranslationRecord) => {
      const session = sessionsSvc()?.get(sessionId)
      if (session === undefined) return null
      const append = await loadAppendPluginRecord()
      if (append !== null) {
        try {
          const res = append(session, TRANSLATION_RECORD_TYPE, record)
          if (typeof res === 'number') return res
        } catch (e) {
          log('failed to persist translation record via appendPluginRecord: ' + String(e))
        }
      }
      try {
        if (typeof session.append === 'function') {
          const res = session.append(TRANSLATION_RECORD_TYPE, record)
          if (typeof res === 'number') return res
          if (res !== null && typeof res === 'object' && typeof (res as { seq?: unknown }).seq === 'number') {
            return (res as { seq: number }).seq
          }
          return 0
        }
      } catch (e) {
        log('failed to persist translation record via session.append: ' + String(e))
      }
      return null
    },
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
    log,
  })

  return {
    getConfig, log, notifyPicker, bin, version, status, store, pool, quota, warmup, semaphore,
    catalog, auth, poolAuth, runs, adapter, acpPool, ecosystem, imageService, translation, translationWorkers, setOverride,
    readEffortUnsupported: effortStore.read,
    rememberEffortUnsupported: effortStore.remember,
    sessionsSvc, sessionAuto,
    get lastRun() { return lastRun },
    get lastParser() { return lastParser },
    mediaDir, bridgeState, webServerPort, activeCwds,
    hostDir: '',
    onConfigWritten: (_key: string, _value: unknown): void => undefined,
  }
}

export type HostServices = ReturnType<typeof createHostServices>
