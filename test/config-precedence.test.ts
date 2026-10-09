import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/common/config.ts'

for (const permissionMode of ['plan', 'accept-edits', 'skip'] as const) {
  test(`runtime selection ${permissionMode} overrides a configured entry mode`, () => {
    const entry = { permissionMode: permissionMode === 'plan' ? 'accept-edits' : 'plan' }
    assert.equal(resolveConfig(entry, {}, { permissionMode }).permissionMode, permissionMode)
    assert.equal(resolveConfig(entry, { DSH_AGY_MODE: 'plan' }, { permissionMode }).permissionMode, 'plan')
  })
}
test('runtime configurable fields override entries; entries supply missing fields', () => {
  const cfg = resolveConfig({ defaultModel: 'entry-model', defaultEffort: 'low', askTool: true }, {}, { defaultModel: 'chosen-model', askTool: false })
  assert.equal(cfg.defaultModel, 'chosen-model')
  assert.equal(cfg.defaultEffort, 'low')
  assert.equal(cfg.askTool, false)
})

test('hiddenModels accepts string arrays, drops junk, and env wins as a comma list', () => {
  // Overrides layer: array of ids; blank, duplicate and non-string entries are dropped.
  const fromOverrides = resolveConfig({}, {}, { hiddenModels: ['gemini-3.7-flash', '  ', 'gemini-3.7-flash', 42, 'claude-sonnet-4-6'] })
  assert.deepEqual(fromOverrides.hiddenModels, ['gemini-3.7-flash', 'claude-sonnet-4-6'])
  // Non-array values fall through to the default deny-list (empty = show all).
  assert.deepEqual(resolveConfig({ hiddenModels: 'gemini-3.7-flash' }, {}, {}).hiddenModels, [])
  // Entry config supplies the list when no override exists.
  assert.deepEqual(resolveConfig({ hiddenModels: ['entry-model'] }, {}, {}).hiddenModels, ['entry-model'])
  // Env wins last, comma-separated.
  const fromEnv = resolveConfig({ hiddenModels: ['entry-model'] }, { DSH_AGY_HIDDEN_MODELS: ' env-model , second, ,' }, {})
  assert.deepEqual(fromEnv.hiddenModels, ['env-model', 'second'])
})
