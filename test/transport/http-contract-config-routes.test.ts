// /config contract: the single guarded settings endpoint.
//
// Pins key allow-listing, per-key validation, the picker-refresh policy and the
// deliberately lax free-form body handling of the current implementation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeReq, rawReq, oversizedReq, invoke, setup } from './http-contract-helpers.ts'

test('/config is POST-only and validates keys before writing', async () => {
  const writes: Array<[string, unknown]> = []
  const configWrites: Array<[string, unknown]> = []
  let pickerEvents = 0
  const s = setup({
    setOverride: (key: string, value: unknown) => {
      writes.push([key, value])
    },
    onConfigWritten: (key: string, value: unknown) => {
      configWrites.push([key, value])
    },
    notifyPicker: () => {
      pickerEvents++
    },
  })
  const route = s.route('/plugins/agy-link/config')

  const wrongMethod = await invoke(route, fakeReq('GET'))
  assert.equal(wrongMethod.status(), 405)
  assert.deepEqual(wrongMethod.json(), { error: 'POST only' })
  assert.equal(writes.length, 0)

  const unknownKey = await invoke(route, fakeReq('POST', '/', { key: 'notAKey', value: 1 }))
  assert.equal(unknownKey.status(), 400)
  assert.deepEqual(unknownKey.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)

  const missingKey = await invoke(route, fakeReq('POST', '/', { value: 1 }))
  assert.equal(missingKey.status(), 400)
  assert.deepEqual(missingKey.json(), { error: 'key not settable' })

  const badDisplay = await invoke(route, fakeReq('POST', '/', { key: 'translateDisplay', value: 'inline' }))
  assert.equal(badDisplay.status(), 400)
  assert.deepEqual(badDisplay.json(), { error: 'translateDisplay must be card or replace' })

  const badArray = await invoke(route, fakeReq('POST', '/', { key: 'hiddenModels', value: 'nope' }))
  assert.equal(badArray.status(), 400)
  assert.deepEqual(badArray.json(), { error: 'hiddenModels must be an array of model ids' })
  assert.equal(writes.length, 0)

  // issue #131: the allow-list is validated exactly like the deny-list.
  const badSelected = await invoke(route, fakeReq('POST', '/', { key: 'selectedModels', value: ['ok', 1] }))
  assert.equal(badSelected.status(), 400)
  assert.deepEqual(badSelected.json(), { error: 'selectedModels must be an array of model ids' })
  assert.equal(writes.length, 0)

  const badWarmup = await invoke(route, fakeReq('POST', '/', { key: 'warmupModels', value: ['ok', 1] }))
  assert.equal(badWarmup.status(), 400)
  assert.deepEqual(badWarmup.json(), { error: 'warmupModels must be an array of model names' })
  assert.equal(writes.length, 0)

  const ok = await invoke(route, fakeReq('POST', '/', { key: 'defaultEffort', value: 'high' }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(ok.json(), { ok: true, key: 'defaultEffort', value: 'high' })
  assert.deepEqual(writes, [['defaultEffort', 'high']])
  assert.deepEqual(configWrites, [['defaultEffort', 'high']])
  assert.equal(pickerEvents, 0, 'unrelated keys must not announce a picker update')

  const hidden = await invoke(route, fakeReq('POST', '/', { key: 'hiddenModels', value: ['gemini-3.7-flash'] }))
  assert.equal(hidden.status(), 200)
  assert.equal(pickerEvents, 1, 'hiddenModels writes must announce the picker update')

  const warmup = await invoke(route, fakeReq('POST', '/', { key: 'warmupModels', value: ['gemini-3-flash'] }))
  assert.equal(warmup.status(), 200)
  assert.equal(pickerEvents, 1, 'warmupModels writes must not announce the picker update')

  // issue #105: both visibility switches are settable through the same guarded
  // endpoint; neither is a picker event.
  for (const [key, value] of [['showHeaderBadge', false], ['showTranslateAction', false], ['translateDisplay', 'replace'], ['btwModel', 'gemini-4-hydrogen'], ['btwEffort', 'medium']] as const) {
    const res = await invoke(route, fakeReq('POST', '/', { key, value }))
    assert.equal(res.status(), 200, key + ' must be an allowed config key')
    assert.deepEqual(res.json(), { ok: true, key, value })
    assert.deepEqual(writes.at(-1), [key, value])
  }
  const badBtwEffort = await invoke(route, fakeReq('POST', '/', { key: 'btwEffort', value: 'turbo' }))
  assert.equal(badBtwEffort.status(), 400)
  // issue #108/#109: toggling the pool-wide catalog CHANGES the visible model
  // set, so it must announce a picker update (otherwise the cached picker
  // keeps showing the old account's models until a restart).
  const wide = await invoke(route, fakeReq('POST', '/', { key: 'poolWideCatalog', value: true }))
  assert.equal(wide.status(), 200)
  assert.deepEqual(writes.at(-1), ['poolWideCatalog', true])
  assert.equal(pickerEvents, 2, 'poolWideCatalog must refresh the model picker like hiddenModels')

  // issue #131: ticking a subset changes the picker contents too.
  const selected = await invoke(route, fakeReq('POST', '/', { key: 'selectedModels', value: ['gemini-3.7-flash'] }))
  assert.equal(selected.status(), 200)
  assert.deepEqual(writes.at(-1), ['selectedModels', ['gemini-3.7-flash']])
  assert.equal(pickerEvents, 3, 'selectedModels writes must announce the picker update')
})

test('/config treats malformed and oversized bodies as empty (non-strict read)', async () => {
  const writes: unknown[] = []
  const s = setup({ setOverride: (...args: unknown[]) => writes.push(args) })
  const route = s.route('/plugins/agy-link/config')

  const malformed = await invoke(route, rawReq('POST', '/', [Buffer.from('{not json')]))
  assert.equal(malformed.status(), 400)
  assert.deepEqual(malformed.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)

  const oversized = await invoke(route, oversizedReq('POST'))
  assert.equal(oversized.status(), 400)
  assert.deepEqual(oversized.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)
})

test('/config does not type-check free-form values (current contract)', async () => {
  const writes: unknown[] = []
  const s = setup({ setOverride: (...args: unknown[]) => writes.push(args) })
  const captured = await invoke(
    s.route('/plugins/agy-link/config'),
    fakeReq('POST', '/', { key: 'defaultModel', value: 42 }),
  )
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { ok: true, key: 'defaultModel', value: 42 })
  assert.deepEqual(writes, [['defaultModel', 42]])
})

test('/config validates auto mode, sandbox, transport, agent, agySettings, imageTool, and syncAccountCustomizations', async () => {
  const written: Array<[string, unknown]> = []
  const s = setup({ setOverride: (k: string, v: unknown) => written.push([k, v]) })
  const route = s.route('/plugins/agy-link/config')

  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'permissionMode', value: 'auto' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'sandbox', value: true }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'sandbox', value: 'yes' }))).status(), 400)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'transport', value: 'acp' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'transport', value: 'grpc' }))).status(), 400)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'agent', value: 'reviewer' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'agySettings', value: '{"a":1}' }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'agySettings', value: '{bad-json' }))).status(), 400)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'imageTool', value: false }))).status(), 200)
  assert.equal((await invoke(route, fakeReq('POST', '/', { key: 'syncAccountCustomizations', value: false }))).status(), 200)

  assert.deepEqual(written, [
    ['permissionMode', 'auto'],
    ['sandbox', true],
    ['transport', 'acp'],
    ['agent', 'reviewer'],
    ['agySettings', '{"a":1}'],
    ['imageTool', false],
    ['syncAccountCustomizations', false],
  ])
})

