// Which account a quota read actually belongs to: Keychain-versus-disk
// precedence, the durable primary credential, agy log email detection, and
// the manual/background refresh identity paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { QuotaService, detectEmailFromAgyLogs } from '../../../src/host/quota.ts'
import { writePrimaryCredential } from '../../../src/host/credential-slot.ts'
import { makeTempPool, writeAccountToken, writeAgyLog } from './quota-fixtures.ts'

test('manual force refresh re-anchors slot identity from the token, not the label (primary showed another account\'s quota)', async () => {
  // Real incident: the system token belonged to elegantmanco@gmail.com but
  // the slot still said q986465568@gmail.com (log scraping returned the
  // stale label), so 鍒锋柊/鍚屾 fetched elegantmanco's quota and displayed
  // it as the primary's values. Manual refresh must trust the TOKEN (via
  // userinfo) over both the stored label and log detection.
  const { dir, pool } = makeTempPool('agy-quota-force-')
  const acc = pool.createAccountSlot('force-sync')
  // Slot currently labeled with the OLD account.
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5, weeklyFraction: 0.5 } }, 'q986465568@gmail.com')

  // Token on disk is valid, so no refresh-token flow kicks in.
  writeAccountToken(acc.dir!, 'ya29.tok_of_elegantmanco')

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
  const { dir, pool } = makeTempPool('agy-quota-bg-')
  const acc = pool.createAccountSlot('bg-poll')
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5 } }, 'stable@gmail.com')

  writeAccountToken(acc.dir!, 'ya29.stable')

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
  const { dir, pool } = makeTempPool('agy-quota-kc-')
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
  const { dir, pool } = makeTempPool('agy-quota-iso-')
  const acc = pool.createAccountSlot('isolated')
  writeAccountToken(acc.dir!, 'ya29.isolated_own')
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
  writeAgyLog(dir, 'cli-20260827_100000.log', [
    'OAuth: authenticated successfully as old.account@google.com\n',
    '...hours pass...\n',
    'OAuth: authenticated successfully as new.account@google.com\n',
  ].join(''))
  assert.equal(detectEmailFromAgyLogs(dir), 'new.account@google.com')
})

test('detectEmailFromAgyLogs extracts user email from agy log files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-test-'))
  writeAgyLog(dir, 'cli-20260820_120000.log', [
    'ERROR: logging before google.Init: OAuth: authenticated successfully as dev.user@google.com\n',
  ].join(''))
  const email = detectEmailFromAgyLogs(dir)
  assert.equal(email, 'dev.user@google.com')
})

test('readSystemKeychainToken dispatches per platform (GH #8 / GH #30)', async () => {
  const { readLinuxSecretToken, readMacKeychainToken, readWindowsCredentialToken } = await import('../../../src/host/quota.ts')
  // Both readers are hard platform gates - safe to call off their target platform.
  if (process.platform !== 'darwin') assert.equal(await readMacKeychainToken(), null, 'mac reader no-ops off darwin')
  if (process.platform !== 'linux') assert.equal(await readLinuxSecretToken(), null, 'linux reader no-ops off linux')
  if (process.platform !== 'win32') assert.equal(await readWindowsCredentialToken(), null, 'windows reader no-ops off win32')

  // A subclass mirroring the production dispatch resolves without throwing.
  // In tests, mock the native keychain reader so macOS SecurityAgent never triggers a desktop password prompt.
  class DispatchProbe extends QuotaService {
    override async readSystemKeychainToken() {
      if (process.platform === 'linux') return readLinuxSecretToken()
      if (process.platform === 'darwin') return { accessToken: 'ya29.mock_mac_kc', refreshToken: '1//mock_refresh' }
      if (process.platform === 'win32') return readWindowsCredentialToken()
      return null
    }
  }
  const { dir, pool } = makeTempPool('agy-quota-dispatch-')
  const primary = pool.createAccountSlot('primary')
  primary.systemHome = true
  const svc = new DispatchProbe(pool)
  const tok = await svc.getStoredToken(primary)
  assert.ok(tok === null || typeof tok.accessToken === 'string', 'dispatch resolves without throwing')
})

test('primary account on Windows resolves email from durable store (.primary-credential.json) and rejects sibling logs', async () => {
  const { dir, pool } = makeTempPool('agy-quota-primary-')
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
  writeAgyLog(dir, 'cli-20261017_120000.log', [
    'OAuth: authenticated successfully as sibling@example.com\n',
  ].join(''))

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

test('getValidAccessToken returns null instead of an already-expired accessToken when refresh fails on network', async () => {
  const { getValidAccessToken } = await import('../../../src/features/quota/token.ts')
  const { dir, pool } = makeTempPool('agy-expired-tok-')
  const acc = pool.createAccountSlot('expired-net')
  const tokenFile = join(acc.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  mkdirSync(join(acc.dir, '.gemini', 'antigravity-cli'), { recursive: true })
  const raw = JSON.stringify({
    token: {
      access_token: 'ya29.already_expired',
      refresh_token: '1//valid_grant',
      expiry: new Date(Date.now() - 120_000).toISOString(),
    },
  })
  writeFileSync(tokenFile, raw)

  const tok = await getValidAccessToken(
    {
      pool,
      // Dead loopback proxy forces refreshTokens() to fail with transport error
      proxyFor: () => 'http://127.0.0.1:1',
      readSystemKeychainToken: async () => null,
      getStoredToken: async () => ({
        accessToken: 'ya29.already_expired',
        refreshToken: '1//valid_grant',
        expiryMs: Date.now() - 120_000,
      }),
      persistRefreshedToken: () => {},
      readPrimaryCredential: () => null,
      writePrimaryCredential: () => false,
      parseCredentialDoc: () => ({ refreshToken: '1//valid_grant' }),
    },
    acc,
    new Map(),
  )
  assert.equal(tok, null, 'must not return an already-expired accessToken after refresh failure')
  assert.equal(pool.getAccount(acc.id)?.authRequired, undefined, 'transport failure must not mark authRequired')
})
