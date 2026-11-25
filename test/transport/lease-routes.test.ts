// HTTP contract of the external credential-lease API (/plugins/agy-link/lease*):
// gating, validation, status codes and the discovery file. Handlers are called
// directly with fake req/res; the slot is a no-op under node:test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { defaultConfig } from '../../src/common/types.ts'
import type { HostServices } from '../../src/host/services.ts'
import type { Route } from '../../src/transport/http/respond.ts'
import { register } from '../../src/transport/http/routes/lease.ts'
import { hasLeaseBearer, linkEndpointPath } from '../../src/host/external-lease.ts'

/** `port: null` registers without a discovery file (and so without a reachable token). */
function setup(t: test.TestContext, port: number | null = 43210) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lease-routes-'))
  const pool = new AccountPoolManager(dir)
  const second = pool.createAccountSlot('Second')
  const routes: Route[] = []
  const services = {
    pool,
    getConfig: () => defaultConfig(),
    log: () => undefined,
    resolveVersion: async () => '1.5.12',
    quota: { prepareIsolatedCliToken: async () => true },
  } as unknown as HostServices
  const dispose = register((r) => routes.push(r), services, port ?? undefined)
  const token = port === null ? '' : (JSON.parse(readFileSync(linkEndpointPath(dir), 'utf8')) as { token: string }).token
  t.after(() => {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  // Every call carries the published token unless the test passes its own `authorization`.
  const call = async (path: string, method: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { authorization: 'Bearer ' + token, ...extra }
    const route = routes.find((r) => r.path === '/plugins/agy-link' + path)
    assert.ok(route, 'route registered: ' + path)
    let status = 0
    let text = ''
    let resolveDone = () => {}
    const done = new Promise<void>((r) => { resolveDone = r })
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = {
      method,
      headers,
      on(event: string, cb: (chunk?: Buffer) => void) {
        if (event === 'data') for (const c of raw) cb(c)
        if (event === 'end') cb()
      },
    }
    const res = {
      writeHead(s: number) { status = s },
      end(b?: unknown) { text = typeof b === 'string' ? b : ''; resolveDone() },
    }
    route.handler(req, res)
    await done
    return { status, json: JSON.parse(text) as Record<string, unknown> }
  }
  return { dir, pool, second, routes, dispose, call, token }
}

test('lease routes: no or wrong bearer token → 401 before the origin and method gates', async (t) => {
  const s = setup(t)
  assert.match(s.token, /^[0-9a-f]{64}$/)
  const wrong = 'f'.repeat(64) === s.token ? 'e'.repeat(64) : 'f'.repeat(64)
  const denied: Array<Record<string, string>> = [
    { authorization: '' },
    { authorization: 'Bearer' },
    { authorization: 'Bearer ' + wrong },
    { authorization: 'Bearer ' + s.token.slice(0, 63) },
    { authorization: 'Basic ' + s.token },
    { authorization: 'Bearer ' + wrong, origin: 'https://evil.example' },
  ]
  for (const [path, method] of [['/lease/acquire', 'POST'], ['/lease/renew', 'POST'], ['/lease/release', 'POST'], ['/lease', 'GET'], ['/lease/acquire', 'GET']] as const) {
    for (const headers of denied) {
      const r = await s.call(path, method, { holder: 'h', leaseId: 'x' }, headers)
      assert.equal(r.status, 401, path + ' ' + method + ' ' + JSON.stringify(headers))
      assert.equal(r.json.code, 'unauthorized')
      assert.equal(JSON.stringify(r.json).includes(s.token), false, 'the token never echoes back')
    }
  }
  // The scheme name is case-insensitive (RFC 9110); nothing was leased by the denied calls.
  const list = await s.call('/lease', 'GET', undefined, { authorization: 'bearer ' + s.token })
  assert.deepEqual([list.status, list.json.leases], [200, []])
})

test('lease routes: without a discovery file the API is unreachable', async (t) => {
  const s = setup(t, null)
  const r = await s.call('/lease/acquire', 'POST', { holder: 'h' })
  assert.equal(r.status, 401)
})

test('lease routes: method and cross-origin gates answer the {ok,code,error} envelope', async (t) => {
  const s = setup(t)
  assert.deepEqual(s.routes.map((r) => r.path).sort(), [
    '/plugins/agy-link/lease',
    '/plugins/agy-link/lease/acquire',
    '/plugins/agy-link/lease/release',
    '/plugins/agy-link/lease/renew',
  ])
  for (const path of ['/lease/acquire', '/lease/renew', '/lease/release']) {
    const r = await s.call(path, 'GET')
    assert.equal(r.status, 405, path)
    assert.deepEqual(r.json, { ok: false, code: 'method_not_allowed', error: 'POST only' })
  }
  assert.equal((await s.call('/lease', 'POST', {})).status, 405)
  const xo = await s.call('/lease/acquire', 'POST', { holder: 'h' }, { origin: 'https://evil.example' })
  assert.equal(xo.status, 403)
  assert.equal(xo.json.code, 'cross_origin')
  const local = await s.call('/lease/acquire', 'POST', { holder: 'h' }, { origin: 'http://127.0.0.1:3000' })
  assert.equal(local.status, 200)
})

test('lease routes: body validation → 400', async (t) => {
  const s = setup(t)
  const bad: Array<[string, unknown, string]> = [
    ['/lease/acquire', 'not json', 'invalid_json'],
    ['/lease/acquire', {}, 'invalid_request'],
    ['/lease/acquire', { holder: '   ' }, 'invalid_request'],
    ['/lease/acquire', { holder: 'x'.repeat(201) }, 'invalid_request'],
    ['/lease/acquire', { holder: 'h', ttlMs: '60000' }, 'invalid_request'],
    ['/lease/acquire', { holder: 'h', waitMs: 0 }, 'invalid_request'],
    ['/lease/acquire', { holder: 'h', accountId: 7 }, 'invalid_request'],
    ['/lease/renew', {}, 'invalid_request'],
    ['/lease/renew', { leaseId: 'a', ttlMs: 'soon' }, 'invalid_request'],
    ['/lease/release', { leaseId: 'a', ok: 'yes' }, 'invalid_request'],
    ['/lease/release', { leaseId: 'a', error: 5 }, 'invalid_request'],
  ]
  for (const [path, body, code] of bad) {
    const r = await s.call(path, 'POST', body)
    assert.equal(r.status, 400, path + ' ' + JSON.stringify(body))
    assert.equal(r.json.ok, false)
    assert.equal(r.json.code, code, path + ' ' + JSON.stringify(body))
  }
})

test('lease routes: acquire → list → renew → release, then 404 lease_not_found', async (t) => {
  const s = setup(t)
  const a = await s.call('/lease/acquire', 'POST', { holder: 'conductor', accountId: s.second.id, ttlMs: 30_000 })
  assert.equal(a.status, 200, JSON.stringify(a.json))
  assert.equal(a.json.ok, true)
  assert.equal(a.json.ttlMs, 30_000)
  const account = a.json.account as Record<string, unknown>
  assert.equal(account.id, s.second.id)
  assert.equal(account.home, s.second.dir)
  assert.equal(account.primary, false)
  assert.equal(account.isolated, true)
  assert.equal(typeof account.proxyUrl, 'string')
  assert.equal(a.json.slot, false, 'agy >= 1.5 isolated account: no slot')
  assert.equal((a.json.env as Record<string, string>).SSH_CONNECTION, '127.0.0.1 0 127.0.0.1 0')
  const leaseId = a.json.leaseId as string

  const list = await s.call('/lease', 'GET')
  assert.deepEqual((list.json.leases as Array<Record<string, unknown>>).map((l) => [l.leaseId, l.holder, l.accountId, l.slot]), [[leaseId, 'conductor', s.second.id, false]])

  const renew = await s.call('/lease/renew', 'POST', { leaseId })
  assert.equal(renew.status, 200)
  assert.equal(typeof renew.json.expiresAt, 'number')

  const rel = await s.call('/lease/release', 'POST', { leaseId, ok: true, model: 'gemini-3-flash' })
  assert.deepEqual([rel.status, rel.json], [200, { ok: true, outcome: 'success' }])
  for (const path of ['/lease/release', '/lease/renew']) {
    const again = await s.call(path, 'POST', { leaseId })
    assert.equal(again.status, 404)
    assert.equal(again.json.code, 'lease_not_found')
  }
})

test('lease routes: pinned unknown account → 404, nothing selectable → 503 with retryAfterMs', async (t) => {
  const s = setup(t)
  const nf = await s.call('/lease/acquire', 'POST', { holder: 'h', accountDir: join(s.dir, 'nope') })
  assert.equal(nf.status, 404)
  assert.equal(nf.json.code, 'account_not_found')
  const reset = new Date(Date.now() + 600_000).toISOString()
  for (const acc of s.pool.getAccounts()) s.pool.recordFailure(acc.id, 'google', 'quota exhausted', reset)
  const none = await s.call('/lease/acquire', 'POST', { holder: 'h' })
  assert.equal(none.status, 503)
  assert.equal(none.json.code, 'no_account')
  assert.ok((none.json.retryAfterMs as number) > 0)
  assert.equal('status' in none.json, false, 'the HTTP status is not echoed in the body')
})

test('lease routes: discovery file is private, carries the token, and is removed on dispose', (t) => {
  const s = setup(t, 43210)
  const file = linkEndpointPath(s.dir)
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.equal(doc.url, 'http://127.0.0.1:43210/plugins/agy-link')
  assert.equal(doc.pid, process.pid)
  assert.equal(typeof doc.startedAt, 'number')
  assert.equal(doc.token, s.token)
  if (process.platform !== 'win32') {
    const st = statSync(file)
    assert.equal(st.mode & 0o777, 0o600)
    assert.equal(st.uid, process.getuid!())
  }
  s.dispose()
  assert.equal(existsSync(file), false)
})

test('lease routes: each plugin start publishes a new token', (t) => {
  const a = setup(t, 43210)
  const b = setup(t, 43211)
  assert.notEqual(a.token, b.token)
})

test('lease routes: no port → no discovery file', (t) => {
  const s = setup(t, null)
  assert.equal(existsSync(linkEndpointPath(s.dir)), false)
})

test('hasLeaseBearer: exact token only, constant-time compare', () => {
  const tok = 'a'.repeat(64)
  assert.equal(hasLeaseBearer('Bearer ' + tok, tok), true)
  assert.equal(hasLeaseBearer('Bearer   ' + tok + '  ', tok), true)
  assert.equal(hasLeaseBearer('Bearer ' + tok + 'a', tok), false)
  assert.equal(hasLeaseBearer('Bearer ' + tok + ' extra', tok), false)
  assert.equal(hasLeaseBearer(['Bearer ' + tok], tok), false)
  assert.equal(hasLeaseBearer(undefined, tok), false)
  assert.equal(hasLeaseBearer('Bearer ', ''), false, 'an empty token never authorizes')
})
