import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJsonWithEtag, type RawRes, type RouteRegistrar } from '../respond.ts'
import { sanitizeCatalogEntries } from '../../../host/models.ts'
import { mergeCatalogWithQuotaModels, quotaCatalogForAccount } from '../../../domain/models/quota-catalog.ts'
import type { ManagedAccount } from '../../../common/pool-types.ts'
import { cacheMetrics } from '../../../host/cache-metrics.ts'
import { snapshotSubagents } from '../../../features/subagent/live.ts'

/**
 * The selectable universe the Settings ticks describe.
 *
 * Deliberately UNFILTERED by `selectedModels`/`hiddenModels`: unticking a model
 * must stay reversible, so the panel always receives the full set and knows the
 * current selection separately. Quota-derived models are merged in because a
 * host without the agy CLI has only the static fallback catalog while the
 * account's own quota snapshot already lists the real models (issue #131).
 */
function selectableModels(
  supportedModels: Parameters<typeof sanitizeCatalogEntries>[0],
  quotaScope: readonly ManagedAccount[],
): Array<{ id: string; name: string; efforts: string[] }> {
  const quota = quotaScope.flatMap((acc) => quotaCatalogForAccount(acc))
  return sanitizeCatalogEntries(mergeCatalogWithQuotaModels(sanitizeCatalogEntries(supportedModels).entries, quota)).entries
}

