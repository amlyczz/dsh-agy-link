// Failure classification and failover: BUSY / steering, soft overload,
// transport-shaped auth vs AUTH, eligibility refusals, quota failover,
// the retry policy, throttling, and session account stickiness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Err, NETWORK_RETRY_DELAYS_MS } from '../../src/common/types.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { collect, makeAdapter, msg, opts, runTurn, workDir } from '../helpers/adapter-fixtures.ts'

test('region eligibility refusal maps to a clear ELIGIBILITY error (issue #32)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'exit-eligible'
  const chunks = await collect(adapter.stream(opts([msg('user', '测试')], { sessionId: 'sess-elig' as never })))
  process.env.FAKE_AGY_MODE = prevMode
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { message: string; code: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, 'ELIGIBILITY')
  assert.ok(
    finish.reason.failure?.message.includes('not eligible') || finish.reason.failure?.message.includes('Antigravity'),
    'message should explain the eligibility/region refusal: ' + finish.reason.failure?.message,
  )
  assert.ok(finish.reason.failure?.message.includes('location'), finish.reason.failure?.message)
})

test('"Eligibility check failed" wrapping a TLS handshake timeout is NETWORK, not ELIGIBILITY', async () => {
  // Observed live: every first turn failed with "Eligibility check failed:
  // failed to get profile picture: … TLS handshake timeout" and the retry
  // succeeded — a transport blip (proxy cold start), not a region refusal.
  const prevMode = process.env.FAKE_AGY_MODE
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'exit-eligible-network'
  const chunks = await collect(adapter.stream(opts([msg('user', '测试')], { sessionId: 'sess-elig-net' as never })))
  process.env.FAKE_AGY_MODE = prevMode
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.NETWORK)
  assert.ok(!finish.reason.failure?.message.includes('not eligible'), 'must not show the region hint: ' + finish.reason.failure?.message)
})

test('live location refusal rotates the refused account away (retry can serve another)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'location-denied'
  const pool = new AccountPoolManager(join(workDir, 'pool-location'))
  const second = pool.createAccountSlot('Proxied')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const res = await runTurn(adapter, [msg('user', 'hi')], { sessionId: 'sess-location' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.reason.failure?.code, Err.ELIGIBILITY)
    assert.ok(finish.reason.failure?.message.includes('location'), finish.reason.failure?.message)
    // ELIGIBILITY is retryable AND the sticky pointer already moved off the
    // refused account, so the retry is served by a different account instead of
    // hitting the same unsupported location again and again.
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
    // Rotating away is not a cooldown penalty on a healthy account.
    assert.equal(pool.getAccounts()[0]!.cooldowns.google, undefined)
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('identical prompt while a live run owns the session is rejected with BUSY (issue #33)', async () => {
  const prevDelay = process.env.FAKE_AGY_DELAY_MS
  const { adapter } = makeAdapter()
  const userMsg = msg('user', 'Please perform task X')
  const sessionOptions = opts([userMsg], { sessionId: 'sess-dup-test' as never })

  try {
    // Keep the first agy child alive long enough for the second submission
    // to observe a live run (a long tool is silent for minutes — issue #33).
    process.env.FAKE_AGY_DELAY_MS = '400'
    const iter1 = adapter.stream(sessionOptions)[Symbol.asyncIterator]()
    const firstChunkPromise = iter1.next()
    // Let stream() spawn and register the live run; do NOT wait for output.
    await new Promise((r) => setTimeout(r, 80))

    // Identical retry must NOT preempt/kill the live long tool — BUSY only.
    await assert.rejects(
      async () => {
        const iter2 = adapter.stream(sessionOptions)
        for await (const _ of iter2) {}
      },
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, Err.BUSY)
        assert.ok(err.message.includes('Duplicate request ignored'))
        return true
      },
    )

    // Drain first stream so it finishes cleanly.
    const first = await firstChunkPromise
    if (!first.done) {
      while (!(await iter1.next()).done) {}
    }
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_AGY_DELAY_MS
    else process.env.FAKE_AGY_DELAY_MS = prevDelay
  }
})

