// Pure parsing/normalization of quota backend responses into family quota
// rows. The parse functions here take plain data in and return plain data out;
// all network I/O, caching and pool mutation stays in features/quota/refresh.ts.
import {
  modelFamilyOf,
  type FamilyQuotaInfo,
  type ModelFamily,
  type ModelQuotaInfo,
} from '../../common/pool-types.ts'
import { isStale5hBucket, pickFamilyQuota, sameQuotaWindow } from './buckets.ts'

export interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

export interface DiscoveredModelsResponse {
  models?: Record<string, DiscoveredModelEntry>
}

export interface QuotaSummaryBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  description?: string
  remainingFraction?: number
  remainingAmount?: number
}

export interface QuotaSummaryGroup {
  displayName?: string
  description?: string
  buckets?: QuotaSummaryBucket[]
}

export interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[]
  buckets?: QuotaSummaryBucket[]
  description?: string
}

export interface UserQuotaBucket {
  modelId?: string
  tokenType?: string
  remainingFraction?: number
  remainingAmount?: number
  resetTime?: string
}

export interface UserQuotaResponse {
  buckets?: UserQuotaBucket[]
}

export interface FamilyQuotaAggregate {
  familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  summaryGroups: QuotaSummaryGroup[]
}

/**
 * Merge `fetchAvailableModels` / `retrieveUserQuota` model entries into one
 * catalog. Per-model `retrieveUserQuota` buckets override the discovered
 * entries' quotaInfo, keeping any existing resetTime when the bucket omits it.
 */
export function buildModelsCatalog(
  discovered: DiscoveredModelsResponse | null,
  userQuota: UserQuotaResponse | null,
): Record<string, DiscoveredModelEntry> {
  const modelsCatalog: Record<string, DiscoveredModelEntry> = {
    ...(discovered?.models || {}),
  }
  if (userQuota && Array.isArray(userQuota.buckets)) {
    for (const b of userQuota.buckets) {
      if (!b.modelId) continue
      const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
        ? Math.min(1, Math.max(0, b.remainingFraction))
        : undefined
      if (frac !== undefined) {
        const existing = modelsCatalog[b.modelId]
        modelsCatalog[b.modelId] = {
          ...existing,
          quotaInfo: {
            remainingFraction: frac,
            resetTime: b.resetTime || existing?.quotaInfo?.resetTime,
          },
        }
      }
    }
  }
  return modelsCatalog
}

/**
 * Flatten a raw summary into the group list the ingest step consumes: the
 * top-level `groups`, plus a synthetic group for a top-level `buckets` array.
 */
function collectSummaryGroups(summary: QuotaSummaryResponse | null): QuotaSummaryGroup[] {
  const summaryGroups: QuotaSummaryGroup[] = []
  if (summary) {
    if (Array.isArray(summary.groups)) summaryGroups.push(...summary.groups)
    if (Array.isArray(summary.buckets) && summary.buckets.length > 0) {
      summaryGroups.push({
        displayName: summary.description || 'Quota',
        buckets: summary.buckets,
      })
    }
  }
  return summaryGroups
}

/**
 * Ingest official weekly & 5h limits from retrieveUserQuotaSummary into
 * `familyQuotas`, recording families whose 5h row is an unmetered placeholder.
 * Mutates both maps in place (callers share the same instances with the
 * model-level merge, exactly as before).
 */
