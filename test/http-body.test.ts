import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readJsonBody, DEFAULT_JSON_BODY_MAX_BYTES } from '../src/host/read-json-body.ts'

/** Fake request: emits the given chunks then 'end' on the next tick. */
function fakeReq(chunks: Buffer[], opts: { error?: Error } = {}): EventEmitter {
  const e = new EventEmitter()
  setImmediate(() => {
    for (const c of chunks) e.emit('data', c)
    if (opts.error) e.emit('error', opts.error)
    else e.emit('end')
  })
  return e
}

test('readJsonBody: parses a JSON object', async () => {
  const res = await readJsonBody(fakeReq([Buffer.from('{"a":1,"b":"x"}')]))
  assert.deepEqual(res, { value: { a: 1, b: 'x' }, tooLarge: false, invalid: false })
})

test('readJsonBody: reassembles across multiple chunks', async () => {
  const res = await readJsonBody(fakeReq([Buffer.from('{"a":'), Buffer.from('42}')]))
  assert.deepEqual(res.value, { a: 42 })
  assert.equal(res.invalid, false)
})

test('readJsonBody: empty / malformed / non-object each resolve invalid', async () => {
  for (const body of ['', 'not json', '[]', '"str"', 'null', '42']) {
    const res = await readJsonBody(fakeReq([Buffer.from(body)]))
    assert.equal(res.invalid, true, 'expected invalid for ' + JSON.stringify(body))
    assert.deepEqual(res.value, {})
  }
})

test('readJsonBody: oversized body is discarded, not parsed', async () => {
  const big = Buffer.from('{"x":"' + 'y'.repeat(2048) + '"}')
  const res = await readJsonBody(fakeReq([big]), { maxBytes: 256 })
  assert.equal(res.tooLarge, true)
  assert.deepEqual(res.value, {})
})

test('readJsonBody: a stream error resolves invalid (never hangs)', async () => {
  const res = await readJsonBody(fakeReq([], { error: new Error('boom') }))
  assert.equal(res.invalid, true)
})

test('readJsonBody: default cap constant is positive', () => {
  assert.ok(DEFAULT_JSON_BODY_MAX_BYTES > 0)
})
