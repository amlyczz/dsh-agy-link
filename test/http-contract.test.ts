// HTTP contract guard for the extracted /plugins/agy-link/* surface.
//
// Phase 3 moved every route body out of apply() into src/transport/http/*.
// This test pins the public contract without spawning agy or starting a real
// server: it drives registerRoutes() with a recording fake webServer and calls
// handlers directly with fake services.
//
// Scope: the full 29-route table plus the error/edge branches each handler
// actually implements today (method gating, strict-body parsing, parameter
// validation, unknown ids, upstream failure mapping). Assertions describe the
// CURRENT behaviour — no handler is changed by this file.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { registerRoutes } from '../src/transport/http/router.ts'
import type { HostServices } from '../src/host/services.ts'
import type { Route } from '../src/transport/http/respond.ts'

// The /qr handler dynamically imports the real `qrcode` package and renders a
// PNG. Dynamic import of this CJS package resolves the same exports object that
// createRequire returns, so replacing toBuffer here keeps the route real while
// making the response instant and independent of PNG generation (no timeout).
try {
  const qrcode = createRequire(import.meta.url)('qrcode') as { toBuffer?: (...args: unknown[]) => Promise<Buffer> }
  qrcode.toBuffer = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
} catch {
  // qrcode unavailable: the /qr test still asserts the 404 branches.
}

/** The frozen route surface: kind + path, exactly as the client half polls it. */
const EXPECTED_ROUTES: ReadonlyArray<readonly [kind: string, path: string]> = [
  ['exact', '/plugins/agy-link/status'],
  ['exact', '/plugins/agy-link/auth'],
  ['exact', '/plugins/agy-link/auth-code'],
  ['exact', '/plugins/agy-link/auth-cancel'],
  ['exact', '/plugins/agy-link/mermaid.min.js'],
  ['exact', '/plugins/agy-link/pool'],
  ['exact', '/plugins/agy-link/pool/begin-add'],
  ['exact', '/plugins/agy-link/pool/complete-add'],
  ['exact', '/plugins/agy-link/pool/cancel-add'],
  ['exact', '/plugins/agy-link/pool/import'],
  ['exact', '/plugins/agy-link/pool/add'],
  ['exact', '/plugins/agy-link/pool/open-terminal'],
  ['exact', '/plugins/agy-link/pool/remove'],
  ['exact', '/plugins/agy-link/pool/enable'],
  ['exact', '/plugins/agy-link/pool/proxy'],
  ['exact', '/plugins/agy-link/pool/primary'],
  ['exact', '/plugins/agy-link/pool/mode'],
  ['exact', '/plugins/agy-link/pool/refresh-quota'],
  ['exact', '/plugins/agy-link/pool/warmup'],
  ['exact', '/plugins/agy-link/pool/clear-cooldown'],
  ['exact', '/plugins/agy-link/pool/set-active'],
  ['exact', '/plugins/agy-link/pool/reorder'],
  ['exact', '/plugins/agy-link/config'],
  ['exact', '/plugins/agy-link/translate'],
  ['exact', '/plugins/agy-link/translate/pending'],
  ['exact', '/plugins/agy-link/translate/turn'],
  ['exact', '/plugins/agy-link/translate/state'],
  ['exact', '/plugins/agy-link/qr'],
  ['exact', '/plugins/agy-link/media'],
  ['exact', '/plugins/agy-link/open'],
  ['prefix', '/plugins/agy-link/assets'],
]

