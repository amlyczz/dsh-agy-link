// Domain types and models for the Antigravity Multi-Account Pool & Sequential Drain.

export type ModelFamily = 'google' | 'argon' | 'anthropic' | 'openai' | 'unknown'

/** Subscription plan tier inferred from authoritative quota groups / models. */
export type AccountPlanTier = 'ultra' | 'pro' | 'free' | 'enterprise' | 'unknown'

/** Check if a model identifier belongs to the Gemini 4 Argon family. */
export function isArgonModel(modelId?: string): boolean {
  if (!modelId) return false
  const lower = modelId.trim().toLowerCase()
  return lower.includes('argon') || lower === 'gemini-pro-orchestrator-g1-pro'
}

/**
 * Map a model slug to its backend quota counter family.
 *
 * Gemini 4 Argon (Pro/Ultra-only) bills against Argon's pool (or the shared
 * Gemini pool when folded by agy 1.5.15+). Its ids look like `gemini-4-argon-*`
 * or `gemini-pro-orchestrator-argon` / `-g1-pro` and MUST be detected before
 * the generic `gemini-` prefix below.
 */
export function modelFamilyOf(modelId?: string): ModelFamily {
  if (!modelId) return 'unknown'
  const id = modelId.toLowerCase()
  if (isArgonModel(id)) return 'argon'
  if (id.startsWith('claude-') || id.includes('claude')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-') || id.includes('gemini')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/') || id.includes('gpt-oss')) return 'openai'
  return 'unknown'
}

/**
 * True when the backend's shared `Gemini Models` (`quotas.google`) group
 * description explicitly names Argon as a member (observed on all paid plans
 * since agy 1.5.12/1.5.15) — i.e. Argon is not a separate plan bucket but one
 * model family inside the Gemini pool.
 *
 * The group's own membership list is authoritative. An accompanying
 * `quotas.argon` row does NOT prove an independent ledger: since agy 1.5.15 the
 * backend reports the merged group under both keys, with the argon copy carrying
 * the same weekly window and no 5h row of its own (2026-11-25: the account card
 * grew a second, phantom "Argon 0%" bucket from exactly that shape). Accounts
 * whose Gemini group does not list Argon keep independent ledgers.
 */
export function argonSharesGoogleGroup(acc?: ManagedAccount | null): boolean {
  return Boolean(acc && isArgonModel(acc.quotas?.google?.description))
}

/**
 * Peer quota family when Argon shares the Gemini Models bucket (`google` <-> `argon`).
 */
export function sharedArgonPeerFamily(
  acc?: ManagedAccount | null,
  family?: ModelFamily,
): ModelFamily | undefined {
  if (!argonSharesGoogleGroup(acc)) return undefined
  if (family === 'argon') return 'google'
  if (family === 'google') return 'argon'
  return undefined
}

/**
 * Effective cooldown state for `family`, mirroring the peer bucket's cooldown
 * when Argon shares the Gemini Models group (`argonSharesGoogleGroup`).
 */
export function effectiveFamilyCooldown(
  acc: ManagedAccount | null | undefined,
  family: ModelFamily,
): FamilyCooldownState | undefined {
  const direct = acc?.cooldowns?.[family]
  const peerFam = sharedArgonPeerFamily(acc, family)
  const peer = peerFam ? acc?.cooldowns?.[peerFam] : undefined
  if (!direct) return peer
  if (!peer) return direct
  return peer.cooldownUntil > direct.cooldownUntil ? peer : direct
}

export interface ModelQuotaInfo {
  modelId: string
  displayName?: string
  remainingFraction?: number
  resetTime?: string
}

export interface FamilyQuotaInfo {
  /** 5-hour rolling remaining quota fraction: 0.0 (exhausted) to 1.0 (full). */
  remainingFraction?: number
  /** ISO-8601 timestamp for when the 5-hour quota window resets. */
  resetTime?: string
  /** Weekly remaining quota fraction: 0.0 (exhausted) to 1.0 (full). */
  weeklyFraction?: number
  /** ISO-8601 timestamp for when the weekly quota resets. */
  weeklyResetTime?: string
  /** Description / tooltip from upstream backend */
  description?: string
  /** Timestamp when this quota was last updated locally. */
  updatedAt?: number
  /** Optional model-level breakdown in this family. */
  models?: ModelQuotaInfo[]
}

