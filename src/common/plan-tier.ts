// Pure plan/tier inference for Google Antigravity accounts (Free / Pro / Ultra / Enterprise).
// Zero network calls: derives the subscription tier strictly from the already-fetched
// `agy -p /usage` groups, `retrieveUserQuotaSummary` groups, model catalog and
// `quotaUnavailable` marker. Lives in `common/` so both host and client can share it.
import type {
  AccountPlanTier,
  FamilyQuotaInfo,
  ManagedAccount,
  ModelFamily,
  QuotaUnavailableState,
} from './pool-types.ts'

export interface PlanTierGroupLike {
  name?: string
  displayName?: string
  description?: string
  buckets?: readonly {
    id?: string
    bucketId?: string
    name?: string
    displayName?: string
    window?: string
  }[]
}

function groupName(g: PlanTierGroupLike): string {
  return (g.name ?? g.displayName ?? '').toLowerCase()
}

function groupDesc(g: PlanTierGroupLike): string {
  return (g.description ?? '').toLowerCase()
}

function isDedicatedArgonGroup(g: PlanTierGroupLike): boolean {
  if (groupName(g).includes('argon')) return true
  return (g.buckets ?? []).some((b) => {
    const id = (b.id ?? b.bucketId ?? '').toLowerCase()
    const dn = (b.name ?? b.displayName ?? '').toLowerCase()
    return id.includes('argon') || dn.includes('argon')
  })
}

function isGeminiGroup(g: PlanTierGroupLike): boolean {
  if (isDedicatedArgonGroup(g)) return false
  return groupName(g).includes('gemini') || groupDesc(g).includes('gemini')
}

/**
 * The UNMETERED 5-hour placeholder a free-tier account reports: frozen at 100%
 * with a reset that is always ~5h away. It is not a paid window — reading it as
 * one badged a free account "Pro" purely because of the placeholder
 * (2026-11-23). A real 5-hour window that has been used is < 100%.
 */
function isUnmetered5hPlaceholder(q: FamilyQuotaInfo | undefined, now: number): boolean {
  if (typeof q?.remainingFraction !== 'number' || q.remainingFraction < 0.999) return false
  if (typeof q.resetTime !== 'string' || q.resetTime === '') return false
  const ms = Date.parse(q.resetTime) - now
  return ms > 4.5 * 3_600_000 && ms < 5.2 * 3_600_000
}

function hasFiveHourBucket(g: PlanTierGroupLike): boolean {
  return (g.buckets ?? []).some((b) => {
    const w = (b.window ?? b.id ?? b.bucketId ?? '').toLowerCase()
    return w.includes('5h') || w.includes('five_hour') || w.includes('5-hour') || w.includes('five')
  })
}

function hasWeeklyBucket(g: PlanTierGroupLike): boolean {
  return (g.buckets ?? []).some((b) => {
    const w = (b.window ?? b.id ?? b.bucketId ?? '').toLowerCase()
    return w.includes('week')
  })
}

export interface PlanTierEvidence {
  /** Argon has its OWN group/bucket (Pro splits Argon into a separate weekly bucket). */
  argonDedicated: boolean
  /** Argon is folded into the shared Gemini Models group (Ultra). */
  argonShared: boolean
  /** A 5-hour rolling window exists. Free accounts are weekly-ONLY. */
  has5h: boolean
  hasWeekly: boolean
}

/** Collect the tier-defining evidence from groups + quotas. Exported for reconciliation. */
export function collectPlanTierEvidence(input: {
  groups?: readonly PlanTierGroupLike[]
  quotas?: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  dedicatedGroups?: readonly ModelFamily[]
  modelIds?: readonly string[]
  /** Clock for placeholder detection; defaults to now. */
  now?: number
}): PlanTierEvidence {
  const groups = input.groups ?? []
  const now = input.now ?? Date.now()
  const quotas = input.quotas ?? {}
  const modelIds = (input.modelIds ?? []).map((m) => m.toLowerCase())

  const argonDedicated =
    groups.some(isDedicatedArgonGroup) ||
    quotas.argon !== undefined ||
    (input.dedicatedGroups?.includes('argon') === true)

  const geminiGroup = groups.find(isGeminiGroup)
  const sharedDesc = `${geminiGroup ? groupDesc(geminiGroup) : ''} ${(quotas.google?.description ?? '').toLowerCase()}`
  const argonInSharedDesc =
    sharedDesc.includes('argon') ||
    modelIds.some((id) => id.includes('argon')) ||
    (quotas.google?.models ?? []).some((m) => m.modelId.toLowerCase().includes('argon'))
  const argonShared = !argonDedicated && argonInSharedDesc

  const has5h = geminiGroup
    ? hasFiveHourBucket(geminiGroup)
    : (typeof quotas.google?.remainingFraction === 'number' && !isUnmetered5hPlaceholder(quotas.google, now)) ||
      groups.some((g) => hasFiveHourBucket(g)) ||
      Object.values(quotas).some((q) => typeof q?.remainingFraction === 'number' && !isUnmetered5hPlaceholder(q, now))
  const hasWeekly = geminiGroup
    ? hasWeeklyBucket(geminiGroup)
    : typeof quotas.google?.weeklyFraction === 'number' ||
      groups.some((g) => hasWeeklyBucket(g)) ||
      Object.values(quotas).some((q) => typeof q?.weeklyFraction === 'number')

  return { argonDedicated, argonShared, has5h, hasWeekly }
}

