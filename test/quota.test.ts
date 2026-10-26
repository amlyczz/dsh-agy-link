import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService, agyUserAgent, detectEmailFromAgyLogs, isStale5hBucket, mergeFallbackFamilyQuota, normalizeStoredToken, pickFamilyQuota, sameCredentialGrant, sameQuotaWindow, shouldReleaseOrphanedCooldown, summaryHasArgonGroup } from '../src/host/quota.ts'
import { shouldPollAccount } from '../src/common/pool-types.ts'
import { writeAgyTokenFile, parsePastedCode, generatePkce } from '../src/host/oauth.ts'
import { parseCredentialDoc, writePrimaryCredential } from '../src/host/credential-slot.ts'
import { detectSystemProxy } from '../src/host/wincred.ts'

test('persistRefreshedToken keeps the refresh token and writes agy nested shape', () => {
  // Regression: the writer used to emit a flat `{access_token,expiry}` document
  // when the file did not exist yet, DROPPING the refresh token. A credential
  // without a refresh token has no stable identity, so the corruption guards
  // (which compare grants) could never fire.
  const dir = mkdtempSync(join(tmpdir(), 'agy-persist-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('persist-test')
  const quota = new QuotaService(pool)
  const persist = (
    quota as unknown as {
      persistRefreshedToken: (a: unknown, t: Record<string, unknown>) => void
    }
  ).persistRefreshedToken.bind(quota)

  const file = join(acc.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')

  persist(acc, { access_token: 'A1', expiryMs: Date.now() + 3600_000, refresh_token: 'R-KEEP' })
  const first = parseCredentialDoc(readFileSync(file, 'utf8'))
  assert.equal(first?.refreshToken, 'R-KEEP', 'the refresh token must be written')
  assert.equal(first?.accessToken, 'A1')
  assert.ok(first?.expiryMs, 'expiry must survive as a parseable timestamp')

  // A later refresh that does not re-supply the refresh token must not lose it.
  persist(acc, { access_token: 'A2', expiryMs: Date.now() + 3600_000 })
  const second = parseCredentialDoc(readFileSync(file, 'utf8'))
  assert.equal(second?.refreshToken, 'R-KEEP', 'the refresh token must be preserved')
  assert.equal(second?.accessToken, 'A2')
})

test('QuotaService parses stored tokens and saves token refresh updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'))
  const pool = new AccountPoolManager(dir)
  // Primary rides the system HOME (Keychain); token files only exist for
  // isolated secondary accounts 鈥?exercise those.
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
  const stored = await quota.getStoredToken(acc)
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
  const stored = await quota.getStoredToken(acc)
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

test('manual force refresh re-anchors slot identity from the token, not the label (primary showed another account\'s quota)', async () => {
  // Real incident: the system token belonged to elegantmanco@gmail.com but
  // the slot still said q986465568@gmail.com (log scraping returned the
  // stale label), so 鍒锋柊/鍚屾 fetched elegantmanco's quota and displayed
  // it as the primary's values. Manual refresh must trust the TOKEN (via
  // userinfo) over both the stored label and log detection.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-force-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('force-sync')
  // Slot currently labeled with the OLD account.
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5, weeklyFraction: 0.5 } }, 'q986465568@gmail.com')

  // Token on disk is valid, so no refresh-token flow kicks in.
  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.tok_of_elegantmanco', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  let userinfoCalls = 0
  class ForceSyncService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      userinfoCalls++
      return { email: 'elegantmanco@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-08-27T12:00:00Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-08-29T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new ForceSyncService(pool)
  await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)

  assert.ok(userinfoCalls >= 1, 'manual refresh verifies the token identity via userinfo')
  const healed = pool.getAccount(acc.id)!
  assert.equal(healed.email, 'elegantmanco@gmail.com', 'slot re-labeled to the token owner')
  assert.equal(healed.quotas.google?.remainingFraction, 0.7, 'quota stored under the healed identity')
  assert.equal(healed.quotas.google?.weeklyFraction, 0.42)
})

