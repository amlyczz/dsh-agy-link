import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService, detectEmailFromAgyLogs, mergeFallbackFamilyQuota, normalizeStoredToken } from '../src/host/quota.ts'
import { shouldPollAccount } from '../src/common/pool-types.ts'
import { writeAgyTokenFile, parsePastedCode, generatePkce } from '../src/host/oauth.ts'

test('QuotaService parses stored tokens and saves token refresh updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'))
  const pool = new AccountPoolManager(dir)
  // Primary rides the system HOME (Keychain); token files only exist for
  // isolated secondary accounts — exercise those.
  const acc = pool.createAccountSlot('quota-test')

  const tokenDir = join(acc.dir, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({
      access_token: 'fake_access_token_123',
      refresh_token: 'fake_refresh_token_456',
      expiry: Date.now() + 3600_000,
    }),
    'utf8',
  )

  const quota = new QuotaService(pool)
  const stored = quota.getStoredToken(acc)
  assert.equal(stored?.accessToken, 'fake_access_token_123')
  assert.equal(stored?.refreshToken, 'fake_refresh_token_456')

  const validToken = await quota.getValidAccessToken(acc)
  assert.equal(validToken, 'fake_access_token_123')
})

test('normalizeStoredToken reads agy 1.1.16 nested shape with ISO expiry', () => {
  // Real on-disk format: {"token": {...}, "auth_method": "consumer"} with
  // expiry as a local ISO-8601 string. The old flat read returned the
  // nested object as the access token ("Bearer [object Object]").
  const nested = normalizeStoredToken({
    token: {
      access_token: 'ya29.nested',
      token_type: 'Bearer',
      refresh_token: '1//nested-refresh',
      expiry: '2026-08-20T16:44:43.782922+08:00',
    },
    auth_method: 'consumer',
  })
  assert.equal(nested?.accessToken, 'ya29.nested')
  assert.equal(nested?.refreshToken, '1//nested-refresh')
  assert.equal(nested?.expiryMs, Date.parse('2026-08-20T16:44:43.782922+08:00'))

  // A bare-object "token" must never be mistaken for the token string.
  assert.equal(normalizeStoredToken({ token: { nope: 1 } }), null)
  assert.equal(normalizeStoredToken({}), null)

  // Epoch seconds and millis both parse.
  const secs = normalizeStoredToken({ access_token: 'a', expiry: 1_800_000_000 })
  assert.equal(secs?.expiryMs, 1_800_000_000_000)
  const millis = normalizeStoredToken({ access_token: 'a', expiry: 1_800_000_000_000 })
  assert.equal(millis?.expiryMs, 1_800_000_000_000)
})

test('normalizeStoredToken parses go-keyring-base64 JSON payloads from Keychain', () => {
  const payload = {
    token: {
      access_token: 'ya29.keychain_access',
      token_type: 'Bearer',
      refresh_token: '1//keychain_refresh',
      expiry: '2026-08-21T15:34:29.273+08:00',
    },
    auth_method: 'consumer',
  }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  const rawKeychainString = `go-keyring-base64:${b64}`
  assert.ok(rawKeychainString.startsWith('go-keyring-base64:'))
  const decoded = JSON.parse(Buffer.from(rawKeychainString.slice('go-keyring-base64:'.length), 'base64').toString('utf8'))
  const token = normalizeStoredToken(decoded)
  assert.equal(token?.accessToken, 'ya29.keychain_access')
  assert.equal(token?.refreshToken, '1//keychain_refresh')
  assert.equal(token?.expiryMs, Date.parse('2026-08-21T15:34:29.273+08:00'))
})

test('writeAgyTokenFile emits the agy on-disk format and round-trips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-oauth-write-'))
  const home = join(dir, 'home')
  const file = writeAgyTokenFile(home, {
    access_token: 'ya29.fresh',
    refresh_token: '1//fresh-refresh',
    expiryMs: Date.parse('2026-08-21T00:00:00Z'),
  })
  assert.ok(file.endsWith(join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')))

  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('roundtrip')
  // Point the account at the HOME we just wrote.
  acc.dir = home
  const quota = new QuotaService(pool)
  const stored = quota.getStoredToken(acc)
  assert.equal(stored?.accessToken, 'ya29.fresh')
  assert.equal(stored?.refreshToken, '1//fresh-refresh')
  assert.equal(stored?.expiryMs, Date.parse('2026-08-21T00:00:00Z'))
})

