// Raw agy usage counters -> DSH TokenUsage.
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RawUsage } from '../../common/types.ts'

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
  if (raw.total_tokens !== undefined) usage.totalTokens = raw.total_tokens
  return usage
}
