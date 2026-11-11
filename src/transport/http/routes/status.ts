import type { HostServices } from '../../../host/services.ts'
import { sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'
import { sanitizeCatalogEntries } from '../../../host/models.ts'

function handleStatus(services: HostServices, req: unknown, res: unknown): void {
  const { getConfig, bin, store, pool, catalog, auth, poolAuth, adapter, translation, lastRun } = services
  const { version: versionCache, dormantReason } = services.status
      void (async () => {
        const cfg = getConfig()
        const cat = catalog.get()
        const allKnown = catalog.getAllKnownModels(pool.getAccounts())
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
          // Full sanitized catalog (complete superset) + the current deny-list so the settings UI's
          // model-visibility toggles show every known model, hidden ones included.
          catalogModels: sanitizeCatalogEntries(allKnown).entries,
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