function handleStatus(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, bin, store, pool, quota, warmup, catalog, auth, poolAuth, adapter, acpPool, backgroundWakeup, translation, lastRun } = services
  const { version: versionCache, dormantReason } = services.status
      runRoute(res, async () => {
        const cfg = getConfig()
        const cat = catalog.get()
        const poolData = pool?.getPoolData ? pool.getPoolData(cfg.proxyUrl?.trim() || undefined) : undefined
        const activeId = (typeof pool?.getActiveAccountId === 'function')
          ? pool.getActiveAccountId('google')
          : (poolData?.lastActiveAccountId ?? poolData?.primaryAccountId)
        const activeAcc = (activeId && typeof pool?.getAccount === 'function') ? pool.getAccount(activeId) : undefined
        // The Settings chips must describe the SAME set the picker offers: with
        // `poolWideCatalog` enabled, show the union instead of the active
        // account's catalog (issue #107).
        let supportedModels: ReturnType<typeof catalog.getModelsForAccount>
        if (cfg.poolWideCatalog || !activeAcc || !pool || typeof catalog.getModelsForAccount !== 'function') {
          supportedModels = typeof catalog.getUnion === 'function'
            ? catalog.getUnion(pool?.getAccounts ? pool.getAccounts() : [], pool)
            : (typeof catalog.getAllKnownModels === 'function'
                ? catalog.getAllKnownModels(pool?.getAccounts ? pool.getAccounts() : [])
                : (catalog.get().models ?? []))
        } else {
          supportedModels = catalog.getModelsForAccount(activeAcc, pool)
        }
        // Same account scope the picker merges quota rows for, so the panel and
        // the picker never disagree about which models exist.
        const allAccounts = typeof pool?.getAccounts === 'function' ? pool.getAccounts() : []
        const quotaScope = cfg.poolWideCatalog ? allAccounts : (activeAcc ? [activeAcc] : allAccounts.slice(0, 1))
        const sanitizedCatalogModels = selectableModels(supportedModels, quotaScope)
        const activeCat = (!cfg.poolWideCatalog && activeAcc && typeof catalog.getAccountCatalog === 'function')
          ? (catalog.getAccountCatalog(activeAcc.id) ?? cat)
          : cat
        const catalogCount = typeof catalog.getModelsForAccount === 'function'
          ? sanitizedCatalogModels.length
          : activeCat.models.length
        const accountModels: Record<string, Array<{ id: string; name: string; efforts: string[] }>> = {}
        if (typeof catalog.getAccountCatalog === 'function') {
          for (const acc of poolData?.accounts ?? []) {
            const accCat = catalog.getAccountCatalog(acc.id)
            if (accCat && accCat.source === 'discovered' && accCat.models.length > 0) {
              accountModels[acc.id] = sanitizeCatalogEntries(accCat.models).entries
            }
          }
        }
        const rawAcpStatus = typeof acpPool?.status === 'function' ? acpPool.status() : null
        const acpStatus = rawAcpStatus && typeof rawAcpStatus === 'object' && 'availableCommands' in rawAcpStatus
          ? (({ availableCommands: _omit, ...rest }) => rest)(rawAcpStatus as Record<string, unknown>)
          : rawAcpStatus
        sendJsonWithEtag(req, res as RawRes, 200, {
          plugin: 'dsh-agy-link',
          bin: bin(),
          version: versionCache,
          dormantReason,
          enabled: cfg.enabled,
          permissionMode: cfg.permissionMode,
          sandbox: cfg.sandbox,
          agent: cfg.agent,
          agySettings: cfg.agySettings,
          transport: cfg.transport,
          acpStatus,
          backgroundWakeup: cfg.backgroundWakeup,
          mcpBridge: cfg.mcpBridge,
          mcpBridgeScope: cfg.mcpBridgeScope,
          bridgeDiagnostic: adapter.bridgeDiagnostic ?? null,
          backgroundWakeupTtlMinutes: cfg.backgroundWakeupTtlMinutes,
          backgroundWakeupMaxPerSession: cfg.backgroundWakeupMaxPerSession,
          backgroundWakeState: typeof backgroundWakeup?.status === 'function' ? backgroundWakeup.status() : null,
          imageTool: cfg.imageTool,
          syncAccountCustomizations: cfg.syncAccountCustomizations,
          workspaceRoot: cfg.workspaceRoot,
          defaultModel: cfg.defaultModel,
          defaultEffort: cfg.defaultEffort,
          orchestratorPlannerModel: cfg.orchestratorPlannerModel,
          orchestratorPlannerEffort: cfg.orchestratorPlannerEffort,
          orchestratorExecutorModel: cfg.orchestratorExecutorModel,
          orchestratorExecutorEffort: cfg.orchestratorExecutorEffort,
          askTool: cfg.askTool,
          auth: auth.status(),
          poolAuth: poolAuth.status(),
          pool: poolData,
          // Real in-flight refreshes. The client used to derive "syncing" from
          // its own click, which cleared the moment the route answered — so a
          // ~55s serial cascade showed no progress at all.
          quotaRefreshing: typeof quota?.refreshingAccounts === 'function' ? quota.refreshingAccounts() : [],
          warmupState: typeof warmup?.status === 'function' ? warmup.status() : null,
          // Live agy-internal subagents per session (header badge). Empty when idle.
          subagents: snapshotSubagents(),
          catalog: { source: activeCat.source, count: catalogCount, lastError: activeCat.lastError ?? cat.lastError ?? null },
          // Dynamically reflects models supported by the currently active account (e.g. hides Argon when active lacks Argon)
          catalogModels: sanitizedCatalogModels,
          accountModels,
          hiddenModels: cfg.hiddenModels,
          selectedModels: cfg.selectedModels,
          autoWarmup: cfg.autoWarmup,
          warmupModels: cfg.warmupModels,
          warmupWindows: cfg.warmupWindows,
          warmupMaxProbesPerRun: cfg.warmupMaxProbesPerRun,
          autoTranslate: cfg.autoTranslate,
          translateDisplay: cfg.translateDisplay,
          translateModel: cfg.translateModel,
          translateEffort: cfg.translateEffort,
          translateTargetLanguage: cfg.translateTargetLanguage,
          showHeaderBadge: cfg.showHeaderBadge,
          showTranslateAction: cfg.showTranslateAction,
          poolWideCatalog: cfg.poolWideCatalog,
          imageModel: cfg.imageModel,
          imageEffort: cfg.imageEffort,
          imageOutputDir: cfg.imageOutputDir,
          btwEnabled: cfg.btwEnabled,
          btwModel: cfg.btwModel,
          btwEffort: cfg.btwEffort,
          translateState: { pending: translation.pendingFor(), stats: translation.stats() },
          bindings: Object.keys(store.all()).length,
          effortUnsupported: adapter.effortUnsupportedModels(),
          cacheStats: cacheMetrics.snapshot(),
              lastRun,
        })
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/status', handler: (req, res) => handleStatus(services, req, res) })
}