test('parsePastedCode accepts bare codes and full redirect URLs', () => {
  assert.deepEqual(parsePastedCode('4/1AfJohXyZ'), { code: '4/1AfJohXyZ' })
  assert.deepEqual(
    parsePastedCode('http://localhost:51121/oauth-callback?code=4/1AfCde&state=xyz123'),
    { code: '4/1AfCde', state: 'xyz123' },
  )
  assert.equal(parsePastedCode('http://localhost:51121/oauth-callback?state=xyz'), null)
  assert.equal(parsePastedCode('short'), null)
  assert.equal(parsePastedCode(''), null)
})

test('generatePkce produces a valid S256 pair', () => {
  const { verifier, challenge } = generatePkce()
  assert.ok(verifier.length >= 43)
  assert.ok(/^[A-Za-z0-9_-]+$/.test(verifier))
  assert.ok(/^[A-Za-z0-9_-]+$/.test(challenge))
  assert.notEqual(verifier, challenge)
})

test('Quota aggregation extracts bottleneck model fraction and earliest reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-agg-'))
  const pool = new AccountPoolManager(dir)
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

test('detectEmailFromAgyLogs extracts user email from agy log files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-test-'))
  const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'cli-20260820_120000.log'),
    'ERROR: logging before google.Init: OAuth: authenticated successfully as dev.user@google.com\n',
    'utf8',
  )
  const email = detectEmailFromAgyLogs(dir)
  assert.equal(email, 'dev.user@google.com')
})

test('shouldPollAccount skips restricted accounts in background polling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-poll-gate-'))
  const pool = new AccountPoolManager(dir)
  const healthy = pool.createAccountSlot('healthy')
  const cooling = pool.createAccountSlot('cooling')
  const quarantined = pool.createAccountSlot('quarantined')
  const disabled = pool.createAccountSlot('disabled')

  // healthy: pollable as-is
  assert.equal(shouldPollAccount(pool.getAccount(healthy.id)!), true)

  // cooling: 429 cooldown active -> skipped until it expires
  pool.recordFailure(cooling.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 21m25s.')
  assert.equal(shouldPollAccount(pool.getAccount(cooling.id)!), false)

  // quarantined: invalid_grant -> skipped until re-auth
  pool.markAuthRequired(quarantined.id, 'invalid_grant')
  assert.equal(shouldPollAccount(pool.getAccount(quarantined.id)!), false)

  // disabled: skipped
  const dis = pool.getAccount(disabled.id)!
  dis.enabled = false
  assert.equal(shouldPollAccount(dis), false)

  // expired cooldown becomes pollable again
  const cd = pool.getAccount(cooling.id)!.cooldowns.google!
  cd.cooldownUntil = Date.now() - 1
  assert.equal(shouldPollAccount(pool.getAccount(cooling.id)!), true)
})

test('mergeFallbackFamilyQuota keeps last-known-good data over partial fallback', () => {
  // Real incident shape: complete entry (5h + weekly) existed, then the
  // summary endpoint blipped and per-model fallback arrived carrying a
  // single window (fraction 1, weekly-window reset a week out, no weekly).
  const good: import('../src/common/pool-types.ts').FamilyQuotaInfo = {
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
  // Complete previous data wins — never clobbered by the partial shape.
  assert.equal(mergeFallbackFamilyQuota(good, partial), good)
  assert.equal(mergeFallbackFamilyQuota(good, partial).weeklyFraction, 0.47)
  // No previous data (first-ever refresh) → fallback fills in.
  assert.equal(mergeFallbackFamilyQuota(undefined, partial), partial)
  // Degenerate previous entry without a fraction → fallback fills in.
  assert.equal(mergeFallbackFamilyQuota({ weeklyFraction: 0.5 }, partial), partial)
})

test('UI_PATHS contains all expected clean SVG paths', async () => {
  const { UI_PATHS } = await import('../src/client/brand-icons.ts')
  assert.ok(UI_PATHS.trash.length > 10)
  assert.ok(UI_PATHS.plus.length > 5)
  assert.ok(UI_PATHS.refresh.length > 10)
  assert.ok(UI_PATHS.star.length > 10)
  assert.ok(UI_PATHS.mail.length > 10)
  assert.ok(UI_PATHS.globe.length > 10)
  assert.ok(UI_PATHS.zap.length > 5)
  assert.ok(UI_PATHS.x.length > 5)
  assert.ok(UI_PATHS.check.length > 5)
})

