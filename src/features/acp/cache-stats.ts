// Per-turn cache accounting for the ACP transport.
//
// Gemini's implicit prompt cache is prefix based and has a short TTL. The only
// honest way to improve it is to know WHY a turn missed: a brand-new session,
// a rebuild after a lost resume, an account/model switch, an idle gap past the
// TTL, or a self-heal retry. This module is pure so the taxonomy is testable
// without spawning agy.
import type { RawUsage } from '../../common/types.ts'

export type CacheMissReason =
  | 'none'
  | 'new-session'
  | 'resume'
  | 'rebuild'
  | 'account-switch'
  | 'model-switch'
  | 'idle'
  | 'retry'
  | 'aux'
  | 'unknown'

/** Gemini implicit cache is widely reported to expire after a few minutes. */
export const CACHE_IDLE_TTL_MS = 5 * 60_000

export interface CacheTurnStats {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** Prompt-side occupancy of the LAST call: input + cacheRead + cacheWrite. */
  contextTokens: number
  /** cacheRead / prompt-side, 0..100, or null when the turn carried no usage. */
  hitPercent: number | null
}

export function summarizeCacheTurn(raw: RawUsage | null | undefined): CacheTurnStats | null {
  if (raw === null || raw === undefined) return null
  const inputTokens = raw.input_tokens ?? 0
  const cacheReadTokens = raw.cache_read_tokens ?? 0
  const cacheWriteTokens = raw.cache_write_tokens ?? 0
  const outputTokens = raw.output_tokens ?? 0
  const contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  if (contextTokens === 0 && outputTokens === 0) return null
  const hitPercent = contextTokens > 0 ? Math.min(100, (cacheReadTokens / contextTokens) * 100) : null
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, contextTokens, hitPercent }
}

export interface CacheReasonInput {
  /** How the ACP session was resolved this turn. */
  sessionStatus: 'created' | 'resumed' | 'loaded' | 'cached' | 'rebuilt'
  isAux?: boolean
  accountSwitched?: boolean
  modelSwitched?: boolean
  retried?: boolean
  /** Milliseconds since the previous turn on this session, when known. */
  idleMs?: number
  idleTtlMs?: number
}

/**
 * Pick the dominant reason a turn could not hit the cache. Ordered by how much
 * it destroys: a new/other account or session loses everything, a model switch
 * or TTL expiry loses everything too, a resume may keep the server-side prefix.
 */
export function classifyCacheReason(input: CacheReasonInput): CacheMissReason {
  if (input.isAux) return 'aux'
  if (input.accountSwitched) return 'account-switch'
  if (input.sessionStatus === 'rebuilt') return 'rebuild'
  if (input.sessionStatus === 'created') return 'new-session'
  if (input.sessionStatus === 'resumed' || input.sessionStatus === 'loaded') return 'resume'
  if (input.modelSwitched) return 'model-switch'
  if (input.retried) return 'retry'
  const ttl = input.idleTtlMs ?? CACHE_IDLE_TTL_MS
  if (input.idleMs !== undefined && input.idleMs > ttl) return 'idle'
  return 'none'
}

export function formatCacheTurn(stats: CacheTurnStats | null, reason: CacheMissReason): string {
  if (stats === null) return `cache: no-usage reason=${reason}`
  const hit = stats.hitPercent === null ? 'n/a' : stats.hitPercent.toFixed(1) + '%'
  return `cache: hit=${hit} ctx=${stats.contextTokens} in=${stats.inputTokens} cr=${stats.cacheReadTokens} cw=${stats.cacheWriteTokens} out=${stats.outputTokens} reason=${reason}`
}
