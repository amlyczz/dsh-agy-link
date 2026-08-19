import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventMapper, suffixDelta, usageFromRaw } from '../src/host/mapper.ts'
import { mirrorCallId, parseMirrorCallId } from '../src/host/recording.ts'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>
type UsageChunk = Extract<StreamChunk, { type: 'usage' }>
type ToolCallEnd = Extract<StreamChunk, { type: 'block-end' }> & { block: { type: 'tool-call'; id: string; name: string; arguments: string } }

/** Fresh mapper for one span of run r1 (cut on completed tools, like main turns). */
function newSpan(runId = 'r1', initialSawText = false): EventMapper {
  return new EventMapper({ runId, cutOnTool: true, initialSawText })
}

function mapAll(mapper: EventMapper, events: unknown[], startIdx = 0): StreamChunk[] {
  const out: StreamChunk[] = []
  let i = startIdx
  for (const ev of events) {
    out.push(...mapper.map(ev as never, i))
    i++
    if (mapper.isFinished) break
  }
  return out
}
function lastChunk(cs: StreamChunk[]): StreamChunk {
  const c = cs[cs.length - 1]
  assert.ok(c !== undefined)
  return c
}
function asFinish(c: StreamChunk): FinishChunk {
  assert.equal(c.type, 'finish')
  return c as FinishChunk
}
function asUsage(c: StreamChunk): UsageChunk {
  assert.equal(c.type, 'usage')
  return c as UsageChunk
}
function toolCallEnd(cs: StreamChunk[]): ToolCallEnd {
  const c = cs.find((x) => x.type === 'block-end' && (x as { block: { type: string } }).block.type === 'tool-call')
  assert.ok(c !== undefined, 'span must emit a tool-call block')
  return c as unknown as ToolCallEnd
}

test('suffixDelta grows by suffix and falls back to newline+full', () => {
  assert.equal(suffixDelta('', 'abc'), 'abc')
  assert.equal(suffixDelta('abc', 'abcdef'), 'def')
  assert.equal(suffixDelta('abc', 'abc'), '')
  assert.equal(suffixDelta('abc', 'xyz'), '\nxyz')
})

test('ok run without tools emits ordered protocol: blocks, usage, finish last', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c1' },
    { kind: 'step', stepKey: '1', stepKind: 'thinking', text: 'Think' },
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Hi there' },
    { kind: 'result', conversationId: 'c1', ok: true, response: 'Hi there', usage: { input_tokens: 7, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 1 } },
  ])
  const types = chunks.map((c) => c.type)
  assert.deepEqual(types, [
    'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end',
    'usage', 'finish',
  ])
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'stop')
  const usage = asUsage(chunks[chunks.length - 2] as StreamChunk)
  assert.equal(usage.usage.inputTokens, 7)
  assert.equal(usage.usage.reasoningTokens, 2)
  assert.equal((finish.replayState as { response?: { conversationId?: string } } | undefined)?.response?.conversationId, 'c1')
  assert.equal(m.isFinished, true)
})

test('snapshot-style repeated steps stream as suffix deltas', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello world' },
  ])
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
  assert.deepEqual(deltas, ['Hello', ' world'])
})

test('completed tool step cuts the span into a native tool-call + finish:tool-calls', () => {
  const m = newSpan('run-abc')
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Working on it' },
    // ACTIVE has no payload yet: no cut
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { command: 'ls' } } },
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'a.txt' } },
    // later events must not map: the span already finished
    { kind: 'step', stepKey: '9', stepKind: 'text', text: 'after the cut' },
  ])
  const end = toolCallEnd(chunks)
  assert.equal(end.block.name, 'agy_tool')
  assert.equal(end.block.id, mirrorCallId('run-abc', 2))
  const args = JSON.parse(end.block.arguments) as { run: string; step: number; tool: string; input: { command: string } }
  assert.equal(args.run, 'run-abc')
  assert.equal(args.step, 2)
  assert.equal(args.tool, 'run_command')
  assert.deepEqual(args.input, { command: 'ls' })
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.equal(m.isFinished, true)
  // no text beyond the pre-tool block leaked into this span
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text, 'Working on it')
})

test('erroring tool step cuts exactly like a successful one', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'timed out' } },
  ])
  const end = toolCallEnd(chunks)
  const args = JSON.parse(end.block.arguments) as { tool: string }
  assert.equal(args.tool, 'find_by_name')
  assert.equal(asFinish(lastChunk(chunks)).reason.kind, 'tool-calls')
})

test('auxiliary spans never cut on tools', () => {
  const m = new EventMapper({ runId: 'r2', cutOnTool: false })
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: {}, output: 'x' } },
    { kind: 'result', conversationId: 'c', ok: true, response: 'done', usage: {} },
  ])
  assert.equal(chunks.some((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call'), false)
  assert.equal(asFinish(lastChunk(chunks)).reason.kind, 'stop')
})

test('result text used when no text step streamed anywhere in the run', () => {
  const m = newSpan('r3')
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c2', ok: true, response: 'only final', usage: {} },
  ])
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
  assert.deepEqual(deltas, ['only final'])
})

