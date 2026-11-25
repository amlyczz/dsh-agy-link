// Gate 2 must catch the "isolated account fell back to the machine-wide
// keyring" case, and must NOT quarantine when the only thing that failed was
// agy's own userinfo lookup on a flaky network.
//
// Live 2026-11-23 (session 8bade603): dao's ACP process logged
// `ChainedAuth: authenticated via keyring` and `applyAuthResult: email=`
// (empty, userinfo EOF) — the identity was never proven, the turn ran on the
// primary's credentials and died with an empty result.
// Live 2026-11-23 15:59: `keyringAuth: failed to fetch user info: ... EOF` +
// empty email is the SAME log shape, but the cause is transport: the token was
// fine, and the account wore a red 需重新登录 badge for an hour over nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyIdentity, readAuthEvidenceFromLog } from '../../../src/features/acp/identity.ts'
import { identityFailureKind } from '../../../src/features/acp/settle.ts'
import { looksLikeNetworkError, shouldMarkAuthRequired } from '../../../src/common/types.ts'

function withLog(text: string, fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agy-identity-'))
  try {
    const file = join(dir, 'agy.log')
    writeFileSync(file, text, 'utf8')
    fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('identity evidence: keyring fallback with an empty email is detected', () => {
  withLog(
    [
      'I1123 15:59:45.155 keyring.go:93] keyringAuth: failed to fetch user info: userinfo request failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": 401 Unauthorized',
      'I1123 15:59:45.156 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)',
      'I1123 15:59:45.156 server_oauth.go:221] applyAuthResult: email=, authMethod=consumer, quotaProject=',
    ].join('\n'),
    (file) => {
      const ev = readAuthEvidenceFromLog(file)
      assert.equal(ev.keyringFallback, true)
      assert.equal(ev.authSeen, true)
      assert.equal(ev.email, null)
      assert.equal(ev.userinfoTransportFailure, false, 'a 401 is not a transport failure')

      const wrong = classifyIdentity(ev, 'daoxzeex@gmail.com', true)
      assert.equal(wrong.kind, 'mismatch')
      assert.match(wrong.kind === 'mismatch' ? wrong.message : '', /without proving/)
      // The primary account (systemHome) legitimately uses the keyring.
      assert.equal(classifyIdentity(ev, 'primary@gmail.com', false).kind, 'ok')
    },
  )
})

test('identity evidence: a transport-failed userinfo lookup is NOT a wrong account', () => {
  // Exactly the 15:59 log: agy's keyring auth could not fetch the profile
  // because the network dropped, so it wrote an empty email. The token itself
  // was healthy — this must not quarantine the account.
  withLog(
    [
      'W1123 15:59:45.155 keyring.go:93] keyringAuth: failed to fetch user info: userinfo request failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF',
      'I1123 15:59:45.156 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)',
      'I1123 15:59:45.156 server_oauth.go:221] applyAuthResult: email=, authMethod=consumer, quotaProject=',
    ].join('\n'),
    (file) => {
      const ev = readAuthEvidenceFromLog(file)
      assert.equal(ev.userinfoTransportFailure, true)
      const verdict = classifyIdentity(ev, 'daoxzeex@gmail.com', true)
      assert.equal(verdict.kind, 'unproven')
      const message = verdict.kind === 'unproven' ? verdict.message : ''
      // The caller turns this into a retryable NETWORK failure; the message must
      // itself look like transport noise so no legacy AUTH gate can flag it.
      assert.match(message, /^ACP identity unproven:/)
      assert.equal(looksLikeNetworkError(message), true)
      // Belt and braces: even if a legacy path classified it AUTH, the transport
      // evidence in the message keeps it from quarantining the account.
      assert.equal(shouldMarkAuthRequired('AUTH', message), false)
      assert.equal(identityFailureKind(message), 'unproven')
      assert.equal(identityFailureKind('ACP identity mismatch: agy authenticated as x'), 'mismatch')
      assert.equal(identityFailureKind('agy exited with code 1'), null)
      assert.equal(classifyIdentity(ev, 'daoxzeex@gmail.com', false).kind, 'ok', 'the primary uses the keyring by design')
    },
  )
})

test('identity evidence: keyring + the CORRECT email is legitimate (macOS labels the slot this way)', () => {
  withLog(
    [
      'I1123 16:42:33.647 auth.go:157] ChainedAuth: authenticated via keyring (effective: keyring)',
      'I1123 16:42:33.647 server_oauth.go:221] applyAuthResult: email=daoxzeex@gmail.com, authMethod=consumer',
    ].join('\n'),
    (file) => {
      const ev = readAuthEvidenceFromLog(file)
      assert.equal(ev.keyringFallback, true)
      assert.equal(ev.email, 'daoxzeex@gmail.com')
      assert.equal(classifyIdentity(ev, 'daoxzeex@gmail.com', true).kind, 'ok')
    },
  )
})

test('identity evidence: a real isolated email is accepted, a different one is not', () => {
  withLog('I1123 15:39:34.019 server_oauth.go:221] applyAuthResult: email=elegantmanco@gmail.com, authMethod=consumer\n', (file) => {
    const ev = readAuthEvidenceFromLog(file)
    assert.equal(ev.email, 'elegantmanco@gmail.com')
    assert.equal(ev.keyringFallback, false)
    assert.equal(classifyIdentity(ev, 'elegantmanco@gmail.com', true).kind, 'ok')
    const wrong = classifyIdentity(ev, 'someone-else@gmail.com', true)
    assert.equal(wrong.kind, 'mismatch')
    assert.match(wrong.kind === 'mismatch' ? wrong.message : '', /authenticated as/)
  })
})

test('identity evidence: a log that names nobody is inconclusive, never a mismatch', () => {
  withLog('I1123 15:39:34.019 serve.go:30] Starting ACP server\n', (file) => {
    const ev = readAuthEvidenceFromLog(file)
    assert.equal(ev.authSeen, false)
    assert.equal(classifyIdentity(ev, 'daoxzeex@gmail.com', true).kind, 'unknown')
  })
})