/** Routes that reject every non-POST method with `405 {error:'POST only'}`. */
const POST_ONLY_ROUTES = [
  '/plugins/agy-link/auth',
  '/plugins/agy-link/auth-code',
  '/plugins/agy-link/auth-cancel',
  '/plugins/agy-link/pool/begin-add',
  '/plugins/agy-link/pool/complete-add',
  '/plugins/agy-link/pool/cancel-add',
  '/plugins/agy-link/pool/import',
  '/plugins/agy-link/pool/add',
  '/plugins/agy-link/pool/open-terminal',
  '/plugins/agy-link/pool/remove',
  '/plugins/agy-link/pool/enable',
  '/plugins/agy-link/pool/proxy',
  '/plugins/agy-link/pool/primary',
  '/plugins/agy-link/pool/mode',
  '/plugins/agy-link/pool/refresh-quota',
  '/plugins/agy-link/pool/warmup',
  '/plugins/agy-link/pool/clear-cooldown',
  '/plugins/agy-link/pool/set-active',
  '/plugins/agy-link/pool/reorder',
  '/plugins/agy-link/config',
  '/plugins/agy-link/translate',
] as const

type FakeWebServer = {
  routes: Route[]
  disposed: string[]
  register(route: Route): () => void
}

function fakeWebServer(): FakeWebServer {
  const routes: Route[] = []
  const disposed: string[] = []
  return {
    routes,
    disposed,
    register(route) {
      routes.push(route)
      return () => {
        disposed.push(route.path)
      }
    },
  }
}

const POOL_DATA = { accounts: [], mode: 'sequential', primaryAccountId: null }

type Overrides = Partial<Record<string, unknown>>
type ConfigOverrides = Record<string, unknown>

const BASE_CONFIG: Record<string, unknown> = {
  enabled: true,
  permissionMode: 'default',
  workspaceRoot: '/tmp/agy-contract',
  defaultModel: 'gemini-3-flash',
  defaultEffort: 'high',
  askTool: false,
  hiddenModels: [] as string[],
  autoWarmup: false,
  warmupModels: [] as string[],
  autoTranslate: false,
  translateModel: '',
  translateEffort: '',
  translateTargetLanguage: 'zh',
  imageModel: '',
  imageEffort: '',
  imageOutputDir: '',
  proxyUrl: '',
  mcpConfigScope: 'global',
  mcpConfigPath: '',
  mediaDir: '',
  mediaTtlMs: 86_400_000,
  quotaPollIntervalMs: 900_000,
  logRetentionDays: 7,
  maxConcurrent: 0,
  suppressAgyAutoUpdate: false,
  quotaViaCli: false,
  translateBindConversation: false,
  fallbackModels: [] as string[],
  modelsCacheTtlMs: 0,
}

/** Minimal plain-object services double: only the fields these handlers touch. */
function fakeServices(overrides: Overrides = {}, config: ConfigOverrides = {}): HostServices {
  const cfg = { ...BASE_CONFIG, ...config }
  const base = {
    getConfig: () => cfg,
    log: () => undefined,
    notifyPicker: () => undefined,
    bin: () => null,
    version: () => null,
    status: { version: '1.1.15', dormantReason: null as string | null },
    store: { all: () => ({}) as Record<string, unknown>, clear: () => undefined },
    pool: {
      getPoolData: () => POOL_DATA,
      getAccounts: () => [],
      getAccount: () => undefined,
      setAccountEnabled: () => false,
    },
    quota: {},
    warmup: {},
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
    },
    auth: { status: () => ({ phase: 'idle' }) },
    poolAuth: { status: () => ({ phase: 'idle' }) },
    adapter: { effortUnsupportedModels: () => [] },
    translation: {
      pendingFor: () => [],
      stats: () => ({}),
      isPending: () => false,
      existingTurn: () => null,
      existingMessage: () => null,
    },
    setOverride: () => undefined,
    readEffortUnsupported: () => [],
    rememberEffortUnsupported: () => undefined,
    sessionsSvc: () => undefined,
    sessionAuto: new Map<string, boolean>(),
    lastRun: null,
    lastParser: { recentLines: [] },
    mediaDir: () => '/tmp/agy-contract',
    bridgeState: { bridge: null, restores: [] as Array<() => void> },
    webServerPort: {} as { current?: number },
    hostDir: '',
    onConfigWritten: () => undefined,
    ...overrides,
  }
  return base as unknown as HostServices
}

