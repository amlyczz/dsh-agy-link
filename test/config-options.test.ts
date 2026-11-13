import test from 'node:test'
import assert from 'node:assert/strict'

import {
  catalogEfforts,
  geminiCatalogModels,
  modelEfforts,
  translateModelOptions,
  translateEffortOptions,
  type EffortLabels,
} from '../src/client/config-options.ts'
import { effortLabel, normalizeEfforts, splitEffortSuffix } from '../src/common/reasoning.ts'

const labels: EffortLabels = { auto: 'Auto', level: (id) => effortLabel(id) }

test('translation model dropdown: auto first, then the catalog in order, deduped', () => {
  const models = [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'gemini-3.8-flash', name: 'duplicate' },
  ]
  const opts = translateModelOptions('', models, 'Auto (gemini flash)')
  assert.deepEqual(opts, [
    { value: '', label: 'Auto (gemini flash)' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ])
})

test('translation model dropdown keeps an unlisted current id selectable', () => {
  // The catalog is advisory: a model configured by hand (or dropped from the
  // plan) must still show up selected instead of silently reading as "auto".
  const opts = translateModelOptions('gemini-9-pro', [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }], 'Auto')
  assert.deepEqual(opts[opts.length - 1], { value: 'gemini-9-pro', label: 'gemini-9-pro' })
  assert.equal(opts.filter((o) => o.value === 'gemini-9-pro').length, 1)
})

test('translation model dropdown tolerates blank catalog entries and blank names', () => {
  const opts = translateModelOptions('', [{ id: '  ', name: 'x' }, { id: 'm1', name: '  ' }], 'Auto')
  assert.deepEqual(opts, [
    { value: '', label: 'Auto' },
    { value: 'm1', label: 'm1' },
  ])
})

test('effort dropdown offers EXACTLY the chosen model efforts, in catalog order', () => {
  // The single source of truth: the model's own effort set. Hydrogen has agy
  // 1.5.7's `xhigh` (rendered "Extra", like agy's own picker); Orchestrator has
  // none at all, so it must not offer levels the CLI would reject.
  const models = [
    { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
  ]
  assert.deepEqual(translateEffortOptions('', labels, 'gemini-4-hydrogen', models), [
    { value: '', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra' },
  ])
  assert.deepEqual(translateEffortOptions('', labels, 'gemini-pro-orchestrator-g1-pro', models), [
    { value: '', label: 'Auto' },
  ])
})

test('effort dropdown falls back to the catalog union when no model is chosen', () => {
  const models = [
    { id: 'gemini-3.8-flash', name: 'Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-hydrogen', name: 'Hydrogen', efforts: ['medium', 'xhigh'] },
  ]
  assert.deepEqual(catalogEfforts(models), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(translateEffortOptions('', labels, '', models).map((o) => o.value), ['', 'low', 'medium', 'high', 'xhigh'])
})

test('effort dropdown keeps an unknown configured level visible without duplicating known ones', () => {
  const models = [{ id: 'gemini-3.8-flash', name: 'Flash', efforts: ['low', 'medium', 'high'] }]
  const extra = translateEffortOptions(' ULTRA ', labels, 'gemini-3.8-flash', models)
  assert.deepEqual(extra[extra.length - 1], { value: 'ultra', label: 'ULTRA'.toLowerCase() })
  assert.equal(translateEffortOptions('HIGH', labels, 'gemini-3.8-flash', models).length, 4, 'known levels never duplicate')
})

test('translation model dropdown only offers the Gemini family', () => {
  // The card is labelled "Gemini 译文"; offering Claude/GPT there would make the
  // label wrong. A hand-configured id still shows through translateModelOptions.
  const models = [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS' },
  ]
  assert.deepEqual(geminiCatalogModels(models).map((m) => m.id), ['gemini-3.8-flash'])
  const opts = translateModelOptions('', geminiCatalogModels(models), 'Auto')
  assert.equal(opts.some((o) => o.value === 'claude-sonnet-5-5'), false)
})

test('modelEfforts ignores malformed effort data', () => {
  assert.deepEqual(modelEfforts(undefined), [])
  assert.deepEqual(modelEfforts({ id: 'm' }), [])
  assert.deepEqual(modelEfforts({ id: 'm', efforts: 'low' }), [])
  assert.deepEqual(modelEfforts({ id: 'm', efforts: [1, ' HIGH ', 'high', ''] }), ['high'])
})

test('splitEffortSuffix prefers the LONGEST suffix so xhigh never folds as high', () => {
  assert.deepEqual(splitEffortSuffix('gemini-4-hydrogen-xhigh'), { base: 'gemini-4-hydrogen', effort: 'xhigh' })
  assert.deepEqual(splitEffortSuffix('gemini-4-hydrogen-high'), { base: 'gemini-4-hydrogen', effort: 'high' })
  assert.deepEqual(splitEffortSuffix('gemini-4-argon-medium'), { base: 'gemini-4-argon', effort: 'medium' })
  assert.deepEqual(splitEffortSuffix('gpt-oss-120b-medium'), { base: 'gpt-oss-120b', effort: 'medium' })
  assert.deepEqual(splitEffortSuffix('gemini-pro-orchestrator-g1-pro'), { base: 'gemini-pro-orchestrator-g1-pro' })
})

test('normalizeEfforts orders canonically and keeps unknown levels last', () => {
  assert.deepEqual(normalizeEfforts(['xhigh', 'low', 'high', 'medium']), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(normalizeEfforts(['ultra', 'low', 'ultra']), ['low', 'ultra'])
  assert.deepEqual(normalizeEfforts(null), [])
  assert.deepEqual(normalizeEfforts(undefined), [])
})
