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

export function inferAccountPlanTier(input: {
  groups?: readonly PlanTierGroupLike[]
  quotas?: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  dedicatedGroups?: readonly ModelFamily[]
  quotaUnavailable?: QuotaUnavailableState
  modelIds?: readonly string[]
}): AccountPlanTier | undefined {
  const groups = input.groups ?? []
  const quotas = input.quotas ?? {}
  const modelIds = (input.modelIds ?? []).map((m) => m.toLowerCase())

  for (const g of groups) {
    const combined = `${groupName(g)} ${groupDesc(g)}`
    if (/\b(?:enterprise|business|workspace)\b/i.test(combined)) return 'enterprise'
  }

  const hasDedicatedArgon =
    groups.some(isDedicatedArgonGroup) ||
    quotas.argon !== undefined ||
    (input.dedicatedGroups?.includes('argon') === true)

  // If the summary was explicitly refused as free-tier (`no_summary_access`)
  // and no fresh groups proved Pro/Ultra, treat it as Free even if stale
  // legacy `dedicatedGroups: ['argon']` remained from before downgrade.
  if (groups.length === 0 && input.quotaUnavailable?.reason === 'no_summary_access') {
    return 'free'
  }

  if (hasDedicatedArgon) return 'pro'

  const geminiGroup = groups.find(isGeminiGroup)
  const geminiDesc = (geminiGroup ? groupDesc(geminiGroup) : (quotas.google?.description ?? '')).toLowerCase()
  const geminiHas5h = geminiGroup
    ? hasFiveHourBucket(geminiGroup)
    : typeof quotas.google?.remainingFraction === 'number'
  const geminiHasWeekly = geminiGroup
    ? hasWeeklyBucket(geminiGroup)
    : typeof quotas.google?.weeklyFraction === 'number'

  const googleModels = (quotas.google?.models ?? []).map((m) => m.modelId.toLowerCase())
  const allModelIds = [...modelIds, ...googleModels]
  const hasArgonModel = geminiDesc.includes('argon') || allModelIds.some((id) => id.includes('argon'))
  const hasGemini4Model =
    /gemini\s*4|neon|carbon|hydrogen|argon/i.test(geminiDesc) ||
    allModelIds.some((id) => /gemini-4|neon|carbon|hydrogen|argon/.test(id))

  if (hasArgonModel && geminiHas5h) return 'ultra'

  if (input.quotaUnavailable?.reason === 'no_summary_access') return 'free'
  if (geminiHasWeekly && !geminiHas5h && !hasGemini4Model) return 'free'

  if (hasGemini4Model && geminiHas5h) return 'pro'

  if (geminiDesc !== '' && !hasGemini4Model && geminiDesc.includes('flash') && !geminiDesc.includes('pro')) {
    return 'free'
  }

  return undefined
}

export function resolveAccountPlanTier(
  acc: ManagedAccount,
  discoveredModelIds?: readonly string[],
): AccountPlanTier | undefined {
  if (acc.planTier && acc.planTier !== 'unknown') return acc.planTier
  return inferAccountPlanTier({
    quotas: acc.quotas,
    dedicatedGroups: acc.dedicatedGroups,
    quotaUnavailable: acc.quotaUnavailable,
    modelIds: discoveredModelIds,
  })
}
