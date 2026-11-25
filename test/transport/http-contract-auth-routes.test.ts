// /auth, /auth-code, /auth-cancel and /qr contract.
//
// Pins proxy resolution/trimming, the missing-code guard, the post-login refresh
// fan-out and the PNG/404 branches of the QR endpoint.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BASE_CONFIG, fakeReq, invoke, poolDouble, setup } from './http-contract-helpers.ts'

test('/auth forwards the trimmed proxy and returns the auth status', async () => {
  const beginCalls: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: 'http://cfg:1' }),
    auth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        beginCalls.push(args)
        return { phase: 'pending', url: 'https://accounts.google.com/x', accountId: 'a1' }
      },
    },
  })
  const captured = await invoke(
    s.route('/plugins/agy-link/auth'),
    fakeReq('POST', '/', { homeDir: '/home/u', accountId: 'a1', proxyUrl: '  http://body:2  ' }),
  )
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { phase: 'pending', url: 'https://accounts.google.com/x', accountId: 'a1' })
  assert.deepEqual(beginCalls, [['/home/u', 'a1', 'http://body:2']])
})

test('/auth falls back to the configured proxy when the body omits it', async () => {
  const beginCalls: unknown[][] = []
  const s = setup({
    getConfig: () => ({ ...BASE_CONFIG, proxyUrl: ' http://cfg:1 ' }),
    auth: {
      status: () => ({ phase: 'idle' }),
      begin: async (...args: unknown[]) => {
        beginCalls.push(args)
        return { phase: 'idle' }
      },
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/auth'), fakeReq('POST', '/', {}))
  assert.equal(captured.status(), 200)
  assert.deepEqual(beginCalls, [[undefined, undefined, 'http://cfg:1']])
})

test('/auth-code rejects a missing code and completes the login on success', async () => {
  const storeClears: unknown[] = []
  const quotaCalls: unknown[][] = []
  const catalogCalls: unknown[][] = []
  const acc = { id: 'a1' }
  const s = setup({
    store: { all: () => ({}), clear: (...args: unknown[]) => storeClears.push(args) },
    pool: { ...poolDouble({ getAccount: (id: unknown) => (id === 'a1' ? acc : undefined) }).pool },
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => quotaCalls.push(['account', ...args]),
      refreshAllQuotas: async (...args: unknown[]) => quotaCalls.push(['all', ...args]),
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async (...args: unknown[]) => catalogCalls.push(args),
    },
    auth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async (code: string) => ({ phase: code === 'ok' ? 'ok' : 'failed', accountId: 'a1' }),
    },
  })

  const missing = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', {}))
  assert.equal(missing.status(), 400)
  assert.deepEqual(missing.json(), { error: 'missing code' })

  const failed = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', { code: 'nope' }))
  assert.equal(failed.status(), 200)
  assert.deepEqual(failed.json(), { phase: 'failed', accountId: 'a1' })
  assert.equal(storeClears.length, 0)
  assert.equal(quotaCalls.length, 0)

  const ok = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', { code: 'ok' }))
  assert.equal(ok.status(), 200)
  assert.deepEqual(ok.json(), { phase: 'ok', accountId: 'a1' })
  assert.deepEqual(quotaCalls, [['account', acc]])
  assert.equal(storeClears.length, 1)
  assert.equal(catalogCalls.length, 1)
})

test('/auth-code refreshes every account when no account id is attached', async () => {
  const quotaCalls: unknown[][] = []
  const s = setup({
    store: { all: () => ({}), clear: () => undefined },
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => quotaCalls.push(['account', ...args]),
      refreshAllQuotas: async (...args: unknown[]) => quotaCalls.push(['all', ...args]),
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => undefined,
    },
    auth: {
      status: () => ({ phase: 'idle' }),
      submitCode: async () => ({ phase: 'ok' }),
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/auth-code'), fakeReq('POST', '/', { code: 'ok' }))
  assert.equal(captured.status(), 200)
  assert.deepEqual(quotaCalls, [['all']])
})

test('/auth-cancel cancels the pending flow', async () => {
  const cancels: unknown[] = []
  const s = setup({
    auth: {
      status: () => ({ phase: 'idle' }),
      cancelAuth: (...args: unknown[]) => {
        cancels.push(args)
        return { phase: 'cancelled' }
      },
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/auth-cancel'), fakeReq('POST', '/', {}))
  assert.equal(captured.status(), 200)
  assert.deepEqual(captured.json(), { phase: 'cancelled' })
  assert.equal(cancels.length, 1)
})

test('/qr returns 404 without a pending URL and a PNG when one exists', async () => {
  const idle = setup()
  const none = await invoke(idle.route('/plugins/agy-link/qr'), fakeReq('GET'))
  assert.equal(none.status(), 404)
  assert.equal(none.text(), 'no pending auth')

  // Pending but with no URL is still 404.
  const pendingNoUrl = setup({ auth: { status: () => ({ phase: 'pending' }) } })
  assert.equal((await invoke(pendingNoUrl.route('/plugins/agy-link/qr'), fakeReq('GET'))).status(), 404)

  const pending = setup({
    auth: { status: () => ({ phase: 'pending', url: 'https://accounts.google.com/o/oauth2/auth?client_id=x' }) },
  })
  const captured = await invoke(pending.route('/plugins/agy-link/qr'), fakeReq('GET'))
  assert.equal(captured.status(), 200)
  assert.equal(captured.headers()['Content-Type'], 'image/png')
  assert.equal(captured.headers()['Cache-Control'], 'no-store')
  // The stubbed toBuffer returns a tiny PNG magic header (see the module stub).
  assert.ok(captured.text().length > 0)
})
