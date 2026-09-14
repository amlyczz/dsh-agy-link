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
