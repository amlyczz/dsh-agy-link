import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_IDLE_TTL_MS,
  classifyCacheReason,
  formatCacheTurn,
  summarizeCacheTurn,
} from '../../../src/features/acp/cache-stats.ts'

test('cache stats: prompt-side occupancy is the LAST call, not a session sum', () => {
  // The real profile of session-8bade603's per-call sample.
  const s = summarizeCacheTurn({ input_tokens: 6622, cache_read_tokens: 63960, output_tokens: 1282 })
  assert.equal(s?.contextTokens, 70582)
  assert.ok(s!.hitPercent! > 90 && s!.hitPercent! <= 100)
})

test('cache stats: no counters means no sample (never a fake 0%)', () => {
  assert.equal(summarizeCacheTurn(undefined), null)
  assert.equal(summarizeCacheTurn({}), null)
  assert.equal(summarizeCacheTurn({ input_tokens: 0, output_tokens: 0 }), null)
})

test('cache reason: the biggest destroyer wins', () => {
  assert.equal(classifyCacheReason({ sessionStatus: 'cached', isAux: true }), 'aux')
  assert.equal(classifyCacheReason({ sessionStatus: 'created', accountSwitched: true }), 'account-switch')
  assert.equal(classifyCacheReason({ sessionStatus: 'rebuilt' }), 'rebuild')
  assert.equal(classifyCacheReason({ sessionStatus: 'created' }), 'new-session')
  assert.equal(classifyCacheReason({ sessionStatus: 'resumed' }), 'resume')
  assert.equal(classifyCacheReason({ sessionStatus: 'cached', modelSwitched: true }), 'model-switch')
  assert.equal(classifyCacheReason({ sessionStatus: 'cached', retried: true }), 'retry')
  assert.equal(classifyCacheReason({ sessionStatus: 'cached', idleMs: CACHE_IDLE_TTL_MS + 1 }), 'idle')
  assert.equal(classifyCacheReason({ sessionStatus: 'cached', idleMs: 30_000 }), 'none')
})

test('cache log line is single-line and carries every counter', () => {
  const line = formatCacheTurn(
    summarizeCacheTurn({ input_tokens: 14424, cache_read_tokens: 42217, output_tokens: 7247 }),
    'none',
  )
  assert.match(line, /hit=74\.5%/)
  assert.match(line, /ctx=56641/)
  assert.match(line, /reason=none/)
  assert.equal(line.includes('\n'), false)
})