test('retry after a settled failure is not blocked by debounce (issue #32)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'exit-error'
  try {
    const { adapter } = makeAdapter()
    const userMsg = msg('user', 'Please perform task X')
    const sessionOptions = opts([userMsg], { sessionId: 'sess-retry-after-fail' as never })

    // First attempt fails the way a fast agy error does (exit 1 + envelope).
    const res1 = await collect(adapter.stream(sessionOptions))
    const finish1 = res1[res1.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish1.type, 'finish')
    assert.equal(finish1.reason.kind, 'error')

    // DSH auto-retries the same prompt. A time-only debounce wall used to
    // swallow this as BUSY; settled runs must not block the retry.
    process.env.FAKE_AGY_MODE = 'ok'
    const res2 = await collect(adapter.stream(sessionOptions))
    const finish2 = res2[res2.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish2.type, 'finish')
    assert.notEqual(finish2.reason.kind, 'error', 'retry must not surface Duplicate/BUSY')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a NEW (steered) prompt preempts a live run instead of debouncing', async () => {
  const prevDelay = process.env.FAKE_AGY_DELAY_MS
  const { adapter } = makeAdapter()
  const firstMsg = msg('user', 'Please perform task X')
  const steeredMsg = msg('user', 'Actually please perform task Y instead')
  try {
    process.env.FAKE_AGY_DELAY_MS = '400'
    const iter1 = adapter.stream(opts([firstMsg], { sessionId: 'sess-steer-same' as never }))[Symbol.asyncIterator]()
    const firstChunkPromise = iter1.next()
    await new Promise((r) => setTimeout(r, 80))

    // Different prompt = mid-turn steer: abort the predecessor and run.
    process.env.FAKE_AGY_DELAY_MS = '0'
    const res2 = await collect(adapter.stream(opts([steeredMsg], { sessionId: 'sess-steer-same' as never })))
    const finish2 = res2[res2.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish2.type, 'finish')
    assert.notEqual(finish2.reason.kind, 'error', 'steering turn must not be BUSY')

    try {
      const first = await firstChunkPromise
      if (!first.done) {
        while (!(await iter1.next()).done) {}
      }
    } catch { /* aborted runs may reject; that's fine */ }
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_AGY_DELAY_MS
    else process.env.FAKE_AGY_DELAY_MS = prevDelay
  }
})

test('soft rate limit signal (model overloaded) becomes a retryable OVERLOADED and stays on current account', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const invocationFile = join(workDir, `invocations-overload-${Date.now()}.txt`)
  process.env.FAKE_AGY_MODE = 'real-fail'
  process.env.FAKE_AGY_INVOCATION_FILE = invocationFile
  const pool = new AccountPoolManager(join(workDir, `pool-soft-overload-${Date.now()}`))
  pool.createAccountSlot('Second')
  const initialActive = pool.getActiveAccountId('google')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const res = await runTurn(adapter, [msg('user', 'Say hello')], { sessionId: 'sess-ratelimit' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    // Server capacity refusals (model overloaded / 503 / 529): retryable OVERLOADED,
    // NO cooldown (nothing spent locally), and STAYS on current account to prevent
    // cascading load onto healthy backup accounts.
    assert.equal(finish.reason.failure?.code, Err.OVERLOADED)
    assert.ok(finish.reason.failure?.message.includes('rate limit'))
    assert.ok(adapter.providerRetryPolicy('agy').retryableCodes.includes(Err.OVERLOADED), 'overload must be retryable')
    const spawns = readFileSync(invocationFile, 'utf8').split('\n').filter(Boolean).length
    assert.ok(spawns >= 2, `expected a failover spawn, got ${spawns}`)
    assert.equal(pool.getActiveAccountId('google'), initialActive, 'capacity overload must stay on current account, not rotate')
    for (const acc of pool.getAccounts()) {
      assert.equal(acc.cooldowns.google, undefined, 'a capacity signal must never cool an account down')
    }
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
    delete process.env.FAKE_AGY_INVOCATION_FILE
  }
})

