// /pool contract: account listing and mutations, plus the add/import auth flow.
//
// Pins parameter forwarding, 400/500 mapping and the current "accept and answer
// 200" behaviour of the mutation routes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { POOL_DATA, BASE_CONFIG, fakeReq, invoke, poolDouble, setup } from './http-contract-helpers.ts'

test('/pool returns pool data and /pool/enable maps failure to 400', async () => {
  let notified = 0
  const s = setup({
    pool: {
      getPoolData: () => POOL_DATA,
      getAccounts: () => [],
      getAccount: () => undefined,
      setAccountEnabled: () => false,
    },
    notifyPicker: () => {
      notified++
    },
  })
  const list = await invoke(s.route('/plugins/agy-link/pool'), fakeReq('GET'))
  assert.equal(list.status(), 200)
  assert.deepEqual(list.json(), POOL_DATA)

  const enable = await invoke(s.route('/plugins/agy-link/pool/enable'), fakeReq('POST', '/', { id: 'missing', enabled: false }))
  assert.equal(enable.status(), 400)
  assert.deepEqual(enable.json(), { ok: false, pool: POOL_DATA })
  assert.equal(notified, 0, 'a failed enable must not announce a picker update')

  const wrongMethod = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('GET'))
  assert.equal(wrongMethod.status(), 405)
  assert.deepEqual(wrongMethod.json(), { error: 'POST only' })
})

test('/pool/add quarantines the new slot and skips the terminal when autoOpenTerminal=false', async () => {
  const pool = poolDouble()
  const s = setup({ pool: pool.pool })
  const captured = await invoke(s.route('/plugins/agy-link/pool/add'), fakeReq('POST', '/', { alias: 'work', autoOpenTerminal: false }))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.deepEqual(body.account, { id: 'acc-new' })
  assert.deepEqual(body.pool, POOL_DATA)
  assert.deepEqual(pool.callsTo('createAccountSlot'), [['work']])
  assert.deepEqual(pool.callsTo('markAuthRequired'), [['acc-new', 'not signed in yet — complete the terminal login']])
})

test('/pool/open-terminal rejects unknown or dirless accounts with 400', async () => {
  const pool = poolDouble({
    getAccount: (id: unknown) => (id === 'no-dir' ? { id: 'no-dir' } : undefined),
  })
  const s = setup({ pool: pool.pool })

  const unknown = await invoke(s.route('/plugins/agy-link/pool/open-terminal'), fakeReq('POST', '/', { id: 'ghost' }))
  assert.equal(unknown.status(), 400)
  assert.deepEqual(unknown.json(), { error: 'account has no isolated directory' })

  const noDir = await invoke(s.route('/plugins/agy-link/pool/open-terminal'), fakeReq('POST', '/', { id: 'no-dir' }))
  assert.equal(noDir.status(), 400)
  assert.deepEqual(noDir.json(), { error: 'account has no isolated directory' })
})

test('/pool/complete-add validates the code and maps pool success/failure', async () => {
  const beginState = { ok: false, phase: 'failed', code: 'BAD_CODE' }
  const pool = poolDouble()
  const s = setup({
    pool: pool.pool,
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async () => beginState,
    },
  })

  const missing = await invoke(s.route('/plugins/agy-link/pool/complete-add'), fakeReq('POST', '/', {}))
  assert.equal(missing.status(), 400)
  assert.deepEqual(missing.json(), { ok: false, phase: 'waiting', code: 'missing_code' })

  const failed = await invoke(s.route('/plugins/agy-link/pool/complete-add'), fakeReq('POST', '/', { code: 'abc' }))
  assert.equal(failed.status(), 400)
  assert.deepEqual(failed.json(), { ok: false, phase: 'failed', code: 'BAD_CODE', pool: POOL_DATA })
})

