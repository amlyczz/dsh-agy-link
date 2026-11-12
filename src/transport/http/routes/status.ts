import type { HostServices } from '../../../host/services.ts'
import { sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'
import { sanitizeCatalogEntries } from '../../../host/models.ts'
import { accountSupportsModel } from '../../../common/pool-types.ts'

function handleStatus(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, bin, store, pool, catalog, auth, poolAuth, adapter, translation, lastRun } = services
  const { version: versionCache, dormantReason } = services.status
      void (async () => {
        const cfg = getConfig()
        const cat = catalog.get()
        const allKnown = catalog.getAllKnownModels(pool?.getAccounts ? pool.getAccounts() : [])
        const poolData = pool?.getPoolData ? pool.getPoolData(cfg.proxyUrl?.trim() || undefined) : undefined
        const activeId = (typeof pool?.getActiveAccountId === 'function')
          ? pool.getActiveAccountId('google')
          : (poolData?.lastActiveAccountId ?? poolData?.primaryAccountId)
        const activeAcc = (activeId && typeof pool?.getAccount === 'function') ? pool.getAccount(activeId) : undefined
        const supportedModels = (activeAcc && pool)
          ? allKnown.filter((m) => {
              if (typeof (pool as any).isModelSupported === 'function') {
                return (pool as any).isModelSupported(activeAcc, m.id)
              }
              return accountSupportsModel(activeAcc, m.id, pool, catalog.get(activeAcc.id))
            })
          : allKnown
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
          pool: poolData,
          catalog: { source: cat.source, count: cat.models.length, lastError: cat.lastError ?? null },
          // Dynamically reflects models supported by the currently active account (e.g. hides Argon when active lacks Argon)
          catalogModels: sanitizeCatalogEntries(supportedModels).entries,
          hiddenModels: cfg.hiddenModels,
          autoWarmup: cfg.autoWarmup,
          warmupModels: cfg.warmupModels,
          autoTranslate: cfg.autoTranslate,
          translateModel: cfg.translateModel,
          translateEffort: cfg.translateEffort,
          translateTargetLanguage: cfg.translateTargetLanguage,
          imageModel: cfg.imageModel,
          imageEffort: cfg.imageEffort,
          imageOutputDir: cfg.imageOutputDir,
          translateState: { pending: translation.pendingFor(), stats: translation.stats() },
          bindings: Object.keys(store.all()).length,
          effortUnsupported: adapter.effortUnsupportedModels(),
              lastRun,
        })
      })()
}

export function register(reg: RouteRegistrar, services: HostServices): void {
  reg({ kind: 'exact', path: '/plugins/agy-link/status', handler: (req, res) => handleStatus(services, req, res) })
}