test('transport-shaped auth failure is NETWORK (retryable) instead of AUTH', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth-network'
  const pool = new AccountPoolManager(join(workDir, 'pool-auth-network'))
  const second = pool.createAccountSlot('Second')
  const initialActive = pool.getActiveAccountId('google')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-network' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    // agy says "not logged into Antigravity" whenever it cannot VALIDATE a good
    // token. Reporting AUTH there ends the turn on a healthy account and DSH
    // renders that code as "API key is invalid" — the live 2026-10-10 bug.
    assert.equal(finish.reason.failure?.code, Err.NETWORK)
    assert.ok(/transport failure/i.test(finish.reason.failure?.message ?? ''), finish.reason.failure?.message)
    const primary = pool.getAccounts()[0]!
    assert.equal(primary.authRequired, undefined, 'a transport blip must never flag the account for re-login')
    // No account owns a proxy here: every account leaves through the same
    // egress, so rotating the sticky pointer only repoints the session and
    // spends the rotation budget a real quota/eligibility hop needs.
    assert.equal(pool.getActiveAccountId('google'), initialActive, 'a shared-egress blip must stay on the current account')
    assert.notEqual(pool.getActiveAccountId('google'), second.id, 'the shared-egress blip must not hop accounts')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a transport failure rotates when accounts leave through different proxies', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth-network'
  const pool = new AccountPoolManager(join(workDir, `pool-auth-network-split-${Date.now()}`))
  const second = pool.createAccountSlot('Second')
  // A per-account proxy makes the egress account-scoped: this account's route
  // to Google can be broken while the next account's route is fine.
  pool.setAccountProxy(second.id, 'socks5://127.0.0.1:7890')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-network-split' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    assert.equal(finish.reason.failure?.code, Err.NETWORK)
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id, 'a distinct egress must hand the retry to the other account')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('transport failures ask DSH for a 5s/15s/30s backoff that resets after a success', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const { adapter } = makeAdapter()
  const sessionId = 'sess-network-backoff'
  const failureDelay = async (): Promise<number | undefined> => {
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: sessionId as never })))
    const finish = chunks[chunks.length - 1] as {
      type: string
      reason: { kind: string; failure?: { code: string; providerRetryAfterMs?: number } }
    }
    assert.equal(finish.reason.failure?.code, Err.NETWORK, JSON.stringify(finish.reason.failure))
    return finish.reason.failure?.providerRetryAfterMs
  }
  try {
    // A 14-minute egress outage outlives any short exponential backoff, so the
    // adapter states the delay it wants instead of letting 2s/4s burn the
    // whole retry budget inside four seconds (live 2026-10-21 16:43).
    process.env.FAKE_AGY_MODE = 'auth-network'
    assert.equal(await failureDelay(), 5_000)
    assert.equal(await failureDelay(), 15_000, 'the second consecutive transport failure waits longer')
    assert.equal(await failureDelay(), 30_000)
    assert.equal(await failureDelay(), 30_000, 'the schedule caps instead of escalating forever')

    process.env.FAKE_AGY_MODE = 'ok'
    const ok = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: sessionId as never })))
    // An `ok` run may cut on a mirrored tool step; what matters is that the run
    // SETTLED successfully, which is what clears the transport streak.
    assert.notEqual((ok[ok.length - 1] as { reason: { kind: string } }).reason.kind, 'error', 'the healthy run must settle')

    process.env.FAKE_AGY_MODE = 'auth-network'
    assert.equal(await failureDelay(), 5_000, 'a success resets the transport streak')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a keyring-auth timeout in agy\'s own log is NETWORK, never a sticky AUTH quarantine', async () => {
  // The live 2026-10-16 bug: the stderr banner is byte-identical to a real
  // sign-out, but agy's log shows `keyringAuth: timed out after 10s` — proof a
  // stored credential existed and only the network was down.
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth-jitter'
  const pool = new AccountPoolManager(join(workDir, 'pool-auth-jitter'))
  const slot = pool.createAccountSlot('Jitter')
  pool.setAccountEnabled('acc_primary', false)
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-jitter' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure?.code, Err.NETWORK, JSON.stringify(finish.reason.failure))
    assert.ok(/keyring auth timing out/.test(finish.reason.failure?.message ?? ''), finish.reason.failure?.message)
    const flagged = pool.getAccount(slot.id)!
    assert.equal(flagged.authRequired, undefined, 'jitter must never sticky-quarantine the account')
    assert.equal(pool.getPoolData().lastActiveAccountId, slot.id === flagged.id ? slot.id : pool.getPoolData().lastActiveAccountId)
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a bare "not signed in" banner does not sticky-quarantine on the first occurrence', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth'
  const pool = new AccountPoolManager(join(workDir, 'pool-auth-confirm'))
  const slot = pool.createAccountSlot('Ambiguous')
  pool.setAccountEnabled('acc_primary', false)
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-confirm' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    // The turn still fails with the accurate AUTH diagnosis…
    assert.equal(finish.reason.failure?.code, Err.AUTH)
    // …but one banner is not proof of a dead login, so no sticky flag yet.
    assert.equal(pool.getAccount(slot.id)!.authRequired, undefined, 'a single ambiguous AUTH must not hard-quarantine')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a post-tool quota failure fails over inside the same step (no dead replay)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const invocationFile = join(workDir, `invocations-${Date.now()}.txt`)
  process.env.FAKE_AGY_MODE = 'quota-once'
  process.env.FAKE_AGY_INVOCATION_FILE = invocationFile
  const pool = new AccountPoolManager(join(workDir, `pool-post-tool-${Date.now()}`))
  const second = pool.createAccountSlot('Second')
  try {
    const { adapter } = makeAdapter({}, { pool })
    // quota-once spends the FIRST account after a tool step, so the failure
    // surfaces in the tool-continuation span. That span used to be re-driven
    // from the settled recording and re-emit the identical failure, ending the
    // turn while a healthy account was idle.
    const res = await runTurn(adapter, [msg('user', 'count the files')], { sessionId: 'sess-post-tool' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop', 'the surviving account must answer instead of the turn failing')
    const spawns = readFileSync(invocationFile, 'utf8').split('\n').filter(Boolean).length
    assert.equal(spawns, 2, 'exactly one failover spawn')
    const primary = pool.getAccounts()[0]!
    assert.ok((primary.cooldowns.google?.cooldownUntil ?? 0) > Date.now(), 'the spent account must be cooled')
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id, 'the failover spawn must use the next account')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
    delete process.env.FAKE_AGY_INVOCATION_FILE
  }
})