test('background refresh keeps the zero-network identity path (no userinfo when email known)', async () => {
  // 0.4.15 risk posture: background polls never call userinfo just to detect
  // account switching 鈥?only manual force refreshes pay that network cost.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-bg-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('bg-poll')
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5 } }, 'stable@gmail.com')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.stable', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  let userinfoCalls = 0
  class BgService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      userinfoCalls++
      return null
    }
    override async fetchQuotaSummary() {
      return { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-08-27T12:00:00Z' }] }] } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new BgService(pool)
  const out = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, false)
  assert.equal(userinfoCalls, 0, 'background refresh must not call userinfo')
  assert.equal(out?.google?.remainingFraction, 0.9)
  assert.equal(pool.getAccount(acc.id)!.email, 'stable@gmail.com')
})

test('getStoredToken prefers the macOS Keychain credential over a stale disk token for the primary account', async () => {
  // Real incident (verified live): agy 1.1.15+ keeps the CURRENT credential
  // in the macOS Keychain; the on-disk antigravity-oauth-token was a stale
  // leftover from a PREVIOUS account's login. Disk-first precedence made
  // every quota refresh fetch the WRONG account's numbers while agy itself
  // was happily authenticated as the right one.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-kc-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)!
  assert.ok(primary, 'bootstrap default primary exists')

  const keychainToken = {
    accessToken: 'ya29.keychain_current_login',
    refreshToken: '1//keychain_refresh',
    expiryMs: Date.now() + 3_600_000,
  }
  let keychainReads = 0
  class KeychainFirstService extends QuotaService {
    override async readSystemKeychainToken() {
      keychainReads++
      return keychainToken
    }
  }

  const svc = new KeychainFirstService(pool)
  const stored = await svc.getStoredToken(primary)
  assert.ok(keychainReads >= 1, 'primary token resolution consults the Keychain')
  assert.equal(stored?.accessToken, 'ya29.keychain_current_login', 'Keychain credential wins over any disk file')
  assert.equal(stored?.refreshToken, '1//keychain_refresh')
})

test('getStoredToken never reads the shared Keychain for isolated pool accounts', async () => {
  // The Keychain is ONE shared slot owned by the system-HOME login; isolated
  // account slots must only ever see their own directory's token file.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-iso-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('isolated')
  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.isolated_own', expiry: Date.now() + 3600_000 }),
    'utf8',
  )
  let keychainReads = 0
  class IsoService extends QuotaService {
    override async readSystemKeychainToken() {
      keychainReads++
      return null
    }
  }
  const svc = new IsoService(pool)
  assert.equal((await svc.getStoredToken(acc))?.accessToken, 'ya29.isolated_own')
  assert.equal(keychainReads, 0, 'isolated accounts must not touch the shared Keychain')
})

test('detectEmailFromAgyLogs returns the latest email in a log file, not the first', () => {
  // Logs are append-ordered: an old login can appear ABOVE a newer one.
  // First-match returned the OLD account; the last match is the current one.
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-last-'))
  const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'cli-20260827_100000.log'),
    'OAuth: authenticated successfully as old.account@google.com\n' +
      '...hours pass...\n' +
      'OAuth: authenticated successfully as new.account@google.com\n',
    'utf8',
  )
  assert.equal(detectEmailFromAgyLogs(dir), 'new.account@google.com')
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
  // Complete previous data wins 鈥?never clobbered by the partial shape.
  assert.equal(mergeFallbackFamilyQuota(good, partial), good)
  assert.equal(mergeFallbackFamilyQuota(good, partial).weeklyFraction, 0.47)
  // No previous data (first-ever refresh) 鈫?fallback fills in.
  assert.equal(mergeFallbackFamilyQuota(undefined, partial), partial)
  // Degenerate previous entry without a fraction 鈫?fallback fills in.
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
  assert.ok(UI_PATHS.power.length > 10)
})


