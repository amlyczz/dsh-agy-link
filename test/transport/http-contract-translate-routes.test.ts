// /translate and its /pending, /turn, /state companions.
//
// Pins the long turn budget (no 504 at 30s), strict body parsing, result-code to
// status mapping, and the query-parameter validation of the read-only probes.
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { capture, fakeReq, rawReq, oversizedReq, invoke, setup } from './http-contract-helpers.ts'

test('/translate waits out a slow agy turn instead of answering 504 at 30s', async () => {
  // A translation is a full agy turn (translateTimeoutMs defaults to 120s).
  // The general ROUTE_TIMEOUT_MS would answer 504 first and, because sendJson
  // is exactly-once, discard the real 200 — every slow "译成人话" looked like
  // a failure. Fake timers let us cross 30s without a 31-second test.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const s = setup({
      translation: {
        translate: async () => { await gate; return { ok: true, text: '译文' } },
        pendingFor: () => [], stats: () => ({}), isPending: () => false,
        existingTurn: () => null, existingMessage: () => null,
      },
    }, { translateTimeoutMs: 120_000 })
    const captured = capture()
    s.route('/plugins/agy-link/translate').handler(fakeReq('POST', '/', { text: 'hello' }), captured.res)
    // Let readBody + the async route body reach the pending translation.
    for (let i = 0; i < 6; i++) await Promise.resolve()
    mock.timers.tick(31_000)
    await Promise.resolve()
    assert.equal(captured.status(), 0, 'no 504 may be written while the job is still running')
    finish()
    await captured.done
    assert.equal(captured.status(), 200, 'the real translation result wins')
    assert.equal((captured.json() as Record<string, unknown>).ok, true)
  } finally {
    mock.timers.reset()
  }
})

test('/translate is strict about JSON and dispatches to the right translation call', async () => {
  const calls: Array<[string, unknown[]]> = []
  const make = (result: unknown) => async (...args: unknown[]) => {
    calls.push(['_', args])
    return result
  }
  const s = setup({
    translation: {
      pendingFor: () => [],
      stats: () => ({}),
      isPending: () => false,
      existingTurn: () => null,
      existingMessage: () => null,
      translate: make({ ok: true, text: 'translated' }),
      translateMessage: make({ ok: true, text: 'message' }),
      translateTurn: make({ ok: true, text: 'turn' }),
      translateLastTurn: make({ ok: true, text: 'last' }),
    },
  })
  const route = s.route('/plugins/agy-link/translate')

  const malformed = await invoke(route, rawReq('POST', '/', [Buffer.from('{oops')]))
  assert.equal(malformed.status(), 400)
  assert.deepEqual(malformed.json(), { error: 'invalid JSON body' })

  const oversized = await invoke(route, oversizedReq('POST'))
  assert.equal(oversized.status(), 400)
  assert.deepEqual(oversized.json(), { error: 'invalid JSON body' })

  const noSelector = await invoke(route, fakeReq('POST', '/', {}))
  assert.equal(noSelector.status(), 400)
  assert.deepEqual(noSelector.json(), { error: 'text, or sessionId (+ turn/messageId), is required' })

  const text = await invoke(route, fakeReq('POST', '/', { text: 'hello' }))
  assert.equal(text.status(), 200)
  assert.deepEqual(text.json(), { ok: true, text: 'translated' })

  const byMessage = await invoke(route, fakeReq('POST', '/', { sessionId: 's', messageId: 'm' }))
  assert.equal(byMessage.status(), 200)

  const byTurn = await invoke(route, fakeReq('POST', '/', { sessionId: 's', turn: 3 }))
  assert.equal(byTurn.status(), 200)

  const byLast = await invoke(route, fakeReq('POST', '/', { sessionId: 's' }))
  assert.equal(byLast.status(), 200)
})

test('/translate maps result codes to 200/409/400/502 and thrown failures to 500', async () => {
  const results: Array<{ result?: unknown; throw?: boolean }> = [
    { result: { ok: true, text: 'x' } },
    { result: { ok: false, code: 'TRANSIENT', error: 'try again' } },
    { result: { ok: false, code: 'TURN_NOT_FOUND', error: 'no turn' } },
    { result: { ok: false, code: 'MESSAGE_NOT_FOUND', error: 'no message' } },
    { result: { ok: false, code: 'EMPTY_TEXT', error: 'empty' } },
    { result: { ok: false, code: 'SOMETHING_ELSE', error: 'upstream' } },
    { throw: true },
  ]
  const expected = [200, 409, 400, 400, 400, 502, 500]
  for (let i = 0; i < results.length; i++) {
    const spec = results[i]!
    const s = setup({
      translation: {
        pendingFor: () => [],
        stats: () => ({}),
        isPending: () => false,
        existingTurn: () => null,
        existingMessage: () => null,
        translate: async () => {
          if (spec.throw === true) throw new Error('translate exploded')
          return spec.result
        },
      },
    })
    const captured = await invoke(s.route('/plugins/agy-link/translate'), fakeReq('POST', '/', { text: 'hi' }))
    assert.equal(captured.status(), expected[i], 'case ' + i)
  }
})

