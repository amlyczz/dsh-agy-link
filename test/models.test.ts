import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountHasArgon, buildFallbackCatalog, defaultEffortFor, findEntry, foldEfforts, isArgonModel, ModelCatalog, parseModelsOutput } from '../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS, defaultConfig, type PluginConfig } from '../src/common/types.ts'

test('parseModelsOutput reads the JSON array shape', () => {
  const raw = JSON.stringify([
    { id: 'gemini-3-6-flash', display_name: 'Gemini 3.6 Flash' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  ])
  const out = parseModelsOutput(raw)
  assert.equal(out.length, 2)
  assert.equal(out[0]?.slug, 'gemini-3-6-flash')
  assert.equal(out[0]?.label, 'Gemini 3.6 Flash')
})

test('parseModelsOutput reads the TAB-separated agy 1.1.15 table and folds efforts', () => {
  // Captured verbatim from a live `agy models` (1.1.15, signed in)
  const table = [
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
    'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
    'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n')
  const out = parseModelsOutput(table)
  assert.equal(out.length, 5)
  assert.equal(out[0]?.slug, 'gemini-3.7-flash-high')
  assert.equal(out[0]?.label, 'Gemini 3.7 Flash (High)')
  const folded = foldEfforts(out)
  const base = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'gemini-3.7-flash')
  assert.ok(base, 'gemini-3.7-flash base exists after folding')
  assert.deepEqual(base?.efforts, ['low', 'medium', 'high'])
})

test('parseModelsOutput drops lowercase diagnostic lines (error:/failed:)', () => {
  // agy may print lowercase 'error:  …' / 'failed:  …' lines; the two-column
  // parser must not turn them into bogus model slugs.
  const out = parseModelsOutput('error:  upstream unavailable\nfailed:  retry later\ngemini-3  Gemini 3\n')
  assert.deepEqual(out.map((m) => m.slug), ['gemini-3'])
})

test('parseModelsOutput reads the two-column text shape', () => {
  const out = parseModelsOutput('gemini-3-6-flash    Gemini 3.6 Flash\nclaude-sonnet-4-6    Claude Sonnet 4.6\n')
  assert.equal(out.length, 2)
  assert.equal(out[1]?.slug, 'claude-sonnet-4-6')
})

test('parseModelsOutput handles dotted current-gen slugs', () => {
  // agy 1.1.13 prints gemini-3.7-flash(-medium) etc. (dots, not dashes)
  const out = parseModelsOutput('gemini-3.7-flash    Gemini 3.7 Flash\ngemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)\ngemini-3.6-flash    Gemini 3.6 Flash\n')
  assert.deepEqual(out.map((r) => r.slug), ['gemini-3.7-flash', 'gemini-3.7-flash-medium', 'gemini-3.6-flash'])
  const folded = foldEfforts(out)
  const base = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'gemini-3.7-flash')
  assert.ok(base, 'gemini-3.7-flash base exists after folding')
  assert.deepEqual(base?.efforts, ['medium'])
})

test('fallback catalog carries the current model line-up incl. 3.8 and 3.7', () => {
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  const ids = cat.map((e) => e.id)
  assert.ok(ids.includes('gemini-3.8-flash'), '3.8 flash present')
  assert.ok(ids.includes('gemini-3.7-flash'), '3.7 flash present')
  assert.ok(ids.includes('gemini-3.6-flash'))
  assert.ok(ids.includes('claude-opus-4-6-thinking'))
  assert.ok(ids.includes('gpt-oss-120b-medium'))
  const f38 = findEntry({ source: 'fallback', models: cat, discoveredAt: 0 }, 'gemini-3.8-flash')
  assert.deepEqual(f38?.efforts, ['low', 'medium', 'high'])
  const f37 = findEntry({ source: 'fallback', models: cat, discoveredAt: 0 }, 'gemini-3.7-flash')
  assert.deepEqual(f37?.efforts, ['low', 'medium', 'high'])
})

