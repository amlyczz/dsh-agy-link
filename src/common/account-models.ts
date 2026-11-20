// Pure per-account model display projection (0 redundancy, zero client->host imports).
// Reconciles each account's real discovered catalog (`agy models`) or raw REST
// quota breakdown into a clean, deduplicated list without effort-tier duplicates
// or internal `-sonar` / `-image` / bare `-tiered` noise.
import { modelFamilyOf, type ManagedAccount, type ModelFamily, type ModelQuotaInfo } from './pool-types.ts'
import { normalizeEfforts, splitEffortSuffix } from './reasoning.ts'

export interface AccountModelCatalogItem {
  id: string
  name: string
  efforts?: readonly string[]
}

export interface AccountModelDisplayItem {
  id: string
  name: string
  family: ModelFamily
  familyLabel: string
  efforts: readonly string[]
  remainingFraction?: number
  resetTime?: string
}

const FAMILY_LABELS: Readonly<Record<ModelFamily, string>> = {
  google: 'Gemini',
  argon: 'Argon',
  anthropic: 'Claude',
  openai: 'OpenAI',
  unknown: 'Other',
}

const QUOTA_FAMILIES: readonly ModelFamily[] = ['google', 'argon', 'anthropic', 'openai']

function familyLabelOf(family: ModelFamily): string {
  return FAMILY_LABELS[family] ?? 'Other'
}

function isInternalNoiseSlug(id: string): boolean {
  const lower = id.trim().toLowerCase()
  return /-sonar$/i.test(lower) || /-image(?:$|-)/i.test(lower)
}

function isEffortFoldableSlug(id: string): boolean {
  const lower = id.trim().toLowerCase()
  return lower.startsWith('gemini') || lower.startsWith('argon') || lower.startsWith('claude')
}

function stripTieredSuffix(id: string): string {
  return id.endsWith('-tiered') && id.length > '-tiered'.length ? id.slice(0, -'-tiered'.length) : id
}

function canonicalQuotaBaseId(rawId: string): { base: string; effort?: string } {
  const trimmed = rawId.trim().toLowerCase()
  if (!isEffortFoldableSlug(trimmed)) return { base: trimmed }
  const split = splitEffortSuffix(trimmed)
  if (split.effort !== undefined) {
    return { base: stripTieredSuffix(split.base), effort: split.effort }
  }
  return { base: stripTieredSuffix(trimmed) }
}

function cleanFallbackDisplayName(rawName: string | undefined, baseId: string, effort?: string): string {
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (name === '' || name.toLowerCase() === baseId.toLowerCase()) return baseId
  let cleaned = name
  if (isEffortFoldableSlug(baseId)) {
    cleaned = cleaned.replace(/\s*\(tiered\)\s*$/i, '').trim()
    if (effort) {
      const effLabel = effort === 'xhigh' ? '(?:xhigh|extra)' : effort
      cleaned = cleaned
        .replace(new RegExp(`\\s*\\(?${effLabel}\\)?\\s*$`, 'i'), '')
        .replace(/\s*\(tiered\)\s*$/i, '')
        .trim()
    }
  }
  return cleaned !== '' ? cleaned : baseId
}

function collectAccountQuotaModels(acc: ManagedAccount): Array<{ family: ModelFamily; model: ModelQuotaInfo }> {
  const out: Array<{ family: ModelFamily; model: ModelQuotaInfo }> = []
  for (const fam of QUOTA_FAMILIES) {
    const models = acc.quotas?.[fam]?.models
    if (!Array.isArray(models)) continue
    for (const model of models) {
      if (model && typeof model.modelId === 'string' && model.modelId.trim() !== '') {
        out.push({ family: fam, model })
      }
    }
  }
  return out
}

function pickQuotaStats(matches: readonly ModelQuotaInfo[]): { remainingFraction?: number; resetTime?: string } {
  let minFrac: number | undefined
  let bestReset: string | undefined
  for (const m of matches) {
    if (typeof m.remainingFraction === 'number' && Number.isFinite(m.remainingFraction)) {
      if (minFrac === undefined || m.remainingFraction < minFrac) {
        minFrac = m.remainingFraction
        if (m.resetTime) bestReset = m.resetTime
      }
    }
    if (!bestReset && m.resetTime) bestReset = m.resetTime
  }
  return {
    ...(minFrac === undefined ? {} : { remainingFraction: minFrac }),
    ...(bestReset ? { resetTime: bestReset } : {}),
  }
}

