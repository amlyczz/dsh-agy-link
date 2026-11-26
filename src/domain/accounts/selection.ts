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
  argonSharesGoogleGroup,
  baseModelSlug,
  effectiveFamilyCooldown,
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
export type AccountIneligibilityReason = 'disabled' | 'auth' | 'cooldown' | 'quota' | 'unsupported' | 'model-unsupported' | 'model-cooldown'

/**
 * The slice of the pool the Argon check needs: whether an account has itself
 * reported a dedicated quota group for a family. Passed explicitly instead of
 * reaching for `this`.
 */
export interface DedicatedGroupSource {
  hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean
  isModelSupported?: (acc: ManagedAccount, model: string) => boolean
  catalogForAccount?: (id: string) => { source?: string; models?: readonly { id: string }[] } | undefined
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
  if (family === 'argon' && !accountHasArgon(acc, pool, pool?.catalogForAccount?.(acc.id))) return 'unsupported'
  // "This model is not in the account's catalog" is NOT the same diagnosis as
  // "the account has no access to this family / plan" (issues #120, #122).
  if (model && pool?.isModelSupported && !pool.isModelSupported(acc, model)) {
    return 'model-unsupported'
  }
  const cd = effectiveFamilyCooldown(acc, family)
  if (cd && cd.cooldownUntil > now) return 'cooldown'
  // A model-scoped cooldown (e.g. the image model's own 429) removes the
  // account only for THAT model — other models in the family stay usable.
  if (model) {
    const mcd = acc.modelCooldowns?.[baseModelSlug(model)]
    if (mcd && mcd.cooldownUntil > now) return 'model-cooldown'
  }
  if (isQuotaBenched(acc, family, now, model)) return 'quota'
  return null
}

/**
 * Pick an eligible account WITHOUT mutating any active pointer.
 *
 * Used by cross-model requests (image generation): rotating a model-scoped
 * bucket must never steal the family's sticky account from a chat turn.
 */
export function pickEligibleAccount(
  accounts: readonly ManagedAccount[],
  pool: DedicatedGroupSource | null | undefined,
  input: {
    family: ModelFamily
    model?: string
    quotaModel?: string
    avoid?: readonly string[]
    activeId?: string
    now: number
  },
): ManagedAccount | null {
  const skip = new Set(input.avoid ?? [])
  const candidates = accounts.filter(
    (acc) =>
      !skip.has(acc.id) &&
      explainIneligibility(acc, input.family, input.now, pool, input.model) === null &&
      (input.quotaModel === undefined || input.quotaModel === '' ||
        isModelQuotaClear(acc, input.family, input.quotaModel, input.now)),
  )
  if (candidates.length === 0) return null
  const active = candidates.find((acc) => acc.id === input.activeId)
  return (
    (active && isInNarrowestTier(active, candidates, input.family) ? active : undefined) ??
    orderByExpiry(accounts, candidates, input.family, input.activeId, input.now)[0] ??
    null
  )
}

/**
 * True when a specific MODEL's quota bucket still has room on this account.
 *
 * Used for cross-model eligibility: an image request must pick an account whose
 * IMAGE bucket is healthy even though the driving chat model lives in the same
 * `google` family. Family-level checks alone cannot see that.
 */
export function isModelQuotaClear(acc: ManagedAccount, family: ModelFamily, model: string, now: number): boolean {
  if (model.trim() === '') return true
  const mcd = acc.modelCooldowns?.[baseModelSlug(model)]
  if (mcd && mcd.cooldownUntil > now) return false
  return !isQuotaBenched(acc, family, now, model)
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
  // Argon reads its own quota row when present, and only uses `google` when
  // `google.description` explicitly names Argon (agy 1.5.15 shared Gemini pool).
  if (family === 'argon' && argonSharesGoogleGroup(acc)) {
    return acc.quotas?.google
  }
  return acc.quotas?.[family]
}

/**
 * Capability set an account reports for one family: base slugs of the models
 * in its quota breakdown. Undefined when the account has not reported any.
 */
function familyCapabilities(acc: ManagedAccount, family: ModelFamily): Set<string> | undefined {
  const models = effectiveFamilyQuota(acc, family)?.models
  if (!Array.isArray(models) || models.length === 0) return undefined
  return new Set(models.map((m) => baseModelSlug(m.modelId)))
}

/**
 * "Exclusive capability" of each candidate: how many models it can serve that
 * NOT every candidate can. All candidates already serve the requested model,
 * so this counts what an account would be uniquely needed for later.
 *
 * A request should go to the account the other models need least: when a
 * cheaper model shares a quota bucket with a scarcer one (e.g. Hydrogen and
 * Neon on the same account), spending a Hydrogen-only account first keeps the
 * dual-capable account's bucket for Neon. Models every candidate supports
 * cancel out, so catalog noise common to all accounts never matters. Accounts
 * with no reported model list score 0 (no evidence of extra capability).
 */
export function exclusiveCapabilityScores(
  candidates: readonly ManagedAccount[],
  family: ModelFamily,
): Map<string, number> {
  const caps = candidates.map((acc) => [acc.id, familyCapabilities(acc, family)] as const)
  const known = caps.flatMap(([, c]) => (c ? [c] : []))
  const shared = known.length === 0 ? new Set<string>() : new Set([...known[0]!].filter((m) => known.every((c) => c.has(m))))
  return new Map(caps.map(([id, c]) => [id, c ? [...c].filter((m) => !shared.has(m)).length : 0]))
}

/**
 * True when `acc` is among the candidates with the fewest exclusive
 * capabilities. A sticky account outside that tier should yield, so a
 * narrower account that comes back from cooldown is picked up again.
 */
export function isInNarrowestTier(
  acc: ManagedAccount,
  candidates: readonly ManagedAccount[],
  family: ModelFamily,
): boolean {
  const scores = exclusiveCapabilityScores(candidates, family)
  return (scores.get(acc.id) ?? 0) <= Math.min(...scores.values())
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
 * Priority 0: Fewest exclusive capabilities (see exclusiveCapabilityScores).
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
  const exclusive = exclusiveCapabilityScores(candidates, family)
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
        failures: effectiveFamilyCooldown(acc, family)?.consecutiveFailures ?? 0,
        surplus: candidateSurplusScore(q, now),
        exclusive: exclusive.get(acc.id) ?? 0,
      }
    })
    .sort((a, b) => {
      // Priority 0: Keep scarce capabilities in reserve
      if (a.exclusive !== b.exclusive) return a.exclusive - b.exclusive

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
  const candidates = accounts.filter((acc) => isAccountEligible(acc, family, now, pool, model))
  if (candidates.length === 0) return undefined
  const pinned = candidates.find((a) => a.id === pinnedId)
  if (pinned && isInNarrowestTier(pinned, candidates, family)) return pinned.id
  return orderByExpiry(accounts, candidates, family, pinnedId, now)[0]?.id
}
