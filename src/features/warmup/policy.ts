// Warmup policy: canonical model mapping, per-family model selection, project-id
// extraction, timing constants and the pure "which weekly windows are due"
// planner. No I/O and no service state.
import type { FamilyQuotaInfo, ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import { PREFERRED_CLAUDE, PREFERRED_GEMINI_FLASH, PREFERRED_OPENAI } from '../../common/model-lineup.ts'

/** Canonical model route resolution for upstream Google Cloud Code PA endpoints. */
export function toCanonicalWarmupModel(model: string): string {
  const clean = model.trim().toLowerCase()
  // Bare Gemini flash slugs must be mapped to the physical upstream entity
  // (`*-tiered`) to avoid 404 "Requested entity was not found"
  // (Antigravity-Manager #3715). `gemini-3-flash` is the legacy alias of 3.8.
  if (clean === 'gemini-3-flash') return 'gemini-3.8-flash-tiered'
  if (/^gemini-3\.\d+-flash$/.test(clean)) return clean + '-tiered'
  if (clean === 'gemini-4-argon' || clean === 'argon') {
    return 'gemini-4-argon-low'
  }
  return model.trim()
}

/** Select target model for a given family honoring user monitored_models preferences. */
export function pickWarmupModelForFamily(
  family: ModelFamily,
  monitoredModels: readonly string[] = [],
  account?: ManagedAccount,
): string {
  if (family === 'argon') {
    if (account?.quotas?.argon?.models?.length) {
      const m = account.quotas.argon.models.find((x) => x.modelId.includes('argon-low'))
        ?? account.quotas.argon.models.find((x) => x.modelId.includes('argon'))
      if (m) return m.modelId
    }
    return 'gemini-4-argon-low'
  }
  if (family === 'anthropic') {
    const accountModels = account?.quotas?.anthropic?.models?.map((m) => m.modelId) ?? []
    if (accountModels.length > 0) {
      const preferred = monitoredModels.find((m) => accountModels.includes(m))
      if (preferred) return preferred

      const sonnet = accountModels.find((m) => m.includes('sonnet') && (m.includes('low') || m.includes('medium')))
        ?? accountModels.find((m) => m.includes('sonnet'))
      if (sonnet) return sonnet

      const anyClaude = accountModels.find((m) => m.toLowerCase().includes('claude'))
      if (anyClaude) return anyClaude
    }
    const found = monitoredModels.find((m) => m.toLowerCase().includes('claude'))
    // 4.6 is retired upstream (agy 1.5.3 lists 5.5 only); legacy accounts pick
    // 4.6 from their own quota models above, so this fallback tracks current.
    return found ?? PREFERRED_CLAUDE
  }
  if (family === 'openai') {
    const found = monitoredModels.find((m) => m.toLowerCase().includes('gpt'))
    return found ?? PREFERRED_OPENAI
  }
  // google / default
  const found = monitoredModels.find((m) => m.toLowerCase().includes('gemini') && !m.toLowerCase().includes('argon'))
  return found ?? PREFERRED_GEMINI_FLASH
}

/**
 * `loadCodeAssist` returns `cloudaicompanionProject` either as a bare string or
 * as an object `{ id }` (the official clients and this repo's own OAuth fixture
 * both show the object form). Normalize both; an unresolved project must stay
 * empty instead of falling back to a shared project id — the backend rejects
 * foreign project ids with 403 "Caller does not have required permission".
 */
export function extractWarmupProjectId(data: unknown): string {
  const project = (data as { cloudaicompanionProject?: unknown } | null | undefined)?.cloudaicompanionProject
  if (typeof project === 'string' && project.trim() !== '') return project.trim()
  const id = (project as { id?: unknown } | null | undefined)?.id
  if (typeof id === 'string' && id.trim() !== '') return id.trim()
  return ''
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
}

export const SIX_DAYS_MS = 6 * 24 * 3600 * 1000
export const FOUR_HOURS_MS = 4 * 3600 * 1000
export const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000
/**
 * A failed probe (429/403/network) must not be retried by the 5-minute
 * scheduler; otherwise one restricted account turns into an endless WAF
 * hammer. Back off for 30 minutes before the next scheduled attempt.
 */
export const FAILURE_BACKOFF_MS = 30 * 60 * 1000

/** 1.5–3s randomized gap: a metronomic interval is itself a WAF signal. */
export function warmupDelayMs(): number {
  return 1500 + Math.floor(Math.random() * 1500)
}

/** Project ID resolver endpoints */
export const LOAD_PROJECT_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
]

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

/**
 * Decide whether one family's weekly window is due for a warmup probe. Kept
 * separate from `planWarmupTargets` to stay under the function budget while
 * preserving the original cooldown/backoff decision order.
 */
function warmupDue(params: {
  quota: FamilyQuotaInfo
  force: boolean
  now: number
  historyKey: string
  isCoolingDown(key: string, cooldownMs: number): boolean
}): { shouldWarm: boolean; failureKey: string } {
  const { quota, force, now, historyKey, isCoolingDown } = params
  let shouldWarm = false
  const hasRecentWarmup = isCoolingDown(historyKey, SIX_DAYS_MS)

  if (force) {
    shouldWarm = true
  } else if (!hasRecentWarmup) {
    if (!quota.weeklyResetTime) {
      // Cold start: weekly reset time uninitialized
      shouldWarm = true
    } else {
      const resetTs = Date.parse(quota.weeklyResetTime)
      if (isNaN(resetTs)) {
        shouldWarm = true
      } else {
        // Either:
        // 1. Time has reached/passed the scheduled reset instant (with 60s buffer)
        // 2. Or Google has already reset the window upstream and is presenting a
        //    floating / fresh ~7-day window (resetTs - now >= 6 days) waiting for activity
        const remainingMs = resetTs - now
        if (now >= resetTs - 60_000 || remainingMs >= SIX_DAYS_MS) {
          shouldWarm = true
        }
      }
    }
  }

  const failureKey = `${historyKey}:failed`
  if (shouldWarm && !force && isCoolingDown(failureKey, FAILURE_BACKOFF_MS)) {
    shouldWarm = false
  }
  return { shouldWarm, failureKey }
}

/**
 * Pure target planner for one account: honors the configured/monitored model
 * list, skips families already in cooldown or not yet due, and falls back to a
 * forced Google probe when a manual/forced run finds no weekly target.
 */
export function planWarmupTargets(params: {
  account: ManagedAccount
  force: boolean
  configuredModels: readonly string[] | undefined
  now: number
  isCoolingDown(key: string, cooldownMs: number): boolean
}): WarmupPlan {
  const { account, force, configuredModels, now, isCoolingDown } = params
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
    const familyCooldown = account.cooldowns?.[fam]
    if (!force && familyCooldown && familyCooldown.cooldownUntil > now) continue

    // Never guess: a partially hydrated quota row (REST fallback rows carry
    // only remainingFraction/resetTime) has weeklyFraction === undefined and
    // is NOT evidence that the weekly bucket is full. Treating it as 1.0
    // made every such refresh look like a cold start and fired probes.
    const weeklyFrac = q.weeklyFraction
    if (weeklyFrac === undefined || weeklyFrac < 0.999) continue

    const historyKey = `${identity}:${fam}:weekly`
    const { shouldWarm, failureKey } = warmupDue({ quota: q, force, now, historyKey, isCoolingDown })
    if (shouldWarm) {
      const model = pickWarmupModelForFamily(fam, monitored, account)
      targets.push({ family: fam, model, historyKey, failureKey })
    }
  }

  // Fallback if no weekly targets hit but user forced a warmup
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
