// Which families a fresh quota snapshot shows as exhausted right now.
//
// The rule behind AccountPoolManager.updateAccountQuotas' proactive advance.
// Pure on purpose: the pool manager decides what to DO about an exhausted
// family (move the sticky pointer); this decides WHICH families qualify, so the
// rule is testable without a pool and reads the same wherever a snapshot lands.
import { LOW_QUOTA_5H, LOW_QUOTA_WEEKLY } from '../../common/quota-bench.ts'
import type { FamilyQuotaInfo, ManagedAccount, ModelFamily } from '../../common/pool-types.ts'

/** True when a window's remaining fraction is at or below its floor and its reset has not passed. */
function windowExhausted(fraction: number | undefined, resetTime: string | undefined, floor: number, now: number): boolean {
  if (typeof fraction !== 'number' || fraction > floor) return false
  return !resetTime || Number.isNaN(Date.parse(resetTime)) || Date.parse(resetTime) > now
}

/**
 * Families whose snapshot shows an exhausted 5-hour or weekly window that has
 * not reset yet — minus the ones the user already overrode with a gate clear at
 * least as fresh as the snapshot: the override is only meant to bridge the gap
 * until fresher data arrives, so a newer snapshot outranks it again.
 */
export function freshlyExhaustedFamilies(
  acc: Pick<ManagedAccount, 'quotaGateClearedAt'>,
  quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>,
  now: number,
): ModelFamily[] {
  const out: ModelFamily[] = []
  for (const [famKey, info] of Object.entries(quotas) as [ModelFamily, FamilyQuotaInfo][]) {
    if (!info) continue
    const exhausted =
      windowExhausted(info.remainingFraction, info.resetTime, LOW_QUOTA_5H, now) ||
      windowExhausted(info.weeklyFraction, info.weeklyResetTime, LOW_QUOTA_WEEKLY, now)
    if (!exhausted) continue
    const clearedAt = acc.quotaGateClearedAt?.[famKey]
    const gateCleared = clearedAt !== undefined && (info.updatedAt ?? 0) <= clearedAt
    if (!gateCleared) out.push(famKey)
  }
  return out
}
