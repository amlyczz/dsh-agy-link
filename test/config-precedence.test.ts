import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/common/config.ts'
import { defaultConfig } from '../src/common/types.ts'

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

test('boolean env vars are case-insensitive and accept yes/on/off', () => {
  assert.equal(resolveConfig({}, { DSH_AGY_MCP_BRIDGE: 'TRUE' }, {}).mcpBridge, true)
  assert.equal(resolveConfig({}, { DSH_AGY_MCP_BRIDGE: 'Yes' }, {}).mcpBridge, true)
  assert.equal(resolveConfig({}, { DSH_AGY_MCP_BRIDGE: 'on' }, {}).mcpBridge, true)
  assert.equal(resolveConfig({}, { DSH_AGY_MCP_BRIDGE: 'OFF' }, {}).mcpBridge, false)
  assert.equal(resolveConfig({}, { DSH_AGY_MCP_BRIDGE: 'No' }, {}).mcpBridge, false)
  assert.equal(resolveConfig({}, { DSH_AGY_MCP_BRIDGE: 'garbage' }, {}).mcpBridge, false, 'unknown falls back to base default')
})

test('maxTurnMinutes defaults to 0 (off) and reads the env override (issue #92)', () => {
  assert.equal(defaultConfig().maxTurnMinutes, 0)
  assert.equal(resolveConfig({ maxTurnMinutes: 30 }, {}, {}).maxTurnMinutes, 30)
  assert.equal(resolveConfig({}, { DSH_AGY_MAX_TURN_MINUTES: '45' }, {}).maxTurnMinutes, 45)
  assert.equal(resolveConfig({}, { DSH_AGY_MAX_TURN_MINUTES: '0' }, {}).maxTurnMinutes, 0)
  assert.equal(resolveConfig({}, { DSH_AGY_MAX_TURN_MINUTES: 'nope' }, {}).maxTurnMinutes, 0)
})

test('context window and max tokens are configurable via env (issue #83)', () => {
  const cfg = resolveConfig({}, { DSH_AGY_CONTEXT_WINDOW: '262144', DSH_AGY_MAX_TOKENS: '32768' }, {})
  assert.equal(cfg.contextWindowDefault, 262144)
  assert.equal(cfg.maxTokensDefault, 32768)
  // Invalid values fall back instead of reporting a bogus window.
  const bad = resolveConfig({}, { DSH_AGY_CONTEXT_WINDOW: 'nope', DSH_AGY_MAX_TOKENS: '-1' }, {})
  assert.equal(bad.contextWindowDefault, 1048576)
  assert.equal(bad.maxTokensDefault, 65536)
  // Entry config still wins over the default, env wins over entry (ADR-13).
  assert.equal(resolveConfig({ contextWindowDefault: 200000 }, {}, {}).contextWindowDefault, 200000)
  assert.equal(
    resolveConfig({ contextWindowDefault: 200000 }, { DSH_AGY_CONTEXT_WINDOW: '262144' }, {}).contextWindowDefault,
    262144,
  )
})

test('longToolIdleMinutes is configurable, accepts 0 (disable) and reads the env override', () => {
  assert.equal(resolveConfig({}, {}, {}).longToolIdleMinutes, 240)
  assert.equal(resolveConfig({ longToolIdleMinutes: 30 }, {}, {}).longToolIdleMinutes, 30)
  assert.equal(resolveConfig({}, {}, { longToolIdleMinutes: 0 }).longToolIdleMinutes, 0)
  assert.equal(resolveConfig({}, { DSH_AGY_LONG_TOOL_IDLE_MINUTES: '45' }, {}).longToolIdleMinutes, 45)
  assert.equal(resolveConfig({}, { DSH_AGY_LONG_TOOL_IDLE_MINUTES: '0' }, {}).longToolIdleMinutes, 0)
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

test('showHeaderBadge and showTranslateAction default to true, accept overrides and env (issue #105)', () => {
  assert.equal(defaultConfig().showHeaderBadge, true)
  assert.equal(defaultConfig().showTranslateAction, true)

  const hiddenBoth = resolveConfig({ showHeaderBadge: false, showTranslateAction: false }, {}, {})
  assert.equal(hiddenBoth.showHeaderBadge, false)
  assert.equal(hiddenBoth.showTranslateAction, false)

  const envOverride = resolveConfig({}, { DSH_AGY_SHOW_HEADER_BADGE: 'off', DSH_AGY_SHOW_TRANSLATE_ACTION: 'false' }, {})
  assert.equal(envOverride.showHeaderBadge, false)
  assert.equal(envOverride.showTranslateAction, false)

  const overrideWins = resolveConfig({ showHeaderBadge: false }, {}, { showHeaderBadge: true })
  assert.equal(overrideWins.showHeaderBadge, true)
})

test('issue #105: header badge and translate action are opt-out, visible by default', () => {
  const defaults = defaultConfig()
  assert.equal(defaults.showHeaderBadge, true, 'badge stays visible without an explicit opt-out')
  assert.equal(defaults.showTranslateAction, true, 'translate action stays visible without an explicit opt-out')
  // Runtime overrides (the /config endpoint) and the persisted entry layer both work.
  assert.equal(resolveConfig({}, {}, { showHeaderBadge: false }).showHeaderBadge, false)
  assert.equal(resolveConfig({ showTranslateAction: false }, {}, {}).showTranslateAction, false)
  // Env accepts the same case-insensitive boolean vocabulary as every other switch,
  // and wins last; junk values fall back to the current layer's value.
  assert.equal(resolveConfig({}, { DSH_AGY_SHOW_HEADER_BADGE: 'off' }, {}).showHeaderBadge, false)
  assert.equal(resolveConfig({}, { DSH_AGY_SHOW_TRANSLATE_ACTION: 'No' }, {}).showTranslateAction, false)
  assert.equal(resolveConfig({}, { DSH_AGY_SHOW_HEADER_BADGE: 'garbage' }, {}).showHeaderBadge, true)
  assert.equal(resolveConfig({ showTranslateAction: false }, { DSH_AGY_SHOW_TRANSLATE_ACTION: 'on' }, {}).showTranslateAction, true)
})
