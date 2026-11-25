// /pool/refresh-quota and /pool/warmup contract: background job semantics.
//
// Pins the non-blocking pending answer, in-flight dedupe keys and their windows,
// strict-JSON rejection, and the TOS quarantine that must survive a refresh.
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUOTA_REFRESH_DEDUP_MS } from '../../src/common/timeouts.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { POOL_DATA, fakeReq, rawReq, oversizedReq, invoke, poolDouble, setup } from './http-contract-helpers.ts'

test('/pool/refresh-quota refreshes one known account and tolerates unknown ids', async () => {
  const acc = { id: 'known' }
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'known' ? acc : undefined) })
  const quotaRefreshes: unknown[][] = []
  const catalogCalls: unknown[][] = []
  const s = setup({
    pool: pool.pool,
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => {
        quotaRefreshes.push(args)
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async (...args: unknown[]) => {
        catalogCalls.push(args)
      },
    },
  })

  const known = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(known.status(), 200)
  assert.deepEqual(quotaRefreshes, [[acc, true]])

  const unknown = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'ghost' }))
  assert.equal(unknown.status(), 200)
  assert.deepEqual(quotaRefreshes, [[acc, true]], 'unknown id refreshes nothing')
  assert.deepEqual(catalogCalls, [['known'], ['ghost']])
})

test('/pool/refresh-quota reports a duplicate click instead of silently doing nothing', async () => {
  // WHY: the route dedupes by key for up to QUOTA_REFRESH_DEDUP_MS. A click that
  // lands inside that window used to answer exactly like a fresh start, so a
  // slow pool looked frozen ("I clicked and the second account never moved").
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const acc = { id: 'inflight-acct' }
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'inflight-acct' ? acc : undefined) })
  const s = setup({
    pool: pool.pool,
    quota: {
      refreshAccountQuota: async () => {
        started.push('pipeline')
        await gate
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
    },
  })

  const first = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'inflight-acct' }))
  const second = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'inflight-acct' }))
  assert.equal(first.status(), 200)
  assert.equal((first.json() as Record<string, unknown>).alreadyRunning, false)
  assert.equal((second.json() as Record<string, unknown>).alreadyRunning, true, 'the duplicate click must be reported as such')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['pipeline'], 'a duplicate click must never stack a second pipeline')
  release!()
})

test('/pool/refresh-quota decouples slow catalog.warmAccounts from quotaRefreshInFlight', async () => {
  let releaseWarm: (() => void) | null = null
  const warmGate = new Promise<void>((resolve) => {
    releaseWarm = resolve
  })
  let refreshCalls = 0
  let warmCalls = 0
  const s = setup({
    pool: poolDouble({ getAccounts: () => [] }).pool,
    quota: {
      refreshAccountQuota: async () => undefined,
      refreshAllQuotas: async () => { refreshCalls++ },
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
      warmAccounts: async () => {
        warmCalls++
        await warmGate
      },
    },
  })

  const first = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', {}))
  assert.equal(first.status(), 200)
  assert.equal((first.json() as Record<string, unknown>).alreadyRunning, false)
  // Let refreshAllQuotas + forceRefresh finish while warmAccounts stays pending.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const second = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', {}))
  assert.equal(second.status(), 200)
  assert.equal((second.json() as Record<string, unknown>).alreadyRunning, false, 'slow catalog.warmAccounts must not keep quotaRefreshInFlight locked')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(refreshCalls, 2)
  assert.equal(warmCalls, 1, 'warmAccounts still deduplicates its own background run via catalogWarmInFlight')
  releaseWarm!()
  await new Promise((resolve) => setImmediate(resolve))
})

