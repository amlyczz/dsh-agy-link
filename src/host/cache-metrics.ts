// Process-wide cache/cold-start counters for the ACP transport.
//
// `runAcpAttempt` records one sample per turn; `/agy status`, `/agy cache-stats`
// and the plugin `/status` route read the snapshot. In-memory only: this is an
// operational health read-out, not a persisted billing ledger. The cache-stats
// module stays pure; this one owns the mutable daily buckets and the report
// formatting so both the command and the HTTP route agree.
import type { CacheMissReason, CacheTurnStats } from '../features/acp/cache-stats.ts'

export interface CacheTurnSample {
  at: number
  reason: CacheMissReason
  stats: CacheTurnStats | null
  sessionKey?: string
  model?: string
}

export interface CacheBucket {
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  turns: number
  /** Turns whose reason was anything other than `none`. */
  coldTurns: number
  promptTokens: number
  cacheReadTokens: number
  hitPercent: number | null
  reasons: Partial<Record<CacheMissReason, number>>
}

export interface CacheMetricsSnapshot {
  today: CacheBucket
  /** Newest first, up to KEEP_DAYS. */
  days: CacheBucket[]
  last: CacheTurnSample | null
  lastBySession: Record<string, CacheTurnSample>
}

const KEEP_DAYS = 14
const MAX_SESSIONS = 64

/** Local YYYY-MM-DD (not UTC: "今日" must match the operator's clock). */
export function dayKey(at: number): string {
  const d = new Date(at)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function emptyBucket(date: string): CacheBucket {
  return { date, turns: 0, coldTurns: 0, promptTokens: 0, cacheReadTokens: 0, hitPercent: null, reasons: {} }
}

export class CacheMetrics {
  private readonly buckets = new Map<string, CacheBucket>()
  private last: CacheTurnSample | null = null
  private readonly bySession = new Map<string, CacheTurnSample>()

  record(sample: CacheTurnSample): void {
    this.last = sample
    if (sample.sessionKey !== undefined && sample.sessionKey !== '') {
      this.bySession.set(sample.sessionKey, sample)
      if (this.bySession.size > MAX_SESSIONS) {
        const oldest = this.bySession.keys().next().value
        if (oldest !== undefined) this.bySession.delete(oldest)
      }
    }
    const key = dayKey(sample.at)
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket(key)
      this.buckets.set(key, bucket)
    }
    bucket.turns += 1
    if (sample.reason !== 'none') bucket.coldTurns += 1
    bucket.reasons[sample.reason] = (bucket.reasons[sample.reason] ?? 0) + 1
    if (sample.stats !== null) {
      bucket.promptTokens += sample.stats.contextTokens
      bucket.cacheReadTokens += sample.stats.cacheReadTokens
      bucket.hitPercent = bucket.promptTokens > 0
        ? Math.min(100, (bucket.cacheReadTokens / bucket.promptTokens) * 100)
        : null
    }
    this.prune(sample.at)
  }

  private prune(now: number): void {
    if (this.buckets.size <= KEEP_DAYS) return
    const keepFrom = dayKey(now - (KEEP_DAYS - 1) * 86_400_000)
    for (const key of [...this.buckets.keys()]) if (key < keepFrom) this.buckets.delete(key)
  }

  snapshot(now: number = Date.now()): CacheMetricsSnapshot {
    const todayKey = dayKey(now)
    const days = [...this.buckets.values()]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, KEEP_DAYS)
    const lastBySession: Record<string, CacheTurnSample> = {}
    for (const [k, v] of this.bySession) lastBySession[k] = v
    return {
      today: this.buckets.get(todayKey) ?? emptyBucket(todayKey),
      days,
      last: this.last,
      lastBySession,
    }
  }

  reset(): void {
    this.buckets.clear()
    this.bySession.clear()
    this.last = null
  }
}

export const cacheMetrics = new CacheMetrics()

function pct(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(1) + '%'
}

function reasonText(bucket: CacheBucket): string {
  const entries = Object.entries(bucket.reasons)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
  return entries.length === 0 ? '—' : entries.map(([k, n]) => `${k}×${n}`).join(' ')
}

/** Compact one-day line used by both the slash command and /agy status. */
export function formatCacheBucket(bucket: CacheBucket): string {
  return `${bucket.date}: ${bucket.turns} 轮，冷 ${bucket.coldTurns}，命中 ${pct(bucket.hitPercent)}（cr ${bucket.cacheReadTokens} / prompt ${bucket.promptTokens}）· ${reasonText(bucket)}`
}

/** Full multi-day report for `/agy cache-stats`. */
export function formatCacheReport(snap: CacheMetricsSnapshot): string[] {
  const lines = ['**缓存命中 / 冷启动归因（按本地日）**', '- 今日: ' + formatCacheBucket(snap.today)]
  const prior = snap.days.filter((d) => d.date !== snap.today.date).slice(0, 6)
  if (prior.length > 0) {
    lines.push('- 前几日:')
    for (const b of prior) lines.push('  - ' + formatCacheBucket(b))
  }
  if (snap.last !== null) {
    const s = snap.last.stats
    lines.push('- 最近一轮: ' + (s === null
      ? '无用量样本'
      : `hit ${pct(s.hitPercent)} · ctx ${s.contextTokens} · in ${s.inputTokens} · cr ${s.cacheReadTokens} · out ${s.outputTokens}`) + ' · reason=' + snap.last.reason)
  }
  if (snap.today.turns === 0) lines.push('- 还没有数据：跑一轮 antigravity 会话后再看。')
  return lines
}
