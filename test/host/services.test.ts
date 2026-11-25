// Coverage for the composition factory `createHostServices`.
//
// This exercises the REAL factory (no mocking of the module) against a temp
// DSH home/state dir so it never reads or writes the developer's ~/.dsh or
// ~/.gemini. Nothing here starts agy: the factory only constructs objects and
// resolves the binary by filesystem probe.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defaultConfig } from '../../src/common/types.ts'
import { createHostServices } from '../../src/host/services.ts'

type FakeCtx = {
  logger?: { info: (m: string) => void }
  emit?: (event: string) => void
  get?: (key: string) => unknown
  sessions?: unknown
}
const asCtx = (ctx: FakeCtx): Context => ctx as unknown as Context

/**
 * Redirect HOME and every DSH path to a fresh temp dir for the test, and restore
 * the whole environment afterwards. Every test gets its own sandbox.
 */
function sandbox(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'agy-services-'))
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(process.env)) saved[k] = process.env[k]
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.LOCALAPPDATA = root
  process.env.APPDATA = root
  process.env.DSH_HOME = root
  process.env.DSH_STATE_DIR = root
  process.env.DSH_AGY_ACCOUNTS_DIR = root
  process.env.PATH = ''
  delete process.env.DSH_AGY_BIN
  delete process.env.DSH_AGY_ENABLED
  delete process.env.DSH_AGY_DEFAULT_MODEL
  delete process.env.DSH_AGY_PROXY_URL
  t.after(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v
    }
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

