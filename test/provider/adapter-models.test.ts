// Model catalog surface: listModels / resolveModel (modalities, duplicate
// ids, hidden models, context window, defensive parsing, per-account
// union) and the side-effect-free listing contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS } from '../../src/common/types.ts'
import { collect, makeAdapter, msg, opts } from '../helpers/adapter-fixtures.ts'

test('listModels is side-effect free: listing never spawns model discovery', async () => {
  // Reported as an infinite probe loop (100% CPU, fan spinning, UI flashing):
  // listModels() kicked off refreshIfNeeded(), whose completion emits
  // llm/adapters-updated — which makes DSH call listModels() again. A zero TTL
  // makes every refresh eligible, so any probing here would fire on each call.
  let probes = 0
  const catalog = new ModelCatalog(
    async () => { probes++; return { stdout: 'gemini-3.8-flash\tGemini 3.8 Flash', stderr: '' } },
    DEFAULT_FALLBACK_MODELS,
    0,
  )
  const { adapter } = makeAdapter({}, { catalog } as never)
  await adapter.listModels('antigravity')
  await adapter.listModels('antigravity')
  assert.equal(probes, 0, 'refresh belongs to startup/account-switch paths, never to listing')
})

test('listModels and resolveModel advertise text and image modalities (multimodal)', async () => {
  const { adapter } = makeAdapter()
  const models = await adapter.listModels('antigravity')
  assert.ok(models.length > 0)
  for (const m of models) {
    assert.deepEqual(m.inputModalities, ['text', 'image'], `model ${m.id} should advertise text and image modalities`)
  }
  const resolved = await adapter.resolveModel('antigravity', 'gemini-3.7-flash')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

test('listModels never returns duplicate ids even with duplicate fallback defs (issue #1)', async () => {
  // DSH's llm.listModels contract throws INVALID_CATALOG on any duplicate
  // model id and the model picker then drops the whole Antigravity group.
  // A user-configured fallbackModels list (or any catalog source) must never
  // be able to trigger that, so the adapter dedupes as a final guard.
  const logs: string[] = []
  const { adapter } = makeAdapter({
    fallbackModels: [
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash (dup)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (dup)' },
    ],
  }, { log: (m) => logs.push(m) })
  const models = await adapter.listModels('antigravity')
  const ids = models.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, 'listModels ids must be unique')
  assert.deepEqual(ids, ['gemini-3.7-flash', 'claude-sonnet-4-6'])
  // The guard must be observable so field instances show up in server logs
  // instead of silently masking the underlying catalog duplication.
  assert.ok(
    logs.some((m) => m.includes('duplicate') && m.includes('gemini-3.7-flash') && m.includes('claude-sonnet-4-6')),
    'deduping should log which duplicate ids were dropped',
  )
})

test('listModels hides hiddenModels from the picker while resolveModel still resolves them', async () => {
  const { adapter } = makeAdapter({ hiddenModels: ['gemini-3.8-flash', ' gpt-oss-120b-medium '] })
  const models = await adapter.listModels('antigravity')
  const ids = models.map((m) => m.id)
  assert.ok(!ids.includes('gemini-3.8-flash'), 'a hidden id must leave the picker list')
  assert.ok(!ids.includes('gpt-oss-120b-medium'), 'hidden ids are matched after trimming')
  assert.ok(ids.includes('claude-sonnet-5-5'), 'unlisted models stay visible (deny-list semantics)')
  // resolveModel deliberately does not filter: in-flight sessions and direct
  // references keep resolving a model after it has been hidden.
  const resolved = await adapter.resolveModel('antigravity', 'gemini-3.8-flash')
  assert.equal(resolved.id, 'gemini-3.8-flash')
  assert.equal(resolved.name, 'Gemini 3.8 Flash')
})

test('resolveModel uniformly advertises 1M context window across all Antigravity models (ADR-013)', async () => {
  const { adapter } = makeAdapter()
  const gemini = await adapter.resolveModel('antigravity', 'gemini-3.7-flash')
  assert.equal(gemini.context?.contextWindow, 1_048_576)
  const claude = await adapter.resolveModel('antigravity', 'claude-sonnet-4-6')
  assert.equal(claude.context?.contextWindow, 1_048_576)
  const gpt = await adapter.resolveModel('antigravity', 'gpt-oss-120b-medium')
  assert.equal(gpt.context?.contextWindow, 1_048_576)
})

test('listModels and resolveModel defensively handle empty IDs, empty names, and empty effort lists', async () => {
  const { adapter } = makeAdapter({
    fallbackModels: [
      { id: '  ', name: 'Empty Id' },
      { id: 'valid-model', name: '  ', efforts: [''] },
      { id: 'effort-model', name: 'Effort Model', efforts: ['high', 'low', 'high'] },
    ],
  })
  const models = await adapter.listModels('antigravity')
  assert.equal(models.some((m) => m.id.trim() === ''), false)
  assert.ok(models.some((m) => m.id === 'valid-model' && m.name === 'valid-model'))

  const resolved = await adapter.resolveModel('antigravity', 'effort-model')
  assert.ok(resolved.reasoning)
  // Canonical order (common/reasoning.ts) + dedupe, so the model menu always
  // reads Low → Medium → High → Extra regardless of the order agy printed.
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['low', 'high'])
  // Display names come from agy's own picker vocabulary, not the raw ids.
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.name), ['Low', 'High'])
  assert.equal(resolved.reasoning.defaultEffort, 'high')

  const resolvedNoEffort = await adapter.resolveModel('antigravity', 'valid-model')
  assert.equal(resolvedNoEffort.reasoning, undefined)
})