test('readSystemKeychainToken dispatches per platform (GH #8 / GH #30)', async () => {
  const { readLinuxSecretToken, readMacKeychainToken, readWindowsCredentialToken } = await import('../src/host/quota.ts')
  // Both readers are hard platform gates - safe to call anywhere.
  if (process.platform !== 'darwin') assert.equal(await readMacKeychainToken(), null, 'mac reader no-ops off darwin')
  if (process.platform !== 'linux') assert.equal(await readLinuxSecretToken(), null, 'linux reader no-ops off linux')
  if (process.platform !== 'win32') assert.equal(await readWindowsCredentialToken(), null, 'windows reader no-ops off win32')
  // A subclass mirroring the production dispatch resolves without throwing.
  // (Result is environment-dependent: a real keyring entry may exist.)
  class DispatchProbe extends QuotaService {
    override async readSystemKeychainToken() {
      if (process.platform === 'linux') return readLinuxSecretToken()
      if (process.platform === 'darwin') return readMacKeychainToken()
      if (process.platform === 'win32') return readWindowsCredentialToken()
      return null
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-dispatch-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.createAccountSlot('primary')
  primary.systemHome = true
  const svc = new DispatchProbe(pool)
  const tok = await svc.getStoredToken(primary)
  assert.ok(tok === null || typeof tok.accessToken === 'string', 'dispatch resolves without throwing')
})

test('AGY_ENDPOINTS prioritizes Antigravity endpoint', async () => {
  const { AGY_ENDPOINTS } = await import('../src/host/oauth.ts')
  assert.equal(AGY_ENDPOINTS[0], 'https://daily-cloudcode-pa.googleapis.com', 'Antigravity daily endpoint must be first')
  assert.ok(AGY_ENDPOINTS.includes('https://cloudcode-pa.googleapis.com'), 'cloudcode-pa remains as fallback')
})

test('fetchQuotaSummary falls through partial summaries omitting Gemini to complete endpoints', async () => {
  const { QuotaService } = await import('../src/host/quota.ts')
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-complete-'))
  const pool = new AccountPoolManager(dir)

  const partialSummary = {
    groups: [
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-16T12:00:00Z' },
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-23T12:00:00Z' },
        ],
      },
    ],
  }

  const completeSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-16T12:00:00Z' },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-10-21T12:00:00Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-16T12:00:00Z' },
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-23T12:00:00Z' },
        ],
      },
    ],
  }

  let callCount = 0
  class TestQuotaService extends QuotaService {
    override async fetchSummaryEndpoint(): Promise<Response> {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify(partialSummary), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify(completeSummary), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  }

  const svc = new TestQuotaService(pool)
  const result = await svc.fetchQuotaSummary('fake_tok')
  assert.ok(result, 'summary should be returned')
  assert.equal(callCount, 2, 'should have fallen through the partial endpoint to the complete one')
  const hasGemini = result.groups?.some((g) => g.displayName?.toLowerCase().includes('gemini'))
  assert.equal(hasGemini, true, 'returned summary must contain Gemini models')
})

test('Gemini 4 Argon quota group lands in its own family, never on google', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-argon-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('argon-user')

  // Valid on-disk token so no refresh flow runs.
  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.argo', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  class ArgonService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      return { email: 'pro-user@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-10-20T12:00:00Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-10-23T12:00:00Z' },
            ],
          },
          {
            // Real shape: the argon group name still contains "gemini" but
            // carries ONLY its own weekly bucket (paid Pro/Ultra accounts).
            displayName: 'Gemini 4 Argon',
            description: 'Models within this group: Gemini 4 Argon',
            buckets: [
              { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.66, resetTime: '2026-10-23T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon-low': { displayName: 'Gemini 4 Argon (Low)', quotaInfo: { remainingFraction: 0.66, resetTime: '2026-10-23T12:00:00Z' } },
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-10-20T12:00:00Z' } },
        },
      } as never
    }
  }

  const svc = new ArgonService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas, 'quota refresh succeeded')
  // Argon group + argon model ids live under their OWN family...
  assert.equal(quotas.argon?.weeklyFraction, 0.66)
  assert.equal(quotas.argon?.weeklyResetTime, '2026-10-23T12:00:00Z')
  assert.equal(quotas.argon?.models?.length, 1)
  assert.equal(quotas.argon?.models?.[0]?.modelId, 'gemini-4-argon-low')
  // ...without clobbering the plain Gemini family.
  assert.equal(quotas.google?.remainingFraction, 0.7)
  assert.equal(quotas.google?.weeklyFraction, 0.42)

  const stored = pool.getAccount(acc.id)!
  assert.equal(stored.quotas.argon?.weeklyFraction, 0.66)
  assert.equal(stored.quotas.google?.weeklyFraction, 0.42)
})

test('accounts without Argon access carry no argon quota entry (UI hides the row)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-noargon-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('free-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.free', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  class FreeService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      return { email: 'free-user@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-10-20T12:00:00Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-10-23T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new FreeService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas, 'quota refresh succeeded')
  assert.equal(quotas.argon, undefined, 'no argon permission 鈫?no argon quota family')
  assert.equal(pool.getAccount(acc.id)!.quotas.argon, undefined, 'argon row must stay hidden for this account')
})

