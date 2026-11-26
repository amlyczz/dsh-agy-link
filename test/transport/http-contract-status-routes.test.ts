// /status and /session-view contract: the client-visible poll shape.
//
// Pins every field the client half reads (catalog/catalogModels, quota and warmup
// progress, visibility switches) plus the per-session model family resolution.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerRoutes } from '../../src/transport/http/router.ts'
import { POOL_DATA, fakeWebServer, fakeServices, fakeReq, invoke, routeFor, poolDouble, setup } from './http-contract-helpers.ts'

test('/status answers 200 with the client-visible shape', async () => {
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices())
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.equal(captured.status(), 200)
  assert.equal(captured.headers()['Content-Type'], 'application/json; charset=utf-8')
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.plugin, 'dsh-agy-link')
  assert.equal(body.bin, null)
  assert.equal(body.version, '1.1.15')
  assert.equal(body.dormantReason, null)
  assert.equal(body.enabled, true)
  assert.deepEqual(body.pool, POOL_DATA)
  assert.deepEqual(body.catalog, { source: 'fallback', count: 0, lastError: null })
  assert.deepEqual(body.catalogModels, [])
  assert.deepEqual(body.hiddenModels, [])
  assert.deepEqual(body.translateState, { pending: [], stats: {} })
  assert.equal(body.bindings, 0)
  assert.deepEqual(body.effortUnsupported, [])
  assert.equal(body.lastRun, null)
  // Field names the client half depends on (frozen contract).
  for (const key of [
    'permissionMode', 'workspaceRoot', 'defaultModel', 'defaultEffort', 'askTool', 'auth', 'poolAuth',
    'autoWarmup', 'warmupModels', 'autoTranslate', 'translateModel', 'translateEffort',
    'translateTargetLanguage', 'imageModel', 'imageEffort', 'imageOutputDir',
    'btwModel', 'btwEffort',
    'showHeaderBadge', 'showTranslateAction', 'poolWideCatalog',
  ]) {
    assert.ok(key in body, 'status must keep field ' + key)
  }
  assert.equal(body.showHeaderBadge, true)
  assert.equal(body.showTranslateAction, true)
  assert.equal(body.poolWideCatalog, false)
})

test('/session-view answers for the family of the model this session selected', async () => {
  const ele = {
    id: 'acc_ele',
    alias: 'ele',
    email: 'ele@example.com',
    dir: '/tmp/ele',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: { argon: { weeklyFraction: 0.58, weeklyResetTime: new Date(Date.now() + 86_400_000).toISOString(), updatedAt: Date.now() } },
  }
  const poolData = {
    version: 1,
    mode: 'sequential',
    defaultCooldownMs: 900_000,
    maxCooldownMs: 3_600_000,
    activeAccountIds: { argon: 'acc_ele' },
    resolvedActiveAccountIds: { argon: 'acc_ele' },
    accounts: [ele],
  }
  const pool = {
    getPoolData: () => poolData,
    getAccounts: () => [ele],
    getAccount: (id: string) => (id === 'acc_ele' ? ele : undefined),
  }
  // The session's own selection outranks the configured default model.
  const sessionsSvc = () => ({
    get: () => ({ log: [{ type: 'model/selection', data: { provider: 'antigravity', model: 'gemini-4-argon-high' } }] }),
  })
  const setup = () => {
    const webServer = fakeWebServer()
    registerRoutes(webServer, fakeServices({ pool, sessionsSvc } as never))
    return { call: (path: string, req: unknown) => invoke(routeFor(webServer.routes, path), req) }
  }

  const captured = await setup().call('/plugins/agy-link/session-view', fakeReq('GET', '/?session=session-1'))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.family, 'argon')
  assert.equal(body.accountId, 'acc_ele')
  assert.equal(body.alias, 'ele')
  assert.equal(body.percent, 58)
  assert.equal(body.window, 'weekly')
  assert.equal(body.model, 'gemini-4-argon-high')

  // No session id: the configured default decides, and no account is invented
  // for a family that has no pointer.
  const fallback = await setup().call('/plugins/agy-link/session-view', fakeReq('GET'))
  const fallbackBody = fallback.json() as Record<string, unknown>
  assert.equal(fallbackBody.model, 'gemini-3-flash')
  assert.equal(fallbackBody.family, 'google')
  assert.equal(fallbackBody.accountId, null)
})

test('/status forwards an explicit UI visibility opt-out (issue #105)', async () => {
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices({}, { showHeaderBadge: false, showTranslateAction: false }))
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.showHeaderBadge, false, 'an explicit false must reach the client unchanged')
  assert.equal(body.showTranslateAction, false)
})

