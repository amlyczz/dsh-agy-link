// Regression tests: "needs re-login" flagging must only fire on
// authoritative OAuth states (never on transport noise), and flagged
// accounts must self-heal via the background re-verification cadence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldMarkAuthRequired, looksLikeNetworkError, looksLikeAuthVerificationJitter, isTransportFailure, isAuthoritativeAuthError } from '../../src/common/types.ts'
import { AUTH_REVERIFY_DELAY_MS, needsAuthReverify, isTerminalAuthError, type ManagedAccount } from '../../src/common/pool-types.ts'
import { accountAuthState, isAccountCriticalAuth } from '../../src/common/quota-bench.ts'

const NETWORK_BLIP = 'Post "https://oauth2.googleapis.com/token": dial tcp 172.217.113.4:443: i/o timeout'

test('looksLikeNetworkError recognises transport noise only', () => {
  assert.equal(looksLikeNetworkError(NETWORK_BLIP), true)
  assert.equal(looksLikeNetworkError('fetch failed'), true)
  assert.equal(looksLikeNetworkError('token endpoint 400: invalid_grant'), false)
  assert.equal(looksLikeNetworkError('Please sign in'), false)
})

test('isAuthoritativeAuthError requires a real OAuth error code', () => {
  assert.equal(isAuthoritativeAuthError('token endpoint 400: invalid_grant — Token expired'), true)
  assert.equal(isAuthoritativeAuthError('token endpoint 401: invalid_client'), true)
  assert.equal(isAuthoritativeAuthError('token endpoint 400: unknown error'), false)
  assert.equal(isAuthoritativeAuthError('token endpoint 500: server error'), false)
})

test('shouldMarkAuthRequired: transport noise never flags, even with code AUTH', () => {
  // The old /auth/i substring test flagged accounts for this exact message.
  assert.equal(shouldMarkAuthRequired(undefined, NETWORK_BLIP), false)
  assert.equal(shouldMarkAuthRequired('AUTH', NETWORK_BLIP), false)
})

test('shouldMarkAuthRequired: authoritative states still flag', () => {
  assert.equal(shouldMarkAuthRequired('AUTH', 'agy is not signed in'), true)
  assert.equal(shouldMarkAuthRequired(undefined, 'token endpoint 400: invalid_grant — expired'), true)
  assert.equal(shouldMarkAuthRequired(undefined, 'refresh failed: unauthorized_client'), true)
  // Bare 400 without an OAuth error code: not authoritative.
  assert.equal(shouldMarkAuthRequired(undefined, 'token endpoint 400: unknown error'), false)
})

test('issue #114: a TOS terminal ban never re-enters background polling', () => {
  const base = { id: 'a', alias: 'a', dir: '', enabled: true, cooldowns: {}, quotas: {} } as ManagedAccount
  const tos = { ...base, authRequired: true, authError: 'HTTP 403: TOS_VIOLATION ... Appeal: https://forms.gle/x' }
  assert.equal(isTerminalAuthError(tos.authError), true)
  assert.equal(isTerminalAuthError('invalid_grant: token expired'), false)
  assert.equal(isTerminalAuthError(undefined), false)
  assert.equal(
    needsAuthReverify({ ...tos, authMarkedAt: Date.now() - AUTH_REVERIFY_DELAY_MS - 1 }),
    false,
    'a terminal ban is not a transient auth failure; do not retry it every 10 minutes',
  )
  assert.equal(
    needsAuthReverify({ ...base, authRequired: true, authError: 'invalid_grant', authMarkedAt: Date.now() - AUTH_REVERIFY_DELAY_MS - 1 }),
    true,
    'ordinary auth failures still self-heal',
  )
})

test('needsAuthReverify: flagged accounts re-enter the poll once the flag is stale', () => {
  const base = { id: 'a', alias: 'a', dir: '', enabled: true, cooldowns: {}, quotas: {} } as ManagedAccount
  assert.equal(needsAuthReverify(base), false, 'unflagged → never')
  assert.equal(needsAuthReverify({ ...base, authRequired: true }), true, 'legacy flag without timestamp → re-verify')
  assert.equal(
    needsAuthReverify({ ...base, authRequired: true, authMarkedAt: Date.now() - 1000 }),
    false,
    'fresh flag → wait',
  )
  assert.equal(
    needsAuthReverify({ ...base, authRequired: true, authMarkedAt: Date.now() - AUTH_REVERIFY_DELAY_MS - 1 }),
    true,
    'stale flag → re-verify',
  )
  assert.equal(AUTH_REVERIFY_DELAY_MS, 10 * 60_000)
})

test('isTransportFailure: a proxy blip logged in the agy run log is NETWORK, not AUTH (issue #71)', () => {
  // Verbatim shape from agy 1.4.12 while the system proxy flapped: the token
  // was still valid, agy failed to validate it over the network, then gave up.
  const agyLog = [
    'keyringAuth: loaded token, expiry=2026-11-05 00:03:38 expired=false',
    'token refresh failed due to network error: Post "https://oauth2.googleapis.com/token": EOF',
    'keyringAuth: token validation failed due to network error (token may still be valid): Post "…/token": EOF',
    'Print mode: silent auth failed',
  ].join('\n')
  const banner = 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login'

  // The two regexes disagree on this log, which is exactly why the run log must
  // reach BOTH: the wide net matches, the narrow jitter set does not.
  assert.equal(looksLikeAuthVerificationJitter(agyLog), false)
  assert.equal(looksLikeNetworkError(banner), false)

  assert.equal(isTransportFailure({ rawErrText: banner, runLogText: agyLog }), true, 'proxy blip must be retried as NETWORK')
  // A genuine sign-out with no transport evidence stays AUTH-side.
  assert.equal(isTransportFailure({ rawErrText: banner, runLogText: 'keyringAuth: no token found' }), false)
  // The narrow keyring-jitter path still short-circuits when it does match.
  assert.equal(
    isTransportFailure({ rawErrText: banner, runLogText: 'keyringAuth: timed out after 30s' }),
    true,
  )
})

test('accountAuthState: the badge must name the KIND of problem, not just "auth"', () => {
  const base = { id: 'a', alias: 'a', dir: '', enabled: true, cooldowns: {}, quotas: {} } as ManagedAccount
  assert.equal(accountAuthState(base), 'healthy')
  assert.equal(accountAuthState({ ...base, authRequired: true, authError: 'token endpoint 400: invalid_grant' }), 'relogin')
  assert.equal(accountAuthState({ ...base, authRequired: true, authError: 'agy is not signed in' }), 'review')
  assert.equal(accountAuthState({ ...base, authRequired: true, authError: 'TOS_VIOLATION (https://forms.gle/x)' }), 'tos')
  assert.equal(accountAuthState({ ...base, authRequired: true, authError: 'VALIDATION_REQUIRED' }), 'validation')
  assert.equal(accountAuthState({ ...base, quotaUnavailable: { reason: 'validation_required', since: 1, retryAfter: 2 } }), 'validation')
  assert.equal(accountAuthState({ ...base, quotaUnavailable: { reason: 'tos_violation', since: 1, retryAfter: 2 } }), 'tos')
  // An unverified flag still blocks rotation — only the badge softens.
  assert.equal(isAccountCriticalAuth({ ...base, authRequired: true, authError: 'agy is not signed in' }), true)
  assert.equal(isAccountCriticalAuth(base), false)
})
