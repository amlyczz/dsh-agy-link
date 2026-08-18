import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamJsonParser } from '../src/host/parser.ts'
import type { AgyEvent } from '../src/common/types.ts'

const OK_NDJSON = [
  '{"event":"init","conversation_id":"c1","model":"gemini-3-6-flash"}',
  '{"event":"step_update","idx":1,"step_type":"thinking","text":"Think"}',
  '{"event":"step_update","idx":3,"step_type":"text","text":"Hi"}',
  '{"event":"result","result":{"conversation_id":"c1","status":"DONE","response":"Hi","usage":{"input_tokens":3,"output_tokens":2}}}',
].join('\n')

function asStep(e: AgyEvent | undefined) {
  assert.ok(e !== undefined && e.kind === 'step')
  return e
}
function asResult(e: AgyEvent | undefined) {
  assert.ok(e !== undefined && e.kind === 'result')
  return e
}

test('parses a full ok run', () => {
  const p = new StreamJsonParser()
  const evs = p.feed(OK_NDJSON + '\n')
  assert.equal(evs.length, 4)
  assert.equal(evs[0]?.kind, 'init')
  assert.equal(asStep(evs[1]).stepKind, 'thinking')
  assert.equal(asStep(evs[2]).stepKind, 'text')
  const res = asResult(evs[3])
  assert.equal(res.ok, true)
  assert.equal(res.usage.input_tokens, 3)
  assert.equal(p.stats.garbage, 0)
})

test('buffers torn chunks across feeds', () => {
  const p = new StreamJsonParser()
  const out: AgyEvent[] = []
  for (let i = 0; i < OK_NDJSON.length; i += 7) {
    out.push(...p.feed(OK_NDJSON.slice(i, i + 7)))
  }
  out.push(...p.flush())
  assert.equal(out.length, 4)
  assert.equal(out.filter((e) => e.kind === 'garbage').length, 0)
})

test('counts garbage and captures auth failures', () => {
  const p = new StreamJsonParser()
  const evs = p.feed('\u26a0 noise line\n{"event":"result","result":{"status":"ERROR","error":"authentication failed or timed out"}}\n')
  assert.equal(evs[0]?.kind, 'garbage')
  assert.equal(asResult(evs[1]).ok, false)
  assert.equal(p.stats.garbage, 1)
  assert.equal(p.stats.sawAuthFailure, true)
})

test('captures the OAuth URL from raw lines', () => {
  const p = new StreamJsonParser()
  p.feed('visit https://accounts.google.com/o/oauth2/auth?code=4/AbC now\n')
  assert.ok(p.stats.authUrl?.startsWith('https://accounts.google.com/'))
})

test('flush emits a trailing line without newline', () => {
  const p = new StreamJsonParser()
  const evs = p.feed('{"event":"init","conversation_id":"c9"}')
  assert.equal(evs.length, 0)
  const tail = p.flush()
  assert.equal(tail.length, 1)
  assert.equal(tail[0]?.kind, 'init')
})

test('infers shapes without an event discriminator', () => {
  const p = new StreamJsonParser()
  const evs = p.feed('{"step_type":"text","text":"hi"}\n{"status":"DONE","response":"done","usage":{"total_tokens":9}}\n')
  assert.equal(asStep(evs[0]).stepKind, 'text')
  assert.equal(asResult(evs[1]).ok, true)
})

test('numeric step_type map (14=thinking, 15=text, 5=tool)', () => {
  const p = new StreamJsonParser()
  const evs = p.feed('{"event":"step_update","idx":1,"step_type":14,"text":"deep"}\n{"event":"step_update","idx":2,"step_type":15,"text":"out"}\n{"event":"step_update","idx":3,"step_type":5,"tool_info":{"name":"bash","parameters":{"cmd":"ls"}}}\n')
  assert.equal(asStep(evs[0]).stepKind, 'thinking')
  assert.equal(asStep(evs[1]).stepKind, 'text')
  const tool = asStep(evs[2])
  assert.equal(tool.stepKind, 'tool')
  assert.equal(tool.tool?.name, 'bash')
})
