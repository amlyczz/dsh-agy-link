import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeRateLimit, looksLikeHardRateLimit, looksLikeEligibilityFailure, looksLikeNetworkError, shouldMarkAuthRequired, looksLikeContextWindowExceeded } from '../../src/common/types.ts'

// Captured verbatim from a real incident: a cortex tool / permission error
// that the old loose classifier (bare `429` / bare `rate limit`) sometimes saw
// alongside quota-ish words in stdout, misclassifying the whole run as a
// rate limit and freezing a healthy account with a ghost cooldown.
const REAL_TOOL_ERROR =
  'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /Users/zqy/Developer/academic-agent/frontend/src/components/landing/LandingNavbar.tsx is not a valid artifact path; artifacts must be in /Users/zqy/.dsh/agy-accounts/acc_1787217298501_cul90/.gemini/antigravity-cli/brain/f94449b8-3395-4b85-bdc1-cba6deeeee94/'

test('looksLikeHardRateLimit matches real server-issued quota signatures', () => {
  assert.equal(looksLikeHardRateLimit('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 21m25s.'), true)
  assert.equal(looksLikeHardRateLimit('Rate limit or quota reached'), true)
  assert.equal(looksLikeHardRateLimit('retry: attempt 2 failed (429: Too Many Requests)'), true)
  assert.equal(looksLikeHardRateLimit('You exceeded your quota. Try again after 2026-08-25T09:00:00Z.'), true)
})

test('looksLikeEligibilityFailure matches the live location refusal and the issue-32 wording', () => {
  // Captured verbatim from a live run: agy exits 3 with this envelope.
  assert.equal(
    looksLikeEligibilityFailure('FAILED_PRECONDITION (code 400): User location is not supported for the API use.'),
    true,
  )
  assert.equal(
    looksLikeEligibilityFailure('Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.'),
    true,
  )
  assert.equal(looksLikeEligibilityFailure('This service is not supported in your country'), true)
  // Unrelated transport / tool noise must NOT look like a region refusal.
  assert.equal(looksLikeEligibilityFailure('oauth2.googleapis.com: i/o timeout'), false)
  assert.equal(looksLikeEligibilityFailure('FAILED_PRECONDITION: workspace file locked'), false)
  assert.equal(
    looksLikeEligibilityFailure('declaring permissions: cortex tool write_to_file: invalid_args'),
    false,
  )
})

test('looksLikeHardRateLimit rejects incidental substrings and unrelated errors', () => {
  // Real incident text (tool/permission failure): must NOT be a rate limit.
  assert.equal(looksLikeHardRateLimit(REAL_TOOL_ERROR), false)
  // UUID/hash fragments that happen to contain 429.
  assert.equal(looksLikeHardRateLimit('conversation f94449b8-3395-4b85-bdc1-cba6deeeee94 not found'), false)
  // Model prose merely mentioning limits.
  assert.equal(looksLikeHardRateLimit('the API docs say rate limits may apply during peak hours'), false)
  assert.equal(looksLikeHardRateLimit(undefined), false)
  assert.equal(looksLikeHardRateLimit(''), false)
})

test('soft looksLikeRateLimit keeps capacity signals out of the hard set', () => {
  // Overload / high traffic: soft yes (message shaping), hard no (no cooldown).
  assert.equal(looksLikeRateLimit('model overloaded'), true)
  assert.equal(looksLikeHardRateLimit('model overloaded'), false)
  assert.equal(looksLikeRateLimit('server experiencing high traffic, retry later'), true)
  assert.equal(looksLikeHardRateLimit('server experiencing high traffic, retry later'), false)
  // Soft still includes everything hard.
  assert.equal(looksLikeRateLimit('RESOURCE_EXHAUSTED (code 429)'), true)
  // And stays silent on the incident text.
  assert.equal(looksLikeRateLimit(REAL_TOOL_ERROR), false)
})

test('real quota phrasings outside the old narrow regex are recognised', () => {
  // These reached users as a bare "agy exited with code 1" (no cooldown, no
  // rotation), so the retry hammered the same spent account.
  assert.equal(looksLikeHardRateLimit('Resource has been exhausted (e.g. check quota).'), true)
  assert.equal(looksLikeHardRateLimit('You have exhausted your quota for this model.'), true)
  assert.equal(looksLikeRateLimit('The model is overloaded.'), true)
  assert.equal(looksLikeHardRateLimit('The model is overloaded.'), false)
  assert.equal(looksLikeRateLimit('temporarily overloaded, please retry'), true)
  assert.equal(looksLikeHardRateLimit('capacity unavailable'), false)
})

test('looksLikeNetworkError recognises transport-shaped auth failures', () => {
  // Verbatim from the live incident: agy reports "not logged into Antigravity"
  // for a HEALTHY login whose token could not be validated over the network.
  assert.equal(
    looksLikeNetworkError('keyringAuth: token validation failed due to network error (token may still be valid): Post "https://oauth2.googleapis.com/token": EOF'),
    true,
  )
  assert.equal(looksLikeNetworkError('Post "https://play.googleapis.com/log": net/http: TLS handshake timeout'), true)
  assert.equal(looksLikeNetworkError('oauth2.googleapis.com: i/o timeout'), true)
  assert.equal(looksLikeNetworkError('google: could not find default credentials: unexpected EOF'), true)
  assert.equal(looksLikeNetworkError('dial tcp 142.250.0.1:443: connect: connection refused'), true)
  // A genuine sign-out carries no transport evidence and must stay AUTH-shaped.
  assert.equal(looksLikeNetworkError('authentication required: run /agy auth'), false)
  assert.equal(shouldMarkAuthRequired('AUTH', 'keyringAuth: token validation failed due to network error: EOF'), false)
  assert.equal(shouldMarkAuthRequired('AUTH', 'invalid_grant: the token has been revoked'), true)
})

test('looksLikeContextWindowExceeded matches token limit and context overflow signatures', () => {
  assert.equal(looksLikeContextWindowExceeded('prompt is too long: 1204000 tokens > 1048576 maximum'), true)
  assert.equal(looksLikeContextWindowExceeded('INVALID_ARGUMENT: prompt is too long: 2000000 tokens > 1000000 maximum'), true)
  assert.equal(looksLikeContextWindowExceeded('The request exceeded the model context window.'), true)
  assert.equal(looksLikeContextWindowExceeded('context length exceeded: maximum context length is 1048576'), true)
  assert.equal(looksLikeContextWindowExceeded('token limit exceeded for this turn'), true)
  assert.equal(looksLikeContextWindowExceeded('input is too large for the model context window'), true)
  assert.equal(looksLikeContextWindowExceeded('prompt is too long for this model context'), true)

  // Incident & unrelated errors must NOT match
  assert.equal(looksLikeContextWindowExceeded(''), false)
  assert.equal(looksLikeContextWindowExceeded(REAL_TOOL_ERROR), false)
  assert.equal(looksLikeContextWindowExceeded('model overloaded, please try again'), false)
  assert.equal(looksLikeContextWindowExceeded('rate limit reached: resets in 20m'), false)
})