/** A stub agy executable. Running it writes a marker so a spawn is detectable. */
function stubBin(dir: string, name: string, marker?: string): string {
  const p = join(dir, name)
  const body = marker === undefined ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\necho spawned >> ' + JSON.stringify(marker) + '\n'
  writeFileSync(p, body)
  chmodSync(p, 0o755)
  return p
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('returns the full services shape with sane defaults', (t) => {
  const root = sandbox(t)
  const services = createHostServices(asCtx({}), {})

  for (const key of ['getConfig', 'log', 'notifyPicker', 'bin', 'version', 'setOverride', 'readEffortUnsupported', 'rememberEffortUnsupported', 'sessionsSvc', 'mediaDir', 'onConfigWritten']) {
    assert.equal(typeof (services as unknown as Record<string, unknown>)[key], 'function', key + ' should be a function')
  }
  for (const key of ['status', 'store', 'pool', 'quota', 'warmup', 'catalog', 'auth', 'poolAuth', 'runs', 'adapter', 'translation', 'bridgeState', 'webServerPort']) {
    assert.equal(typeof (services as unknown as Record<string, unknown>)[key], 'object', key + ' should be an object')
  }
  assert.ok(services.sessionAuto instanceof Map)
  assert.equal(services.sessionAuto.size, 0)
  assert.equal(services.lastRun, null)
  assert.equal(typeof services.lastParser, 'object')
  assert.equal(services.hostDir, '')
  assert.equal(services.bridgeState.bridge, null)
  assert.deepEqual(services.bridgeState.restores, [])
  assert.equal(typeof services.bridgeState.log, 'function')
  assert.deepEqual({ ...services.webServerPort }, {})
  assert.equal(services.webServerPort.current, undefined)
  assert.equal(services.status.version, null)
  assert.equal(services.status.dormantReason, null)
  assert.equal(services.version(), null)
  assert.equal(services.onConfigWritten('k', 1), undefined)
  // mediaDir falls back to <stateDir>/media for an empty cfg.mediaDir.
  assert.equal(services.mediaDir(), join(root, 'agy-link', 'media'))
})

// ---------------------------------------------------------------------------
// Config resolution through the factory's getConfig
// ---------------------------------------------------------------------------

test('getConfig reflects entryConfig, runtime overrides and env (env wins)', (t) => {
  sandbox(t)
  const services = createHostServices(asCtx({}), {
    enabled: false,
    defaultModel: 'entry-model',
    workspaceRoot: '/entry/ws',
  })
  assert.equal(services.getConfig().enabled, false)
  assert.equal(services.getConfig().defaultModel, 'entry-model')
  assert.equal(services.getConfig().workspaceRoot, '/entry/ws')

  // Runtime override beats entryConfig.
  services.setOverride('defaultModel', 'override-model')
  assert.equal(services.getConfig().defaultModel, 'override-model')
  assert.equal(services.getConfig().enabled, false)

  // Env wins last.
  process.env.DSH_AGY_DEFAULT_MODEL = 'env-model'
  process.env.DSH_AGY_ENABLED = 'true'
  assert.equal(services.getConfig().defaultModel, 'env-model')
  assert.equal(services.getConfig().enabled, true)

  delete process.env.DSH_AGY_DEFAULT_MODEL
  delete process.env.DSH_AGY_ENABLED
  assert.equal(services.getConfig().defaultModel, 'override-model')
  assert.equal(services.getConfig().enabled, false)
})

test('getConfig covers mcpConfigScope / disableTelemetry / quotaViaCli / workspaceRoot / proxyUrl branches', (t) => {
  sandbox(t)
  const base = defaultConfig()
  const services = createHostServices(asCtx({}), {
    mcpConfigScope: 'workspace',
    disableTelemetry: true,
    quotaViaCli: true,
    workspaceRoot: '/ws',
    proxyUrl: 'http://proxy:1',
  })
  assert.equal(services.getConfig().mcpConfigScope, 'workspace')
  assert.equal(services.getConfig().disableTelemetry, true)
  assert.equal(services.getConfig().quotaViaCli, true)
  assert.equal(services.getConfig().workspaceRoot, '/ws')
  assert.equal(services.getConfig().proxyUrl, 'http://proxy:1')

  // An unknown scope falls back to the default enum value.
  const bad = createHostServices(asCtx({}), { mcpConfigScope: 'bogus' })
  assert.equal(bad.getConfig().mcpConfigScope, base.mcpConfigScope)

  // Empty strings are ignored by the layered read (base defaults win).
  const empty = createHostServices(asCtx({}), { workspaceRoot: '', proxyUrl: '' })
  assert.equal(empty.getConfig().workspaceRoot, base.workspaceRoot)
  assert.equal(empty.getConfig().proxyUrl, base.proxyUrl)

  // Env overrides for the same knobs.
  process.env.DSH_AGY_MCP_CONFIG_SCOPE = 'both'
  process.env.DSH_AGY_DISABLE_TELEMETRY = 'false'
  process.env.DSH_AGY_QUOTA_VIA_CLI = 'false'
  process.env.DSH_AGY_WORKSPACE_ROOT = '/env-ws'
  process.env.DSH_AGY_PROXY_URL = 'http://env-proxy:2'
  assert.equal(services.getConfig().mcpConfigScope, 'both')
  assert.equal(services.getConfig().disableTelemetry, false)
  assert.equal(services.getConfig().quotaViaCli, false)
  assert.equal(services.getConfig().workspaceRoot, '/env-ws')
  assert.equal(services.getConfig().proxyUrl, 'http://env-proxy:2')
})

test('mediaDir honours a configured mediaDir', (t) => {
  sandbox(t)
  const services = createHostServices(asCtx({}), { mediaDir: '/custom/media' })
  assert.equal(services.mediaDir(), '/custom/media')
})

// ---------------------------------------------------------------------------
// log / notifyPicker
// ---------------------------------------------------------------------------

test('log prefixes messages and tolerates a ctx without a logger', (t) => {
  sandbox(t)
  const lines: string[] = []
  const withLogger = createHostServices(asCtx({ logger: { info: (m: string) => lines.push(m) } }), {})
  withLogger.log('hello')
  withLogger.log('world')
  assert.deepEqual(lines, ['[dsh-agy-link] hello', '[dsh-agy-link] world'])

  const noLogger = createHostServices(asCtx({}), {})
  assert.doesNotThrow(() => noLogger.log('silent'))
})

test('notifyPicker emits llm/models-updated + llm/adapters-updated and tolerates missing/throwing emit', (t) => {
  sandbox(t)
  const events: string[] = []
  const emitted = createHostServices(asCtx({ emit: (e: string) => events.push(e) }), {})
  emitted.notifyPicker()
  assert.deepEqual(events, ['llm/models-updated', 'llm/adapters-updated'])

  const noEmit = createHostServices(asCtx({}), {})
  assert.doesNotThrow(() => noEmit.notifyPicker())

  const throwing = createHostServices(asCtx({ emit: () => {
    throw new Error('no listeners')
  } }), {})
  assert.doesNotThrow(() => throwing.notifyPicker())
})

// ---------------------------------------------------------------------------
// status / version / bin / setOverride
// ---------------------------------------------------------------------------

test('status getters/setters are live and version() follows status.version', (t) => {
  sandbox(t)
  const services = createHostServices(asCtx({}), {})
  services.status.version = '1.2.3'
  services.status.dormantReason = 'agy too old'
  assert.equal(services.version(), '1.2.3')
  assert.equal(services.status.version, '1.2.3')
  assert.equal(services.status.dormantReason, 'agy too old')
  services.status.version = null
  services.status.dormantReason = null
  assert.equal(services.version(), null)
  assert.equal(services.status.dormantReason, null)
})

test('bin resolves a configured executable and setOverride resets the bin cache', (t) => {
  const root = sandbox(t)
  const first = stubBin(root, 'agy-one')
  const second = stubBin(root, 'agy-two')
  process.env.DSH_AGY_BIN = first
  const services = createHostServices(asCtx({}), {})
  assert.equal(services.bin(), first)

  // Cached: an env change is not observed until the cache is reset.
  process.env.DSH_AGY_BIN = second
  assert.equal(services.bin(), first)

  services.setOverride('defaultEffort', 'low')
  assert.equal(services.bin(), second)
})

test('bin returns null when no agy candidate exists', (t) => {
  sandbox(t) // PATH='' and HOME=temp => no ~/.local/bin/agy and no absolute hits
  const services = createHostServices(asCtx({}), {})
  assert.equal(services.bin(), null)
})

test('setOverride writes runtime-overrides.json under the temp state dir', (t) => {
  const root = sandbox(t)
  const services = createHostServices(asCtx({}), {})
  services.setOverride('defaultEffort', 'low')
  services.setOverride('hiddenModels', ['a', 'b'])

  const file = join(root, 'agy-link', 'runtime-overrides.json')
  assert.ok(existsSync(file), 'overrides file written under DSH_HOME/agy-link')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { defaultEffort: 'low', hiddenModels: ['a', 'b'] })
  assert.equal(services.getConfig().defaultEffort, 'low')
  assert.deepEqual(services.getConfig().hiddenModels, ['a', 'b'])
})

