// HTTP contract of the external credential-lease API (/plugins/agy-link/lease*):
// gating, validation, status codes and the discovery file. Handlers are called
// directly with fake req/res; the slot is a no-op under node:test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AccountPoolManager } from '../src/host/pool.ts'
import { defaultConfig } from '../src/common/types.ts'
import type { HostServices } from '../src/host/services.ts'
import type { Route } from '../src/transport/http/respond.ts'
import { register } from '../src/transport/http/routes/lease.ts'
import { linkEndpointPath } from '../src/host/external-lease.ts'

function setup(t: test.TestContext, port?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lease-routes-'))
  const pool = new AccountPoolManager(dir)
  const second = pool.createAccountSlot('Second')
  const routes: Route[] = []
  const services = { pool, getConfig: () => defaultConfig(), log: () => undefined } as unknown as HostServices
  const dispose = register((r) => routes.push(r), services, port)
  t.after(() => {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const call = async (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
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
  return { dir, pool, second, routes, dispose, call }
}

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
  assert.equal(typeof account.proxyUrl, 'string')
  const leaseId = a.json.leaseId as string

  const list = await s.call('/lease', 'GET')
  assert.deepEqual((list.json.leases as Array<Record<string, unknown>>).map((l) => [l.leaseId, l.holder, l.accountId]), [[leaseId, 'conductor', s.second.id]])

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

test('lease routes: discovery file is written for a known port and removed on dispose', (t) => {
  const s = setup(t, 43210)
  const file = linkEndpointPath(s.dir)
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.equal(doc.url, 'http://127.0.0.1:43210/plugins/agy-link')
  assert.equal(doc.pid, process.pid)
  assert.equal(typeof doc.startedAt, 'number')
  s.dispose()
  assert.equal(existsSync(file), false)
})

test('lease routes: no port → no discovery file', (t) => {
  const s = setup(t)
  assert.equal(existsSync(linkEndpointPath(s.dir)), false)
})
