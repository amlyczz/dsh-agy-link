// Pure quota-bucket decisions shared by the quota service: family merging,
// dedicated-Argon-group detection, orphaned-cooldown release, window matching
// and the unmetered-5h placeholder check. No I/O, no service state.
import type { FamilyQuotaInfo } from '../../common/pool-types.ts'

/**
 * When the quota-summary endpoint transiently fails, per-model fallback
 * data carries a SINGLE window (sometimes the weekly one) and no weekly
 * fields. Overwriting a previously COMPLETE family entry with that partial
 * shape dropped weeklyFraction to none and put wrong-window numbers into
 * the 5h row (observed: 5h=100% / reset a week out / weekly missing).
 * Rule: last-known-good complete data always wins over partial fallback.
 */
export function mergeFallbackFamilyQuota(
  prev: FamilyQuotaInfo | undefined,
  fallback: FamilyQuotaInfo,
): FamilyQuotaInfo {
  if (prev && typeof prev.remainingFraction === 'number') return prev
  return fallback
}

/** Minimal shape of the quota groups `retrieveUserQuotaSummary` returns. */
export interface QuotaGroupShape {
  displayName?: string
  description?: string
  buckets?: readonly { bucketId?: string; displayName?: string }[]
}

/**
 * True when any returned group is the dedicated Argon bucket.
 *
 * The backend stops emitting that group once the plan folds Argon into the
 * larger Gemini bucket (Ultra). From then on the family is governed by the
 * shared bucket, so a cooldown recorded against the retired pool — e.g. a 429
 * taken minutes before an upgrade — must not keep blocking the family for days.
 */
export function summaryHasArgonGroup(groups: readonly QuotaGroupShape[]): boolean {
  return groups.some((group) => {
    const fields: (string | undefined)[] = [group.displayName, group.description]
    for (const bucket of group.buckets ?? []) fields.push(bucket.bucketId, bucket.displayName)
    return fields.some((value) => typeof value === 'string' && value.toLowerCase().includes('argon'))
  })
}

/**
 * Decide whether a family's cooldown belongs to a quota bucket that no longer exists.
 *
 * A cooldown is recorded against the pool that produced the 429. A plan change can
 * retire that pool — a Pro → Ultra upgrade folds Argon into the larger Gemini bucket
 * and the backend stops emitting the `Gemini 4 Argon` group — leaving a cooldown that
 * blocks the family until a reset that no longer applies:
 *
 *   All Antigravity accounts are unavailable: no account can serve argon right now
 *   (1 in cooldown) (earliest reset in 345338s)
 *
 * `groupSeenBefore` is what keeps this from firing on accounts that never had the
 * group at all (free tier, or any plan without an Argon bucket): their argon
 * cooldowns come from genuine 429s and must survive.
 */
export function shouldReleaseOrphanedCooldown(state: {
  summaryAuthoritative: boolean
  groupPresent: boolean
  groupSeenBefore: boolean
  hasCooldown: boolean
}): boolean {
  return state.summaryAuthoritative
    && !state.groupPresent
    && state.groupSeenBefore
    && state.hasCooldown
}

/**
 * Pick the family fraction when this poll's summary carried no group for it.
 *
 * An *authoritative* summary (at least one group returned) means the absence is
 * real: the family lost its own bucket — a Pro → Ultra upgrade folds the
 * separate Argon pool into the larger Gemini bucket, and the backend then stops
 * reporting a `Gemini 4 Argon` group entirely while `fetchAvailableModels`
 * keeps listing the argon models with fresh per-model fractions. Keeping the
 * last-known-good row there would freeze a dead window on screen (0%, a reset
 * time from the previous tier).
 *
 * A failed or empty summary is the case `mergeFallbackFamilyQuota` protects:
 * nothing authoritative arrived, so the previous complete value stays.
 */
export function pickFamilyQuota(
  prev: FamilyQuotaInfo | undefined,
  fresh: FamilyQuotaInfo,
  summaryAuthoritative: boolean,
): FamilyQuotaInfo {
  return summaryAuthoritative ? fresh : mergeFallbackFamilyQuota(prev, fresh)
}

/** How close two ISO reset stamps must be to name the SAME quota window. */
export const QUOTA_WINDOW_MATCH_TOLERANCE_MS = 5 * 60_000

/**
 * Detects whether a 5-hour quota bucket from retrieveUserQuotaSummary is an
 * unmetered placeholder (remainingFraction = 1.0 and resetTime = now + ~5h).
 * In unmetered environments (e.g. Cloud Code PA prod for free tier), the window
 * never starts billing and stays frozen at 100% forever.
 */
export function isStale5hBucket(remainingFraction?: number, resetTime?: string, now = Date.now()): boolean {
  if (remainingFraction !== 1 || !resetTime) return false
  const resetMs = Date.parse(resetTime) - now
  return resetMs > 4.5 * 3600_000 && resetMs < 5.2 * 3600_000
}

/**
 * True when two reset stamps point at the same quota window.
 *
 * `fetchAvailableModels` returns a per-model `quotaInfo` with NO window label:
 * for some accounts it carries the 5-hour bucket, for others the WEEKLY bucket
 * (live: daoxzeex@gmail.com reports the weekly fraction + weekly reset on every
 * Gemini model). The only reliable discriminator is the reset instant — it
 * matches exactly one of the `retrieveUserQuotaSummary` buckets.
 */
export function sameQuotaWindow(a?: string, b?: string, toleranceMs = QUOTA_WINDOW_MATCH_TOLERANCE_MS): boolean {
  if (!a || !b) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false
  return Math.abs(ta - tb) <= toleranceMs
}
