// Pure account-selection policy for the multi-account pool: eligibility
// predicates, quota-bench detection, reset bookkeeping and the "use it or
// lose it" rotation order.
//
// Nothing here touches disk or reads the wall clock: every function takes its
// inputs explicitly (account, family, now, pool) so the scheduling rules stay
// side-effect-free and can be unit-tested in isolation. AccountPoolManager
// keeps thin delegating methods with the original signatures, so callers are
// unchanged.
import {
  accountHasArgon,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import {
  isAccountCriticalAuth,
  isQuotaBenched,
  LOW_QUOTA_5H,
  LOW_QUOTA_WEEKLY,
} from '../../common/quota-bench.ts'
import { computeQuotaPacing, FIVE_HOUR_WINDOW_MS, WEEKLY_WINDOW_MS } from '../../common/quota-pacing.ts'

export { isQuotaBenched, LOW_QUOTA_5H, LOW_QUOTA_WEEKLY }

/** Why a pool account cannot serve a family right now (diagnostics only). */
export type AccountIneligibilityReason = 'disabled' | 'auth' | 'cooldown' | 'quota' | 'unsupported' | 'model-unsupported'

/**
 * The slice of the pool the Argon check needs: whether an account has itself
 * reported a dedicated quota group for a family. Passed explicitly instead of
 * reaching for `this`.
 */
export interface DedicatedGroupSource {
  hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean
  isModelSupported?: (acc: ManagedAccount, model: string) => boolean
}

/**
 * Why this account cannot serve `family` right now, or null when it can.
 *
 * Exists so callers can report the ACTUAL blocker: quota rotation used to be
 * folded into "in cooldown", which pointed users at `/agy clear-cooldown` for
 * a state that command did not touch.
 */
export function explainIneligibility(
  acc: ManagedAccount,
  family: ModelFamily,
  now: number,
  pool?: DedicatedGroupSource | null,
  model?: string,
): AccountIneligibilityReason | null {
  if (!acc.enabled) return 'disabled'
  if (isAccountCriticalAuth(acc)) return 'auth'
  if (family === 'argon' && !accountHasArgon(acc, pool)) return 'unsupported'
  // "This model is not in the account's catalog" is NOT the same diagnosis as
  // "the account has no access to this family / plan" (issues #120, #122).
  if (model && pool?.isModelSupported && !pool.isModelSupported(acc, model)) {
    return 'model-unsupported'
  }
  const cd = acc.cooldowns?.[family]
  if (cd && cd.cooldownUntil > now) return 'cooldown'
  if (isQuotaBenched(acc, family, now, model)) return 'quota'
  return null
}

/**
 * Check whether an account is eligible to serve requests for the given family.
 */
export function isAccountEligible(
  acc: ManagedAccount,
  family: ModelFamily,
  now: number,
  pool?: DedicatedGroupSource | null,
  model?: string,
): boolean {
  return explainIneligibility(acc, family, now, pool, model) === null
}

function effectiveFamilyQuota(acc: ManagedAccount, family: ModelFamily): FamilyQuotaInfo | undefined {
  // Argon and Gemini are INDEPENDENT quota books (see
  // .spec/quota-and-risk-control.md). Never borrow `google`'s numbers for
  // `argon`: an absent row means "unknown", not "same as Gemini". Borrowing
  // would either bench a healthy Argon on a drained Gemini pool or mask a
  // drained Argon behind a full Gemini one.
  return acc.quotas?.[family]
}

/** Reset timestamps within 5m belong to the same reset cohort (avoids 1-60s clock jitter). */
const RESET_COHORT_TOLERANCE_MS = 5 * 60_000

/**
 * Next moment this account's quota state refreshes for one family: the
 * sooner of the 5h window reset and the weekly cap reset. NaN when unknown.
 */
export function nextQuotaResetAt(acc: ManagedAccount, family: ModelFamily): number {
  const q = effectiveFamilyQuota(acc, family)
  const stamps = [q?.resetTime, q?.weeklyResetTime]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map((v) => Date.parse(v))
    .filter((t) => !Number.isNaN(t))
  return stamps.length === 0 ? Number.NaN : Math.min(...stamps)
}

/** Cyclic distance from `fromId` (0 = itself), so ties keep pool order. */
export function cyclicDistance(
  accounts: readonly ManagedAccount[],
  fromId: string | undefined,
  id: string,
): number {
  const total = accounts.length
  const idx = accounts.findIndex((a) => a.id === id)
  if (idx === -1) return Number.MAX_SAFE_INTEGER
  if (fromId === undefined) return idx
  const start = accounts.findIndex((a) => a.id === fromId)
  if (start === -1) return idx
  return (idx - start + total) % total
}

function candidateSurplusScore(q: FamilyQuotaInfo | undefined, now: number): number | null {
  if (!q) return null
  const scores: number[] = []
  if (typeof q.weeklyFraction === 'number') {
    scores.push(computeQuotaPacing(q.weeklyFraction, q.weeklyResetTime, WEEKLY_WINDOW_MS, now).surplus)
  }
  if (typeof q.remainingFraction === 'number') {
    scores.push(computeQuotaPacing(q.remainingFraction, q.resetTime, FIVE_HOUR_WINDOW_MS, now).surplus)
  }
  return scores.length > 0 ? Math.min(...scores) : null
}

/**
 * "Use it or lose it" rotation order with cohort burn-rate surplus tie-breaking.
 * Priority 1: Weekly quota expiring soonest (>5m difference).
 * Priority 2: 5-hour quota expiring soonest (>5m difference).
 * Priority 3: Within the same reset cohort, fewest consecutive failures, then
 *             highest quota pacing surplus (>5% difference).
 * Priority 4: Cyclic distance from `fromId` (or pool order).
 */
export function orderByExpiry(
  accounts: readonly ManagedAccount[],
  candidates: readonly ManagedAccount[],
  family: ModelFamily,
  fromId: string | undefined,
  now: number,
): ManagedAccount[] {
  return candidates
    .map((acc, index) => {
      const q = effectiveFamilyQuota(acc, family)
      const weeklyMs = q?.weeklyResetTime ? Date.parse(q.weeklyResetTime) : Number.NaN
      const fiveHourMs = q?.resetTime ? Date.parse(q.resetTime) : Number.NaN
      const weeklyRemaining = !Number.isNaN(weeklyMs) ? Math.max(0, weeklyMs - now) : Number.POSITIVE_INFINITY
      const fiveHourRemaining = !Number.isNaN(fiveHourMs) ? Math.max(0, fiveHourMs - now) : Number.POSITIVE_INFINITY
      return {
        acc,
        index,
        weeklyRemaining,
        fiveHourRemaining,
        weeklyKnown: Number.isFinite(weeklyRemaining),
        fiveHourKnown: Number.isFinite(fiveHourRemaining),
        failures: acc.cooldowns?.[family]?.consecutiveFailures ?? 0,
        surplus: candidateSurplusScore(q, now),
      }
    })
    .sort((a, b) => {
      // Priority 1: Weekly quota reset time (outside cohort jitter tolerance)
      if (a.weeklyKnown && b.weeklyKnown) {
        if (Math.abs(a.weeklyRemaining - b.weeklyRemaining) > RESET_COHORT_TOLERANCE_MS) {
          return a.weeklyRemaining - b.weeklyRemaining
        }
      } else if (a.weeklyKnown !== b.weeklyKnown) {
        return a.weeklyKnown ? -1 : 1
      }

      // Priority 2: 5-hour quota reset time (outside cohort jitter tolerance)
      if (a.fiveHourKnown && b.fiveHourKnown) {
        if (Math.abs(a.fiveHourRemaining - b.fiveHourRemaining) > RESET_COHORT_TOLERANCE_MS) {
          return a.fiveHourRemaining - b.fiveHourRemaining
        }
      } else if (a.fiveHourKnown !== b.fiveHourKnown) {
        return a.fiveHourKnown ? -1 : 1
      }

      // Priority 3: Same reset cohort -> prefer healthier account & higher burn-rate surplus
      if (a.failures !== b.failures) {
        return a.failures - b.failures
      }
      if (a.surplus !== null && b.surplus !== null && Math.abs(b.surplus - a.surplus) > 0.05) {
        return b.surplus - a.surplus
      }

      // Priority 4: Fallback to cyclic distance / pool order
      const da = cyclicDistance(accounts, fromId, a.acc.id)
      const db = cyclicDistance(accounts, fromId, b.acc.id)
      return da !== db ? da - db : a.index - b.index
    })
    .map((e) => e.acc)
}

/**
 * Pure, side-effect-free lookup of the active eligible account ID for a given
 * family. Honors a still-eligible family pin first, then falls back to the
 * first eligible candidate in rotation order without mutating pool state.
 */
export function resolveEligibleActiveAccountId(
  accounts: readonly ManagedAccount[],
  activeAccountIds: Partial<Record<ModelFamily, string>> | undefined,
  family: ModelFamily,
  pool?: DedicatedGroupSource | null,
  now = Date.now(),
  model?: string,
): string | undefined {
  const pinnedId = activeAccountIds?.[family]
  if (pinnedId) {
    const pinned = accounts.find((a) => a.id === pinnedId)
    if (pinned && isAccountEligible(pinned, family, now, pool, model)) {
      return pinned.id
    }
  }
  const candidates = accounts.filter((acc) => isAccountEligible(acc, family, now, pool, model))
  if (candidates.length === 0) return undefined
  return orderByExpiry(accounts, candidates, family, pinnedId, now)[0]?.id
}
