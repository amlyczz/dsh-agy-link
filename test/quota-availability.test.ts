// Quota availability: endpoint health breaker, per-account "quota unavailable"
// state, and the manual-sweep scheduler.
//
// WHY (live incident 2026-11-19): with five pool accounts on ONE egress, a
// manual "刷新额度" took ~55s and one account never updated at all. Two causes:
//   1. `retrieveUserQuotaSummary` on daily-cloudcode-pa.googleapis.com resets
//      the connection for every account (5-8s), and the first-endpoint order
//      made every refresh pay it before falling back to the sandbox endpoint.
//   2. That account's summary was 403 "not a valid license", so the pipeline
//      silently kept the previous snapshot — no error, no stale marker, row
//      frozen for days.
// These tests pin the fixes: endpoints that just failed are tried last, an
// unavailable summary is recorded on the account (and the account stops being
// polled until the retry window passes), and a manual sweep may run a bounded
// number of same-egress accounts in parallel while still staggering starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService } from '../src/host/quota.ts'
import { AGY_ENDPOINTS } from '../src/host/oauth.ts'
import { shouldPollAccount } from '../src/common/pool-types.ts'
import { QUOTA_ENDPOINT_DOWN_MS, QUOTA_LICENSE_RETRY_MS } from '../src/common/timeouts.ts'
import {
  EndpointHealth,
  endpointHealthKey,
  orderEndpointsByHealth,
} from '../src/features/quota/endpoint-health.ts'
import { fetchQuotaSummary, type QuotaHttpDeps } from '../src/features/quota/http.ts'
import { sweepAccountsByEgress } from '../src/features/quota/sweep.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const LICENSE_403_BODY = JSON.stringify({
  error: {
    code: 403,
    message: 'You do not have a valid license of this product. Please contact your administrator to request a license.',
    status: 'PERMISSION_DENIED',
  },
})

function httpDeps(overrides: Partial<QuotaHttpDeps> & Pick<QuotaHttpDeps, 'fetchSummaryEndpoint'>): QuotaHttpDeps {
  return {
    agyVersion: () => '1.5.11',
    getPreferredEndpointIndex: () => 0,
    setPreferredEndpointIndex: () => undefined,
    fetchUserQuotaEndpoint: async () => new Response('{}', { status: 200 }),
    ...overrides,
  }
}

// ---------------------------------------------------------------- breaker ---

test('EndpointHealth: a failed endpoint stays down for the TTL, then is retried', () => {
  let now = 1_000
  const health = new EndpointHealth(QUOTA_ENDPOINT_DOWN_MS, () => now)
  const key = endpointHealthKey('summary', 'https://a.example')

  assert.equal(health.isDown(key), false)
  health.noteFailure(key)
  assert.equal(health.isDown(key), true, 'right after a failure the endpoint is down')

  now += QUOTA_ENDPOINT_DOWN_MS - 1
  assert.equal(health.isDown(key), true, 'still down inside the window')

  now += 1
  assert.equal(health.isDown(key), false, 'the window must expire so a recovered endpoint is retried')

  health.noteFailure(key)
  health.noteSuccess(key)
  assert.equal(health.isDown(key), false, 'a success clears the breaker immediately')
})

test('orderEndpointsByHealth: unhealthy endpoints move to the back, never dropped', () => {
  const health = new EndpointHealth(QUOTA_ENDPOINT_DOWN_MS, () => 0)
  const [first, second] = AGY_ENDPOINTS
  health.noteFailure(endpointHealthKey('summary', first!))

  assert.deepEqual(
    orderEndpointsByHealth([first!, second!], 'summary', health),
    [second!, first!],
    'the endpoint that just reset is tried LAST instead of costing a full timeout first',
  )
  // A different op keeps its own health: models on `first` must stay first.
  assert.deepEqual(orderEndpointsByHealth([first!, second!], 'models', health), [first!, second!])

  // Total outage must still probe, or a transient reset would lock the pool out.
  health.noteFailure(endpointHealthKey('summary', second!))
  assert.deepEqual(orderEndpointsByHealth([first!, second!], 'summary', health), [first!, second!])

  assert.deepEqual(orderEndpointsByHealth([first!, second!], 'summary', undefined), [first!, second!])
})

test('fetchQuotaSummary skips a down endpoint and reports a licence 403 as no_license', async () => {
  const [primaryEp, fallbackEp] = AGY_ENDPOINTS
  const calls: string[] = []
  const failures: Array<{ kind: string; status?: number } | null> = []
  const health = new EndpointHealth(QUOTA_ENDPOINT_DOWN_MS, () => 0)
  health.noteFailure(endpointHealthKey('summary', primaryEp!))

  const out = await fetchQuotaSummary(
    httpDeps({
      fetchSummaryEndpoint: async (endpoint) => {
        calls.push(endpoint)
        return new Response(LICENSE_403_BODY, { status: 403 })
      },
      endpointHealth: health,
      onSummaryFailure: (failure) => failures.push(failure),
    }),
    'tok',
  )

  assert.equal(out, null)
  assert.deepEqual(calls, [fallbackEp], 'the down endpoint must not be hit at all')
  assert.deepEqual(failures.at(-1), { kind: 'no_license', status: 403, detail: 'PERMISSION_DENIED' })

  // The sandbox endpoint answered (403), so it is alive — only the reset one is down.
  assert.equal(health.isDown(endpointHealthKey('summary', fallbackEp!)), false)
})

