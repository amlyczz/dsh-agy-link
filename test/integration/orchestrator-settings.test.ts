import '../helpers/client-render.ts'
import { React, renderToStaticMarkup } from '../helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildOrchestratorSettingsObject,
  isOrchestratorModel,
  isOrchestratorRoleModel,
  mergeOrchestratorIntoAgySettings,
  resolveOrchestratorRoleSlug,
} from '../../src/common/orchestrator.ts'
import { agySettingsFilePath, syncOrchestratorSettingsFileAt } from '../../src/runtime/agy/settings-sync.ts'
import { prepareOrchestratorSettingsForAcp } from '../../src/features/acp/orchestrator-prep.ts'
import { resolveConfig } from '../../src/common/config.ts'
import { defaultConfig, type PluginConfig } from '../../src/common/types/config.ts'
import { effortLabel } from '../../src/common/reasoning.ts'
import { buildSpawnArgs, resolveEffectiveAgySettings, type AttemptDeps, type AttemptInput } from '../../src/provider/attempt.ts'
import { runAgyAttempt } from '../../src/provider/attempt-outcome.ts'
import { RunRegistry } from '../../src/host/recording.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { runAgyOnce } from '../../src/host/oneshot.ts'
import { renderStatus } from '../../src/host/commands/status.ts'
import { registerRoutes } from '../../src/transport/http/router.ts'
import type { HostServices } from '../../src/host/services.ts'
import type { Route } from '../../src/transport/http/respond.ts'
import { orchestratorEffortOptions, orchestratorRoleModels, orchestratorRoleModelsFor, type EffortLabels } from '../../src/client/config-options.ts'
import { renderOrchestratorRows } from '../../src/client/sections/OrchestratorSettingsRows.ts'
import { zh } from '../../src/client/locales/zh.ts'
import { en } from '../../src/client/locales/en.ts'

const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement

const EFFORT_LABELS: EffortLabels = { auto: 'Auto', level: (id) => effortLabel(id) }

test('isOrchestratorModel identifies orchestrator role slugs and excludes worker models', () => {
  assert.equal(isOrchestratorModel('gemini-pro-orchestrator'), true)
  assert.equal(isOrchestratorModel('gemini-pro-orchestrator-neon'), true)
  assert.equal(isOrchestratorModel('gemini-pro-orchestrator-argon'), true)
  assert.equal(isOrchestratorModel('gemini-pro-orchestrator-g1-pro'), true)
  assert.equal(isOrchestratorModel('agy/gemini-pro-orchestrator-neon'), true)
  assert.equal(isOrchestratorModel('gemini-4-neon'), false)
  assert.equal(isOrchestratorModel('gemini-4-argon'), false)
  assert.equal(isOrchestratorModel('claude-opus-5-5'), false)
  assert.equal(isOrchestratorModel(''), false)
  assert.equal(isOrchestratorModel(undefined), false)
})

test('resolveOrchestratorRoleSlug builds tiered slugs and guards fixed-effort models', () => {
  assert.equal(resolveOrchestratorRoleSlug('', 'high'), undefined)
  assert.equal(resolveOrchestratorRoleSlug('gemini-4-neon', ''), 'gemini-4-neon')
  assert.equal(
    resolveOrchestratorRoleSlug('gemini-4-neon', 'xhigh', ['low', 'medium', 'high', 'xhigh']),
    'gemini-4-neon-xhigh',
  )
  assert.equal(
    resolveOrchestratorRoleSlug('gemini-4-neon-medium', 'xhigh', ['low', 'medium', 'high', 'xhigh']),
    'gemini-4-neon-xhigh',
  )
  // Unsupported effort falls back to base slug instead of fabricating an invalid slug.
  assert.equal(
    resolveOrchestratorRoleSlug('gemini-3.8-flash', 'xhigh', ['low', 'medium', 'high']),
    'gemini-3.8-flash',
  )
  // gpt-oss-120b-medium carries `-medium` inside its canonical id and has no selectable effort tiers.
  assert.equal(resolveOrchestratorRoleSlug('gpt-oss-120b-medium', 'high', []), 'gpt-oss-120b-medium')
  assert.equal(resolveOrchestratorRoleSlug('gpt-oss-120b-medium', 'high'), 'gpt-oss-120b-medium')
})

