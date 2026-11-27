// Bounded pool-reset wait (the 2026-11-27 turn-257 failure: a 5h window at 4%
// was benched 665s before its reset, the old 20s cap gave up in 63ms and the
// whole turn ended with AGY_ERROR and no assistant output).
//
// Everything here drives a fake pool and never spawns agy: no Antigravity quota
// is consumed, and the long waits run on a virtual clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectSessionAccount } from '../../src/provider/account-selection.ts'
import { resolveConfig } from '../../src/common/config.ts'
import { defaultConfig, type PluginConfig } from '../../src/common/types.ts'
import type { AccountPoolManager } from '../../src/host/pool.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import { STATUS_NOTICE_BLOCK_INDEX, awaitWithNotices, describePoolResetWait } from '../../src/provider/notices.ts'
import { collect, makeAdapter, msg, opts } from '../helpers/adapter-fixtures.ts'

function account(id: string): ManagedAccount {
  return { id, alias: id, dir: '', enabled: true, createdAt: 0, cooldowns: {}, quotas: {} }
}

const ACC = account('acc_primary')

type PoolOpts = {
  /** Countdown reported while the pool is drained; null = "no finite reset". */
  countdownMs?: number | null
  /** Release the account after this many selectAccount() calls (no waiting). */
  releaseAfterSelects?: number
  /** Release the account once this much wall time has passed. */
  releaseAfterMs?: number
  /** Release the account once the (possibly virtual) clock passes this instant. */
  releaseAtClock?: number
  /** Static countdown clock used by the live-snapshot replay. */
  countdownFrom?: () => number
}

/** Fake one-account pool whose quota/cooldown window resets on demand. */
function fakePool(o: PoolOpts = {}) {
  const started = Date.now()
  const releaseAt = o.releaseAfterMs === undefined ? Infinity : started + o.releaseAfterMs
  let selects = 0
  let released = false
  const isOpen = (): boolean => {
    if (!released && Date.now() >= releaseAt) released = true
    if (!released && o.releaseAtClock !== undefined && Date.now() >= o.releaseAtClock) released = true
    if (!released && o.releaseAfterSelects !== undefined && selects >= o.releaseAfterSelects) released = true
    return released
  }
  const countdown = (): number | null => {
    if (isOpen()) return 0
    if (o.countdownFrom !== undefined) return o.countdownFrom()
    if (o.countdownMs !== undefined) return o.countdownMs
    return Number.isFinite(releaseAt) ? Math.max(0, releaseAt - Date.now()) : null
  }
  const pool = {
    getAccounts: () => [ACC],
    getAccount: (id: string) => (id === ACC.id ? ACC : undefined),
    getPoolData: () => ({ lastActiveAccountId: ACC.id, activeAccountIds: {}, manualPinAt: 0 }),
    isAccountEligible: () => isOpen(),
    isAccountEligibleForModel: () => isOpen(),
    explainIneligibility: () => (isOpen() ? null : 'quota'),
    selectAccount: () => {
      selects += 1
      return isOpen() ? ACC : null
    },
    findAccount: () => undefined,
    markAccountActive: () => {},
    setActiveAccount: () => {},
    getEarliestAvailableCountdown: countdown,
    getEarliestResetCountdown: () => countdown(),
  }
  return { pool: pool as unknown as AccountPoolManager, selects: () => selects }
}

const cfg = (over: Partial<PluginConfig> = {}): PluginConfig => ({
  ...defaultConfig(),
  parallelSameAccount: false,
  autoFallbackModel: false,
  ...over,
})

const store = { all: () => ({}), delete: () => {} } as never

function run(pool: AccountPoolManager, over: Partial<PluginConfig> = {}, extra: Record<string, unknown> = {}) {
  return selectSessionAccount({
    deps: { pool, store },
    cfg: cfg(over),
    model: 'gemini-3.8-flash',
    isAux: false,
    sessionKey: 's1',
    ...extra,
  })
}

