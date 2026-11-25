// Quota token plumbing: the on-disk and Keychain credential formats agy
// actually writes, token persistence across refreshes, and credential
// grant identity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { QuotaService, normalizeStoredToken, sameCredentialGrant } from '../../../src/host/quota.ts'
import { writeAgyTokenFile, parsePastedCode, generatePkce } from '../../../src/host/oauth.ts'
import { parseCredentialDoc } from '../../../src/host/credential-slot.ts'
import { makeTempPool, writeAccountToken } from './quota-fixtures.ts'

test('persistRefreshedToken keeps the refresh token and writes agy nested shape', () => {
  // Regression: the writer used to emit a flat `{access_token,expiry}` document
  // when the file did not exist yet, DROPPING the refresh token. A credential
  // without a refresh token has no stable identity, so the corruption guards
  // (which compare grants) could never fire.
  const { dir, pool } = makeTempPool('agy-persist-')
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
  const { dir, pool } = makeTempPool('agy-quota-test-')
  // Primary rides the system HOME (Keychain); token files only exist for
  // isolated secondary accounts 鈥?exercise those.
  const acc = pool.createAccountSlot('quota-test')

  writeAccountToken(acc.dir, 'fake_access_token_123', { refreshToken: 'fake_refresh_token_456' })

  const quota = new QuotaService(pool)
  const stored = await quota.getStoredToken(acc)
  assert.equal(stored?.accessToken, 'fake_access_token_123')
  assert.equal(stored?.refreshToken, 'fake_refresh_token_456')

  const validToken = await quota.getValidAccessToken(acc)
  assert.equal(validToken, 'fake_access_token_123')
})

test('a replaced account grant is no longer current for an in-flight quota refresh', () => {
  const { dir, pool } = makeTempPool('agy-quota-reauth-')
  const account = pool.createAccountSlot('backup')
  const quota = new QuotaService(pool)
  const isCurrent = (quota as unknown as {
    isCurrentAccountGrant: (a: unknown, refresh: string) => boolean
  }).isCurrentAccountGrant.bind(quota)
  writeAgyTokenFile(account.dir, { access_token: 'old', refresh_token: 'old-grant' })
  assert.equal(isCurrent(account, 'old-grant'), true)
  writeAgyTokenFile(account.dir, { access_token: 'new', refresh_token: 'new-grant' })
  assert.equal(isCurrent(account, 'old-grant'), false)
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
