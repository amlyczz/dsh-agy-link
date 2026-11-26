// Pure cooldown reconciliation when fresh quota data arrives.
//
// Prevents an account whose quota has already reset or recovered to 100% from
// remaining stuck in "cooling down" due to an earlier 429 backoff timer or
// previous-window reset timestamp, while preserving legitimate fresh 429s and
// mid-cycle partial-quota cooldowns.
import {
  baseModelSlug,
  sharedArgonPeerFamily,
  type FamilyCooldownState,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import { LOW_QUOTA_5H, LOW_QUOTA_WEEKLY } from '../../common/quota-bench.ts'
import { FIVE_HOUR_WINDOW_MS, WEEKLY_WINDOW_MS } from '../../common/quota-pacing.ts'
import { QUOTA_WINDOW_MATCH_TOLERANCE_MS } from '../quota/buckets.ts'

/** Minimum fraction treated as a fully recovered (100%) quota bucket. */
export const FULL_QUOTA_THRESHOLD = 0.999

/**
 * Grace period after recording a 429 during which an unchanged 100% reading
 * will not clear the cooldown (protects against post-attempt refresh lag).
 */
export const COOLDOWN_FRESH_GRACE_MS = 2 * 60_000

function parseIsoMs(iso?: string): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function windowRolledOver(
  prevResetStr: string | undefined,
  newResetStr: string | undefined,
  windowMs: number,
  newFraction: number | undefined,
  lowThreshold: number,
  cdRecordedAt: number | undefined,
): boolean {
  if (typeof newFraction === 'number' && newFraction <= lowThreshold) return false
  const newResetMs = parseIsoMs(newResetStr)
  if (newResetMs === null) return false
  const prevResetMs = parseIsoMs(prevResetStr)
  if (prevResetMs !== null && newResetMs - prevResetMs > QUOTA_WINDOW_MATCH_TOLERANCE_MS) {
    return true
  }
  if (cdRecordedAt !== undefined) {
    const windowStartMs = newResetMs - windowMs
    if (cdRecordedAt < windowStartMs - QUOTA_WINDOW_MATCH_TOLERANCE_MS) {
      return true
    }
  }
  return false
}

function isFreshSnapshot(
  prevQuota: FamilyQuotaInfo | undefined,
  newQuota: FamilyQuotaInfo,
): boolean {
  if (
    newQuota.updatedAt !== undefined &&
    prevQuota?.updatedAt !== undefined &&
    newQuota.updatedAt <= prevQuota.updatedAt
  ) {
    return false
  }
  return true
}

function isCooldownSuperseded(
  cd: FamilyCooldownState,
  prevQuota: FamilyQuotaInfo | undefined,
  newQuota: FamilyQuotaInfo,
  summaryTrusted: boolean,
  now: number,
): boolean {
  if (cd.cooldownUntil <= now) return false
  if (!isFreshSnapshot(prevQuota, newQuota)) return false

  const has5h = typeof newQuota.remainingFraction === 'number'
  const hasWeekly = typeof newQuota.weeklyFraction === 'number'
  if (!has5h && !hasWeekly) return false

  const notExhausted5h = !has5h || newQuota.remainingFraction! > LOW_QUOTA_5H
  const notExhaustedWeekly = !hasWeekly || newQuota.weeklyFraction! > LOW_QUOTA_WEEKLY
  if (!notExhausted5h || !notExhaustedWeekly) return false

  const rolled5h = windowRolledOver(
    prevQuota?.resetTime,
    newQuota.resetTime,
    FIVE_HOUR_WINDOW_MS,
    newQuota.remainingFraction,
    LOW_QUOTA_5H,
    cd.recordedAt,
  )
  const rolledWeekly = windowRolledOver(
    prevQuota?.weeklyResetTime,
    newQuota.weeklyResetTime,
    WEEKLY_WINDOW_MS,
    newQuota.weeklyFraction,
    LOW_QUOTA_WEEKLY,
    cd.recordedAt,
  )
  const recovered5h =
    typeof prevQuota?.remainingFraction === 'number' &&
    prevQuota.remainingFraction <= LOW_QUOTA_5H &&
    has5h &&
    newQuota.remainingFraction! > LOW_QUOTA_5H
  const recoveredWeekly =
    typeof prevQuota?.weeklyFraction === 'number' &&
    prevQuota.weeklyFraction <= LOW_QUOTA_WEEKLY &&
    hasWeekly &&
    newQuota.weeklyFraction! > LOW_QUOTA_WEEKLY

  if (rolled5h || rolledWeekly || recovered5h || recoveredWeekly) {
    return true
  }

  if (!summaryTrusted) return false

  const isFull5h = !has5h || newQuota.remainingFraction! >= FULL_QUOTA_THRESHOLD
  const isFullWeekly = !hasWeekly || newQuota.weeklyFraction! >= FULL_QUOTA_THRESHOLD
  if (!isFull5h || !isFullWeekly) return false

  // A brand-new 429 on an already-100% snapshot stays guarded briefly so an
  // immediate post-failure refresh cannot erase it before upstream catches up.
  if (cd.recordedAt !== undefined && now - cd.recordedAt < COOLDOWN_FRESH_GRACE_MS) {
    return false
  }
  return true
}

function reconcileModelCooldowns(
  acc: ManagedAccount,
  prevQuota: FamilyQuotaInfo | undefined,
  newQuota: FamilyQuotaInfo,
  summaryTrusted: boolean,
  now: number,
): boolean {
  if (!acc.modelCooldowns || !Array.isArray(newQuota.models) || newQuota.models.length === 0) {
    return false
  }
  let changed = false
  for (const [slug, mcd] of Object.entries(acc.modelCooldowns)) {
    if (!mcd || mcd.cooldownUntil <= now) continue
    const matched = newQuota.models.filter((m) => baseModelSlug(m.modelId) === slug)
    if (matched.length === 0) continue
    const prevMatched = prevQuota?.models?.find((m) => baseModelSlug(m.modelId) === slug)
    const minRemaining = Math.min(
      ...matched.map((m) => (typeof m.remainingFraction === 'number' ? m.remainingFraction : 1)),
    )
    const repReset = matched.find((m) => typeof m.resetTime === 'string' && m.resetTime !== '')?.resetTime
    const syntheticNew: FamilyQuotaInfo = {
      remainingFraction: minRemaining,
      ...(repReset !== undefined ? { resetTime: repReset } : {}),
      ...(newQuota.updatedAt !== undefined ? { updatedAt: newQuota.updatedAt } : {}),
    }
    const syntheticPrev: FamilyQuotaInfo | undefined = prevMatched
      ? {
          ...(prevMatched.remainingFraction !== undefined ? { remainingFraction: prevMatched.remainingFraction } : {}),
          ...(prevMatched.resetTime !== undefined ? { resetTime: prevMatched.resetTime } : {}),
          ...(prevQuota?.updatedAt !== undefined ? { updatedAt: prevQuota.updatedAt } : {}),
        }
      : undefined
    if (isCooldownSuperseded(mcd, syntheticPrev, syntheticNew, summaryTrusted, now)) {
      delete acc.modelCooldowns[slug]
      changed = true
    }
  }
  return changed
}

/**
 * Reconcile active family and model cooldowns against freshly arrived quota
 * rows. Clears cooldowns disproven by a window rollover, recovery from an
 * exhausted state, or a trusted 100% snapshot. Returns true when modified.
 */
export function reconcileCooldownsFromQuota(
  acc: ManagedAccount,
  prevQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>,
  incomingQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>,
  now = Date.now(),
): boolean {
  const unavailReason = acc.quotaUnavailable?.reason
  const summaryTrusted = unavailReason === undefined || unavailReason === 'no_summary_access'
  let changed = false

  for (const [famKey, info] of Object.entries(incomingQuotas) as [ModelFamily, FamilyQuotaInfo | undefined][]) {
    if (!info) continue
    const prev = prevQuotas[famKey]
    const peer = sharedArgonPeerFamily(acc, famKey)
    const directCd = acc.cooldowns?.[famKey]
    const peerCd = peer ? acc.cooldowns?.[peer] : undefined

    if (directCd && isCooldownSuperseded(directCd, prev, info, summaryTrusted, now)) {
      delete acc.cooldowns[famKey]
      changed = true
      if (peer && acc.cooldowns?.[peer]) {
        delete acc.cooldowns[peer]
      }
    } else if (peer && peerCd && isCooldownSuperseded(peerCd, prev, info, summaryTrusted, now)) {
      delete acc.cooldowns[peer]
      changed = true
    }

    if (reconcileModelCooldowns(acc, prev, info, summaryTrusted, now)) {
      changed = true
    }
  }

  return changed
}
