// The pure quota and pool helpers: aggregation, last-known-good merging,
// window matching, and the UA/version plumbing the backend needs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QuotaService,
  agyUserAgent,
  isStale5hBucket,
  mergeFallbackFamilyQuota,
  pickFamilyQuota,
  sameQuotaWindow,
  staggerJitterMs,
  summaryHasArgonGroup,
} from '../../../src/host/quota.ts'
import { makeTempPool } from './quota-fixtures.ts'

test('Quota aggregation extracts bottleneck model fraction and earliest reset', () => {
  const { dir, pool } = makeTempPool('agy-quota-agg-')
  const acc = pool.getAccounts()[0]!

  pool.updateAccountQuotas(
    acc.id,
    {
      google: {
        remainingFraction: 0.85,
        resetTime: '2026-08-20T16:00:00Z',
        weeklyFraction: 0.95,
        weeklyResetTime: '2026-08-27T08:00:00Z',
        models: [
          { modelId: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', remainingFraction: 0.85, resetTime: '2026-08-20T16:00:00Z' },
          { modelId: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', remainingFraction: 0.9, resetTime: '2026-08-20T16:00:00Z' },
        ],
      },
      anthropic: {
        remainingFraction: 0.4,
        resetTime: '2026-08-20T18:30:00Z',
        weeklyFraction: 0.8,
        weeklyResetTime: '2026-08-27T12:00:00Z',
        models: [
          { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', remainingFraction: 0.4, resetTime: '2026-08-20T18:30:00Z' },
        ],
      },
      openai: {
        remainingFraction: 1.0,
        weeklyFraction: 1.0,
      },
    },
    'test@gmail.com',
  )

  const updated = pool.getAccount(acc.id)!
  assert.equal(updated.email, 'test@gmail.com')
  assert.equal(updated.quotas.google?.remainingFraction, 0.85)
  assert.equal(updated.quotas.google?.weeklyFraction, 0.95)
  assert.equal(updated.quotas.google?.weeklyResetTime, '2026-08-27T08:00:00Z')
  assert.equal(updated.quotas.google?.models?.length, 2)
  assert.equal(updated.quotas.anthropic?.remainingFraction, 0.4)
  assert.equal(updated.quotas.anthropic?.weeklyFraction, 0.8)
  assert.equal(updated.quotas.anthropic?.models?.length, 1)
  assert.equal(updated.quotas.openai?.remainingFraction, 1.0)
  assert.equal(updated.quotas.openai?.weeklyFraction, 1.0)
})

test('mergeFallbackFamilyQuota keeps last-known-good data over partial fallback', () => {
  // Real incident shape: complete entry (5h + weekly) existed, then the
  // summary endpoint blipped and per-model fallback arrived carrying a
  // single window (fraction 1, weekly-window reset a week out, no weekly).
  const good: import('../../../src/common/pool-types.ts').FamilyQuotaInfo = {
    remainingFraction: 0.84,
    resetTime: '2026-08-25T14:01:28Z',
    weeklyFraction: 0.47,
    weeklyResetTime: '2026-08-27T08:13:04Z',
    updatedAt: 1_000,
  }
  const partial = {
    remainingFraction: 1,
    resetTime: '2026-09-01T09:53:06Z',
    updatedAt: 2_000,
  }
  // Complete previous data wins 鈥?never clobbered by the partial shape.
  assert.equal(mergeFallbackFamilyQuota(good, partial), good)
  assert.equal(mergeFallbackFamilyQuota(good, partial).weeklyFraction, 0.47)
  // No previous data (first-ever refresh) 鈫?fallback fills in.
  assert.equal(mergeFallbackFamilyQuota(undefined, partial), partial)
  // Degenerate previous entry without a fraction 鈫?fallback fills in.
  assert.equal(mergeFallbackFamilyQuota({ weeklyFraction: 0.5 }, partial), partial)
})

test('UI_PATHS contains all expected clean SVG paths', async () => {
  const { UI_PATHS } = await import('../../../src/client/brand-icons.ts')
  assert.ok(UI_PATHS.trash.length > 10)
  assert.ok(UI_PATHS.plus.length > 5)
  assert.ok(UI_PATHS.refresh.length > 10)
  assert.ok(UI_PATHS.star.length > 10)
  assert.ok(UI_PATHS.mail.length > 10)
  assert.ok(UI_PATHS.globe.length > 10)
  assert.ok(UI_PATHS.zap.length > 5)
  assert.ok(UI_PATHS.x.length > 5)
  assert.ok(UI_PATHS.check.length > 5)
  assert.ok(UI_PATHS.power.length > 10)
})

test('AGY_ENDPOINTS prioritizes Antigravity endpoint and uses consumer sandbox fallback', async () => {
  const { AGY_ENDPOINTS } = await import('../../../src/host/oauth.ts')
  assert.equal(AGY_ENDPOINTS[0], 'https://daily-cloudcode-pa.googleapis.com', 'Antigravity daily endpoint must be first')
  assert.ok(AGY_ENDPOINTS.includes('https://daily-cloudcode-pa.sandbox.googleapis.com'), 'daily sandbox remains as consumer fallback')
  assert.equal(AGY_ENDPOINTS.includes('https://cloudcode-pa.googleapis.com'), false, 'enterprise cloudcode-pa must not be queried')
})

test('sameQuotaWindow matches reset instants, not their textual form', () => {
  const a = '2026-10-24T18:19:18Z'
  const shifted = '2026-10-24T18:19:20Z' // 2s drift (server recomputes on every poll)
  const different = '2026-10-22T19:43:34Z'
  assert.equal(sameQuotaWindow(a, a), true)
  assert.equal(sameQuotaWindow(a, shifted), true, 'small drift still names the same window')
  assert.equal(sameQuotaWindow(a, different), false, 'a different instant names a different window')
  assert.equal(sameQuotaWindow(a, undefined), false)
  assert.equal(sameQuotaWindow('not-a-date', a), false)
  // A ~12h-apart pair must never be folded together.
  assert.equal(sameQuotaWindow('2026-10-24T18:00:00Z', '2026-10-25T06:00:00Z'), false)
})

test('isStale5hBucket correctly identifies unmetered placeholder 5h buckets', () => {
  const now = Date.now()
  // Exactly 5h away and remainingFraction = 1.0 -> stale placeholder
  assert.equal(isStale5hBucket(1.0, new Date(now + 5 * 3600_000).toISOString(), now), true)
  assert.equal(isStale5hBucket(1.0, new Date(now + 4.9 * 3600_000).toISOString(), now), true)
  // Active window in progress (e.g. 2h remaining or 30 mins) -> NOT stale
  assert.equal(isStale5hBucket(1.0, new Date(now + 2 * 3600_000).toISOString(), now), false)
  // Partially consumed fraction (< 1.0) -> NOT stale (it is actively billing)
  assert.equal(isStale5hBucket(0.97, new Date(now + 5 * 3600_000).toISOString(), now), false)
  // Missing reset time or fraction -> NOT stale
  assert.equal(isStale5hBucket(undefined, new Date(now + 5 * 3600_000).toISOString(), now), false)
  assert.equal(isStale5hBucket(1.0, undefined, now), false)
})

test('agyUserAgent emits the CLI product string the backend needs for Argon', () => {
  // Regression: the UA used to be `antigravity/<version> <os>/<arch>`, which the
  // backend classifies as a non-CLI product, so `retrieveUserQuotaSummary`
  // answered with only the Gemini/3P groups and the Pro-plan Argon group was
  // never present 鈥?the UI silently showed no Argon quota at all.
  const fallback = agyUserAgent()
  assert.match(fallback, /^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=/)
  assert.ok(fallback.includes('auth_method=consumer'), 'keeps the CLI identity markers')
  assert.ok(!fallback.includes('antigravity/2.'), 'must not use the old non-CLI product form')

  // A real, new-enough agy version is forwarded verbatim.
  assert.ok(agyUserAgent('1.4.5').includes('antigravity/cli/1.4.5 '))
  assert.ok(agyUserAgent('1.5.0').includes('antigravity/cli/1.5.0 '))

  // Anything older than the floor (or unparseable) falls back, because those
  // builds never received the Argon group in the first place.
  assert.ok(!agyUserAgent('1.2.2').includes('cli/1.2.2'), 'below floor must not claim a new version')
  assert.ok(!agyUserAgent('garbage').includes('garbage'))
  assert.ok(!agyUserAgent(null).includes('null'))
})

test('QuotaService accepts an agy version provider without touching the network', () => {
  const { dir, pool } = makeTempPool('agy-ua-')
  const quota = new QuotaService(pool, () => '', () => '1.4.5')
  assert.ok(quota instanceof QuotaService)
})

test('pickFamilyQuota drops a dead last-known-good row when the summary is authoritative', () => {
  // Real incident: an account upgraded Pro 鈫?Ultra. The backend then stopped
  // returning the separate `Gemini 4 Argon` group (its quota is folded into the
  // Gemini bucket) while `fetchAvailableModels` kept listing the argon models
  // with a fresh 100%. Keeping last-known-good froze the previous tier's window
  // on screen: 0%, and a reset time two days in the past relative to the new one.
  const staleArgon: import('../../../src/common/pool-types.ts').FamilyQuotaInfo = {
    remainingFraction: 0,
    resetTime: '2026-10-27T03:28:36Z',
    weeklyFraction: 0,
    weeklyResetTime: '2026-10-27T03:28:36Z',
    updatedAt: 1_000,
  }
  const freshArgon = {
    remainingFraction: 1,
    resetTime: '2026-10-30T03:19:31Z',
    updatedAt: 2_000,
  }

  // Authoritative summary: the family is genuinely gone 鈫?adopt the live value.
  assert.equal(pickFamilyQuota(staleArgon, freshArgon, true), freshArgon)

  // Failed/empty summary: nothing authoritative arrived 鈫?keep last-known-good,
  // which is exactly what mergeFallbackFamilyQuota already guarantees.
  assert.equal(pickFamilyQuota(staleArgon, freshArgon, false), staleArgon)

  // First-ever refresh has no previous value either way.
  assert.equal(pickFamilyQuota(undefined, freshArgon, true), freshArgon)
  assert.equal(pickFamilyQuota(undefined, freshArgon, false), freshArgon)
})

test('summaryHasArgonGroup detects the dedicated Argon bucket across group shapes', () => {
  // Pro: the backend emits a dedicated group whose name carries "Argon".
  assert.equal(summaryHasArgonGroup([
    { displayName: 'Gemini Models', description: 'Gemini Flash, Gemini Pro' },
    { displayName: 'Gemini 4 Argon', description: 'For paid Pro plans, Argon quota is separate.' },
  ]), true)

  // Freshly upgraded Ultra account: only the two shared groups come back, so the
  // family is now governed by the Gemini bucket (the #54 scenario).
  assert.equal(summaryHasArgonGroup([
    { displayName: 'Gemini Models', description: 'Gemini Flash, Gemini Pro' },
    { displayName: 'Claude and GPT models', description: 'Claude Opus, Claude Sonnet, GPT-OSS' },
  ]), false)

  // A neutrally named group that only announces Argon through its bucketId still counts.
  assert.equal(summaryHasArgonGroup([{
    displayName: 'Quota',
    buckets: [{ bucketId: 'gemini-argon-wtu-weekly', displayName: 'Weekly Limit Remaining' }],
  }]), true)

  assert.equal(summaryHasArgonGroup([]), false)
})

test('staggerJitterMs generates organic values within requested bounds', () => {
  for (let i = 0; i < 50; i++) {
    const val = staggerJitterMs(2000, 1500)
    assert.ok(val >= 2000, "delay must be >= 2000")
    assert.ok(val < 3500, "delay must be < 3500")
  }
  // Custom base and jitter
  const exact = staggerJitterMs(1000, 1)
  assert.equal(exact, 1000)
})