type Captured = {
  res: unknown
  done: Promise<void>
  status: () => number
  headers: () => Record<string, string>
  text: () => string
  json: () => unknown
}

/** Fake ServerResponse that resolves `done` when the handler ends the response. */
function capture(): Captured {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      status = s
      headers = h
    },
    end(b?: unknown) {
      body = typeof b === 'string' ? b : b === undefined ? '' : Buffer.from(b as Uint8Array).toString('utf8')
      resolveDone()
    },
  }
  return {
    res,
    done,
    status: () => status,
    headers: () => headers,
    text: () => body,
    json: () => JSON.parse(body) as unknown,
  }
}

/** Fake IncomingMessage: readJsonBody sees the JSON body then 'end'. */
function fakeReq(method: string, url = '/', body?: unknown): unknown {
  return rawReq(method, url, body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
}

/** Fake IncomingMessage from raw chunks (malformed / oversized bodies). */
function rawReq(method: string, url = '/', chunks: Buffer[] = []): unknown {
  return {
    method,
    url,
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') for (const c of chunks) cb(c)
      if (event === 'end') cb(Buffer.alloc(0))
      return undefined
    },
  }
}

function oversizedReq(method: string, url = '/'): unknown {
  return rawReq(method, url, [Buffer.from(JSON.stringify({ text: 'x'.repeat(1_100_000) }))])
}

async function invoke(route: Route, req: unknown): Promise<Captured> {
  const captured = capture()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('route did not end the response: ' + route.path)), 5_000)
    timer.unref?.()
  })
  try {
    route.handler(req, captured.res)
    await Promise.race([captured.done, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return captured
}

function routeFor(routes: Route[], path: string): Route {
  const route = routes.find((r) => r.path === path)
  assert.ok(route, 'route must be registered: ' + path)
  return route
}

type Spy<T> = ((...args: unknown[]) => T) & { calls: unknown[][] }
function spy<T>(ret: T): Spy<T> {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]): T => {
    calls.push(args)
    return ret
  }
  return Object.assign(fn, { calls })
}

/** Full pool double: every method a pool route can touch, with recorded calls. */
function poolDouble(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown[]]> = []
  const fn = (name: string, ret: unknown) => (...args: unknown[]): unknown => {
    calls.push([name, args])
    return ret
  }
  const pool = {
    getPoolData: fn('getPoolData', POOL_DATA),
    getAccounts: fn('getAccounts', []),
    getAccount: fn('getAccount', undefined),
    createAccountSlot: fn('createAccountSlot', { id: 'acc-new', dir: undefined }),
    markAuthRequired: fn('markAuthRequired', true),
    deleteAccount: fn('deleteAccount', true),
    setAccountEnabled: fn('setAccountEnabled', false),
    setAccountProxy: fn('setAccountProxy', true),
    setPrimaryAccount: fn('setPrimaryAccount', false),
    setMode: fn('setMode', true),
    setActiveAccount: fn('setActiveAccount', false),
    reorderAccounts: fn('reorderAccounts', false),
    getActiveAccountId: fn('getActiveAccountId', undefined),
    clearCooldown: fn('clearCooldown', true),
    ...overrides,
  }
  return {
    pool,
    calls,
    callsTo: (name: string) => calls.filter(([n]) => n === name).map(([, args]) => args),
  }
}

/** Register routes against a fake server and return a path→route lookup. */
function setup(overrides: Overrides = {}, config: ConfigOverrides = {}) {
  const webServer = fakeWebServer()
  const services = fakeServices(overrides, config)
  registerRoutes(webServer, services)
  return {
    webServer,
    services,
    route: (path: string) => routeFor(webServer.routes, path),
    call: async (path: string, req: unknown) => invoke(routeFor(webServer.routes, path), req),
  }
}

// ---------------------------------------------------------------------------
// Surface + happy paths
// ---------------------------------------------------------------------------

test('registerRoutes exposes exactly the frozen 29-route surface', () => {
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
  ]) {
    assert.ok(key in body, 'status must keep field ' + key)
  }
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

