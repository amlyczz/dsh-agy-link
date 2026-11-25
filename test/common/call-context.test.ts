import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCallContext, effectivePermissionMode } from '../../src/provider/call-context.ts'
import { defaultConfig, type PluginConfig } from '../../src/common/types.ts'
import type { AgyGenerateOptions } from '../../src/common/protocol.ts'

function ctx(over: Partial<AgyGenerateOptions> = {}, cfg: Partial<PluginConfig> = {}, extra: { sessionCwd?: (id: string) => string | undefined } = {}) {
  const warnings: string[] = []
  const options = { provider: 'antigravity', model: 'gemini-3.8-flash', messages: [], ...over } as unknown as AgyGenerateOptions
  const context = resolveCallContext({
    options,
    cfg: { ...defaultConfig(), permissionMode: 'accept-edits', ...cfg },
    bin: '/fake/agy',
    warnOnce: (_k, m) => warnings.push(m),
    cwd: '/proc-cwd',
    ...extra,
  })
  return { context, warnings }
}

test('issue #113: DSH plan mode forces read-only agy permissions', () => {
  // A statically configured `skip` used to hand --dangerously-skip-permissions
  // to agy while DSH was in plan mode, so "planning" could still write files.
  assert.equal(effectivePermissionMode('skip', true, false), 'plan')
  assert.equal(effectivePermissionMode('accept-edits', true, false), 'plan')
  assert.equal(effectivePermissionMode('skip', false, false), 'skip', 'normal turns keep the configured mode')
  assert.equal(effectivePermissionMode('skip', true, true), 'skip', 'aux calls are already read-only; leave their policy alone')
})

test('chat call: not aux, configured permission mode, tools as declared', () => {
  const { context } = ctx()
  assert.equal(context.purpose, 'chat')
  assert.equal(context.isAux, false)
  assert.equal(context.permissionMode, 'accept-edits')
  assert.equal(context.hasToolSupport, true)
})

test('translation: aux + plan + own session payload', () => {
  const { context } = ctx({ purpose: 'translation', agyTranslateSession: { setup: 'persona', text: 'source' } })
  assert.equal(context.isAux, true)
  assert.equal(context.isTranslateSession, true)
  assert.equal(context.translateSession?.setup, 'persona')
  assert.equal(context.permissionMode, 'plan')
})

test('image: aux but keeps the configured mode, and honours a per-call override', () => {
  assert.equal(ctx({ purpose: 'image' }).context.permissionMode, 'accept-edits')
  assert.equal(ctx({ purpose: 'image', agyPermissionMode: 'skip' }).context.permissionMode, 'skip')
  assert.equal(ctx({ purpose: 'image', agyPermissionMode: 'plan' }).context.permissionMode, 'plan')
})

test('title keeps the configured mode; compaction is read-only plan', () => {
  assert.equal(ctx({ purpose: 'session-title' }).context.permissionMode, 'accept-edits')
  assert.equal(ctx({ purpose: 'compaction' }).context.permissionMode, 'plan')
})

test('review policy marks the call aux', () => {
  const { context } = ctx({ system: 'REVIEW_POLICY: return one JSON object' })
  assert.equal(context.isReview, true)
  assert.equal(context.isAux, true)
})

test('auxiliary gate blocks background helpers but not translation/image', () => {
  const cfg = { allowAuxiliary: false }
  assert.throws(() => ctx({ purpose: 'compaction' }, cfg), /allowAuxiliary/)
  assert.doesNotThrow(() => ctx({ purpose: 'translation' }, cfg))
  assert.doesNotThrow(() => ctx({ purpose: 'image' }, cfg))
})

test('tool mode: run_code-only is Code Mode, agy_tool is native, undefined tools supports both', () => {
  const runCode = ctx({ tools: [{ name: 'run_code' }] as never }).context
  assert.equal(runCode.isCodeMode, true)
  assert.equal(runCode.hasToolSupport, true)
  const native = ctx({ tools: [{ name: 'agy_tool' }, { name: 'run_code' }] as never }).context
  assert.equal(native.isCodeMode, false)
  assert.equal(native.hasToolSupport, true)
  assert.equal(ctx().context.hasToolSupport, true)
})

test('workspace precedence: config > session cwd > process cwd (with one warning)', () => {
  assert.equal(ctx({}, { workspaceRoot: '/cfg' }).context.workspaceRoot, '/cfg')
  const fromSession = ctx({ sessionId: 's1' as never }, {}, { sessionCwd: (id) => (id === 's1' ? '/session' : undefined) })
  assert.equal(fromSession.context.workspaceRoot, '/session')
  assert.equal(fromSession.warnings.length, 0)
  const fallback = ctx({ sessionId: 's2' as never })
  assert.equal(fallback.context.workspaceRoot, '/proc-cwd')
  assert.equal(fallback.warnings.length, 1)
})

test('missing binary throws AGY_NOT_INSTALLED before any work', () => {
  assert.throws(() => resolveCallContext({
    options: { provider: 'antigravity', model: 'm', messages: [] } as unknown as AgyGenerateOptions,
    cfg: defaultConfig(),
    bin: null,
    warnOnce: () => {},
  }), /agy binary not found/)
})

test('pure-text aux calls run in a neutral, cacheable dir instead of the project workspace', () => {
  for (const purpose of ['session-title', 'compaction', 'translation'] as const) {
    const { context } = ctx({ purpose, ...(purpose === 'translation' ? { agyTranslateSession: { setup: 'p', text: 't' } } : {}) })
    assert.equal(context.neutralAuxWorkspace, true, purpose + ' must use the neutral dir')
    // Separator-agnostic: the neutral dir is a real path under the plugin state
    // dir, so Windows yields `…\agy-link\aux-cwd` (the old assert baked in `/`).
    const normalized = context.workspaceRoot.replaceAll('\\', '/')
    assert.ok(normalized.endsWith('/agy-link/aux-cwd'), purpose + ' cwd: ' + context.workspaceRoot)
  }
  const chat = ctx()
  assert.equal(chat.context.neutralAuxWorkspace, false)
  assert.equal(chat.context.workspaceRoot, '/proc-cwd')
  const image = ctx({ purpose: 'image' })
  assert.equal(image.context.neutralAuxWorkspace, false, 'image calls still see the workspace')
})

test('an explicit workspaceRoot wins over the neutral aux dir (operator intent)', () => {
  const { context } = ctx({ purpose: 'session-title' }, { workspaceRoot: '/cfg' })
  assert.equal(context.neutralAuxWorkspace, false)
  assert.equal(context.workspaceRoot, '/cfg')
})

test('auxNeutralWorkspace:false restores the old behaviour', () => {
  const { context } = ctx({ purpose: 'session-title' }, { auxNeutralWorkspace: false })
  assert.equal(context.neutralAuxWorkspace, false)
  assert.equal(context.workspaceRoot, '/proc-cwd')
})
