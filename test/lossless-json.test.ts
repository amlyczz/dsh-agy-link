import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventMapper, usageFromRaw, suffixDelta } from '../src/host/mapper.ts'
import { StreamJsonParser } from '../src/host/parser.ts'

// Regression (0.2.6): the DSH session layer rejects any chunk carrying
// undefined-valued fields (lossless-JSON boundary: undefined, NaN, -0,
// non-plain objects all fail). Every chunk this adapter emits must be a
// plain JSON object with no undefined properties.

/** Minimal lossless-JSON check mirroring dsh-session.walkJsonValue rules. */
function isLosslessJson(value: unknown): boolean {
  const ancestors = new Set<unknown>()
  const stack: Array<{ kind: string; value?: unknown; source?: unknown; key?: unknown; index?: number }> = [{ kind: 'visit', value }]
  while (stack.length > 0) {
    const task = stack.pop()!
    if (task.kind === 'leave') { ancestors.delete(task.source); continue }
    if (task.kind === 'array-item') {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index as number)) return false
      stack.push({ kind: 'visit', value: (task.source as unknown[])[task.index!] })
      continue
    }
    if (task.kind === 'object-property') {
      stack.push({ kind: 'visit', value: (task.source as Record<string, unknown>)[task.key as string] })
      continue
    }
    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'string') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return false
      continue
    }
    if (typeof current !== 'object') return false
    if (ancestors.has(current)) return false
    if (Array.isArray(current)) {
      ancestors.add(current)
      stack.push({ kind: 'leave', source: current })
      for (let i = current.length - 1; i >= 0; i--) stack.push({ kind: 'array-item', source: current, index: i })
      continue
    }
    const proto = Object.getPrototypeOf(current)
    if (proto !== Object.prototype && proto !== null) return false
    ancestors.add(current)
    stack.push({ kind: 'leave', source: current })
    const keys = Object.keys(current as object)
    for (let i = keys.length - 1; i >= 0; i--) stack.push({ kind: 'object-property', source: current, key: keys[i] })
  }
  return true
}

function collect(chunks: Generator<object>): unknown[] {
  return [...chunks] as unknown[]
}

test('every emitted chunk is lossless JSON (no undefined fields)', () => {
  const m = new EventMapper()
  const chunks: unknown[] = []
  const feed = (ev: Parameters<EventMapper['map']>[0]): void => {
    for (const ch of m.map(ev) as Generator<object>) chunks.push(ch)
  }
  feed({ kind: 'step', stepKind: 'thinking', stepKey: 's1', text: 'let me think' } as never)
  feed({ kind: 'step', stepKind: 'text', stepKey: 's2', text: 'Hello ' } as never)
  feed({ kind: 'step', stepKind: 'text', stepKey: 's2', text: 'Hello world' } as never)
  feed({ kind: 'step', stepKind: 'tool', stepKey: 's3', text: '', tool: { name: 'bash', args: { c: 'x' }, output: 'ok' } } as never)
  feed({ kind: 'result', conversationId: 'cid-1', ok: true, response: '', error: undefined, usage: { input_tokens: 1, output_tokens: 2 } } as never)
  for (const ch of chunks) {
    assert.equal(isLosslessJson(ch), true, 'chunk must survive the lossless-JSON boundary: ' + JSON.stringify(ch))
  }
  // usage chunk: optional counters must be omitted (not undefined)
  const usageChunk = chunks.find((c) => (c as { type?: string }).type === 'usage') as { usage: Record<string, unknown> }
  assert.ok(!('cacheReadTokens' in usageChunk.usage), 'absent cache counter omitted')
  assert.ok(!('reasoningTokens' in usageChunk.usage))
  assert.equal(usageChunk.usage.inputTokens, 1)
  // finish chunk: replayState present (conversationId non-empty)
  const finish = chunks.find((c) => (c as { type?: string }).type === 'finish') as { replayState?: unknown; reason: { kind: string } }
  assert.ok(finish.replayState, 'replayState attached when conversation id known')
  assert.deepEqual(finish.replayState, { response: { conversationId: 'cid-1' } })
})

test('finish without conversation id omits replayState entirely', () => {
  const m = new EventMapper()
  const chunks = collect(m.map({ kind: 'result', conversationId: '', ok: true, response: 'x', error: undefined, usage: {} } as never) as Generator<object>)
  const finish = chunks.find((c) => (c as { type?: string }).type === 'finish') as Record<string, unknown>
  assert.ok(!('replayState' in finish), 'replayState omitted')
  assert.equal(isLosslessJson(finish), true)
})

test('usageFromRaw omits absent optional counters', () => {
  const u = usageFromRaw({ input_tokens: 3, output_tokens: 4 })
  assert.ok(!('cacheReadTokens' in u))
  assert.ok(!('reasoningTokens' in u))
  const u2 = usageFromRaw({ input_tokens: 1, output_tokens: 1, thinking_tokens: 9, cache_read_tokens: 5 })
  assert.equal(u2.reasoningTokens, 9)
  assert.equal(u2.cacheReadTokens, 5)
})

test('suffixDelta handles empty and grown text', () => {
  assert.equal(suffixDelta('', 'a'), 'a')
  assert.equal(suffixDelta('a', 'ab'), 'b')
  assert.equal(suffixDelta('a', 'c'), '\nc')
  assert.equal(suffixDelta('same', 'same'), '')
})

test('parser never emits undefined text or NaN usage', () => {
  const p = new StreamJsonParser()
  const evs = p.feed('{"event":"step_update","step_type":"thinking","idx":0,"text":"hmm"}\n{"event":"result","result":{"usage":{"input_tokens":10}}}\n')
  for (const ev of evs) {
    assert.equal(isLosslessJson(ev), true)
  }
  const result = evs.find((e) => e.kind === 'result')
  assert.equal((result as { usage?: { input_tokens?: number } }).usage?.input_tokens, 10)
})