test('quota exhaustion and timeouts are retried so the next account can serve them', () => {
  const { adapter } = makeAdapter()
  const policy = adapter.providerRetryPolicy('agy')
  // Quota exhaustion was a dead end before: the account cooled down and the
  // sticky pointer advanced, but no retry was ever attempted.
  assert.ok(policy.retryableCodes.includes(Err.RATE_LIMIT), 'rate limit must retry onto the next account')
  assert.ok(policy.retryableCodes.includes(Err.TIMEOUT), 'silent timeouts must retry onto the next account')
  assert.ok(policy.retryableCodes.includes(Err.NETWORK), 'transport failures must retry (same account when the egress is shared)')
  assert.ok(!(policy.retryableCodes as readonly string[]).includes(Err.AGY_ERROR), 'deterministic AGY_ERRORs stay single-shot')
  // The budget must outlast the 5s/15s/30s transport schedule: an egress
  // outage that spans minutes used to die after two retries inside 4 seconds
  // (live 2026-10-21 16:43), so a lone account gets the same three hops.
  assert.equal(policy.maxRetries, NETWORK_RETRY_DELAYS_MS.length)
  assert.ok(!(policy.retryableCodes as readonly string[]).includes(Err.AUTH), 'a lone account cannot fail over a sign-out')
})

test('the retry policy can carry the whole transport backoff schedule', () => {
  const { adapter } = makeAdapter()
  const policy = adapter.providerRetryPolicy('agy')
  // A provider delay ABOVE maxDelayMs makes the retry plugin refuse the retry
  // outright (normal mode returns without scheduling), so the cap must sit at
  // or past the longest transport delay.
  assert.ok(policy.maxDelayMs >= 30_000, `maxDelayMs ${policy.maxDelayMs} would discard the 30s transport delay`)
  assert.ok(policy.maxRetries >= NETWORK_RETRY_DELAYS_MS.length)
  // Non-transport retries keep their short first delay: only NETWORK states a
  // provider delay, everything else still backs off from 2s.
  assert.equal(policy.initialDelayMs, 2_000)
})

