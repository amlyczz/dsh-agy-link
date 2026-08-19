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
  // Span 1 ends on the completed tool cut; span 2 carries the result.
  const m1 = new EventMapper({ runId: 'r-lossless', cutOnTool: true })
  const chunks: unknown[] = []
  const feed = (mapper: EventMapper, ev: Parameters<EventMapper['map']>[0], i: number): void => {
    for (const ch of mapper.map(ev, i) as Generator<object>) chunks.push(ch)
  }
  feed(m1, { kind: 'step', stepKind: 'thinking', stepKey: 's1', text: 'let me think' } as never, 0)
  feed(m1, { kind: 'step', stepKind: 'text', stepKey: 's2', text: 'Hello ' } as never, 1)
  feed(m1, { kind: 'step', stepKind: 'text', stepKey: 's2', text: 'Hello world' } as never, 2)
  feed(m1, { kind: 'step', stepKind: 'tool', stepKey: 's3', text: '', tool: { name: 'bash', args: { c: 'x' }, output: 'ok' } } as never, 3)
  const m2 = new EventMapper({ runId: 'r-lossless', cutOnTool: true, initialSawText: true })
  feed(m2, { kind: 'result', conversationId: 'cid-1', ok: true, response: '', error: undefined, usage: { input_tokens: 1, output_tokens: 2 } } as never, 4)
  for (const ch of chunks) {
    assert.equal(isLosslessJson(ch), true, 'chunk must survive the lossless-JSON boundary: ' + JSON.stringify(ch))
  }
  // tool-cut finish is reason tool-calls with no replayState
  const toolFinish = chunks.find((c) => (c as { type?: string; reason?: { kind?: string } }).type === 'finish' && (c as { reason: { kind: string } }).reason.kind === 'tool-calls') as Record<string, unknown>
  assert.ok(toolFinish, 'tool-calls finish present')
  assert.ok(!('replayState' in toolFinish), 'cut finish carries no replayState')
  // usage chunk from the cut span is zeroed
  const usageChunk = chunks.find((c) => (c as { type?: string }).type === 'usage') as { usage: Record<string, unknown> }
  assert.ok(!('cacheReadTokens' in usageChunk.usage), 'absent cache counter omitted')
  assert.ok(!('reasoningTokens' in usageChunk.usage))
  assert.equal(usageChunk.usage.inputTokens, 0)
  // final finish: replayState present (conversationId non-empty)
  const finish = chunks.filter((c) => (c as { type?: string }).type === 'finish').pop() as { replayState?: unknown; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  assert.ok(finish.replayState, 'replayState attached when conversation id known')
  assert.deepEqual(finish.replayState, { response: { conversationId: 'cid-1' } })
})

test('finish without conversation id omits replayState entirely', () => {
  const m = new EventMapper({ runId: 'r2', cutOnTool: true })
  const chunks = collect(m.map({ kind: 'result', conversationId: '', ok: true, response: 'x', error: undefined, usage: {} } as never, 0) as Generator<object>)
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
