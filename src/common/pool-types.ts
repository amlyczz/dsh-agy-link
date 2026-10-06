// Domain types and models for the Antigravity Multi-Account Pool & Sequential Drain.

export type ModelFamily = 'google' | 'anthropic' | 'openai' | 'unknown'

/** Map a model slug to its backend quota counter family. */
export function modelFamilyOf(modelId?: string): ModelFamily {
  if (!modelId) return 'unknown'
  const id = modelId.toLowerCase()
  if (id.startsWith('claude-') || id.includes('claude')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-') || id.includes('gemini')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/') || id.includes('gpt-oss')) return 'openai'
  return 'unknown'
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
  /** Cooldown state tracked per model family. */
  cooldowns: Partial<Record<ModelFamily, FamilyCooldownState>>
  /** Cached real-time quota statistics per model family. */
  quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
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
  for (const cd of Object.values(account.cooldowns)) {
    if (cd && cd.cooldownUntil > now) return false
  }
  return true
}

/**
 * After this long, an authRequired flag becomes eligible for ONE background
 * re-verification per poll cycle: a single transient failure used to
 * quarantine an account until a manual quota refresh cleared it.
 */
export const AUTH_REVERIFY_DELAY_MS = 10 * 60_000

/**
 * A flagged account whose flag is old enough (or whose flag predates the
 * authMarkedAt bookkeeping) may be re-verified in the background. If the
 * stored token still works the flag clears itself; if not, the flag is
 * simply re-stamped.
 */
export function needsAuthReverify(account: ManagedAccount, now = Date.now()): boolean {
  if (!account.authRequired) return false
  if (typeof account.authMarkedAt !== 'number') return true
  return now - account.authMarkedAt > AUTH_REVERIFY_DELAY_MS
}

/** Compute real-time health indicator for an account. */
export function getAccountHealth(account: ManagedAccount, family: ModelFamily = 'google'): AccountHealthInfo {
  if (!account.enabled) return { status: 'disabled', message: 'Account disabled' }
  if (account.authRequired) return { status: 'auth_required', message: account.authError || 'Authentication required' }
  const cd = account.cooldowns[family]
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
   * Account of the most recent agy spawn — the single source of truth for the
   * console's "in use" badge. Per-family pointers above are an internal
   * scheduling detail: families can legitimately sit stale on accounts that
   * are not running anything (that badge showed two accounts at once).
   */
  lastActiveAccountId?: string
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
