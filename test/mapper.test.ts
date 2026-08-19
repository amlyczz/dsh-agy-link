import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventMapper, suffixDelta, usageFromRaw } from '../src/host/mapper.ts'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>
type UsageChunk = Extract<StreamChunk, { type: 'usage' }>

function mapAll(mapper: EventMapper, events: unknown[]): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const ev of events) out.push(...mapper.map(ev as never))
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

test('suffixDelta grows by suffix and falls back to newline+full', () => {
  assert.equal(suffixDelta('', 'abc'), 'abc')
  assert.equal(suffixDelta('abc', 'abcdef'), 'def')
  assert.equal(suffixDelta('abc', 'abc'), '')
  assert.equal(suffixDelta('abc', 'xyz'), '\nxyz')
})

test('ok run emits ordered protocol: blocks, usage, finish last', () => {
  const m = new EventMapper()
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
  const m = new EventMapper()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello' },
    { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello world' },
  ])
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
  assert.deepEqual(deltas, ['Hello', ' world'])
})

test('tool steps announce once and render output once', () => {
  const m = new EventMapper()
  const chunks = mapAll(m, [
    { kind: 'step', stepKey: '2', stepKind: 'tool', tool: { name: 'read_file', args: { path: '/x' } } },
    { kind: 'step', stepKey: '2', stepKind: 'tool', tool: { name: 'read_file', args: { path: '/x' } } },
    { kind: 'step', stepKey: '2', stepKind: 'tool', tool: { name: 'read_file', args: { path: '/x' }, output: 'data' } },
    { kind: 'step', stepKey: '2', stepKind: 'tool', tool: { name: 'read_file', args: { path: '/x' }, output: 'data' } },
  ])
  const all = chunks.map((c) => (c.type === 'text-delta' ? (c as unknown as { text: string }).text : '')).join('')
  assert.equal(all.match(/\[agy tool: read_file\]/g)?.length, 1)
  assert.equal(all.match(/-> data/g)?.length, 1)
})

test('result text used when no text step streamed', () => {
  const m = new EventMapper()
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c2', ok: true, response: 'only final', usage: {} },
  ])
  const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
  assert.deepEqual(deltas, ['only final'])
})

test('emitFailure closes blocks and finishes with error', () => {
  const m = new EventMapper()
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

test('agy 1.1.15 stream: thinking turns, tool announce/output/error, text fragments', () => {
  const m = new EventMapper()
  const chunks = mapAll(m, [
    { kind: 'init', conversationId: 'c15' },
    // thinking-only turn (usage, no text)
    { kind: 'step', stepKey: '2', stepKind: 'text', text: '', usage: { thinking_tokens: 80 } },
    // tool call with output
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { CommandLine: 'ls' } } },
    { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { CommandLine: 'ls' }, output: 'note1.txt' } },
    // failed tool call
    { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { Pattern: 'x' }, error: 'Find command timed out.' } },
    // streamed answer fragments
    { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are ', fragment: true },
    { kind: 'step', stepKey: '5', stepKind: 'text', text: '2 files.', fragment: true },
    { kind: 'result', conversationId: 'c15', ok: true, response: 'There are 2 files.', usage: { input_tokens: 9, output_tokens: 8, thinking_tokens: 95 } },
  ])
  const text = chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => (c as { text: string }).text)
    .join('')
  // tool activity lives in the visible text body now
  assert.ok(text.includes('[agy tool: run_command]'), text)
  assert.ok(text.includes('-> note1.txt'), text)
  assert.ok(text.includes('[agy tool error: find_by_name] Find command timed out.'), text)
  assert.ok(text.includes('There are 2 files.'), text)
  const reasoning = chunks
    .filter((c) => c.type === 'reasoning-delta')
    .map((c) => (c as { text: string }).text)
    .join('')
  assert.ok(reasoning.includes('[agy thinking turn · 80 thinking tokens]'), reasoning)
  assert.ok(!reasoning.includes('[agy tool:'), 'tool annotations must not be in reasoning')
  const finish = asFinish(lastChunk(chunks))
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(m.isFinished, true)
})

test('result ERROR with usable response soft-finishes and annotates the error', () => {
  const m = new EventMapper()
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
  const m = new EventMapper()
  const chunks = mapAll(m, [
    { kind: 'result', conversationId: 'c15', ok: false, response: '', error: 'explosion', usage: {} },
  ])
  assert.equal(chunks.length, 0)
  assert.equal(m.isFinished, false)
})

test('usageFromRaw maps snake_case fields', () => {
  const u = usageFromRaw({ input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5 })
  assert.equal(u.inputTokens, 1)
  assert.equal(u.outputTokens, 2)
  assert.equal(u.reasoningTokens, 3)
  assert.equal(u.cacheReadTokens, 4)
  assert.equal(u.cacheWriteTokens, 5)
})
