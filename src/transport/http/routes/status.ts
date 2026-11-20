import type { HostServices } from '../../../host/services.ts'
import { runRoute, sendJsonWithEtag, type RawRes, type RouteRegistrar } from '../respond.ts'
import { sanitizeCatalogEntries } from '../../../host/models.ts'

function handleStatus(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, bin, store, pool, quota, catalog, auth, poolAuth, adapter, translation, lastRun } = services
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
        const sanitizedCatalogModels = sanitizeCatalogEntries(supportedModels).entries
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
        sendJsonWithEtag(req, res as RawRes, 200, {
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
          pool: poolData,
          // Real in-flight refreshes. The client used to derive "syncing" from
          // its own click, which cleared the moment the route answered — so a
          // ~55s serial cascade showed no progress at all.
          quotaRefreshing: typeof quota?.refreshingAccounts === 'function' ? quota.refreshingAccounts() : [],
          catalog: { source: activeCat.source, count: catalogCount, lastError: activeCat.lastError ?? cat.lastError ?? null },
          // Dynamically reflects models supported by the currently active account (e.g. hides Argon when active lacks Argon)
          catalogModels: sanitizedCatalogModels,
          accountModels,
          hiddenModels: cfg.hiddenModels,
          autoWarmup: cfg.autoWarmup,
          warmupModels: cfg.warmupModels,
          autoTranslate: cfg.autoTranslate,
          translateModel: cfg.translateModel,
          translateEffort: cfg.translateEffort,
          translateTargetLanguage: cfg.translateTargetLanguage,
          showHeaderBadge: cfg.showHeaderBadge,
          showTranslateAction: cfg.showTranslateAction,
          poolWideCatalog: cfg.poolWideCatalog,
          imageModel: cfg.imageModel,
          imageEffort: cfg.imageEffort,
          imageOutputDir: cfg.imageOutputDir,
          translateState: { pending: translation.pendingFor(), stats: translation.stats() },
          bindings: Object.keys(store.all()).length,
          effortUnsupported: adapter.effortUnsupportedModels(),
              lastRun,
        })
      })
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/status', handler: (req, res) => handleStatus(services, req, res) })
}