test('/pool/warmup is strict about JSON, deduplicates in-flight runs, and returns non-blocking pending status', async () => {
  const warmupCalls: unknown[][] = []
  const refreshedAccounts: unknown[] = []
  const knownAcc = { id: 'known', enabled: true }
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'known' ? knownAcc : undefined) })
  const s = setup({
    pool: pool.pool,
    warmup: {
      warmupAccount: async (...args: unknown[]) => {
        warmupCalls.push(['account', ...args])
        return [{ accountId: 'known', alias: 'known', model: 'm', success: true, durationMs: 1 }]
      },
      warmupAllAccounts: async (...args: unknown[]) => {
        warmupCalls.push(['all', ...args])
        return [{ accountId: 'known', alias: 'known', model: 'm', success: true, durationMs: 1 }]
      },
    },
    quota: {
      refreshAccountQuota: async (acc: unknown) => { refreshedAccounts.push(acc) },
      refreshAllQuotas: async () => undefined,
    },
  })

  const malformed = await invoke(s.route('/plugins/agy-link/pool/warmup'), rawReq('POST', '/', [Buffer.from('{oops')]))
  assert.equal(malformed.status(), 400)
  assert.deepEqual(malformed.json(), { error: 'invalid JSON body' })

  const oversized = await invoke(s.route('/plugins/agy-link/pool/warmup'), oversizedReq('POST'))
  assert.equal(oversized.status(), 400)
  assert.deepEqual(oversized.json(), { error: 'invalid JSON body' })

  const badModel = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true, model: 'bad model!' }))
  assert.equal(badModel.status(), 400)
  assert.deepEqual(badModel.json(), { error: 'invalid model' })

  const badModelType = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true, model: 7 }))
  assert.equal(badModelType.status(), 400)
  assert.deepEqual(badModelType.json(), { error: 'invalid model' })

  const missingSelector = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', {}))
  assert.equal(missingSelector.status(), 400)
  assert.deepEqual(missingSelector.json(), { error: 'id or { all: true } required' })
  assert.equal(warmupCalls.length, 0)

  const unknownAccount = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { id: 'ghost' }))
  assert.equal(unknownAccount.status(), 404)
  assert.deepEqual(unknownAccount.json(), { error: 'Account not found' })

  const one = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { id: 'known', force: true, model: 'gemini-3-flash', ignoreFailureBackoff: true }))
  assert.equal(one.status(), 200)
  assert.deepEqual(one.json(), { ok: true, pending: true, alreadyRunning: false, warmupState: null, pool: POOL_DATA })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(warmupCalls[0], ['account', knownAcc, { force: true, model: 'gemini-3-flash', ignoreFailureBackoff: true }])
  assert.equal(refreshedAccounts.length, 1)

  const all = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true }))
  assert.equal(all.status(), 200)
  assert.deepEqual(all.json(), { ok: true, pending: true, alreadyRunning: false, warmupState: null, pool: POOL_DATA })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(warmupCalls[1], ['all', { force: false }])
})

test('/pool/warmup deduplicates overlapping triggers and isolates background failures', async () => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  let shouldThrow = false
  const s = setup({
    warmup: {
      warmupAllAccounts: async () => {
        calls++
        await gate
        if (shouldThrow) throw new Error('warmup exploded')
        return []
      },
    },
  })

  const first = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true }))
  assert.equal(first.status(), 200)
  assert.equal((first.json() as Record<string, unknown>).pending, true)
  assert.equal((first.json() as Record<string, unknown>).alreadyRunning, false)

  const second = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true }))
  assert.equal(second.status(), 200)
  assert.equal((second.json() as Record<string, unknown>).alreadyRunning, true)
  assert.equal(calls, 1, 'overlapping /pool/warmup must reuse inflight run')

  shouldThrow = true
  release!()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  // Background error is caught cleanly and releases the dedupe slot for a retry.
  shouldThrow = false
  const retry = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true }))
  assert.equal(retry.status(), 200)
  assert.equal((retry.json() as Record<string, unknown>).alreadyRunning, false)
  await new Promise((resolve) => setImmediate(resolve))
})

test('REGRESSION: /pool/refresh-quota answers immediately even when the quota pipeline never settles', async () => {
  // Before the fix the route awaited a 20s `agy /usage` spawn + several REST
  // calls, so the console's "同步中" kept spinning. The status poll (3s) is
  // what actually delivers fresh numbers, so the HTTP response must not wait.
  let started = 0
  const s = setup({
    quota: {
      refreshAccountQuota: async () => {
        started++
        await new Promise<void>(() => undefined) // deliberately never resolves
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
    },
    pool: poolDouble({ getAccount: (id: unknown) => (id === 'hanging' ? { id: 'hanging' } : undefined) }).pool,
  })
  const startedAt = Date.now()
  const res = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'hanging' }))
  assert.equal(res.status(), 200)
  assert.equal((res.json() as { pending?: boolean }).pending, true)
  assert.equal(started, 1, 'the refresh still runs in the background')
  assert.ok(Date.now() - startedAt < 1000, 'the HTTP response must not wait for the pipeline')

  // A second click on the same account must not stack a duplicate pipeline.
  const again = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'hanging' }))
  assert.equal(again.status(), 200)
  assert.equal(started, 1, 'in-flight refresh is deduped')
})

