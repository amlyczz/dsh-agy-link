// Branch-coverage additions for low-branch host/domain units.
//
// Everything here uses fakes/stubs: no agy spawn, no external network. Platform
// branches (win32/darwin) are simulated by temporarily redefining
// `process.platform` and restored in a finally block.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { SessionStore, SENT_IMAGE_IDS_MAX } from '../src/host/sessions.ts'
import { mergeSentImageIds } from '../src/provider/finalize.ts'
import { runBootHygiene } from '../src/host/boot-hygiene.ts'
import type { HostServices } from '../src/host/services.ts'
import { selectSessionAccount } from '../src/provider/account-selection.ts'
import type { AccountPoolManager } from '../src/host/pool.ts'
import { agyFetch } from '../src/host/net.ts'
import { defineAgyAskTool, resolveAskModel } from '../src/host/ask-tool.ts'
import { resolveTranslateTarget } from '../src/features/translation/target.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'
import type { ManagedAccount } from '../src/common/pool-types.ts'
import type { Catalog } from '../src/host/models.ts'
import {
  getStoredToken,
  getValidAccessToken,
  isCurrentAccountGrant,
  persistRefreshedToken,
  quotaTokenFilePath,
  readLinuxSecretToken,
  readMacKeychainToken,
  readSystemKeychainToken,
  readWindowsCredentialToken,
  type QuotaTokenDeps,
} from '../src/features/quota/token.ts'
import { extractStepThoughts, extractToolInfo } from '../src/runtime/agy/db/extract.ts'
import { fetchQuotaSummary, fetchUserQuota, type QuotaHttpDeps } from '../src/features/quota/http.ts'
import { AGY_ENDPOINTS } from '../src/host/oauth.ts'
import { handleGoal, handleSession, handleClear } from '../src/host/commands/session.ts'
import type { CommandDeps, CommandContext } from '../src/host/commands/shared.ts'
import { ensureIsolatedKeychain, purgeStaleIsolatedKeychain } from '../src/runtime/agy/keychain.ts'

// ---- small helpers --------------------------------------------------------

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: original, configurable: true })
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function account(id: string, over: Partial<ManagedAccount> = {}): ManagedAccount {
  return { id, alias: id, dir: '', enabled: true, createdAt: 0, cooldowns: {}, quotas: {}, ...over }
}

// ===== 1. SessionStore =====================================================