test('listModels exposes union of models across all accounts while resolveModel remains pure', async () => {
  let activeId = 'acc_free'
  const accounts: Record<string, any> = {
    acc_free: {
      id: 'acc_free',
      alias: 'Free Account',
      dir: '/tmp/acc_free',
      enabled: true,
      quotas: { google: { remainingFraction: 1 } },
    },
    acc_pro: {
      id: 'acc_pro',
      alias: 'Pro Account',
      dir: '/tmp/acc_pro',
      enabled: true,
      quotas: { argon: { remainingFraction: 1 }, google: { remainingFraction: 1 } },
    },
  }
  const fakePool = {
    getActiveAccountId: () => activeId,
    getPoolData: () => ({ primaryAccountId: 'acc_free', lastActiveAccountId: activeId, accounts: Object.values(accounts) }),
    getAccounts: () => Object.values(accounts),
    getAccount: (id: string) => accounts[id],
    hasDedicatedGroup: (id: string, fam: string) => id === 'acc_pro' && fam === 'argon',
    accountHasArgon: (acc: any) => acc.id === 'acc_pro',
    isAccountEligible: (acc: any, fam: string) => fam === 'argon' ? acc.id === 'acc_pro' : true,
    isModelSupported: (acc: any, model: string) => model === 'gemini-4-argon' ? acc.id === 'acc_pro' : true,
    selectAccount: (fam: string) => {
      if (fam === 'argon') return accounts['acc_pro']
      return accounts[activeId]
    },
    setActiveAccount: (id: string) => { activeId = id; return true },
  }
  const { adapter } = makeAdapter({
    fallbackModels: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    ],
  }, { pool: fakePool as any })

  // 1. With free account active: only models supported by acc_free are listed (argon excluded)
  activeId = 'acc_free'
  const freeModels = await adapter.listModels('antigravity')
  assert.ok(freeModels.some((m) => m.id === 'gemini-3.8-flash'))
  assert.ok(!freeModels.some((m) => m.id === 'gemini-4-argon'), 'free account without argon must not advertise argon in picker')

  // 2. When switched to pro account: argon is listed in the picker
  activeId = 'acc_pro'
  const proModels = await adapter.listModels('antigravity')
  assert.ok(proModels.some((m) => m.id === 'gemini-4-argon'), 'pro account must advertise argon in picker')

  // 3. Resolving gemini-4-argon succeeds from union models without mutating active account (pure query)
  activeId = 'acc_free'
  const resolved = await adapter.resolveModel('antigravity', 'gemini-4-argon')
  assert.equal(resolved.id, 'gemini-4-argon')
  assert.equal(activeId, 'acc_free', 'resolveModel must remain side-effect free')

  // 3. When NO account in the pool has Argon access, Argon is excluded
  const fakePoolNoArgon = {
    ...fakePool,
    getAccounts: () => [accounts['acc_free']],
    getPoolData: () => ({ primaryAccountId: 'acc_free', lastActiveAccountId: 'acc_free', accounts: [accounts['acc_free']] }),
    hasDedicatedGroup: () => false,
    accountHasArgon: () => false,
  }
  const { adapter: adapterNoArgon } = makeAdapter({
    fallbackModels: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    ],
  }, { pool: fakePoolNoArgon as any })
  const freeOnlyModels = await adapterNoArgon.listModels('antigravity')
  assert.ok(!freeOnlyModels.some((m) => m.id === 'gemini-4-argon'), 'pool without any argon accounts must not show gemini-4-argon')
})

test('N lookups of an unavailable model do not rewrite or mutate the pool', async () => {
  let activeId = 'acc_free'
  let persistCalls = 0
  const fakePool = {
    getActiveAccountId: () => activeId,
    getPoolData: () => ({ primaryAccountId: 'acc_free', lastActiveAccountId: activeId, accounts: [] }),
    getAccounts: () => [{ id: 'acc_free', enabled: true, quotas: {} }],
    getAccount: () => ({ id: 'acc_free', enabled: true }),
    setActiveAccount: () => { persistCalls++; return true },
    persist: () => { persistCalls++ },
  }
  const { adapter } = makeAdapter({
    fallbackModels: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }],
  }, { pool: fakePool as any })

  for (let i = 0; i < 20; i++) {
    const info = await adapter.resolveModel('antigravity', 'gemini-4-argon')
    assert.equal(info.id, 'gemini-4-argon')
  }
  assert.equal(persistCalls, 0, 'repeated lookups of unsupported model must not rewrite the pool')
  assert.equal(activeId, 'acc_free')
})

test('stream error provides unsupported hint when no account has access to the requested family', async () => {
  const fakePool = {
    getAccounts: () => [{ id: 'acc_free', enabled: true, quotas: {} }],
    explainIneligibility: () => 'unsupported' as const,
    isAccountEligible: () => false,
    selectAccount: () => null,
    getEarliestAvailableCountdown: () => null,
    getEarliestResetCountdown: () => null,
  }
  const { adapter } = makeAdapter({}, { pool: fakePool as any })
  await assert.rejects(
    () => collect(adapter.stream(opts([msg('user', 'hi')], { model: 'gemini-4-argon' }))),
    (err: any) => {
      assert.ok(err.message.includes('1 lack argon access'), `expected lack argon access in ${err.message}`)
      assert.ok(err.message.includes('No enabled account has access to argon'), `expected unsupported hint in ${err.message}`)
      return true
    },
  )
})