export interface FamilyCooldownState {
  /** Timestamp when cooldown expires and account becomes available again. */
  cooldownUntil: number
  /** Reason for cooldown (e.g. "429 Rate Limit", "Quota Exhausted"). */
  reason: string
  /** Consecutive rate-limit failure count (for exponential/tiered backoff). */
  consecutiveFailures: number
}

export interface ManagedAccount {
  id: string
  alias: string
  /** True only when `alias` is the server-owned canonical built-in default. */
  defaultAlias?: boolean
  email?: string
  /**
   * Absolute path to the isolated account home directory. Empty for the
   * primary/system account: agy 1.1.15+ stores credentials in the macOS
   * Keychain (Antigravity Safe Storage), NOT in a ~/.gemini token file, so
   * the primary account must keep the real system HOME to stay signed in.
   */
  dir: string
  /**
   * True when this account rides the real system HOME (no HOME injection).
   * Always true for the primary account; only secondary pool accounts get
   * isolated HOME directories.
   */
  systemHome?: boolean
  /** Optional custom proxy URL override (e.g. "socks5://127.0.0.1:7890"). */
  proxyUrl?: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  /** Set to true when OAuth token refresh fails with invalid_grant or authentication is rejected. */
  authRequired?: boolean
  /** Last authentication failure reason. */
  authError?: string
  /** When authRequired was last set (drives the background re-verification cadence). */
  authMarkedAt?: number
  /**
   * Consecutive background re-verifications that failed to disprove the flag.
   * Drives an exponential back-off (2m → 4m → 8m → 16m → 30m) so a genuinely
   * dead login is not re-probed every two minutes, while a transient false
   * positive heals on the first attempt.
   */
  authReverifyAttempts?: number
  /** Cooldown state tracked per model family. */
  cooldowns: Partial<Record<ModelFamily, FamilyCooldownState>>
  /**
   * Cooldown state tracked per MODEL (base slug), for quota buckets that belong
   * to a single model rather than the family — e.g. `gemini-3.1-flash-image`.
   * A model-scoped 429 must never leave the family's OTHER models unavailable.
   */
  modelCooldowns?: Record<string, FamilyCooldownState>
  /** Cached real-time quota statistics per model family. */
  quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
  /**
   * Per-family `updatedAt` of the quota snapshot an explicit user action
   * (`/agy clear-cooldown`) overrode. Proactive low-quota benching is ignored
   * while the cached row is no newer than this stamp, so the override can
   * never outlive the data it was meant to fix: the next poll re-arms it.
   */
  quotaGateClearedAt?: Partial<Record<ModelFamily, number>>
  /**
   * Families this account has itself reported a dedicated quota group for.
   *
   * Only used to tell "the bucket went away" (Pro -> Ultra folds Argon into the
   * Gemini bucket) apart from "this account never had one" (free tier, or a
   * plan that never exposes Argon) — the latter must never have its cooldown
   * cleared, because its argon cooldowns come from real 429s.
   */
  dedicatedGroups?: ModelFamily[]
  /** Subscription tier (`ultra` | `pro` | `free` | `enterprise`), inferred from quota/model evidence. */
  planTier?: AccountPlanTier
  /**
   * An explicit tier the user pinned for this account (`/agy plan <id|alias> <tier>`).
   *
   * WHY: the quota API cannot tell Pro from Ultra any more — agy 1.5.15 lists
   * Argon inside the shared Gemini group for every paid plan, exposes no tier
   * field, and the Antigravity licence service is not reachable from here
   * (2026-11-24). Inference therefore reports the conservative `pro`; this field
   * is the only truthful way to show a genuinely different plan, and it outranks
   * every inferred value in `resolveAccountPlanTier`.
   */
  planTierOverride?: AccountPlanTier
  /**
   * Why the last quota refresh produced no authoritative snapshot, and when it
   * may be probed again.
   *
   * WHY: a failed refresh used to be invisible. `buildFamilyQuotas` keeps the
   * previous complete snapshot when the summary is unavailable (correct — a
   * partial fallback must never overwrite good data), so an account whose
   * summary endpoint answers 403 "not a valid license" showed yesterday's
   * percentages forever with no error anywhere (live 2026-11-19). Recording the
   * reason lets the console say "quota unavailable" and lets the background
   * sweep stop re-probing an account that cannot answer.
   */
  quotaUnavailable?: QuotaUnavailableState
}