test('pool-reset wait: a finite reset inside the cap is waited out, then the account is picked', async () => {
  const { pool, selects } = fakePool({ releaseAfterMs: 120 })
  const started = Date.now()
  const out = await run(pool, { poolResetWaitMs: 5_000 })
  const elapsed = Date.now() - started
  assert.equal(out.account?.id, ACC.id, 'the drained account has to serve the turn after its reset')
  assert.ok(elapsed >= 120, 'must actually wait for the reset, waited ' + elapsed + 'ms')
  assert.ok(selects() >= 2, 'selection is retried after the wait, attempts=' + selects())
})

test('pool-reset wait: a reset beyond the cap fails fast, names the cap and keeps the earliest-reset hint', async () => {
  const { pool } = fakePool({ countdownMs: 60_000 })
  const started = Date.now()
  await assert.rejects(run(pool, { poolResetWaitMs: 5_000 }), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'AGY_ERROR')
    assert.match(error.message, /earliest reset in 60s/)
    assert.match(error.message, /beyond the 5s wait cap \(poolResetWaitMs\); raise the cap to outlast it/)
    assert.match(error.message, /Add an account, wait for the quota reset/)
    return true
  })
  assert.ok(Date.now() - started < 1_000, 'a reset outside the cap must not be slept on')
})

test('pool-reset wait: a blocker the reset cannot repair (model missing from the catalog) fails fast', async () => {
  // acc_cooling holds a finite cooldown, acc_other simply lacks the model. The
  // reset will not make acc_other able to serve it, so a chat turn must not park
  // for 15 minutes on a blocker that outlives the reset.
  const cooling = account('acc_cooling')
  const other = account('acc_other')
  const pool = {
    getAccounts: () => [cooling, other],
    getAccount: () => undefined,
    getPoolData: () => ({ lastActiveAccountId: undefined, activeAccountIds: {}, manualPinAt: 0 }),
    isAccountEligible: () => false,
    isAccountEligibleForModel: () => false,
    explainIneligibility: (a: ManagedAccount) => (a.id === 'acc_cooling' ? 'cooldown' : 'model-unsupported'),
    selectAccount: () => null,
    findAccount: () => undefined,
    markAccountActive: () => {},
    setActiveAccount: () => {},
    getEarliestAvailableCountdown: () => 5_000,
    getEarliestResetCountdown: () => 5_000,
  } as unknown as AccountPoolManager
  const started = Date.now()
  await assert.rejects(run(pool, { poolResetWaitMs: 900_000 }), (error: { code?: string }) => {
    assert.equal(error.code, 'AGY_ERROR')
    return true
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1_000, 'no wait when a non-reset blocker remains, took ' + elapsed + 'ms')
})

test('pool-reset wait: a snapshot that never advances fails after one round instead of parking to the cap', async () => {
  // A stale quota row (or a reset that already landed but was never refreshed)
  // keeps reporting the same countdown. Re-arming it would sleep until the
  // 15-minute cap and park the turn; one round must settle it.
  const { pool, selects } = fakePool({ countdownMs: 120 })
  const started = Date.now()
  await assert.rejects(run(pool, { poolResetWaitMs: 900_000 }), (error: { code?: string }) => {
    assert.equal(error.code, 'AGY_ERROR')
    return true
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3_000, 'one round only, took ' + elapsed + 'ms')
  assert.equal(selects(), 2, 'one pick, one post-wait re-pick')
})

test('pool-reset wait: a healthy account never enters the wait', async () => {
  const { pool, selects } = fakePool({ releaseAfterSelects: 0 })
  const out = await run(pool, { poolResetWaitMs: 900_000 })
  assert.equal(out.account?.id, ACC.id)
  assert.equal(selects(), 1, 'one selection, no re-pick loop')
})

test('pool-reset wait: Stop (abort) cancels the wait with ABORTED instead of spawning later', async () => {
  const { pool } = fakePool({ countdownMs: 5_000 })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(
    run(pool, { poolResetWaitMs: 10_000 }, { signal: controller.signal }),
    (error: { code?: string }) => {
      assert.equal(error.code, 'ABORTED')
      return true
    },
  )
})

test('pool-reset wait: poolResetWaitMs 0 keeps the legacy fail-fast path', async () => {
  const { pool, selects } = fakePool({ countdownMs: 5_000 })
  await assert.rejects(run(pool, { poolResetWaitMs: 0 }), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'AGY_ERROR')
    assert.doesNotMatch(error.message, /wait cap/, 'no cap hint when waiting is disabled')
    return true
  })
  assert.equal(selects(), 1, 'cap 0 must not re-pick')
})