test('fetchQuotaSummary marks a resetting endpoint down and clears it on success', async () => {
  const [primaryEp, fallbackEp] = AGY_ENDPOINTS
  const health = new EndpointHealth(QUOTA_ENDPOINT_DOWN_MS, () => 0)
  const failures: Array<{ kind: string } | null> = []

  const summary = { groups: [{ displayName: 'Gemini Models', buckets: [] }] }
  const out = await fetchQuotaSummary(
    httpDeps({
      fetchSummaryEndpoint: async (endpoint) => {
        if (endpoint === primaryEp) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
        return new Response(JSON.stringify(summary), { status: 200 })
      },
      endpointHealth: health,
      onSummaryFailure: (failure) => failures.push(failure),
    }),
    'tok',
  )

  assert.deepEqual(out, summary)
  assert.equal(failures.at(-1), null, 'a successful summary clears the failure record')
  assert.equal(health.isDown(endpointHealthKey('summary', primaryEp!)), true, 'the reset endpoint is remembered')
  assert.equal(health.isDown(endpointHealthKey('summary', fallbackEp!)), false)
})

// ------------------------------------------------- per-account availability ---

class StubQuotaService extends QuotaService {
  summaryCalls: string[] = []
  userQuotaCalls = 0
  constructor(
    pool: AccountPoolManager,
    private readonly summaryResponder: (endpoint: string) => Response | 'throw',
  ) {
    super(pool, () => '', () => '1.5.11', { bin: () => null, viaCli: () => true })
  }

  override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
    return { email: 'dao@example.com' }
  }

  protected override async fetchSummaryEndpoint(endpoint: string): Promise<Response> {
    this.summaryCalls.push(endpoint)
    const result = this.summaryResponder(endpoint)
    if (result === 'throw') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    return result
  }

  protected override async fetchUserQuotaEndpoint(): Promise<Response> {
    this.userQuotaCalls++
    return new Response('{}', { status: 200 })
  }

  override async fetchAvailableModels(): Promise<never> {
    return { models: {} } as never
  }
}

function makeIsolatedAccount(label: string): { pool: AccountPoolManager; dir: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-av-'))
  const pool = new AccountPoolManager(dir)
  pool.setAccountEnabled('acc_primary', false)
  const acc = pool.createAccountSlot(label)
  pool.clearAuthRequired(acc.id, true)
  const tokenDir = join(acc.dir, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ token: { access_token: 'tok', refresh_token: 'ref', expiry: Date.now() + 3_600_000 }, auth_method: 'consumer' }),
    'utf8',
  )
  return { pool, dir, id: acc.id }
}