test('active 5h consumption in model discovery tightens coarse summary 5h quota', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-tighten-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('tighten-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.tighten', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  const now = Date.now()
  const active5hReset = new Date(now + 15 * 60_000).toISOString() // 15 mins away (active 5h consumption)
  const summary5hReset = new Date(now + 5 * 3600_000).toISOString() // 5 hours away
  const weeklyReset = new Date(now + 3 * 24 * 3600_000).toISOString()

  class TightenService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'tighten@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: summary5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: weeklyReset },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-3.8-flash': {
            displayName: 'Gemini 3.8 Flash',
            quotaInfo: { remainingFraction: 0.72, resetTime: active5hReset },
          },
        },
      } as never
    }
  }

  const svc = new TightenService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // Even though summary reported 1.0 (coarse), model discovery tightened it to 0.72!
  assert.equal(quotas.google?.remainingFraction, 0.72)
  assert.equal(quotas.google?.resetTime, active5hReset)
  // Weekly limit from summary is preserved.
  assert.equal(quotas.google?.weeklyFraction, 0.8)
  assert.equal(quotas.google?.weeklyResetTime, weeklyReset)
})

test('weekly-bound model discovery must not overwrite the 5h row (2026-10-22 report)', async () => {
  // Live evidence (daoxzeex@gmail.com, 2026-10-22 23:23):
  //   summary: gemini-5h 0.822 / reset +4h18m, gemini-weekly 0.174 / reset +2d2h
  //   fetchAvailableModels: every gemini model 0.1736 / reset == THE WEEKLY RESET
  // The models endpoint reports whichever window Google deems binding for that
  // account, WITHOUT labelling it. The old merge folded that number into the
  // family's 5h slot, so the GUI painted "5h 19% 路 weekly 19%" with the weekly
  // reset on BOTH rows 鈥?exactly the screenshot the user filed.
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-weeklymodels-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('weekly-models-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.weeklymodels', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  const now = Date.now()
  const SUMMARY_5H_RESET = new Date(now + (4 * 60 + 18) * 60_000).toISOString()
  const SUMMARY_WEEKLY_RESET = new Date(now + (2 * 24 + 2) * 3600_000).toISOString()
  const SUMMARY_5H = 0.82211393
  const WEEKLY = 0.17376757
  const MODEL_WEEKLY = 0.17361549

  class WeeklyModelsService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'weeklymodels@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: WEEKLY, resetTime: SUMMARY_WEEKLY_RESET },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: SUMMARY_5H, resetTime: SUMMARY_5H_RESET },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-3.8-flash-high': {
            displayName: 'Gemini 3.8 Flash (High)',
            quotaInfo: { remainingFraction: MODEL_WEEKLY, resetTime: SUMMARY_WEEKLY_RESET },
          },
          'gemini-3-flash': {
            displayName: 'Gemini 3 Flash',
            quotaInfo: { remainingFraction: MODEL_WEEKLY, resetTime: SUMMARY_WEEKLY_RESET },
          },
        },
      } as never
    }
  }

  const svc = new WeeklyModelsService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // 5h row: untouched by the weekly-shaped model data.
  assert.equal(quotas.google?.remainingFraction, SUMMARY_5H, '5h row keeps the 5h bucket')
  assert.equal(quotas.google?.resetTime, SUMMARY_5H_RESET, '5h row keeps the 5h reset (鈮?h out, not 2d)')
  // Weekly row: tightened to the fresher model-side weekly figure.
  assert.equal(quotas.google?.weeklyFraction, MODEL_WEEKLY, 'weekly row takes the model-side weekly value')
  assert.equal(quotas.google?.weeklyResetTime, SUMMARY_WEEKLY_RESET)
  // The two rows must never be identical in value AND reset 鈥?that is the bug.
  assert.notEqual(quotas.google?.remainingFraction, quotas.google?.weeklyFraction)
  assert.notEqual(quotas.google?.resetTime, quotas.google?.weeklyResetTime)
})

