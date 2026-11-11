// HTTP contract guard for the extracted /plugins/agy-link/* surface.
//
// Phase 3 moved every route body out of apply() into src/transport/http/*.
// This test pins the public contract without spawning agy or starting a real
// server: it drives registerRoutes() with a recording fake webServer and calls
// a few handlers directly with fake services.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerRoutes } from '../src/transport/http/router.ts'
import type { HostServices } from '../src/host/services.ts'
import type { Route } from '../src/transport/http/respond.ts'

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
  ['prefix', '/plugins/agy-link/assets'],
]

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

/** Minimal plain-object services double: only the fields these handlers touch. */
function fakeServices(overrides: Overrides = {}): HostServices {
  const cfg = {
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
  const base = {
    getConfig: () => cfg,
    log: () => undefined,
    notifyPicker: () => undefined,
    bin: () => null,
    version: () => null,
    status: { version: '1.1.15', dormantReason: null as string | null },
    store: { all: () => ({}) },
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
    json: () => JSON.parse(body) as unknown,
  }
}

/** Fake IncomingMessage: readJsonBody sees the body then 'end' (or just 'end'). */
function fakeReq(method: string, url = '/', body?: unknown): unknown {
  return {
    method,
    url,
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb(Buffer.alloc(0))
      return undefined
    },
  }
}

async function invoke(route: Route, req: unknown): Promise<Captured> {
  const captured = capture()
  route.handler(req, captured.res)
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('route did not end the response: ' + route.path)), 1_000)
    t.unref?.()
  })
  await Promise.race([captured.done, timeout])
  return captured
}

function routeFor(routes: Route[], path: string): Route {
  const route = routes.find((r) => r.path === path)
  assert.ok(route, 'route must be registered: ' + path)
  return route
}

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
  const route = routeFor(webServer.routes, '/plugins/agy-link/status')
  const captured = await invoke(route, fakeReq('GET'))
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

test('/config is POST-only and validates keys before writing', async () => {
  const writes: Array<[string, unknown]> = []
  const configWrites: Array<[string, unknown]> = []
  let pickerEvents = 0
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices({
    setOverride: (key: string, value: unknown) => {
      writes.push([key, value])
    },
    onConfigWritten: (key: string, value: unknown) => {
      configWrites.push([key, value])
    },
    notifyPicker: () => {
      pickerEvents++
    },
  }))
  const route = routeFor(webServer.routes, '/plugins/agy-link/config')

  const wrongMethod = await invoke(route, fakeReq('GET'))
  assert.equal(wrongMethod.status(), 405)
  assert.deepEqual(wrongMethod.json(), { error: 'POST only' })
  assert.equal(writes.length, 0)

  const unknownKey = await invoke(route, fakeReq('POST', '/', { key: 'notAKey', value: 1 }))
  assert.equal(unknownKey.status(), 400)
  assert.deepEqual(unknownKey.json(), { error: 'key not settable' })
  assert.equal(writes.length, 0)

  const badArray = await invoke(route, fakeReq('POST', '/', { key: 'hiddenModels', value: 'nope' }))
  assert.equal(badArray.status(), 400)
  assert.deepEqual(badArray.json(), { error: 'hiddenModels must be an array of model ids' })
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
})

test('/pool returns pool data and /pool/enable maps failure to 400', async () => {
  let notified = 0
  const webServer = fakeWebServer()
  registerRoutes(webServer, fakeServices({
    pool: {
      getPoolData: () => POOL_DATA,
      getAccounts: () => [],
      getAccount: () => undefined,
      setAccountEnabled: () => false,
    },
    notifyPicker: () => {
      notified++
    },
  }))
  const list = await invoke(routeFor(webServer.routes, '/plugins/agy-link/pool'), fakeReq('GET'))
  assert.equal(list.status(), 200)
  assert.deepEqual(list.json(), POOL_DATA)

  const enable = await invoke(
    routeFor(webServer.routes, '/plugins/agy-link/pool/enable'),
    fakeReq('POST', '/', { id: 'missing', enabled: false }),
  )
  assert.equal(enable.status(), 400)
  assert.deepEqual(enable.json(), { ok: false, pool: POOL_DATA })
  assert.equal(notified, 0, 'a failed enable must not announce a picker update')

  const wrongMethod = await invoke(
    routeFor(webServer.routes, '/plugins/agy-link/pool/begin-add'),
    fakeReq('GET'),
  )
  assert.equal(wrongMethod.status(), 405)
  assert.deepEqual(wrongMethod.json(), { error: 'POST only' })
})