test('a licence-refused summary records quotaUnavailable=no_license on the account', async () => {
  const { pool, dir, id } = makeIsolatedAccount('dao')
  try {
    const svc = new StubQuotaService(pool, () => new Response(LICENSE_403_BODY, { status: 403 }))
    const before = Date.now()
    const out = await svc.refreshAccountQuota(pool.getAccount(id)!, true)

    assert.equal(out, null)
    const state = pool.getAccount(id)!.quotaUnavailable
    assert.equal(state?.reason, 'no_license')
    assert.ok((state?.since ?? 0) >= before)
    assert.ok((state?.retryAfter ?? 0) >= before + QUOTA_LICENSE_RETRY_MS, 'the retry window is armed')

    // A licence refusal is terminal-ish: the hourly sweep must stop knocking.
    assert.equal(shouldPollAccount(pool.getAccount(id)!), false, 'no_license accounts leave the background sweep')
    // ...but a manual click must still be allowed to prove a restored licence.
    pool.getAccount(id)!.quotaUnavailable = { ...state!, retryAfter: 0 }
    assert.equal(shouldPollAccount(pool.getAccount(id)!), true, 'the retry window expiring re-arms polling')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an authoritative summary clears a previous quotaUnavailable state', async () => {
  const { pool, dir, id } = makeIsolatedAccount('healed')
  try {
    const broken = new StubQuotaService(pool, () => 'throw')
    await broken.refreshAccountQuota(pool.getAccount(id)!, true)
    assert.equal(pool.getAccount(id)!.quotaUnavailable?.reason, 'unreachable', 'a total failure is recorded, not swallowed')

    const healthy = new StubQuotaService(pool, () =>
      new Response(
        JSON.stringify({
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.42, resetTime: '2026-11-19T12:00:00Z' }],
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const out = await healthy.refreshAccountQuota(pool.getAccount(id)!, true)
    assert.equal(out?.google?.remainingFraction, 0.42)
    assert.equal(pool.getAccount(id)!.quotaUnavailable, undefined, 'fresh authoritative data clears the marker')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('background polls skip the summary request while a no_license account is in its retry window', async () => {
  const { pool, dir, id } = makeIsolatedAccount('suppressed')
  try {
    const first = new StubQuotaService(pool, () => new Response(LICENSE_403_BODY, { status: 403 }))
    await first.refreshAccountQuota(pool.getAccount(id)!, true)
    assert.equal(pool.getAccount(id)!.quotaUnavailable?.reason, 'no_license')

    const stampedSince = pool.getAccount(id)!.quotaUnavailable!.since
    await sleep(5)
    const background = new StubQuotaService(pool, () => new Response(LICENSE_403_BODY, { status: 403 }))
    await background.refreshAccountQuota(pool.getAccount(id)!, false)
    assert.equal(background.summaryCalls.length, 0, 'the doomed summary probe is not repeated on every poll')
    assert.equal(
      pool.getAccount(id)!.quotaUnavailable?.since,
      stampedSince,
      'a skipped probe must not re-stamp the marker as if it had just failed',
    )

    const forced = new StubQuotaService(pool, () => new Response(LICENSE_403_BODY, { status: 403 }))
    await forced.refreshAccountQuota(pool.getAccount(id)!, true)
    assert.ok(forced.summaryCalls.length > 0, 'an explicit refresh must still probe (licence may be restored)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------- scheduler ---

test('sweepAccountsByEgress: bounded concurrency per egress with staggered starts', async () => {
  const accounts = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}` }))
  const starts: number[] = []
  let active = 0
  let peak = 0

  await sweepAccountsByEgress(accounts, {
    egressOf: () => 'same-proxy',
    run: async () => {
      starts.push(Date.now())
      active++
      peak = Math.max(peak, active)
      await sleep(40)
      active--
    },
    staggerMs: () => 15,
    concurrency: 2,
  })

  assert.equal(starts.length, 5)
  assert.ok(peak >= 2, `expected parallel starts on one egress, saw peak=${peak}`)
  assert.ok(peak <= 2, `concurrency must stay bounded, saw peak=${peak}`)
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i]! - starts[i - 1]! >= 10, `starts must stay staggered (gap=${starts[i]! - starts[i - 1]!}ms)`)
  }
})

test('sweepAccountsByEgress: concurrency 1 keeps the background sweep strictly serial', async () => {
  const accounts = Array.from({ length: 3 }, (_, i) => ({ id: `b${i}` }))
  let active = 0
  let peak = 0
  const order: string[] = []

  await sweepAccountsByEgress(accounts, {
    egressOf: () => 'direct',
    run: async (acc) => {
      active++
      peak = Math.max(peak, active)
      order.push(acc.id)
      await sleep(20)
      active--
    },
    staggerMs: () => 0,
    concurrency: 1,
  })

  assert.equal(peak, 1, 'the unattended sweep must never overlap accounts')
  assert.deepEqual(order, ['b0', 'b1', 'b2'], 'and it must keep pool order')
})

test('refreshAllQuotas(true) refreshes same-egress accounts with bounded parallelism', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-sweep-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const ids: string[] = []
    for (const label of ['s1', 's2', 's3', 's4']) {
      const acc = pool.createAccountSlot(label)
      pool.clearAuthRequired(acc.id, true)
      pool.setAccountProxy(acc.id, 'http://127.0.0.1:7890')
      ids.push(acc.id)
    }

    let active = 0
    let peak = 0
    const starts: number[] = []
    class RecordingQuota extends QuotaService {
      override async refreshAccountQuota(): Promise<null> {
        starts.push(Date.now())
        active++
        peak = Math.max(peak, active)
        await sleep(40)
        active--
        return null
      }
    }
    const qs = new RecordingQuota(pool, () => '', () => '1.5.12', { forceStaggerMs: () => 20, forceConcurrency: () => 2 })
    await qs.refreshAllQuotas(true)

    assert.equal(starts.length, ids.length)
    assert.ok(peak >= 2, `expected a manual sweep to overlap accounts, saw peak=${peak}`)
    assert.ok(peak <= 2, `manual sweep concurrency must stay bounded, saw peak=${peak}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('QuotaService exposes the account ids currently refreshing', async () => {
  const { pool, dir, id } = makeIsolatedAccount('spinner')
  try {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    class GatedQuota extends QuotaService {
      constructor() {
        super(pool, () => '', () => '1.5.12', { bin: () => null })
      }
      override async fetchUserInfo(): Promise<{ email?: string } | null> {
        await gate
        return { email: 'spinner@example.com' }
      }
      protected override async fetchSummaryEndpoint(): Promise<Response> {
        return new Response(JSON.stringify({ groups: [] }), { status: 200 })
      }
      protected override async fetchUserQuotaEndpoint(): Promise<Response> {
        return new Response('{}', { status: 200 })
      }
      override async fetchAvailableModels(): Promise<never> {
        return { models: {} } as never
      }
    }
    const qs = new GatedQuota()
    const running = qs.refreshAccountQuota(pool.getAccount(id)!, true)
    await sleep(10)
    assert.deepEqual(qs.refreshingAccounts(), [id], 'the console can show which row is being refreshed')
    release!()
    await running
    assert.deepEqual(qs.refreshingAccounts(), [], 'and clears it when the refresh settles')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