// ---------------------------------------------------------------------------
// Method gating tables
// ---------------------------------------------------------------------------

test('every POST-only route rejects GET/PUT/DELETE with 405 before touching services', async () => {
  const s = setup()
  for (const path of POST_ONLY_ROUTES) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const captured = await invoke(s.route(path), fakeReq(method))
      assert.equal(captured.status(), 405, path + ' ' + method)
      assert.deepEqual(captured.json(), { error: 'POST only' }, path + ' ' + method)
    }
  }
  // 21 POST-only + 10 method-agnostic routes = 31 routes total.
  assert.equal(POST_ONLY_ROUTES.length + 10, EXPECTED_ROUTES.length)
})

test('GET-style routes do not gate on method (current contract, asserted verbatim)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-get-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'assets'), { recursive: true })
  const s = setup({ hostDir: root }, {})
  const cases: Array<[string, string, number]> = [
    ['/plugins/agy-link/status', '/', 200],
    ['/plugins/agy-link/pool', '/', 200],
    ['/plugins/agy-link/translate/pending', '/', 200],
    ['/plugins/agy-link/translate/turn', '/?session=s&turn=1', 200],
    ['/plugins/agy-link/translate/state', '/?session=s&message=m', 200],
    ['/plugins/agy-link/qr', '/', 404],
    ['/plugins/agy-link/mermaid.min.js', '/', 404],
    ['/plugins/agy-link/media', '/', 400],
    ['/plugins/agy-link/open', '/', 400],
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

  const badArray = await invoke(route, fakeReq('POST', '/', { key: 'hiddenModels', value: 'nope' }))
  assert.equal(badArray.status(), 400)
  assert.deepEqual(badArray.json(), { error: 'hiddenModels must be an array of model ids' })
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

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

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

test('/pool/refresh-quota refreshes one known account and tolerates unknown ids', async () => {
  const acc = { id: 'known' }
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'known' ? acc : undefined) })
  const quotaRefreshes: unknown[][] = []
  let catalogRefreshes = 0
  const s = setup({
    pool: pool.pool,
    quota: {
      refreshAccountQuota: async (...args: unknown[]) => {
        quotaRefreshes.push(args)
      },
      refreshAllQuotas: async () => undefined,
    },
    catalog: {
      get: () => ({ source: 'fallback', models: [], lastError: null }),
      getAllKnownModels: () => [],
      forceRefresh: async () => {
        catalogRefreshes++
      },
    },
  })

  const known = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'known' }))
  assert.equal(known.status(), 200)
  assert.deepEqual(quotaRefreshes, [[acc, true]])

  const unknown = await invoke(s.route('/plugins/agy-link/pool/refresh-quota'), fakeReq('POST', '/', { id: 'ghost' }))
  assert.equal(unknown.status(), 200)
  assert.deepEqual(quotaRefreshes, [[acc, true]], 'unknown id refreshes nothing')
  assert.equal(catalogRefreshes, 2)
})

