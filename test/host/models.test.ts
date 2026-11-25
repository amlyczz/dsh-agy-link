import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountHasArgon, buildFallbackCatalog, defaultEffortFor, findEntry, foldEfforts, isArgonModel, ModelCatalog, parseModelsOutput, resolveModelSlug } from '../../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS, defaultConfig, type PluginConfig } from '../../src/common/types.ts'
import { listAvailableModels, resolveModelInfo, type ModelResolutionDeps } from '../../src/provider/model-resolution.ts'

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

// Verbatim `agy models` output (agy 1.5.16, macOS, 2026-11-24).
const AGY_1516_MODELS = [
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gemini-pro-orchestrator-argon\tOrchestrator (Argon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n')

test('REGRESSION: the DSH catalog is agy 1.5.16 folded — no effort leaks in as a model', () => {
  const folded = foldEfforts(parseModelsOutput(AGY_1516_MODELS))
  assert.deepEqual(
    folded.map((m) => [m.id, m.efforts]),
    [
      ['gemini-4-neon', ['low', 'medium', 'high', 'xhigh']],
      ['gemini-4-carbon', ['low', 'medium', 'high']],
      ['gemini-4-argon', ['low', 'medium', 'high']],
      ['gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh']],
      ['gemini-pro-orchestrator-neon', null],
      ['gemini-pro-orchestrator', null],
      ['gemini-pro-orchestrator-argon', null],
      ['gemini-3.8-flash', ['low', 'medium', 'high']],
      ['claude-opus-5-5', ['low', 'medium', 'high']],
      ['claude-sonnet-5-5', ['low', 'medium', 'high']],
      ['gpt-oss-120b-medium', null],
    ],
  )
  // The bug itself: `xhigh` must never appear as a standalone model id.
  assert.equal(folded.some((m) => m.id === 'gemini-4-hydrogen-xhigh'), false)
  // Nor may any tiered slug of a folding family survive as its own model
  // (gpt-oss-120b-medium is a real verbatim id, not a tier of gpt-oss-120b).
  assert.equal(folded.some((m) => /^(?:gemini|claude|argon).+-(?:low|medium|high|xhigh|max)$/.test(m.id)), false)
})

test('the offline fallback lineup is the same set the live discovery produces', () => {
  // A fallback that disagrees with discovery is a bug the user only sees when
  // signed out — keep them byte-identical in id and effort set.
  const discovered = foldEfforts(parseModelsOutput(AGY_1516_MODELS)).map((m) => [m.id, m.efforts])
  const fallback = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS).map((m) => [m.id, m.efforts])
  assert.deepEqual(fallback, discovered)
})

test('fallback catalog mirrors agy 1.5.16 exactly — nothing agy does not list', () => {
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  const ids = cat.map((e) => e.id)
  // Ground truth: `agy models` on 1.5.16, in its own order.
  assert.deepEqual(ids, [
    'gemini-4-neon',
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-hydrogen',
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator',
    'gemini-pro-orchestrator-argon',
    'gemini-3.8-flash',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-oss-120b-medium',
  ])
  // Retired upstream: offering them here is exactly how DSH ends
  // up listing models agy's own picker does not have.
  assert.equal(ids.includes('claude-opus-4-6-thinking'), false, 'Claude 4.6 line is retired')
  assert.equal(ids.includes('claude-sonnet-4-6'), false, 'Claude 4.6 line is retired')
  assert.equal(ids.includes('gemini-3.7-flash'), false, 'retired 3.7 flash is gone')

  const byId = (id: string) => cat.find((e) => e.id === id)
  assert.deepEqual(byId('gemini-3.8-flash')?.efforts, ['low', 'medium', 'high'])
  assert.deepEqual(byId('gemini-4-carbon')?.efforts, ['low', 'medium', 'high'])
  assert.deepEqual(byId('gemini-4-argon')?.efforts, ['low', 'medium', 'high'])
  // agy 1.5.7 added `xhigh` to the Hydrogen family (its picker labels it "Extra").
  assert.deepEqual(byId('gemini-4-hydrogen')?.efforts, ['low', 'medium', 'high', 'xhigh'])
  // Orchestrator is a single fixed slug — no --effort.
  assert.equal(byId('gemini-pro-orchestrator')?.efforts, null)
  assert.equal(byId('gemini-pro-orchestrator-argon')?.efforts, null)
  // Verified on agy 1.5.3: a base Claude 5.5 slug accepts --effort, while a
  // tiered slug conflicts with it, so the catalog advertises base + tiers.
  assert.deepEqual(byId('claude-sonnet-5-5')?.efforts, ['low', 'medium', 'high'])
  assert.equal(byId('gpt-oss-120b-medium')?.efforts, null)
})

