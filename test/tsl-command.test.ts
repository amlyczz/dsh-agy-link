import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTslArgs, tslCommandDefinition } from '../src/host/tsl-command.ts'
import { defaultConfig } from '../src/common/types.ts'

test('parse: bare /tsl means the last completed turn', () => {
  const a = parseTslArgs('')
  assert.equal(a.turn, undefined)
  assert.equal(a.text, undefined)
  assert.equal(a.persist, true)
  assert.equal(a.full, false)
})

test('parse: turn number, flags and explicit model/effort', () => {
  const a = parseTslArgs('3 --full --print --no-persist --force --model claude-sonnet-4-6 --effort medium --lang English')
  assert.equal(a.turn, 3)
  assert.equal(a.full, true)
  assert.equal(a.print, true)
  assert.equal(a.persist, false)
  assert.equal(a.force, true)
  assert.equal(a.model, 'claude-sonnet-4-6')
  assert.equal(a.effort, 'medium')
  assert.equal(a.lang, 'English')
})

test('parse: auto switch and help', () => {
  assert.equal(parseTslArgs('auto on').auto, 'on')
  assert.equal(parseTslArgs('auto off').auto, 'off')
  assert.equal(parseTslArgs('auto').auto, 'status')
  assert.equal(parseTslArgs('help').help, true)
})

test('parse: free text is translated verbatim (flags never leak into it)', () => {
  const a = parseTslArgs('这是一段  黑话 --print')
  assert.equal(a.text, '这是一段 黑话')
  assert.equal(a.print, true)
})

test('parse: --text consumes the rest of the line', () => {
  const a = parseTslArgs('--text hello world --not-a-flag')
  assert.equal(a.text, 'hello world --not-a-flag')
})

test('command declares an input hint so the composer dispatches /tsl <args>', () => {
  const def = tslCommandDefinition({
    cfg: () => defaultConfig(),
    translate: () => ({}) as never,
    setOverride: () => undefined,
    sessionAuto: { get: () => undefined, set: () => undefined },
  })
  assert.equal(def.name, 'tsl')
  assert.ok(def.input)
  assert.match(def.input!.hint, /auto/)
  assert.match(def.input!.hint, /--full/)
})

function makeDeps(result: Record<string, unknown>, captured: { calls: Array<Record<string, unknown>> }) {
  const service = {
    translate: async (req: Record<string, unknown>) => {
      captured.calls.push({ kind: 'text', ...req })
      return { ok: true, text: '人话版', model: 'gemini-3.8-flash', effort: 'high', cached: false, durationMs: 1200, ...result }
    },
    translateLastTurn: async (_id: string, opts: Record<string, unknown>) => {
      captured.calls.push({ kind: 'last', ...opts })
      return { ok: true, text: '人话版', model: 'gemini-3.8-flash', effort: 'high', cached: false, durationMs: 1200, recordSeq: 42, turn: 1, ...result }
    },
    translateTurn: async (_id: string, turn: number, opts: Record<string, unknown>) => {
      captured.calls.push({ kind: 'turn', turn, ...opts })
      return { ok: true, text: '人话版', model: 'gemini-3.8-flash', effort: 'high', cached: false, durationMs: 1200, recordSeq: 42, turn, ...result }
    },
  }
  const deps = {
    cfg: () => defaultConfig(),
    translate: () => service as never,
    setOverride: () => undefined,
    sessionAuto: { get: () => undefined, set: () => undefined },
    sessions: () => ({ get: () => ({ id: 's1', log: [] }) }),
  }
  return deps
}

function invocation(rawInput: string, withAgent = true) {
  return {
    rawInput,
    ...(withAgent
      ? { agent: { id: 's1', session: { id: 's1', log: [] } } }
      : {}),
  } as never
}

test('/tsl returns a concise status when the card record was persisted', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(makeDeps({}, captured) as never)
  const res = await def.handler(invocation(''))
  assert.equal(res.kind, 'success')
  assert.match(res.text ?? '', /已生成译文/)
  assert.match(res.text ?? '', /gemini-3\.8-flash/)
  assert.match(res.text ?? '', /Gemini 译文/)
  // No body duplication when the card exists.
  assert.ok(!(res.text ?? '').includes('人话版'))
  assert.equal(captured.calls[0]?.kind, 'last')
})

test('/tsl 3 targets that turn', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(makeDeps({}, captured) as never)
  const res = await def.handler(invocation('3'))
  assert.equal(res.kind, 'success')
  assert.equal(captured.calls[0]?.kind, 'turn')
  assert.equal(captured.calls[0]?.turn, 3)
})

test('/tsl --text prints the translation body', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(makeDeps({}, captured) as never)
  const res = await def.handler(invocation('--text 一段黑话'))
  assert.equal(res.kind, 'success')
  assert.match(res.text ?? '', /人话版/)
  assert.equal(captured.calls[0]?.kind, 'text')
})

test('/tsl --print also echoes the body for a persisted turn', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(makeDeps({}, captured) as never)
  const res = await def.handler(invocation('--print'))
  assert.match(res.text ?? '', /人话版/)
})

test('/tsl surfaces a friendly error when the turn is empty', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(
    makeDeps({ ok: false, code: 'TURN_NOT_FOUND', error: 'no text', text: '' }, captured) as never,
  )
  const res = await def.handler(invocation(''))
  assert.equal(res.kind, 'error')
  assert.match(res.text ?? '', /没有可翻译/)
})

test('/tsl surfaces a friendly error when the turn is still running', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(
    makeDeps({ ok: false, code: 'TRANSIENT', error: 'running', text: '' }, captured) as never,
  )
  const res = await def.handler(invocation(''))
  assert.equal(res.kind, 'error')
  assert.match(res.text ?? '', /还没结束/)
})

test('/tsl auto on writes the per-session override', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const written: Array<{ id: string; value: boolean | undefined }> = []
  const deps = {
    ...makeDeps({}, captured),
    sessionAuto: { get: () => undefined, set: (id: string, value: boolean | undefined) => written.push({ id, value }) },
  }
  const def = tslCommandDefinition(deps as never)
  const res = await def.handler(invocation('auto on'))
  assert.equal(res.kind, 'success')
  assert.deepEqual(written, [{ id: 's1', value: true }])
  // The switch catches up on the last completed turn immediately.
  assert.equal(captured.calls.some((call) => call.kind === 'last'), true)
})

test('/tsl outside a session fails clearly', async () => {
  const captured = { calls: [] as Array<Record<string, unknown>> }
  const def = tslCommandDefinition(makeDeps({}, captured) as never)
  const res = await def.handler(invocation('', false))
  assert.equal(res.kind, 'error')
  assert.match(res.text ?? '', /当前会话/)
})