test('setOverride logs instead of throwing when the state dir cannot be created', (t) => {
  const root = sandbox(t)
  // Make `agy-link` a regular FILE so mkdirSync(..., {recursive:true}) fails.
  writeFileSync(join(root, 'agy-link'), 'blocker')
  const lines: string[] = []
  const services = createHostServices(asCtx({ logger: { info: (m: string) => lines.push(m) } }), {})
  assert.doesNotThrow(() => services.setOverride('defaultEffort', 'low'))
  assert.ok(lines.some((l) => l.includes('failed to persist override')), 'failure is logged')
})

// ---------------------------------------------------------------------------
// effort-unsupported persistence
// ---------------------------------------------------------------------------

test('readEffortUnsupported filters the list and observes external edits (issue #115)', (t) => {
  const root = sandbox(t)
  mkdirSync(join(root, 'agy-link'), { recursive: true })
  writeFileSync(join(root, 'agy-link', 'effort-unsupported.json'), JSON.stringify(['a', '', 2, ' b ', 'a', null]))
  const services = createHostServices(asCtx({}), {})
  // Only non-empty strings are kept; duplicates are preserved (unlike config lists).
  assert.deepEqual(services.readEffortUnsupported(), ['a', ' b ', 'a'])
  // An operator clearing/fixing the file must not need a host restart.
  writeFileSync(join(root, 'agy-link', 'effort-unsupported.json'), JSON.stringify(['z']))
  assert.deepEqual(services.readEffortUnsupported(), ['z'])
})

test('readEffortUnsupported tolerates a missing or invalid file', (t) => {
  const root = sandbox(t)
  const missing = createHostServices(asCtx({}), {})
  assert.deepEqual(missing.readEffortUnsupported(), [])

  mkdirSync(join(root, 'agy-link'), { recursive: true })
  writeFileSync(join(root, 'agy-link', 'effort-unsupported.json'), 'not json')
  const invalid = createHostServices(asCtx({}), {})
  assert.deepEqual(invalid.readEffortUnsupported(), [])

  writeFileSync(join(root, 'agy-link', 'effort-unsupported.json'), JSON.stringify({ not: 'array' }))
  const nonArray = createHostServices(asCtx({}), {})
  assert.deepEqual(nonArray.readEffortUnsupported(), [])
})

