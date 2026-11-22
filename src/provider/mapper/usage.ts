// Raw agy usage counters -> DSH TokenUsage.
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RawUsage } from '../../common/types.ts'

/**
 * Derive the total the host can accept (issue #167).
 *
 * The CLI reports `total_tokens` as input + output only, leaving the cached
 * prompt out; a cached turn therefore arrives with a total smaller than the
 * prompt the host reconstructs from the counters, and DSH's token meter drops
 * the whole turn. The ACP path reports the real total (input + cache read +
 * cache write + output), so we only need to derive when the number cannot be
 * trusted:
 *
 * - keep the reported total when it already covers every counter we know;
 * - when the payload carries both cache counters the host demands
 *   `total - output === input + cacheRead + cacheWrite` exactly, so a
 *   reported total that disagrees is unusable and we derive instead.
 */
export function usageFromRaw(raw: RawUsage): TokenUsage {
  // The DSH session layer rejects chunks carrying undefined-valued fields
  // (lossless-JSON boundary), so optional counters are omitted, not set to
  // undefined.
  const usage: TokenUsage = {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
  }
  if (raw.cache_read_tokens !== undefined) usage.cacheReadTokens = raw.cache_read_tokens
  if (raw.cache_write_tokens !== undefined) usage.cacheWriteTokens = raw.cache_write_tokens
  if (raw.thinking_tokens !== undefined) usage.reasoningTokens = raw.thinking_tokens
  const known =
    usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const bothCacheCounters = usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined
  const reported = raw.total_tokens
  const keepReported = reported !== undefined && reported >= known && (!bothCacheCounters || reported === known)
  usage.totalTokens = keepReported ? reported : known
  return usage
}
