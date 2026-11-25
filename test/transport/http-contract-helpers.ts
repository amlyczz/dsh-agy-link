// Shared fixtures for the HTTP contract suite (split from http-contract.test.ts).
//
// Every http-contract-*.test.ts file imports its services double, request/response
// fakes and pool double from here so the fake surface is defined exactly once.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { registerRoutes } from '../../src/transport/http/router.ts'
import type { HostServices } from '../../src/host/services.ts'
import type { Route } from '../../src/transport/http/respond.ts'

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
export const EXPECTED_ROUTES: ReadonlyArray<readonly [kind: string, path: string]> = [
  ['exact', '/plugins/agy-link/status'],
  ['exact', '/plugins/agy-link/session-view'],
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
  ['exact', '/plugins/agy-link/pool/alias'],
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
  ['exact', '/plugins/agy-link/embed'],
  ['exact', '/plugins/agy-link/ecosystem'],
  ['exact', '/plugins/agy-link/ecosystem/sync'],
  ['exact', '/plugins/agy-link/ecosystem/plugin'],
  ['exact', '/plugins/agy-link/btw/state'],
  ['exact', '/plugins/agy-link/btw/stream'],
  ['exact', '/plugins/agy-link/btw/ask'],
  ['exact', '/plugins/agy-link/btw/cancel'],
  ['exact', '/plugins/agy-link/btw/dismiss'],
  ['exact', '/plugins/agy-link/btw/clear'],
  ['exact', '/plugins/agy-link/lease'],
  ['exact', '/plugins/agy-link/lease/acquire'],
  ['exact', '/plugins/agy-link/lease/renew'],
  ['exact', '/plugins/agy-link/lease/release'],
  ['prefix', '/plugins/agy-link/assets'],
]

/** Routes that reject every non-POST method with `405 {error:'POST only'}`. */
export const POST_ONLY_ROUTES = [
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
  '/plugins/agy-link/pool/alias',
  '/plugins/agy-link/pool/primary',
  '/plugins/agy-link/pool/mode',
  '/plugins/agy-link/pool/refresh-quota',
  '/plugins/agy-link/pool/warmup',
  '/plugins/agy-link/pool/clear-cooldown',
  '/plugins/agy-link/pool/set-active',
  '/plugins/agy-link/pool/reorder',
  '/plugins/agy-link/config',
  '/plugins/agy-link/translate',
  '/plugins/agy-link/open',
  '/plugins/agy-link/ecosystem/sync',
  '/plugins/agy-link/ecosystem/plugin',
  '/plugins/agy-link/btw/ask',
  '/plugins/agy-link/btw/cancel',
  '/plugins/agy-link/btw/dismiss',
  '/plugins/agy-link/btw/clear',
] as const

export type FakeWebServer = {
  routes: Route[]
  disposed: string[]
  register(route: Route): () => void
}

export function fakeWebServer(): FakeWebServer {
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

export const POOL_DATA = { accounts: [], mode: 'sequential', primaryAccountId: null }

export type Overrides = Partial<Record<string, unknown>>
export type ConfigOverrides = Record<string, unknown>

export const BASE_CONFIG: Record<string, unknown> = {
  enabled: true,
  permissionMode: 'default',
  sandbox: false,
  agent: '',
  agySettings: '',
  transport: 'cli',
  mcpBridge: false,
  btwEnabled: true,
  imageTool: true,
  syncAccountCustomizations: true,
  workspaceRoot: '/tmp/agy-contract',
  defaultModel: 'gemini-3-flash',
  defaultEffort: 'high',
  askTool: false,
  hiddenModels: [] as string[],
  selectedModels: [] as string[],
  autoWarmup: false,
  warmupModels: [] as string[],
  autoTranslate: false,
  translateModel: '',
  translateEffort: '',
  translateTargetLanguage: 'zh',
  showHeaderBadge: true,
  showTranslateAction: true,
  poolWideCatalog: false,
  imageModel: '',
  imageEffort: '',
  imageOutputDir: '',
  btwModel: '',
  btwEffort: 'low',
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
export function fakeServices(overrides: Overrides = {}, config: ConfigOverrides = {}): HostServices {
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
    acpPool: { status: () => ({ activeProcesses: 0, sessions: 0, keys: [] }) },
    ecosystem: {
      inspect: () => ({
        primaryHome: '/tmp/agy-primary',
        plugins: [],
        mcpServers: [],
        skills: [],
        rules: [],
        agents: [],
        syncedAccountCount: 0,
        lastSyncAt: null,
      }),
      syncAll: () => ({
        primaryHome: '/tmp/agy-primary',
        syncedAccounts: [],
        skippedAccounts: [],
        copiedFiles: 0,
        removedFiles: 0,
        errors: [],
        syncedAt: 1,
      }),
      setPluginEnabled: (id: string, enabled: boolean) => ({
        primaryHome: '/tmp/agy-primary',
        plugins: [{ id, name: id, enabled, source: 'global', hasMcp: false, hasHooks: false, skillCount: 0, ruleCount: 0, path: '/tmp/' + id }],
        mcpServers: [],
        skills: [],
        rules: [],
        agents: [],
        syncedAccountCount: 0,
        lastSyncAt: null,
      }),
    },
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

export type Captured = {
  res: unknown
  done: Promise<void>
  status: () => number
  headers: () => Record<string, string>
  text: () => string
  json: () => unknown
}

/** Fake ServerResponse that resolves `done` when the handler ends the response. */
export function capture(): Captured {
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
export function fakeReq(method: string, url = '/', body?: unknown): unknown {
  return rawReq(method, url, body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
}

/** Fake IncomingMessage from raw chunks (malformed / oversized bodies). */
export function rawReq(method: string, url = '/', chunks: Buffer[] = []): unknown {
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

export function oversizedReq(method: string, url = '/'): unknown {
  return rawReq(method, url, [Buffer.from(JSON.stringify({ text: 'x'.repeat(1_100_000) }))])
}

export async function invoke(route: Route, req: unknown): Promise<Captured> {
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

export function routeFor(routes: Route[], path: string): Route {
  const route = routes.find((r) => r.path === path)
  assert.ok(route, 'route must be registered: ' + path)
  return route
}

export type Spy<T> = ((...args: unknown[]) => T) & { calls: unknown[][] }
export function spy<T>(ret: T): Spy<T> {
  const calls: unknown[][] = []
  const fn = (...args: unknown[]): T => {
    calls.push(args)
    return ret
  }
  return Object.assign(fn, { calls })
}

/** Full pool double: every method a pool route can touch, with recorded calls. */
export function poolDouble(overrides: Record<string, unknown> = {}) {
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
export function setup(overrides: Overrides = {}, config: ConfigOverrides = {}) {
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
