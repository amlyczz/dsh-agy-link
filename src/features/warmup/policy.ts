// Warmup policy: CLI model normalization, per-family model selection, timing
// constants and the pure "which weekly windows are due" planner.
// Zero direct HTTP endpoints or spoofed headers — probes run exclusively via
// the official `agy` CLI binary.
import type { FamilyQuotaInfo, ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import { isFamilyCooling } from '../../common/quota-bench.ts'
import { PREFERRED_CLAUDE, PREFERRED_GEMINI_FLASH, PREFERRED_OPENAI } from '../../common/model-lineup.ts'

/** Normalize a configured or quota-reported model ID into a clean `agy --model` CLI slug. */
export function toCliWarmupModel(model: string): string {
  const clean = model.trim().toLowerCase()
  if (clean === 'gemini-3-flash' || clean === 'gemini-3.8-flash-tiered') return 'gemini-3.8-flash'
  const tieredFlash = clean.match(/^(gemini-3\.\d+-flash)-tiered$/)
  if (tieredFlash?.[1]) return tieredFlash[1]
  if (clean === 'argon' || clean.startsWith('gemini-4-argon-')) return 'gemini-4-argon'
  const claude55 = clean.match(/^(claude-(?:sonnet|opus)-5-5)-(?:low|medium|high)$/)
  if (claude55?.[1]) return claude55[1]
  return model.trim()
}

/** Select target CLI model for a given family honoring user monitored_models preferences. */
export function pickWarmupModelForFamily(
  family: ModelFamily,
  monitoredModels: readonly string[] = [],
  account?: ManagedAccount,
): string {
  if (family === 'argon') {
    if (account?.quotas?.argon?.models?.length) {
      const m = account.quotas.argon.models.find((x) => x.modelId.includes('argon'))
      if (m) return toCliWarmupModel(m.modelId)
    }
    return 'gemini-4-argon'
  }
  if (family === 'anthropic') {
    const accountModels = account?.quotas?.anthropic?.models?.map((m) => m.modelId) ?? []
    if (accountModels.length > 0) {
      const preferred = monitoredModels.find((m) => accountModels.includes(m))
      if (preferred) return toCliWarmupModel(preferred)

      const sonnet = accountModels.find((m) => m.includes('sonnet'))
      if (sonnet) return toCliWarmupModel(sonnet)

      const anyClaude = accountModels.find((m) => m.toLowerCase().includes('claude'))
      if (anyClaude) return toCliWarmupModel(anyClaude)
    }
    const found = monitoredModels.find((m) => m.toLowerCase().includes('claude'))
    return toCliWarmupModel(found ?? PREFERRED_CLAUDE)
  }
  if (family === 'openai') {
    const found = monitoredModels.find((m) => m.toLowerCase().includes('gpt'))
    return toCliWarmupModel(found ?? PREFERRED_OPENAI)
  }
  const found = monitoredModels.find((m) => m.toLowerCase().includes('gemini') && !m.toLowerCase().includes('argon'))
  return toCliWarmupModel(found ?? PREFERRED_GEMINI_FLASH)
}

export interface WarmupResult {
  accountId: string
  alias: string
  email?: string
  model: string
  success: boolean
  status?: number
  error?: string
  durationMs: number
  skipped?: boolean
  skipReason?: string
  terminal?: boolean
}

export const SIX_DAYS_MS = 6 * 24 * 3600 * 1000
export const FOUR_HOURS_MS = 4 * 3600 * 1000
export const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000
/**
 * A failed probe (429/403/network) must not be retried by the 5-minute
 * scheduler; otherwise one restricted account turns into an endless hammer.
 * Back off for 30 minutes before the next scheduled attempt.
 */
export const FAILURE_BACKOFF_MS = 30 * 60 * 1000

/** 1.5–3s randomized gap: a metronomic interval is itself a risk-control signal. */
export function warmupDelayMs(): number {
  return 1500 + Math.floor(Math.random() * 1500)
}

/** One family/model the service should probe this run. */
export interface WarmupTarget {
  family: ModelFamily
  model: string
  historyKey: string
  failureKey: string
}

export type WarmupPlan =
  | { kind: 'targets'; targets: WarmupTarget[] }
  | { kind: 'skip'; model: string; reason: string }

/** Build a skipped WarmupResult (disabled / auth / cooldown / nothing due). */
export function skippedWarmupResult(
  account: ManagedAccount,
  model: string,
  reason: string,
  success = false,
): WarmupResult {
  return {
    accountId: account.id,
    alias: account.alias,
    email: account.email,
    model,
    success,
    durationMs: 0,
    skipped: true,
    skipReason: reason,
  }
}

function warmupDue(params: {
  quota: FamilyQuotaInfo
  force: boolean
  ignoreFailureBackoff?: boolean
  now: number
  historyKey: string
  isCoolingDown(key: string, cooldownMs: number): boolean
}): { shouldWarm: boolean; failureKey: string } {
  const { quota, force, ignoreFailureBackoff, now, historyKey, isCoolingDown } = params
  let shouldWarm = false
  const hasRecentWarmup = isCoolingDown(historyKey, SIX_DAYS_MS)

  if (force) {
    shouldWarm = true
  } else if (!hasRecentWarmup) {
    if (!quota.weeklyResetTime) {
      shouldWarm = true
    } else {
      const resetTs = Date.parse(quota.weeklyResetTime)
      if (isNaN(resetTs)) {
        shouldWarm = true
      } else {
        const remainingMs = resetTs - now
        if (now >= resetTs - 60_000 || remainingMs >= SIX_DAYS_MS) {
          shouldWarm = true
        }
      }
    }
  }

  const failureKey = `${historyKey}:failed`
  if (shouldWarm && !force && !ignoreFailureBackoff && isCoolingDown(failureKey, FAILURE_BACKOFF_MS)) {
    shouldWarm = false
  }
  return { shouldWarm, failureKey }
}

/**
 * Pure target planner for one account: honors the configured/monitored model
 * list, skips families already cooling or not yet due, and falls back to a
 * forced Google probe when a manual/forced run finds no weekly target.
 */
export function planWarmupTargets(params: {
  account: ManagedAccount
  force: boolean
  ignoreFailureBackoff?: boolean
  configuredModels: readonly string[] | undefined
  now: number
  isCoolingDown(key: string, cooldownMs: number): boolean
}): WarmupPlan {
  const { account, force, ignoreFailureBackoff, configuredModels, now, isCoolingDown } = params
  const identity = account.email || account.id

  if (configuredModels !== undefined && configuredModels.length === 0) {
    return { kind: 'skip', model: 'none', reason: 'No warmup models configured' }
  }
  const monitored = configuredModels ?? [PREFERRED_GEMINI_FLASH, PREFERRED_CLAUDE]
  const quotas = account.quotas ?? {}
  const families = Object.keys(quotas) as ModelFamily[]
  const targets: WarmupTarget[] = []

  for (const fam of families) {
    const q: FamilyQuotaInfo | undefined = quotas[fam]
    if (!q) continue
    if (!force && isFamilyCooling(account, fam, now)) continue

    const weeklyFrac = q.weeklyFraction
    if (weeklyFrac === undefined || weeklyFrac < 0.999) continue

    const historyKey = `${identity}:${fam}:weekly`
    const { shouldWarm, failureKey } = warmupDue({ quota: q, force, ignoreFailureBackoff, now, historyKey, isCoolingDown })
    if (shouldWarm) {
      const model = pickWarmupModelForFamily(fam, monitored, account)
      targets.push({ family: fam, model, historyKey, failureKey })
    }
  }

  if (targets.length === 0 && force) {
    const fallbackModel = pickWarmupModelForFamily('google', monitored, account)
    targets.push({
      family: 'google',
      model: fallbackModel,
      historyKey: `${identity}:google:forced:${Math.floor(now / SIX_DAYS_MS)}`,
      failureKey: `${identity}:google:forced:${Math.floor(now / SIX_DAYS_MS)}:failed`,
    })
  }

  if (targets.length === 0) {
    return { kind: 'skip', model: 'none', reason: 'All weekly quota windows in cooldown or not yet due for reset' }
  }
  return { kind: 'targets', targets }
}

export interface WarmupErrorInfo {
  error: string
  /** Terminal account state (e.g. a TOS ban): quarantine, do not keep probing. */
  terminal: boolean
  appealUrl?: string
  validationUrl?: string
}

/**
 * Classify upstream CLI / JSON errors without truncating critical URLs.
 * Detects both JSON `TOS_VIOLATION` envelopes and CLI warning text
 * (`This service has been disabled in this account for violation of Terms of Service`),
 * as well as temporary `VALIDATION_REQUIRED` challenges.
 */
export function describeWarmupError(status: number, body: string): WarmupErrorInfo {
  const detail = body.trim().slice(0, 2000)
  const appealUrl =
    /"appeal_url"\s*:\s*"([^"]+)"/.exec(body)?.[1] ??
    /(https:\/\/forms\.gle\/[A-Za-z0-9_-]+)/.exec(body)?.[1]
  const validationUrl =
    /"validation_url"\s*:\s*"([^"]+)"/.exec(body)?.[1] ??
    /(https:\/\/accounts\.google\.com\/[^\s"')]+)/.exec(body)?.[1]
  const terminal =
    /TOS_VIOLATION|violation of Terms of Service|service has been disabled in this account/i.test(body)
  const isValidation = !terminal && /VALIDATION_REQUIRED|verify your account/i.test(body)
  const suffix = appealUrl
    ? ` Appeal: ${appealUrl}`
    : isValidation && validationUrl
      ? ` Verify: ${validationUrl}`
      : ''
  const prefix = status >= 100 ? `HTTP ${status}: ` : ''
  return {
    error: `${prefix}${detail}${suffix}`.trim(),
    terminal,
    ...(appealUrl ? { appealUrl } : {}),
    ...(validationUrl ? { validationUrl } : {}),
  }
}