test('rememberEffortUnsupported persists, announces, and de-duplicates case/space-insensitively', (t) => {
  const root = sandbox(t)
  mkdirSync(join(root, 'agy-link'), { recursive: true })
  writeFileSync(join(root, 'agy-link', 'effort-unsupported.json'), JSON.stringify(['a']))
  const events: string[] = []
  const services = createHostServices(asCtx({ emit: (e: string) => events.push(e) }), {})

  services.rememberEffortUnsupported('claude-sonnet-4-6')
  const file = join(root, 'agy-link', 'effort-unsupported.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['a', 'claude-sonnet-4-6'])
  assert.deepEqual(events, ['llm/models-updated', 'llm/adapters-updated'])

  // Same model (case/whitespace-insensitive) is a no-op: no second event/write.
  services.rememberEffortUnsupported('  CLAUDE-SONNET-4-6 ')
  assert.deepEqual(events, ['llm/models-updated', 'llm/adapters-updated'])
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['a', 'claude-sonnet-4-6'])
})

test('createHostServices wires per-account catalog into pool.isModelSupported and dsh-agent model.select', async (t) => {
  sandbox(t)
  const selected: unknown[] = []
  const fakeAgents = {
    resolve: async (id: unknown) => (id === 'sess-1' ? { model: { select: (s: unknown) => selected.push(s) } } : undefined),
  }
  const services = createHostServices(asCtx({ get: (k) => (k === 'agents' ? fakeAgents : undefined) }), {})
  const acc1 = services.pool.getAccounts()[0]!
  const acc2 = services.pool.createAccountSlot('Secondary')

  // Populate discovered catalog ONLY for acc1 (with Argon), leave acc2 un-probed
  ;(services.catalog as any).accountCatalogs.set(acc1.id, {
    source: 'discovered',
    models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['high'] }],
    discoveredAt: Date.now(),
  })
  ;(services.catalog as any).current = (services.catalog as any).accountCatalogs.get(acc1.id)

  assert.equal(services.pool.isModelSupported(acc1, 'gemini-4-argon'), true, 'pool must see acc1 discovered catalog')
  assert.equal(services.pool.isModelSupported(acc2, 'gemini-4-argon'), false, 'un-probed acc2 must not inherit acc1 Argon')

  // Verify syncSessionModel reaches dsh-agent's resolve(id).model.select(...)
  ;(services.adapter as any).deps.syncSessionModel('sess-1', 'gemini-3.8-flash', 'high')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(selected.length, 1)
  assert.deepEqual(selected[0], { provider: 'antigravity', model: 'gemini-3.8-flash', reasoningEffort: 'high' })
})

test('rememberEffortUnsupported logs instead of throwing when persistence fails', (t) => {
  const root = sandbox(t)
  writeFileSync(join(root, 'agy-link'), 'blocker')
  const lines: string[] = []
  const services = createHostServices(asCtx({ logger: { info: (m: string) => lines.push(m) } }), {})
  assert.doesNotThrow(() => services.rememberEffortUnsupported('m'))
  assert.ok(lines.some((l) => l.includes('failed to persist the effort-unsupported')), 'failure is logged')
})

// ---------------------------------------------------------------------------
// sessionsSvc
// ---------------------------------------------------------------------------

test('sessionsSvc prefers ctx.get("sessions") and falls back to ctx.sessions', (t) => {
  sandbox(t)
  const fromGet = { get: () => undefined }
  const a = createHostServices(asCtx({ get: (k) => (k === 'sessions' ? fromGet : undefined) }), {})
  assert.equal(a.sessionsSvc(), fromGet)

  const fromProp = { get: () => undefined }
  const b = createHostServices(asCtx({ get: () => undefined, sessions: fromProp }), {})
  assert.equal(b.sessionsSvc(), fromProp)

  const none = createHostServices(asCtx({ get: () => undefined }), {})
  assert.equal(none.sessionsSvc(), undefined)
})

