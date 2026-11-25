// Regression coverage for the false "需重新登录" quarantine (2026-10-16).
//
// A transient network blip made agy's keyring auth miss its hard 10s window;
// agy then printed the SAME 939-byte "Authentication required" banner a real
// sign-out prints, DSH classified the run AUTH and sticky-quarantined three
// healthy accounts. The stderr banner is byte-identical in both cases — agy's
// own per-run log is the only signal that separates them.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  Err,
  isAuthoritativeAuthError,
  looksLikeAuthFailure,
  looksLikeAuthVerificationJitter,
  looksLikeNetworkError,
} from '../../src/common/types.ts'
import { AUTH_CONFIRM_STRIKES } from '../../src/common/pool-types.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { readAgyRunLogText, snapshotAgyLogs } from '../../src/host/agy-log.ts'
import { mkdirSync, writeFileSync } from 'node:fs'

// ---- fixtures: verbatim line shapes observed in real agy 1.4.0 logs -------

const JITTER_LOG = [
  'I1016 17:29:16.281503       1 printmode.go:403] Print mode: not authenticated, trying silent auth',
  'I1016 17:29:16.708947     291 keyring.go:64] keyringAuth: loaded token, expiry=2026-10-16 09:38:48.745 +0000 UTC expired=false',
  'W1016 17:29:26.284604       1 keyring.go:111] keyringAuth: timed out after 10s, skipping keyring auth',
  'I1016 17:29:26.284725       1 printmode.go:409] Print mode: silent auth failed',
  'I1016 17:29:26.284771       1 printmode.go:426] Print mode: triggering interactive OAuth',
  'W1016 17:29:46.728586     291 keyring.go:93] keyringAuth: failed to fetch user info: userinfo request failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": dial tcp 172.217.113.4:443: i/o timeout',
].join('\n')

const SIGNOUT_LOG = [
  'I1016 18:00:44.790291       1 printmode.go:403] Print mode: not authenticated, trying silent auth',
  'I1016 18:00:44.819094       1 printmode.go:409] Print mode: silent auth failed',
  'I1016 18:00:44.819171       1 printmode.go:426] Print mode: triggering interactive OAuth',
  'E1016 18:01:44.821321       1 printmode.go:476] Print mode: auth timed out',
].join('\n')

// ---- classifier ------------------------------------------------------------

test('looksLikeAuthVerificationJitter: keyring timeout / userinfo transport failure ⇒ jitter', () => {
  assert.equal(looksLikeAuthVerificationJitter(JITTER_LOG), true, 'the exact live evidence must read as jitter')
  assert.equal(looksLikeAuthVerificationJitter('keyringAuth: timed out after 10s, skipping keyring auth'), true)
  assert.equal(looksLikeAuthVerificationJitter('keyringAuth: failed to fetch user info: userinfo request failed: dial tcp 1.2.3.4:443: i/o timeout'), true)
})

test('looksLikeAuthVerificationJitter: genuine sign-out log (no keyring activity) is NOT jitter', () => {
  assert.equal(looksLikeAuthVerificationJitter(SIGNOUT_LOG), false)
  assert.equal(looksLikeAuthVerificationJitter(''), false)
})

test('looksLikeAuthVerificationJitter: an authoritative token error always wins over jitter', () => {
  // A revoked refresh token that ALSO hit a blip must still be a sign-out.
  assert.equal(looksLikeAuthVerificationJitter(JITTER_LOG + '\nkeyring.go:120] token refresh failed: oauth2: invalid_grant'), false)
  assert.equal(isAuthoritativeAuthError('oauth2: invalid_grant: Token has been expired or revoked'), true)
})

test('looksLikeAuthVerificationJitter ignores the generic banner text alone', () => {
  // stderr carries exactly this and it is byte-identical in both cases.
  assert.equal(looksLikeAuthVerificationJitter('Authentication required. Please visit the URL to log in:'), false)
})

// ---- log reader ------------------------------------------------------------

test('readAgyRunLogText only returns log files created by this run', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-log-jitter-'))
  const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(join(logDir, 'cli-20261016_000001.log'), 'stale previous run')

  const before = snapshotAgyLogs(home)
  assert.equal(readAgyRunLogText(home, before), '', 'no new file yet ⇒ no evidence')

  writeFileSync(join(logDir, 'cli-20261016_000002.log'), JITTER_LOG)
  const text = readAgyRunLogText(home, before)
  assert.ok(text.includes('keyringAuth: timed out after 10s'), text)
  assert.ok(!text.includes('stale previous run'))
})