function projectFromAuthoritativeCatalog(
  acc: ManagedAccount,
  catalogModels: readonly AccountModelCatalogItem[],
): AccountModelDisplayItem[] {
  const quotaModels = collectAccountQuotaModels(acc)
  const seenIds = new Set<string>()
  const rows: AccountModelDisplayItem[] = []
  for (const entry of catalogModels) {
    if (!entry || typeof entry.id !== 'string') continue
    const id = entry.id.trim()
    const lowerId = id.toLowerCase()
    if (id === '' || seenIds.has(lowerId)) continue
    seenIds.add(lowerId)
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
    const family = modelFamilyOf(id)
    const efforts = normalizeEfforts(entry.efforts)
    const matched = quotaModels
      .filter(({ model }) => {
        const raw = model.modelId.trim().toLowerCase()
        return raw === lowerId || canonicalQuotaBaseId(raw).base === lowerId
      })
      .map(({ model }) => model)

    let stats = pickQuotaStats(matched)
    if (stats.remainingFraction === undefined && !stats.resetTime) {
      const bucket = acc.quotas?.[family] ?? (family === 'argon' ? acc.quotas?.google : undefined)
      const frac = typeof bucket?.remainingFraction === 'number'
        ? bucket.remainingFraction
        : typeof bucket?.weeklyFraction === 'number'
          ? bucket.weeklyFraction
          : undefined
      const reset = bucket?.resetTime || bucket?.weeklyResetTime || undefined
      stats = {
        ...(frac === undefined ? {} : { remainingFraction: frac }),
        ...(reset ? { resetTime: reset } : {}),
      }
    }
    rows.push({
      id,
      name,
      family,
      familyLabel: familyLabelOf(family),
      efforts,
      ...stats,
    })
  }
  return rows
}

interface FallbackAccumulator {
  id: string
  name: string
  family: ModelFamily
  efforts: Set<string>
  remainingFraction?: number
  resetTime?: string
}

function projectFromQuotaFallback(acc: ManagedAccount): AccountModelDisplayItem[] {
  const quotaModels = collectAccountQuotaModels(acc)
  const items: FallbackAccumulator[] = []
  const byIdKey = new Map<string, FallbackAccumulator>()
  const byNameKey = new Map<string, FallbackAccumulator>()

  for (const { family: rawFam, model } of quotaModels) {
    const rawId = model.modelId.trim()
    if (rawId === '' || isInternalNoiseSlug(rawId)) continue
    const { base, effort } = canonicalQuotaBaseId(rawId)
    const detected = modelFamilyOf(base)
    const family = detected !== 'unknown' ? detected : rawFam
    const cleanName = cleanFallbackDisplayName(model.displayName, base, effort)
    const idKey = `${family}::${base}`
    const nameKey = `${family}::name::${cleanName.toLowerCase()}`
    let item = byIdKey.get(idKey) ?? byNameKey.get(nameKey)
    if (!item) {
      item = { id: base, name: cleanName, family, efforts: new Set<string>() }
      items.push(item)
    } else if (item.name === item.id && cleanName !== base) {
      item.name = cleanName
    }
    byIdKey.set(idKey, item)
    byNameKey.set(nameKey, item)
    if (effort) item.efforts.add(effort)
    if (typeof model.remainingFraction === 'number' && Number.isFinite(model.remainingFraction)) {
      if (item.remainingFraction === undefined || model.remainingFraction < item.remainingFraction) {
        item.remainingFraction = model.remainingFraction
        if (model.resetTime) item.resetTime = model.resetTime
      }
    }
    if (!item.resetTime && model.resetTime) item.resetTime = model.resetTime
  }

  return items.map((item) => ({
    id: item.id,
    name: item.name,
    family: item.family,
    familyLabel: familyLabelOf(item.family),
    efforts: normalizeEfforts(item.efforts),
    ...(item.remainingFraction === undefined ? {} : { remainingFraction: item.remainingFraction }),
    ...(item.resetTime ? { resetTime: item.resetTime } : {}),
  }))
}

/**
 * Build the exact, 0-redundancy model list to display on an account card.
 * Prefers the account's own discovered `agy models` catalog when available,
 * and falls back to deduplicating/cleaning raw REST quota rows otherwise.
 */
export function buildAccountModelRows(
  acc: ManagedAccount,
  catalogModels?: readonly AccountModelCatalogItem[],
): AccountModelDisplayItem[] {
  if (Array.isArray(catalogModels) && catalogModels.length > 0) {
    return projectFromAuthoritativeCatalog(acc, catalogModels)
  }
  return projectFromQuotaFallback(acc)
}