test('buildOrchestratorSettingsObject and mergeOrchestratorIntoAgySettings preserve unrelated keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-orch-merge-'))
  try {
    const emptyCfg = defaultConfig()
    assert.equal(buildOrchestratorSettingsObject(emptyCfg), undefined)

    // Unsupported effort for Carbon (low/medium/high only) falls back to base slug using fallback catalog
    assert.deepEqual(
      buildOrchestratorSettingsObject({
        orchestratorPlannerModel: 'gemini-4-carbon',
        orchestratorPlannerEffort: 'xhigh',
        orchestratorExecutorModel: 'gemini-4-hydrogen',
        orchestratorExecutorEffort: 'high',
      }),
      {
        planner: 'gemini-4-carbon',
        executor: 'gemini-4-hydrogen-high',
      },
    )

    const orch = buildOrchestratorSettingsObject({
      orchestratorPlannerModel: 'gemini-4-neon',
      orchestratorPlannerEffort: 'xhigh',
      orchestratorExecutorModel: 'gemini-4-hydrogen',
      orchestratorExecutorEffort: 'high',
    })
    assert.deepEqual(orch, {
      planner: 'gemini-4-neon-xhigh',
      executor: 'gemini-4-hydrogen-high',
    })

    // Fresh inline JSON when base settings are empty
    assert.equal(
      mergeOrchestratorIntoAgySettings(undefined, orch),
      JSON.stringify({ orchestrator: { planner: 'gemini-4-neon-xhigh', executor: 'gemini-4-hydrogen-high' } }),
    )

    // Merge into inline base JSON without clobbering unrelated fields or partial orchestrator keys
    const mergedInline = JSON.parse(
      mergeOrchestratorIntoAgySettings(
        '{"theme":"dark","orchestrator":{"executor":"claude-opus-5-5-medium"}}',
        { planner: 'gemini-4-neon-xhigh' },
      )!,
    )
    assert.deepEqual(mergedInline, {
      theme: 'dark',
      orchestrator: {
        executor: 'claude-opus-5-5-medium',
        planner: 'gemini-4-neon-xhigh',
      },
    })

    // Merge from settings JSON file path without mutating the file
    const filePath = join(dir, 'settings.json')
    writeFileSync(filePath, JSON.stringify({ sandbox: true, existing: 42 }), 'utf8')
    const mergedFile = JSON.parse(
      mergeOrchestratorIntoAgySettings(filePath, orch, (p) => (p === filePath ? '{"sandbox":true,"existing":42}' : ''))!,
    )
    assert.deepEqual(mergedFile, {
      sandbox: true,
      existing: 42,
      orchestrator: { planner: 'gemini-4-neon-xhigh', executor: 'gemini-4-hydrogen-high' },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue #204: the Planner/Executor dropdown follows agy\'s role whitelist', () => {
  const catalog = [
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
  ]
  assert.deepEqual(
    orchestratorRoleModelsFor('planner', catalog).map((m) => m.id),
    ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'claude-opus-5-5'],
  )
  assert.deepEqual(
    orchestratorRoleModelsFor('executor', catalog).map((m) => m.id),
    ['gemini-4-hydrogen', 'claude-sonnet-5-5'],
  )
  // Effort suffixes and the agy/ prefix are presentation variants of the same id.
  assert.equal(isOrchestratorRoleModel('planner', 'gemini-4-neon-xhigh'), true)
  assert.equal(isOrchestratorRoleModel('planner', 'agy/gemini-4-neon-high'), true)
  assert.equal(isOrchestratorRoleModel('planner', 'claude-opus-5-5@default'), true)
  assert.equal(isOrchestratorRoleModel('executor', 'gemini-4-neon'), false)
  assert.equal(isOrchestratorRoleModel('planner', 'gemini-3.8-flash'), false)
  // The Btw dropdown is NOT role-scoped and keeps every worker model.
  assert.equal(orchestratorRoleModels(catalog).includes(catalog[6]!), true)
})

