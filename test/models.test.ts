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

test('parseModelsOutput reads the two-column text shape', () => {
  const out = parseModelsOutput('gemini-3-6-flash    Gemini 3.6 Flash\nclaude-sonnet-4-6    Claude Sonnet 4.6\n')
  assert.equal(out.length, 2)
  assert.equal(out[1]?.slug, 'claude-sonnet-4-6')
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

test('bare gemini base without siblings gets no efforts', () => {
  const folded = foldEfforts([{ slug: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro' }])
  assert.equal(folded[0]?.efforts, null)
})

test('buildFallbackCatalog carries configurable efforts', () => {
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  assert.equal(cat.length, 3)
  const flash = cat.find((e) => e.id === 'gemini-3-6-flash')
  assert.deepEqual(flash?.efforts, ['low', 'medium', 'high'])
  const claude = cat.find((e) => e.id === 'claude-sonnet-4-6')
  assert.equal(claude?.efforts, null)
})

test('defaultEffortFor prefers config override then first known effort', () => {
  const cfg: PluginConfig = { ...defaultConfig(), defaultEffort: 'high' }
  const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
  const flash = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3-6-flash')
  assert.equal(flash && defaultEffortFor(flash, cfg), 'high')
  const cfg2: PluginConfig = { ...defaultConfig(), defaultEffort: '' }
  assert.equal(flash && defaultEffortFor(flash, cfg2), 'medium')
})

test('effort suffix ids still resolve to their base entry', () => {
  const folded = foldEfforts([
    { slug: 'gemini-3-6-flash', label: 'F' },
    { slug: 'gemini-3-6-flash-high', label: 'FH' },
  ])
  const cat = { source: 'discovered' as const, models: folded, discoveredAt: 0 }
  assert.equal(findEntry(cat, 'gemini-3-6-flash')?.id, 'gemini-3-6-flash')
})
