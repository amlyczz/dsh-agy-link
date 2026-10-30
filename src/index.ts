// dsh-agy-link host assembly (spec section 5): dormant-safe detection,
// LlmAdapter registration, /agy commands, agy_ask tool, auth helper, and
// the /plugins/agy-link/* HTTP surface the client half polls. Everything
// registers as cordis effects, so uninstalling the plugin rolls it back
// cleanly.
import type { Context } from '@deepseek-ai/cordis'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dshHome, overridesPath, readOverrides, resolveConfig, stateDir } from './common/config.ts'
import { PLUGIN_ID, PROVIDER_ID, type PluginConfig } from './common/types.ts'
import type { ManagedAccount } from './common/pool-types.ts'
import { AgyAdapter } from './host/adapter.ts'
import { defineAgyAskTool } from './host/ask-tool.ts'
import { AuthHelper } from './host/auth.ts'
import { agyCommandDefinition } from './host/commands.ts'
import { writeDoctorReport } from './host/diagnostics.ts'
import { defineAgyMirrorTool } from './host/mirror-tool.ts'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { ModelCatalog, sanitizeCatalogEntries } from './host/models.ts'
import { RunRegistry } from './host/recording.ts'
import { MIN_AGY_VERSION, compareVersions, ensureIsolatedKeychain, isolatedHomeEnv, openAccountTerminal, parseVersion, probeProcess, proxyEnvFor, purgeStaleIsolatedKeychain, repairMacSystemKeychain, resolveAgyBin } from './host/runner.ts'
import { SessionStore } from './host/sessions.ts'
import { AccountPoolManager } from './host/pool.ts'
import { PoolAuthFlow } from './host/pool-auth.ts'
import { QuotaService } from './host/quota.ts'
import { WarmupService, type WarmupResult } from './host/warmup.ts'
import { detectSystemProxy } from './host/wincred.ts'
import { resolvePrimaryCredential, findDuplicateCredentialIdentities } from './host/credential-slot.ts'
import { homedir } from 'node:os'
import { StreamJsonParser } from './host/parser.ts'
import { defaultMediaDir, sweepDir, type ImageRefLike } from './host/media.ts'
import { agyMcpConfigPath, startMcpBridge, writeMcpConfig, type McpBridge, type ToolsServiceLike } from './host/mcp-bridge.ts'
import { readJsonBody } from './host/read-json-body.ts'
import { fileURLToPath } from 'node:url'
import { handleMediaRequest, handleAssetRequest, type HttpRequestLike, type HttpResponseLike } from './host/media-route.ts'

export const name = 'dsh-agy-link'
// webServer and tools are optional: the plugin loads headless too.
export const inject = ['llm', 'commands']

type StatusWriter = {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: unknown): unknown
};
type RawReq = {
  method?: string
  on(event: string, cb: (chunk: Buffer) => void): unknown
};
type RawRes = StatusWriter;
type WebServerLike = {
  port?: number;
  register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): unknown;
};

