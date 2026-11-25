import test from 'node:test'
import assert from 'node:assert/strict'

import { AccountQuotaRefresher, QUOTA_ACCOUNT_REFRESH_MIN_GAP_MS } from '../../../src/features/quota/freshness.ts'

test('AccountQuotaRefresher throttles a burst of triggers to one refresh per gap', () => {
  let now = 1_000_000
  const calls: string[] = []
  const r = new AccountQuotaRefresher(async (id) => { calls.push(id) }, () => now, 60_000)

  assert.equal(r.trigger('a'), true, 'first trigger fires')
  assert.equal(r.trigger('a'), false, 'second within the gap is throttled')
  assert.equal(r.trigger('b'), true, 'a different account is independent')
  now += 59_999
  assert.equal(r.trigger('a'), false, 'still inside the gap')
  now += 1
  assert.equal(r.trigger('a'), true, 'gap elapsed -> fires again')
  assert.deepEqual(calls, ['a', 'b', 'a'])
})

test('a throwing refresh is swallowed (quota is advisory, never breaks a turn)', async () => {
  const r = new AccountQuotaRefresher(async () => { throw new Error('boom') }, () => 0, 0)
  assert.equal(r.trigger('x'), true)
  await new Promise((res) => setImmediate(res))
  // reaching here without an unhandled rejection is the assertion
})

test('refreshIfStale only refreshes when the row is older than maxAge', async () => {
  let now = 10_000_000
  const seen: string[] = []
  const r = new AccountQuotaRefresher(async (id) => { seen.push(id) }, () => now, 60_000)

  assert.equal(await r.refreshIfStale('a', now - 1_000, 5 * 60_000), false, 'fresh row skips')
  assert.equal(await r.refreshIfStale('a', now - 10 * 60_000, 5 * 60_000), true, 'stale row refreshes')
  assert.equal(await r.refreshIfStale('a', now - 10 * 60_000, 5 * 60_000), false, 'throttled right after')
  now += 60_000
  assert.equal(await r.refreshIfStale('a', undefined, 5 * 60_000), true, 'unknown updatedAt counts as stale')
  assert.deepEqual(seen, ['a', 'a'])
})

test('the default gap is five minutes', () => {
  assert.equal(QUOTA_ACCOUNT_REFRESH_MIN_GAP_MS, 5 * 60_000)
})

test('trigger defers refresh while busy and runs once idle', async () => {
  let busy = true
  const calls: string[] = []
  const r = new AccountQuotaRefresher(
    async (id) => { calls.push(id) },
    () => 1_000_000,
    60_000,
    { isBusy: () => busy, deferMs: 25, maxDefers: 10 },
  )
  try {
    assert.equal(r.trigger('a'), true, 'busy trigger schedules deferred refresh')
    assert.equal(r.trigger('a'), false, 'duplicate trigger while deferred is coalesced')
    assert.deepEqual(calls, [], 'must not fire synchronously while busy')
    await new Promise((res) => setTimeout(res, 40))
    assert.deepEqual(calls, [], 'stays deferred while still busy')
    busy = false
    await new Promise((res) => setTimeout(res, 50))
    assert.deepEqual(calls, ['a'], 'fires once idle')
  } finally {
    r.dispose()
  }
})