// ---- sticky-quarantine confirmation gate -----------------------------------

test('noteAuthFailure: a single ambiguous AUTH must NOT hard-quarantine an account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-auth-strike-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('Ambiguous')

  const quarantined = pool.noteAuthFailure(acc.id, 'agy is not signed in — run /agy auth to login')
  assert.equal(quarantined, false, 'first strike ⇒ rotate away, do not quarantine')
  assert.equal(pool.getAccount(acc.id)!.authRequired, undefined, 'no sticky 需重新登录 badge')

  // Second independent confirmation ⇒ quarantine.
  assert.equal(pool.noteAuthFailure(acc.id, 'agy is not signed in'), true)
  assert.equal(pool.getAccount(acc.id)!.authRequired, true)
})

test('noteAuthFailure: a success resets the confirmation streak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-auth-streak-reset-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('Recovers')

  pool.noteAuthFailure(acc.id, 'agy is not signed in')
  pool.recordSuccess(acc.id, 'google')
  assert.equal(pool.noteAuthFailure(acc.id, 'agy is not signed in'), false, 'success must clear the streak')
  assert.equal(pool.getAccount(acc.id)!.authRequired, undefined)

  // ...and the streak counts from zero again, so the NEXT failure confirms.
  assert.equal(pool.noteAuthFailure(acc.id, 'agy is not signed in'), true)
  assert.equal(pool.getAccount(acc.id)!.authRequired, true)
})

test('AUTH_CONFIRM_STRIKES stays at 2', () => {
  assert.equal(AUTH_CONFIRM_STRIKES, 2)
})

test('markAuthRequired keeps its immediate, authoritative semantics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-auth-authoritative-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('Revoked')
  pool.markAuthRequired(acc.id, 'invalid_grant: Token has been expired or revoked')
  assert.equal(pool.getAccount(acc.id)!.authRequired, true, 'the direct OAuth path must still quarantine on first sight')
})

test('incidental "disabled" log lines never poison looksLikeAuthVerificationJitter or isAuthoritativeAuthError', () => {
  assert.equal(isAuthoritativeAuthError('I1016 main.go:42] auto-update disabled; telemetry disabled'), false)
  assert.equal(
    looksLikeAuthVerificationJitter('I1016 main.go:42] auto-update disabled\n' + JITTER_LOG),
    true,
    'benign "disabled" config log must not short-circuit keyring jitter detection',
  )
  assert.equal(isAuthoritativeAuthError('oauth2: account_disabled'), true)
  assert.equal(isAuthoritativeAuthError('PERMISSION_DENIED: TOS_VIOLATION'), true)
})

test('looksLikeNetworkError covers HTTP/2 stream drops, proxy 502/504/522, and TLS resets', () => {
  assert.equal(looksLikeNetworkError('http2: client connection lost'), true)
  assert.equal(looksLikeNetworkError('stream error: stream ID 3; REFUSED_STREAM'), true)
  assert.equal(looksLikeNetworkError('502 Bad Gateway from upstream proxy'), true)
  assert.equal(looksLikeNetworkError('504 Gateway Time-out'), true)
  assert.equal(looksLikeNetworkError('HTTP 522 Cloudflare connection timed out'), true)
  assert.equal(looksLikeNetworkError('local error: tls: bad record mac'), true)
  assert.equal(looksLikeNetworkError('write tcp: broken pipe'), true)
})

test('looksLikeAuthFailure ignores third-party MCP server auth errors', () => {
  assert.equal(looksLikeAuthFailure('MCP server "github": authentication required'), false)
  assert.equal(looksLikeAuthFailure('[mcp] linear tool failed: authentication failed (401)'), false)
  assert.equal(looksLikeAuthFailure('Authentication required. Please sign in to Antigravity.'), true)
})

test('readAgyRunLogText captures bytes appended to a same-second cli-*.log file', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-log-samesec-'))
  const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  const sameSecFile = join(logDir, 'cli-20261118_120000.log')
  writeFileSync(sameSecFile, 'first run prefix\n')

  const before = snapshotAgyLogs(home)
  writeFileSync(sameSecFile, 'first run prefix\n' + JITTER_LOG)
  const text = readAgyRunLogText(home, before)
  assert.ok(text.includes('keyringAuth: timed out after 10s'), 'must read appended bytes on same-second collision')
  assert.ok(!text.includes('first run prefix'), 'must not re-read pre-snapshot bytes')
})