test('issue #107: /status catalogModels follows the pool-wide switch', async () => {
  const active = { id: 'acc_active', alias: 'Active', dir: '/tmp/active', enabled: true, createdAt: 0 }
  const pool = {
    getPoolData: () => POOL_DATA,
    getAccounts: () => [active],
    getAccount: (id: string) => (id === 'acc_active' ? active : undefined),
    getActiveAccountId: () => 'acc_active',
  }
  const catalog = {
    get: () => ({ source: 'discovered', models: [], lastError: null }),
    getAllKnownModels: () => [],
    getModelsForAccount: () => [{ id: 'model-active', name: 'Active only', efforts: [] }],
    getUnion: () => [
      { id: 'model-active', name: 'Active only', efforts: [] },
      { id: 'model-other', name: 'Another account', efforts: [] },
    ],
  }

  const narrow = await invoke(
    setup({ pool, catalog }, { poolWideCatalog: false }).route('/plugins/agy-link/status'),
    fakeReq('GET'),
  )
  const narrowIds = (narrow.json() as { catalogModels: Array<{ id: string }> }).catalogModels.map((m) => m.id)
  assert.deepEqual(narrowIds, ['model-active'], 'default keeps single-account isolation')

  const wide = await invoke(
    setup({ pool, catalog }, { poolWideCatalog: true }).route('/plugins/agy-link/status'),
    fakeReq('GET'),
  )
  const wideIds = (wide.json() as { catalogModels: Array<{ id: string }> }).catalogModels.map((m) => m.id)
  assert.deepEqual(wideIds, ['model-active', 'model-other'], 'Settings chips must match the picker union')
})

test('/status reflects bin/dormant/last-run/pool proxy and announces no method gate', async () => {
  const pool = poolDouble()
  const s = setup({
    bin: () => '/opt/agy',
    status: { version: '1.2.3', dormantReason: 'agy 1.0.0 is older than 1.1.15' },
    store: { all: () => ({ a: {}, b: {} }), clear: () => undefined },
    pool: pool.pool,
    catalog: {
      get: () => ({ source: 'agy', models: [{}, {}], lastError: 'boom' }),
      getAllKnownModels: () => [],
    },
    adapter: { effortUnsupportedModels: () => ['claude-sonnet-4-6'] },
    lastRun: { processOk: true, processCode: '0', toolErrors: [], durationMs: 10, model: 'm', tokenSpeed: { lastTps: 1, avgTps: 1, outputTokens: 1, measuredSteps: 1, generatingMs: 1 } },
    translation: { pendingFor: () => ['p'], stats: () => ({ ok: 2 }), isPending: () => false, existingTurn: () => null, existingMessage: () => null },
  }, { proxyUrl: '  http://proxy.local:8080  ', hiddenModels: ['hidden-1'], enabled: false })

  // No method gate on GET-style routes: POST is processed identically.
  const captured = await invoke(s.route('/plugins/agy-link/status'), fakeReq('POST'))
  assert.equal(captured.status(), 200)
  const body = captured.json() as Record<string, unknown>
  assert.equal(body.bin, '/opt/agy')
  assert.equal(body.version, '1.2.3')
  assert.equal(body.dormantReason, 'agy 1.0.0 is older than 1.1.15')
  assert.equal(body.enabled, false)
  assert.deepEqual(body.hiddenModels, ['hidden-1'])
  assert.deepEqual(body.catalog, { source: 'agy', count: 2, lastError: 'boom' })
  assert.deepEqual(body.effortUnsupported, ['claude-sonnet-4-6'])
  assert.equal(body.bindings, 2)
  assert.deepEqual(body.translateState, { pending: ['p'], stats: { ok: 2 } })
  assert.deepEqual(body.lastRun, { processOk: true, processCode: '0', toolErrors: [], durationMs: 10, model: 'm', tokenSpeed: { lastTps: 1, avgTps: 1, outputTokens: 1, measuredSteps: 1, generatingMs: 1 } })
  assert.deepEqual(pool.callsTo('getPoolData'), [['http://proxy.local:8080']], 'status passes the trimmed proxy to getPoolData')
})

test('/status forwards the account ids the host is refreshing right now', async () => {
  const withIds = fakeServices({ quota: { refreshingAccounts: () => ['a1', 'a2'] } })
  const webServer = fakeWebServer()
  registerRoutes(webServer, withIds)
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.deepEqual((captured.json() as Record<string, unknown>).quotaRefreshing, ['a1', 'a2'])

  // A host double without the method must degrade to an empty list, not throw.
  const withoutMethod = fakeServices({ quota: {} })
  const ws2 = fakeWebServer()
  registerRoutes(ws2, withoutMethod)
  const second = await invoke(routeFor(ws2.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.deepEqual((second.json() as Record<string, unknown>).quotaRefreshing, [])
  // availableCommands is stripped from HTTP /status to avoid 20KB+ per-poll bloat.
  const withCmds = fakeServices({
    acpPool: { status: () => ({ activeProcesses: 1, sessions: 1, keys: ['k1'], availableCommands: [{ name: 'plan', description: 'big' }] }) },
  })
  const ws3 = fakeWebServer()
  registerRoutes(ws3, withCmds)
  const third = await invoke(routeFor(ws3.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  const acpSt = (third.json() as Record<string, unknown>).acpStatus as Record<string, unknown>
  assert.equal(acpSt.activeProcesses, 1)
  assert.equal('availableCommands' in acpSt, false)
})

test('/status exposes warmup.status() snapshot as warmupState', async () => {
  const snapshot = {
    running: true,
    scope: 'all',
    startedAt: 1000,
    total: 2,
    completed: 1,
    activeAccountIds: ['a2'],
    currentAccountId: 'a2',
    lastRun: null,
  }
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices({ warmup: { status: () => snapshot } }))
  const captured = await invoke(routeFor(webServer.routes, '/plugins/agy-link/status'), fakeReq('GET'))
  assert.deepEqual((captured.json() as Record<string, unknown>).warmupState, snapshot)
})
