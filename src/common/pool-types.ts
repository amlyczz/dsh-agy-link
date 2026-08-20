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

export interface FamilyQuotaInfo {
  /** Remaining quota fraction: 0.0 (exhausted) to 1.0 (full). */
  remainingFraction?: number
  /** ISO-8601 timestamp for when the quota window resets (e.g. "2026-08-20T16:00:00Z"). */
  resetTime?: string
  /** Timestamp when this quota was last updated locally. */
  updatedAt?: number
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
  email?: string
  /** Absolute path to the isolated account home directory. */
  dir: string
  /** Optional custom proxy URL override (e.g. "socks5://127.0.0.1:7890"). */
  proxyUrl?: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  /** Cooldown state tracked per model family. */
  cooldowns: Partial<Record<ModelFamily, FamilyCooldownState>>
  /** Cached real-time quota statistics per model family. */
  quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
}

export interface AccountPoolData {
  version: 1
  mode: 'sequential' | 'round-robin'
  defaultCooldownMs: number
  maxCooldownMs: number
  primaryAccountId?: string
  accounts: ManagedAccount[]
}

export function defaultPoolData(): AccountPoolData {
  return {
    version: 1,
    mode: 'sequential',
    defaultCooldownMs: 10 * 60 * 1000, // 10 minutes
    maxCooldownMs: 60 * 60 * 1000,    // 60 minutes
    accounts: [],
  }
}
