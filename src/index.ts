// dsh-agy-link host assembly (spec section 5): dormant-safe detection,
// LlmAdapter registration, /agy commands, agy_ask tool, auth helper, and
// the /plugins/agy-link/* HTTP surface the client half polls. Everything
// registers as cordis effects, so uninstalling the plugin rolls it back
// cleanly.
//
// Service construction lives in src/host/services.ts and the HTTP route bodies
// in src/transport/http/routes/*; this file is the composition root: config,
// service construction, commands/tools, lifecycle effects and one call to
// registerRoutes().
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_ID } from './common/types.ts'
import { defineAgyAskTool } from './host/ask-tool.ts'
import { agyCommandDefinition } from './host/commands.ts'
import { tslCommandDefinition } from './host/tsl-command.ts'
import { writeDoctorReport } from './host/diagnostics.ts'
import { defineAgyMirrorTool } from './host/mirror-tool.ts'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { MIN_AGY_VERSION, compareVersions, isolatedHomeEnv, parseVersion, probeProcess } from './host/runner.ts'
import { sweepDir } from './host/media.ts'
import { agyMcpConfigPath, startMcpBridge, writeMcpConfig, type ToolsServiceLike } from './host/mcp-bridge.ts'
import { runBootHygiene } from './host/boot-hygiene.ts'
import { createHostServices } from './host/services.ts'
import { registerRoutes, type WebServerLike } from './transport/http/router.ts'

export const name = 'dsh-agy-link'
// webServer and tools are optional: the plugin loads headless too.
export const inject = ['llm', 'commands']

export function apply(ctx: Context, entryConfig: Record<string, unknown> = {}): void {
  const services = createHostServices(ctx, entryConfig)
  const {
    getConfig, log, bin, version, store, pool, quota, warmup, catalog, auth, poolAuth, runs,
    adapter, translation, setOverride, notifyPicker, readEffortUnsupported, rememberEffortUnsupported,
    sessionsSvc, sessionAuto, mediaDir, bridgeState, webServerPort,
  } = services

  // Boot-time pool/store hygiene: stale staging logs, keychains, credential slot.
  runBootHygiene(services)

  // ---- dormant detection + background probes ----
  // Defer version/catalog spawns so plugin load does not immediately create
  // agy child processes (Windows conhost flash, issue #23). Catalog refresh
  // is also driven lazily by adapter.listModels / stream.
  const bootProbeTimer = setTimeout(() => {
    void (async () => {
      if (!getConfig().enabled) {
        services.status.dormantReason = 'disabled by config'
        log('dormant: disabled by config')
        return
      }
      const currentBin = bin()
      if (!currentBin) {
        services.status.dormantReason = 'agy binary not found — install via https://antigravity.google/docs/cli/install'
        log('dormant: agy binary not found')
        return
      }
      try {
        const v = await probeProcess(currentBin, ['--version'], 10_000, undefined, undefined, getConfig().suppressAgyAutoUpdate)
        services.status.version = parseVersion(v.stdout)
        if (services.status.version && compareVersions(services.status.version, MIN_AGY_VERSION) < 0) {
          services.status.dormantReason = 'agy ' + services.status.version + ' is older than ' + MIN_AGY_VERSION + ' — run: agy update'
          log('dormant: ' + services.status.dormantReason)
          return
        }
        services.status.dormantReason = null
        log('agy detected: ' + (services.status.version ?? 'unknown version'))
      } catch {
        log('version probe failed — continuing with fallback catalog')
      }
      await catalog.refreshIfNeeded().catch(() => undefined)
      notifyPicker()
    })();
  }, 4_000)
  bootProbeTimer.unref?.()
  ctx.effect(() => () => clearTimeout(bootProbeTimer))

  // Catalog freshness without probing from listModels(): refreshIfNeeded()
  // honours its TTL, so this costs at most one `agy models` spawn per window
  // and cannot feed back into a listing loop.
  const catalogPollTimer = setInterval(() => {
    void catalog.refreshIfNeeded().catch(() => undefined)
  }, 30 * 60_000)
  catalogPollTimer.unref?.()
  ctx.effect(() => () => clearInterval(catalogPollTimer))

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
      lastRun: () => services.lastRun,
      setOverride,
      sessions: () => (ctx.get('sessions') as any) ?? (ctx as any).sessions,
      runDoctor: async () => {
        return writeDoctorReport({
          cfg: getConfig,
          bin,
          version,
          catalog: () => catalog,
          store: () => store,
          recentLines: () => services.lastParser.recentLines,
          effortUnsupported: () => adapter.effortUnsupportedModels(),
        })
      },
    }),
  )

  // ---- /tsl command (Gemini plain-language translation) ----
  ctx.commands.register(
    tslCommandDefinition({
      cfg: getConfig,
      translate: () => translation,
      setOverride,
      sessionAuto: {
        get: (id) => sessionAuto.get(id),
        set: (id, value) => {
          if (value === undefined) sessionAuto.delete(id)
          else sessionAuto.set(id, value)
        },
      },
      sessions: () => sessionsSvc(),
    }),
  )

  // ---- automatic post-turn translation ----
  // Reacts to the durable turn boundary, never to a render event. The append
  // of the translation record happens after the awaited model call, so it can
  // never reenter the session's publication boundary (Session.append refuses
  // that); a listener must not append synchronously here.
  ctx.effect(() => {
    const unlisten = ctx.on(
      'session/event',
      (subject: unknown, event: unknown) => {
        try {
          const ev = event as { type?: string; data?: { turn?: unknown; reason?: { kind?: string } } } | null
          if (ev === null || ev.type !== 'turn/end') return
          if (ev.data?.reason?.kind !== 'completed') return
          const turn = ev.data?.turn
          if (typeof turn !== 'number') return
          const session = subject as { id?: unknown } | null
          const id = session?.id === undefined || session?.id === null ? '' : String(session.id)
          if (id === '') return
          void translation.autoTranslateTurn(id, turn).catch(() => undefined)
        } catch {
          // contained: a translation failure must never disturb the agent loop
        }
      },
      { global: true },
    )
    return () => {
      if (typeof unlisten === 'function') unlisten()
    }
  })

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
        defineAgyAskTool({
          cfg: getConfig,
          bin,
          catalog: () => catalog.get(),
          effortUnsupported: () => readEffortUnsupported(),
          onEffortUnsupported: (model) => rememberEffortUnsupported(model),
        }),
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

  // The /config route is module-owning, so it calls back through this hook to
  // re-sync the ask/mirror tools after a config write (same as the old inline route).
  services.onConfigWritten = (key, value) => {
    void key
    void value
    syncAskTool()
    syncMirrorTool()
  }

  // ---- HTTP surface for the client half ----
  // Registered through a reactive ctx.inject sub-fiber: at plugin load time
  // the webServer service may not exist yet (load-order race observed on
  // dsh web), and in headless compositions it never does. The sub-fiber
  // starts whenever the service appears and tears the routes down when it
  // goes away. The route bodies themselves live in src/transport/http/routes/*.
  // The deployment anchor is resolved here because only the composition root
  // knows its own location (src/ in dev, dist/ in the bundle).
  services.hostDir = fileURLToPath(new URL('.', import.meta.url))
  ctx.inject(['webServer'], (sub) => {
    const webServer = sub.get('webServer') as WebServerLike | undefined
    if (!webServer) return
    webServerPort.current = (webServer as { port?: number }).port
    return registerRoutes(webServer, services)
  })


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

  // The bridge restore hooks are shared with the pool routes through
  // services.bridgeState (created in services.ts).
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