function ingestSummaryGroups(
  summaryGroups: readonly QuotaSummaryGroup[],
  now: number,
  familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>,
  stale5hFamilies: Set<ModelFamily>,
): void {
  for (const group of summaryGroups) {
    const dName = (group.displayName || '').toLowerCase()
    const desc = (group.description || '').toLowerCase()
    // Gemini 4 Argon (Pro/Ultra-only) ships as its OWN quota group with a
    // separate weekly bucket, but its display name still contains "gemini"
    // ("Gemini 4 Argon"). Detect argon BEFORE the generic gemini gate or
    // the group folds into — and overwrites — the plain Gemini family.
    const hasArgonBucket = Array.isArray(group.buckets) && group.buckets.some((b) => (b.bucketId || '').toLowerCase().includes('argon') || (b.displayName || '').toLowerCase().includes('argon'))
    const isArgon = dName.includes('argon') || desc.includes('argon') || hasArgonBucket
    const isGoogle = !isArgon && (dName.includes('gemini') || desc.includes('gemini'))
    const is3P = dName.includes('claude') || dName.includes('gpt') || desc.includes('claude') || desc.includes('gpt')

    const targetFamilies: ModelFamily[] = isArgon
      ? ['argon']
      : isGoogle
      ? ['google']
      : is3P
      ? ['anthropic', 'openai']
      : []

    let fiveHourFrac: number | undefined
    let fiveHourReset: string | undefined
    let weeklyFrac: number | undefined
    let weeklyReset: string | undefined

    for (const b of group.buckets || []) {
      const w = (b.window || b.bucketId || '').toLowerCase()
      // Server fractions are clamped to [0,1] and NaN rejected: a bogus
      // remainingFraction (NaN/negative/>1) used to flow straight into
      // isAccountEligible and the UI ("NaN%" rows, permanently ineligible).
      const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
        ? Math.min(1, Math.max(0, b.remainingFraction))
        : undefined
      if (w.includes('5h') || w.includes('five_hour') || w.includes('5-hour')) {
        fiveHourFrac = frac
        fiveHourReset = b.resetTime
      } else if (w.includes('weekly') || w.includes('week')) {
        weeklyFrac = frac
        weeklyReset = b.resetTime
      }
    }

    for (const fam of targetFamilies) {
      if (isStale5hBucket(fiveHourFrac, fiveHourReset, now)) {
        stale5hFamilies.add(fam)
      }
      familyQuotas[fam] = {
        remainingFraction: fiveHourFrac,
        resetTime: fiveHourReset,
        weeklyFraction: weeklyFrac,
        weeklyResetTime: weeklyReset,
        description: group.description,
        updatedAt: now,
      }
    }
  }
}

/**
 * Ingest the per-model list from fetchAvailableModels / retrieveUserQuota into
 * `familyQuotas`, tightening the summary rows (or falling back to a
 * model-derived row when the summary had none). Mutates `familyQuotas` and
 * `stale5hFamilies`; returns the per-family model lists.
 */