test('/pool/warmup is strict about JSON and required selectors', async () => {
  const warmupCalls: unknown[][] = []
  const pool = poolDouble({ getAccount: (id: unknown) => (id === 'known' ? { id: 'known' } : undefined) })
  const s = setup({
    pool: pool.pool,
    warmup: {
      warmupAccount: async (...args: unknown[]) => {
        warmupCalls.push(['account', ...args])
        return [{ model: 'm', ok: true }]
      },
      warmupAllAccounts: async (...args: unknown[]) => {
        warmupCalls.push(['all', ...args])
        return [{ model: 'm', ok: true }]
      },
    },
    quota: { refreshAccountQuota: async () => undefined, refreshAllQuotas: async () => undefined },
  })

  const malformed = await invoke(s.route('/plugins/agy-link/pool/warmup'), rawReq('POST', '/', [Buffer.from('{oops')]))
  assert.equal(malformed.status(), 400)
  assert.deepEqual(malformed.json(), { error: 'invalid JSON body' })

  const oversized = await invoke(s.route('/plugins/agy-link/pool/warmup'), oversizedReq('POST'))
  assert.equal(oversized.status(), 400)
  assert.deepEqual(oversized.json(), { error: 'invalid JSON body' })

  const badModel = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true, model: 'bad model!' }))
  assert.equal(badModel.status(), 400)
  assert.deepEqual(badModel.json(), { error: 'invalid model' })

  const badModelType = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true, model: 7 }))
  assert.equal(badModelType.status(), 400)
  assert.deepEqual(badModelType.json(), { error: 'invalid model' })

  const missingSelector = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', {}))
  assert.equal(missingSelector.status(), 400)
  assert.deepEqual(missingSelector.json(), { error: 'id or { all: true } required' })
  assert.equal(warmupCalls.length, 0)

  const unknownAccount = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { id: 'ghost' }))
  assert.equal(unknownAccount.status(), 404)
  assert.deepEqual(unknownAccount.json(), { error: 'Account not found' })

  const one = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { id: 'known', force: true, model: 'gemini-3-flash' }))
  assert.equal(one.status(), 200)
  assert.deepEqual(one.json(), { ok: true, results: [{ model: 'm', ok: true }], pool: POOL_DATA })
  assert.deepEqual(warmupCalls[0], ['account', { id: 'known' }, { force: true, model: 'gemini-3-flash' }])

  const all = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true }))
  assert.equal(all.status(), 200)
  assert.deepEqual(all.json(), { ok: true, results: [{ model: 'm', ok: true }], pool: POOL_DATA })
  assert.deepEqual(warmupCalls[1], ['all', { force: false }])
})

test('/pool/warmup maps a thrown warmup failure to 500', async () => {
  const s = setup({
    warmup: {
      warmupAllAccounts: async () => {
        throw new Error('warmup exploded')
      },
    },
  })
  const captured = await invoke(s.route('/plugins/agy-link/pool/warmup'), fakeReq('POST', '/', { all: true }))
  assert.equal(captured.status(), 500)
  assert.deepEqual(captured.json(), { error: 'Error: warmup exploded' })
})

test('/pool/open-terminal still rejects an existing account without a dir', async () => {
  // openAccountTerminal() would spawn a real terminal, so this contract test
  // only exercises the guard: an existing account with no dir is rejected.
  const pool = poolDouble({ getAccount: () => ({ id: 'no-dir' }) })
  const s = setup({ pool: pool.pool })
  const captured = await invoke(s.route('/plugins/agy-link/pool/open-terminal'), fakeReq('POST', '/', { id: 'no-dir' }))
  assert.equal(captured.status(), 400)
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Media / assets / mermaid
// ---------------------------------------------------------------------------

test('/media rejects a missing path, missing files, non-images and directories', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-media-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = join(root, 'note.txt')
  const image = join(root, 'ok.png')
  const dir = join(root, 'sub')
  writeFileSync(text, 'plain text')
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  mkdirSync(dir, { recursive: true })

  const s = setup()
  const route = s.route('/plugins/agy-link/media')

  const missingParam = await invoke(route, fakeReq('GET', '/'))
  assert.equal(missingParam.status(), 400)
  assert.equal(missingParam.text(), 'missing path query parameter')

  const missingFile = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(join(root, 'nope.png'))))
  assert.equal(missingFile.status(), 404)
  assert.equal(missingFile.text(), 'file not found')

  const nonImage = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(text)))
  assert.equal(nonImage.status(), 403)
  assert.equal(nonImage.text(), 'access denied: not an image')

  const notAFile = await invoke(route, fakeReq('GET', '/?path=' + encodeURIComponent(dir)))
  assert.equal(notAFile.status(), 403)
  assert.equal(notAFile.text(), 'not a regular file')

  // `path=` empty behaves like a missing parameter.
  const emptyParam = await invoke(route, fakeReq('GET', '/?path='))
  assert.equal(emptyParam.status(), 400)

  // A relative path is resolved against workspaceRoot when provided.
  const workspace = setup({}, { workspaceRoot: root })
  const relative = await invoke(workspace.route('/plugins/agy-link/media'), fakeReq('GET', '/?path=note.txt'))
  assert.equal(relative.status(), 403, 'relative path resolves under the workspace root')
  assert.equal(relative.text(), 'access denied: not an image')
})