test('result fallback suppressed when an earlier span already streamed the text', () => {
  // Final span of a run whose text streamed in span 1: the result response
  // must NOT be duplicated as a fresh text block.
  const m = newSpan('r4', true)
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c4', ok: true, response: 'already streamed', usage: {} },
  ], 5)
  assert.equal(chunks.some((c) => c.type === 'text-delta'), false)
  assert.equal(asFinish(lastChunk(chunks)).reason.kind, 'stop')
})

test('agy 1.1.15 stream maps onto spans: thinking turn, tool cuts, fragments, result', () => {
  const events: unknown[] = [
    { kind: 'init', conversationId: 'c15' },
    // thinking-only turn (usage, no text)
    { kind: 'step', stepKey: '2', stepKind: 'text', text: '', usage: { thinking_tokens: 80 } },
    // tool call with output
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { command: 'ls' } } },
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'note1.txt' } },
    // failed tool call
    { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'Find command timed out.' } },
    // streamed answer fragments
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are ', fragment: true },
    { kind: 'step', stepKey: '5', stepKind: 'text', text: '2 files.', fragment: true },
    { kind: 'result', conversationId: 'c15', ok: true, response: 'There are 2 files.', usage: { input_tokens: 9, output_tokens: 8, thinking_tokens: 95 } },
  ]
  // Span 1: thinking annotation + first tool cut
  const s1 = newSpan('run15')
  const c1 = mapAll(s1, events, 0)
  const reasoning1 = c1.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
  assert.ok(reasoning1.includes('[agy thinking turn · 80 thinking tokens]'), reasoning1)
  assert.equal(toolCallEnd(c1).block.id, mirrorCallId('run15', 3))
  assert.equal(asFinish(lastChunk(c1)).reason.kind, 'tool-calls')
  // Span 2: second tool cut (the errored one)
  const s2 = newSpan('run15')
  const c2 = mapAll(s2, events.slice(4), 4)
  assert.equal(toolCallEnd(c2).block.id, mirrorCallId('run15', 4))
  assert.equal(asFinish(lastChunk(c2)).reason.kind, 'tool-calls')
  // Span 3: fragments + result → stop
  const s3 = newSpan('run15', false)
  const c3 = mapAll(s3, events.slice(5), 5)
  const text3 = c3.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  assert.equal(text3, 'There are 2 files.')
  assert.equal(asFinish(lastChunk(c3)).reason.kind, 'stop')
})

test('emitFailure closes blocks and finishes with error', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'partial' },
  ])
  chunks.push(...[...m.emitFailure('error', 'AUTH', 'not signed in')])
  const finish = asFinish(lastChunk(chunks))
  if (finish.reason.kind === 'error') {
    assert.equal(finish.reason.failure.code, 'AUTH')
  } else {
    assert.fail('expected error finish')
  }
  const endIdx = chunks.map((c) => c.type).lastIndexOf('block-end')
  assert.ok(endIdx >= 0)
  assert.ok(chunks.slice(endIdx + 1).every((d) => d.type === 'usage' || d.type === 'finish'))
})

test('result ERROR with usable response soft-finishes and annotates the error', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are 2 files.', fragment: true },
    { kind: 'result', conversationId: 'c15', ok: false, response: 'There are 2 files.', error: 'find timed out', usage: { input_tokens: 9, output_tokens: 8 } },
  ])
  const reasoning = chunks
    .filter((c) => c.type === 'reasoning-delta')
    .map((c) => (c as { text: string }).text)
    .join('')
  assert.ok(reasoning.includes('[agy finished with error] find timed out'), reasoning)
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(m.isFinished, true)
})

test('result ERROR without response stays passive for the adapter', () => {
  const m = newSpan()
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c15', ok: false, response: '', error: 'explosion', usage: {} },
  ])
  assert.equal(chunks.length, 0)
  assert.equal(m.isFinished, false)
})

test('mirrorCallId round-trips through parseMirrorCallId', () => {
  const id = mirrorCallId('0f1e2d3c-4b5a-6789-9abc-def012345678', 42)
  assert.equal(id, 'agytc-0f1e2d3c-4b5a-6789-9abc-def012345678-42')
  assert.deepEqual(parseMirrorCallId(id), { runId: '0f1e2d3c-4b5a-6789-9abc-def012345678', eventIndex: 42 })
  assert.equal(parseMirrorCallId('other-1'), null)
  assert.equal(parseMirrorCallId('agytc-x'), null)
})

test('usageFromRaw maps snake_case fields', () => {
  const u = usageFromRaw({ input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5 })
  assert.equal(u.inputTokens, 1)
  assert.equal(u.outputTokens, 2)
  assert.equal(u.reasoningTokens, 3)
  assert.equal(u.cacheReadTokens, 4)
  assert.equal(u.cacheWriteTokens, 5)
})
