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

test('every DSH_AGY_* env override is honoured, and junk values never corrupt the config', () => {
  const cfg = resolveConfig({}, {
    DSH_AGY_MODE: 'plan',
    DSH_AGY_SKIP_PERMISSIONS: 'true',
    DSH_AGY_DEFAULT_MODEL: 'gemini-4-hydrogen',
    DSH_AGY_DEFAULT_EFFORT: 'xhigh',
    DSH_AGY_TIMEOUT_MS: '12345',
    DSH_AGY_LONG_TOOL_IDLE_MINUTES: '5',
    DSH_AGY_MAX_TURN_MINUTES: '7',
    DSH_AGY_CONTEXT_WINDOW: '262144',
    DSH_AGY_MAX_TOKENS: '32768',
    DSH_AGY_EXTRA_ARGS: '--foo --bar',
    DSH_AGY_HIDDEN_MODELS: 'a,b',
    DSH_AGY_WORKSPACE_ROOT: '/tmp/ws',
    DSH_AGY_MEDIA_DIR: '/tmp/media',
    DSH_AGY_MEDIA_TTL_MS: '999',
    DSH_AGY_MCP_BRIDGE: 'yes',
    DSH_AGY_MCP_TOOL_ALLOWLIST: 'x,y',
    DSH_AGY_MCP_CONFIG_PATH: '/tmp/mcp.json',
    DSH_AGY_MCP_CONFIG_SCOPE: 'workspace',
    DSH_AGY_RATE_LIMIT_PER_MINUTE: '12',
    DSH_AGY_AUTO_FALLBACK_MODEL: 'on',
    DSH_AGY_LOG_RETENTION_DAYS: '3',
    DSH_AGY_DISABLE_TELEMETRY: 'false',
    DSH_AGY_QUOTA_POLL_INTERVAL_MS: '120000',
    DSH_AGY_QUOTA_VIA_CLI: 'no',
    DSH_AGY_PROXY_URL: 'http://127.0.0.1:1',
    DSH_AGY_SUPPRESS_AUTOUPDATE: 'true',
    DSH_AGY_AUTO_WARMUP: 'true',
    DSH_AGY_WARMUP_MODELS: 'm1,m2',
    DSH_AGY_AUTO_TRANSLATE: 'true',
    DSH_AGY_TRANSLATE_MODEL: 'tm',
    DSH_AGY_TRANSLATE_EFFORT: 'low',
    DSH_AGY_TRANSLATE_LANG: 'English',
    DSH_AGY_SHOW_HEADER_BADGE: 'off',
    DSH_AGY_SHOW_TRANSLATE_ACTION: 'off',
    DSH_AGY_IMAGE_MODEL: 'im',
    DSH_AGY_IMAGE_EFFORT: 'high',
    DSH_AGY_IMAGE_TIMEOUT_MS: '1000',
    DSH_AGY_IMAGE_MAX_BYTES: '2048',
    DSH_AGY_IMAGE_OUTPUT_DIR: '/tmp/img',
    DSH_AGY_IMAGE_RETRIES: '2',
  }, {})
  assert.equal(cfg.permissionMode, 'skip', 'SKIP_PERMISSIONS wins over MODE')
  assert.equal(cfg.defaultModel, 'gemini-4-hydrogen')
  assert.equal(cfg.defaultEffort, 'xhigh')
  assert.equal(cfg.timeoutMs, 12345)
  assert.equal(cfg.contextWindowDefault, 262144)
  assert.equal(cfg.maxTokensDefault, 32768)
  assert.deepEqual(cfg.extraArgs, ['--foo', '--bar'])
  assert.deepEqual(cfg.hiddenModels, ['a', 'b'])
  assert.equal(cfg.mcpBridge, true)
  assert.equal(cfg.mcpConfigScope, 'workspace')
  assert.equal(cfg.rateLimitPerMinute, 12)
  assert.equal(cfg.autoFallbackModel, true)
  assert.equal(cfg.logRetentionDays, 3)
  assert.equal(cfg.disableTelemetry, false)
  assert.equal(cfg.quotaPollIntervalMs, 120000)
  assert.equal(cfg.quotaViaCli, false)
  assert.equal(cfg.suppressAgyAutoUpdate, true)
  assert.equal(cfg.autoWarmup, true)
  assert.deepEqual(cfg.warmupModels, ['m1', 'm2'])
  assert.equal(cfg.autoTranslate, true)
  assert.equal(cfg.translateTargetLanguage, 'English')
  assert.equal(cfg.showHeaderBadge, false)
  assert.equal(cfg.showTranslateAction, false)
  assert.equal(cfg.imageTimeoutMs, 1000)
  assert.equal(cfg.imageMaxBytes, 2048)
  assert.equal(cfg.imageRetries, 2)

  // The rejection branches matter just as much: a typo must leave the default
  // intact instead of writing a zero/NaN into the running config (ADR-13).
  const base = defaultConfig()
  const junk = resolveConfig({}, {
    DSH_AGY_MODE: 'nope',
    DSH_AGY_SKIP_PERMISSIONS: 'nope',
    DSH_AGY_TIMEOUT_MS: 'nope',
    DSH_AGY_LONG_TOOL_IDLE_MINUTES: '-1',
    DSH_AGY_MAX_TURN_MINUTES: '-2',
    DSH_AGY_CONTEXT_WINDOW: '-1',
    DSH_AGY_MAX_TOKENS: '0',
    DSH_AGY_MCP_BRIDGE: 'nope',
    DSH_AGY_MCP_CONFIG_SCOPE: 'nope',
    DSH_AGY_RATE_LIMIT_PER_MINUTE: '-1',
    DSH_AGY_AUTO_FALLBACK_MODEL: 'nope',
    DSH_AGY_LOG_RETENTION_DAYS: '0',
    DSH_AGY_DISABLE_TELEMETRY: 'nope',
    DSH_AGY_QUOTA_POLL_INTERVAL_MS: '1000',
    DSH_AGY_QUOTA_VIA_CLI: 'nope',
    DSH_AGY_SUPPRESS_AUTOUPDATE: 'nope',
    DSH_AGY_AUTO_WARMUP: 'nope',
    DSH_AGY_AUTO_TRANSLATE: 'nope',
    DSH_AGY_SHOW_HEADER_BADGE: 'nope',
    DSH_AGY_SHOW_TRANSLATE_ACTION: 'nope',
    DSH_AGY_IMAGE_TIMEOUT_MS: 'nope',
    DSH_AGY_IMAGE_MAX_BYTES: 'nope',
    DSH_AGY_IMAGE_RETRIES: 'nope',
  }, {})
  assert.equal(junk.timeoutMs, base.timeoutMs)
  assert.equal(junk.contextWindowDefault, base.contextWindowDefault)
  assert.equal(junk.mcpBridge, base.mcpBridge)
  assert.equal(junk.mcpConfigScope, base.mcpConfigScope)
  assert.equal(junk.quotaPollIntervalMs, base.quotaPollIntervalMs)
  assert.equal(junk.showHeaderBadge, true)
  assert.equal(junk.showTranslateAction, true)
  assert.equal(junk.imageTimeoutMs, base.imageTimeoutMs)
})
