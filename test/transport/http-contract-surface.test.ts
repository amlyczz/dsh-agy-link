// Route-table surface + method gating of /plugins/agy-link/*.
//
// Pins the frozen 48-entry route table, the registerRoutes disposer, and the
// per-route method contract (POST-only 405 vs. method-agnostic GET routes).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRoutes } from '../../src/transport/http/router.ts'
import { EXPECTED_ROUTES, POST_ONLY_ROUTES, fakeWebServer, fakeServices, fakeReq, invoke, setup } from './http-contract-helpers.ts'

test('registerRoutes exposes exactly the frozen route surface', () => {
  const webServer = fakeWebServer()
  const dispose = registerRoutes(webServer, fakeServices())
  assert.equal(webServer.routes.length, EXPECTED_ROUTES.length, 'route count changed')
  const actual = webServer.routes
    .map((r) => [r.kind, r.path] as const)
    .sort((a, b) => a[1].localeCompare(b[1]))
  const expected = [...EXPECTED_ROUTES].sort((a, b) => a[1].localeCompare(b[1]))
  assert.deepEqual(actual, expected)
  for (const route of webServer.routes) {
    assert.equal(typeof route.handler, 'function', 'handler must be a function: ' + route.path)
  }
  const paths = new Set(webServer.routes.map((r) => r.path))
  assert.equal(paths.size, EXPECTED_ROUTES.length, 'duplicate route path')
  assert.equal(typeof dispose, 'function')
})

test('the registerRoutes disposer tears every route down', () => {
  const webServer = fakeWebServer()
  const dispose = registerRoutes(webServer, fakeServices())
  dispose()
  assert.equal(webServer.disposed.length, EXPECTED_ROUTES.length)
  assert.deepEqual([...webServer.disposed].sort(), webServer.routes.map((r) => r.path).sort())
})

test('every POST-only route rejects GET/PUT/DELETE with 405 before touching services', async () => {
  const s = setup()
  for (const path of POST_ONLY_ROUTES) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const captured = await invoke(s.route(path), fakeReq(method))
      assert.equal(captured.status(), 405, path + ' ' + method)
      assert.deepEqual(captured.json(), { error: 'POST only' }, path + ' ' + method)
    }
  }
  // POST-only + 14 GET/method-agnostic routes (incl. /btw/state & /btw/stream) + 4 lease routes (their own
  // `{ok,code,error}` envelope; gated in test/lease-routes.test.ts).
  assert.equal(POST_ONLY_ROUTES.length + 14 + 4, EXPECTED_ROUTES.length)
})

test('GET-style routes do not gate on method (current contract, asserted verbatim)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-get-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'assets'), { recursive: true })
  const s = setup({ hostDir: root }, {})
  const cases: Array<[string, string, number]> = [
    ['/plugins/agy-link/status', '/', 200],
    ['/plugins/agy-link/session-view', '/?session=s', 200],
    ['/plugins/agy-link/pool', '/', 200],
    ['/plugins/agy-link/translate/pending', '/', 200],
    ['/plugins/agy-link/translate/turn', '/?session=s&turn=1', 200],
    ['/plugins/agy-link/translate/state', '/?session=s&message=m', 200],
    ['/plugins/agy-link/qr', '/', 404],
    ['/plugins/agy-link/mermaid.min.js', '/', 404],
    ['/plugins/agy-link/media', '/', 400],
    ['/plugins/agy-link/assets', '/plugins/agy-link/assets/none.js', 404],
  ]
  for (const [path, url, expected] of cases) {
    const captured = await invoke(s.route(path), fakeReq('POST', url))
    assert.notEqual(captured.status(), 405, path + ' must not reject POST')
    assert.equal(captured.status(), expected, path + ' POST status')
  }
})

test('a request without a method is treated as GET (methodOf default)', async () => {
  const s = setup()
  const noMethod = { url: '/', on: () => undefined }
  const captured = await invoke(s.route('/plugins/agy-link/config'), noMethod)
  assert.equal(captured.status(), 405)
  assert.deepEqual(captured.json(), { error: 'POST only' })
})
