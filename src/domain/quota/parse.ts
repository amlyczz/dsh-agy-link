// Pure parsing/normalization of quota backend responses into family quota
// rows. The parse functions here take plain data in and return plain data out;
// all network I/O, caching and pool mutation stays in features/quota/refresh.ts.
import {
  isArgonModel,
  modelFamilyOf,
  type FamilyQuotaInfo,
  type ModelFamily,
  type ModelQuotaInfo,
} from '../../common/pool-types.ts'
import { isStale5hBucket, looksLikeWeeklyWindow, pickFamilyQuota, sameQuotaWindow, undoWeeklyInFiveHourSlot } from './buckets.ts'

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
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>
}

/**
 * Normalize a server quota fraction in [0, 1].
 * Proto3 JSON serialization omits `0.0` numeric fields: when `remainingFraction`
 * is absent (`undefined`) while a `resetTime` or `remainingAmount === 0` is
 * present, the bucket/model is exhausted (`0`), NOT `undefined` / `100%`.
 */
function parseBucketFraction(
  rawRemaining: unknown,
  resetTime?: string,
  remainingAmount?: unknown,
): number | undefined {
  if (typeof rawRemaining === 'number' && Number.isFinite(rawRemaining)) {
    return Math.min(1, Math.max(0, rawRemaining))
  }
  if (
    rawRemaining === undefined &&
    ((typeof resetTime === 'string' && resetTime.trim() !== '') || remainingAmount === 0)
  ) {
    return 0
  }
  return undefined
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
      const frac = parseBucketFraction(b.remainingFraction, b.resetTime, b.remainingAmount)
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
    //
    // Only the GROUP NAME and the BUCKET ids may prove a dedicated pool. The
    // description must not: since agy 1.5.12 the plain `Gemini Models` group
    // enumerates its members ("Models within this group: Gemini 4 Neon, Gemini 4
    // Carbon, Gemini 4 Argon, …"), so a description match filed the SHARED pool
    // under `argon` and left `google` without its weekly numbers (2026-11-19).
    const hasArgonBucket = Array.isArray(group.buckets) && group.buckets.some((b) => (b.bucketId || '').toLowerCase().includes('argon') || (b.displayName || '').toLowerCase().includes('argon'))
    const isArgon = dName.includes('argon') || hasArgonBucket
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
      const frac = parseBucketFraction(b.remainingFraction, b.resetTime, b.remainingAmount)
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
/**
 * The row to use when this poll's summary carried NO group for `fam`.
 *
 * Three shapes, decided by the only evidence a label-less reading offers — its
 * reset instant:
 *
 *   • `argon` without a dedicated group: WEEKLY-ONLY by construction (a Pro →
 *     Ultra fold still reports argon models, but the pool is the shared Gemini
 *     one and the reading carries the weekly window). Filing it as the 5-hour
 *     fraction would bench a healthy account on the 10% 5h floor.
 *   • any family whose reading resets more than 6 hours out: the WEEKLY window.
 *     Filing it as the 5-hour fraction painted "5h 100% · weekly (empty) · reset
 *     6 days out" plus a Pro badge on a FREE account (2026-11-23/24) — four
 *     numbers describing buckets that account never had. The 5-hour slot stays
 *     unknown unless a real (sub-6h) reading is already stored.
 *   • anything else: the conservative "lowest binding constraint" merge, which
 *     never overwrites a previously complete row with partial fallback data.
 */
function fallbackFamilyRow(params: {
  fam: ModelFamily
  prevFamily: FamilyQuotaInfo | undefined
  remaining: number
  resetTime: string | undefined
  now: number
  summaryAuthoritative: boolean
}): FamilyQuotaInfo {
  const { fam, prevFamily, remaining, resetTime, now, summaryAuthoritative } = params
  if (fam === 'argon') {
    return {
      ...(prevFamily ?? {}),
      remainingFraction: undefined,
      resetTime: undefined,
      weeklyFraction: remaining,
      weeklyResetTime: resetTime,
      updatedAt: now,
    }
  }
  if (looksLikeWeeklyWindow(resetTime, now)) {
    // A weekly reading never claims the 5-hour slot. A real 5h reading the
    // account already stored is NOT erased: it stays until its own boundary,
    // which the panel marks as expired instead of presenting it as live.
    const keptWeekly = typeof prevFamily?.weeklyFraction === 'number' && prevFamily.weeklyFraction <= remaining
    return {
      ...(prevFamily ?? {}),
      weeklyFraction: keptWeekly ? prevFamily?.weeklyFraction : remaining,
      weeklyResetTime: keptWeekly ? prevFamily?.weeklyResetTime ?? resetTime : resetTime,
      updatedAt: now,
    }
  }
  return pickFamilyQuota(
    prevFamily,
    { remainingFraction: remaining, resetTime, updatedAt: now },
    summaryAuthoritative,
  )
}

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
    const quotaFamily = modelFamilyOf(modelId)
    if (quotaFamily === 'unknown') continue
    const resetTime = entry.quotaInfo?.resetTime
    // On agy 1.5.15+, Google folded Gemini 4 Argon into `Gemini Models` (the summary
    // has NO separate Argon group, `google.description` lists Argon, and per-model
    // quotaInfo carries a 5-hour reset matching Gemini). Do NOT synthesize a bogus
    // `argon` weekly row out of a 5-hour timestamp; attach the model under `google`.
    const foldedArgon5h =
      quotaFamily === 'argon' &&
      summaryAuthoritative &&
      !familyQuotas.argon &&
      isArgonModel(familyQuotas.google?.description) &&
      !looksLikeWeeklyWindow(resetTime, now)
    const fam: ModelFamily = foldedArgon5h ? 'google' : quotaFamily
    const remaining = parseBucketFraction(entry.quotaInfo?.remainingFraction, resetTime)

    if (remaining === undefined) continue

    if (!familyModels[fam]) familyModels[fam] = []
    familyModels[fam]!.push({
      modelId,
      displayName: entry.displayName || modelId,
      remainingFraction: remaining,
      resetTime,
    })

    const isStale = stale5hFamilies.has(fam)
    // A persisted row that carries the WEEKLY number in the 5-hour slot is the
    // free-tier mis-filing `undoWeeklyInFiveHourSlot` repairs; every branch
    // below must start from the corrected row or the error is frozen forever.
    const prevFamily = undoWeeklyInFiveHourSlot(prevQuotas[fam], now)
    // Fallback for family fraction if summary was unavailable.
    if (!familyQuotas[fam]) {
      familyQuotas[fam] = fallbackFamilyRow({ fam, prevFamily, remaining, resetTime, now, summaryAuthoritative })
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
      // Same rule for EVERY family, decided by the reset distance instead of by
      // the family name: a reading that resets more than 6 hours out cannot be
      // the rolling 5-hour bucket, so it belongs to the weekly row even when the
      // summary never named that window (free tier).
      const weeklyOnlyRow = familyQuota.resetTime === undefined && looksLikeWeeklyWindow(resetTime, now)
      const modelIsWeekly =
        weeklyOnlyArgon ||
        weeklyOnlyRow ||
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