/**
 * `no_license` — the backend refused the summary as unlicensed (403).
 * `auth` — the summary was refused as unauthenticated (401).
 * `unreachable` — every endpoint failed at the network layer.
 * `partial` — the summary was missing but per-model fallback data arrived.
 */
export type QuotaUnavailableReason =
  | 'no_license'
  /**
   * The summary endpoint refuses this account outright (free tier: 403
   * PERMISSION_DENIED without VALIDATION_REQUIRED / TOS_VIOLATION). Terminal
   * for the SUMMARY call only — the account still serves models, so it stays
   * in the poll (issue #137).
   */
  | 'no_summary_access'
  /** Google requires web verification (`403 PERMISSION_DENIED` + `VALIDATION_REQUIRED`). */
  | 'validation_required'
  /** Account suspended (`403 PERMISSION_DENIED` + `TOS_VIOLATION`). */
  | 'tos_violation'
  | 'auth'
  | 'unreachable'
  | 'partial'

export interface QuotaUnavailableState {
  reason: QuotaUnavailableReason
  /** When this state was first observed (not re-stamped by skipped probes). */
  since: number
  /** Epoch ms after which an unattended probe may try again. */
  retryAfter: number
  /** Short, non-sensitive detail (HTTP status family / PERMISSION_DENIED…). */
  detail?: string
  /** Optional safe HTTPS action URL (e.g. Google `validation_url` for account verification). */
  actionUrl?: string
}

/**
 * True when the unattended quota probe must skip this account's summary call.
 *
 * Only terminal account-level refusals suppress: retrying them every hour is
 * pure risk-control exposure. `auth` stays on the existing authRequired
 * lifecycle, and network faults must be retried normally.
 */
export function quotaSummarySuppressed(account: ManagedAccount, now = Date.now()): boolean {
  const state = account.quotaUnavailable
  if (state === undefined) return false
  if (
    state.reason !== 'no_license'
    && state.reason !== 'no_summary_access'
    && state.reason !== 'validation_required'
    && state.reason !== 'tos_violation'
  ) {
    return false
  }
  return state.retryAfter > now
}

/**
 * Whether the account should leave the background poll ENTIRELY.
 *
 * Unlicensed, verification-blocked, and suspended accounts cannot produce
 * usable quota until the user intervenes. A free-tier account whose SUMMARY is
 * refused still refreshes its model list and user quota (issue #137).
 */
export function accountPollSuppressed(account: ManagedAccount, now = Date.now()): boolean {
  const state = account.quotaUnavailable
  if (state === undefined) return false
  if (state.reason !== 'no_license' && state.reason !== 'validation_required' && state.reason !== 'tos_violation') {
    return false
  }
  return state.retryAfter > now
}

/**
 * Determine whether a managed account has confirmed access to the Gemini 4 Argon family.
 *
 * An account qualifies for Argon when:
 * 1. It carries an authoritative Argon quota bucket.
 * 2. It has a dedicated Argon group recorded by the pool.
 * 3. Its Google per-model quota breakdown includes an Argon model.
 * 4. Or its discovered catalog includes Argon (when no negative quota breakdown is present).
 */