test('SessionStore: clear() empties every binding and persists the empty store', () => {
  const dir = tempDir('hb-sessions-clear-')
  try {
    const file = join(dir, 'sessions.json')
    const store = new SessionStore(file)
    store.set('a', { conversationId: 'ca', lastMessageCount: 1, updatedAt: 1 })
    store.set('b', { conversationId: 'cb', lastMessageCount: 2, updatedAt: 2 })
    store.clear()
    assert.deepEqual(Object.keys(store.all()), [])
    assert.equal(store.get('a'), undefined)
    assert.deepEqual(Object.keys(new SessionStore(file).all()), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionStore: get/delete of an unknown key are safe', () => {
  const dir = tempDir('hb-sessions-unknown-')
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    assert.equal(store.get('nope'), undefined)
    store.delete('nope') // removed set; merge writes an empty object
    assert.deepEqual(Object.keys(store.all()), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionStore: sentImageIds and interrupted survive a reload', () => {
  const dir = tempDir('hb-sessions-fields-')
  try {
    const file = join(dir, 'sessions.json')
    const store = new SessionStore(file)
    store.set('s', {
      conversationId: 'c',
      lastMessageCount: 3,
      updatedAt: 9,
      sentImageIds: ['img-1', 'img-2'],
      interrupted: true,
      lastInputTokens: 42,
    })
    const reloaded = new SessionStore(file)
    assert.deepEqual(reloaded.get('s')?.sentImageIds, ['img-1', 'img-2'])
    assert.equal(reloaded.get('s')?.interrupted, true)
    assert.equal(reloaded.get('s')?.lastInputTokens, 42)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionStore: cleanupStaleAccounts leaves non-account keys and unknown shapes alone', () => {
  const dir = tempDir('hb-sessions-cleanup-')
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    store.set('no-colon-key', { conversationId: 'c1', lastMessageCount: 0, updatedAt: 1 })
    store.set('sess:notanacc', { conversationId: 'c2', lastMessageCount: 0, updatedAt: 2 })
    // No matching account ids: the "changed" flag stays false (no persist branch).
    store.cleanupStaleAccounts(new Set(['acc_live']))
    assert.ok(store.get('no-colon-key'))
    assert.ok(store.get('sess:notanacc'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeSentImageIds: dedupes, skips junk, caps to the newest ids', () => {
  assert.deepEqual(mergeSentImageIds(undefined, ['a', 'b', 'b', '', 'c']), ['a', 'b', 'c'])
  const many = Array.from({ length: SENT_IMAGE_IDS_MAX + 5 }, (_, i) => 'id-' + i)
  const capped = mergeSentImageIds(undefined, many)
  assert.equal(capped.length, SENT_IMAGE_IDS_MAX)
  assert.equal(capped[0], 'id-5')
  // custom cap keeps the tail
  assert.deepEqual(mergeSentImageIds(['1', '2', '3'], ['4'], 2), ['3', '4'])
})

// ===== 2. boot-hygiene =====================================================

function hygieneServices(over: {
  accounts?: ManagedAccount[]
  swept?: number
  logsSwept?: number
  cleanupThrows?: boolean
  logs: string[]
  retention?: number
}): HostServices {
  const accounts = over.accounts ?? []
  const store = {
    cleanupStaleAccounts: (ids: Set<string>) => {
      if (over.cleanupThrows) throw new Error('cleanup boom')
      void ids
    },
  }
  const pool = {
    dir: '/tmp/pool',
    getAccounts: () => accounts,
    sweepStaleStaging: () => over.swept ?? 0,
    sweepOldLogs: () => over.logsSwept ?? 0,
    markAuthRequired: () => {},
  }
  return {
    pool,
    store,
    log: (m: string) => over.logs.push(m),
    getConfig: () => ({ ...defaultConfig(), logRetentionDays: over.retention ?? 7 }),
  } as unknown as HostServices
}

test('boot-hygiene: sweeps staging dirs and old logs (non-darwin/win32 path, no spawn)', () => {
  const restore = setPlatform('linux')
  const logs: string[] = []
  try {
    const services = hygieneServices({
      accounts: [account('acc_a', { dir: '' }), account('acc_b', { dir: '/tmp/acc_b' })],
      swept: 2,
      logsSwept: 3,
      logs,
    })
    runBootHygiene(services)
    assert.ok(logs.includes('swept 2 stale staging dir(s)'))
    assert.ok(logs.includes('swept 3 old log file(s)'))
  } finally {
    restore()
  }
})

test('boot-hygiene: zero sweeps emit no log, and a throwing cleanup is swallowed', () => {
  const restore = setPlatform('linux')
  const logs: string[] = []
  try {
    runBootHygiene(hygieneServices({ swept: 0, logsSwept: 0, cleanupThrows: true, logs }))
    assert.deepEqual(logs, [])
  } finally {
    restore()
  }
})

// ===== 3. account-selection ================================================

type SelPoolOpts = {
  accounts?: ManagedAccount[]
  eligible?: (a: ManagedAccount, f: string) => boolean
  select?: (f: string) => ManagedAccount | null
  explain?: (a: ManagedAccount, f: string) => 'disabled' | 'auth' | 'cooldown' | 'quota' | 'unsupported' | null
  lastActive?: string
  countdown?: number | null
  resetCountdown?: number | null
  withExplain?: boolean
  withAvailable?: boolean
}

function selPool(opts: SelPoolOpts) {
  const accounts = opts.accounts ?? []
  const calls = { setActive: [] as Array<[string, string]>, select: [] as string[] }
  const pool: Record<string, unknown> = {
    getAccounts: () => accounts,
    getAccount: (id: string) => accounts.find((a) => a.id === id),
    isAccountEligible: (a: ManagedAccount, f: string) => (opts.eligible ? opts.eligible(a, f) : true),
    selectAccount: (f: string) => {
      calls.select.push(f)
      return opts.select ? opts.select(f) : null
    },
    setActiveAccount: (id: string, f: string) => calls.setActive.push([id, f]),
    getPoolData: () => ({ lastActiveAccountId: opts.lastActive }),
    getEarliestResetCountdown: () => opts.resetCountdown ?? null,
  }
  if (opts.withExplain !== false) {
    pool.explainIneligibility = (a: ManagedAccount, f: string) => (opts.explain ? opts.explain(a, f) : null)
  }
  if (opts.withAvailable !== false) {
    pool.getEarliestAvailableCountdown = () => (opts.countdown === undefined ? null : opts.countdown)
  }
  return { pool: pool as unknown as AccountPoolManager, calls }
}

function selectionDeps(pool: AccountPoolManager | undefined, bindings: Record<string, unknown> = {}) {
  const deleted: string[] = []
  const synced: Array<[string, string, string | undefined]> = []
  return {
    deps: {
      pool,
      store: {
        all: () => bindings,
        delete: (k: string) => { deleted.push(k) },
      } as never,
      syncSessionModel: (s: string, m: string, e?: string) => synced.push([s, m, e]),
    },
    deleted,
    synced,
  }
}

const cfgSelect = (over: Partial<PluginConfig> = {}): PluginConfig => ({ ...defaultConfig(), parallelSameAccount: false, autoFallbackModel: false, ...over })

test('account-selection: no pool returns an undefined account but a resolved family/model', async () => {
  const { deps } = selectionDeps(undefined)
  const out = await selectSessionAccount({ deps, cfg: cfgSelect(), model: 'gemini-3.8-flash', isAux: false, sessionKey: 's' })
  assert.equal(out.account, undefined)
  assert.equal(out.family, 'google')
  assert.equal(out.activeModel, 'gemini-3.8-flash')
})

test('account-selection: sticky affinity reuses the session account and pins it active', async () => {
  const a = account('acc_x')
  const { pool, calls } = selPool({ accounts: [a], select: () => null, lastActive: undefined })
  const { deps } = selectionDeps(pool, { 's1:acc_x': { conversationId: 'c', lastMessageCount: 0, updatedAt: 5 } })
  const out = await selectSessionAccount({ deps, cfg: cfgSelect(), model: 'gemini-3.8-flash', isAux: false, sessionKey: 's1' })
  assert.equal(out.account?.id, 'acc_x')
  assert.deepEqual(calls.setActive, [['acc_x', 'google']])
  assert.deepEqual(calls.select, []) // sticky hit short-circuits selectAccount
})

test('account-selection: a stale binding to a deleted account is dropped', async () => {
  const live = account('acc_live')
  const { pool } = selPool({ accounts: [live], select: () => live })
  const { deps, deleted } = selectionDeps(pool, { 's1:acc_gone': { conversationId: 'c', lastMessageCount: 0, updatedAt: 5 } })
  const out = await selectSessionAccount({ deps, cfg: cfgSelect(), model: 'gemini-3.8-flash', isAux: false, sessionKey: 's1' })
  assert.ok(deleted.includes('s1:acc_gone'))
  assert.equal(out.account?.id, 'acc_live')
})

test('account-selection: ineligible sticky account falls through to selectAccount', async () => {
  const a = account('acc_x')
  const { pool } = selPool({ accounts: [a], eligible: () => false, select: () => a })
  const { deps } = selectionDeps(pool, { 's1:acc_x': { conversationId: 'c', lastMessageCount: 0, updatedAt: 5 } })
  const out = await selectSessionAccount({ deps, cfg: cfgSelect(), model: 'gemini-3.8-flash', isAux: false, sessionKey: 's1' })
  assert.equal(out.account?.id, 'acc_x')
})

test('account-selection: win32 + parallelSameAccount pins the pool candidate directly', async () => {
  const a = account('acc_w')
  const { pool } = selPool({ accounts: [a], select: () => a })
  const { deps } = selectionDeps(pool)
  const restore = setPlatform('win32')
  try {
    const out = await selectSessionAccount({
      deps,
      cfg: cfgSelect({ parallelSameAccount: true }),
      model: 'gemini-3.8-flash',
      isAux: false,
      sessionKey: 's1',
    })
    assert.equal(out.account?.id, 'acc_w')
  } finally {
    restore()
  }
})

test('account-selection: model=="" syncs the default model into the session', async () => {
  const a = account('acc_s')
  const { pool } = selPool({ accounts: [a], select: () => a })
  const { deps, synced } = selectionDeps(pool)
  await selectSessionAccount({ deps, cfg: cfgSelect({ defaultModel: 'gemini-3.8-flash' }), model: '', isAux: false, sessionKey: 's1' })
  assert.deepEqual(synced[0], ['s1', 'gemini-3.8-flash', undefined])
})

test('account-selection: cross-family fallback picks anthropic when google is exhausted', async () => {
  const fb = account('acc_claude')
  const { pool } = selPool({
    accounts: [fb],
    select: (f) => (f === 'anthropic' ? fb : null),
  })
  const { deps, synced } = selectionDeps(pool)
  const out = await selectSessionAccount({
    deps,
    cfg: cfgSelect({ autoFallbackModel: true }),
    model: 'gemini-3.8-flash',
    isAux: false,
    sessionKey: 's1',
  })
  assert.equal(out.account?.id, 'acc_claude')
  assert.equal(out.family, 'anthropic')
  assert.equal(out.activeModel, 'claude-sonnet-5-5')
  assert.deepEqual(synced.at(-1), ['s1', 'claude-sonnet-5-5', undefined])
})

test('account-selection: a short reset is waited out, then the account is re-picked', async () => {
  const a = account('acc_late')
  let n = 0
  const { pool } = selPool({
    accounts: [a],
    countdown: 1,
    select: () => {
      n += 1
      return n === 1 ? null : a // first pick misses, the post-wait re-pick hits
    },
  })
  const { deps } = selectionDeps(pool)
  const out = await selectSessionAccount({ deps, cfg: cfgSelect(), model: 'gemini-3.8-flash', isAux: false, sessionKey: 's1' })
  assert.equal(out.account?.id, 'acc_late')
})

async function expectUnavailable(pool: AccountPoolManager, cfg: PluginConfig = cfgSelect()): Promise<{ message: string; code: unknown }> {
  const { deps } = selectionDeps(pool)
  try {
    await selectSessionAccount({ deps, cfg, model: 'gemini-3.8-flash', isAux: false, sessionKey: 's1' })
  } catch (e) {
    const err = e as { message: string; code: unknown }
    return { message: err.message, code: err.code }
  }
  assert.fail('expected selectSessionAccount to throw')
}

test('account-selection: error reasons — all disabled', async () => {
  const { pool } = selPool({ accounts: [account('acc_a', { enabled: false })], select: () => null })
  const { message } = await expectUnavailable(pool)
  assert.match(message, /all accounts are disabled/)
})

test('account-selection: error reasons — every enabled account needs re-login', async () => {
  const { pool } = selPool({
    accounts: [account('acc_a', { authRequired: true }), account('acc_b', { authRequired: true })],
    select: () => null,
  })
  const { message } = await expectUnavailable(pool)
  assert.match(message, /every account needs a re-login/)
})

test('account-selection: error reasons — all detail counters + wait string', async () => {
  const reasons: Record<string, 'cooldown' | 'quota' | 'unsupported'> = {
    acc_cd: 'cooldown',
    acc_q: 'quota',
    acc_u: 'unsupported',
  }
  const { pool } = selPool({
    accounts: [
      account('acc_cd'),
      account('acc_q'),
      account('acc_u'),
      account('acc_out', { authRequired: true }),
      account('acc_off', { enabled: false }),
    ],
    select: () => null,
    countdown: 25_000,
    explain: (a) => reasons[a.id] ?? null,
  })
  const { message, code } = await expectUnavailable(pool)
  assert.equal(code, 'AGY_ERROR')
  assert.match(message, /1 in cooldown/)
  assert.match(message, /1 quota-exhausted/)
  assert.match(message, /1 lack google access/)
  assert.match(message, /1 signed out/)
  assert.match(message, /1 disabled/)
  assert.match(message, /earliest reset in 25s/)
})

test('account-selection: error reasons — unsupported-only hint', async () => {
  const { pool } = selPool({
    accounts: [account('acc_u')],
    select: () => null,
    explain: () => 'unsupported',
  })
  const { message } = await expectUnavailable(pool)
  assert.match(message, /No enabled account has access to google/)
})

test('account-selection: error reasons — quota-only hint', async () => {
  const { pool } = selPool({
    accounts: [account('acc_q')],
    select: () => null,
    explain: () => 'quota',
  })
  const { message } = await expectUnavailable(pool)
  assert.match(message, /wait for the quota reset/)
})

test('account-selection: error reasons — explainIneligibility fallback and long reset', async () => {
  // No explainIneligibility: unavailableError falls back to isAccountEligible.
  const { pool } = selPool({
    accounts: [account('acc_x')],
    select: () => null,
    eligible: () => false,
    withExplain: false,
    countdown: 30_000, // > 20s: waitForShortReset bails immediately
    withAvailable: false, // forces the getEarliestResetCountdown fallback
    resetCountdown: null,
  })
  const { message } = await expectUnavailable(pool)
  assert.match(message, /1 in cooldown/)
  assert.doesNotMatch(message, /earliest reset/)
})

// ===== 4. net.ts ===========================================================

test('agyFetch: direct branch (no proxy) surfaces URL errors without a real request', async () => {
  const restorePlatform = setPlatform('aix') // skip scutil/registry/gsettings probes
  const saved = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].map((k) => [k, process.env[k]] as const)
  for (const [k] of saved) delete process.env[k]
  try {
    await assert.rejects(() => agyFetch('not a valid url'), TypeError)
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    restorePlatform()
  }
})

test('agyFetch: explicit proxy branch caches one agent per proxy URL', async () => {
  const signal = AbortSignal.abort()
  const init = { signal }
  // Two aborted calls: the second hits the per-proxy cache instead of building a new agent.
  await assert.rejects(() => agyFetch('http://127.0.0.1:9/x', init, 'http://127.0.0.1:3128'))
  await assert.rejects(() => agyFetch('http://127.0.0.1:9/x', init, 'http://127.0.0.1:3128'))
})

test('agyFetch: an invalid proxy URL throws synchronously', () => {
  assert.throws(() => agyFetch('http://127.0.0.1:9/x', {}, 'not a url'), /Invalid URL/)
})

// ===== 5. ask-tool =========================================================

const askCatalog: Catalog = {
  source: 'fallback',
  discoveredAt: 0,
  models: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: null },
  ],
}

test('resolveAskModel: empty, exact id, alias, level, unknown and fallback branches', () => {
  assert.equal(resolveAskModel('', askCatalog, 'def-model'), 'def-model')
  assert.equal(resolveAskModel('claude-sonnet-5-5', askCatalog, 'def'), 'claude-sonnet-5-5')
  assert.equal(resolveAskModel('flash', askCatalog, 'def'), 'gemini-3.8-flash')
  assert.equal(resolveAskModel('claude', askCatalog, 'def'), 'claude-sonnet-5-5')
  assert.equal(resolveAskModel('gemini low', askCatalog, 'def'), 'gemini-3.8-flash')
  assert.equal(resolveAskModel('gemini-high', askCatalog, 'def'), 'gemini-3.8-flash')
  // No candidate: falls back to the default model, or the raw query when default is empty.
  assert.equal(resolveAskModel('mystery', askCatalog, 'def'), 'def')
  assert.equal(resolveAskModel('mystery', askCatalog, ''), 'mystery')
  // Alias + level: no exact '-high' variant, so the newest matching id wins.
  assert.equal(resolveAskModel('claude high', askCatalog, 'def'), 'claude-sonnet-5-5')
})

function askTool(deps: Record<string, unknown>) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan' }
  return defineAgyAskTool({
    cfg: () => cfg,
    bin: () => null, // no agy binary → runAgyOnce returns "not found" without spawning
    catalog: () => askCatalog,
    ...deps,
  } as never) as unknown as {
    name: string
    description: string
    output: { render: (a: unknown, v: string) => Array<{ type: string; text: string }> }
    execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<string>
  }
}

test('agy_ask definition: name, output render, and a missing-binary error path', async () => {
  const tool = askTool({})
  assert.equal(tool.name, 'agy_ask')
  assert.deepEqual(tool.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
  await assert.rejects(
    () => tool.execute({ prompt: 'x' }, { signal: new AbortController().signal }),
    /agy binary not found/,
  )
})

test('agy_ask: invalid schema JSON throws before any run', async () => {
  const tool = askTool({})
  await assert.rejects(
    () => tool.execute({ prompt: 'x', schema: '{not json' }, { signal: new AbortController().signal }),
    /schema is not valid JSON/,
  )
})

test('agy_ask: explicit effort, readPaths and learned-refusal branches reach the missing-binary error', async () => {
  const tool = askTool({ effortUnsupported: () => ['gemini-3.8-flash'] })
  await assert.rejects(
    () => tool.execute(
      { prompt: 'x', model: 'flash', effort: 'low', readPaths: 'a.txt, b.txt', timeoutMinutes: 2 },
      { signal: new AbortController().signal },
    ),
    /agy binary not found/,
  )
  // No explicit effort → defaultEffortFor path, also ends in the missing-binary error.
  const tool2 = askTool({})
  await assert.rejects(
    () => tool2.execute({ prompt: 'x', model: 'flash' }, { signal: new AbortController().signal }),
    /agy binary not found/,
  )
})

// ===== 6a. translation/target =============================================

const tCatalog: Catalog = {
  source: 'fallback',
  discoveredAt: 0,
  models: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: null },
  ],
}
const tCfg = (over: Partial<PluginConfig> = {}): PluginConfig => ({ ...defaultConfig(), ...over })

test('resolveTranslateTarget: explicit listed model + default effort', () => {
  const out = resolveTranslateTarget(tCfg({ translateEffort: 'low' }), tCatalog)
  assert.equal(out.model, 'gemini-3.8-flash')
  assert.equal(out.effort, 'low')
})

test('resolveTranslateTarget: explicit unlisted override resolves via slug', () => {
  const out = resolveTranslateTarget(tCfg(), tCatalog, { model: 'claude-sonnet', effort: 'high' })
  assert.equal(out.model, 'claude-sonnet-5-5')
  assert.equal(out.effort, '')
})

test('resolveTranslateTarget: default chain falls through to the newest flash', () => {
  const catalog: Catalog = {
    source: 'fallback',
    discoveredAt: 0,
    models: [
      { id: 'gemini-3.1-flash', name: 'a', efforts: null },
      { id: 'gemini-9.9-flash', name: 'b', efforts: null },
      { id: 'other-model', name: 'c', efforts: null },
    ],
  }
  const out = resolveTranslateTarget(tCfg({ translateModel: '', defaultModel: '' }), catalog)
  assert.equal(out.model, 'gemini-9.9-flash')
})

test('resolveTranslateTarget: defaultModel candidate when gemini-3.8 is absent', () => {
  const catalog: Catalog = {
    source: 'fallback',
    discoveredAt: 0,
    models: [{ id: 'custom-flash', name: 'c', efforts: null }],
  }
  const out = resolveTranslateTarget(tCfg({ translateModel: '', defaultModel: 'custom-flash' }), catalog)
  assert.equal(out.model, 'custom-flash')
})

test('resolveTranslateTarget: empty catalog yields an empty model', () => {
  const out = resolveTranslateTarget(tCfg({ translateModel: '', defaultModel: '' }), { source: 'fallback', discoveredAt: 0, models: [] })
  assert.deepEqual(out, { model: '', effort: '' })
})

test('resolveTranslateTarget: wanted effort not offered falls back to the default', () => {
  const out = resolveTranslateTarget(tCfg({ translateEffort: 'ultra' }), tCatalog)
  assert.equal(out.model, 'gemini-3.8-flash')
  assert.equal(out.effort, 'high')
})

test('resolveTranslateTarget: a fixed-effort model yields an empty effort', () => {
  const out = resolveTranslateTarget(tCfg({ translateModel: 'claude-sonnet-4-6' }), tCatalog)
  assert.equal(out.model, 'claude-sonnet-4-6')
  assert.equal(out.effort, '')
})

// ===== 6b. quota/token ====================================================

function tokenDeps(over: Partial<QuotaTokenDeps> = {}, poolDir = '/tmp/pool'): QuotaTokenDeps {
  return {
    pool: { dir: poolDir, clearAuthRequired: () => {}, markAuthRequired: () => {} },
    proxyFor: () => 'http://proxy.local',
    readSystemKeychainToken: async () => null,
    getStoredToken: async () => null,
    persistRefreshedToken: () => {},
    readPrimaryCredential: () => null,
    writePrimaryCredential: () => true,
    parseCredentialDoc: (raw) => (raw ? (JSON.parse(raw) as { accessToken?: string; refreshToken?: string }) : null),
    ...over,
  }
}

test('quotaTokenFilePath: isolated account uses its dir, system account uses HOME', () => {
  const isolated = account('acc_i', { dir: '/tmp/iso' })
  assert.ok(quotaTokenFilePath(isolated).startsWith('/tmp/iso/'))
  assert.match(quotaTokenFilePath(isolated), /\.gemini\/antigravity-cli\//)

  const home = tempDir('hb-token-home-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  try {
    const sys = account('acc_sys', { dir: '', systemHome: true })
    assert.ok(quotaTokenFilePath(sys).startsWith(home))
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('getStoredToken: disk token, corrupted file, and isolated-account short circuit', async () => {
  const dir = tempDir('hb-token-disk-')
  try {
    const acc = account('acc_i', { dir })
    const file = quotaTokenFilePath(acc)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expiry: Date.now() + 3_600_000 }))
    const deps = tokenDeps()
    const tok = await getStoredToken(deps, acc)
    assert.equal(tok?.accessToken, 'a1')
    assert.equal(tok?.refreshToken, 'r1')

    writeFileSync(file, '{broken json')
    assert.equal(await getStoredToken(deps, acc), null)

    rmSync(file, { force: true })
    rmSync(file + '.bak', { force: true })
    assert.equal(await getStoredToken(deps, acc), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getStoredToken: system account prefers the keychain, and allowKeychainFallback=false skips it', async () => {
  const home = tempDir('hb-token-sys-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  try {
    const sys = account('acc_sys', { dir: '', systemHome: true })
    let reads = 0
    const deps = tokenDeps({
      readSystemKeychainToken: async () => {
        reads += 1
        return { accessToken: 'kc', refreshToken: 'kcr' }
      },
    })
    assert.equal((await getStoredToken(deps, sys))?.accessToken, 'kc')
    reads = 0
    assert.equal(await getStoredToken(deps, sys, false), null)
    assert.equal(reads, 0, 'keychain must not be read when the fallback is disabled')
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('getStoredToken: win32 primary durable store wins; empty stored token falls through', async () => {
  const home = tempDir('hb-token-win-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  const restore = setPlatform('win32')
  try {
    const sys = account('acc_sys', { dir: '', systemHome: true })
    let keychainReads = 0
    const deps = tokenDeps({
      readPrimaryCredential: () => ({ raw: '{"access_token":"p1"}', savedAt: 1 }),
      parseCredentialDoc: () => ({ accessToken: 'p1' }),
      readSystemKeychainToken: async () => { keychainReads += 1; return { accessToken: 'kc' } },
    })
    assert.equal((await getStoredToken(deps, sys))?.accessToken, 'p1')

    // Empty durable token → falls through to the keychain.
    const deps2 = tokenDeps({
      readPrimaryCredential: () => ({ raw: '{"x":1}', savedAt: 1 }),
      parseCredentialDoc: () => ({}),
      readSystemKeychainToken: async () => { keychainReads += 1; return { accessToken: 'kc' } },
    })
    assert.equal((await getStoredToken(deps2, sys))?.accessToken, 'kc')
    assert.ok(keychainReads >= 1)
  } finally {
    restore()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('persistRefreshedToken: writes the nested agy shape and preserves the prior grant', async () => {
  const dir = tempDir('hb-token-persist-')
  try {
    const acc = account('acc_i', { dir })
    const file = quotaTokenFilePath(acc)
    const deps = tokenDeps()
    persistRefreshedToken(deps, acc, { access_token: 'A1', expiryMs: Date.now() + 3_600_000, refresh_token: 'R1' })
    const first = JSON.parse(readFileSync(file, 'utf8')) as { token: Record<string, unknown>; auth_method: string }
    assert.equal(first.token.access_token, 'A1')
    assert.equal(first.token.refresh_token, 'R1')
    assert.equal(first.auth_method, 'consumer')
    assert.ok(typeof first.token.expiry === 'string')

    // A second refresh without a refresh_token keeps the stored one and old auth/meta.
    persistRefreshedToken(deps, acc, { access_token: 'A2', expiryMs: Date.now() + 3_600_000 })
    const second = JSON.parse(readFileSync(file, 'utf8')) as { token: Record<string, unknown> }
    assert.equal(second.token.access_token, 'A2')
    assert.equal(second.token.refresh_token, 'R1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistRefreshedToken: flat legacy doc is accepted; win32 re-adopts into the durable store', async () => {
  const home = tempDir('hb-token-flat-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  const restore = setPlatform('win32')
  try {
    // systemHome → the token path resolves under HOME, and the win32 re-adopt branch runs.
    const acc = account('acc_sys', { dir: '', systemHome: true })
    const file = quotaTokenFilePath(acc)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ access_token: 'old', refresh_token: 'Rlegacy', token_type: 'Custom' }))
    let written: { raw: string } | null = null
    const deps = tokenDeps({
      parseCredentialDoc: (raw) => (raw && raw.includes('Rlegacy') ? { refreshToken: 'Rlegacy' } : null),
      readPrimaryCredential: () => ({ raw: '{"x":1}', email: 'e@x', savedAt: 1 }),
      writePrimaryCredential: (cred) => { written = cred; return true },
    })
    persistRefreshedToken(deps, acc, { access_token: 'A3' })
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { token: Record<string, unknown> }
    assert.equal(doc.token.access_token, 'A3')
    assert.equal(doc.token.refresh_token, 'Rlegacy')
    assert.equal(doc.token.token_type, 'Custom')
    assert.ok(written !== null && (written as { raw: string }).raw.includes('A3'))
  } finally {
    restore()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('persistRefreshedToken: unwritable path is swallowed (best-effort)', () => {
  const dir = tempDir('hb-token-blocked-')
  try {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const acc = account('acc_i', { dir: join(blocker, 'nested') }) // parent is a file → mkdir throws
    assert.doesNotThrow(() => persistRefreshedToken(tokenDeps(), acc, { access_token: 'A' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isCurrentAccountGrant: system account always current; isolated compares the refresh token', () => {
  const home = tempDir('hb-token-current-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  try {
    const sys = account('acc_sys', { dir: '', systemHome: true })
    assert.equal(isCurrentAccountGrant(tokenDeps(), sys, 'whatever'), true)

    const iso = account('acc_i', { dir: home })
    const file = quotaTokenFilePath(iso)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ refresh_token: 'R1' }))
    const deps = tokenDeps({ parseCredentialDoc: () => ({ refreshToken: 'R1' }) })
    assert.equal(isCurrentAccountGrant(deps, iso, 'R1'), true)
    assert.equal(isCurrentAccountGrant(deps, iso, 'R2'), false)

    writeFileSync(file, '{broken')
    const throwing = tokenDeps({ parseCredentialDoc: () => { throw new Error('bad') } })
    assert.equal(isCurrentAccountGrant(throwing, iso, 'R1'), false)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('getValidAccessToken: dedupes concurrent calls and returns cached/fresh or null tokens', async () => {
  const acc = account('acc_v')
  const map = new Map<string, Promise<string | null>>()
  let calls = 0
  const deps = tokenDeps({
    getStoredToken: async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 5))
      return { accessToken: 'fresh', expiryMs: Date.now() + 3_600_000 }
    },
  })
  const p1 = getValidAccessToken(deps, acc, map)
  const p2 = getValidAccessToken(deps, acc, map)
  assert.equal(await p1, 'fresh')
  assert.equal(await p2, 'fresh')
  assert.equal(calls, 1, 'the second concurrent call reuses the in-flight attempt')
  assert.equal(map.size, 0, 'the in-flight entry is cleared after settling')

  assert.equal(await getValidAccessToken(tokenDeps({ getStoredToken: async () => null }), account('acc_n'), new Map()), null)
  assert.equal(
    await getValidAccessToken(
      tokenDeps({ getStoredToken: async () => ({ accessToken: 'stale', expiryMs: Date.now() - 1_000 }) }),
      account('acc_e'),
      new Map(),
    ),
    'stale',
    'an expired token without a refresh token falls back to the stored access token',
  )
})

test('keyring readers are platform-gated (aix) and the dispatcher no-ops', async () => {
  const restore = setPlatform('aix')
  try {
    assert.equal(await readMacKeychainToken(), null)
    assert.equal(await readLinuxSecretToken(), null)
    assert.equal(await readWindowsCredentialToken(), null)
    assert.equal(await readSystemKeychainToken(), null)
  } finally {
    restore()
  }
})

test('boot-hygiene: darwin with an empty HOME (no login keychain) repairs nothing and does not spawn', () => {
  const home = tempDir('hb-hygiene-darwin-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  const restore = setPlatform('darwin')
  const logs: string[] = []
  try {
    // Accounts have no dir → the per-account keychain provisioning loop is skipped.
    runBootHygiene(hygieneServices({ accounts: [account('acc_a', { dir: '' })], logs }))
    assert.deepEqual(logs, [])
  } finally {
    restore()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

// ===== 7. db/extract ======================================================

function vi(n: number): Buffer {
  const out: number[] = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return Buffer.from(out)
}
const pbTag = (field: number, wire: number): Buffer => vi((field << 3) | wire)
const pbLen = (field: number, buf: Buffer): Buffer => Buffer.concat([pbTag(field, 2), vi(buf.length), buf])
const pbVarint = (field: number, val: number): Buffer => Buffer.concat([pbTag(field, 0), vi(val)])
const pbFixed = (field: number, wire: 1 | 5): Buffer => Buffer.concat([pbTag(field, wire), Buffer.alloc(wire === 1 ? 8 : 4)])

test('extractStepThoughts: JSON toolAction inside field 20.3 becomes an action candidate', () => {
  const json = JSON.stringify({ toolAction: 'Run the test suite', toolSummary: 'all green' })
  const payload = pbLen(20, pbLen(3, Buffer.from(json)))
  assert.equal(extractStepThoughts(payload), 'Run the test suite — all green')
})

test('extractStepThoughts: raw-buffer toolAction/toolSummary fallback scan', () => {
  const payload = Buffer.from('junk "toolAction":"Read the file" mid "toolSummary":"done" tail')
  assert.equal(extractStepThoughts(payload), 'Read the file — done')
})

test('extractStepThoughts: field filter branches (system/plan/uuid/bot) and prose selection', () => {
  const prose = 'This is a real human sentence with enough words to count.'
  const parts = [
    pbLen(20, pbLen(3, Buffer.from('SYSTEM ROLE please ignore me entirely'))),
    pbLen(20, pbLen(3, Buffer.from('/plan do the thing'))),
    pbLen(20, pbLen(3, Buffer.from('123e4567-e89b-12d3-a456-426614174000'))),
    pbLen(20, pbLen(3, Buffer.from('bot-1234567890'))),
    pbLen(20, pbLen(3, Buffer.from('call_abcdefghij'))),
    pbLen(20, pbLen(3, Buffer.from(prose))),
  ]
  const payload = Buffer.concat(parts)
  assert.equal(extractStepThoughts(payload), prose)
})

test('extractStepThoughts: field 20 non-length wire types and unknown wire terminate cleanly', () => {
  const inner = Buffer.concat([pbVarint(1, 5), pbFixed(2, 1), pbFixed(3, 5), pbTag(4, 3)])
  const payload = Buffer.concat([pbLen(20, inner), pbVarint(1, 1), pbFixed(2, 1), pbFixed(3, 5), pbTag(4, 3)])
  assert.equal(extractStepThoughts(payload), null)
  // A run of continuation bytes with no terminator exhausts readVarint.
  assert.equal(extractStepThoughts(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])), null)
})

test('extractStepThoughts: empty/garbage payload yields null', () => {
  assert.equal(extractStepThoughts(Buffer.alloc(0)), null)
  assert.equal(extractStepThoughts(Buffer.from('short')), null)
})

test('extractToolInfo: deterministic field 2/3 sequence extracts name + args', () => {
  const payload = Buffer.concat([
    pbLen(2, Buffer.from('write_to_file')),
    pbLen(3, Buffer.from('{"CodeContent":"hi"}')),
  ])
  assert.deepEqual(extractToolInfo(payload), { name: 'write_to_file', args: { CodeContent: 'hi' } })
})

test('extractToolInfo: invalid name, non-{ args and malformed JSON fall through to the scan', () => {
  // An invalid tool name is rejected by the deterministic scan, but the embedded
  // JSON object still contains a known tool key, so the fallback scan recovers it.
  const badName = Buffer.concat([pbLen(2, Buffer.from('bad name!')), pbLen(3, Buffer.from('{"CodeContent":"x"}'))])
  assert.deepEqual(extractToolInfo(badName), { name: '', args: { CodeContent: 'x' } })
  const nonBrace = Buffer.concat([pbLen(2, Buffer.from('write_to_file')), pbLen(3, Buffer.from('not-json'))])
  assert.equal(extractToolInfo(nonBrace), null)
  const malformed = Buffer.concat([pbLen(2, Buffer.from('write_to_file')), pbLen(3, Buffer.from('{bad'))])
  assert.equal(extractToolInfo(malformed), null)
})

test('extractToolInfo: fallback scan handles escapes, unclosed/invalid braces and picks the richest object', () => {
  const payload = Buffer.from(
    'aaa {"TargetFile":"a\\\\b"} ' +
    'bbb {"TargetFile":"unclosed" ' +
    'ccc {"TargetFile":"bad", } ' +
    'ddd {"TargetFile":"f","CommandLine":"ls","Query":"q"} zzz',
  )
  const out = extractToolInfo(payload)
  assert.ok(out)
  assert.equal(out?.name, '')
  assert.equal((out?.args as Record<string, unknown>).Query, 'q')
  assert.equal(extractToolInfo(Buffer.from('no braces at all')), null)
})

// ===== 8. quota/http ======================================================

function fakeResponse(status: number, body: unknown, opts: { jsonThrows?: boolean } = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (opts.jsonThrows) throw new Error('bad json')
      return body
    },
    text: async () => '',
  } as unknown as Response
}

function httpDeps(handlers: {
  summary?: Array<() => Promise<Response>>
  userQuota?: Array<() => Promise<Response>>
}) {
  const sets: number[] = []
  let preferred = 0
  let si = 0
  let ui = 0
  const deps: QuotaHttpDeps = {
    agyVersion: () => null,
    getPreferredEndpointIndex: () => preferred,
    setPreferredEndpointIndex: (i) => { preferred = i; sets.push(i) },
    fetchSummaryEndpoint: async () => {
      const h = handlers.summary?.[si++]
      if (!h) throw new Error('exhausted')
      return h()
    },
    fetchUserQuotaEndpoint: async () => {
      const h = handlers.userQuota?.[ui++]
      if (!h) throw new Error('exhausted')
      return h()
    },
  }
  return { deps, sets }
}

test('fetchQuotaSummary: first-endpoint gemini summary returns immediately', async () => {
  const summary = { groups: [{ displayName: 'Gemini Models', buckets: [] }] }
  const { deps, sets } = httpDeps({ summary: [async () => fakeResponse(200, summary)] })
  assert.deepEqual(await fetchQuotaSummary(deps, 'tok'), summary)
  assert.deepEqual(sets, [])
})

test('fetchQuotaSummary: a later gemini endpoint wins and records the preferred index', async () => {
  const summary = { groups: [{ displayName: 'Gemini Models', buckets: [] }] }
  const { deps, sets } = httpDeps({
    summary: [
      async () => fakeResponse(200, {}), // no gemini, no groups → partial stays null
      async () => fakeResponse(200, summary),
    ],
  })
  assert.deepEqual(await fetchQuotaSummary(deps, 'tok'), summary)
  assert.deepEqual(sets, [AGY_ENDPOINTS.indexOf(AGY_ENDPOINTS[1]!)])
})

test('fetchQuotaSummary: merges 3P groups from an earlier partial summary', async () => {
  const partial = { groups: [{ displayName: 'Claude Models', buckets: [] }] }
  const gemini = { groups: [{ displayName: 'Gemini Models', buckets: [] }] }
  const { deps } = httpDeps({
    summary: [async () => fakeResponse(200, partial), async () => fakeResponse(200, gemini)],
  })
  const out = await fetchQuotaSummary(deps, 'tok')
  assert.equal(out?.groups?.length, 2)
  assert.equal(out?.groups?.some((g) => g.displayName === 'Claude Models'), true)
  assert.equal(out?.groups?.some((g) => g.displayName === 'Gemini Models'), true)
})

test('fetchQuotaSummary: 401/403 breaks; thrown endpoints and unparsable JSON fall through to null', async () => {
  const forbidden = httpDeps({ summary: [async () => fakeResponse(403, {})] })
  assert.equal(await fetchQuotaSummary(forbidden.deps, 'tok'), null)

  const throwing = httpDeps({
    summary: [
      async () => { throw new Error('net') },
      async () => fakeResponse(200, { groups: [{ displayName: 'Gemini Models', buckets: [] }] }),
    ],
  })
  assert.ok(await fetchQuotaSummary(throwing.deps, 'tok'))

  const badJson = httpDeps({ summary: [async () => fakeResponse(200, null, { jsonThrows: true })] })
  assert.equal(await fetchQuotaSummary(badJson.deps, 'tok'), null)

  const empty = httpDeps({ summary: [async () => fakeResponse(200, undefined)] })
  assert.equal(await fetchQuotaSummary(empty.deps, 'tok'), null)
})

test('fetchUserQuota: ok returns json, 401 breaks, throws fall through, all-fail is null', async () => {
  const okBody = { buckets: [{ modelId: 'm', remainingFraction: 0.5 }] }
  const okDeps = httpDeps({ userQuota: [async () => fakeResponse(200, okBody)] })
  assert.deepEqual(await fetchUserQuota(okDeps.deps, 'tok'), okBody)

  const forbidden = httpDeps({ userQuota: [async () => fakeResponse(401, {})] })
  assert.equal(await fetchUserQuota(forbidden.deps, 'tok'), null)

  const retry = httpDeps({
    userQuota: [
      async () => { throw new Error('net') },
      async () => fakeResponse(200, okBody),
    ],
  })
  assert.deepEqual(await fetchUserQuota(retry.deps, 'tok'), okBody)

  const serverErr = httpDeps({ userQuota: [async () => fakeResponse(500, {})] })
  assert.equal(await fetchUserQuota(serverErr.deps, 'tok'), null)
})

// ===== 9. commands/session ===============================================

function fakeStore(initial: Record<string, { conversationId: string; lastMessageCount: number; updatedAt: number; model?: string }> = {}) {
  const data = { ...initial }
  return {
    all: () => data,
    delete: (k: string) => { delete (data as Record<string, unknown>)[k] },
    data,
  }
}

function cmdDeps(store: ReturnType<typeof fakeStore>, sessions?: { get(id: unknown): unknown }): CommandDeps {
  return { store: () => store as never, sessions: () => sessions } as unknown as CommandDeps
}

function ctx(arg: string, agent?: { id?: string; session?: unknown }): CommandContext {
  return { sub: 'goal', arg, parts: [], raw: '', ...(agent === undefined ? {} : { invocation: { agent } as never }) }
}

function goalSession(events: unknown[], append?: (t: string, d: unknown) => void) {
  return { events, ...(append === undefined ? {} : { append }) } as never
}

function goalEvent(over: Partial<{ operation: string; phase: string; kind: string; blocked: boolean; maxRounds: number }> = {}) {
  return {
    type: 'goal/change',
    data: {
      kind: over.kind ?? 'goal/change',
      operation: over.operation ?? 'active',
      goal: {
        id: 'g1',
        revision: 2,
        objective: 'ship it',
        phase: over.phase ?? 'active',
        ...(over.maxRounds === undefined ? {} : { maxGoalRounds: over.maxRounds }),
        ...(over.blocked ? { blockedReason: { message: 'needs input' } } : {}),
      },
      roundsStarted: 4,
      createdAt: 1000,
    },
  }
}

test('handleGoal: no session / no active goal / unknown action', () => {
  const store = fakeStore()
  assert.equal(handleGoal(cmdDeps(store), ctx('status')).kind, 'error')
  assert.equal(handleGoal(cmdDeps(store), ctx('status', { id: 's1', session: goalSession([]) })).kind, 'success')
  assert.match((handleGoal(cmdDeps(store), ctx('status', { id: 's1', session: goalSession([]) })).text ?? ''), /No active goal/)
  assert.match((handleGoal(cmdDeps(store), ctx('bogus', { id: 's1', session: goalSession([]) })).text ?? ''), /Unknown goal action/)
})

test('handleGoal: status renders phase, rounds, id and a blocked reason', () => {
  const session = goalSession([goalEvent({ phase: 'blocked', blocked: true, maxRounds: 10 })])
  const out = handleGoal(cmdDeps(fakeStore()), ctx('status', { id: 's1', session }))
  assert.equal(out.kind, 'success')
  assert.match(out.text ?? '', /🚫/)
  assert.match(out.text ?? '', /g1/)
  assert.match(out.text ?? '', /4 \/ 10/)
  assert.match(out.text ?? '', /needs input/)
})

test('handleGoal: an unknown phase falls back to the neutral emoji and the clear operation hides the goal', () => {
  const odd = goalSession([goalEvent({ phase: 'weird' })])
  assert.match(handleGoal(cmdDeps(fakeStore()), ctx('status', { id: 's1', session: odd })).text ?? '', /⚪/)
  const cleared = goalSession([goalEvent({ operation: 'clear' })])
  assert.match(handleGoal(cmdDeps(fakeStore()), ctx('status', { id: 's1', session: cleared })).text ?? '', /No active goal/)
})

test('handleGoal: complete/pause/resume error without a goal or without append', () => {
  for (const action of ['complete', 'pause', 'resume']) {
    assert.equal(handleGoal(cmdDeps(fakeStore()), ctx(action, { id: 's1', session: goalSession([]) })).kind, 'error')
    const noAppend = goalSession([goalEvent()])
    assert.match(handleGoal(cmdDeps(fakeStore()), ctx(action, { id: 's1', session: noAppend })).text ?? '', /cannot append/)
  }
})

test('handleGoal: complete/pause/resume/clear append the right transition', () => {
  for (const [action, phase] of [['complete', 'complete'], ['pause', 'paused'], ['resume', 'active']] as const) {
    const appended: Array<{ t: string; d: Record<string, unknown> }> = []
    const session = goalSession([goalEvent()], (t, d) => appended.push({ t, d: d as Record<string, unknown> }))
    const out = handleGoal(cmdDeps(fakeStore()), ctx(action, { id: 's1', session }))
    assert.equal(out.kind, 'success')
    assert.equal(appended[0]?.t, 'goal/change')
    const goal = appended[0]?.d.goal as { phase: string; revision: number }
    assert.equal(goal.phase, phase)
    assert.equal(goal.revision, 3)
  }

  const appended: Array<Record<string, unknown>> = []
  const clearSession = goalSession([goalEvent()], (_t, d) => appended.push(d as Record<string, unknown>))
  const clearOut = handleGoal(cmdDeps(fakeStore()), ctx('clear', { id: 's1', session: clearSession }))
  assert.equal(clearOut.kind, 'success')
  assert.equal(appended[0]?.operation, 'clear')
  assert.equal((appended[0]?.cleared as { id: string }).id, 'g1')
})

test('handleGoal: clear without a goal is a no-op success; clear without append is an error', () => {
  assert.match(handleGoal(cmdDeps(fakeStore()), ctx('clear', { id: 's1', session: goalSession([]) })).text ?? '', /No active goal to clear/)
  const noAppend = goalSession([goalEvent()])
  assert.match(handleGoal(cmdDeps(fakeStore()), ctx('clear', { id: 's1', session: noAppend })).text ?? '', /cannot append/)
})

test('handleGoal: session falls back to the session store and ignores non-goal events', () => {
  const session = goalSession([{ type: 'other', data: {} }, { type: 'goal/change', data: { kind: 'nope' } }])
  const sessions = { get: () => session }
  const out = handleGoal(cmdDeps(fakeStore(), sessions), ctx('status', { id: 's1' }))
  assert.match(out.text ?? '', /No active goal/)
})

test('handleSession: info shows bindings/cwd/events or the no-identifier branch', () => {
  const store = fakeStore({ sess1: { conversationId: 'c1', lastMessageCount: 3, updatedAt: 5, model: 'm1' } })
  const session = { header: { cwd: '/work' }, events: [1, 2] }
  const info = handleSession(cmdDeps(store), ctx('info', { id: 'sess1', session }))
  assert.match(info.text ?? '', /sess1/)
  assert.match(info.text ?? '', /\/work/)
  assert.match(info.text ?? '', /c1/)
  assert.match(info.text ?? '', /m1/)
  assert.match(info.text ?? '', /Total Session Events/)

  const noBinding = handleSession(cmdDeps(fakeStore()), ctx('info', { id: 'sess2', session: { header: {} } }))
  assert.match(noBinding.text ?? '', /none - next turn starts fresh/)

  const noId = handleSession(cmdDeps(fakeStore()), ctx('info'))
  assert.match(noId.text ?? '', /could not be identified/)
})

test('handleSession: clear without an id drops the most-recent binding; with an id drops matches', () => {
  assert.match(handleSession(cmdDeps(fakeStore()), ctx('clear')).text ?? '', /No conversation bindings yet/)

  const store = fakeStore({
    old: { conversationId: 'cold', lastMessageCount: 0, updatedAt: 1 },
    recent: { conversationId: 'cnew', lastMessageCount: 0, updatedAt: 9 },
  })
  const cleared = handleSession(cmdDeps(store), ctx('clear'))
  assert.match(cleared.text ?? '', /recent/)
  assert.equal(store.data.recent, undefined)

  const store2 = fakeStore({
    'sess:acc': { conversationId: 'c1', lastMessageCount: 0, updatedAt: 1 },
    other: { conversationId: 'c2', lastMessageCount: 0, updatedAt: 2 },
  })
  const out = handleSession(cmdDeps(store2), ctx('clear', { id: 'sess' }))
  assert.match(out.text ?? '', /Dropped 1 agy conversation binding/)
  assert.equal(store2.data['sess:acc'], undefined)

  const none = handleSession(cmdDeps(fakeStore({ other: { conversationId: 'c', lastMessageCount: 0, updatedAt: 1 } })), ctx('clear', { id: 'nope' }))
  assert.match(none.text ?? '', /Dropped any agy conversation binding/)
  assert.match(handleSession(cmdDeps(fakeStore()), ctx('nope')).text ?? '', /Unknown session action/)
})

test('handleClear: drops the session binding, else the most recent, else reports none', () => {
  const withSession = fakeStore({ 's1:acc': { conversationId: 'c1', lastMessageCount: 0, updatedAt: 1 } })
  assert.match(handleClear(cmdDeps(withSession), ctx('', { id: 's1' })).text ?? '', /Dropped binding for session/)
  assert.equal(withSession.data['s1:acc'], undefined)

  const fallback = fakeStore({ only: { conversationId: 'c', lastMessageCount: 0, updatedAt: 1 } })
  assert.match(handleClear(cmdDeps(fallback), ctx('', { id: 's2' })).text ?? '', /only/)
  assert.equal(fallback.data.only, undefined)

  assert.match(handleClear(cmdDeps(fakeStore()), ctx('')).text ?? '', /No conversation bindings yet/)
})


// ===== 10. extra token edge cases ========================================

test('getStoredToken: malformed nested token documents return null', async () => {
  const dir = tempDir('hb-token-malformed-')
  try {
    const acc = account('acc_i', { dir })
    const file = quotaTokenFilePath(acc)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ token: { nope: 1 } }))
    assert.equal(await getStoredToken(tokenDeps(), acc), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('getValidAccessToken: expired token with no access and no refresh token returns null', async () => {
  const deps = tokenDeps({ getStoredToken: async () => ({ expiryMs: Date.now() - 1_000 }) })
  assert.equal(await getValidAccessToken(deps, account('acc_e2'), new Map()), null)
})

test('getStoredToken: a failing keyring read surfaces as a rejection', async () => {
  const home = tempDir('hb-token-kcfail-')
  const savedHome = process.env.HOME
  process.env.HOME = home
  try {
    const sys = account('acc_sys', { dir: '', systemHome: true })
    const deps = tokenDeps({ readSystemKeychainToken: async () => { throw new Error('keyring locked') } })
    await assert.rejects(() => getStoredToken(deps, sys), /keyring locked/)
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  }
})

// ===== 11. keychain provisioning/purge (injected run, no spawn) ==========

test('ensureIsolatedKeychain: provisions once, then reports the keychain exists; failures return false', () => {
  const dir = tempDir('hb-kc-ensure-')
  try {
    assert.equal(ensureIsolatedKeychain('', 'darwin', () => undefined), false)
    assert.equal(ensureIsolatedKeychain(dir, 'linux', () => undefined), false)
    const calls: string[] = []
    const ok = ensureIsolatedKeychain(dir, 'darwin', (_file, args) => {
      calls.push(args[0]!)
      if (args[0] === 'create-keychain') writeFileSync(join(dir, 'Library', 'Keychains', 'login.keychain-db'), 'kc')
      return undefined
    })
    assert.equal(ok, true)
    assert.deepEqual(calls, ['create-keychain', 'set-keychain-settings'])
    assert.equal(ensureIsolatedKeychain(dir, 'darwin', () => undefined), false, 'already provisioned')
    const failing = tempDir('hb-kc-ensure-fail-')
    assert.equal(ensureIsolatedKeychain(failing, 'darwin', () => { throw new Error('security boom') }), false)
    rmSync(failing, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purgeStaleIsolatedKeychain: healthy keychain kept, throwing run purges it, edge paths no-op', () => {
  const dir = tempDir('hb-kc-purge-')
  try {
    assert.equal(purgeStaleIsolatedKeychain('', 'darwin', () => undefined), false)
    assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin', () => undefined), false, 'missing keychain no-ops')
    const kcPath = join(dir, 'Library', 'Keychains', 'login.keychain-db')
    mkdirSync(dirname(kcPath), { recursive: true })
    writeFileSync(kcPath, 'stale')
    // Healthy: settings update succeeds → not stale, file kept.
    assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin', () => undefined), false)
    assert.equal(existsSync(kcPath), true)
    // Locked/corrupt: settings update throws → purge deletes it.
    assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin', (_f, args) => {
      if (args[0] === 'set-keychain-settings') throw new Error('locked')
      return undefined
    }), true)
    assert.equal(existsSync(kcPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