function ingestModelCatalog(params: {
  modelsCatalog: Record<string, DiscoveredModelEntry>
  prevQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  now: number
  summaryAuthoritative: boolean
  familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  stale5hFamilies: Set<ModelFamily>
}): Partial<Record<ModelFamily, ModelQuotaInfo[]>> {
  const { modelsCatalog, prevQuotas, now, summaryAuthoritative, familyQuotas, stale5hFamilies } = params
  const familyModels: Partial<Record<ModelFamily, ModelQuotaInfo[]>> = {}
  for (const [modelId, entry] of Object.entries(modelsCatalog)) {
    const fam = modelFamilyOf(modelId)
    if (fam === 'unknown') continue
    const rawRemaining = entry.quotaInfo?.remainingFraction
    // Clamp to [0,1]; non-numeric entries are skipped (same contract as
    // the summary path above).
    const remaining = typeof rawRemaining === 'number' && Number.isFinite(rawRemaining)
      ? Math.min(1, Math.max(0, rawRemaining))
      : undefined
    const resetTime = entry.quotaInfo?.resetTime

    if (remaining === undefined) continue

    if (!familyModels[fam]) familyModels[fam] = []
    familyModels[fam]!.push({
      modelId,
      displayName: entry.displayName || modelId,
      remainingFraction: remaining,
      resetTime,
    })

    const isStale = stale5hFamilies.has(fam)
    // Fallback for family fraction if summary was unavailable.
    if (!familyQuotas[fam]) {
      if (fam === 'argon') {
        // Argon is WEEKLY-ONLY whenever the backend does not publish a
        // dedicated Argon group (a Pro -> Ultra plan folds it into the
        // shared Gemini bucket). The per-model quotaInfo then carries the
        // WEEKLY window, so it must never be filed under the 5-hour row:
        // the 10% 5h floor would otherwise bench an account whose weekly
        // quota is still above the 5% weekly floor.
        familyQuotas.argon = {
          ...(prevQuotas.argon ?? {}),
          remainingFraction: undefined,
          resetTime: undefined,
          weeklyFraction: remaining,
          weeklyResetTime: resetTime,
          updatedAt: now,
        }
      } else {
        familyQuotas[fam] = pickFamilyQuota(
          prevQuotas[fam],
          { remainingFraction: remaining, resetTime, updatedAt: now },
          summaryAuthoritative,
        )
      }
    } else {
      // Window-aware merge. `quotaInfo` carries no window label, so the
      // reset instant decides where the number belongs:
      //   • reset == summary 5h reset  → a 5h reading: tighten the 5h row.
      //   • reset == summary WEEKLY reset → a weekly reading: tighten the
      //     weekly row ONLY. Filing it under the 5h row painted "5h 19% ·
      //     weekly 19%" with the weekly reset on both lines (2026-10-22).
      //   • neither / no summary resets → unmatchable: keep the old
      //     conservative "lowest binding constraint" tighten on the 5h row.
      const familyQuota = familyQuotas[fam]!
      // Argon never carries a 5-hour window unless the backend reported one
      // explicitly; when `resetTime` is absent the model-level reading is
      // the WEEKLY window and must not tighten the 5-hour row.
      const weeklyOnlyArgon = fam === 'argon' && familyQuota.resetTime === undefined
      const modelIsWeekly =
        weeklyOnlyArgon ||
        (sameQuotaWindow(resetTime, familyQuota.weeklyResetTime) &&
          !sameQuotaWindow(resetTime, familyQuota.resetTime))
      if (modelIsWeekly) {
        const curWeekly = familyQuota.weeklyFraction ?? 1
        if (remaining < curWeekly) {
          familyQuota.weeklyFraction = remaining
          familyQuota.weeklyResetTime = resetTime
        }
        continue
      }
      // The binding constraint is the LOWEST reported remaining across all
      // sources. A lower remaining is by definition more consumed —
      // tighten to it and adopt its reset. If the coarse summary returned an
      // unmetered 5h placeholder (stale 100% with now+5h), the live model
      // window overrides it so the UI displays authentic numbers.
      const curRemaining = familyQuota.remainingFraction ?? 1
      if (remaining < curRemaining || isStale) {
        familyQuota.remainingFraction = remaining
        familyQuota.resetTime = resetTime
        stale5hFamilies.delete(fam)
      }
      if (fam === 'argon' && familyQuota.weeklyFraction === undefined) {
        familyQuota.weeklyFraction = remaining
        familyQuota.weeklyResetTime = resetTime
      }
    }
  }
  return familyModels
}

/**
 * Turn a raw quota summary + model catalog into the family quota rows served to
 * the UI/pool. `prevQuotas` is the account's last-known-good snapshot, used by
 * `pickFamilyQuota`/the Argon weekly fallback. `now` is the single timestamp
 * stamped on every produced row.
 */
export function buildFamilyQuotas(params: {
  summary: QuotaSummaryResponse | null
  modelsCatalog: Record<string, DiscoveredModelEntry>
  prevQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  now: number
}): FamilyQuotaAggregate {
  const { summary, modelsCatalog, prevQuotas, now } = params
  const familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {}
  const stale5hFamilies = new Set<ModelFamily>()

  // 1. Ingest official weekly & 5h limits from retrieveUserQuotaSummary
  const summaryGroups = collectSummaryGroups(summary)
  if (summaryGroups.length > 0) {
    ingestSummaryGroups(summaryGroups, now, familyQuotas, stale5hFamilies)
  }

  // 2. Ingest detailed model list from fetchAvailableModels / retrieveUserQuota
  if (Object.keys(modelsCatalog).length > 0) {
    const familyModels = ingestModelCatalog({
      modelsCatalog,
      prevQuotas,
      now,
      summaryAuthoritative: summaryGroups.length > 0,
      familyQuotas,
      stale5hFamilies,
    })
    for (const [famKey, list] of Object.entries(familyModels)) {
      const fam = famKey as ModelFamily
      if (familyQuotas[fam]) {
        familyQuotas[fam]!.models = list
      }
    }
  }

  return { familyQuotas, summaryGroups }
}