test('issue #204: syncOrchestratorSettingsFileAt merges settings.json and reports real changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-orch-settings-file-'))
  try {
    const file = agySettingsFilePath(dir)
    assert.equal(syncOrchestratorSettingsFileAt(file, undefined), 'skipped')

    const payload = { planner: 'gemini-4-neon-high', executor: 'gemini-4-hydrogen-medium' }
    assert.equal(syncOrchestratorSettingsFileAt(file, payload), 'written')
    const first = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.deepEqual(first.orchestrator, payload)

    // Re-running with the same seats must not rewrite (no ACP recycle noise).
    assert.equal(syncOrchestratorSettingsFileAt(file, payload), 'unchanged')

    // Unrelated keys and the rest of the orchestrator object survive a merge.
    writeFileSync(file, JSON.stringify({ theme: 'dark', orchestrator: { keep: true, ...payload } }), 'utf8')
    assert.equal(syncOrchestratorSettingsFileAt(file, { planner: 'claude-opus-5-5' }), 'written')
    const merged = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(merged.theme, 'dark')
    assert.deepEqual(merged.orchestrator, { keep: true, ...payload, planner: 'claude-opus-5-5' })

    // A corrupt document is never overwritten by the sync helper.
    writeFileSync(file, '{ not json', 'utf8')
    assert.equal(syncOrchestratorSettingsFileAt(file, payload), 'skipped')
    assert.equal(readFileSync(file, 'utf8'), '{ not json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue #204: prepareOrchestratorSettingsForAcp writes settings and tags the process key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-orch-prep-'))
  const prevHome = process.env.HOME
  process.env.HOME = dir
  try {
    const cfg = {
      ...defaultConfig(),
      orchestratorPlannerModel: 'gemini-4-neon',
      orchestratorPlannerEffort: 'high',
      orchestratorExecutorModel: 'gemini-4-hydrogen',
      orchestratorExecutorEffort: 'high',
    }
    // A worker model never touches settings.json and carries no key tag.
    assert.deepEqual(
      prepareOrchestratorSettingsForAcp({ cfg, activeModel: 'gemini-4-neon', account: undefined }),
      { ok: true },
    )

    const first = prepareOrchestratorSettingsForAcp({ cfg, activeModel: 'gemini-pro-orchestrator-neon', account: undefined })
    assert.equal(first.ok, true)
    assert.equal(first.ok && first.settingsTag, JSON.stringify({ planner: 'gemini-4-neon-high', executor: 'gemini-4-hydrogen-high' }))
    const file = agySettingsFilePath(dir)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).orchestrator, {
      planner: 'gemini-4-neon-high',
      executor: 'gemini-4-hydrogen-high',
    })

    // Stable tag across turns: the resident ACP process stays reusable.
    const second = prepareOrchestratorSettingsForAcp({ cfg, activeModel: 'gemini-pro-orchestrator-neon', account: undefined })
    assert.equal(second.ok && second.settingsTag, first.ok && first.settingsTag)

    // An unparsable document is never overwritten: the caller must fall back
    // to the CLI path rather than run the orchestrator with unknown settings.
    writeFileSync(file, '{ broken', 'utf8')
    const failed = prepareOrchestratorSettingsForAcp({ cfg, activeModel: 'gemini-pro-orchestrator-neon', account: undefined })
    assert.equal(failed.ok, false)
    assert.equal(readFileSync(file, 'utf8'), '{ broken')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveConfig loads orchestrator config fields from overrides and DSH_AGY_ORCHESTRATOR_* env vars', () => {
  const cfg = resolveConfig(
    {},
    {
      DSH_AGY_ORCHESTRATOR_PLANNER_MODEL: 'gemini-4-neon',
      DSH_AGY_ORCHESTRATOR_PLANNER_EFFORT: 'xhigh',
      DSH_AGY_ORCHESTRATOR_EXECUTOR_MODEL: 'claude-sonnet-5-5',
      DSH_AGY_ORCHESTRATOR_EXECUTOR_EFFORT: 'medium',
    },
    {},
  )
  assert.equal(cfg.orchestratorPlannerModel, 'gemini-4-neon')
  assert.equal(cfg.orchestratorPlannerEffort, 'xhigh')
  assert.equal(cfg.orchestratorExecutorModel, 'claude-sonnet-5-5')
  assert.equal(cfg.orchestratorExecutorEffort, 'medium')

  const fromOverrides = resolveConfig(
    {},
    {},
    {
      orchestratorPlannerModel: 'gemini-4-hydrogen',
      orchestratorPlannerEffort: 'high',
    },
  )
  assert.equal(fromOverrides.orchestratorPlannerModel, 'gemini-4-hydrogen')
  assert.equal(fromOverrides.orchestratorPlannerEffort, 'high')
  assert.equal(fromOverrides.orchestratorExecutorModel, '')
})