export function accountHasArgon(
  acc?: ManagedAccount | null,
  pool?: { hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean } | null,
  catalog?: { source?: string; models?: readonly { id: string }[] } | null,
): boolean {
  if (!acc) return false

  // 1. Authoritative quota bucket explicitly exists
  if (acc.quotas?.argon !== undefined) return true

  // 2. Pool recorded dedicated Argon quota group (PR #54)
  if (pool && typeof pool.hasDedicatedGroup === 'function' && pool.hasDedicatedGroup(acc.id, 'argon')) return true

  // 3. Per-model quotas or shared Gemini group description explicitly naming Argon
  //    (agy 1.5.12/1.5.15 paid plans enumerate Gemini 4 Argon / Orchestrator (Argon) here).
  if (acc.quotas?.google?.models?.some((m) => isArgonModel(m.modelId))) return true
  if (isArgonModel(acc.quotas?.google?.description)) return true

  // 4. Authoritative negative only when the Google group reported a PER-MODEL breakdown
  if (Array.isArray(acc.quotas?.google?.models)) {
    return false
  }

  // 5. Account's discovered catalog contains argon (only when quota has not been polled yet)
  if (catalog && catalog.source === 'discovered') {
    return catalog.models?.some((m) => isArgonModel(m.id)) ?? false
  }

  return false
}

const EFFORT_SUFFIX_RE = /-(?:tiered-)?(?:low|medium|high|xhigh|tiered|thinking)$/i

/**
 * Return the un-tiered base model slug (e.g. claude-opus-4-6-thinking -> claude-opus-4-6,
 * claude-opus-5-5-high -> claude-opus-5-5).
 */
export function baseModelSlug(id: string): string {
  const s = id.trim().toLowerCase().replace(/\./g, '-')
  if (s === 'claude-opus-4-6' || s === 'claude-opus-4-8' || s === 'claude-opus-4-5') return 'claude-opus-4-6'
  if (s === 'claude-sonnet-4-5') return 'claude-sonnet-4-6'
  return s.replace(EFFORT_SUFFIX_RE, '')
}

/**
 * Test whether a requested model matches a candidate model id (accounting for
 * aliases, effort variants, and base model families).
 */
export function modelMatches(requestedModel: string, candidateModelId: string): boolean {
  if (!requestedModel || !candidateModelId) return false
  const r = requestedModel.trim().toLowerCase()
  const c = candidateModelId.trim().toLowerCase()
  if (r === c) return true
  return baseModelSlug(r) === baseModelSlug(c)
}

function quotaSupportsModel(
  acc: ManagedAccount,
  clean: string,
  pool?: { hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean } | null,
  catalog?: { source?: string; models?: readonly { id: string }[] } | null,
): boolean {
  const familyQuotaModels = acc.quotas?.[modelFamilyOf(clean)]?.models
  if (Array.isArray(familyQuotaModels) && familyQuotaModels.some((m) => modelMatches(clean, m.modelId))) {
    return true
  }
  // CLI-synthesized orchestrator slugs (`gemini-pro-orchestrator-neon`,
  // `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon` / `-g1-pro`)
  // never appear in Google's REST quota breakdown (`fetchAvailableModels`),
  // which only returns their backing models (`gemini-4-neon-*`,
  // `gemini-4-carbon-*`, Argon). Infer support from that backing evidence so
  // Pro/Ultra accounts are never falsely rejected before per-account
  // `agy models` discovery finishes or when a cached catalog predates a rollout.
  const lower = clean.toLowerCase()
  if (lower === 'gemini-pro-orchestrator-neon') {
    return Array.isArray(familyQuotaModels) && familyQuotaModels.some((m) => modelMatches('gemini-4-neon', m.modelId))
  }
  if (lower === 'gemini-pro-orchestrator' || lower === 'gemini-pro-orchestrator-carbon') {
    return Array.isArray(familyQuotaModels) && familyQuotaModels.some((m) => modelMatches('gemini-4-carbon', m.modelId))
  }
  if (lower === 'gemini-pro-orchestrator-g1-pro' || lower === 'gemini-pro-orchestrator-argon') {
    return accountHasArgon(acc, pool, catalog)
  }
  return false
}

/**
 * Determine whether a managed account supports a specific model.
 * If the account's quota or discovered catalog enumerates models for that family,
 * the list is authoritative: the model must match an available entry.
 */