test('/pool/complete-add returns 200 and the pool snapshot when the login completes', async () => {
  const pool = poolDouble()
  const s = setup({
    pool: pool.pool,
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async () => ({ ok: true, phase: 'ok', code: 'OK' }),
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/pool/complete-add'), fakeReq('POST', '/', { code: 'abc' }))
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { ok: true, phase: 'ok', code: 'OK', pool: POOL_DATA })
  assert.deepEqual(pool.callsTo('getPoolData'), [[]])
})

test('/pool/begin-add / cancel-add forward to the pool auth flow and map begin failure to 500', async () => {
  const begun: unknown[][] = []
  const cancelled: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: '' }),
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        begun.push(args)
        return { ok: false, phase: 'failed', code: 'NOPE' }
      },
      cancel: async (...args: unknown[]) => {
        cancelled.push(args)
        return undefined
      },
    },
  })

  const failed = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('POST', '/', { alias: 'a', proxyUrl: 'http://p:1' }))
  assert.equal(failed.status(), 500)
  assert.deepEqual(failed.json(), { ok: false, phase: 'failed', code: 'NOPE' })
  assert.deepEqual(begun, [['a', 'http://p:1']])

  const cancel = await invoke(s.route('/plugins/agy-link/pool/cancel-add'), fakeReq('POST', '/', {}))
  assert.equal(cancel.status(), 200)
  assert.deepEqual(cancel.json(), { ok: true, pool: POOL_DATA })
  assert.equal(cancelled.length, 1)
})

test('/pool/begin-add falls back to the configured proxy and trims the body value', async () => {
  const begun: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: ' http://cfg-proxy:9 ' }),
    poolAuth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        begun.push(args)
        return { ok: true, phase: 'pending' }
      },
    },
  })
  const trimmed = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('POST', '/', { proxyUrl: '  http://body-proxy:1  ' }))
  assert.equal(trimmed.status(), 200)
  assert.deepEqual(begun[0], [undefined, 'http://body-proxy:1'])

  const fromConfig = await invoke(s.route('/plugins/agy-link/pool/begin-add'), fakeReq('POST', '/', {}))
  assert.equal(fromConfig.status(), 200)
  assert.deepEqual(begun[1], [undefined, 'http://cfg-proxy:9'])
})