test('exhausted 5h bucket: per-model weekly-boundary remaining lands on the WEEKLY row, not 5h', async () => {
  // 2026-10-17 00:37 incident: the coarse summary reported the meaningless
  // placeholder "100%, resets in now+5h" while the account was actually down
  // to 4.06% 鈥?every model row carried that remaining with the NEXT reset at
  // the weekly boundary, 14.5 hours out.
  //
  // 2026-10-22 correction: that per-model number IS the weekly bucket (its
  // reset is the weekly reset), so it belongs on the weekly row. Folding it
  // into the 5h row made both rows print the same percentage and the same
  // reset (the filed screenshot). The account still reads as dry, because the
  // weekly row is what drives eligibility (LOW_QUOTA_WEEKLY = 5%).
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-weeklytighten-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('weekly-tighten-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.weeklytighten', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  const now = Date.now()
  const summary5hReset = new Date(now + 5 * 3600_000).toISOString() // the "now+5h" placeholder
  const weeklyBoundaryReset = new Date(now + 14.5 * 3600_000).toISOString() // 14.5h out 鈥?beyond the old 6h gate
  const REAL_REMAINING = 0.040659066

  class WeeklyTightenService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'weeklytighten@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: summary5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: REAL_REMAINING, resetTime: weeklyBoundaryReset },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-3.8-flash-tiered': {
            displayName: 'gemini-3.8-flash-tiered',
            quotaInfo: { remainingFraction: REAL_REMAINING, resetTime: weeklyBoundaryReset },
          },
          'gemini-3.6-flash-high': {
            displayName: 'Gemini 3.6 Flash (High)',
            quotaInfo: { remainingFraction: REAL_REMAINING, resetTime: weeklyBoundaryReset },
          },
        },
      } as never
    }
  }

  const svc = new WeeklyTightenService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // The weekly row carries the real remaining and its weekly-boundary reset,
  // even though that reset sits beyond the old 6-hour gate.
  assert.equal(quotas.google?.weeklyFraction, REAL_REMAINING)
  assert.equal(quotas.google?.weeklyResetTime, weeklyBoundaryReset)
  // The 5h row is NOT rewritten from the weekly reading any more.
  assert.equal(quotas.google?.remainingFraction, 1, '5h placeholder stays on the 5h row')
  assert.equal(quotas.google?.resetTime, summary5hReset)
  // The account is still treated as dry 鈥?the weekly row is what excludes it.
  const refreshed = pool.getAccount(acc.id)!
  assert.equal(refreshed.quotas.google?.weeklyFraction, REAL_REMAINING)
  assert.equal(pool.isAccountEligible(refreshed, 'google', now), false, 'a 4% weekly account is not usable')
})

test('primary account on Windows resolves email from durable store (.primary-credential.json) and rejects sibling logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-primary-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)!
  assert.ok(primary)

  // Secondary sibling account exists in the pool
  const sec = pool.createAccountSlot('sibling')
  pool.updateAccountQuotas(sec.id, {}, 'sibling@example.com')

  // Durable store has the verified primary email
  writePrimaryCredential(
    {
      raw: JSON.stringify({ token: { access_token: 'ya29.primary', refresh_token: '1//prim', expiry: new Date(Date.now() + 3600_000).toISOString() } }),
      email: 'primary@example.com',
      savedAt: Date.now(),
    },
    dir,
  )

  // Write a log file that contains the sibling's email to simulate sibling agy runs
  const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'cli-20261017_120000.log'),
    'OAuth: authenticated successfully as sibling@example.com\n',
    'utf8',
  )

  class PrimaryTestService extends QuotaService {
    override async fetchUserInfo() {
      return null
    }
    override async fetchQuotaSummary() {
      return { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: '2026-10-17T12:00:00Z' }] }] } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new PrimaryTestService(pool)
  await svc.refreshAccountQuota(primary, false)

  const updated = pool.getAccount(primary.id)!
  if (process.platform === 'win32') {
    assert.equal(updated.email, 'primary@example.com', 'primary resolves email from .primary-credential.json on Windows')
  } else {
    assert.notEqual(updated.email, 'sibling@example.com', 'primary never adopts sibling email from logs')
  }
})

test('normalizeLegacyPrimary self-heals primary account email from .primary-credential.json on Windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-selfheal-'))
  writePrimaryCredential(
    {
      raw: JSON.stringify({ token: { access_token: 'ya29.primary', refresh_token: '1//prim' } }),
      email: 'g98@example.com',
      savedAt: Date.now(),
    },
    dir,
  )

  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)!
  assert.ok(primary)
  if (process.platform === 'win32') {
    assert.equal(primary.email, 'g98@example.com', 'primary email self-heals from durable store on Windows')
  }
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