test('buildSpawnArgs injects --settings {orchestrator} only on Orchestrator models', () => {
  const cfg: PluginConfig = {
    ...defaultConfig(),
    orchestratorPlannerModel: 'gemini-4-neon',
    orchestratorPlannerEffort: 'xhigh',
    orchestratorExecutorModel: 'gemini-4-hydrogen',
    orchestratorExecutorEffort: 'high',
    agySettings: '{"keepMe":true}',
  }
  const baseInput: AttemptInput = {
    cfg,
    bin: 'agy',
    permissionMode: 'auto',
    sessionKey: 's1',
    workspaceRoot: '/tmp',
    isAux: false,
    account: undefined,
    prompt: 'hello',
    model: 'gemini-pro-orchestrator-neon',
    activeModel: 'gemini-pro-orchestrator-neon',
    effort: undefined,
    addDirs: [],
    persistBinding: false,
    binding: undefined,
    messages: [],
    newlySentImageIds: [],
    sessionAccountKey: 's1',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
  }

  const orchArgs = buildSpawnArgs(baseInput, 10, undefined).args
  const settingsIdx = orchArgs.indexOf('--settings')
  assert.notEqual(settingsIdx, -1)
  assert.deepEqual(JSON.parse(orchArgs[settingsIdx + 1]!), {
    keepMe: true,
    orchestrator: {
      planner: 'gemini-4-neon-xhigh',
      executor: 'gemini-4-hydrogen-high',
    },
  })

  // Regular worker model leaves orchestrator out of --settings
  const regularArgs = buildSpawnArgs({
    ...baseInput,
    model: 'gemini-4-neon',
    activeModel: 'gemini-4-neon',
  }, 10, undefined).args
  const regularIdx = regularArgs.indexOf('--settings')
  assert.equal(regularArgs[regularIdx + 1], '{"keepMe":true}')
  assert.equal(resolveEffectiveAgySettings({ ...baseInput, activeModel: 'claude-opus-5-5', agySettings: undefined, cfg: defaultConfig() }), undefined)
})

