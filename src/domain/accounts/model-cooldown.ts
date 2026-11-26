// Model-scoped cooldown bookkeeping — the "second dimension" of availability.
//
// A model family groups several quota buckets. `google` owns both the text
// models and the image model (`gemini-3.1-flash-image`), and Google meters the
// image bucket separately. Cooling the FAMILY for an image 429 is therefore
// wrong: it pauses text models that still have quota. This module owns the
// per-model half of the rules; `cooldowns[family]` keeps its meaning.
import type { FamilyCooldownState, ManagedAccount } from '../../common/pool-types.ts'
import { baseModelSlug } from '../../common/pool-types.ts'
import { isModelScopedQuotaFailure, parseResetDurationMs } from '../../common/types.ts'

/** Cooldown ceiling inputs shared with family-scoped recording. */
export interface CooldownBudget {
  defaultCooldownMs: number
  maxCooldownMs: number
}

/**
 * Absolute expiry for a 429. A server-provided reset (ISO timestamp or a
 * duration inside the message) wins; otherwise exponential backoff.
 */
export function cooldownUntilFor(
  budget: CooldownBudget,
  failures: number,
  reason: string,
  serverResetTime?: string,
  now = Date.now(),
): number {
  const parsedDuration = parseResetDurationMs(serverResetTime || reason)
  if (serverResetTime && !parsedDuration) {
    const parsed = Date.parse(serverResetTime)
    if (!Number.isNaN(parsed) && parsed > now) return parsed + 10_000
    return now + Math.min(budget.defaultCooldownMs * failures, budget.maxCooldownMs)
  }
  if (parsedDuration && parsedDuration > 0) return now + parsedDuration + 10_000
  return now + Math.min(budget.defaultCooldownMs * failures, budget.maxCooldownMs)
}

/** Record a 429 that belongs to ONE model's bucket; returns the stored state. */
export function applyModelFailure(
  acc: ManagedAccount,
  model: string,
  reason: string,
  serverResetTime: string | undefined,
  budget: CooldownBudget,
  now = Date.now(),
): FamilyCooldownState | null {
  const key = baseModelSlug(model)
  if (key === '') return null
  acc.modelCooldowns ??= {}
  const failures = (acc.modelCooldowns[key]?.consecutiveFailures ?? 0) + 1
  const next: FamilyCooldownState = {
    cooldownUntil: cooldownUntilFor(budget, failures, reason, serverResetTime, now),
    reason,
    consecutiveFailures: failures,
    recordedAt: now,
  }
  acc.modelCooldowns[key] = next
  return next
}

/** True when this exact model is cooling down (family ignored). */
export function hasModelCooldown(acc: ManagedAccount, model: string, now = Date.now()): boolean {
  const key = baseModelSlug(model)
  const cd = key === '' ? undefined : acc.modelCooldowns?.[key]
  return Boolean(cd && cd.cooldownUntil > now)
}

/** Clear one model's cooldown; returns true when something changed. */
export function clearModelCooldown(acc: ManagedAccount, model: string): boolean {
  const key = baseModelSlug(model)
  if (key === '' || acc.modelCooldowns?.[key] === undefined) return false
  delete acc.modelCooldowns[key]
  return true
}

/**
 * Migration: earlier builds cooled the whole FAMILY on a model-scoped 429
 * (image quota). Drop exactly those legacy entries; genuine family cooldowns
 * have unrelated reasons and stay.
 */
export function dropLegacyModelScopedFamilyCooldowns(accounts: readonly ManagedAccount[]): number {
  let dropped = 0
  for (const acc of accounts) {
    const cooldowns = acc.cooldowns
    if (!cooldowns) continue
    for (const family of Object.keys(cooldowns) as Array<keyof typeof cooldowns>) {
      const cd = cooldowns[family]
      if (cd && isModelScopedQuotaFailure(cd.reason)) {
        delete cooldowns[family]
        dropped += 1
      }
    }
  }
  return dropped
}
