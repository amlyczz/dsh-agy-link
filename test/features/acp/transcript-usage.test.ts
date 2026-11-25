import assert from 'node:assert/strict'
import test from 'node:test'
import { extractUsageFromRecord } from '../../../src/features/acp/transcript-usage.ts'

// issue #175: agy 1.5.12 writes `PLANNER_RESPONSE` records with the token
// counters FLAT on the record itself (no `usage` wrapper). Reading only nested
// objects made the tailer return null, so the ACP context meter fell back to
// the step-less estimate and inflated with every tool step (3.1M / 1.0M).

test('nested usage is still read (no regression)', () => {
  const u = extractUsageFromRecord({ usage: { input_tokens: 10, output_tokens: 2 } })
  assert.equal(u?.input_tokens, 10)
  assert.equal(u?.output_tokens, 2)
})

test('token_usage and metadata.usage are still read', () => {
  assert.equal(extractUsageFromRecord({ token_usage: { prompt_tokens: 7 } })?.input_tokens, 7)
  assert.equal(extractUsageFromRecord({ metadata: { usage: { completion_tokens: 3 } } })?.output_tokens, 3)
})

test('flat top-level counters are read (issue #175)', () => {
  const rec = {
    step_index: 49,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    model: 'gemini-pro-orchestrator-neon',
    input_tokens: 294_300,
    output_tokens: 1_200,
    cache_read_tokens: 280_000,
    thinking_tokens: 40,
  }
  const u = extractUsageFromRecord(rec)
  assert.ok(u, 'a flat record must yield a sample')
  assert.equal(u.input_tokens, 294_300)
  assert.equal(u.output_tokens, 1_200)
  assert.equal(u.cache_read_tokens, 280_000)
  assert.equal(u.thinking_tokens, 40)
})

test('a record with no counters at all yields null', () => {
  assert.equal(extractUsageFromRecord({ step_index: 3, type: 'TOOL_CALL', status: 'DONE' }), null)
})
