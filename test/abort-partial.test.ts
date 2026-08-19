import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventMapper } from '../src/host/mapper.ts'

// Regression (v0.2): aborting mid-stream must still deliver everything the
// model already produced — emitFailure closes the open block first, so
// partial text/thinking is never dropped when the caller hits stop.
test('emitFailure(aborted) preserves already-emitted deltas', () => {
  const m = new EventMapper()
  const chunks: unknown[] = []
  const feed = (ev: Parameters<EventMapper['map']>[0]): void => {
    for (const ch of m.map(ev) as Generator<object>) chunks.push(ch)
  }
  feed({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'Hello ' } as Parameters<EventMapper['map']>[0])
  feed({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'Hello world' } as Parameters<EventMapper['map']>[0])
  for (const ch of m.emitFailure('aborted', 'ABORTED', 'agy run aborted by caller') as Generator<object>) chunks.push(ch)
  const deltas = chunks.filter((c) => (c as { type?: string }).type === 'text-delta') as Array<{ text: string }>
  assert.equal(deltas.map((d) => d.text).join(''), 'Hello world')
  const types = chunks.map((c) => (c as { type?: string }).type)
  assert.ok(types.includes('block-end'))
  assert.ok(types.includes('finish'))
  const finish = chunks.find((c) => (c as { type?: string }).type === 'finish') as { reason: { kind: string; failure?: { code: string } } }
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.reason.failure?.code, 'ABORTED')
  assert.equal(types[types.length - 1], 'finish')
  assert.equal([...m.emitFailure('error', 'X', 'y')].length, 0)
})