export function inferAccountPlanTier(input: {
  groups?: readonly PlanTierGroupLike[]
  quotas?: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  dedicatedGroups?: readonly ModelFamily[]
  quotaUnavailable?: QuotaUnavailableState
  modelIds?: readonly string[]
  /** Clock for placeholder detection; defaults to now. */
  now?: number
}): AccountPlanTier | undefined {
  const groups = input.groups ?? []

  for (const g of groups) {
    const combined = `${groupName(g)} ${groupDesc(g)}`
    if (/\b(?:enterprise|business|workspace)\b/i.test(combined)) return 'enterprise'
  }

  const ev = collectPlanTierEvidence(input)

  // Free = weekly-only, or an explicit refusal with no paid window in evidence.
  // A 5-hour window is the paid marker: no free account has one.
  if (input.quotaUnavailable?.reason === 'no_summary_access' && !ev.has5h) return 'free'

  // Pro splits Argon into its own bucket; Ultra folds Argon into the shared
  // Gemini Models bucket (visible only in that group's description).
  if (ev.argonDedicated) return 'pro'
  if (ev.argonShared) return 'ultra'

  // Any paid 5-hour window without Argon evidence is a Pro subscription. Do NOT
  // call a Flash-only Gemini group free: Flash models ship on paid plans too,
  // and the account in front of us carries a 5h window, which Free never has.
  if (ev.has5h) return 'pro'
  if (ev.hasWeekly) return 'free'

  return undefined
}

/**
 * True when a PERSISTED tier is contradicted by the evidence in front of us, in
 * which case the stored value is stale and must be recomputed.
 *
 * Each tier has one defining marker, so an absent marker invalidates the tier:
 *  - `free` requires "no 5-hour window" (Free is weekly-only),
 *  - `ultra` requires Argon folded into the shared bucket,
 * Pro / Enterprise are never auto-downgraded here: a weaker probe must not erase
 * a tier that a richer probe (CLI `/usage` groups) legitimately detected.
 */
export function isStalePlanTier(
  tier: AccountPlanTier,
  ev: PlanTierEvidence,
  quotaUnavailable?: QuotaUnavailableState,
): boolean {
  if (tier === 'free') return ev.has5h
  if (tier === 'ultra') return !ev.argonShared && !ev.argonDedicated
  // A refused summary on an account with NO 5-hour window is the free-tier
  // shape, so a persisted "pro" contradicts the evidence in front of us. Without
  // this the badge stayed Pro while the same card carried an empty 5h bar,
  // which is the "every number on this card is wrong" report of 2026-11-24.
  // A paid account keeps its 5h reading through `undoWeeklyInFiveHourSlot`, so
  // it still proves `has5h` and is never downgraded by a transient refusal.
  if (tier === 'pro') return quotaUnavailable?.reason === 'no_summary_access' && !ev.has5h
  return false
}

export function resolveAccountPlanTier(
  acc: ManagedAccount,
  discoveredModelIds?: readonly string[],
): AccountPlanTier | undefined {
  const evidence = collectPlanTierEvidence({
    quotas: acc.quotas,
    dedicatedGroups: acc.dedicatedGroups,
    modelIds: discoveredModelIds,
  })
  const inferred = inferAccountPlanTier({
    quotas: acc.quotas,
    dedicatedGroups: acc.dedicatedGroups,
    quotaUnavailable: acc.quotaUnavailable,
    modelIds: discoveredModelIds,
  })
  const persisted = acc.planTier && acc.planTier !== 'unknown' ? acc.planTier : undefined
  if (persisted === undefined) return inferred
  // A stored tier that its own defining marker contradicts is stale (e.g. a
  // "free" badge on an account that clearly has a 5-hour paid window).
  if (isStalePlanTier(persisted, evidence, acc.quotaUnavailable)) return inferred ?? persisted
  return persisted
}