test('orchestrator overrides stay on ACP by writing settings.json, instead of forcing CLI --settings (issue #204)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-orch-attempt-'))
  const prevHome = process.env.HOME
  process.env.HOME = dir
  try {
    const argvLog = join(dir, 'argv.json')
    const fakeBin = join(dir, 'agy.cjs')
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)), 'utf8');
console.log(JSON.stringify({ event: 'response', content: 'ok' }));
console.log(JSON.stringify({ event: 'complete', stats: { total_tokens: 5 } }));
`,
      'utf8',
    )
    chmodSync(fakeBin, 0o755)

    const runs = new RunRegistry()
    const store = new SessionStore(join(dir, 'sessions.json'))
    let acpCalls = 0
    const cfg: PluginConfig = {
      ...defaultConfig(),
      transport: 'acp',
      orchestratorPlannerModel: 'gemini-4-neon',
      orchestratorPlannerEffort: 'xhigh',
      orchestratorExecutorModel: 'gemini-4-hydrogen',
      orchestratorExecutorEffort: 'medium',
    }
    const deps: AttemptDeps = {
      acquire: async () => () => undefined,
      runs,
      store,
      clearInFlightPrompt: () => undefined,
      registerActiveRun: () => undefined,
      unregisterActiveRun: () => undefined,
      isSuperseded: () => false,
      noteNetworkFailure: () => 0,
      clearNetworkStreak: () => undefined,
      dropFailoverBudget: () => undefined,
      clearRateLimitFailover: () => undefined,
      sharesSingleEgress: () => false,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
      runAcp: async () => {
        acpCalls++
        const rec = runs.create()
        rec.settle(null)
        return rec
      },
    }
    const baseInput: AttemptInput = {
      cfg,
      bin: fakeBin,
      permissionMode: 'auto',
      sessionKey: 's1',
      workspaceRoot: dir,
      isAux: false,
      account: undefined,
      prompt: 'hi',
      model: 'gemini-4-neon',
      activeModel: 'gemini-4-neon',
      effort: 'high',
      addDirs: [],
      persistBinding: false,
      binding: undefined,
      messages: [],
      newlySentImageIds: [],
      sessionAccountKey: 's1',
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    }

    async function runAndDrain(input: AttemptInput) {
      const gen = runAgyAttempt(deps, input)
      while (true) {
        const step = await gen.next()
        if (step.done) {
          for await (const _ of step.value.eventsFrom(0)) { /* drain */ }
          break
        }
      }
    }

    // 1. Non-orchestrator model still uses ACP
    await runAndDrain(baseInput)
    assert.equal(acpCalls, 1)

    // 2. Orchestrator model WITH no planner/executor overrides also keeps ACP
    await runAndDrain({
      ...baseInput,
      cfg: { ...defaultConfig(), transport: 'acp' },
      model: 'gemini-pro-orchestrator-neon',
      activeModel: 'gemini-pro-orchestrator-neon',
    })
    assert.equal(acpCalls, 2)

    // 3. Orchestrator model WITH custom planner/executor now keeps ACP: the
    // payload is written to <home>/.gemini/antigravity-cli/settings.json by
    // runAcpAttempt, so the batch CLI is never spawned for this case.
    await runAndDrain({
      ...baseInput,
      model: 'gemini-pro-orchestrator-neon',
      activeModel: 'gemini-pro-orchestrator-neon',
      effort: undefined,
    })
    assert.equal(acpCalls, 3, 'customized orchestrator must stay on the resident ACP path')
    assert.equal(existsSync(argvLog), false, 'no CLI fallback was spawned for orchestrator overrides')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  }
})

test('runAgyOnce passes --settings {orchestrator} only on Orchestrator models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-orch-oneshot-'))
  try {
    const argvLog = join(dir, 'oneshot-argv.json')
    const fakeBin = join(dir, 'agy.cjs')
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)), 'utf8');
console.log(JSON.stringify({ type: 'result', status: 'SUCCESS', response: 'done' }));
`,
      'utf8',
    )
    chmodSync(fakeBin, 0o755)
    const cfg: PluginConfig = {
      ...defaultConfig(),
      orchestratorPlannerModel: 'claude-opus-5-5',
      orchestratorPlannerEffort: 'high',
      orchestratorExecutorModel: 'gemini-3.8-flash',
      orchestratorExecutorEffort: 'medium',
    }

    const r1 = await runAgyOnce(
      { cfg: () => cfg, bin: () => fakeBin },
      { prompt: 'plan task', model: 'gemini-pro-orchestrator-argon', cwd: dir },
    )
    assert.equal(r1.ok, true)
    const args1 = JSON.parse(readFileSync(argvLog, 'utf8')) as string[]
    assert.deepEqual(JSON.parse(args1[args1.indexOf('--settings') + 1]!), {
      orchestrator: {
        planner: 'claude-opus-5-5-high',
        executor: 'gemini-3.8-flash-medium',
      },
    })

    const r2 = await runAgyOnce(
      { cfg: () => cfg, bin: () => fakeBin },
      { prompt: 'normal task', model: 'gemini-3.8-flash', cwd: dir },
    )
    assert.equal(r2.ok, true)
    const args2 = JSON.parse(readFileSync(argvLog, 'utf8')) as string[]
    assert.equal(args2.includes('--settings'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('HTTP /config validation, /status exposure, and /agy status output cover orchestrator settings', async () => {
  const cfg: PluginConfig = {
    ...defaultConfig(),
    orchestratorPlannerModel: 'gemini-4-neon',
    orchestratorPlannerEffort: 'xhigh',
  }
  const writes: Array<[string, unknown]> = []
  const routes = new Map<string, Route['handler']>()
  const webServer = {
    register(r: Route) {
      routes.set(r.path, r.handler)
    },
  }
  const services = {
    getConfig: () => cfg,
    log: () => undefined,
    notifyPicker: () => undefined,
    bin: () => null,
    version: () => null,
    status: { version: '1.0.0', dormantReason: null },
    store: { all: () => ({}), clear: () => undefined },
    pool: { getPoolData: () => ({ accounts: [], resolvedActiveAccountIds: {} }), getAccounts: () => [], getAccount: () => undefined, setAccountEnabled: () => false },
    quota: {},
    warmup: {},
    catalog: { get: () => ({ source: 'fallback', models: [], lastError: null }), getAllKnownModels: () => [] },
    auth: { status: () => ({ phase: 'idle' }) },
    poolAuth: { status: () => ({ phase: 'idle' }) },
    adapter: { effortUnsupportedModels: () => [] },
    acpPool: { status: () => ({ activeProcesses: 0, sessions: 0, keys: [] }) },
    ecosystem: {},
    translation: { pendingFor: () => [], stats: () => ({}), isPending: () => false, existingTurn: () => null, existingMessage: () => null },
    setOverride: (k: string, v: unknown) => {
      writes.push([k, v])
      ;(cfg as unknown as Record<string, unknown>)[k] = v
    },
    readEffortUnsupported: () => [],
    rememberEffortUnsupported: () => undefined,
    sessionsSvc: () => undefined,
    sessionAuto: new Map(),
    lastRun: null,
    lastParser: { recentLines: [] },
    mediaDir: () => '/tmp',
    bridgeState: { bridge: null, restores: [] },
    webServerPort: {},
    hostDir: '',
    onConfigWritten: () => undefined,
  } as unknown as HostServices

  registerRoutes(webServer, services)

  async function invoke(path: string, method: string, body?: unknown) {
    let status = 0
    let text = ''
    let done!: () => void
    const p = new Promise<void>((r) => { done = r })
    const res = {
      writeHead(s: number) { status = s },
      end(b?: unknown) { text = typeof b === 'string' ? b : ''; done() },
    }
    const req = {
      method,
      url: '/',
      on(ev: string, cb: (chunk?: Buffer) => void) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body), 'utf8'))
        if (ev === 'end') cb()
      },
    }
    routes.get(path)!(req, res)
    await p
    return { status, json: () => JSON.parse(text) as Record<string, unknown> }
  }

  // Valid update
  const okRes = await invoke('/plugins/agy-link/config', 'POST', { key: 'orchestratorExecutorModel', value: 'gemini-4-hydrogen' })
  assert.equal(okRes.status, 200)
  const okEffort = await invoke('/plugins/agy-link/config', 'POST', { key: 'orchestratorExecutorEffort', value: 'high' })
  assert.equal(okEffort.status, 200)
  assert.deepEqual(writes, [
    ['orchestratorExecutorModel', 'gemini-4-hydrogen'],
    ['orchestratorExecutorEffort', 'high'],
  ])

  // Invalid effort rejected
  const badEffort = await invoke('/plugins/agy-link/config', 'POST', { key: 'orchestratorPlannerEffort', value: 'turbo' })
  assert.equal(badEffort.status, 400)

  // /status exposes all 4 keys
  const statusRes = await invoke('/plugins/agy-link/status', 'GET')
  assert.equal(statusRes.status, 200)
  const sj = statusRes.json()
  assert.equal(sj.orchestratorPlannerModel, 'gemini-4-neon')
  assert.equal(sj.orchestratorPlannerEffort, 'xhigh')
  assert.equal(sj.orchestratorExecutorModel, 'gemini-4-hydrogen')
  assert.equal(sj.orchestratorExecutorEffort, 'high')

  // /agy status includes orchestrator summary line
  const md = await renderStatus({
    cfg: () => cfg,
    bin: () => null,
    version: () => '1.5.15',
    auth: () => null,
    catalog: () => ({ get: () => ({ models: [], source: 'fallback' }) }) as never,
    store: () => ({ all: () => ({}) }) as never,
    lastRun: () => null,
    setOverride: () => undefined,
    runDoctor: async () => '',
  })
  assert.match(md, /- orchestrator: planner=gemini-4-neon-xhigh, executor=gemini-4-hydrogen-high/)
})