export function accountSupportsModel(
  acc?: ManagedAccount | null,
  model?: string,
  pool?: { hasDedicatedGroup?: (id: string, family: ModelFamily) => boolean } | null,
  catalog?: { source?: string; models?: readonly { id: string }[] } | null,
): boolean {
  if (!acc) return false
  if (!model || model.trim() === '') return true
  const clean = model.trim()

  if (isArgonModel(clean)) {
    return accountHasArgon(acc, pool, catalog)
  }

  // A discovered catalog is authoritative when it AFFIRMS the model. A
  // NEGATIVE answer is weaker: `agy models` silently prints a stale/fallback
  // snapshot when auth was unavailable, and that snapshot used to veto the
  // account's own quota groups forever (issue #122). Let explicit quota
  // evidence win over a negative catalog entry.
  if (catalog && catalog.source === 'discovered' && Array.isArray(catalog.models) && catalog.models.length > 0) {
    if (catalog.models.some((m) => modelMatches(clean, m.id))) return true
    if (quotaSupportsModel(acc, clean, pool, catalog)) return true
    return false
  }

  const family = modelFamilyOf(clean)
  const familyQuota = acc.quotas?.[family]
  if (familyQuota) {
    if (Array.isArray(familyQuota.models) && familyQuota.models.length > 0) {
      return quotaSupportsModel(acc, clean, pool, catalog)
    }
    return true
  }

  // Quota was polled for this account, but this family (e.g. anthropic) is completely missing:
  if (acc.quotas && Object.keys(acc.quotas).length > 0 && acc.quotas.google !== undefined) {
    return false
  }

  return true
}

export type AccountHealthStatus = 'healthy' | 'cooldown' | 'auth_required' | 'disabled'

export interface AccountHealthInfo {
  status: AccountHealthStatus
  message?: string
  cooldownMs?: number
}

/**
 * Whether the background quota poller should touch this account at all.
 * Disabled, auth-quarantined and cooldown accounts are skipped so automatic
 * polling never hammers Google endpoints for accounts already known to be
 * restricted (risk-control exposure minimization). Manual force refresh
 * from the UI bypasses this gate.
 */
export function shouldPollAccount(account: ManagedAccount): boolean {
  if (!account.enabled) return false
  if (account.authRequired) return false
  const now = Date.now()
  // An account whose summary endpoint refuses it as unlicensed cannot produce
  // quota data; probing it every hour only repeats the refusal. A free-tier
  // account is only summary-refused and keeps polling (#137).
  if (accountPollSuppressed(account, now)) return false
  const quotaFamilies = Object.entries(account.quotas ?? {})
    .filter(([, q]) => q !== undefined)
    .map(([fam]) => fam as ModelFamily)
  if (quotaFamilies.length > 0) {
    // Only skip polling when EVERY known quota family has an active 429 cooldown:
    // cooling Gemini must not stop healthy Argon/Claude/GPT families from refreshing.
    const allCooling = quotaFamilies.every((fam) => {
      const cd = effectiveFamilyCooldown(account, fam)
      return Boolean(cd && cd.cooldownUntil > now)
    })
    return !allCooling
  }
  for (const cd of Object.values(account.cooldowns ?? {})) {
    if (cd && cd.cooldownUntil > now) return false
  }
  return true
}

/**
 * How many independent, NON-authoritative auth-classified failures are needed
 * before an account is sticky-quarantined. agy's "not signed in" stderr banner
 * is byte-identical for a real sign-out and for a keyring validation that died
 * on the network, so a SINGLE occurrence is not proof of a dead login (live
 * incident 2026-10-16: one afternoon of proxy jitter quarantined three healthy
 * accounts on first sight). Authoritative evidence (invalid_grant, revoked…)
 * and the explicit re-login paths bypass this gate entirely.
 */
export const AUTH_CONFIRM_STRIKES = 2

/**
 * After this long, an authRequired flag becomes eligible for ONE background
 * re-verification per poll cycle: a single transient failure used to
 * quarantine an account until a manual quota refresh cleared it.
 */
export const AUTH_REVERIFY_DELAY_MS = 10 * 60_000

