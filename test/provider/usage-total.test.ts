// issue #167: the total DSH can accept.
//
// The host's token meter (normalizeUsage in dsh-token-meter) rejects a whole
// turn when `totalTokens` is missing, or when it contradicts the prompt it
// reconstructs from input + cacheRead + cacheWrite. agy's CLI reports
// `total_tokens` as input + output and omits cache_write_tokens entirely, so a
// cached CLI turn used to arrive with a total smaller than its own counters and
// the entire turn was dropped from the meter. usageFromRaw therefore keeps a
// reported total only when it can be trusted and derives it otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageFromRaw } from '../../src/provider/mapper/usage.ts'
import { classifyEvent } from '../../src/host/parser.ts'

test('a cached CLI turn (no cache_write counter, total without cache) is derived', () => {
  // Measured shape, agy 1.5.14 CLI stream-json result event (issue #167).
  const ev = classifyEvent(
    { type: 'result', usage: { input_tokens: 66_216, output_tokens: 3_098, thinking_tokens: 2_712, cache_read_tokens: 15_706, total_tokens: 69_314 } },
    1,
  )
  assert.ok(ev && ev.kind === 'result')
  const u = usageFromRaw(ev.usage)
  assert.equal(u.inputTokens, 66_216)
  assert.equal(u.outputTokens, 3_098)
  assert.equal(u.cacheReadTokens, 15_706)
  assert.equal(u.totalTokens, 66_216 + 3_098 + 15_706, 'total covers the cached prompt the CLI left out')
  // The host demands total - output >= input + cacheRead + cacheWrite.
  assert.ok(u.totalTokens - u.outputTokens >= u.inputTokens + (u.cacheReadTokens ?? 0))
})

test('a cached CLI step sample is derived the same way', () => {
  const ev = classifyEvent(
    { type: 'step_update', usage: { input_tokens: 3_068, output_tokens: 600, thinking_tokens: 457, cache_read_tokens: 43_629, total_tokens: 3_668 } },
    1,
  )
  assert.ok(ev && ev.kind === 'step' && ev.usage)
  const u = usageFromRaw(ev.usage)
  assert.equal(u.totalTokens, 3_068 + 600 + 43_629)
})

test('the ACP total is already correct and is passed through untouched', () => {
  // Measured PromptResponse.usage, agy 1.5.14 ACP (issue #167).
  const u = usageFromRaw({
    input_tokens: 50_555,
    output_tokens: 820,
    cache_read_tokens: 45_593,
    cache_write_tokens: 0,
    thinking_tokens: 728,
    total_tokens: 96_968,
  })
  assert.equal(u.totalTokens, 96_968, 'input + cacheRead + cacheWrite + output, as agy reports it')
  assert.equal(u.totalTokens, u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0))
})

test('a missing total is derived instead of being left undefined', () => {
  const u = usageFromRaw({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 })
  assert.equal(u.totalTokens, 150)
  const bare = usageFromRaw({ input_tokens: 7, output_tokens: 3 })
  assert.equal(bare.totalTokens, 10, 'no counters at all still yields a usable total')
})

test('a reported total larger than the counters is trusted', () => {
  // Reasoning tokens are billed but not part of the prompt; a total above the
  // sum of the counters is a superset we must not shrink.
  const u = usageFromRaw({ input_tokens: 10, output_tokens: 5, thinking_tokens: 500, total_tokens: 515 })
  assert.equal(u.totalTokens, 515)
})

test('both cache counters present: a disagreeing total is replaced, an exact one is kept', () => {
  const exact = usageFromRaw({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 7, cache_write_tokens: 3, total_tokens: 25 })
  assert.equal(exact.totalTokens, 25, 'total - output === input + cacheRead + cacheWrite')
  const off = usageFromRaw({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 7, cache_write_tokens: 3, total_tokens: 99 })
  assert.equal(off.totalTokens, 25, 'the host would reject 99, so the derived total wins')
  const low = usageFromRaw({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 7, cache_write_tokens: 3, total_tokens: 4 })
  assert.equal(low.totalTokens, 25)
})
