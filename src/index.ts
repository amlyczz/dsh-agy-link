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
import { AUTH_FAST_REVERIFY_MS } from './common/pool-types.ts'
import { defineAgyAskTool } from './host/ask-tool.ts'
import { defineAgyImageTool } from './host/image-tool.ts'
import { agyCommandDefinition, buildAgyCommandDeps } from './host/commands.ts'
import { agySlashCommandDefinitions } from './host/agy-slash-commands.ts'
import { btwCommandDefinition } from './host/btw-command.ts'
import { tslCommandDefinition } from './host/tsl-command.ts'
import { defineAgyMirrorTool, MIRROR_TOOL_NAME } from './host/mirror-tool.ts'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { MIN_AGY_VERSION, compareVersions, isolatedHomeEnv } from './host/runner.ts'
import { agyNotInstalledMessage } from './provider/call-context.ts'
import { sweepDir } from './host/media.ts'
import { agyMcpConfigPath, registerBridgeMcpConfig, startMcpBridge, teardownBridgeState, type ToolsServiceLike } from './host/mcp-bridge.ts'
import { observeBridgeAssemblies } from './host/bridge-steps.ts'
import type { GoalServiceLike } from './host/commands/shared.ts'
import { runBootHygiene } from './host/boot-hygiene.ts'
import { scheduleBootMaintenance } from './host/boot-maintenance.ts'
import { closeProxyAgents } from './host/net.ts'
import { setRuntimeAgyVersion } from './host/oauth.ts'
import { createHostServices } from './host/services.ts'
import { registerRoutes, type WebServerLike } from './transport/http/router.ts'

export const name = 'dsh-agy-link'
// webServer and tools are optional: the plugin loads headless too.
export const inject = ['llm', 'commands']