test('issue #196: mcpBridge is settable through the config route (boolean only) and reported by status', async () => {
  const writes: Array<[string, unknown]> = []
  const s = setup({ setOverride: (k: string, v: unknown) => { writes.push([k, v]) } })
  const route = s.route('/plugins/agy-link/config')

  // It used to answer 400 "key not settable", which is why the switch was unreachable.
  const ok = await invoke(route, fakeReq('POST', '/', { key: 'mcpBridge', value: true }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(writes, [['mcpBridge', true]])

  const bad = await invoke(route, fakeReq('POST', '/', { key: 'mcpBridge', value: 'yes' }))
  assert.equal(bad.status(), 400)
  assert.deepEqual(bad.json(), { error: 'mcpBridge must be a boolean' })

  const status = await s.call('/plugins/agy-link/status', fakeReq('GET', '/plugins/agy-link/status'))
  assert.equal(status.status(), 200)
  assert.ok('mcpBridge' in (status.json() as Record<string, unknown>), 'status must expose mcpBridge so the panel can render its switch')
})

test('issue #201: btwEnabled is settable (boolean) and reported by status', async () => {
  const writes: Array<[string, unknown]> = []
  const s = setup({ setOverride: (k: string, v: unknown) => { writes.push([k, v]) } })
  const route = s.route('/plugins/agy-link/config')
  const ok = await invoke(route, fakeReq('POST', '/', { key: 'btwEnabled', value: false }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(writes, [['btwEnabled', false]])
  const bad = await invoke(route, fakeReq('POST', '/', { key: 'btwEnabled', value: 'no' }))
  assert.equal(bad.status(), 400)
  assert.deepEqual(bad.json(), { error: 'btwEnabled must be a boolean' })
  const status = await s.call('/plugins/agy-link/status', fakeReq('GET', '/plugins/agy-link/status'))
  assert.ok('btwEnabled' in (status.json() as Record<string, unknown>), 'status must expose btwEnabled')
})

test('router CSRF gate blocks cross-origin POST to /config and /pool/* while allowing dsh-app://', async () => {
  const writes: Array<[string, unknown]> = []
  const s = setup({ setOverride: (k: string, v: unknown) => { writes.push([k, v]) } })
  const withOrigin = (origin: string, body: unknown) =>
    Object.assign(fakeReq('POST', '/', body) as Record<string, unknown>, { headers: { origin } })

  for (const blockedOrigin of ['https://evil.example', 'null', 'file:///tmp/x.html']) {
    const cfgRes = await invoke(s.route('/plugins/agy-link/config'), withOrigin(blockedOrigin, { key: 'btwEnabled', value: false }))
    assert.equal(cfgRes.status(), 403, `POST /config from ${blockedOrigin} must be blocked`)
    assert.deepEqual(cfgRes.json(), { ok: false, error: 'cross-origin request denied' })

    const poolRes = await invoke(s.route('/plugins/agy-link/pool/mode'), withOrigin(blockedOrigin, { parallel: true }))
    assert.equal(poolRes.status(), 403, `POST /pool/mode from ${blockedOrigin} must be blocked`)
    assert.deepEqual(poolRes.json(), { ok: false, error: 'cross-origin request denied' })
  }
  assert.equal(writes.length, 0, 'blocked CSRF requests must not reach route handler')

  const allowed = await invoke(s.route('/plugins/agy-link/config'), withOrigin('dsh-app://desktop', { key: 'btwEnabled', value: true }))
  assert.equal(allowed.status(), 200)
  assert.deepEqual(writes, [['btwEnabled', true]])
})

test('bridge scope validates settings writes and status reports the effective scope and diagnostic', async () => {
  const writes: Array<[string, unknown]> = []
  const bridgeDiagnostic = { hostTools: ['read_ticket'], disabledSettings: ['forwardSystemPrompt'] }
  const s = setup({ setOverride: (k: string, v: unknown) => writes.push([k, v]),
    adapter: { effortUnsupportedModels: () => [], bridgeDiagnostic } }, { mcpBridgeScope: 'host-only' })
  const update = (value: unknown) => s.call('/plugins/agy-link/config', fakeReq('POST', '/', { key: 'mcpBridgeScope', value }))
  for (const valid of ['all', 'host-only']) assert.equal((await update(valid)).status(), 200)
  for (const invalid of [true, '', 'other']) assert.equal((await update(invalid)).status(), 400)
  assert.deepEqual(writes, [['mcpBridgeScope', 'all'], ['mcpBridgeScope', 'host-only']])
  const status = (await s.call('/plugins/agy-link/status', fakeReq('GET', '/'))).json() as Record<string, unknown>
  assert.equal(status.mcpBridgeScope, 'host-only')
  assert.deepEqual(status.bridgeDiagnostic, bridgeDiagnostic)
})
