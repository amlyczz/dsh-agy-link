// Regression tests for issue #158: usage accounting under the ACP transport.
//
// agy sends session/update with usage_update carrying only { used, size } — the
// context-window occupancy at the end of an internal call. It used to be
// promoted to state.lastUsage.input_tokens, and because the run reports
// lastStepUsageRaw ?? resultRaw, that placeholder shadowed the real
// PromptResponse.usage: cache hit rate stuck at 0%, token speed at 0 tok/s,
// uncached input inflated. These tests pin the fix.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { RunRecording, hasUsageBreakdown } from '../../src/host/recording.ts'
import { EventMapper } from '../../src/host/mapper.ts'
import { latestUserTaskText, isSyntheticHarnessMessage } from '../../src/provider/prompt-text.ts'
import {
  createAcpStreamState,
  acpUpdateToAgyEvents,
  acpPromptResultToAgyEvent,
} from '../../src/features/acp/protocol.ts'
import type { AgyEvent } from '../../src/common/types.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

function step(partial: Partial<Extract<AgyEvent, { kind: 'step' }>> & { stepKey: string }): AgyEvent {
  return { kind: 'step', stepKind: 'text', text: '', raw: {}, ...partial } as AgyEvent
}

function userText(text: string, source?: Record<string, unknown>): Message {
  return { role: 'user', content: [{ type: 'text', text }], ...(source === undefined ? {} : { source }) } as unknown as Message
}

/** The usage chunk DSH would receive for a recorded run. */
function finalUsageChunk(rec: RunRecording, events: readonly AgyEvent[]): Record<string, number> {
  const mapper = new EventMapper({ runId: 'r-acp', cutOnTool: false, usage: rec })
  const chunks: { type?: string; usage?: Record<string, number> }[] = []
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (ev === undefined) continue
    for (const ch of mapper.map(ev, i)) chunks.push(ch as { type?: string; usage?: Record<string, number> })
  }
  const usage = chunks.filter((c) => c.type === 'usage')
  assert.ok(usage.length > 0, 'the result span emits a usage chunk')
  return usage[usage.length - 1]?.usage ?? {}
}

