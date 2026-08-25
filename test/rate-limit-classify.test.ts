import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeRateLimit, looksLikeHardRateLimit } from '../src/common/types.ts'

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
