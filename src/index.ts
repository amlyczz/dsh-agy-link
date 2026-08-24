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
import { AgyAdapter } from './host/adapter.ts'
import { defineAgyAskTool } from './host/ask-tool.ts'
import { AuthHelper } from './host/auth.ts'
import { agyCommandDefinition } from './host/commands.ts'
import { writeDoctorReport } from './host/diagnostics.ts'
import { defineAgyMirrorTool } from './host/mirror-tool.ts'
import { ModelCatalog } from './host/models.ts'
import { RunRegistry } from './host/recording.ts'
import { MIN_AGY_VERSION, compareVersions, parseVersion, probeProcess, resolveAgyBin } from './host/runner.ts'
import { SessionStore } from './host/sessions.ts'
import { AccountPoolManager } from './host/pool.ts'
import { PoolAuthFlow } from './host/pool-auth.ts'
import { QuotaService } from './host/quota.ts'
import { StreamJsonParser } from './host/parser.ts'
import { defaultMediaDir, sweepDir, type ImageRefLike } from './host/media.ts'
import { startMcpBridge, writeMcpConfig, type McpBridge, type ToolsServiceLike } from './host/mcp-bridge.ts'
import { fileURLToPath } from 'node:url'

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
  register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }): unknown;
};

/** Cross-session concurrency limiter (ADR-12). */
class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly max: () => number) {}
  async acquire(): Promise<() => void> {
    if (this.active < Math.max(1, this.max())) {
      this.active++
      return () => this.releaseOne()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve(() => this.releaseOne())
      })
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
  let lastRun: { ok: boolean; code: string; durationMs: number; model: string } | null = null
  let lastParser = new StreamJsonParser()

  const getConfig = (): PluginConfig => resolveConfig(entryConfig)
  const bin = (): string | null => {
    if (binCache === undefined) binCache = resolveAgyBin(getConfig())
    return binCache
  }
  const version = () => versionCache
  const store = new SessionStore(join(stateDir(), 'sessions.json'))
  const pool = new AccountPoolManager()
  const quota = new QuotaService(pool)
  const semaphore = new Semaphore(() => getConfig().maxConcurrent)
  const catalog = new ModelCatalog(
    async (signal) => {
      const b = bin()
      if (!b) throw new Error('agy binary not found')
      // agy models has no --output-format flag (verified against 1.1.13);
      // it prints a two-column text table. parseModelsOutput handles both.
      const out = await probeProcess(b, ['models'], 30_000, signal)
      if (out.code !== 0 && out.stdout.trim() === '') {
        throw new Error('agy models failed: ' + (out.stderrTail.trim() !== '' ? out.stderrTail.trim().slice(-200) : 'exit ' + String(out.code)))
      }
      return { stdout: out.stdout, stderr: out.stderrTail }
    },
    getConfig().fallbackModels,
    300_000,
  )
  const auth = new AuthHelper(bin)
  const poolAuth = new PoolAuthFlow(pool, quota, log)
  const runs = new RunRegistry()

  // Boot hygiene: remove staging dirs and purge old historical logs
  const swept = pool.sweepStaleStaging()
  if (swept > 0) log('swept ' + swept + ' stale staging dir(s)')
  const logsSwept = pool.sweepOldLogs(getConfig().logRetentionDays)
  if (logsSwept > 0) log('swept ' + logsSwept + ' old log file(s)')

  const adapter = new AgyAdapter({
    getConfig,
    catalog,
    store,
    pool,
    bin,
    acquire: () => semaphore.acquire(),
    log,
    runs,
    sessionCwd: (sessionId) => {
      const sessions = ctx.get('sessions') as { get(id: unknown): { header?: { cwd?: string } } | undefined } | undefined
      return sessions?.get(sessionId)?.header?.cwd
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
    try {
      mkdirSync(stateDir(), { recursive: true })
      writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
    } catch (e) {
      log('failed to persist override: ' + String(e))
    }
  };

  // ---- dormant detection + background probes ----
  void (async () => {
    if (!getConfig().enabled) {
      dormantReason = 'disabled by config'
      log('dormant: disabled by config')
      return
    }
    if (!bin()) {
      dormantReason = 'agy binary not found — install via https://antigravity.google/docs/cli/install'
      log('dormant: agy binary not found')
      return
    }
    try {
      const v = await probeProcess(bin() as string, ['--version'], 10_000)
      versionCache = parseVersion(v.stdout)
      if (versionCache && compareVersions(versionCache, MIN_AGY_VERSION) < 0) {
        dormantReason = 'agy ' + versionCache + ' is older than ' + MIN_AGY_VERSION + ' — run: agy update'
        log('dormant: ' + dormantReason)
        return
      }
      log('agy detected: ' + (versionCache ?? 'unknown version'))
    } catch {
      log('version probe failed — continuing with fallback catalog')
    }
    await catalog.refreshIfNeeded().catch(() => undefined)
  })();

  // ---- llm registration (dormant-safe) ----
  if (getConfig().enabled && bin()) {
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
    return () => {
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
    const readBody = (req: unknown): Promise<Record<string, unknown>> => {
    const r = req as { on?: (e: string, cb: (c: Buffer) => void) => void }
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      r.on?.('data', (c) => chunks.push(c))
      r.on?.('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
        } catch {
          resolve({})
        }
      })
    })
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
          pool: pool.getPoolData(),
          catalog: { source: cat.source, count: cat.models.length, lastError: cat.lastError ?? null },
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
        const st = await auth.begin(homeDir, accountId)
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
    reg({ kind: 'exact', path: '/plugins/agy-link/pool', handler: (_req, res) => {
      sendJson(res as RawRes, 200, pool.getPoolData())
    }})
    reg({ kind: 'exact', path: '/plugins/agy-link/pool/begin-add', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const alias = typeof body.alias === 'string' ? body.alias : undefined
        const proxyUrl = typeof body.proxyUrl === 'string' ? body.proxyUrl : undefined
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
          sendJson(res as RawRes, 400, { ok: false, error: 'missing code' })
          return
        }
        const st = await poolAuth.submitCode(code)
        sendJson(res as RawRes, st.ok ? 200 : 400, {
          ok: st.ok,
          phase: st.phase,
          message: st.message,
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
        const autoOpen = body.autoOpenTerminal !== false
        if (autoOpen && acc.dir) {
          if (process.platform === 'darwin') {
            const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "export HOME='${acc.dir}'; agy"`
            execFile('osascript', ['-e', script], () => {})
          } else if (process.platform === 'win32') {
            // HOME alone is ignored by Node/Go on Windows — set USERPROFILE too.
            execFile('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `set "HOME=${acc.dir}" && set "USERPROFILE=${acc.dir}" && agy`], () => {})
          } else {
            execFile('x-terminal-emulator', ['-e', `sh -c "export HOME='${acc.dir}'; agy; exec sh"`], () => {})
          }
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
        if (process.platform === 'darwin') {
          const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "export HOME='${acc.dir}'; agy"`
          execFile('osascript', ['-e', script], () => {})
        } else if (process.platform === 'win32') {
          // HOME alone is ignored by Node/Go on Windows — set USERPROFILE too.
          execFile('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `set "HOME=${acc.dir}" && set "USERPROFILE=${acc.dir}" && agy`], () => {})
        } else {
          execFile('x-terminal-emulator', ['-e', `sh -c "export HOME='${acc.dir}'; agy; exec sh"`], () => {})
        }
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
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
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
        pool.setPrimaryAccount(id)
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
        sendJson(res as RawRes, 200, { ok: true, pool: pool.getPoolData() })
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
    reg({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        const allowed = ['permissionMode', 'defaultModel', 'defaultEffort', 'askTool', 'workspaceRoot']
        if (!allowed.includes(key)) {
          sendJson(res as RawRes, 400, { error: 'key not settable' })
          return
        }
        setOverride(key, body.value)
        syncAskTool()
        syncMirrorTool()
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
    return () => clearInterval(timer)
  })

  // Background quota refresh: reads local token files only (no agy spawns,
  // no Keychain prompts), then one HTTPS call per account every 5 minutes.
  ctx.effect(() => {
    if (!getConfig().enabled) return () => undefined
    const refresh = (): void => {
      void quota.refreshAllQuotas().catch(() => undefined)
    }
    const boot = setTimeout(refresh, 5_000)
    const timer = setInterval(refresh, 5 * 60_000)
    return () => {
      clearTimeout(boot)
      clearInterval(timer)
    }
  })

  const bridgeState: { bridge: Awaited<ReturnType<typeof startMcpBridge>> | null; restore: (() => void) | null } = { bridge: null, restore: null }
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
          const bridge = await startMcpBridge({
            bridgeScript: script,
            tools: () => (ctx.get('tools') as ToolsServiceLike | undefined),
            allowlist: () => getConfig().mcpToolAllowlist,
            log,
          })
          bridgeState.bridge = bridge
          const root = cfg.workspaceRoot !== '' ? cfg.workspaceRoot : process.cwd()
          bridgeState.restore = writeMcpConfig(root, bridge)
          log('mcp bridge ready at ' + bridge.url + (toolsSvc ? '' : ' (tools service not yet available)'))
        } catch (e) {
          log('mcp bridge failed to start: ' + String(e))
        }
      })()
    } else if (!want && bridgeState.bridge !== null) {
      bridgeState.restore?.()
      void bridgeState.bridge.close()
      bridgeState.bridge = null
      bridgeState.restore = null
    }
  }
  syncMcpBridge()

  ctx.effect(() => {
    auth.dispose()
    void poolAuth.cancel()
    if (askToolDispose.current !== null) askToolDispose.current()
    if (mirrorToolDispose.current !== null) mirrorToolDispose.current()
    bridgeState.restore?.()
    void bridgeState.bridge?.close()
    return () => undefined
  })
}