describe('issue #158: usage_update is context occupancy, not a usage sample', () => {
  test('used is recorded separately and never rides along on streamed steps', () => {
    const st = createAcpStreamState()
    assert.deepEqual(acpUpdateToAgyEvents('s', { sessionUpdate: 'usage_update', used: 51_000, size: 1_000_000 }, st), [])
    assert.equal(st.lastContextUsed, 51_000)
    assert.deepEqual(st.lastUsage, {}, 'no token sample was invented')

    const text = acpUpdateToAgyEvents('s', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, st)
    const ev = text[0] as Extract<AgyEvent, { kind: 'step' }>
    assert.equal(ev.usage, undefined, 'an input-only context reading must not become step usage')
  })

  test('an update that really carries output/cache counts is still a sample', () => {
    const st = createAcpStreamState()
    acpUpdateToAgyEvents('s', { sessionUpdate: 'usage_update', used: 900, outputTokens: 12, cachedReadTokens: 800 }, st)
    assert.equal(st.lastUsage.output_tokens, 12)
    assert.equal(st.lastUsage.cache_read_tokens, 800)
    assert.equal(st.lastUsage.input_tokens, undefined, 'used never becomes input_tokens')
  })

  test('a whole ACP turn reports the PromptResponse usage, not used with 0 output', () => {
    // The exact end-to-end shape the maintainer asked to pin: stream a turn,
    // then check the final usage DSH receives.
    const st = createAcpStreamState()
    const rec = new RunRecording('run-158')
    const feed = (update: Record<string, unknown>): void => {
      for (const ev of acpUpdateToAgyEvents('sid', update, st)) rec.append(ev)
    }
    feed({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
    feed({ sessionUpdate: 'usage_update', used: 240_000, size: 1_000_000 })
    feed({ sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'run_command', status: 'in_progress', rawInput: { CommandLine: 'ls' } })
    feed({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'a' } })
    feed({ sessionUpdate: 'usage_update', used: 300_000, size: 1_000_000 })
    feed({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })

    const promptResponseUsage = {
      inputTokens: 41_000,
      outputTokens: 820,
      cachedReadTokens: 38_000,
      thoughtTokens: 90,
      // agy reports total = input + cacheRead + cacheWrite + output (issue #167).
      totalTokens: 41_000 + 38_000 + 820,
    }
    rec.append(acpPromptResultToAgyEvent('sid', { stopReason: 'end_turn', usage: promptResponseUsage }, st.accumulatedText))

    const events: AgyEvent[] = []
    for (let i = 0; i < rec.length; i++) {
      const ev = rec.eventAt(i)
      if (ev !== undefined) events.push(ev)
    }
    const usage = finalUsageChunk(rec, events)
    assert.equal(usage.inputTokens, 41_000, 'input comes from PromptResponse, not from used')
    assert.equal(usage.outputTokens, 820, 'output is no longer forced to 0')
    assert.equal(usage.cacheReadTokens, 38_000, 'the cache-read counter survives')
    assert.equal(usage.reasoningTokens, 90)
    assert.equal(usage.totalTokens, 79_820)
  })

  test('a step sample still wins when it carries a real breakdown', () => {
    const rec = new RunRecording('run-step')
    // EventMapper feeds noteStepUsage as it consumes the step; call it directly here.
    rec.noteStepUsage({ input_tokens: 16_800, output_tokens: 160 })
    const chosen = rec.finalUsage({ input_tokens: 31_800, output_tokens: 260 })
    assert.equal(chosen.input_tokens, 16_800, 'per-call sample preferred over the cumulative envelope')
    assert.equal(chosen.output_tokens, 160)
  })

  test('an input-only sample yields to the envelope', () => {
    const rec = new RunRecording('run-bare')
    rec.noteStepUsage({ input_tokens: 300_000 })
    const chosen = rec.finalUsage({ input_tokens: 41_000, output_tokens: 820 })
    assert.equal(chosen.output_tokens, 820, 'the envelope keeps the real counts')
    assert.equal(chosen.input_tokens, 41_000)
  })

  test('hasUsageBreakdown only accepts real token counts', () => {
    assert.equal(hasUsageBreakdown({ input_tokens: 10 }), false)
    assert.equal(hasUsageBreakdown({ input_tokens: 10, output_tokens: 0 }), false)
    assert.equal(hasUsageBreakdown({ output_tokens: 1 }), true)
    assert.equal(hasUsageBreakdown({ cache_read_tokens: 5 }), true)
    assert.equal(hasUsageBreakdown({ cache_write_tokens: 5 }), true)
    assert.equal(hasUsageBreakdown({ thinking_tokens: 5 }), true)
    assert.equal(hasUsageBreakdown({ total_tokens: 5 }), true)
  })
})

describe('issue #158: no placeholder 0/0 usage, and a real token speed', () => {
  test('a tool cut with no measurement omits the usage chunk', () => {
    const rec = new RunRecording('run-cut')
    rec.append(step({ stepKey: 't1', stepKind: 'tool', state: 'DONE', tool: { name: 'run_command', output: 'ok' } }))
    const mapper = new EventMapper({ runId: 'r-cut', cutOnTool: true, usage: rec })
    const first = rec.eventAt(0)
    assert.ok(first !== undefined)
    const chunks = [...mapper.map(first, 0)]
    assert.equal(chunks.some((c) => (c as { type: string }).type === 'usage'), false, 'no 0/0 placeholder')
    assert.ok(chunks.some((c) => (c as { type: string }).type === 'finish'))
  })

  test('a failed turn with no sample omits the usage chunk instead of zeroing the meter', () => {
    const rec = new RunRecording('run-fail')
    const mapper = new EventMapper({ runId: 'r-fail', cutOnTool: true, usage: rec })
    const chunks = [...mapper.emitFailure('error', 'AUTH', 'not signed in')]
    assert.equal(chunks.some((c) => (c as { type: string }).type === 'usage'), false)
  })

  test('token speed falls back to the envelope output over the run span', () => {
    let clock = 1_000
    const rec = new RunRecording('run-speed', () => clock)
    rec.append(step({ stepKey: '1', text: 'a' }))
    clock += 1_500
    rec.append(step({ stepKey: '1', text: 'ab' }))
    rec.append({ kind: 'result', ok: true, response: 'ab', conversationId: 'c', usage: { input_tokens: 10, output_tokens: 300 } } as AgyEvent)
    const stats = rec.speedStats()
    assert.equal(stats.outputTokens, 300, 'envelope output count is used')
    assert.equal(stats.measuredSteps, 1)
    assert.ok(stats.avgTps !== null && Math.abs(stats.avgTps - 200) < 1, '300 tokens over 1.5s = 200 tok/s')
    assert.ok(stats.lastTps !== null && stats.lastTps > 0)
  })

  test('step samples still take priority over the fallback', () => {
    let clock = 1_000
    const rec = new RunRecording('run-speed2', () => clock)
    rec.append(step({ stepKey: 's', usage: { output_tokens: 10 } }))
    clock += 1_000
    rec.append(step({ stepKey: 's', usage: { output_tokens: 60 } }))
    rec.append({ kind: 'result', ok: true, response: 'x', conversationId: 'c', usage: { input_tokens: 5, output_tokens: 999 } } as AgyEvent)
    const stats = rec.speedStats()
    assert.equal(stats.outputTokens, 60, 'measured step samples win over the envelope fallback')
  })

  test('a sub-500ms run still reports no speed rather than a fake one', () => {
    let clock = 1_000
    const rec = new RunRecording('run-speed3', () => clock)
    rec.append(step({ stepKey: '1', text: 'a' }))
    clock += 50
    rec.append({ kind: 'result', ok: true, response: 'a', conversationId: 'c', usage: { output_tokens: 5 } } as AgyEvent)
    const stats = rec.speedStats()
    assert.equal(stats.avgTps, null)
    assert.equal(stats.lastTps, null)
  })
})

describe('issue #158: a memory snapshot never becomes the task text', () => {
  test('latestUserTaskText skips a dsh-mnemon snapshot and keeps the real task', () => {
    const messages = [
      userText('refactor the runner'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } as unknown as Message,
      userText('[memory snapshot] remembered: prefers tabs', { kind: 'dsh-mnemon' }),
    ]
    assert.equal(latestUserTaskText(messages), 'refactor the runner')
  })

  test('the snapshot still rides along: it is not marked synthetic', () => {
    const snapshot = userText('[memory snapshot] remembered: prefers tabs', { kind: 'dsh-mnemon' })
    assert.equal(isSyntheticHarnessMessage(snapshot), false, 'the snapshot must reach agy with the turn')
  })

  test('a lone memory snapshot leaves no task text at all', () => {
    assert.equal(latestUserTaskText([userText('[memory snapshot] x', { kind: 'dsh-mnemon' })]), '')
  })
})