function resolveAssetDir(): string {
  const currentDir = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(currentDir, 'assets'),
    join(currentDir, '../assets'),
    join(currentDir, '../../assets'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return join(currentDir, 'assets')
}

/** Cross-session concurrency limiter (ADR-12). max() <= 0 means unlimited. */
class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly max: () => number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error('aborted before semaphore acquisition')
    const limit = this.max()
    if (limit <= 0) {
      // Unlimited: native agy concurrency — Google rate limits and the
      // account pool's cooldowns are the natural regulators.
      this.active++
      return () => this.releaseOne()
    }
    if (this.active < limit) {
      this.active++
      return () => this.releaseOne()
    }
    return new Promise((resolve, reject) => {
      let entry: () => void
      const onAbort = () => {
        const idx = this.queue.indexOf(entry)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(new Error('aborted while waiting for semaphore slot'))
      }
      entry = () => {
        signal?.removeEventListener('abort', onAbort)
        this.active++
        resolve(() => this.releaseOne())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
    })
  }
  private releaseOne(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

export function apply(ctx: Context, entryConfig: Record<string, unknown> = {}): void {
  const tag = '[dsh-agy-link] '
  const log = (msg: string) => {
    const logger = (ctx as unknown as { logger?: { info?: (m: string) => void } }).logger
    logger?.info?.(tag + msg)
  };

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
  // The webview model picker caches its catalog snapshot and only re-reads
  // after the payload-free `llm/adapters-updated` event (consumers re-read
  // the registries instead of receiving state). Emit it whenever picker
  // output can change: hiddenModels writes and async catalog refreshes.
  const notifyPicker = (): void => {
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
  )
  const semaphore = new Semaphore(() => getConfig().maxConcurrent)

  const getDiscoveryEnv = (account?: ManagedAccount): NodeJS.ProcessEnv => {
    const cfg = getConfig()
    return {
      ...process.env,
      ...(cfg.disableTelemetry
        ? {
            DO_NOT_TRACK: '1',
            DISABLE_TELEMETRY: '1',
            GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
            ANTIGRAVITY_DISABLE_TELEMETRY: '1',
          }
        : {}),
      ...(account && account.dir ? isolatedHomeEnv(account.dir) : {}),
      ...proxyEnvFor(account?.proxyUrl || cfg.proxyUrl || detectSystemProxy() || undefined),
    }
  }

  const catalog = new ModelCatalog(
    async (signal, accountId) => {
      const b = bin()
      if (!b) throw new Error('agy binary not found')
      // agy models has no --output-format flag (verified against 1.1.13);
      // it prints a two-column text table. parseModelsOutput handles both.
      const poolData = pool.getPoolData()
      const targetAcc = accountId ? pool.getAccount(accountId) : undefined
      const activeId = pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
      const candidateAccount = (targetAcc && targetAcc.enabled && !targetAcc.authRequired)
        ? targetAcc
        : (activeId ? pool.getAccount(activeId) : undefined)
        ?? (poolData.primaryAccountId ? pool.getAccount(poolData.primaryAccountId) : undefined)
        ?? pool.getAccounts().find((a) => a.enabled && !a.authRequired)

      let out = await probeProcess(b, ['models'], 30_000, signal, getDiscoveryEnv(candidateAccount), getConfig().suppressAgyAutoUpdate)

      // If probe failed or prompted to sign in, and candidate had no dir (system HOME),
      // try secondary accounts with isolated dir if available before giving up.
      if ((out.code !== 0 || out.stdout.includes('Please sign in') || /sign in|auth|not logged in/i.test(out.stderrTail)) && (!candidateAccount || !candidateAccount.dir)) {
        const secondary = pool.getAccounts().find((a) => a.enabled && !a.authRequired && a.dir)
        if (secondary) {
          const secondaryOut = await probeProcess(b, ['models'], 30_000, signal, getDiscoveryEnv(secondary), getConfig().suppressAgyAutoUpdate)
          if (secondaryOut.code === 0 && secondaryOut.stdout.trim() !== '') {
            out = secondaryOut
          }
        }
      }

      if (out.code !== 0 && out.stdout.trim() === '') {
        throw new Error('agy models failed: ' + (out.stderrTail.trim() !== '' ? out.stderrTail.trim().slice(-200) : 'exit ' + String(out.code)))
      }
      return { stdout: out.stdout, stderr: out.stderrTail }
    },
    getConfig().fallbackModels,
    getConfig().modelsCacheTtlMs,
    notifyPicker,
  )
  const auth = new AuthHelper(bin, () => getConfig().suppressAgyAutoUpdate)
  const poolAuth = new PoolAuthFlow(pool, quota, log)
  const runs = new RunRegistry()

  // Boot hygiene: remove staging dirs and purge old historical logs
  try {
    const validAccIds = new Set(pool.getAccounts().map((a) => a.id))
    store.cleanupStaleAccounts(validAccIds)
  } catch {
    // best-effort hygiene
  }
  const swept = pool.sweepStaleStaging()
  if (swept > 0) log('swept ' + swept + ' stale staging dir(s)')
  const logsSwept = pool.sweepOldLogs(getConfig().logRetentionDays)
  if (logsSwept > 0) log('swept ' + logsSwept + ' old log file(s)')
  // Provision per-account login keychains for isolated pool homes (macOS):
  // without one, agy's keyring save pops the system "create login keychain"
  // password dialog on every token refresh. Idempotent; pre-existing homes
  // from older versions are covered here too.
  if (process.platform === 'darwin') {
    try {
      const repaired = repairMacSystemKeychain()
      if (repaired) log('repaired macOS system keychain settings (restored real login keychain)')
    } catch {
      // ignore
    }
  }
  let kcProvisioned = 0
  for (const acc of pool.getAccounts()) {
    if (acc.dir) {
      purgeStaleIsolatedKeychain(acc.dir)
      if (ensureIsolatedKeychain(acc.dir)) kcProvisioned++
    }
  }
  if (kcProvisioned > 0) log('provisioned isolated keychains for ' + kcProvisioned + ' pool account(s)')
  // Windows shares ONE process-global credential slot across every agy
  // process. Establish the durable, identity-verified primary credential that
  // the slot is handed back to, and report pool corruption loudly instead of
  // silently reporting the wrong account's quota.
  if (process.platform === 'win32') {
    void resolvePrimaryCredential(pool, {
      baseDir: pool.dir,
      log,
      proxyUrl: getConfig().proxyUrl || detectSystemProxy(),
    })
      .then((cred) => {
        if (cred) log('primary credential verified' + (cred.email ? ' <' + cred.email + '>' : ''))
      })
      .catch(() => undefined)
    for (const dupe of findDuplicateCredentialIdentities(pool.getAccounts(), homedir())) {
      log(
        'WARNING: accounts share one credential identity (their login was overwritten — sign in again): ' +
          dupe.locations.join(', '),
      )
    }
  }

  const webServerPort: { current?: number } = {}

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
    sessionCwd: (sessionId) => {
      const sessions = ctx.get('sessions') as { get(id: unknown): { header?: { cwd?: string } } | undefined } | undefined
      return sessions?.get(sessionId)?.header?.cwd
    },
    sessionGoal: (sessionId) => {
      try {
        const agents = (ctx.get('agents') as { get(id: unknown): unknown } | undefined)
          ?? (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents
        const goals = (ctx.get('goals') as { get(agent: unknown): { id?: string; revision?: number; phase?: string; activation?: string } | undefined } | undefined)
          ?? (ctx as unknown as { goals?: { get(agent: unknown): { id?: string; revision?: number; phase?: string; activation?: string } | undefined } }).goals
        const agent = agents?.get(sessionId)
        if (agent && goals) {
          const g = goals.get(agent)
          // Only volunteer a completion target for a goal the driver would
          // actually keep driving: active AND armed. A paused or blocked goal
          // is under direct human control — synthesizing update_goal(complete)
          // for it would override the user's explicit pause.
          if (g?.id && g.phase === 'active' && (g.activation === undefined || g.activation === 'armed')) {
            return {
              goalId: g.id,
              revision: typeof g.revision === 'number' ? g.revision : 1,
            }
          }
        }
      } catch {
        // Fallback to inspecting session log below
      }

      type SessionWithEvents = {
        log?: readonly { type: string; data?: unknown }[]
        snapshotEvents?(): readonly { type: string; data?: unknown }[]
        ownEvents?(): readonly { type: string; data?: unknown }[]
        events?: readonly { type: string; data?: unknown }[]
      }
      const sessions = (ctx.get('sessions') as { get(id: unknown): SessionWithEvents | undefined } | undefined)
        ?? (ctx as unknown as { sessions?: { get(id: unknown): SessionWithEvents | undefined } }).sessions
      const session = sessions?.get(sessionId)
      const evs = session?.snapshotEvents?.() ?? session?.ownEvents?.() ?? session?.log ?? session?.events
      if (!evs) return null
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i]
        if (ev?.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
          const d = ev.data as { operation?: string; goal?: { id?: string; revision?: number }; cleared?: { id?: string } }
          if (d.operation === 'clear') return null
          if (d.goal?.id) {
            return {
              goalId: d.goal.id,
              revision: typeof d.goal.revision === 'number' ? d.goal.revision : 1,
            }
          }
        }
      }
      return null
    },
    syncSessionModel: (sessionId, model, effort) => {
      if (!sessionId) return
      try {
        const sessions = (ctx.get('sessions') as { get(id: unknown): { append?: (type: string, data: unknown) => unknown } } | undefined)
          ?? (ctx as unknown as { sessions?: { get(id: unknown): { append?: (type: string, data: unknown) => unknown } } }).sessions
        const session = sessions?.get(sessionId)
        if (session && typeof session.append === 'function') {
          session.append('model/selection', {
            provider: PROVIDER_ID,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
          })
        }
      } catch {
        // safe containment
      }

      try {
        const agents = (ctx.get('agents') as { get(id: unknown): unknown; selectForNextRequest?: (a: unknown, s: unknown) => void } | undefined)
          ?? (ctx as unknown as { agents?: { get(id: unknown): unknown; selectForNextRequest?: (a: unknown, s: unknown) => void } }).agents
        const agent = agents?.get(sessionId)
        if (agent && agents && typeof agents.selectForNextRequest === 'function') {
          agents.selectForNextRequest(agent, {
            provider: PROVIDER_ID,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
          })
        }
      } catch {
        // safe containment
      }
    },
    onRun: (info) => {
      lastRun = info
    },
    onParser: (p) => {
      lastParser = p
    },
    readImage: async (ref: ImageRefLike) => {
      const svc = (ctx.get('attachments') as { readImage?: (r: ImageRefLike) => Promise<{ data?: Uint8Array } | null> } | undefined)
        ?? (ctx as unknown as { attachments?: { readImage?: (r: ImageRefLike) => Promise<{ data?: Uint8Array } | null> } }).attachments
      if (svc && typeof svc.readImage === 'function') {
        try {
          const stored = await svc.readImage(ref)
          if (stored?.data) return stored.data
        } catch {
          // fall through to disk read fallback
        }
      }
      try {
        const id = ref.attachmentId
        if (id && typeof id === 'string') {
          const diskPath = join(dshHome(), 'attachments', 'v1', 'objects', id.slice(0, 2), id)
          if (existsSync(diskPath)) {
            return readFileSync(diskPath)
          }
        }
      } catch {
        return null
      }
      return null
    },
  })

  const setOverride = (key: string, value: unknown): void => {
    const file = overridesPath()
    const current = readOverrides(file)
    current[key] = value
    binCache = undefined
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
    } catch (e) {
      log('failed to persist override: ' + String(e))
    }
  };

  // ---- dormant detection + background probes ----
  // Defer version/catalog spawns so plugin load does not immediately create
  // agy child processes (Windows conhost flash, issue #23). Catalog refresh
  // is also driven lazily by adapter.listModels / stream.
  const bootProbeTimer = setTimeout(() => {
    void (async () => {
      if (!getConfig().enabled) {
        dormantReason = 'disabled by config'
        log('dormant: disabled by config')
        return
      }
      const currentBin = bin()
      if (!currentBin) {
        dormantReason = 'agy binary not found — install via https://antigravity.google/docs/cli/install'
        log('dormant: agy binary not found')
        return
      }
      try {
        const v = await probeProcess(currentBin, ['--version'], 10_000, undefined, undefined, getConfig().suppressAgyAutoUpdate)
        versionCache = parseVersion(v.stdout)
        if (versionCache && compareVersions(versionCache, MIN_AGY_VERSION) < 0) {
          dormantReason = 'agy ' + versionCache + ' is older than ' + MIN_AGY_VERSION + ' — run: agy update'
          log('dormant: ' + dormantReason)
          return
        }
        dormantReason = null
        log('agy detected: ' + (versionCache ?? 'unknown version'))
      } catch {
        log('version probe failed — continuing with fallback catalog')
      }
      await catalog.refreshIfNeeded().catch(() => undefined)
      notifyPicker()
    })();
  }, 4_000)
  bootProbeTimer.unref?.()
  ctx.effect(() => () => clearTimeout(bootProbeTimer))

  // ---- llm registration (dormant-safe) ----
  if (getConfig().enabled) {
    try {
      ctx.llm.registerAdapter([PROVIDER_ID], adapter)
      log('registered provider route: ' + PROVIDER_ID)
    } catch (e) {
      log('adapter registration failed: ' + String(e))
    }
  }
  // NOTE: no registerConfigurableProviders call. This plugin configures
  // through its own cordis entry (enabled/agyBin/mode/...), not the llm
  // settings directory; registering here would put an unconfigured
  // antigravity into the provider-add list and confuse the UI state.

  // ---- /agy command ----
  ctx.commands.register(
    agyCommandDefinition({
      cfg: getConfig,
      bin,
      version,
      auth: () => auth,
      catalog: () => catalog,
      store: () => store,
      pool: () => pool,
      poolAuth: () => poolAuth,
      quota: () => quota,
      lastRun: () => lastRun,
      setOverride,
      sessions: () => (ctx.get('sessions') as any) ?? (ctx as any).sessions,
      runDoctor: async () => {
        return writeDoctorReport({
          cfg: getConfig,
          bin,
          version,
          catalog: () => catalog,
          store: () => store,
          recentLines: () => lastParser.recentLines,
        })
      },
    }),
  )

  // ---- tool registrations (agy_ask + the agy_tool mirror) ----
  // The tools service is reached through a reactive ctx.inject sub-fiber:
  // at plugin load time it may not exist yet (the same load-order race the
  // webServer routes hit), and headless compositions never start it. A
  // one-shot ctx.get('tools') silently loses every registration when it
  // races startup — which left the mirror unregistered and every span cut
  // failing with `unknown tool "agy_tool"`.
  const toolsSvcRef: { current: { register: (t: unknown) => unknown } | null } = { current: null }
  const askToolDispose = { current: null as null | (() => void) }
  const mirrorToolDispose = { current: null as null | (() => void) }
  const preExecuteDispose = { current: null as null | (() => void) }
  const syncAskTool = (): void => {
    const want = getConfig().askTool && bin() !== null
    if (want && askToolDispose.current === null && toolsSvcRef.current) {
      const reg = toolsSvcRef.current.register(
        defineAgyAskTool({ cfg: getConfig, bin, catalog: () => catalog.get() }),
      ) as unknown as () => void
      askToolDispose.current = typeof reg === 'function' ? reg : null
    } else if (!want && askToolDispose.current !== null) {
      askToolDispose.current()
      askToolDispose.current = null
    }
  }
  // The mirror rides the agent loop for native tool-card rendering: the
  // adapter's spans cut on completed agy tool steps with finish:tool-calls
  // addressed here, and the loop's dispatch writes the real tool/call +
  // tool/result events DSH's tool-card UI renders from.
  const syncMirrorTool = (): void => {
    const want = getConfig().enabled && bin() !== null
    if (want && mirrorToolDispose.current === null && toolsSvcRef.current) {
      const reg = toolsSvcRef.current.register(defineAgyMirrorTool({ runs })) as unknown as () => void
      mirrorToolDispose.current = typeof reg === 'function' ? reg : null
      if (mirrorToolDispose.current !== null) log('agy_tool mirror registered with the tools service')
    } else if (!want && mirrorToolDispose.current !== null) {
      mirrorToolDispose.current()
      mirrorToolDispose.current = null
    }
  }
  ctx.inject(['tools'], (sub) => {
    toolsSvcRef.current = sub.get('tools') as { register: (t: unknown) => unknown }
    syncAskTool()
    syncMirrorTool()
    // Bypass auto-review and permission prompt gates for the synthetic agy_tool mirror:
    // agy_tool only replays in-memory stdout already executed by agy in the previous step.
    // Intercepting it in auto-review causes redundant review LLM calls, review timeouts,
    // and crashes on tool-call reviewer endings.
    const unlisten = sub.on(
      'tools/pre-execute',
      async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        if (exec.name === 'agy_tool') {
          return { kind: 'allow' }
        }
        return next()
      },
      { prepend: true, global: true },
    )
    preExecuteDispose.current = typeof unlisten === 'function' ? unlisten : null

    return () => {
      if (preExecuteDispose.current !== null) preExecuteDispose.current()
      preExecuteDispose.current = null
      if (askToolDispose.current !== null) askToolDispose.current()
      askToolDispose.current = null
      if (mirrorToolDispose.current !== null) mirrorToolDispose.current()
      mirrorToolDispose.current = null
      toolsSvcRef.current = null
    }
  })

  // ---- HTTP surface for the client half ----
  // Registered through a reactive ctx.inject sub-fiber: at plugin load time
  // the webServer service may not exist yet (load-order race observed on
  // dsh web), and in headless compositions it never does. The sub-fiber
  // starts whenever the service appears and tears the routes down when it
  // goes away — no more silent one-shot ctx.get() that permanently loses
  // the /plugins/agy-link/* routes when it races the server startup.
  const registerRoutes = (webServer: WebServerLike): (() => void) => {
    const disposers: Array<() => void> = []
    const reg = (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): void => {
      const d = webServer.register(route) as unknown as () => void | undefined
      if (typeof d === 'function') disposers.push(d)
    }
    const sendJson = (res: RawRes, status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    // Bounded, shared JSON reader (see ./host/read-json-body.ts): plugin
    // payloads are small config JSON, and an unbounded buffer let a local
    // client exhaust host memory by streaming a huge POST body.
    const readBody = async (req: unknown, strict = false): Promise<Record<string, unknown>> => {
      const result = await readJsonBody(req)
      // Strict callers must be able to tell malformed/oversized bodies from
      // `{}`: an empty body must not silently become "do it for all accounts".
      if (result.invalid || result.tooLarge) return strict ? { __invalidJson: true } : {}
      return result.value
    };
  const methodOf = (req: unknown): string => {
    const m = (req as { method?: unknown }).method
    return typeof m === 'string' ? m.toUpperCase() : 'GET'
  };

    reg({ kind: 'exact', path: '/plugins/agy-link/status', handler: (_req, res) => {
      void (async () => {
        const cfg = getConfig()
        const cat = catalog.get()
        sendJson(res as RawRes, 200, {
          plugin: 'dsh-agy-link',
          bin: bin(),
          version: versionCache,
          dormantReason,
          enabled: cfg.enabled,
          permissionMode: cfg.permissionMode,
          workspaceRoot: cfg.workspaceRoot,
          defaultModel: cfg.defaultModel,
          defaultEffort: cfg.defaultEffort,
          askTool: cfg.askTool,
          auth: auth.status(),
          poolAuth: poolAuth.status(),
          pool: pool.getPoolData(cfg.proxyUrl?.trim() || undefined),
          catalog: { source: cat.source, count: cat.models.length, lastError: cat.lastError ?? null },
          // Full sanitized catalog + the current deny-list so the settings UI's
          // model-visibility toggles show every known model, hidden ones included.
          catalogModels: sanitizeCatalogEntries(cat.models).entries,
          hiddenModels: cfg.hiddenModels,
          autoWarmup: cfg.autoWarmup,
          warmupModels: cfg.warmupModels,
          bindings: Object.keys(store.all()).length,
              lastRun,
        })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/auth', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const homeDir = typeof body.homeDir === 'string' ? body.homeDir : undefined
        const accountId = typeof body.accountId === 'string' ? body.accountId : undefined
        const proxyUrl = typeof body.proxyUrl === 'string' && body.proxyUrl.trim() !== ''
          ? body.proxyUrl.trim()
          : (getConfig().proxyUrl.trim() || detectSystemProxy() || undefined)
        const st = await auth.begin(homeDir, accountId, proxyUrl)
        sendJson(res as RawRes, 200, st)
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/auth-code', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const code = typeof body.code === 'string' ? body.code : ''
        if (code === '') {
          sendJson(res as RawRes, 400, { error: 'missing code' })
          return
        }
        const st = await auth.submitCode(code)
        if (st.phase === 'ok') {
          if (st.accountId) {
            const acc = pool.getAccount(st.accountId)
            if (acc) void quota.refreshAccountQuota(acc).catch(() => undefined)
          } else {
            void quota.refreshAllQuotas().catch(() => undefined)
          }
          store.clear()
          void catalog.forceRefresh().catch(() => undefined)
        }
        sendJson(res as RawRes, 200, st)
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/auth-cancel', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        await readBody(req)
        const st = auth.cancelAuth()
        sendJson(res as RawRes, 200, st)
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/mermaid.min.js', handler: (_req, res) => {
      const p = join(import.meta.dirname, 'mermaid.min.js')
      const fallback = join(import.meta.dirname, '..', 'assets', 'mermaid.min.js')
      const file = existsSync(p) ? p : existsSync(fallback) ? fallback : null
      if (!file) {
        ;(res as RawRes).writeHead(404, { 'content-type': 'text/plain' })
        ;(res as RawRes).end('mermaid.min.js not found')
        return
      }
      try {
        const content = readFileSync(file)
        ;(res as RawRes).writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        })
        ;(res as RawRes).end(content)
      } catch (err) {
        ;(res as RawRes).writeHead(500, { 'content-type': 'text/plain' })
        ;(res as RawRes).end('read error: ' + String(err))
      }
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool', handler: (_req, res) => {
      sendJson(res as RawRes, 200, pool.getPoolData(getConfig().proxyUrl.trim() || undefined))
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/begin-add', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const alias = typeof body.alias === 'string' ? body.alias : undefined
        const proxyUrl = typeof body.proxyUrl === 'string' && body.proxyUrl.trim() !== ''
          ? body.proxyUrl.trim()
          : (getConfig().proxyUrl.trim() || detectSystemProxy() || undefined)
        const st = await poolAuth.begin(alias, proxyUrl)
        sendJson(res as RawRes, st.ok ? 200 : 500, st)
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/complete-add', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const code = typeof body.code === 'string' ? body.code : ''
        if (!code) {
          sendJson(res as RawRes, 400, { ok: false, phase: 'waiting', code: 'missing_code' })
          return
        }
        const st = await poolAuth.submitCode(code)
        sendJson(res as RawRes, st.ok ? 200 : 400, {
          ok: st.ok,
          phase: st.phase,
          code: st.code,
          pool: pool.getPoolData(),
        })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/cancel-add', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        await readBody(req)
        await poolAuth.cancel()
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/add', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const alias = typeof body.alias === 'string' ? body.alias : undefined
        const acc = pool.createAccountSlot(alias)
        if (bridgeState.bridge !== null) {
          const cfg = getConfig()
          if (cfg.mcpConfigScope === 'global' || cfg.mcpConfigScope === 'both') {
            const accTarget = agyMcpConfigPath('', isolatedHomeEnv(acc.dir))
            bridgeState.restores.push(writeMcpConfig(accTarget, bridgeState.bridge))
          }
        }
        // Quarantine until the terminal login completes (same contract as
        // /agy add-account): the scheduler must not route real runs to a
        // slot nobody has signed into yet.
        pool.markAuthRequired(acc.id, 'not signed in yet — complete the terminal login')
        const autoOpen = body.autoOpenTerminal !== false
        if (autoOpen && acc.dir) {
          openAccountTerminal(acc.dir)
        }
        sendJson(res as RawRes, 200, { ok: true, account: acc, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/open-terminal', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const acc = pool.getAccount(id)
        if (!acc || !acc.dir) {
          sendJson(res as RawRes, 400, { error: 'account has no isolated directory' })
          return
        }
        openAccountTerminal(acc.dir)
        sendJson(res as RawRes, 200, { ok: true, dir: acc.dir })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/remove', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        pool.deleteAccount(id)
        // Deleting the active/primary account changes the effective account.
        notifyPicker()
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/enable', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const enabled = typeof body.enabled === 'boolean' ? body.enabled : true
        const ok = pool.setAccountEnabled(id, enabled)
        // Enabling/disabling the active account changes which models are live.
        if (ok) notifyPicker()
        sendJson(res as RawRes, ok ? 200 : 400, { ok, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/proxy', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl : undefined
        pool.setAccountProxy(id, proxyUrl)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/primary', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (pool.setPrimaryAccount(id)) {
          // Same contract as /pool/set-active: switching the primary changes
          // the effective account and its model catalog / Argon visibility.
          notifyPicker()
          void catalog.forceRefreshAndNotify(id).catch(() => undefined)
        }
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/mode', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const mode = body.mode === 'round-robin' ? 'round-robin' : 'sequential'
        pool.setMode(mode)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/refresh-quota', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id) {
          const acc = pool.getAccount(id)
          if (acc) await quota.refreshAccountQuota(acc, true)
        } else {
          await quota.refreshAllQuotas(true)
        }
        // Manual refresh also re-reads the model catalog: after an external
        // re-login the subscription tier (and thus model list) may differ.
        // One `agy models` spawn per explicit user click only — the
        // background poller never touches the catalog.
        // ModelCatalog emits notifyPicker internally ONLY when entries change.
        void catalog.forceRefresh().catch(() => undefined)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/warmup', handler: (req, res) => {
      void (async () => {
        try {
          if (methodOf(req) !== 'POST') {
            sendJson(res as RawRes, 405, { error: 'POST only' })
            return
          }
          const body = await readBody(req, true)
          if (body.__invalidJson === true) {
            sendJson(res as RawRes, 400, { error: 'invalid JSON body' })
            return
          }
          const id = typeof body.id === 'string' ? body.id : ''
          const force = body.force === true
          const rawModel = body.model
          if (rawModel !== undefined && (typeof rawModel !== 'string' || !/^[A-Za-z0-9._/-]{1,80}$/.test(rawModel))) {
            sendJson(res as RawRes, 400, { error: 'invalid model' })
            return
          }
          const model = typeof rawModel === 'string' ? rawModel : undefined
          // Never let an empty/malformed body fan out to every account: the
          // caller must say either `{ id }` or `{ all: true }` explicitly.
          if (id === '' && body.all !== true) {
            sendJson(res as RawRes, 400, { error: 'id or { all: true } required' })
            return
          }
          let results: WarmupResult[] = []
          if (id) {
            const acc = pool.getAccount(id)
            if (!acc) {
              sendJson(res as RawRes, 404, { error: 'Account not found' })
              return
            }
            results = await warmup.warmupAccount(acc, { force, model })
            await quota.refreshAccountQuota(acc, true).catch(() => undefined)
          } else {
            results = await warmup.warmupAllAccounts({ force })
            // Non-forced refresh respects account cooldowns and the 10s cache,
            // avoiding a second network burst right after a warmup pass.
            await quota.refreshAllQuotas(false).catch(() => undefined)
          }
          sendJson(res as RawRes, 200, { ok: true, results, pool: pool.getPoolData() })
        } catch (e) {
          sendJson(res as RawRes, 500, { error: String(e) })
        }
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/clear-cooldown', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : undefined
        const family = typeof body.family === 'string' ? body.family : undefined
        pool.clearCooldown(id, family as never)
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/set-active', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const ok = id !== '' && pool.setActiveAccount(id)
        if (ok) {
          // Switching the active account changes BOTH the discovered catalog
          // (per-account plans differ, e.g. Gemini 4 Argon) AND the Argon
          // visibility gate in listModels(). Discover this account, then emit
          // the update unconditionally — otherwise the composer's cached model
          // snapshot keeps showing the previous account's models (Argon
          // missing after switching to a Pro/Ultra account).
          notifyPicker()
          void catalog.forceRefreshAndNotify(id).catch(() => undefined)
        }
        sendJson(res as RawRes, ok ? 200 : 400, { ok, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/reorder', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
        if (pool.reorderAccounts(ids)) {
          // Reordering clears the sticky active pointers, so the effective
          // account may change; refresh it and re-announce the model list.
          const activeId = pool.getActiveAccountId('google')
          notifyPicker()
          if (activeId) void catalog.forceRefreshAndNotify(activeId).catch(() => undefined)
        }
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        const allowed = ['permissionMode', 'defaultModel', 'defaultEffort', 'askTool', 'workspaceRoot', 'hiddenModels', 'autoWarmup', 'warmupModels']
        if (!allowed.includes(key)) {
          sendJson(res as RawRes, 400, { error: 'key not settable' })
          return
        }
        if (key === 'hiddenModels' && (!Array.isArray(body.value) || !(body.value as unknown[]).every((x) => typeof x === 'string'))) {
          sendJson(res as RawRes, 400, { error: 'hiddenModels must be an array of model ids' })
          return
        }
        if (key === 'warmupModels' && (!Array.isArray(body.value) || !(body.value as unknown[]).every((x) => typeof x === 'string'))) {
          sendJson(res as RawRes, 400, { error: 'warmupModels must be an array of model names' })
          return
        }
        setOverride(key, body.value)
        syncAskTool()
        syncMirrorTool()
        // Picker visibility changed — the webview re-reads the catalog only
        // after this event, so the toggle must announce itself.
        if (key === 'hiddenModels') notifyPicker()
        sendJson(res as RawRes, 200, { ok: true, key, value: body.value })
      })()
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/qr', handler: (_req, res) => {
      void (async () => {
        const st = auth.status()
        const url = st.phase === 'pending' ? st.url : undefined
        if (!url) {
          const r404 = res as RawRes
          r404.writeHead(404, { 'Content-Type': 'text/plain' })
          r404.end('no pending auth')
          return
        }
        try {
          const mod = (await import('qrcode')) as unknown as { toBuffer: (t: string, o?: { type?: string; width?: number; margin?: number }) => Promise<Buffer> }
          const png = await mod.toBuffer(url, { type: 'png', width: 220, margin: 1 })
          const r2 = res as RawRes
          r2.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
          r2.end(png)
        } catch {
          sendJson(res as RawRes, 500, { error: 'qr generation failed' })
        }
      })()
    }})

    // /plugins/agy-link/media?path=...
    reg({ kind: 'exact', path: '/plugins/agy-link/media', handler: (req, res) => {
      handleMediaRequest(req as HttpRequestLike, res as HttpResponseLike, { workspaceRoot: getConfig().workspaceRoot })
    }})

    // /plugins/agy-link/assets/...
    const assetDir = resolveAssetDir()
    reg({ kind: 'prefix', path: '/plugins/agy-link/assets', handler: (req, res) => {
      handleAssetRequest(req as HttpRequestLike, res as HttpResponseLike, assetDir)
    }})

    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          // route already gone (server teardown) — nothing to do
        }
      }
    }
  }

  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer') as WebServerLike | undefined
    if (!webServer) return
    webServerPort.current = (webServer as { port?: number }).port
    return registerRoutes(webServer)
  })

  // ---- v0.2: media TTL sweep + optional MCP reverse bridge ----
  const mediaDir = (): string => {
    const cfg = getConfig()
    return cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      void sweepDir(mediaDir(), getConfig().mediaTtlMs).catch(() => undefined)
    }, Math.max(60_000, Math.min(getConfig().mediaTtlMs, 3_600_000)))
    timer.unref?.()
    return () => clearInterval(timer)
  })

  // Background quota refresh: reads local token files only (no agy spawns,
  // no Keychain prompts), then one HTTPS call per account per poll interval
  // (default 15 min, configurable; clamped to at least 60s). Restricted
  // accounts (cooldown / auth-quarantined) are skipped by refreshAllQuotas.
  ctx.effect(() => {
    if (!getConfig().enabled) return () => undefined
    const refresh = (): void => {
      const prevArgon = pool.getAccounts().map((a) => Boolean(a.quotas?.argon)).join(',')
      void quota.refreshAllQuotas().then(() => {
        const nextArgon = pool.getAccounts().map((a) => Boolean(a.quotas?.argon)).join(',')
        if (prevArgon !== nextArgon) notifyPicker()
      }).catch(() => undefined)
    }
    const boot = setTimeout(refresh, 5_000)
    boot.unref?.()
    const timer = setInterval(refresh, Math.max(60_000, getConfig().quotaPollIntervalMs))
    timer.unref?.()
    return () => {
      clearTimeout(boot)
      clearInterval(timer)
    }
  })

  // Scheduled weekly quota auto-warmup (opt-in): monitors 7-day quota windows
  // and cold starts, triggering minimal 1-token probes to advance the upstream
  // timer. No boot pass: the 5s quota refresh needs time to produce trustworthy
  // weekly data first, and an upgrade must never probe on stale pool.json rows.
  ctx.effect(() => {
    if (!getConfig().enabled) return () => undefined
    let running = false
    const checkWarmup = (): void => {
      if (running) return
      const cfg = getConfig()
      if (!cfg.enabled || !cfg.autoWarmup) return
      running = true
      void warmup.runScheduledWarmup()
        .catch(() => undefined)
        .finally(() => { running = false })
    }
    // Scan every 5 minutes (300s, matching Antigravity-Manager scheduler).
    // The in-flight guard prevents a slow cycle from overlapping the next tick.
    const timer = setInterval(checkWarmup, 300_000)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  // One bridge can publish to several registries (global, pool accounts, and/or workspace),
  // so keep every restore hook it produced.
  const bridgeState: { bridge: Awaited<ReturnType<typeof startMcpBridge>> | null; restores: Array<() => void> } = { bridge: null, restores: [] }
  let bridgeDisposed = false
  const syncMcpBridge = (): void => {
    const cfg = getConfig()
    const want = cfg.mcpBridge && cfg.enabled
    if (want && bridgeState.bridge === null) {
      void (async () => {
        try {
          // fileURLToPath resolves file:/// URLs correctly on Windows
          // (URL.pathname would yield /C:/... there and break the spawn).
          const script = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
          const toolsSvc = ctx.get('tools') as ToolsServiceLike | undefined
          const agents = (): { get(id: unknown): unknown } | undefined => {
            const svc = ctx.get('agents') as { get(id: unknown): unknown } | undefined
            return svc ?? (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents
          }
          const bridge = await startMcpBridge({
            bridgeScript: script,
            tools: () => (ctx.get('tools') as ToolsServiceLike | undefined),
            allowlist: () => getConfig().mcpToolAllowlist,
            // Bridged calls run on behalf of the session that spawned agy
            // (issue #55): resolve its agent so tools that require a caller work.
            resolveAgent: (sessionId) => agents()?.get(sessionId),
            log,
          })
          // A scope can be disposed before asynchronous listener startup ends.
          // Do not publish a capability or registry configs after disposal.
          if (bridgeDisposed) {
            await bridge.close()
            return
          }
          bridgeState.bridge = bridge
          const root = cfg.workspaceRoot !== '' ? cfg.workspaceRoot : process.cwd()
          // `agy` 1.4+ ignores a workspace `.mcp.json` and only loads the global
          // registry, so that is the default target (issue #55).
          const targets: string[] = []
          if (cfg.mcpConfigScope === 'global' || cfg.mcpConfigScope === 'both') {
            targets.push(agyMcpConfigPath(cfg.mcpConfigPath))
            // Also register in every pool account's isolated home
            for (const acc of pool.getAccounts()) {
              if (acc.dir) {
                targets.push(agyMcpConfigPath('', isolatedHomeEnv(acc.dir)))
              }
            }
          }
          if (cfg.mcpConfigScope === 'workspace' || cfg.mcpConfigScope === 'both') {
            targets.push(join(root, '.mcp.json'))
          }
          const uniqueTargets = Array.from(new Set(targets))
          bridgeState.restores = uniqueTargets.map((file) => writeMcpConfig(file, bridge))
          log('mcp bridge ready at ' + bridge.url + ' (registries: ' + uniqueTargets.join(', ') + ')' + (toolsSvc ? '' : ' (tools service not yet available)'))
        } catch (e) {
          for (const undo of bridgeState.restores) undo()
          await bridgeState.bridge?.close()
          bridgeState.bridge = null
          bridgeState.restores = []
          log('mcp bridge failed to start: ' + String(e))
        }
      })()
    } else if (!want && bridgeState.bridge !== null) {
      for (const undo of bridgeState.restores) undo()
      void bridgeState.bridge.close()
      bridgeState.bridge = null
      bridgeState.restores = []
    }
  }
  syncMcpBridge()

  ctx.effect(() => {
    return () => {
      bridgeDisposed = true
      auth.dispose()
      void poolAuth.cancel()
      if (askToolDispose.current !== null) askToolDispose.current()
      if (mirrorToolDispose.current !== null) mirrorToolDispose.current()
      for (const undo of bridgeState.restores) undo()
      void bridgeState.bridge?.close()
    }
  })
}