test('parseModelsOutput skips banners and error lines', () => {
  const out = parseModelsOutput('Fetching models...\nError: hmm\ngemini-3-6-flash    Flash\n')
  assert.equal(out.length, 1)
})

test('foldEfforts folds gemini effort suffixes into a base entry', () => {
  const folded = foldEfforts([
    { slug: 'gemini-3-6-flash', label: 'Gemini 3.6 Flash' },
    { slug: 'gemini-3-6-flash-high', label: 'Gemini 3.6 Flash High' },
    { slug: 'gemini-3-6-flash-low', label: 'Gemini 3.6 Flash Low' },
    { slug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  ])
  const ids = folded.map((e) => e.id)
  assert.ok(ids.includes('gemini-3-6-flash'))
  assert.ok(!ids.includes('gemini-3-6-flash-high'))
  const base = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'gemini-3-6-flash')
  assert.deepEqual(base?.efforts, ['low', 'high'])
  const claude = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'claude-sonnet-4-6')
  assert.equal(claude?.efforts, null)
})

test('foldEfforts emits no duplicate ids when agy lists the bare base plus one variant (issue #1)', () => {
  // agy 1.1.13 shape: the bare base IS a catalog member next to its
  // variants. Folding must absorb the bare entry into the folded base
  // instead of emitting the id twice — DSH's llm.listModels rejects the
  // whole provider catalog on any duplicate id (INVALID_CATALOG), which
  // drops the entire Antigravity group from the model picker.
  const folded = foldEfforts([
    { slug: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { slug: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
    { slug: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  ])
  const ids = folded.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'catalog ids must be unique')
  const base = folded.filter((e) => e.id === 'gemini-3.7-flash')
  assert.equal(base.length, 1, 'folded base appears exactly once')
  assert.deepEqual(base[0]?.efforts, ['medium'])
  // Unrelated bare entries stay verbatim.
  assert.ok(ids.includes('gemini-3.6-flash'))
})

test('foldEfforts emits no duplicate ids when the bare base is listed alongside every variant', () => {
  const folded = foldEfforts([
    { slug: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { slug: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { slug: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
    { slug: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
    { slug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  ])
  const ids = folded.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'catalog ids must be unique')
  const base = folded.filter((e) => e.id === 'gemini-3.7-flash')
  assert.equal(base.length, 1)
  assert.deepEqual(base[0]?.efforts, ['low', 'medium', 'high'])
  assert.ok(ids.includes('claude-sonnet-4-6'))
})

test('parseModelsOutput dedupes repeated slugs', () => {
  // Some agy builds print the same row twice (e.g. overlapping sections);
  // duplicate raw slugs would become duplicate catalog ids downstream.
  const out = parseModelsOutput([
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n'))
  assert.deepEqual(out.map((r) => r.slug), ['gemini-3.7-flash-high', 'claude-sonnet-4-6'])
})

test('bare gemini base without siblings gets no efforts', () => {
  const folded = foldEfforts([{ slug: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro' }])
  assert.equal(folded[0]?.efforts, null)
})

test('buildFallbackCatalog carries configurable efforts', () => {
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  assert.equal(cat.length, 8)
  const flash38 = cat.find((e) => e.id === 'gemini-3.8-flash')
  assert.deepEqual(flash38?.efforts, ['low', 'medium', 'high'])
  const argon = cat.find((e) => e.id === 'gemini-4-argon')
  assert.deepEqual(argon?.efforts, ['low', 'medium', 'high'])
  const flash = cat.find((e) => e.id === 'gemini-3.7-flash')
  assert.deepEqual(flash?.efforts, ['low', 'medium', 'high'])
  const claude = cat.find((e) => e.id === 'claude-sonnet-4-6')
  assert.equal(claude?.efforts, null)
})

test('defaultEffortFor prefers config override then high first', () => {
  const cfg: PluginConfig = { ...defaultConfig(), defaultEffort: 'low' }
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  const flash = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3.7-flash')
  assert.equal(flash && defaultEffortFor(flash, cfg), 'low')
  // No config override: default is the highest available effort.
  const cfg2: PluginConfig = { ...defaultConfig(), defaultEffort: '' }
  assert.equal(flash && defaultEffortFor(flash, cfg2), 'high')
  // Flash line-up defaults to high
  const flash38 = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3.8-flash')
  assert.equal(flash38 && defaultEffortFor(flash38, cfg2), 'high')
})

test('effort suffix ids still resolve to their base entry', () => {
  const folded = foldEfforts([
    { slug: 'gemini-3-6-flash', label: 'F' },
    { slug: 'gemini-3-6-flash-high', label: 'FH' },
  ])
  const cat = { source: 'discovered' as const, models: folded, discoveredAt: 0 }
  assert.equal(findEntry(cat, 'gemini-3-6-flash')?.id, 'gemini-3-6-flash')
})

test('findEntry resolves aliases via resolveModelSlug', () => {
  const cat = { source: 'fallback' as const, models: buildFallbackCatalog(DEFAULT_FALLBACK_MODELS), discoveredAt: 0 }
  assert.equal(findEntry(cat, 'claude-opus-4-6')?.id, 'claude-opus-4-6-thinking')
  assert.equal(findEntry(cat, 'claude-opus')?.id, 'claude-opus-4-6-thinking')
  assert.equal(findEntry(cat, 'gpt-oss-120b')?.id, 'gpt-oss-120b-medium')
})

test('isArgonModel identifies Argon variants case-insensitively', () => {
  assert.equal(isArgonModel('gemini-4-argon'), true)
  assert.equal(isArgonModel('gemini-4-argon-high'), true)
  assert.equal(isArgonModel('GEMINI-4-ARGON'), true)
  assert.equal(isArgonModel('gemini-3.8-flash'), false)
  assert.equal(isArgonModel('claude-sonnet-4-6'), false)
})

test('accountHasArgon detects Argon access across quota, pool, and discovered catalog', () => {
  // 1. Account with live argon quota
  const accWithArgonQuota = {
    id: 'acc_pro',
    alias: 'Pro',
    dir: '/tmp/pro',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {
      argon: { remainingFraction: 1 },
      google: { remainingFraction: 0.8 },
    },
  }
  assert.equal(accountHasArgon(accWithArgonQuota), true)

  // 2. Account with dedicated group noted in pool (PR #54)
  const fakePool = {
    hasDedicatedGroup: (id: string, fam: string) => id === 'acc_pro_pool' && fam === 'argon',
  }
  const accWithPoolNote = {
    id: 'acc_pro_pool',
    alias: 'Pro Pool',
    dir: '/tmp/pro2',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {},
  }
  assert.equal(accountHasArgon(accWithPoolNote, fakePool as never), true)

  // 3. Account with per-model quota mentioning argon
  const accWithModelQuota = {
    id: 'acc_model',
    alias: 'Model',
    dir: '/tmp/model',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 1,
        models: [{ modelId: 'gemini-4-argon-high', remainingFraction: 1 }],
      },
    },
  }
  assert.equal(accountHasArgon(accWithModelQuota), true)

  // 4. Free account: Google quota present, but NO Argon bucket
  const freeAcc = {
    id: 'acc_free',
    alias: 'Free',
    dir: '/tmp/free',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {
      google: { remainingFraction: 1 },
    },
  }
  assert.equal(accountHasArgon(freeAcc), false)

  // 4b. REGRESSION: Free account with Google quota but NO Argon bucket
  // must return false EVEN IF passed a discovered catalog that contains Argon!
  const discoveredCatalogWithArgon = {
    source: 'discovered' as const,
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: null },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: null },
    ],
    discoveredAt: Date.now(),
  }
  assert.equal(
    accountHasArgon(freeAcc, null, discoveredCatalogWithArgon),
    false,
    'free account must NEVER claim argon even if a discovered catalog contains argon',
  )

  // 5. Blank/un-polled account: defaults to false
  const blankAcc = {
    id: 'acc_blank',
    alias: 'Blank',
    dir: '/tmp/blank',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {},
  }
  assert.equal(accountHasArgon(blankAcc), false)
})

test('ModelCatalog caches per-account catalogs when accountId is provided', async () => {
  const accountOutputs: Record<string, string> = {
    acc_free: 'gemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-4-6\tClaude Sonnet 4.6',
    acc_pro: 'gemini-3.8-flash\tGemini 3.8 Flash\ngemini-4-argon\tGemini 4 Argon\nclaude-sonnet-4-6\tClaude Sonnet 4.6',
  }

  const catalog = new ModelCatalog(
    async (_signal, accountId) => {
      const out = accountId ? accountOutputs[accountId] : undefined
      if (out) return { stdout: out, stderr: '' }
      return { stdout: accountOutputs.acc_free!, stderr: '' }
    },
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )

  // Initial state is fallback
  assert.equal(catalog.get('acc_free').source, 'fallback')

  // Force refresh for free account
  await catalog.forceRefresh('acc_free')
  const freeCat = catalog.get('acc_free')
  assert.equal(freeCat.source, 'discovered')
  const freeIds = freeCat.models.map((m) => m.id)
  assert.ok(freeIds.includes('gemini-3.8-flash'))
  assert.ok(!freeIds.includes('gemini-4-argon'), 'free account has no argon')

  // Force refresh for pro account
  await catalog.forceRefresh('acc_pro')
  const proCat = catalog.get('acc_pro')
  assert.equal(proCat.source, 'discovered')
  const proIds = proCat.models.map((m) => m.id)
  assert.ok(proIds.includes('gemini-3.8-flash'))
  assert.ok(proIds.includes('gemini-4-argon'), 'pro account has argon')

  // Verifying isolation: freeCat still does not have argon
  assert.ok(!catalog.get('acc_free').models.some((m) => m.id === 'gemini-4-argon'))
})

test('REGRESSION: refreshIfNeeded(accountId) does not skip an un-cached account because global current is fresh', async () => {
  let probedAccount: string | undefined
  const catalog = new ModelCatalog(
    async (_signal, accountId) => {
      probedAccount = accountId
      return { stdout: 'gemini-3.8-flash\tGemini 3.8 Flash', stderr: '' }
    },
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )

  // 1. Initial boot refresh without accountId establishes this.current as discovered
  await catalog.forceRefresh()
  assert.equal(catalog.get().source, 'discovered')

  // 2. An account 'acc_free' has never been probed.
  // In the old buggy code, refreshIfNeeded('acc_free') saw that this.get('acc_free')
  // returned this.current whose age < ttlMs, so it returned early without probing!
  probedAccount = undefined
  await catalog.refreshIfNeeded('acc_free')
  assert.equal(probedAccount, 'acc_free', 'refreshIfNeeded must probe the un-cached account')
  assert.equal(catalog.hasAccountCatalog('acc_free'), true)
})

test('forceRefreshAndNotify re-announces the picker even when the account catalog is unchanged', async () => {
  let updates = 0
  const out = 'gemini-3.8-flash\tGemini 3.8 Flash\ngemini-4-argon\tGemini 4 Argon'
  const catalog = new ModelCatalog(
    async () => ({ stdout: out, stderr: '' }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
    () => { updates += 1 },
  )

  // First switch: fallback -> discovered (changed), so refresh() also notifies.
  await catalog.forceRefreshAndNotify('acc_pro')
  assert.equal(updates, 1)
  assert.ok(catalog.get('acc_pro').models.some((m) => m.id === 'gemini-4-argon'))

  // Second switch back to the same account with identical output: refresh()
  // alone would stay silent (contents unchanged), but switching the active
  // account must still re-announce so the composer re-reads the model list.
  await catalog.forceRefreshAndNotify('acc_pro')
  assert.equal(updates, 2, 'account switch must always emit llm/adapters-updated')

  // A plain forceRefresh with unchanged contents must NOT notify (documents the
  // difference the fix relies on).
  const before = updates
  await catalog.forceRefresh('acc_pro')
  assert.equal(updates, before)
})