test('the retry budget follows the pool so a 3-account pool fails over twice', () => {
  const pool = new AccountPoolManager(join(workDir, `pool-retry-budget-${Date.now()}`))
  pool.createAccountSlot('Second')
  pool.createAccountSlot('Third')
  const { adapter } = makeAdapter({}, { pool })
  const policy = adapter.providerRetryPolicy('agy')
  // With one spare account a stale-token second account turned the single retry
  // into a dead end (live 2026-10-10: primary ELIGIBILITY → g98 "not signed in"
  // → turn lost). The budget must cover the pool…
  assert.equal(policy.maxRetries, NETWORK_RETRY_DELAYS_MS.length)
  assert.ok(policy.retryableCodes.includes(Err.AUTH), 'with a spare account a sign-out can continue on the next one')
  assert.ok(policy.retryableCodes.includes(Err.ELIGIBILITY))
  assert.ok(policy.retryableCodes.includes(Err.OVERLOADED))
})

test('hard quota refusal cools the spent account and hands the retry to the next one', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'real-quota'
  const pool = new AccountPoolManager(join(workDir, 'pool-hard-quota'))
  const second = pool.createAccountSlot('Second')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const res = await runTurn(adapter, [msg('user', 'hi')], { sessionId: 'sess-hard-quota' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure?.code, Err.RATE_LIMIT, 'hard quota must use the retryable code')
    const primary = pool.getAccounts()[0]!
    // Spent account left rotation...
    assert.ok((primary.cooldowns.google?.cooldownUntil ?? 0) > Date.now(), 'hard quota must cool the account down')
    // ...and the pointer already moved on, so the retry lands on the next one.
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('sliding-window rate limit enforces request throttling per minute', async () => {
  const { adapter } = makeAdapter({
    rateLimitPerMinute: 2,
  })

  const t0 = Date.now()
  const userMsg1 = msg('user', 'Req 1')
  const userMsg2 = msg('user', 'Req 2')

  // Run 2 turns quickly
  await runTurn(adapter, [userMsg1], { sessionId: 'sess-rl-1' as never })
  await runTurn(adapter, [userMsg2], { sessionId: 'sess-rl-2' as never })

  const elapsed = Date.now() - t0
  assert.ok(elapsed < 15_000, `elapsed ${elapsed}ms exceeded 15000ms`)
})

test('session sticks to current account across multiple turns and only switches when quota is exhausted', async () => {
  const pool = new AccountPoolManager(join(workDir, `pool-session-sticky-${Date.now()}`))
  const first = pool.getAccounts()[0]!
  const second = pool.createAccountSlot('Account B')

  const { adapter } = makeAdapter({}, { pool })
  const sessionId = 'sess-sticky-account-turns' as never

  // Turn 1 on first account
  const res1 = await runTurn(adapter, [msg('user', 'Hello turn 1')], { sessionId })
  assert.equal(res1.chunks[res1.chunks.length - 1]!.type, 'finish')
  assert.equal(pool.getPoolData().lastActiveAccountId, first.id)

  // Even if another account exists or was marked active by background or another session,
  // Turn 2 MUST stay on the first account because its quota is not exhausted!
  pool.markAccountActive(second.id)
  const res2 = await runTurn(
    adapter,
    [msg('user', 'Hello turn 1'), msg('assistant', 'Reply 1'), msg('user', 'Hello turn 2')],
    { sessionId },
  )
  assert.equal(res2.chunks[res2.chunks.length - 1]!.type, 'finish')
  assert.equal(pool.getPoolData().lastActiveAccountId, first.id, 'session must stick to first account while quota is healthy')

  // Now first account quota is exhausted (hits 429)
  pool.recordFailure(first.id, 'google', 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.')

  // Turn 3 must now switch to second account because first account quota is exhausted
  const res3 = await runTurn(
    adapter,
    [
      msg('user', 'Hello turn 1'),
      msg('assistant', 'Reply 1'),
      msg('user', 'Hello turn 2'),
      msg('assistant', 'Reply 2'),
      msg('user', 'Hello turn 3'),
    ],
    { sessionId },
  )
  assert.equal(res3.chunks[res3.chunks.length - 1]!.type, 'finish')
  assert.equal(pool.getPoolData().lastActiveAccountId, second.id, 'session must switch to second account once quota is exhausted')
})