/**
 * First re-verification delay for a fresh flag. The hourly pool poll used to be
 * the ONLY re-check, so a transient mis-classification painted a red 需重新登录
 * badge for up to ~70 minutes on a healthy account (reported 2026-11-23).
 */
export const AUTH_FAST_REVERIFY_MS = 2 * 60_000

/** Upper bound of the re-verification back-off (a dead login is still retried). */
export const AUTH_REVERIFY_MAX_MS = 30 * 60_000

/** Exponential re-verification back-off: 2m, 4m, 8m, 16m, then 30m. */
export function authReverifyDelayMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0
  return Math.min(AUTH_FAST_REVERIFY_MS * 2 ** Math.min(n, 4), AUTH_REVERIFY_MAX_MS)
}

/**
 * A flagged account whose flag is old enough (or whose flag predates the
 * authMarkedAt bookkeeping) may be re-verified in the background. If the
 * stored token still works the flag clears itself; if not, the flag is
 * simply re-stamped.
 */
/** A terminal account ban (Google TOS_VIOLATION) is not a transient auth error. */
export function isTerminalAuthError(message?: string): boolean {
  return typeof message === 'string' && /\bTOS_VIOLATION\b|violation of Terms of Service/i.test(message)
}

export function needsAuthReverify(
  account: ManagedAccount,
  now = Date.now(),
  delayMs = AUTH_REVERIFY_DELAY_MS,
): boolean {
  if (!account.enabled) return false
  if (!account.authRequired) return false
  // A TOS-banned account still has a working refresh token, so the 10-minute
  // "re-verify" would always succeed and clear the ban. Terminal states must
  // wait for an explicit re-login / appeal, not a background poll (issue #114).
  if (isTerminalAuthError(account.authError)) return false
  if (typeof account.authMarkedAt !== 'number') return true
  return now - account.authMarkedAt > delayMs
}

/** Compute real-time health indicator for an account. */
export function getAccountHealth(account: ManagedAccount, family: ModelFamily = 'google'): AccountHealthInfo {
  if (!account.enabled) return { status: 'disabled', message: 'Account disabled' }
  if (account.authRequired) return { status: 'auth_required', message: account.authError || 'Authentication required' }
  const cd = effectiveFamilyCooldown(account, family)
  if (cd && cd.cooldownUntil > Date.now()) {
    return {
      status: 'cooldown',
      message: cd.reason,
      cooldownMs: cd.cooldownUntil - Date.now(),
    }
  }
  return { status: 'healthy' }
}

export interface AccountPoolData {
  version: 1
  mode: 'sequential' | 'round-robin'
  defaultCooldownMs: number
  maxCooldownMs: number
  primaryAccountId?: string
  /** Currently active account id per model family for sticky sequential drain */
  activeAccountIds?: Partial<Record<ModelFamily, string>>
  /**
   * Account of the most recent agy spawn that belonged to the `google` family.
   *
   * NOT the account a session is using: selection is per family, so the
   * console reads `activeAccountIds[family]` (a real per-family pin) and the
   * conversation header reads `/session-view` (family of the selected model).
   * Kept for the `google` readouts that predate family scoping and for
   * last-resort fallbacks.
   */
  lastActiveAccountId?: string
  /** Timestamp of the most recent explicit user account switch/pin (overrides older session stickiness) */
  manualPinAt?: number
  /** Per-family explicit pin timestamps so pinning one family never disrupts other families' session stickiness. */
  manualPinAtByFamily?: Partial<Record<ModelFamily, number>>
  /** Side-effect-free resolved active account ID per family, computed for UI readouts. */
  resolvedActiveAccountIds?: Partial<Record<ModelFamily, string>>
  /** Authoritative currently active account ID computed by the pool scheduler */
  activeAccountId?: string
  /** Detected system-wide or plugin-configured default proxy URL */
  systemProxy?: string
  accounts: ManagedAccount[]
}

export function defaultPoolData(): AccountPoolData {
  return {
    version: 1,
    mode: 'sequential',
    defaultCooldownMs: 15 * 60 * 1000, // 15 minutes (hardened from 10m)
    maxCooldownMs: 60 * 60 * 1000,    // 60 minutes
    accounts: [],
  }
}
