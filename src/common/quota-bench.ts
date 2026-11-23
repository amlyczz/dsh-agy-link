// Pure quota-bench, cooldown, and auth-quarantine predicates shared across
// domain scheduling, host commands, and client UI so every surface derives
// account availability from a single source of truth.
import { modelMatches, type FamilyQuotaInfo, type ManagedAccount, type ModelFamily } from './pool-types.ts'

/** Proactive rotation thresholds: bench accounts at or below these remaining fractions until reset. */
export const LOW_QUOTA_5H = 0.10
export const LOW_QUOTA_WEEKLY = 0.05

export type QuotaFamily = 'google' | 'argon' | 'anthropic' | 'openai'

/** Ordered quota families tracked on an account card. */
export const QUOTA_FAMILIES: readonly QuotaFamily[] = [
  'google',
  'argon',
  'anthropic',
  'openai',
]

/** Normalize user/CLI/HTTP model-family aliases onto canonical `ModelFamily` keys. */
export function normalizeModelFamily(raw?: string): ModelFamily | undefined {
  if (!raw) return undefined
  const clean = raw.trim().toLowerCase()
  if (clean === 'google' || clean === 'gemini') return 'google'
  if (clean === 'argon') return 'argon'
  if (clean === 'anthropic' || clean === 'claude') return 'anthropic'
  if (clean === 'openai' || clean === 'gpt' || clean === 'gpt-oss') return 'openai'
  if (clean === 'unknown') return 'unknown'
  return undefined
}

function isWindowBenched(fraction: number | undefined, resetTime: string | undefined, threshold: number, now: number): boolean {
  if (typeof fraction !== 'number' || fraction > threshold) return false
  if (!resetTime) return true
  const resetMs = Date.parse(resetTime)
  return Number.isNaN(resetMs) || resetMs > now
}

/** True when a family's 5-hour quota window is at or below the proactive bench threshold and not yet reset. */
export function is5hQuotaBenched(
  quota: FamilyQuotaInfo | undefined,
  clearedAt: number | undefined,
  now: number,
): boolean {
  if (!quota) return false
  if (clearedAt !== undefined && (quota.updatedAt ?? 0) <= clearedAt) return false
  return isWindowBenched(quota.remainingFraction, quota.resetTime, LOW_QUOTA_5H, now)
}

/** True when a family's weekly quota window is at or below the proactive bench threshold and not yet reset. */
export function isWeeklyQuotaBenched(
  quota: FamilyQuotaInfo | undefined,
  clearedAt: number | undefined,
  now: number,
): boolean {
  if (!quota) return false
  if (clearedAt !== undefined && (quota.updatedAt ?? 0) <= clearedAt) return false
  return isWindowBenched(quota.weeklyFraction, quota.weeklyResetTime, LOW_QUOTA_WEEKLY, now)
}

/**
 * True when a family's cached quota snapshot benches the account.
 *
 * A user-visible `clearCooldown(..., includeQuotaBench = true)` records the
 * `updatedAt` of the snapshot it overrode; the gate stays off only while the
 * cached row is no newer than that stamp, so a fresh poll always re-arms it.
 */
export function isQuotaBenched(acc: ManagedAccount, family: ModelFamily, now: number, model?: string): boolean {
  // Argon has its own quota book; an absent row is "unknown", never a mirror of
  // the shared-looking Gemini row (.spec/quota-and-risk-control.md).
  const quota = acc.quotas?.[family]
  if (!quota) return false
  const clearedAt = acc.quotaGateClearedAt?.[family]
  if (is5hQuotaBenched(quota, clearedAt, now) || isWeeklyQuotaBenched(quota, clearedAt, now)) return true
  if (!model || model.trim() === '' || !Array.isArray(quota.models)) return false
  if (clearedAt !== undefined && (quota.updatedAt ?? 0) <= clearedAt) return false
  const matched = quota.models.filter((m) => modelMatches(model, m.modelId))
  if (matched.length === 0) return false
  return matched.every((m) => isWindowBenched(m.remainingFraction, m.resetTime ?? quota.resetTime, LOW_QUOTA_WEEKLY, now))
}

/** True when any family on the account has an active local 429 cooldown timer. */
export function accountHasActiveCooldown(acc: ManagedAccount, now: number): boolean {
  return Object.values(acc.cooldowns ?? {}).some((cd) => Boolean(cd && cd.cooldownUntil > now))
}

/**
 * True when any family reported on the account is benched by its quota snapshot.
 *
 * Each family is judged on its OWN row only. An account with no `argon` row is
 * not Argon-benched (unknown ≠ drained) — a drained Gemini pool must never
 * bench Argon, because the two are separate quota books.
 */
export function accountHasQuotaBench(acc: ManagedAccount, now: number): boolean {
  return QUOTA_FAMILIES.some((fam) => isQuotaBenched(acc, fam, now))
}

/** True when a family has an active local 429 cooldown timer on this account. */
export function isFamilyInCooldown(acc: ManagedAccount, family: ModelFamily, now: number): boolean {
  const cd = acc.cooldowns?.[family]
  return Boolean(cd && cd.cooldownUntil > now)
}

/**
 * Single source of truth for whether one model family on an account is
 * currently cooling (either via an active 429 cooldown timer or proactive
 * low-quota benching).
 */
export function isFamilyCooling(acc: ManagedAccount, family: ModelFamily, now: number): boolean {
  return isFamilyInCooldown(acc, family, now) || isQuotaBenched(acc, family, now)
}

/** Known quota families explicitly tracked on this account. */
export function accountKnownFamilies(acc: ManagedAccount): QuotaFamily[] {
  return QUOTA_FAMILIES.filter((fam) => {
    if (fam === 'argon') {
      return acc.quotas?.argon !== undefined || acc.cooldowns?.argon !== undefined
    }
    return acc.quotas?.[fam] !== undefined || acc.cooldowns?.[fam] !== undefined
  })
}

/** Families on this account that are currently cooling. */
export function accountCoolingFamilies(acc: ManagedAccount, now: number): QuotaFamily[] {
  return accountKnownFamilies(acc).filter((fam) => isFamilyCooling(acc, fam, now))
}

/**
 * True only when every known family on the account is cooling (drives the
 * account-level amber indicator dot without punishing healthy families).
 */
export function isAccountFullyCooling(acc: ManagedAccount, now: number): boolean {
  const known = accountKnownFamilies(acc)
  if (known.length === 0) return accountHasActiveCooldown(acc, now)
  return known.every((fam) => isFamilyCooling(acc, fam, now))
}

/**
 * True when the account cannot operate due to auth expiration, web verification
 * (`VALIDATION_REQUIRED`), or ToS suspension (`TOS_VIOLATION`).
 */
export function isAccountCriticalAuth(acc: ManagedAccount): boolean {
  if (acc.authRequired === true) return true
  const reason = acc.quotaUnavailable?.reason
  return reason === 'validation_required' || reason === 'tos_violation'
}