test('client orchestratorRoleModels, orchestratorEffortOptions, and OrchestratorSettingsRows UI work across locales', () => {
  const catalog = [
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: [] },
  ]
  assert.deepEqual(orchestratorRoleModels(catalog).map((m) => m.id), ['gemini-4-neon', 'gpt-oss-120b-medium'])
  assert.deepEqual(orchestratorEffortOptions('', EFFORT_LABELS, '', catalog), [{ value: '', label: 'Auto' }])
  assert.deepEqual(orchestratorEffortOptions('', EFFORT_LABELS, 'gpt-oss-120b-medium', catalog), [{ value: '', label: 'Auto' }])
  assert.deepEqual(
    orchestratorEffortOptions('xhigh', EFFORT_LABELS, 'gemini-4-neon', catalog).map((o) => o.value),
    ['', 'low', 'medium', 'high', 'xhigh'],
  )

  for (const dict of [zh, en]) {
    const t = (key: string) => (dict as Record<string, string>)[key] ?? key
    const rows = renderOrchestratorRows(
      t as never,
      {
        orchestratorPlannerModel: 'gemini-4-neon',
        orchestratorPlannerEffort: 'xhigh',
        orchestratorExecutorModel: '',
        orchestratorExecutorEffort: '',
      },
      catalog,
      null,
      async () => undefined,
      EFFORT_LABELS,
    )
    const html = renderToStaticMarkup(createElement('div', null, ...rows))
    assert.ok(html.includes(dict['config.orchestratorPlanner']))
    assert.ok(html.includes(dict['config.orchestratorExecutor']))
    assert.equal(html.includes('gemini-pro-orchestrator-neon'), false, 'orchestrator slug must not offer itself as planner/executor')
    assert.ok(html.includes('gemini-4-neon'))
  }
})

