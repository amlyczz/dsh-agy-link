import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFallbackCatalog, defaultEffortFor, findEntry, foldEfforts, parseModelsOutput } from '../src/host/models.ts'
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

test('fallback catalog carries the current model line-up incl. 3.7', () => {
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  const ids = cat.map((e) => e.id)
  assert.ok(ids.includes('gemini-3.7-flash'), '3.7 flash present')
  assert.ok(ids.includes('gemini-3.6-flash'))
  assert.ok(ids.includes('claude-opus-4-6-thinking'))
  assert.ok(ids.includes('gpt-oss-120b-medium'))
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
  assert.equal(cat.length, 7)
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
  // pro line-up has no medium; high still wins.
  const pro = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3.1-pro')
  assert.equal(pro && defaultEffortFor(pro, cfg2), 'high')
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

