// /embed and /ecosystem contract.
//
// Pins the confined widget CSP/bridge script and the ecosystem snapshot, sync and
// plugin-toggle endpoints.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeReq, invoke, setup } from './http-contract-helpers.ts'

test('/embed serves confined HTML widgets with strict CSP and bridge script', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-embed-route-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const widget = join(dir, 'chart.html')
  const nonHtml = join(dir, 'note.txt')
  const missingHtml = join(dir, 'nope.html')
  writeFileSync(widget, '<html><head></head><body><h1>Chart</h1></body></html>')
  writeFileSync(nonHtml, 'hello')

  const s = setup({}, { workspaceRoot: dir })
  const route = s.route('/plugins/agy-link/embed')

  const missing = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missing.status(), 400)

  const notFound = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(missingHtml)))
  assert.equal(notFound.status(), 404)

  const txtRes = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(nonHtml)))
  assert.equal(txtRes.status(), 403)

  const okRes = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(widget) + '&id=w1'))
  assert.equal(okRes.status(), 200)
  assert.match(okRes.headers()['Content-Security-Policy'] ?? '', /default-src 'none'/)
  assert.match(okRes.text(), /agy-embed-resize/)
  assert.match(okRes.text(), /"w1"/)
})

test('/ecosystem routes return snapshot, run sync, and toggle plugin state', async () => {
  const s = setup()
  const getEco = s.route('/plugins/agy-link/ecosystem')
  const postBlocked = await invoke(getEco, fakeReq('POST', '/'))
  assert.equal(postBlocked.status(), 405)

  const ecoRes = await invoke(getEco, fakeReq('GET', '/'))
  assert.equal(ecoRes.status(), 200)
  assert.equal((ecoRes.json() as { ok?: boolean }).ok, true)

  const syncRes = await invoke(s.route('/plugins/agy-link/ecosystem/sync'), fakeReq('POST', '/', {}))
  assert.equal(syncRes.status(), 200)
  assert.equal((syncRes.json() as { ok?: boolean }).ok, true)

  const toggleRoute = s.route('/plugins/agy-link/ecosystem/plugin')
  const badToggle = await invoke(toggleRoute, fakeReq('POST', '/', { id: 'p1' }))
  assert.equal(badToggle.status(), 400)

  const okToggle = await invoke(toggleRoute, fakeReq('POST', '/', { id: 'p1', enabled: false }))
  assert.equal(okToggle.status(), 200)
  const snap = (okToggle.json() as { snapshot: { plugins: Array<{ id: string; enabled: boolean }> } }).snapshot
  assert.equal(snap.plugins[0]?.id, 'p1')
  assert.equal(snap.plugins[0]?.enabled, false)
})
