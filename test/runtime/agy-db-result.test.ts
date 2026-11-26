import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractToolResultText } from '../../src/runtime/agy/db/extract.ts'

/** Length-delimited protobuf field: tag varint + length varint + bytes. */
function field(tag: number, payload: Buffer): Buffer {
  const head: number[] = []
  let v = (tag << 3) | 2
  while (v >= 0x80) {
    head.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  head.push(v)
  let len = payload.length
  const lenBytes: number[] = []
  while (len >= 0x80) {
    lenBytes.push((len & 0x7f) | 0x80)
    len >>>= 7
  }
  lenBytes.push(len)
  return Buffer.concat([Buffer.from([...head, ...lenBytes]), payload])
}

/** step_payload → 140 (container) → 2 (ToolResult) → 1 (rendered text). */
function payloadWithResult(text: string, extra: Buffer = Buffer.alloc(0)): Buffer {
  const result = Buffer.concat([field(1, Buffer.from(text, 'utf8')), field(3, Buffer.from('meta', 'utf8')), field(6, Buffer.from('type.googleapis.com/exa.cortex.core.tools.ReadFile', 'utf8'))])
  const container = Buffer.concat([field(1, Buffer.from('status', 'utf8')), field(2, result)])
  return Buffer.concat([field(1, Buffer.from([0x84, 0x01])), field(5, Buffer.from('callid', 'utf8')), field(140, container), extra])
}

test('extracts the rendered result text agy keeps in field 140.2.1', () => {
  const text = 'Created At: 2026-11-26T19:35:34+08:00\nCompleted At: 2026-11-26T19:35:36+08:00\nShowing lines 1-2 of 2\n1: # Title\n2: body'
  assert.equal(extractToolResultText(payloadWithResult(text)), text)
})

test('returns null when the step has no result container', () => {
  assert.equal(extractToolResultText(Buffer.from([0x0a, 0x03, 0x61, 0x62, 0x63])), null)
})

test('returns null for an empty rendered result', () => {
  assert.equal(extractToolResultText(payloadWithResult('')), null)
})

test('ignores trailing sibling fields after the result', () => {
  const text = 'Created At: 2026-11-26T19:35:34+08:00\nCreated file'
  const payload = payloadWithResult(text, field(144, Buffer.from('tail', 'utf8')))
  assert.equal(extractToolResultText(payload), text)
})

test('rejects a truncated length instead of throwing', () => {
  // field 140 with a length that runs past the buffer.
  const payload = Buffer.from([0xa2, 0x08, 0x7f, 0x01, 0x02])
  assert.equal(extractToolResultText(payload), null)
})
