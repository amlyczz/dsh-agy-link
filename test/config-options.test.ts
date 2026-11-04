import test from 'node:test'
import assert from 'node:assert/strict'

import { geminiCatalogModels, translateModelOptions, translateEffortOptions } from '../src/client/config-options.ts'

test('translation model dropdown: auto first, then the catalog in order, deduped', () => {
  const models = [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
    { id: 'gemini-3.8-flash', name: 'duplicate' },
  ]
  const opts = translateModelOptions('', models, 'Auto (gemini flash)')
  assert.deepEqual(opts, [
    { value: '', label: 'Auto (gemini flash)' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
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

test('translation effort dropdown: auto, the three levels, then an unknown configured level', () => {
  const labels = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' }
  assert.deepEqual(translateEffortOptions('', labels), [
    { value: '', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ])
  // Configured through DSH_AGY_TRANSLATE_EFFORT or an old config file: keep it visible.
  const extra = translateEffortOptions(' XHIGH ', labels)
  assert.equal(extra.length, 5)
  assert.deepEqual(extra[4], { value: 'xhigh', label: 'xhigh' })
  assert.equal(translateEffortOptions('HIGH', labels).length, 4, 'known levels never duplicate')
})

test('translation model dropdown only offers the Gemini family', () => {
  // The card is labelled "Gemini 译文"; offering Claude/GPT there would make the
  // label wrong. A hand-configured id still shows through translateModelOptions.
  const models = [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
    { id: 'gpt-oss-120b', name: 'GPT-OSS' },
  ]
  assert.deepEqual(geminiCatalogModels(models).map((m) => m.id), ['gemini-3.8-flash'])
  const opts = translateModelOptions('', geminiCatalogModels(models), 'Auto')
  assert.equal(opts.some((o) => o.value === 'claude-sonnet-4.6'), false)
})
