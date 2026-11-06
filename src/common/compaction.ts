// Compaction formatting and metadata utilities for dsh-agy-link.

export interface CompactionNotice {
  beforeTokens: number
  afterTokens: number
  items: number
  summary?: string
}

/** Format a raw token count into human-friendly string like 128.5k, 14.2k, 1.2M, 500. */
export function formatTokenCount(tokens: number): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return '0'
  }
  if (tokens >= 1_000_000) {
    const m = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')
    return `${m}M`
  }
  if (tokens >= 1_000) {
    const k = (tokens / 1_000).toFixed(1).replace(/\.0$/, '')
    return `${k}k`
  }
  return String(Math.round(tokens))
}

/** Calculate percentage reduction, e.g. "-89%". */
export function calcTokenReduction(before: number, after: number): string {
  if (before <= 0 || after >= before) return '-0%'
  const pct = Math.round(((before - after) / before) * 100)
  return `-${pct}%`
}

/** Format the summary string, e.g. "128.5k → 14.2k tokens (-89%)". */
export function formatCompactionSummary(before: number, after: number): string {
  const b = formatTokenCount(before)
  const a = formatTokenCount(after)
  const red = calcTokenReduction(before, after)
  return `${b} → ${a} tokens (${red})`
}

/**
 * Render standard compaction marker for the stream.
 * In raw markdown (and DSH markdown which escapes raw HTML), this surfaces as an elegant blockquote:
 * > [✂️ **上下文已压缩** · 128.5k → 14.2k tokens (-89%)](#agy-compaction?before=128500&after=14200&items=18&summary=...)
 * In browser DSH, the client enhancer transforms it into the interactive native Compaction Card.
 */
export function renderCompactionMarker(notice: CompactionNotice): string {
  const summaryText = formatCompactionSummary(notice.beforeTokens, notice.afterTokens)
  const encodedSummary = notice.summary ? encodeURIComponent(notice.summary) : ''
  return `> [✂️ **上下文已压缩** · ${summaryText}](#agy-compaction?before=${notice.beforeTokens}&after=${notice.afterTokens}&items=${notice.items}&summary=${encodedSummary})\n\n`
}