test('pool-reset wait: auxiliary calls never park on the pool reset', async () => {
  const { pool } = fakePool({ countdownMs: 5_000 })
  await assert.rejects(
    run(pool, { poolResetWaitMs: 900_000 }, { isAux: true }),
    (error: { code?: string }) => error.code === 'AGY_ERROR',
  )
})

test('pool-reset wait: the live turn-257 snapshot (665s, 4% left) waits, then selects at the recorded resetTime', async () => {
  // pool.json at 2026-11-27T14:47:31Z: google remainingFraction=0.0400,
  // resetTime=14:58:43Z; turn 257 started 14:47:38Z → 665s countdown.
  const start = 1_795_790_858_074
  const resetAt = 1_795_791_523_000
  const { pool } = fakePool({ countdownFrom: () => Math.max(0, resetAt - Date.now()), releaseAtClock: resetAt })
  const realNow = Date.now
  const realSetTimeout = globalThis.setTimeout
  let clock = start
  Date.now = () => clock
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    clock += ms ?? 0
    queueMicrotask(fn)
    return { unref() {} }
  }) as unknown as typeof setTimeout
  try {
    const out = await run(pool, { poolResetWaitMs: 900_000 })
    assert.equal(out.account?.id, ACC.id)
    assert.ok(clock >= resetAt, 'virtual clock must pass the recorded resetTime')
  } finally {
    Date.now = realNow
    globalThis.setTimeout = realSetTimeout
  }
})

test('pool-reset wait: config wiring — default 15 min, entry/overrides win, 0 stays 0', () => {
  assert.equal(resolveConfig({}, {}, {}).poolResetWaitMs, 900_000)
  assert.equal(resolveConfig({ poolResetWaitMs: 4_200 }, {}, {}).poolResetWaitMs, 4_200)
  assert.equal(resolveConfig({}, {}, { poolResetWaitMs: '120000' }).poolResetWaitMs, 120_000)
  assert.equal(resolveConfig({ poolResetWaitMs: 0 }, {}, {}).poolResetWaitMs, 0, '0 disables the wait instead of falling back')
})

test('pool-reset wait: the notice carries the remaining time, the cap, the elapsed time and Stop', () => {
  const text = describePoolResetWait(12_000, 900_000, 40_000)
  assert.match(text, /^\[agy\] 号池暂时耗尽：正在等待配额\/冷却重置（剩余约 12s，最多等 900s，已等 40s）/)
  assert.match(text, /按 Stop 可取消/)
  assert.match(text, /\[agy\] Antigravity pool is drained: waiting for the next quota\/cooldown reset \(~12s left, cap 900s, waited 40s\)/)
  assert.match(text, /press Stop to cancel/)
})

test('pool-reset wait: awaitWithNotices streams those notice lines on the reserved block index', async () => {
  let release: (v: string) => void = () => {}
  const work = new Promise<string>((resolve) => {
    release = resolve
  })
  const state = { resetAt: Date.now() + 60_000, capMs: 900_000 }
  const gen = awaitWithNotices(work, {
    intervalMs: 10,
    escalate: 2,
    maxIntervalMs: 40,
    notice: (waitedMs) => describePoolResetWait(state.resetAt - Date.now(), state.capMs, waitedMs),
  })
  const texts: string[] = []
  for (;;) {
    const step = await gen.next()
    if (step.done === true) break
    const chunk = step.value as { type: string; index: number; text: string }
    assert.equal(chunk.type, 'reasoning-delta')
    assert.equal(chunk.index, STATUS_NOTICE_BLOCK_INDEX)
    texts.push(chunk.text)
    if (texts.length >= 2) release('served')
  }
  assert.ok(texts.length >= 2, 'expected repeated notices, got ' + texts.length)
  assert.match(texts[0]!, /号池暂时耗尽/)
  assert.match(texts[0]!, /最多等 900s/)
})

