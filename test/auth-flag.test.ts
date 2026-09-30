// Regression tests: "needs re-login" flagging must only fire on
// authoritative OAuth states (never on transport noise), and flagged
// accounts must self-heal via the background re-verification cadence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldMarkAuthRequired, looksLikeNetworkError, isAuthoritativeAuthError } from '../src/common/types.ts'
import { AUTH_REVERIFY_DELAY_MS, needsAuthReverify, type ManagedAccount } from '../src/common/pool-types.ts'

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