test('stale 5h summary placeholder with 100% and now+5h is replaced by live model quota (#48)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-stale5h-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('stale5h-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.stale5h', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  const now = Date.now()
  const stale5hReset = new Date(now + 5 * 3600_000).toISOString()
  const liveActiveReset = '2026-10-18T21:14:37Z'

  class StaleService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'stale@example.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: stale5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.92, resetTime: '2026-10-24T11:11:37Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-2.5-flash': {
            displayName: 'Gemini 2.5 Flash',
            quotaInfo: {
              remainingFraction: 0.9711094,
              resetTime: liveActiveReset,
            },
          },
        },
      } as never
    }
  }

  const svc = new StaleService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // Stale 1.0 / now+5h was replaced by live model fraction (0.9711094) and live reset time!
  assert.equal(quotas.google?.remainingFraction, 0.9711094)
  assert.equal(quotas.google?.resetTime, liveActiveReset)
  assert.equal(quotas.google?.weeklyFraction, 0.92)
  assert.equal(quotas.google?.weeklyResetTime, '2026-10-24T11:11:37Z')
})

test('fetchUserQuota integrates /v1internal:retrieveUserQuota per-model buckets (#48)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-retrieve-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('retrieve-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.retrieve', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  const now = Date.now()
  const stale5hReset = new Date(now + 5 * 3600_000).toISOString()
  const activeReset = '2026-10-18T21:14:37Z'

  class RetrieveService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'ret@example.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: stale5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.92, resetTime: '2026-10-24T11:11:37Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      // Empty model catalog from models endpoint
      return { models: {} } as never
    }
    override async fetchUserQuota() {
      // retrieveUserQuota returns the 12 gemini buckets
      return {
        buckets: [
          {
            modelId: 'gemini-2.5-flash',
            tokenType: 'WTUS',
            remainingFraction: 0.9711094,
            resetTime: activeReset,
          },
        ],
      }
    }
  }

  const svc = new RetrieveService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  assert.equal(quotas.google?.remainingFraction, 0.9711094)
  assert.equal(quotas.google?.resetTime, activeReset)
  assert.equal(quotas.google?.models?.length, 1)
  assert.equal(quotas.google?.models?.[0]?.modelId, 'gemini-2.5-flash')
})

test('Argon model quota populates weeklyFraction when summary has no weekly argon group (#46)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-argonmodel-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('argon-model-user')

  const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({ access_token: 'ya29.argonmodel', expiry: Date.now() + 3600_000 }),
    'utf8',
  )

  class ArgonModelService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'argonmodel@example.com' }
    }
    override async fetchQuotaSummary() {
      // Only plain Gemini in summary; Argon is missing from summary
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-20T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaInfo: {
              remainingFraction: 0.85,
              resetTime: '2026-10-25T12:00:00Z',
            },
          },
        },
      } as never
    }
  }

  const svc = new ArgonModelService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  assert.ok(quotas.argon, 'argon family should be discovered from models')
  assert.equal(quotas.argon?.weeklyFraction, 0.85, 'Argon weeklyFraction should be populated from model quota')
  assert.equal(quotas.argon?.weeklyResetTime, '2026-10-25T12:00:00Z')
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
  const dir = mkdtempSync(join(tmpdir(), 'agy-ua-'))
  const pool = new AccountPoolManager(dir)
  const quota = new QuotaService(pool, () => '', () => '1.4.5')
  assert.ok(quota instanceof QuotaService)
})

test('pickFamilyQuota drops a dead last-known-good row when the summary is authoritative', () => {
  // Real incident: an account upgraded Pro 鈫?Ultra. The backend then stopped
  // returning the separate `Gemini 4 Argon` group (its quota is folded into the
  // Gemini bucket) while `fetchAvailableModels` kept listing the argon models
  // with a fresh 100%. Keeping last-known-good froze the previous tier's window
  // on screen: 0%, and a reset time two days in the past relative to the new one.
  const staleArgon: import('../src/common/pool-types.ts').FamilyQuotaInfo = {
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

test('shouldReleaseOrphanedCooldown never fires for an account that never had an Argon bucket', () => {
  // Reviewer-reported regression: the first draft cleared the argon cooldown on
  // every authoritative poll that lacked the group 鈥?true for free-tier and every
  // non-Pro account, whose argon cooldowns come from real 429s. Clearing those
  // every 60s silently disabled the cooldown mechanism for that family.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true,
    groupPresent: false,
    groupSeenBefore: false,   // never reported a dedicated bucket
    hasCooldown: true,
  }), false)

  // The genuine Pro -> Ultra transition: the account used to report the bucket.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true,
    groupPresent: false,
    groupSeenBefore: true,
    hasCooldown: true,
  }), true)

  // Still reported -> nothing to release.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true, groupPresent: true, groupSeenBefore: true, hasCooldown: true,
  }), false)

  // No cooldown to release -> no pointless persist().
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true, groupPresent: false, groupSeenBefore: true, hasCooldown: false,
  }), false)

  // Failed/empty summary carries no authority over a family that is missing.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: false, groupPresent: false, groupSeenBefore: true, hasCooldown: true,
  }), false)
})