test('/translate/pending answers items/stats and forwards the session filter', async () => {
  const filters: unknown[] = []
  const s = setup({
    translation: {
      pendingFor: (session?: string) => {
        filters.push(session)
        return [{ id: '1' }]
      },
      stats: () => ({ total: 1 }),
      isPending: () => false,
      existingTurn: () => null,
      existingMessage: () => null,
    },
  })
  const noSession = await invoke(s.route('/plugins/agy-link/translate/pending'), fakeReq('GET'))
  assert.equal(noSession.status(), 200)
  assert.deepEqual(noSession.json(), { items: [{ id: '1' }], stats: { total: 1 } })

  const withSession = await invoke(s.route('/plugins/agy-link/translate/pending'), fakeReq('GET', '/?session=abc'))
  assert.equal(withSession.status(), 200)
  assert.deepEqual(filters, [undefined, 'abc'])

  // A malformed percent-escape in the query is returned verbatim, not thrown.
  const malformedEscape = await invoke(s.route('/plugins/agy-link/translate/pending'), fakeReq('GET', '/?session=%E0%A4%A'))
  assert.equal(malformedEscape.status(), 200)
  assert.deepEqual(filters.at(-1), '%E0%A4%A')
})

test('/translate/turn validates session+turn and reports idle/ready', async () => {
  const existing: Array<Record<string, unknown> | null> = [null, { seq: 7, model: 'm', effort: 'high' }]
  let call = 0
  const s = setup({
    translation: {
      pendingFor: () => [],
      stats: () => ({}),
      isPending: () => false,
      existingTurn: () => existing[call++] ?? null,
      existingMessage: () => null,
    },
  })
  const route = s.route('/plugins/agy-link/translate/turn')

  const missing = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missing.status(), 400)
  assert.deepEqual(missing.json(), { error: 'session and turn are required' })

  // Number('') === 0 and Number.isFinite(0) is true: a missing or empty `turn`
  // is accepted as turn 0 (current contract; only a non-numeric turn rejects).
  const missingTurn = await invoke(route, fakeReq('GET', '/?session=s'))
  assert.equal(missingTurn.status(), 200)
  assert.deepEqual(missingTurn.json(), { state: 'idle' })

  const invalidTurn = await invoke(route, fakeReq('GET', '/?session=s&turn=abc'))
  assert.equal(invalidTurn.status(), 400)
  assert.deepEqual(invalidTurn.json(), { error: 'session and turn are required' })

  call = 0
  const idle = await invoke(route, fakeReq('GET', '/?session=s&turn=2'))
  assert.equal(idle.status(), 200)
  assert.deepEqual(idle.json(), { state: 'idle' })

  const ready = await invoke(route, fakeReq('GET', '/?session=s&turn=2'))
  assert.equal(ready.status(), 200)
  assert.deepEqual(ready.json(), { state: 'ready', seq: 7, model: 'm', effort: 'high' })

  call = 0
  const emptyTurn = await invoke(route, fakeReq('GET', '/?session=s&turn='))
  assert.equal(emptyTurn.status(), 200)
  assert.deepEqual(emptyTurn.json(), { state: 'idle' })
})

test('/translate/state validates session+message and reports idle/busy/ready', async () => {
  const behaviors: Array<{ existing?: Record<string, unknown> | null; pending?: boolean }> = [
    { existing: null, pending: false },
    { existing: null, pending: true },
    { existing: { seq: 3, model: 'm', effort: '' } },
  ]
  let call = 0
  let current: { existing?: Record<string, unknown> | null; pending?: boolean } | undefined
  const s = setup({
    translation: {
      pendingFor: () => [],
      stats: () => ({}),
      isPending: () => current?.pending === true,
      existingTurn: () => null,
      existingMessage: () => {
        current = behaviors[call]
        call++
        return current?.existing ?? null
      },
    },
  })
  const route = s.route('/plugins/agy-link/translate/state')

  const missing = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missing.status(), 400)
  assert.deepEqual(missing.json(), { error: 'session and message are required' })

  const missingMessage = await invoke(route, fakeReq('GET', '/?session=s'))
  assert.equal(missingMessage.status(), 400)

  const idle = await invoke(route, fakeReq('GET', '/?session=s&message=m1'))
  assert.equal(idle.status(), 200)
  assert.deepEqual(idle.json(), { state: 'idle' })

  const busy = await invoke(route, fakeReq('GET', '/?session=s&message=m2'))
  assert.equal(busy.status(), 200)
  assert.deepEqual(busy.json(), { state: 'busy' })

  const ready = await invoke(route, fakeReq('GET', '/?session=s&message=m3'))
  assert.equal(ready.status(), 200)
  assert.deepEqual(ready.json(), { state: 'ready', seq: 3, model: 'm', effort: '' })
})
