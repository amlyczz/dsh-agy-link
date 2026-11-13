// Regression: the console's "同步中" spinner used to spin forever.
//
// Three independent causes, all covered here:
//  1. client writes (`postJson`) had NO timeout, so `loadingAction`'s finally
//     never ran when the host never answered;
//  2. host async routes were bare `void (async () => …)()` IIFEs — a thrown
//     dependency became an unhandled rejection and NO HTTP response at all;
//  3. `refresh-quota` awaited a 20s CLI spawn + several REST calls before
//     answering, so even the happy path looked hung.
import test from 'node:test'
import assert from 'node:assert/strict'

import { runRoute, sendJson, ROUTE_TIMEOUT_MS } from '../src/transport/http/respond.ts'
import type { RawRes } from '../src/transport/http/respond.ts'
import { timedSignal, STATUS_TIMEOUT_MS, WRITE_TIMEOUT_MS } from '../src/client/api.ts'

interface Reply {
  status: number
  body: unknown
  writes: number
  done: Promise<void>
}

function reply(): { res: RawRes; seen: () => Reply } {
  let status = 0
  let body: unknown = null
  let writes = 0
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const res: RawRes = {
    writeHead(s: number) {
      status = s
      writes += 1
      return undefined
    },
    end(b?: unknown) {
      body = b
      resolveDone()
      return undefined
    },
  }
  return { res, seen: () => ({ status, body: body === undefined ? null : JSON.parse(String(body)), writes, done }) }
}

test('runRoute answers 500 when the body rejects, instead of leaving the socket open', async () => {
  const { res, seen } = reply()
  runRoute(res, async () => { throw new Error('quota pipeline exploded') })
  await seen().done
  assert.equal(seen().status, 500)
  assert.deepEqual(seen().body, { ok: false, error: 'quota pipeline exploded' })
})

test('runRoute answers 504 on a hung body (hard deadline)', async () => {
  const { res, seen } = reply()
  runRoute(res, () => new Promise<void>(() => undefined), 10)
  await seen().done
  assert.equal(seen().status, 504)
  assert.deepEqual(seen().body, { ok: false, error: 'request timed out' })
})

test('sendJson is exactly-once: a late body cannot write a second head after a timeout', async () => {
  const { res, seen } = reply()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  runRoute(res, async () => {
    await gate
    sendJson(res, 200, { ok: true, late: true })
  }, 10)
  await seen().done
  assert.equal(seen().status, 504, 'the deadline response wins')
  release()
  await new Promise((r) => setTimeout(r, 20))
  // writeHead must have been called exactly once — a second one would throw
  // ERR_HTTP_HEADERS_SENT on a real Node response.
  assert.equal(seen().writes, 1)
})

test('runRoute leaves a normal response untouched', async () => {
  const { res, seen } = reply()
  runRoute(res, async () => { sendJson(res, 200, { ok: true, pool: { accounts: [] } }) })
  await seen().done
  assert.equal(seen().status, 200)
  assert.equal(seen().writes, 1)
})

test('timeouts are ordered so the client gives up AFTER the host can still answer', () => {
  assert.ok(STATUS_TIMEOUT_MS < WRITE_TIMEOUT_MS, 'status polls stay snappier than writes')
  assert.ok(WRITE_TIMEOUT_MS < ROUTE_TIMEOUT_MS, 'host deadline is the last resort, not first')
  assert.ok(ROUTE_TIMEOUT_MS >= 20_000, 'agy /usage alone has a 20s cap')
})

test('timedSignal produces an abortable signal (or undefined where unsupported)', () => {
  const sig = timedSignal(50) as AbortSignal | undefined
  if (sig !== undefined) {
    assert.equal(sig.aborted, false)
    assert.equal(typeof sig.addEventListener, 'function')
  }
})