test('sameCredentialGrant proves a shared grant through the refresh token, never a rotating access token', () => {
  const a = { accessToken: 'ya29.A1', refreshToken: '1//GRANT_A' }
  const b = { accessToken: 'ya29.A2', refreshToken: '1//GRANT_A' }
  assert.equal(sameCredentialGrant(a, b), true, 'a rotated access token must still name the same grant')

  const other = { accessToken: 'ya29.B1', refreshToken: '1//GRANT_B' }
  assert.equal(sameCredentialGrant(a, other), false, 'different refresh tokens are different accounts')

  // Mixed shapes cannot be proven equal: one side identifying by refresh token
  // and the other only by access token must NOT be treated as a match.
  const accessOnly = { accessToken: 'ya29.A1' }
  assert.equal(sameCredentialGrant(a, accessOnly), false, 'unprovable pairs must fail closed')
  assert.equal(sameCredentialGrant(accessOnly, { accessToken: 'ya29.A1' }), true, 'access tokens are usable when neither side has a refresh token')

  assert.equal(sameCredentialGrant(null, a), false, 'an absent slot credential never matches')
  assert.equal(sameCredentialGrant(undefined, undefined), false)
})

test('REGRESSION: isolated pool accounts never consult the CLI nor pay a keystore read', async () => {
  // 2026-10-26: every pool row displayed the slot owner's numbers with identical
  // reset instants. gy reads the OS keystore before the per-HOME token file,
  // so the CLI can only ever answer for the account that owns that store — the
  // system login. Isolated accounts must therefore never spawn it, and the
  // rejection must not even read the keystore (four PowerShell cold starts per
  // poll would make the pool needlessly slow).
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-cliiso-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('isolated')
  let keystoreReads = 0
  class CountingService extends QuotaService {
    override async readSystemKeychainToken() {
      keystoreReads++
      return { accessToken: 'ya29.owner', refreshToken: '1//OWNER' }
    }
  }
  const svc = new CountingService(pool, () => '', () => null, { bin: () => 'agy' })
  const read = (
    svc as unknown as { readCliUsageFamilies(a: unknown): Promise<unknown> }
  ).readCliUsageFamilies.bind(svc)
  assert.equal(await read(acc), null, 'an isolated account must fall back to the REST path')
  assert.equal(keystoreReads, 0, 'the fast reject must not touch the keystore')
})

test('the CLI is refused for the primary while the slot carries another grant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-cliguard-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)
  assert.ok(primary, 'bootstrap default primary exists')

  const build = (slot: { refreshToken: string }, own: { refreshToken: string }) => {
    class Guarded extends QuotaService {
      override async readSystemKeychainToken() {
        return { accessToken: 'ya29.' + slot.refreshToken, ...slot }
      }
      override async getStoredToken() {
        return { accessToken: 'ya29.' + own.refreshToken, ...own }
      }
    }
    return new Guarded(pool, () => '', () => null, { bin: () => 'agy' }) as unknown as {
      cliSlotHoldsAccount(a: unknown): Promise<boolean>
    }
  }

  assert.equal(
    await build({ refreshToken: '1//OTHER' }, { refreshToken: '1//PRIMARY' }).cliSlotHoldsAccount(primary),
    false,
    'a handed-over slot belongs to a secondary; its numbers must not land on the primary',
  )
  assert.equal(
    await build({ refreshToken: '1//PRIMARY' }, { refreshToken: '1//PRIMARY' }).cliSlotHoldsAccount(primary),
    true,
    'the owner is allowed to read Argon through the CLI',
  )
})