test('Claude 5.5 effort variants fold into a base entry, like gemini/argon', () => {
  const folded = foldEfforts([
    { slug: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
    { slug: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
    { slug: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
    { slug: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
    { slug: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
    { slug: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  ])
  assert.deepEqual(folded.map((e) => e.id).sort(), ['claude-opus-5-5', 'claude-sonnet-5-5'])
  const sonnet = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'claude-sonnet-5-5')
  assert.deepEqual(sonnet?.efforts, ['low', 'medium', 'high'])
  assert.equal(sonnet?.name, 'Claude Sonnet 5.5')
  // A tiered slug must resolve to the base one: agy rejects the pair with --effort.
  assert.equal(resolveModelSlug('claude-sonnet-5-5-high'), 'claude-sonnet-5-5')
  assert.equal(resolveModelSlug('claude-opus-5-5'), 'claude-opus-5-5')
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
  assert.equal(cat.length, DEFAULT_FALLBACK_MODELS.length)
  const flash38 = cat.find((e) => e.id === 'gemini-3.8-flash')
  assert.deepEqual(flash38?.efforts, ['low', 'medium', 'high'])
  const hydrogen = cat.find((e) => e.id === 'gemini-4-hydrogen')
  assert.deepEqual(hydrogen?.efforts, ['low', 'medium', 'high', 'xhigh'])
  const orchestrator = cat.find((e) => e.id === 'gemini-pro-orchestrator-argon')
  assert.equal(orchestrator?.efforts, null)
  const gpt = cat.find((e) => e.id === 'gpt-oss-120b-medium')
  assert.equal(gpt?.efforts, null)
})

test('defaultEffortFor prefers config override then high first', () => {
  const cfg: PluginConfig = { ...defaultConfig(), defaultEffort: 'low' }
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  const flash = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3.8-flash')
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
  // Bare aliases point at the current generation (agy 1.5.7 serves 5.5 only).
  assert.equal(findEntry(cat, 'claude-opus')?.id, 'claude-opus-5-5')
  assert.equal(findEntry(cat, 'claude-sonnet')?.id, 'claude-sonnet-5-5')
  assert.equal(findEntry(cat, 'gpt-oss-120b')?.id, 'gpt-oss-120b-medium')
  // A retired 4.6 id still RESOLVES (legacy sessions), it just is not listed:
  // resolveModelSlug is pure, so the catalog lookup correctly finds nothing.
  assert.equal(resolveModelSlug('claude-opus-4-6'), 'claude-opus-4-6-thinking')
  assert.equal(findEntry(cat, 'claude-opus-4-6'), undefined)
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
      // Free tier reports an explicit per-model breakdown; that omission of
      // Argon is what makes "no Argon" authoritative.
      google: { remainingFraction: 1, models: [{ modelId: 'gemini-3.8-flash', remainingFraction: 1 }] },
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

  // 4c. REGRESSION (issue #68): a Google AI Ultra account has a google quota
  // group but NO per-model breakdown — the backend folds Argon into the shared
  // Gemini bucket. Missing detail is UNKNOWN, not negative, so the discovered
  // per-account catalog must decide instead of early-returning false.
  const ultraAcc = {
    id: 'acc_ultra',
    alias: 'Ultra',
    dir: '/tmp/ultra',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {
      google: { remainingFraction: 0.96, weeklyFraction: 0.68, description: 'Models within this group: Gemini Flash, Gemini Pro' },
    },
  }
  assert.equal(
    accountHasArgon(ultraAcc, null, discoveredCatalogWithArgon),
    true,
    'Ultra must see Argon via its discovered catalog even without a per-model breakdown',
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

test('getAllKnownModels never treats quota buckets as runnable models and excludes fallbacks once discovered', async () => {
  const accountWithQuotaPollution = {
    id: 'acc_polluted',
    alias: 'Polluted',
    dir: '/tmp/polluted',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 1,
        models: [
          { modelId: 'gemini-2.5-flash-thinking', displayName: 'Gemini 3.5 Flash Lite' },
          { modelId: 'gemini-3.8-flash-tiered', displayName: 'gemini-3.8-flash-tiered' },
          { modelId: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite' },
          { modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
        ],
      },
    },
  }

  const catalog = new ModelCatalog(
    async () => ({ stdout: 'gemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-5-5\tClaude Sonnet 5.5', stderr: '' }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )

  await catalog.forceRefresh('acc_polluted')
  const allKnown = catalog.getAllKnownModels([accountWithQuotaPollution as any])
  const ids = allKnown.map((m) => m.id)

  // Real discovered models from agy models must be present
  assert.ok(ids.includes('gemini-3.8-flash'))
  assert.ok(ids.includes('claude-sonnet-5-5'))

  // Quota buckets MUST NEVER be included in known models
  assert.equal(ids.includes('gemini-2.5-flash-thinking'), false)
  assert.equal(ids.includes('gemini-3.8-flash-tiered'), false)
  assert.equal(ids.includes('gemini-3.5-flash-lite'), false)
  assert.equal(ids.includes('gemini-2.5-pro'), false)

  // Fallbacks MUST NOT pollute the discovered catalog
  assert.equal(ids.includes('claude-sonnet-4-6'), false)
})

test('getModelsForAccount returns exact models for that specific account without cross-pollution', async () => {
  const outputs: Record<string, string> = {
    acc_primary: 'gemini-4-argon\tGemini 4 Argon\ngemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-5-5\tClaude Sonnet 5.5',
    acc_secondary: 'gemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  }

  const catalog = new ModelCatalog(
    async (_signal, id) => ({ stdout: outputs[id ?? 'acc_primary'] ?? '', stderr: '' }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )

  await catalog.forceRefresh('acc_primary')
  await catalog.forceRefresh('acc_secondary')

  const primaryModels = catalog.getModelsForAccount({ id: 'acc_primary', enabled: true } as any)
  const primaryIds = primaryModels.map((m) => m.id)
  assert.ok(primaryIds.includes('gemini-4-argon'))
  assert.ok(primaryIds.includes('claude-sonnet-5-5'))
  assert.equal(primaryIds.includes('claude-sonnet-4-6'), false, 'primary must NOT have Claude 4.6')

  const secondaryModels = catalog.getModelsForAccount({ id: 'acc_secondary', enabled: true } as any)
  const secondaryIds = secondaryModels.map((m) => m.id)
  assert.ok(secondaryIds.includes('gemini-3.8-flash'))
  assert.ok(secondaryIds.includes('claude-sonnet-4-6'))
  assert.equal(secondaryIds.includes('gemini-4-argon'), false, 'secondary must NOT have Argon')
  assert.equal(secondaryIds.includes('claude-sonnet-5-5'), false, 'secondary must NOT have Claude 5.5')
})

// ---------------------------------------------------------------------------
// Issue #107: opt-in pool-wide catalog so model-aware account routing is usable
// from the picker (default stays strict single-account isolation).
// ---------------------------------------------------------------------------

async function poolWideDeps(poolWideCatalog: boolean): Promise<ModelResolutionDeps> {
  const primary = { id: 'acc_primary', alias: 'Primary', dir: '/tmp/primary', enabled: true, createdAt: 0 } as never
  const secondary = { id: 'acc_secondary', alias: 'Secondary', dir: '/tmp/secondary', enabled: true, createdAt: 0 } as never
  const pool = {
    getAccounts: () => [primary, secondary],
    getAccount: (id: string) => (id === 'acc_primary' ? primary : id === 'acc_secondary' ? secondary : undefined),
    getActiveAccountId: () => 'acc_primary',
    getPoolData: () => ({ lastActiveAccountId: 'acc_primary', primaryAccountId: 'acc_primary' }),
  } as never
  const outputs: Record<string, string> = {
    acc_primary: 'gemini-4-argon\tGemini 4 Argon\ngemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-5-5\tClaude Sonnet 5.5',
    acc_secondary: 'gemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  }
  const catalog = new ModelCatalog(
    async (_signal, id) => ({ stdout: outputs[id ?? 'acc_primary'] ?? '', stderr: '' }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )
  await catalog.forceRefresh('acc_primary')
  await catalog.forceRefresh('acc_secondary')
  return {
    catalog,
    pool,
    getConfig: () => ({ ...defaultConfig(), poolWideCatalog } as PluginConfig),
    isEffortUnsupported: () => false,
    warnOnce: () => undefined,
  }
}

test('issue #107: poolWideCatalog exposes the pool-wide union; default stays isolated', async () => {
  const narrow = listAvailableModels(await poolWideDeps(false)).map((m) => m.id)
  assert.ok(narrow.includes('gemini-4-argon'), 'primary owns Argon')
  assert.equal(narrow.includes('claude-sonnet-4-6'), false, 'default hides another account’s models')

  const wide = listAvailableModels(await poolWideDeps(true)).map((m) => m.id)
  assert.ok(wide.includes('gemini-4-argon'))
  assert.ok(wide.includes('claude-sonnet-4-6'), 'union surfaces the other account’s model for model-aware routing')
  assert.ok(wide.includes('claude-sonnet-5-5'))
})

test('issue #131: selectedModels whitelists the picker, and an empty selection shows everything', async () => {
  const base = await poolWideDeps(true)
  const withSelection = (ids: string[]): ModelResolutionDeps => ({
    ...base,
    getConfig: () => ({ ...defaultConfig(), poolWideCatalog: true, selectedModels: ids } as PluginConfig),
  })

  const all = listAvailableModels(withSelection([])).map((m) => m.id)
  assert.ok(all.length > 3, 'an empty whitelist must not restrict the picker')
  assert.deepEqual(listAvailableModels(withSelection(['  '])).map((m) => m.id), all, 'blank ids are ignored, not treated as a match')

  const picked = listAvailableModels(withSelection(['gemini-3.8-flash', ' claude-sonnet-4-6 '])).map((m) => m.id)
  assert.deepEqual(picked.sort(), ['claude-sonnet-4-6', 'gemini-3.8-flash'], 'trimmed ids survive and everything else is dropped')
})

test('issue #131: hiddenModels still wins over selectedModels', async () => {
  const base = await poolWideDeps(true)
  const deps: ModelResolutionDeps = {
    ...base,
    getConfig: () => ({
      ...defaultConfig(),
      poolWideCatalog: true,
      selectedModels: ['gemini-3.8-flash', 'claude-sonnet-5-5'],
      hiddenModels: ['claude-sonnet-5-5'],
    } as PluginConfig),
  }
  assert.deepEqual(listAvailableModels(deps).map((m) => m.id), ['gemini-3.8-flash'], 'the deny-list applies after the allow-list')
})

test('issue #131: a deselected model still resolves for an in-flight session', async () => {
  const base = await poolWideDeps(true)
  const deps: ModelResolutionDeps = {
    ...base,
    getConfig: () => ({ ...defaultConfig(), poolWideCatalog: true, selectedModels: ['gemini-3.8-flash'] } as PluginConfig),
  }
  assert.equal(listAvailableModels(deps).some((m) => m.id === 'claude-sonnet-5-5'), false)
  const resolved = resolveModelInfo(deps, 'claude-sonnet-5-5')
  assert.equal(resolved.id, 'claude-sonnet-5-5', 'the whitelist is a picker filter, not a resolution gate')
})

test('issue #131: a stale effort-variant id still selects its folded base model', async () => {
  const base = await poolWideDeps(true)
  const withSelection = (ids: string[]): ModelResolutionDeps => ({
    ...base,
    getConfig: () => ({ ...defaultConfig(), poolWideCatalog: true, selectedModels: ids } as PluginConfig),
  })

  // The picker lists gemini-3.8-flash as one row. A selection saved while the
  // CLI still advertised `-high`/`-low` as separate slugs must keep selecting
  // that row; an exact-id match would leave the set non-empty, match nothing,
  // and silently hide every model.
  const stale = listAvailableModels(withSelection(['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])).map((m) => m.id)
  assert.deepEqual(stale, ['gemini-3.8-flash'], 'a folded effort variant keeps selecting its base row')

  // A selection that matches nothing must not be confused with the empty
  // "show everything" state - it genuinely selects nothing.
  const orphan = listAvailableModels(withSelection(['gemini-does-not-exist'])).map((m) => m.id)
  assert.deepEqual(orphan, [], 'a selection naming only unknown models shows no models')
})

// ---------------------------------------------------------------------------
// Issue #106: listModels must never close a discovery → adapters-updated →
// listModels loop when discovery fails (signed out / token expired / timeout).
// ---------------------------------------------------------------------------

function loopDeps(discoverThrows = true): {
  deps: ModelResolutionDeps
  reads: () => number
  probes: () => number
  announcements: () => number
  read: () => void
} {
  const account = { id: 'acc1', alias: 'A', dir: '/tmp/acc1', enabled: true, createdAt: 0 } as never
  const pool = {
    getAccounts: () => [account],
    getAccount: (id: string) => (id === 'acc1' ? account : undefined),
    getActiveAccountId: () => 'acc1',
    getPoolData: () => ({ lastActiveAccountId: 'acc1', primaryAccountId: 'acc1' }),
  } as never
  let probes = 0
  let announcements = 0
  let readCount = 0
  let deps!: ModelResolutionDeps
  const catalog = new ModelCatalog(
    async () => {
      probes++
      if (discoverThrows) throw new Error('agy models failed')
      return { stdout: 'gemini-3.8-flash\tGemini 3.8 Flash', stderr: '' }
    },
    DEFAULT_FALLBACK_MODELS,
    300_000,
    () => {
      announcements++
      // DSH's browser re-reads the catalog on `llm/adapters-updated`. Bound it
      // so a broken implementation fails the test instead of hanging.
      if (readCount < 40) read()
    },
  )
  const read = (): void => {
    readCount++
    listAvailableModels(deps)
  }
  deps = {
    catalog,
    pool,
    getConfig: () => defaultConfig(),
    isEffortUnsupported: () => false,
    warnOnce: () => undefined,
  }
  return {
    deps,
    reads: () => readCount,
    probes: () => probes,
    announcements: () => announcements,
    read,
  }
}

test('issue #106: failed account discovery does not self-excite listModels (no probe/announce storm)', async () => {
  const h = loopDeps(true)
  for (let i = 0; i < 20; i++) h.read()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(h.probes(), 1, 'one throttled probe per retry window, not one per read')
  assert.equal(h.announcements(), 0, 'a failed refresh must NEVER emit adapters-updated')
  assert.ok(h.reads() <= 20, 'no feedback loop: reads stay at the 20 we asked for')
})

test('issue #106: repeated reads across settled refreshes stay throttled while discovery fails', async () => {
  const h = loopDeps(true)
  for (let i = 0; i < 5; i++) {
    h.read()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(h.probes(), 1, 'an un-cached account records its attempt too')
  assert.equal(h.announcements(), 0)
})

test('issue #106: a successful first discovery still announces exactly once', async () => {
  const h = loopDeps(false)
  h.read()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.probes(), 1)
  assert.equal(h.announcements(), 1, 'the picker needs one update when the account catalog is built')
  assert.ok(h.reads() <= 2, 'one announcement must not snowball')
})

test('concurrent refreshIfNeeded for different accounts runs per-account instead of dropping the second', async () => {
  const seen: string[] = []
  const catalog = new ModelCatalog(
    async (_signal, accountId) => {
      seen.push(accountId ?? 'default')
      await new Promise((r) => setTimeout(r, 30))
      if (accountId === 'acc_pro') {
        return { stdout: 'gemini-4-argon\tGemini 4 Argon\ngemini-3.8-flash\tGemini 3.8 Flash', stderr: '' }
      }
      return { stdout: 'gemini-3.8-flash\tGemini 3.8 Flash', stderr: '' }
    },
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )

  await Promise.all([
    catalog.refreshIfNeeded('acc_free'),
    catalog.refreshIfNeeded('acc_pro'),
  ])
  assert.equal(catalog.hasAccountCatalog('acc_free'), true)
  assert.equal(catalog.hasAccountCatalog('acc_pro'), true, 'acc_pro refresh must not be dropped behind acc_free')
  assert.ok(catalog.get('acc_pro').models.some((m) => m.id === 'gemini-4-argon'))
})

test('ModelCatalog.refresh detects effort and label changes on identical model ids', async () => {
  let step = 0
  let updates = 0
  const catalog = new ModelCatalog(
    async () => {
      step++
      if (step === 1) {
        return { stdout: 'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)', stderr: '' }
      }
      return {
        stdout: 'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (Extra)',
        stderr: '',
      }
    },
    DEFAULT_FALLBACK_MODELS,
    300_000,
    () => { updates++ },
  )

  await catalog.forceRefresh('acc_1')
  assert.equal(updates, 1)
  await catalog.forceRefresh('acc_1')
  assert.equal(updates, 2, 'adding xhigh effort must announce a catalog update')
})

test('ModelCatalog.refresh rejects unauthenticated fallback stdout when stderr reports signed-out (#122)', async () => {
  let updates = 0
  const catalog = new ModelCatalog(
    async () => ({
      stdout: 'claude-sonnet-4-6\tClaude Sonnet 4.6\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      stderr: 'Warning: not logged in — showing static fallback models. Run agy login.',
    }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
    () => { updates++ },
  )

  await catalog.forceRefresh('acc_signed_out')
  assert.equal(catalog.hasAccountCatalog('acc_signed_out'), false, 'signed-out fallback must never poison discovered cache')
  assert.equal(updates, 0)
})

test('getModelsForAccount surfaces Argon at t=0ms when switching from Free current catalog to Pro account', async () => {
  const catalog = new ModelCatalog(
    async () => ({ stdout: 'gemini-3.8-flash\tGemini 3.8 Flash\nclaude-sonnet-5-5\tClaude Sonnet 5.5', stderr: '' }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )
  // Boot discovered from Free primary account (no Argon in this.current)
  await catalog.forceRefresh()
  assert.equal(catalog.get().models.some((m) => isArgonModel(m.id)), false)

  // User switches to Pro secondary account whose quota already proves Argon access,
  // BEFORE `agy models` finishes for acc_pro:
  const proAcc = {
    id: 'acc_pro_unprobed',
    alias: 'Pro',
    dir: '/tmp/pro',
    enabled: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: { argon: { weeklyFraction: 0.9 } },
  } as any

  const modelsAtT0 = catalog.getModelsForAccount(proAcc, null)
  assert.ok(modelsAtT0.some((m) => isArgonModel(m.id)), 'Argon must appear immediately at t=0ms on switch to Pro account')
})


