// Regression tests for the ACP usage/context contract (follow-up to #158/#167).
//
// `agy acp`'s `session/prompt` response reports usage CUMULATIVE for the whole
// ACP session: every internal PLANNER_RESPONSE call is summed into the final
// `usage`. DSH's context meter treats the last reported usage as the current
// context occupancy, so forwarding that envelope makes a 1M-window session
// show "上下文 100%" after a handful of tool steps (a real 4.45M prompt side on
// a 1,048,576 window). The authoritative per-call figure lives in
// `transcript.jsonl`, where agy 1.5.x writes the counters at the TOP LEVEL of
// each PLANNER_RESPONSE line (older builds nested them under `usage`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpTranscriptUsageTailer } from '../../../src/features/acp/transcript-usage.ts'
import { RunRecording } from '../../../src/host/recording.ts'
import { usageFromRaw } from '../../../src/provider/mapper/usage.ts'

function withTranscript(lines: string[], fn: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cache-usage-'))
  try {
    const file = join(dir, 'transcript.jsonl')
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')
    fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('acp usage: tailer reads agy 1.5.x TOP-LEVEL token counters (real transcript shape)', () => {
  withTranscript([
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T07:22:02Z',
      input_tokens: 42216,
      cache_read_tokens: 0,
      output_tokens: 760,
      thinking: 'plan',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-23T07:22:14Z',
      input_tokens: 14424,
      cache_read_tokens: 42217,
      output_tokens: 7247,
      thinking: 'answer',
    }),
  ], (file) => {
    const tailer = new AcpTranscriptUsageTailer('conv', undefined, file)
    // Constructor starts at EOF; rewind to emulate "tailing from the pre-turn offset".
    ;(tailer as unknown as { offset: number }).offset = 0
    const samples = tailer.poll()
    assert.equal(samples.length, 2, 'both real PLANNER_RESPONSE lines must parse')
    assert.equal(samples[0]!.usage.input_tokens, 42216)
    assert.equal(samples[1]!.usage.input_tokens, 14424)
    assert.equal(samples[1]!.usage.cache_read_tokens, 42217)
    assert.equal(samples[1]!.usage.output_tokens, 7247)
  })
})

test('acp usage: the per-call transcript sample wins over a cumulative result envelope', () => {
  const rec = new RunRecording('r-acp-cumulative')
  // Per-call sample (last internal call): 14.4k uncached + 42.2k cached.
  rec.noteStepUsage({ input_tokens: 14424, cache_read_tokens: 42217, output_tokens: 7247 }, 'transcript-2')
  // Cumulative envelope for the whole ACP session: 56.6k + 4.05M cached.
  const final = rec.finalUsage({ input_tokens: 56640, cache_read_tokens: 4048573, output_tokens: 8007, total_tokens: 4483643 })
  assert.equal(final.input_tokens, 14424, 'prompt side must be the last call, not the session sum')
  assert.equal(final.cache_read_tokens, 42217)
  assert.equal(final.output_tokens, 7247)
  const usage = usageFromRaw(final)
  assert.equal(usage.inputTokens + (usage.cacheReadTokens ?? 0), 56641, 'context occupancy stays per-call')
})

test('acp usage: without a per-call sample the emitter refuses the cumulative envelope when a prior span already emitted', () => {
  const rec = new RunRecording('r-acp-any-emitted')
  rec.noteStepUsage({ input_tokens: 1000, cache_read_tokens: 50000, output_tokens: 100 }, 'transcript-1')
  const first = rec.consumeSpanUsage()
  assert.equal(first?.input_tokens, 1000)
  // No new sample arrived before the result: returning the cumulative envelope
  // would re-introduce the 100% context bug, so nothing is emitted.
  const second = rec.consumeSpanUsage({ input_tokens: 56640, cache_read_tokens: 4048573, output_tokens: 8007 })
  assert.equal(second, null)
})
