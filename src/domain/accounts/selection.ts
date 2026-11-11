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
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'

/**
 * Proactive rotation thresholds: an account at or below these remaining
 * fractions is benched until its reset instead of being served
 * (isQuotaBenched / updateAccountQuotas / getEarliestAvailableCountdown).
 *
 * The old 2%/1% values only benched an account AFTER it had already died:
 * 2026-10-17 01:42 — the primary sat at 4.07% (above the old gate), so the
 * sticky affinity kept every session pinned to it while three parallel turns
 * slammed into the wall together and stalled in agy-internal retries, with
 * q98 idle at 100%. Benching at 10%/5% rotates while the successor still has
 * runway; the benched account comes back at its own reset.
 */
export const LOW_QUOTA_5H = 0.10
export const LOW_QUOTA_WEEKLY = 0.05

/** Why a pool account cannot serve a family right now (diagnostics only). */
export type AccountIneligibilityReason = 'disabled' | 'auth' | 'cooldown' | 'quota' | 'unsupported'

/**
 * The slice of the pool the Argon check needs: whether an account has itself
 * reported a dedicated quota group for a family. Passed explicitly instead of
 * reaching for `this`.
 */
export interface DedicatedGroupSource {
  hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean
}

/**
 * True when a family's cached quota snapshot benches the account.
 *
 * A user-visible `clearCooldown(..., includeQuotaBench = true)` records the
 * `updatedAt` of the snapshot it overrode; the gate stays off only while the
 * cached row is no newer than that stamp, so a fresh poll always re-arms it.
 */
export function isQuotaBenched(acc: ManagedAccount, family: ModelFamily, now: number): boolean {
  const quota = acc.quotas?.[family]
  if (!quota) return false
  const clearedAt = acc.quotaGateClearedAt?.[family]
  if (clearedAt !== undefined && (quota.updatedAt ?? 0) <= clearedAt) return false
  // If 5h quota remaining is at/below the proactive rotation threshold and
  // reset time is in future (or missing), treat as in cooldown
  if (typeof quota.remainingFraction === 'number' && quota.remainingFraction <= LOW_QUOTA_5H) {
    if (quota.resetTime) {
      const resetMs = Date.parse(quota.resetTime)
      if (Number.isNaN(resetMs) || resetMs > now) return true
    } else {
      return true
    }
  }
  // If weekly quota remaining is at/below the rotation threshold and weekly
  // reset time is in future (or missing), treat as in cooldown
  if (typeof quota.weeklyFraction === 'number' && quota.weeklyFraction <= LOW_QUOTA_WEEKLY) {
    if (quota.weeklyResetTime) {
      const resetMs = Date.parse(quota.weeklyResetTime)
      if (Number.isNaN(resetMs) || resetMs > now) return true
    } else {
      return true
    }
  }
  return false
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
): AccountIneligibilityReason | null {
  if (!acc.enabled) return 'disabled'
  if (acc.authRequired) return 'auth'
  if (family === 'argon' && !accountHasArgon(acc, pool)) return 'unsupported'
  const cd = acc.cooldowns?.[family]
  if (cd && cd.cooldownUntil > now) return 'cooldown'
  if (isQuotaBenched(acc, family, now)) return 'quota'
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
): boolean {
  return explainIneligibility(acc, family, now, pool) === null
}

/**
 * Next moment this account's quota state refreshes for one family: the
 * sooner of the 5h window reset and the weekly cap reset. NaN when unknown.
 */
export function nextQuotaResetAt(acc: ManagedAccount, family: ModelFamily): number {
  const q = acc.quotas?.[family]
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

/**
 * "Use it or lose it" rotation order.
 * Priority 1: Weekly quota expiring soonest (least remaining time until weeklyResetTime).
 * Priority 2: 5-hour quota expiring soonest (least remaining time until resetTime).
 * Priority 3: Cyclic distance from `fromId` (or pool order).
 *
 * `accounts` is the pool order used for cycle distance; `now` is threaded in so
 * callers keep the exact clock snapshot they passed to the eligibility check.
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
      const q = acc.quotas?.[family]
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
      }
    })
    .sort((a, b) => {
      // Priority 1: Weekly quota reset time (least remaining time until reset first)
      if (a.weeklyKnown && b.weeklyKnown) {
        if (a.weeklyRemaining !== b.weeklyRemaining) {
          return a.weeklyRemaining - b.weeklyRemaining
        }
      } else if (a.weeklyKnown !== b.weeklyKnown) {
        return a.weeklyKnown ? -1 : 1
      }

      // Priority 2: 5-hour quota reset time (least remaining time until reset first)
      if (a.fiveHourKnown && b.fiveHourKnown) {
        if (a.fiveHourRemaining !== b.fiveHourRemaining) {
          return a.fiveHourRemaining - b.fiveHourRemaining
        }
      } else if (a.fiveHourKnown !== b.fiveHourKnown) {
        return a.fiveHourKnown ? -1 : 1
      }

      // Priority 3: Fallback to cyclic distance / pool order
      const da = cyclicDistance(accounts, fromId, a.acc.id)
      const db = cyclicDistance(accounts, fromId, b.acc.id)
      return da !== db ? da - db : a.index - b.index
    })
    .map((e) => e.acc)
}
