import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CacheMetrics, dayKey, formatCacheBucket, formatCacheReport } from '../../src/host/cache-metrics.ts'
import { summarizeCacheTurn } from '../../src/features/acp/cache-stats.ts'

function at(day: number, hour = 12): number {
  return new Date(2026, 10, day, hour, 0, 0).getTime()
}

test('cache metrics: daily buckets order newest-first and keep raw counts', () => {
  const m = new CacheMetrics()
  m.record({ at: at(23), reason: 'none', stats: summarizeCacheTurn({ input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 100 }) })
  m.record({ at: at(23), reason: 'idle', stats: summarizeCacheTurn({ input_tokens: 5000, cache_read_tokens: 0, output_tokens: 100 }) })
  m.record({ at: at(23), reason: 'new-session', stats: summarizeCacheTurn({ input_tokens: 2000, cache_read_tokens: 3000, output_tokens: 100 }) })
  m.record({ at: at(24), reason: 'none', stats: summarizeCacheTurn({ input_tokens: 100, cache_read_tokens: 900, output_tokens: 10 }) })

  const snap = m.snapshot(at(24))
  assert.equal(snap.today.date, '2026-11-24')
  assert.equal(snap.today.turns, 1)
  assert.equal(snap.today.coldTurns, 0)
  assert.equal(snap.days.length, 2)
  assert.equal(snap.days[0]!.date, '2026-11-24')
  assert.equal(snap.days[1]!.date, '2026-11-23')
  const d23 = snap.days[1]!
  assert.equal(d23.turns, 3)
  assert.equal(d23.coldTurns, 2)
  assert.deepEqual(d23.reasons, { none: 1, idle: 1, 'new-session': 1 })
  // weighted: (9000 + 0 + 3000) / (10000 + 5000 + 5000)
  assert.equal(d23.hitPercent, 60)
  assert.equal(d23.promptTokens, 20000)
  assert.equal(snap.last?.reason, 'none')
})

test('cache metrics: buckets older than the retention window are pruned', () => {
  const m = new CacheMetrics()
  for (let day = 1; day <= 20; day++) {
    m.record({ at: new Date(2026, 9, day, 12).getTime(), reason: 'none', stats: null })
  }
  const snap = m.snapshot(new Date(2026, 9, 20, 18).getTime())
  assert.equal(snap.days.length, 14)
  assert.equal(snap.days[0]!.date, '2026-10-20')
  assert.equal(snap.days[13]!.date, '2026-10-07')
})

test('cache metrics: report names today, recent days and the last turn', () => {
  const m = new CacheMetrics()
  m.record({ at: at(23), reason: 'idle', stats: summarizeCacheTurn({ input_tokens: 3000, cache_read_tokens: 5000, output_tokens: 200 }) })
  const lines = formatCacheReport(m.snapshot(at(23)))
  assert.match(lines[0]!, /缓存命中/)
  assert.match(lines[1]!, /今日/)
  assert.ok(lines.some((l) => /reason=idle/.test(l)))
  assert.equal(lines.some((l) => /还没有数据/.test(l)), false)
})

test('cache metrics: an empty day reports zero and a hint', () => {
  const lines = formatCacheReport(new CacheMetrics().snapshot(at(25)))
  assert.match(lines[1]!, /0 轮/)
  assert.ok(lines.some((l) => /还没有数据/.test(l)))
})

test('dayKey is the local calendar day, not UTC', () => {
  // 00:30 local on the 23rd must stay the 23rd.
  assert.equal(dayKey(new Date(2026, 10, 23, 0, 30).getTime()), '2026-11-23')
  assert.match(formatCacheBucket({ date: '2026-11-23', turns: 0, coldTurns: 0, promptTokens: 0, cacheReadTokens: 0, hitPercent: null, reasons: {} }), /n\/a/)
})