// ---------------------------------------------------------------------------
// Construction side-effect isolation
// ---------------------------------------------------------------------------

test('constructing does not spawn agy and stays inside the temp HOME', (t) => {
  const root = sandbox(t)
  const marker = join(root, 'spawned.txt')
  const bin = stubBin(root, 'agy-marker', marker)
  process.env.DSH_AGY_BIN = bin

  assert.equal(homedir(), root, 'HOME is redirected to the temp dir before construction')
  const services = createHostServices(asCtx({}), {})

  // The factory resolves the binary by filesystem probe, never by executing it.
  assert.equal(services.bin(), bin)
  assert.equal(existsSync(marker), false, 'agy was not spawned during construction or bin resolution')
  assert.equal(services.bridgeState.bridge, null)
  assert.deepEqual(services.bridgeState.restores, [])
  assert.equal(typeof services.bridgeState.log, 'function')
})

test('issue #139: activeCwds reads the session store list() (DSH has no values())', (t) => {
  sandbox(t)
  // DSH's SessionStore exposes list()/get(id); `values()` never existed, so the
  // old cast made this always empty and every workspace file was refused by
  // /open and /media with "path outside allowed workspace roots".
  const sessions = {
    get: () => undefined,
    list: () => [
      { header: { cwd: 'C:\\work\\alpha' } },
      { header: { cwd: 'C:\\work\\beta' } },
      { header: { cwd: 'C:\\work\\alpha' } },
      { header: {} },
    ],
  }
  const services = createHostServices(asCtx({ get: (k: string) => (k === 'sessions' ? sessions : undefined) }), {})
  assert.deepEqual(services.activeCwds(), ['C:\\work\\alpha', 'C:\\work\\beta'])
})

test('issue #139: activeCwds still works when a host only exposes values()', (t) => {
  sandbox(t)
  const sessions = { get: () => undefined, values: () => [{ header: { cwd: '/work/legacy' } }] }
  const services = createHostServices(asCtx({ get: (k: string) => (k === 'sessions' ? sessions : undefined) }), {})
  assert.deepEqual(services.activeCwds(), ['/work/legacy'])
})

test('issue #139: activeCwds degrades to empty when the sessions service is unusable', (t) => {
  sandbox(t)
  const throwing = { get: () => undefined, list: () => { throw new Error('boom') } }
  const services = createHostServices(asCtx({ get: (k: string) => (k === 'sessions' ? throwing : undefined) }), {})
  assert.deepEqual(services.activeCwds(), [])
})

test('global ModelCatalog discovery skips disabled primaryAccountId and rejects when all accounts are disabled', async (t) => {
  const root = sandbox(t)
  const isWin = process.platform === 'win32'
  const fakeBin = join(root, isWin ? 'agy.cmd' : 'agy')
  const logFile = join(root, 'probe-homes.log')
  writeFileSync(
    fakeBin,
    isWin
      ? [
          '@echo off',
          `echo home=%HOME%>> "${logFile}"`,
          'echo gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
          'echo gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          'echo "home=$HOME" >> "' + logFile + '"',
          'echo "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)"',
          'echo "gemini-3.8-flash-high\tGemini 3.8 Flash (High)"',
        ].join('\n'),
  )
  chmodSync(fakeBin, 0o755)
  process.env.DSH_AGY_BIN = fakeBin

  const services = createHostServices(asCtx({}), {})
  const primary = services.pool.getAccounts().find((a) => a.systemHome)!
  const secondary = services.pool.createAccountSlot('sec')
  services.pool.setAccountEnabled(primary.id, false)

  await services.catalog.forceRefresh()
  const logged = readFileSync(join(root, 'probe-homes.log'), 'utf8').trim().split('\n')
  assert.equal(logged.at(-1), `home=${secondary.dir}`, 'disabled primary must be skipped in favor of enabled secondary')
  assert.equal(
    services.catalog.getAccountCatalog(secondary.id)?.models.some((m) => m.id === 'gemini-3.8-flash'),
    true,
    'global discovery must also populate the probed account catalog so accountSupportsModel sees it immediately',
  )

  services.pool.setAccountEnabled(secondary.id, false)
  await services.catalog.forceRefresh()
  assert.match(services.catalog.get().lastError ?? '', /no enabled account available/)
})
