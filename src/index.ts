// dsh-agy-link host assembly (spec section 5): dormant-safe detection,
// LlmAdapter registration, /agy commands, agy_ask tool, auth helper, and
// the /plugins/agy-link/* HTTP surface the client half polls. Everything
// registers as cordis effects, so uninstalling the plugin rolls it back
// cleanly.
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { overridesPath, readOverrides, resolveConfig, stateDir } from './common/config.ts'
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
  const runs = new RunRegistry()

  const adapter = new AgyAdapter({
    getConfig,
    catalog,
    store,
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
      const svc = (ctx as unknown as { attachments?: { readImage?: (r: ImageRefLike) => Promise<{ data?: Uint8Array } | null> } }).attachments
      if (!svc || typeof svc.readImage !== 'function') return null
      try {
        const stored = await svc.readImage(ref)
        return stored?.data ?? null
      } catch {
        return null
      }
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
          auth: await auth.resolvedStatus(),
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
        await readBody(req)
        const st = await auth.begin()
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
        if (st.phase === 'ok') void catalog.forceRefresh().catch(() => undefined)
        sendJson(res as RawRes, 200, st)
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
    if (askToolDispose.current !== null) askToolDispose.current()
    if (mirrorToolDispose.current !== null) mirrorToolDispose.current()
    bridgeState.restore?.()
    void bridgeState.bridge?.close()
    return () => undefined
  })
}