test('/assets rejects traversal, missing assets and directories; serves mermaid only when present', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assets = join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  mkdirSync(join(assets, 'nested'), { recursive: true })
  writeFileSync(join(assets, 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'secret')
  symlinkSync(join(root, 'secret.txt'), join(assets, 'escape.txt'))

  const s = setup({ hostDir: root })
  const assetRoute = s.route('/plugins/agy-link/assets')

  const missing = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/none.js'))
  assert.equal(missing.status(), 404)
  assert.equal(missing.text(), 'asset not found')

  const traversal = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/%2e%2e%2fsecret.txt'))
  assert.equal(traversal.status(), 404, 'encoded traversal resolves to a literal name and is not served')
  assert.equal(traversal.text(), 'asset not found')

  const escaped = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/escape.txt'))
  assert.equal(escaped.status(), 403, 'symlink escape is forbidden')
  assert.equal(escaped.text(), 'forbidden')

  const directory = await invoke(assetRoute, fakeReq('GET', '/plugins/agy-link/assets/nested'))
  assert.equal(directory.status(), 403)
  assert.equal(directory.text(), 'not a file')

  const mermaidMissing = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(mermaidMissing.status(), 404)
  assert.equal(mermaidMissing.text(), 'mermaid.min.js not found')

  writeFileSync(join(root, 'mermaid.min.js'), 'console.log("mermaid")')
  const mermaid = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(mermaid.status(), 200)
  assert.equal(mermaid.headers()['content-type'], 'application/javascript; charset=utf-8')
  assert.equal(mermaid.text(), 'console.log("mermaid")')
})

test('/assets 404s when the asset dir cannot be resolved', async () => {
  const s = setup({ hostDir: '/nonexistent-agy-host-dir' })
  const captured = await invoke(s.route('/plugins/agy-link/assets'), fakeReq('GET', '/plugins/agy-link/assets/a.js'))
  assert.equal(captured.status(), 404)
  assert.equal(captured.text(), 'asset not found')
})

test('/pool/add publishes the bridge MCP config into the account home when a bridge is active', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-contract-add-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bridge = { port: 4321, bridgeScript: '/tmp/bridge.mjs', url: 'http://127.0.0.1:4321', token: 'secret', close: async () => undefined }
  const pool = poolDouble({ createAccountSlot: () => ({ id: 'acc-x', dir }) })
  const s = setup({
    pool: pool.pool,
    bridgeState: { bridge, restores: [] as Array<() => void> },
  }, { mcpConfigScope: 'global' })

  const captured = await invoke(s.route('/plugins/agy-link/pool/add'), fakeReq('POST', '/', { autoOpenTerminal: false }))
  assert.equal(captured.status(), 200)
  const registered = s.services.bridgeState as unknown as { restores: Array<() => void> }
  assert.equal(registered.restores.length, 1, 'a restore hook is recorded for the new account home')
  const configFile = join(dir, '.gemini', 'config', 'mcp_config.json')
  assert.ok(existsSync(configFile), 'mcp config written under the account home')
  assert.match(readFileSync(configFile, 'utf8'), /mcpServers/)
})

test('/mermaid.min.js maps an unreadable file to 500', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-contract-mermaid-err-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A directory named mermaid.min.js exists but readFileSync throws EISDIR.
  mkdirSync(join(root, 'mermaid.min.js'))
  const s = setup({ hostDir: root })
  const captured = await invoke(s.route('/plugins/agy-link/mermaid.min.js'), fakeReq('GET'))
  assert.equal(captured.status(), 500)
  assert.match(captured.text(), /^read error: /)
})
