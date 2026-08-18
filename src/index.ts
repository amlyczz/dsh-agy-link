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
import { renderToolActivity } from './host/diff-render.ts'
import { ModelCatalog } from './host/models.ts'
import { MIN_AGY_VERSION, compareVersions, parseVersion, probeProcess, resolveAgyBin } from './host/runner.ts'
import { SessionStore } from './host/sessions.ts'
import { StreamJsonParser } from './host/parser.ts'

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
  const lastParser = new StreamJsonParser()

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
      const out = await probeProcess(b, ['models', '--output-format', 'json'], 30_000, signal)
      if (out.code !== 0 && out.stdout.trim() === '') {
        throw new Error('agy models failed: ' + (out.stderrTail.trim() !== '' ? out.stderrTail.trim().slice(-200) : 'exit ' + String(out.code)))
      }
      return { stdout: out.stdout, stderr: out.stderrTail }
    },
    getConfig().fallbackModels,
    300_000,
  )
  const auth = new AuthHelper(bin)

  const adapter = new AgyAdapter({
    getConfig,
    catalog,
    store,
    bin,
    acquire: () => semaphore.acquire(),
    log,
    toolOutput: (name, args, output) => {
      const ws = getConfig().workspaceRoot
      return renderToolActivity(name, args, output, ws !== '' ? ws : process.cwd())
    },
    onRun: (info) => {
      lastRun = info
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
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER_ID,
      displayName: 'Antigravity (agy CLI)',
      settingsNs: PLUGIN_ID,
      settingsPath: [],
      declared: false,
    }])
  } catch {
    // directory entry is best-effort
  }

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

  // ---- agy_ask tool (optional) ----
  const toolsSvc = ctx.get('tools') as { register: (t: unknown) => unknown } | undefined
  const askToolDispose = { current: null as null | (() => void) }
  const syncAskTool = (): void => {
    const want = getConfig().askTool && bin() !== null
    if (want && askToolDispose.current === null && toolsSvc) {
      const reg = toolsSvc.register(
        defineAgyAskTool({ cfg: getConfig, bin, catalog: () => catalog.get() }),
      ) as unknown as () => void
      askToolDispose.current = typeof reg === 'function' ? reg : null
    } else if (!want && askToolDispose.current !== null) {
      askToolDispose.current()
      askToolDispose.current = null
    }
  }
  syncAskTool()

  // ---- HTTP surface for the client half ----
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  const sendJson = (res: RawRes, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  };
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

  if (webServer) {
    webServer.register({ kind: 'exact', path: '/plugins/agy-link/status', handler: (_req, res) => {
      const cfg = getConfig()
      const cat = catalog.get()
      sendJson(res as RawRes, 200, {
        plugin: 'dsh-agy-link',
        bin: bin(),
        version: versionCache,
        dormantReason,
        enabled: cfg.enabled,
        permissionMode: cfg.permissionMode,
        defaultModel: cfg.defaultModel,
        defaultEffort: cfg.defaultEffort,
        askTool: cfg.askTool,
        auth: auth.status(),
        catalog: { source: cat.source, count: cat.models.length, lastError: cat.lastError ?? null },
        bindings: Object.keys(store.all()).length,
        lastRun,
      })
    }})
    webServer.register({ kind: 'exact', path: '/plugins/agy-link/auth', handler: (req, res) => {
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
    webServer.register({ kind: 'exact', path: '/plugins/agy-link/auth-code', handler: (req, res) => {
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
    webServer.register({ kind: 'exact', path: '/plugins/agy-link/config', handler: (req, res) => {
      void (async () => {
        if (methodOf(req) !== 'POST') {
          sendJson(res as RawRes, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        const key = typeof body.key === 'string' ? body.key : ''
        const allowed = ['permissionMode', 'defaultModel', 'defaultEffort', 'askTool']
        if (!allowed.includes(key)) {
          sendJson(res as RawRes, 400, { error: 'key not settable' })
          return
        }
        setOverride(key, body.value)
        syncAskTool()
        sendJson(res as RawRes, 200, { ok: true, key, value: body.value })
      })()
    }})
    webServer.register({ kind: 'exact', path: '/plugins/agy-link/qr', handler: (_req, res) => {
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
  }

  ctx.effect(() => {
    auth.dispose()
    if (askToolDispose.current !== null) askToolDispose.current()
    return () => undefined
  })
}
