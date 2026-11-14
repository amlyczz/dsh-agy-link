// Model listing and metadata resolution for the Antigravity route.
//
// Extracted verbatim from AgyAdapter.listModels / resolveModel /
// getActiveAccount so the adapter keeps only thin override delegates. The
// behaviour (union catalog across enabled pool accounts, hidden-model filter,
// advisory effort levels minus learned refusals) is unchanged.
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { accountSupportsModel, type ManagedAccount } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import { defaultEffortFor, findEntry, sanitizeCatalogEntries, type CatalogEntry, type ModelCatalog } from '../host/models.ts'
import { effortLabel, normalizeEfforts } from '../common/reasoning.ts'

/** What model resolution needs from the adapter. */
export interface ModelResolutionDeps {
  catalog: ModelCatalog
  pool?: AccountPoolManager
  getConfig: () => PluginConfig
  isEffortUnsupported: (model: string) => boolean
  warnOnce: (key: string, message: string) => void
}

export function activeAccount(deps: ModelResolutionDeps): ManagedAccount | undefined {
  const pool = deps.pool
  if (!pool) return undefined
  const activeId = pool.getActiveAccountId('google') ?? pool.getPoolData().lastActiveAccountId ?? pool.getPoolData().primaryAccountId
  return activeId ? pool.getAccount(activeId) : undefined
}

export function listAvailableModels(deps: ModelResolutionDeps): readonly LlmModelInfo[] {
  const pool = deps.pool
  const accounts = pool ? pool.getAccounts().filter((a) => a.enabled) : []
  const cfg = deps.getConfig()
  const activeAcc = activeAccount(deps)

  // Default (issue #106 / v0.6.21 isolation): the picker shows only the models
  // the ACTIVE account supports. With `poolWideCatalog` the picker shows the
  // union across enabled accounts instead — the scheduler already routes by
  // `selectAccount(family, model)` (PR #100), so a model owned by another
  // account is served by that account without a manual switch (issue #107).
  let models: readonly CatalogEntry[]
  if (activeAcc && pool && !cfg.poolWideCatalog) {
    models = deps.catalog.getModelsForAccount(activeAcc, pool)
    if (!deps.catalog.hasAccountCatalog(activeAcc.id)) {
      // Read path: throttled, change-only announcements. Never use the
      // always-broadcasting account-switch path here (issue #106).
      void deps.catalog.ensureAccountCatalog(activeAcc.id).catch(() => undefined)
    }
  } else {
    models = deps.catalog.getUnion(accounts, pool)
  }

  const { entries, dropped } = sanitizeCatalogEntries(models)
  if (dropped.length > 0) {
    deps.warnOnce(
      'catalog-dupes',
      'model catalog contained duplicate ids [' + dropped.join(', ') + '] — kept first occurrence so DSH does not drop the whole provider group (INVALID_CATALOG)',
    )
  }
  const hidden = new Set(cfg.hiddenModels.map((s) => s.trim()))
  return entries
    .filter((m) => !hidden.has(m.id))
    .map((m) => ({
      provider: PROVIDER_ID,
      id: m.id,
      name: m.name,
      inputModalities: ['text', 'image'] as const,
    }))
}

export function resolveModelInfo(deps: ModelResolutionDeps, model: string): LlmResolvedModelInfo {
  const pool = deps.pool
  const activeAcc = activeAccount(deps)
  const cfg = deps.getConfig()
  const accounts = pool ? pool.getAccounts().filter((a) => a.enabled) : []
  const rawModel = typeof model === 'string' ? model.trim() : ''
  const cleanId = rawModel !== '' ? rawModel : cfg.defaultModel

  const unionModels = deps.catalog.getUnion(accounts, pool)
  const allModels = deps.catalog.getAllKnownModels(accounts)
  const entry = unionModels.find((m) => m.id === cleanId)
    ?? allModels.find((m) => m.id === cleanId)
    ?? findEntry(deps.catalog.get(activeAcc?.id), cleanId)
    ?? findEntry(deps.catalog.get(), cleanId)
  const rawName = entry ? entry.name : cleanId
  const name = (typeof rawName === 'string' && rawName.trim() !== '') ? rawName.trim() : cleanId
  const contextWindow = typeof cfg.contextWindowDefault === 'number' && cfg.contextWindowDefault > 0 ? cfg.contextWindowDefault : 200_000
  const resolved: LlmResolvedModelInfo = {
    provider: PROVIDER_ID,
    id: cleanId,
    name,
    inputModalities: ['text', 'image'] as const,
    context: { contextWindow },
    defaultMaxTokens: typeof cfg.maxTokensDefault === 'number' && cfg.maxTokensDefault > 0 ? cfg.maxTokensDefault : 8192,
  }
  if (deps.isEffortUnsupported(cleanId)) {
    // Learned refusal (issue #67): do not offer levels the model rejects.
  } else if (entry && Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    // Canonical order + agy's own display names (agy's picker calls `xhigh`
    // "Extra"), so the menu reads exactly like agy's model submenu.
    const cleanEfforts = normalizeEfforts(entry.efforts)
    if (cleanEfforts.length > 0) {
      const def = defaultEffortFor({ ...entry, efforts: cleanEfforts }, cfg)
      const validDef = def && cleanEfforts.includes(def) ? def : cleanEfforts[0]
      resolved.reasoning = {
        efforts: cleanEfforts.map((e) => ({ id: e as never, name: effortLabel(e) })),
        ...(validDef ? { defaultEffort: validDef as never } : {}),
      }
    }
  }
  return resolved
}