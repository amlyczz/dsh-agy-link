// /agy cache-stats — per-day cache hit rate and cold-start attribution.
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { cacheMetrics, formatCacheReport } from '../cache-metrics.ts'
import { ok } from './shared.ts'

export async function handleCacheStats(): Promise<CommandResult> {
  return ok(formatCacheReport(cacheMetrics.snapshot()).join('\n'))
}