test('pool-reset wait: a slow selection with nothing to report streams no empty chunk', async (t) => {
  // Aux calls and slow self-heals (healStaleModelSnapshot's refresh) never hand
  // a pool wait to the wrapper, so the notice renders nothing while the
  // selection still exceeds one cadence. Before the fix that tick wrote a bare
  // '\n' reasoning delta into the transcript.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let calls = 0
    const work = new Promise<string>((resolve) => {
      setTimeout(() => resolve('served'), 30)
    })
    const gen = awaitWithNotices(work, {
      intervalMs: 10,
      notice: () => {
        calls++
        return ''
      },
    })
    const texts: string[] = []
    const pump = (async () => {
      for (;;) {
        const step = await gen.next()
        if (step.done === true) return
        texts.push((step.value as { text: string }).text)
      }
    })()
    // The generator needs a microtask turn between ticks to skip a blank notice
    // and re-arm; the selection's own 30ms timer ends the wait on the third tick.
    for (let tick = 0; tick < 3; tick++) {
      t.mock.timers.tick(10)
      await Promise.resolve()
    }
    await pump
    assert.ok(calls >= 1, 'the cadence still fires while the selection runs, saw ' + calls)
    assert.deepEqual(texts, [], 'a blank notice must not put an empty chunk into the transcript')
  } finally {
    t.mock.timers.reset()
  }
})

test('pool-reset wait: a blank tick is skipped without losing the next real notice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let calls = 0
    const work = new Promise<string>((resolve) => {
      setTimeout(() => resolve('served'), 30)
    })
    const gen = awaitWithNotices(work, {
      intervalMs: 10,
      notice: () => (++calls === 1 ? '' : 'now waiting'),
    })
    const texts: string[] = []
    const pump = (async () => {
      for (;;) {
        const step = await gen.next()
        if (step.done === true) return
        texts.push((step.value as { text: string }).text)
      }
    })()
    for (let tick = 0; tick < 3; tick++) {
      t.mock.timers.tick(10)
      await Promise.resolve()
    }
    await pump
    assert.deepEqual(texts, ['now waiting\n'], 'only the blank tick is dropped')
  } finally {
    t.mock.timers.reset()
  }
})

test('pool-reset wait: the adapter streams the notice into the transcript while the selection is parked', async () => {
  // The pool stays drained until its reset (60ms away), so the parked selection
  // settles on its own instead of leaking a timer.
  const { pool } = fakePool({ releaseAfterMs: 60 })
  const { adapter } = makeAdapter({ poolResetWaitMs: 60_000 }, { pool })
  const realSetTimeout = globalThis.setTimeout
  // Compress the two cadences under test (20s notice interval, 8s reset sleep):
  // the point is that a parked selection yields the notice, not the wall clock.
  globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, Math.min(ms ?? 0, 10))) as typeof setTimeout
  const gen = adapter.stream(opts([msg('user', '还在吗')], { sessionId: 'sess-pool-wait' as never }))[Symbol.asyncIterator]()
  try {
    const first = await gen.next()
    assert.equal(first.done, false, 'a parked turn must not end silently')
    const chunk = first.value as { type: string; index: number; text: string }
    assert.equal(chunk.type, 'reasoning-delta')
    assert.equal(chunk.index, STATUS_NOTICE_BLOCK_INDEX)
    assert.match(chunk.text, /\[agy\] 号池暂时耗尽/)
    assert.match(chunk.text, /最多等 60s/)
    assert.match(chunk.text, /按 Stop 可取消/)
  } finally {
    await gen.return?.(undefined as never)
    globalThis.setTimeout = realSetTimeout
  }
})

test('pool-reset wait: a healthy selection streams no notice at all', async () => {
  const { adapter } = makeAdapter({ poolResetWaitMs: 900_000 }, { pool: fakePool({ releaseAfterSelects: 0 }).pool })
  const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-pool-fast' as never })))
  const notices = chunks.filter((c) => (c as { type: string }).type === 'reasoning-delta' && (c as { index?: number }).index === STATUS_NOTICE_BLOCK_INDEX)
  assert.deepEqual(notices, [], 'a fast selection must not pollute the transcript')
})