test('REGRESSION: quota dedupe outlives the old 30s race while its work still runs', async () => {
  // The first version raced the work against ROUTE_TIMEOUT_MS and deleted the
  // dedupe entry when the timer won — a second click then started a second
  // `agy /usage` pipeline on top of the first. The entry now belongs to the
  // work itself, with a much longer hard cap.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let started = 0
    const s = setup({
      quota: {
        refreshAccountQuota: async () => {
          started++
          await new Promise<void>(() => undefined) // never settles
        },
        refreshAllQuotas: async () => undefined,
      },
      catalog: {
        get: () => ({ source: 'fallback', models: [], lastError: null }),
        getAllKnownModels: () => [],
        forceRefresh: async () => undefined,
      },
      pool: poolDouble({ getAccount: (id: unknown) => (id === 'slow' ? { id: 'slow' } : undefined) }).pool,
    })
    const route = s.route('/plugins/agy-link/pool/refresh-quota')
    await invoke(route, fakeReq('POST', '/', { id: 'slow' }))
    mock.timers.tick(31_000)
    await invoke(route, fakeReq('POST', '/', { id: 'slow' }))
    assert.equal(started, 1, 'no duplicate pipeline after 30s')
    mock.timers.tick(QUOTA_REFRESH_DEDUP_MS + 1)
    await invoke(route, fakeReq('POST', '/', { id: 'slow' }))
    assert.equal(started, 2, 'a genuinely wedged refresh can be retried after the hard cap')
  } finally {
    mock.timers.reset()
  }
})

test('issue #114: TOS quarantine survives the forced quota refresh in the same warmup request', async () => {
  // v0.6.26 marked the account authRequired on a terminal 403, but
  // handlePoolWarmup then unconditionally ran refreshAccountQuota(acc, true),
  // whose success cleared the flag again — all inside ONE HTTP request.
  const dir = mkdtempSync(join(tmpdir(), 'agy-tos-route-'))
  try {
    const realPool = new AccountPoolManager(dir)
    const acc = realPool.getAccounts()[0]!
    const tos = 'HTTP 403: TOS_VIOLATION service disabled. Appeal: https://forms.gle/x'
    const s = setup({
      pool: realPool,
      warmup: {
        warmupAccount: async () => {
          realPool.markAuthRequired(acc.id, tos)
          return [
            { accountId: acc.id, alias: acc.alias, model: 'gemini-4-argon', success: true, durationMs: 1 },
            { accountId: acc.id, alias: acc.alias, model: 'gemini-3.8-flash', success: false, status: 403, error: tos, durationMs: 1 },
          ]
        },
      },
      quota: {
        // Emulate the real pipeline: a successful OAuth/usage refresh calls
        // clearAuthRequired. It MUST NOT lift a terminal ban.
        refreshAccountQuota: async () => { realPool.clearAuthRequired(acc.id) },
      },
    })
    const res = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { id: acc.id, force: true }))
    assert.equal(res.status(), 200)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(realPool.getAccount(acc.id)?.authRequired, true, 'quarantine must still be set after background warmup + quota refresh')
    assert.equal(realPool.getAccount(acc.id)?.authError, tos)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('REGRESSION: every route answers 500 when a dependency throws (no silent hang)', async () => {
  const s = setup({
    quota: {
      refreshAccountQuota: async () => { throw new Error('boom') },
      refreshAllQuotas: async () => undefined,
    },
    pool: poolDouble({ getAccount: () => ({ id: 'x' }) }).pool,
  })
  // A background rejection is swallowed by the guarded runner, but the HTTP
  // response is still 200/pending — the important part is that it ENDS.
  const res = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'x' }))
  assert.equal(res.status(), 200)
  assert.equal((res.json() as { ok?: boolean }).ok, true)
})
