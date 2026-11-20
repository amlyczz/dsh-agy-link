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
import { mergeCatalogWithQuotaModels, quotaCatalogForAccount } from '../domain/models/quota-catalog.ts'

/** One picker row after sanitizing (efforts are always a concrete array). */
type SanitizedEntry = { id: string; name: string; efforts: string[] }

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
  const quotaScoped = quotaScopeAccounts(pool, accounts, activeAcc, cfg.poolWideCatalog)
  const visible = visibleEntries(entries, quotaScoped, cfg)
  return visible.map((m) => ({
    provider: PROVIDER_ID,
    id: m.id,
    name: m.name,
    inputModalities: ['text', 'image'] as const,
  }))
}

/**
 * Accounts whose quota snapshots describe models the picker may offer.
 *
 * Narrow mode (default) describes ONE account — the same account whose `agy
 * models` catalog the picker is showing, so the two sources never contradict
 * each other. Pool-wide mode describes every enabled account because the
 * scheduler can route to any of them (issue #107).
 */
function quotaScopeAccounts(
  pool: ModelResolutionDeps['pool'],
  accounts: readonly ManagedAccount[],
  activeAcc: ManagedAccount | undefined,
  poolWide: boolean,
): readonly ManagedAccount[] {
  if (!pool) return []
  if (poolWide) return accounts
  if (activeAcc) return [activeAcc]
  return accounts.slice(0, 1)
}

/**
 * Fold quota-derived models into the catalog and apply BOTH visibility filters.
 *
 * Quota rows are merged in because a host without the agy CLI only ever has the
 * static fallback catalog, while every quota refresh already stored the real
 * per-account model list — that list is what makes the picker useful at all
 * (issue #131). Merge, don't replace: `agy models` stays authoritative for the
 * models it knows about.
 *
 * Visibility order is allow-list THEN deny-list: `selectedModels` is the
 * checkbox state the settings panel writes, `hiddenModels` remains the older
 * deny-list (env/config escape hatch) and still wins on a conflict so an
 * operator can hide a model without editing the selection.
 */
function visibleEntries(
  entries: readonly SanitizedEntry[],
  quotaScope: readonly ManagedAccount[],
  cfg: PluginConfig,
): readonly CatalogEntry[] {
  const quota = quotaCatalogForAccounts(quotaScope)
  const merged = mergeCatalogWithQuotaModels(entries, quota)
  const selected = new Set(cfg.selectedModels.map((s) => s.trim()).filter((s) => s !== ''))
  const hidden = new Set(cfg.hiddenModels.map((s) => s.trim()))
  return merged.filter((m) => (selected.size === 0 || selected.has(m.id)) && !hidden.has(m.id))
}

/** Union of the quota-derived catalogs of several accounts, first label wins. */
function quotaCatalogForAccounts(accounts: readonly ManagedAccount[]): CatalogEntry[] {
  const out: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const acc of accounts) {
    for (const entry of quotaCatalogForAccount(acc)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push(entry)
    }
  }
  return out
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
    // A model may only be known from a quota snapshot (CLI-less host, issue
    // #131). Resolution must still find it — an in-flight conversation keeps
    // working after the user unticks it in the settings panel.
    ?? quotaCatalogForAccounts(quotaScopeAccounts(pool, accounts, activeAcc, cfg.poolWideCatalog)).find((m) => m.id === cleanId)
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