export function apply(ctx: Context, entryConfig: Record<string, unknown> = {}): void {
  const services = createHostServices(ctx, entryConfig)
  const {
    getConfig, log, bin, version, store, pool, quota, warmup, catalog, auth, poolAuth, runs,
    adapter, acpPool, ecosystem, imageService, translation, btw, setOverride, notifyPicker, readEffortUnsupported, rememberEffortUnsupported,
    sessionsSvc, sessionAuto, mediaDir, bridgeState, webServerPort,
  } = services

  observeBridgeAssemblies(ctx, services.bridgeSteps, () => bridgeState.bridge !== null)

  // Boot-time pool/store hygiene: stale staging logs, keychains, credential slot.
  runBootHygiene(services)

  // Everything expensive (staging/log sweeps, the ecosystem mirror, stale presence
  // locks, orphaned MCP servers) is deferred to one idle pass: a pool of 8 accounts
  // otherwise pays hundreds of file stats plus a full copy per account before the
  // first frame, and leaves the previous run's MCP children behind.
  const stopBootMaintenance = scheduleBootMaintenance({
    accounts: () => services.pool.getAccounts(),
    sweepStaging: () => services.pool.sweepStaleStaging(),
    sweepLogs: () => services.pool.sweepOldLogs(getConfig().logRetentionDays),
    ...(getConfig().syncAccountCustomizations ? { syncEcosystem: () => services.ecosystem?.syncAll() } : {}),
    log,
    reapOrphans: getConfig().reapOrphanMcp,
  })
  ctx.effect(() => () => stopBootMaintenance())

  // Track version probe completion so the 5s boot quota refresh never races
  // `agy --version` (preventing fallback UA version skew on the first poll).
  let versionProbePromise: Promise<void> | null = null

  // ---- dormant detection + background probes ----
  // Boot probes are deliberately cheap and deferrable. Every `agy` spawn costs
  // a process, a credential-slot read and (for `models`) a full MCP-server boot
  // storm from the user's own registry, so a probe must never run while a real
  // turn is in flight and must never fan out over the whole pool.
  //
  // Before this guard the boot path was: 4s timer -> `agy --version` ->
  // `agy models` (~4.6s, forking every MCP server) -> warmAccounts(8). Eight
  // accounts meant tens of seconds of background churn on every DSH start, on
  // top of the MCP processes it orphaned. Now the probe waits for an idle
  // moment, refreshes only the ACTIVE account eagerly, and leaves every other
  // account lazy (ensureAccountCatalog loads it on first use) unless the
  // opt-in pool-wide catalog actually needs them.
  const BOOT_PROBE_DELAY_MS = 4_000
  const BOOT_PROBE_RETRY_MS = 20_000
  let bootProbeTimer: ReturnType<typeof setTimeout> | null = null
  let bootProbeAttempts = 0
  let bootProbeStopped = false

  const runBootProbe = async (): Promise<void> => {
    if (!getConfig().enabled) {
      services.status.dormantReason = 'disabled by config'
      log('dormant: disabled by config')
      return
    }
    const currentBin = bin()
    if (!currentBin) {
      // Same actionable wording as the turn-level error: the badge shows this
      // string, so it must say where we looked and how to point us at a
      // binary installed outside the probed locations.
      services.status.dormantReason = agyNotInstalledMessage(getConfig())
      log('dormant: agy binary not found')
      return
    }
    versionProbePromise = (async () => {
      try {
        services.status.version = await services.resolveVersion()
        setRuntimeAgyVersion(services.status.version)
        catalog.syncAgyVersion(services.status.version)
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
    })()
    await versionProbePromise
    if (services.status.dormantReason !== null) return

    const poolData = services.pool.getPoolData()
    const activeId = services.pool.getActiveAccountId('google') ?? poolData.lastActiveAccountId ?? poolData.primaryAccountId
    // ONE spawn for the account the picker actually shows.
    await catalog.refreshIfNeeded(activeId).catch(() => undefined)
    notifyPicker()
    // Only the opt-in pool-wide catalog needs every account discovered; the
    // per-account rows otherwise load lazily on first use, so we never pay
    // N x (agy models + MCP boot storm) at startup again.
    if (getConfig().poolWideCatalog) {
      void catalog.warmAccounts(services.pool.getAccounts()).catch(() => undefined)
    }
  }

  const scheduleBootProbe = (delayMs: number): void => {
    if (bootProbeStopped) return
    bootProbeTimer = setTimeout(() => {
      // A turn is running: come back later instead of competing with it for the
      // spawn slot, the credential slot, and the user's first token.
      if (bootProbeAttempts < 30 && services.adapter.activeRunCount() > 0) {
        bootProbeAttempts++
        scheduleBootProbe(BOOT_PROBE_RETRY_MS)
        return
      }
      void runBootProbe()
    }, delayMs)
    bootProbeTimer.unref?.()
  }

  scheduleBootProbe(BOOT_PROBE_DELAY_MS)
  ctx.effect(() => () => {
    bootProbeStopped = true
    if (bootProbeTimer !== null) clearTimeout(bootProbeTimer)
  })

  // Catalog freshness without probing from listModels(): refreshIfNeeded()
  // honours its TTL, so this costs at most one `agy models` spawn per window
  // and cannot feed back into a listing loop.
  const catalogPollTimer = setInterval(() => {
    const activeId = services.pool.getActiveAccountId('google')
    void catalog.refreshIfNeeded(activeId).catch(() => undefined)
  }, 30 * 60_000)
  catalogPollTimer.unref?.()
  ctx.effect(() => () => clearInterval(catalogPollTimer))

  // ---- llm registration (dormant-safe + runtime toggleable) ----
  let adapterHandle: { replace?: (providers: string[]) => void; dispose?: () => void } | null = null
  const syncAdapterRegistration = (): void => {
    const want = getConfig().enabled
    if (want) {
      if (adapterHandle === null) {
        try {
          adapterHandle = (ctx.llm.registerAdapter([PROVIDER_ID], adapter) as unknown as typeof adapterHandle) ?? {}
          log('registered provider route: ' + PROVIDER_ID)
        } catch (e) {
          log('adapter registration failed: ' + String(e))
        }
      } else if (typeof adapterHandle.replace === 'function') {
        adapterHandle.replace([PROVIDER_ID])
      }
    } else if (adapterHandle !== null) {
      if (typeof adapterHandle.replace === 'function') {
        adapterHandle.replace([])
      } else if (typeof adapterHandle.dispose === 'function') {
        adapterHandle.dispose()
        adapterHandle = null
      }
    }
  }
  syncAdapterRegistration()
  // NOTE: no registerConfigurableProviders call. This plugin configures
  // through its own cordis entry (enabled/agyBin/mode/...), not the llm
  // settings directory; registering here would put an unconfigured
  // antigravity into the provider-add list and confuse the UI state.

  // ---- /agy, /tsl, /atw, and full a-prefix slash bridge commands ----
  const agyDeps = buildAgyCommandDeps({
    services,
    goals: () => (ctx.get('goals') as GoalServiceLike | undefined) ?? ((ctx as unknown as { goals?: GoalServiceLike }).goals),
    agents: () => (ctx.get('agents') as { get(id: unknown): unknown } | undefined) ?? ((ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents),
  })
  ctx.commands.register(agyCommandDefinition(agyDeps))
  for (const def of agySlashCommandDefinitions({
    deps: () => agyDeps,
    armForcedPlan: services.armForcedPlan,
    planMode: () => ctx.get('planMode' as never) as { enter?: (agent: unknown) => unknown } | undefined,
  })) {
    ctx.commands.register(def)
  }

  // Opt-out (issue #201): a user who already runs a dedicated /btw plugin can
  // turn this one off so the two never compete for a command name. Read at
  // registration time, so the switch takes effect on the next start.
  if (getConfig().btwEnabled !== false) {
    ctx.commands.register(
      btwCommandDefinition({
        btw: () => btw,
        isWebActive: () => webServerPort.current !== undefined,
      }),
    )
  }

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
  let pluginDisposing = false
  const toolsSvcRef: { current: { register: (t: unknown) => unknown; get?: (name: string, scope?: unknown) => unknown } | null } = { current: null }
  const askToolDispose = { current: null as null | (() => void) }
  const imageToolDispose = { current: null as null | (() => void) }
  const mirrorToolDispose = { current: null as null | (() => void) }
  const preExecuteDispose = { current: null as null | (() => void) }
  const resolveAgentsSvc = (): { get(id: unknown): unknown } | undefined => {
    const svc = ctx.get('agents') as { get(id: unknown): unknown } | undefined
    return svc ?? (ctx as unknown as { agents?: { get(id: unknown): unknown } }).agents
  }
  // Live liveness gate for AgyAdapter / EventMapper: never emit an `agy_tool`
  // tool-call while the plugin is disposing, before `tools` has mounted, or
  // when an agent scope's `tools.restrict({ allow })` hides `agy_tool`.
  services.setMirrorToolCheck((sessionId?: string): boolean => {
    if (pluginDisposing || mirrorToolDispose.current === null || toolsSvcRef.current === null) {
      return false
    }
    if (typeof toolsSvcRef.current.get === 'function') {
      try {
        const agent = sessionId ? resolveAgentsSvc()?.get(sessionId) : undefined
        return toolsSvcRef.current.get(MIRROR_TOOL_NAME, agent) !== undefined
      } catch {
        return true
      }
    }
    return true
  })
  const syncAskTool = (): void => {
    const want = getConfig().askTool && bin() !== null
    if (want && askToolDispose.current === null && toolsSvcRef.current) {
      const reg = toolsSvcRef.current.register(
        defineAgyAskTool({
          cfg: getConfig,
          bin,
          pool: () => pool,
          acquire: (sig) => services.semaphore.acquire(sig),
          log,
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
  const syncImageTool = (): void => {
    const want = getConfig().enabled && getConfig().imageTool && bin() !== null
    if (want && imageToolDispose.current === null && toolsSvcRef.current) {
      const reg = toolsSvcRef.current.register(
        defineAgyImageTool({
          imageService: () => imageService,
          log,
        }),
      ) as unknown as () => void
      imageToolDispose.current = typeof reg === 'function' ? reg : null
    } else if (!want && imageToolDispose.current !== null) {
      imageToolDispose.current()
      imageToolDispose.current = null
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
    syncImageTool()
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
      if (imageToolDispose.current !== null) imageToolDispose.current()
      imageToolDispose.current = null
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
    syncAdapterRegistration()
    syncAskTool()
    syncImageTool()
    syncMirrorTool()
    syncMcpBridge()
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
  // (default 60 min via quotaPollIntervalMs, configurable at runtime through
  // the settings route / `/agy config quota-poll`, clamped to at least 60s).
  // The account currently in use is additionally refreshed as soon as it
  // settles a run (see quota/freshness.ts), so the panel is not stuck on the
  // hourly snapshot. Restricted
  // accounts (cooldown / auth-quarantined) are skipped by refreshAllQuotas.
  // Background quota refresh: 5s boot pass awaits `versionProbePromise` if in
  // flight so User-Agent carries the detected agy version from the first poll.
  ctx.effect(() => {
    if (!getConfig().enabled) return () => undefined
    const refresh = (): void => {
      if (!getConfig().enabled) return
      void (async () => {
        if (versionProbePromise) await versionProbePromise.catch(() => undefined)
        const prevArgon = pool.getAccounts().map((a) => Boolean(a.quotas?.argon)).join(',')
        await quota.refreshAllQuotas()
        const nextArgon = pool.getAccounts().map((a) => Boolean(a.quotas?.argon)).join(',')
        if (prevArgon !== nextArgon) notifyPicker()
      })().catch(() => undefined)
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

  // Fast self-heal for 需重新登录 flags; only flags past their own back-off run.
  ctx.effect(() => {
    if (!getConfig().enabled) return () => undefined
    let running = false
    const timer = setInterval(() => {
      if (running || !getConfig().enabled) return
      running = true
      void quota.reverifyFlaggedAccounts().catch(() => undefined).finally(() => { running = false })
    }, AUTH_FAST_REVERIFY_MS)
    timer.unref?.(); return () => clearInterval(timer)
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
  let bridgeStarting = false
  const syncMcpBridge = (): void => {
    const cfg = getConfig()
    const want = cfg.mcpBridge && cfg.enabled
    if (want && bridgeState.bridge === null && !bridgeStarting) {
      bridgeStarting = true
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
            scope: () => getConfig().mcpBridgeScope,
            resolveStep: token => services.bridgeSteps.resolve(token),
            log,
          })
          // A scope can be disposed before asynchronous listener startup ends.
          // Do not publish a capability or registry configs after disposal.
          const current = getConfig()
          if (bridgeDisposed || !current.enabled || !current.mcpBridge) {
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
          for (const file of uniqueTargets) registerBridgeMcpConfig(bridgeState, file)
          log('mcp bridge ready at ' + bridge.url + ' (registries: ' + uniqueTargets.join(', ') + ')' + (toolsSvc ? '' : ' (tools service not yet available)'))
        } catch (e) {
          await teardownBridgeState(bridgeState)
          log('mcp bridge failed to start: ' + String(e))
        } finally {
          bridgeStarting = false
        }
      })()
    } else if (!want && bridgeState.bridge !== null) {
      void teardownBridgeState(bridgeState)
    }
  }
  syncMcpBridge()

  ctx.effect(() => {
    return () => {
      // Flip BEFORE tearing down ACP/tools so any trailing tool event flushed
      // by disposal cannot emit a doomed `agy_tool` call (`UNKNOWN_TOOL`).
      pluginDisposing = true
      bridgeDisposed = true
      services.backgroundWakeup.dispose()
      services.quotaRefresher?.dispose()
      services.translationWorkers?.dispose()
      services.btw.dispose()
      acpPool.dispose()
      auth.dispose()
      void poolAuth.cancel()
      if (askToolDispose.current !== null) askToolDispose.current()
      if (imageToolDispose.current !== null) imageToolDispose.current()
      if (mirrorToolDispose.current !== null) mirrorToolDispose.current()
      void teardownBridgeState(bridgeState)
      void closeProxyAgents()
    }
  })
}