test('/pool mutation routes forward ids/params and always answer 200', async () => {
  const seen: Record<string, unknown[][]> = {}
  const rec = (name: string, ret: (args: unknown[]) => unknown) => (...args: unknown[]): unknown => {
    ;(seen[name] ??= []).push(args)
    return ret(args)
  }
  const pool = poolDouble({
    setAccountEnabled: rec('setAccountEnabled', (args) => args[0] === 'known'),
    setActiveAccount: rec('setActiveAccount', (args) => args[0] === 'known'),
    setPrimaryAccount: rec('setPrimaryAccount', () => true),
    reorderAccounts: rec('reorderAccounts', () => true),
    getActiveAccountId: rec('getActiveAccountId', () => 'known'),
  })
  let notified = 0
  const catalogRefreshes: unknown[][] = []
  const quotaRefreshes: unknown[][] = []
  const s = setup({
    pool: pool.pool,
    notifyPicker: () => {
      notified++
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefreshAndNotify: async (...args: unknown[]) => {
        catalogRefreshes.push(args)
      },
      forceRefresh: async () => undefined,
    },
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => {
        quotaRefreshes.push(['account', ...args])
      },
      refreshAllQuotas: async (...args: unknown[]) => {
        quotaRefreshes.push(['all', ...args])
      },
    },
  })

  const remove = await invoke(s.route('/plugins/agy-link/pool/remove'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(remove.status(), 200)
  assert.deepEqual(remove.json(), { ok: true, pool: POOL_DATA })
  assert.deepEqual(pool.callsTo('deleteAccount'), [['known']])

  const enableOk = await invoke(s.route('/plugins/agy-link/pool/enable'), fakeReq('POST', '/', { id: 'known', enabled: true }))
  assert.equal(enableOk.status(), 200)
  assert.deepEqual(enableOk.json(), { ok: true, pool: POOL_DATA })
  assert.deepEqual(seen.setAccountEnabled, [['known', true]])

  // Missing `enabled` defaults to true (no 400).
  const enableDefault = await invoke(s.route('/plugins/agy-link/pool/enable'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(enableDefault.status(), 200)
  assert.deepEqual(seen.setAccountEnabled?.[1], ['known', true])

  const proxy = await invoke(s.route('/plugins/agy-link/pool/proxy'), fakeReq('POST', '/', { id: 'known', proxyUrl: 'http://p:1' }))
  assert.equal(proxy.status(), 200)
  assert.deepEqual(pool.callsTo('setAccountProxy'), [['known', 'http://p:1']])

  // Missing id is NOT validated on /proxy (current contract: 200).
  const proxyMissing = await invoke(s.route('/plugins/agy-link/pool/proxy'), fakeReq('POST', '/', {}))
  assert.equal(proxyMissing.status(), 200)
  assert.deepEqual(pool.callsTo('setAccountProxy')[1], ['', undefined])

  const primary = await invoke(s.route('/plugins/agy-link/pool/primary'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(primary.status(), 200)
  assert.deepEqual(catalogRefreshes, [['known']])

  const setActive = await invoke(s.route('/plugins/agy-link/pool/set-active'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(setActive.status(), 200)
  assert.deepEqual(setActive.json(), { ok: true, pool: POOL_DATA })
  assert.deepEqual(catalogRefreshes, [['known'], ['known']])
  assert.deepEqual(seen.setActiveAccount, [['known', 'google']])

  const setActiveArgon = await invoke(s.route('/plugins/agy-link/pool/set-active'), fakeReq('POST', '/', { id: 'known', family: 'argon' }))
  assert.equal(setActiveArgon.status(), 200)
  assert.deepEqual(setActiveArgon.json(), { ok: true, pool: POOL_DATA })
  assert.deepEqual(seen.setActiveAccount, [['known', 'google'], ['known', 'argon']])

  const setActiveInvalidFamily = await invoke(s.route('/plugins/agy-link/pool/set-active'), fakeReq('POST', '/', { id: 'known', family: 'bogus' }))
  assert.equal(setActiveInvalidFamily.status(), 400)
  assert.deepEqual(setActiveInvalidFamily.json(), { ok: false, error: 'invalid family', pool: POOL_DATA })

  const setActiveMissing = await invoke(s.route('/plugins/agy-link/pool/set-active'), fakeReq('POST', '/', {}))
  assert.equal(setActiveMissing.status(), 400)
  assert.deepEqual(setActiveMissing.json(), { ok: false, pool: POOL_DATA })

  const mode = await invoke(s.route('/plugins/agy-link/pool/mode'), fakeReq('POST', '/', { mode: 'round-robin' }))
  assert.equal(mode.status(), 200)
  assert.deepEqual(pool.callsTo('setMode'), [['round-robin']])
  // Anything else collapses to sequential.
  const modeBad = await invoke(s.route('/plugins/agy-link/pool/mode'), fakeReq('POST', '/', { mode: 'nonsense' }))
  assert.equal(modeBad.status(), 200)
  assert.deepEqual(pool.callsTo('setMode')[1], ['sequential'])

  const reorder = await invoke(s.route('/plugins/agy-link/pool/reorder'), fakeReq('POST', '/', { ids: ['known', 42, 'b'] }))
  assert.equal(reorder.status(), 200)
  assert.deepEqual(reorder.json(), { ok: true, pool: POOL_DATA })
  assert.deepEqual(seen.reorderAccounts, [[['known', 'b']]])
  assert.deepEqual(catalogRefreshes.at(-1), ['known'])

  const clear = await invoke(s.route('/plugins/agy-link/pool/clear-cooldown'), fakeReq('POST', '/', { id: 'known', family: 'gemini' }))
  assert.equal(clear.status(), 200)
  assert.deepEqual(pool.callsTo('clearCooldown'), [['known', 'gemini', true]])

  // No id/family is still accepted (current contract: no validation).
  const clearEmpty = await invoke(s.route('/plugins/agy-link/pool/clear-cooldown'), fakeReq('POST', '/', {}))
  assert.equal(clearEmpty.status(), 200)
  assert.deepEqual(pool.callsTo('clearCooldown')[1], [undefined, undefined, true])

  const refreshAll = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', {}))
  assert.equal(refreshAll.status(), 200)
  assert.deepEqual(quotaRefreshes, [['all', true]])

  const refreshOne = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(refreshOne.status(), 200)
  // getAccount default is undefined, so no per-account refresh fires.
  assert.deepEqual(quotaRefreshes, [['all', true]])

  assert.ok(notified >= 3, 'remove/enable/primary/set-active/reorder announce the picker')
})

test('/pool/open-terminal still rejects an existing account without a dir', async () => {
  // openAccountTerminal() would spawn a real terminal, so this contract test
  // only exercises the guard: an existing account with no dir is rejected.
  const pool = poolDouble({ getAccount: () => ({ id: 'no-dir' }) })
  const s = setup({ pool: pool.pool })
  const captured = await invoke(s.route('/plugins/agy-link/pool/open-terminal'), fakeReq('POST', '/', { id: 'no-dir' }))
  assert.equal(captured.status(), 400)
})