test('issue #207: prepareOrchestratorSettingsForAcp clears removed seats on disk while keeping unrelated settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-orch-clear-'))
  const prevHome = process.env.HOME
  process.env.HOME = dir
  try {
    const file = agySettingsFilePath(dir)
    syncOrchestratorSettingsFileAt(file, { planner: 'gemini-4-neon-high', executor: 'gemini-4-hydrogen-high' })
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    doc.theme = 'light'
    ;(doc.orchestrator as Record<string, unknown>).customFlag = true
    writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8')

    // Clear only executor seat
    const cfgOne: PluginConfig = { ...defaultConfig(), orchestratorPlannerModel: 'gemini-4-neon', orchestratorPlannerEffort: 'high' }
    const one = prepareOrchestratorSettingsForAcp({ cfg: cfgOne, activeModel: 'gemini-pro-orchestrator-neon', account: undefined })
    assert.equal(one.ok, true)
    assert.equal(one.ok ? one.settingsTag : undefined, JSON.stringify({ planner: 'gemini-4-neon-high' }))
    const afterOne = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(afterOne.theme, 'light')
    assert.deepEqual(afterOne.orchestrator, { planner: 'gemini-4-neon-high', customFlag: true })

    // Clear remaining planner seat -> customFlag stays, planner removed; if no custom keys left, orchestrator key deleted
    delete (afterOne.orchestrator as Record<string, unknown>).customFlag
    writeFileSync(file, JSON.stringify(afterOne, null, 2), 'utf8')
    const cfgNone = defaultConfig()
    const none = prepareOrchestratorSettingsForAcp({ cfg: cfgNone, activeModel: 'gemini-pro-orchestrator-neon', account: undefined })
    assert.equal(none.ok, true)
    assert.equal(none.ok ? none.settingsTag : 'err', undefined)
    const afterNone = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.deepEqual(afterNone, { theme: 'light' })
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(dir, { recursive: true, force: true })
  }
})
