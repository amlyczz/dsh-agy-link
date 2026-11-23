// Which account the console should treat as "in use" for each model family.
//
// Two DIFFERENT questions live here and must not be conflated:
//   • resolveFamilyActiveIds  — who the scheduler would use (pin first, then the
//                               eligibility PREDICTION for an unpinned family).
//   • resolveFamilyPinnedIds  — who is actually pinned (explicit "设为当前", or the
//                               account a run really used).
// Rendering an unpinned prediction under an "in use" label is what made the
// panel contradict the running session (2026-11-23), so callers compare both.
import type { AccountPoolData } from '../../common/pool-types.ts';
import { QUOTA_FAMILIES, type QuotaFamily } from '../../common/quota-bench.ts';

type OptimisticByFamily = Partial<Record<QuotaFamily, string>> | undefined;
type OptimisticId = string | null | undefined;

export function resolveFamilyActiveIds(
	pool: AccountPoolData | undefined,
	optimisticActiveByFamily: OptimisticByFamily,
	optimisticActiveId: OptimisticId,
): Partial<Record<QuotaFamily, string>> {
	const out: Partial<Record<QuotaFamily, string>> = {};
	for (const fam of QUOTA_FAMILIES) {
		out[fam] =
			optimisticActiveByFamily?.[fam] ??
			(fam === 'google' ? optimisticActiveId ?? undefined : undefined) ??
			pool?.resolvedActiveAccountIds?.[fam] ??
			(fam === 'google'
				? (pool?.activeAccountId ?? pool?.lastActiveAccountId ?? pool?.activeAccountIds?.google ?? pool?.primaryAccountId)
				: pool?.activeAccountIds?.[fam]);
	}
	return out;
}

export function resolveFamilyPinnedIds(
	pool: AccountPoolData | undefined,
	optimisticActiveByFamily: OptimisticByFamily,
	optimisticActiveId: OptimisticId,
): Partial<Record<QuotaFamily, string>> {
	const out: Partial<Record<QuotaFamily, string>> = {};
	for (const fam of QUOTA_FAMILIES) {
		out[fam] =
			optimisticActiveByFamily?.[fam] ??
			(fam === 'google' ? optimisticActiveId ?? undefined : undefined) ??
			(fam === 'google'
				? (pool?.activeAccountId ?? pool?.activeAccountIds?.google ?? pool?.lastActiveAccountId)
				: pool?.activeAccountIds?.[fam]);
	}
	return out;
}
