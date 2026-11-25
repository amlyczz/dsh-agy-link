import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agyCommandDefinition } from '../../src/host/commands.ts'
import { COMMAND_REGISTRY } from '../../src/host/commands/registry.ts'
import { HELP } from '../../src/host/commands/shared.ts'
import { defaultConfig } from '../../src/common/types.ts'

const baseDeps = {
  cfg: () => defaultConfig(),
  bin: () => null,
  version: () => '0.0.0',
  auth: () => null,
  catalog: () => ({ get: () => ({ source: 'fallback', models: [] }) }),
  store: () => ({ all: () => ({}) }),
}

test('agy auth defaults to primary and selects existing accounts unambiguously', async () => {
  const { AccountPoolManager } = await import('../../src/host/pool.ts')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const pool = new AccountPoolManager(mkdtempSync(join(tmpdir(), 'agy-cmd-auth-')))
  const account = pool.createAccountSlot('Backup Google account 3')
  let selected = ''
  const flow = {
    beginPrimary: async () => { selected = 'primary'; return { ok: true, url: 'https://example.com' } },
    beginAccount: async (id: string) => { selected = id; return { ok: true, url: 'https://example.com' } },
    status: () => ({ phase: 'failed', code: 'identity_mismatch' }),
  }
  const def = agyCommandDefinition({ ...baseDeps, pool: () => pool, poolAuth: () => flow } as never)
  await def.handler({ rawInput: 'auth' } as never)
  assert.equal(selected, 'primary')
  await def.handler({ rawInput: 'auth Backup Google account 3' } as never)
  assert.equal(selected, account.id)
  await def.handler({ rawInput: `auth ${account.id}` } as never)
  assert.equal(selected, account.id)
  assert.match((await def.handler({ rawInput: 'auth missing' } as never)).text ?? '', /not found/)
  assert.match((await def.handler({ rawInput: 'auth-status' } as never)).text ?? '', /identity_mismatch/)
  const listing = await def.handler({ rawInput: 'pool' } as never)
  assert.ok(listing.text?.includes(account.id))
  pool.createAccountSlot('Backup Google account 3')
  assert.match((await def.handler({ rawInput: 'auth Backup Google account 3' } as never)).text ?? '', /Multiple accounts/)
})

// Issue #27: without input.hint, DSH composer drops `/agy <sub>` to plain chat.
test('agy command declares input hint so subcommands are intercepted', () => {
  const def = agyCommandDefinition(baseDeps as never)
  assert.equal(def.name, 'agy')
  assert.ok(def.input, 'CommandDefinition.input must be set')
  assert.match(def.input!.hint, /status/)
  assert.match(def.input!.hint, /workspace/)
  assert.match(def.input!.hint, /enable-account/)
  assert.match(def.input!.hint, /disable-account/)
})

test('agy enable-account and disable-account toggle account state and reflect in pool status', async () => {
  const { AccountPoolManager } = await import('../../src/host/pool.ts')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'agy-cmd-test-'))
  const pool = new AccountPoolManager(dir)
  const sec = pool.createAccountSlot('Secondary')

  const testDeps = {
    ...baseDeps,
    pool: () => pool,
  }
  const def = agyCommandDefinition(testDeps as never)

  // Disable account
  const disRes = await def.handler({ rawInput: `disable-account ${sec.id}` } as never)
  assert.ok(disRes.text?.includes(`Disabled account ${sec.id}`))
  assert.equal(pool.getAccount(sec.id)?.enabled, false)

  // /agy pool shows Disabled status
  const poolRes = await def.handler({ rawInput: 'pool' } as never)
  assert.match(poolRes.text ?? '', /Status: ⏸️ Disabled/)

  // Enable account
  const enRes = await def.handler({ rawInput: `enable-account ${sec.id}` } as never)
  assert.ok(enRes.text?.includes(`Enabled account ${sec.id}`))
  assert.equal(pool.getAccount(sec.id)?.enabled, true)

  const poolRes2 = await def.handler({ rawInput: 'pool' } as never)
  assert.match(poolRes2.text ?? '', /Status: 🟢 Ready/)
})

test('agy goal commands manipulate session goal state', async () => {
  const events: { type: string; data: unknown }[] = [
    {
      type: 'goal/change',
      data: {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: {
          id: 'goal-test-123',
          revision: 1,
          objective: 'Test Objective',
          phase: 'active',
          maxGoalRounds: 256,
        },
        roundsStarted: 3,
        createdAt: 1000,
        updatedAt: 1000,
      },
    },
  ]

  const mockSession = {
    id: 'session-test-abc',
    events,
    append: (type: string, data: unknown) => {
      events.push({ type, data })
      return { type, data }
    },
  }

  const mockInvocation = {
    rawInput: 'goal status',
    agent: {
      id: 'session-test-abc',
      session: mockSession,
    },
  }

  const def = agyCommandDefinition(baseDeps as never)

  // 1. Goal status
  const stRes = await def.handler(mockInvocation as never)
  assert.match(stRes.text ?? '', /DSH Goal Status/)
  assert.match(stRes.text ?? '', /goal-test-123/)
  assert.match(stRes.text ?? '', /Test Objective/)
  assert.match(stRes.text ?? '', /3 \/ 256/)

  // 2. Goal pause
  const pauseRes = await def.handler({ ...mockInvocation, rawInput: 'goal pause' } as never)
  assert.match(pauseRes.text ?? '', /Paused goal `goal-test-123`/)
  assert.equal((events[events.length - 1]!.data as { operation: string }).operation, 'pause')

  // 3. Goal resume
  const resumeRes = await def.handler({ ...mockInvocation, rawInput: 'goal resume' } as never)
  assert.match(resumeRes.text ?? '', /Resumed goal `goal-test-123`/)
  assert.equal((events[events.length - 1]!.data as { operation: string }).operation, 'resume')

  // 4. Goal complete
  const compRes = await def.handler({ ...mockInvocation, rawInput: 'goal complete' } as never)
  assert.match(compRes.text ?? '', /Marked goal `goal-test-123` as complete/)
  assert.equal((events[events.length - 1]!.data as { operation: string }).operation, 'complete')

  // 5. Goal clear
  const clearRes = await def.handler({ ...mockInvocation, rawInput: 'goal clear' } as never)
  assert.match(clearRes.text ?? '', /Cleared goal `goal-test-123`/)
  assert.equal((events[events.length - 1]!.data as { operation: string }).operation, 'clear')

  // 6. Goal status after clear
  const stRes2 = await def.handler({ ...mockInvocation, rawInput: 'goal status' } as never)
  assert.match(stRes2.text ?? '', /No active goal in this session/)
})

test('agy session commands inspect and drop conversation bindings', async () => {
  const storeData: Record<string, { conversationId: string; lastMessageCount: number; updatedAt: number; model?: string }> = {
    'session-xyz': {
      conversationId: 'agy-conv-999',
      lastMessageCount: 12,
      updatedAt: Date.now(),
      model: 'gemini-3.8-flash',
    },
  }

  const testDeps = {
    ...baseDeps,
    store: () => ({
      all: () => storeData,
      delete: (k: string) => {
        delete storeData[k]
      },
    }),
  }

  const mockSession = {
    id: 'session-xyz',
    header: { cwd: '/workspace/demo' },
    events: [1, 2, 3],
  }

  const mockInvocation = {
    rawInput: 'session info',
    agent: {
      id: 'session-xyz',
      session: mockSession,
    },
  }

  const def = agyCommandDefinition(testDeps as never)

  // 1. Session info
  const infoRes = await def.handler(mockInvocation as never)
  assert.match(infoRes.text ?? '', /DSH Session & agy Bridge Info/)
  assert.match(infoRes.text ?? '', /session-xyz/)
  assert.match(infoRes.text ?? '', /\/workspace\/demo/)
  assert.match(infoRes.text ?? '', /agy-conv-999/)
  assert.match(infoRes.text ?? '', /Total Session Events\*\*:\s*3/)

  // 2. Session clear
  const clearRes = await def.handler({ ...mockInvocation, rawInput: 'session clear' } as never)
  assert.match(clearRes.text ?? '', /Dropped 1 agy conversation binding\(s\) for session `session-xyz`/)
  assert.equal(storeData['session-xyz'], undefined)
})

test('agy import subcommand parses token and alias and calls poolAuth.importRefreshToken', async () => {
  let importedToken = ''
  let importedAlias: string | undefined
  const flow = {
    importRefreshToken: async (token: string, alias?: string) => {
      importedToken = token
      importedAlias = alias
      return { ok: true, isNew: true, email: 'cli@example.com', account: { alias: alias || 'cli@example.com' } }
    },
  }
  const def = agyCommandDefinition({
    ...baseDeps,
    store: () => ({ clear: () => {} }),
    poolAuth: () => flow,
  } as never)

  // Empty input returns usage
  const emptyRes = await def.handler({ rawInput: 'import' } as never)
  assert.match(emptyRes.text ?? '', /用法|Usage/)

  // Raw token + alias
  const res = await def.handler({ rawInput: 'import 1//my-token My CLI Account' } as never)
  assert.equal(importedToken, '1//my-token')
  assert.equal(importedAlias, 'My CLI Account')
  assert.match(res.text ?? '', /成功导入凭据/)

  // JSON token input
  const jsonToken = '{"token":{"refresh_token":"1//json-tok"}}'
  const jsonRes = await def.handler({ rawInput: `import ${jsonToken} JSON Account` } as never)
  assert.equal(importedToken, jsonToken)
  assert.equal(importedAlias, 'JSON Account')
  assert.match(jsonRes.text ?? '', /成功导入凭据/)
})

test('agy config, status, models, use, refresh-quota and non-destructive auth-code commands work end-to-end', async () => {
  const { AccountPoolManager } = await import('../../src/host/pool.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'agy-cmd-full-'))
  try {
    const pool = new AccountPoolManager(dir)
    const sec = pool.createAccountSlot('Backup')
    pool.clearAuthRequired(sec.id, true)
    const overrides: Record<string, unknown> = {}
    let pickerNotified = 0
    let refreshForced: boolean | undefined = undefined
    let storeCleared = false

    const cfg = defaultConfig()
    const def = agyCommandDefinition({
      ...baseDeps,
      cfg: () => ({ ...cfg, ...overrides }),
      setOverride: (k: string, v: unknown) => { overrides[k] = v },
      notifyPicker: () => { pickerNotified++ },
      bin: () => '/usr/local/bin/agy',
      version: () => '1.5.12',
      auth: () => ({ resolvedStatus: async () => ({ phase: 'ok', message: 'signed in' }) }),
      catalog: () => ({
        get: () => ({ source: 'discovered', models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'high'] }] }),
        forceRefresh: async () => ({ source: 'discovered', models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'high'] }] }),
      }),
      store: () => ({
        all: () => ({ 's1:acc_primary': { conversationId: 'c1' } }),
        clear: () => { storeCleared = true },
      }),
      lastRun: () => ({
        processOk: true,
        processCode: 'OK',
        model: 'gemini-4-argon',
        durationMs: 1200,
        toolErrors: [],
        tokenSpeed: { measuredSteps: 1, outputTokens: 120, avgTps: 42.5, lastTps: 45 },
      }),
      pool: () => pool,
      quota: () => ({
        refreshAllQuotas: async (force?: boolean) => { refreshForced = force },
      }),
      poolAuth: () => ({
        submitCode: async () => ({ ok: true }),
      }),
    } as never)

    assert.match((await def.handler({ rawInput: 'mode plan' } as never)).text ?? '', /\*\*plan\*\*/)
    assert.equal(overrides.permissionMode, 'plan')
    assert.match((await def.handler({ rawInput: 'mode bogus' } as never)).text ?? '', /usage:/)

    assert.match((await def.handler({ rawInput: 'effort xhigh' } as never)).text ?? '', /\*\*xhigh\*\*/)
    assert.equal(overrides.defaultEffort, 'xhigh')
    assert.ok(pickerNotified >= 1)

    assert.match((await def.handler({ rawInput: 'dispatch' } as never)).text ?? '', /dispatch guards/)
    assert.match((await def.handler({ rawInput: 'dispatch 10' } as never)).text ?? '', /10 分钟/)
    assert.equal(overrides.dispatchTimeoutMinutes, 10)
    assert.match((await def.handler({ rawInput: 'dispatch off' } as never)).text ?? '', /无限等待/)
    assert.equal(overrides.dispatchTimeoutMinutes, 0)

    assert.match((await def.handler({ rawInput: 'dispatch-retries 3' } as never)).text ?? '', /3/)
    assert.equal(overrides.dispatchRetries, 3)

    assert.match((await def.handler({ rawInput: 'parallel off' } as never)).text ?? '', /关闭/)
    assert.equal(overrides.parallelSameAccount, false)

    assert.match((await def.handler({ rawInput: 'max-concurrent 4' } as never)).text ?? '', /4/)
    assert.equal(overrides.maxConcurrent, 4)

    assert.match((await def.handler({ rawInput: 'workspace /tmp/ws-test' } as never)).text ?? '', /\/tmp\/ws-test/)
    assert.equal(overrides.workspaceRoot, '/tmp/ws-test')
    assert.match((await def.handler({ rawInput: 'workspace clear' } as never)).text ?? '', /reset/)
    assert.equal(overrides.workspaceRoot, '')

    const statusOut = await def.handler({ rawInput: 'status' } as never)
    assert.match(statusOut.text ?? '', /1\.5\.12/)
    assert.match(statusOut.text ?? '', /42\.5 tok\/s/)

    const modelsOut = await def.handler({ rawInput: 'models' } as never)
    assert.match(modelsOut.text ?? '', /gemini-4-argon/)

    const useOut = await def.handler({ rawInput: `use ${sec.id}` } as never)
    assert.match(useOut.text ?? '', new RegExp(sec.id))

    await def.handler({ rawInput: 'refresh-quota' } as never)
    assert.equal(refreshForced, true, '/agy refresh-quota should pass force=true')

    const authCodeOut = await def.handler({ rawInput: 'auth-code 4/code123' } as never)
    assert.match(authCodeOut.text ?? '', /Logged in/)
    assert.equal(storeCleared, false, 'auth-code must NOT wipe unrelated multi-account session bindings')

    assert.match((await def.handler({ rawInput: 'add-account BackupNew' } as never)).text ?? '', /BackupNew/)
    assert.match((await def.handler({ rawInput: `clear-cooldown ${sec.id}` } as never)).text ?? '', /Cleared cooldown/)
    assert.match((await def.handler({ rawInput: `remove-account ${sec.id}` } as never)).text ?? '', /Removed account/)
    assert.match((await def.handler({ rawInput: 'remove-account' } as never)).text ?? '', /usage:/)
    assert.match((await def.handler({ rawInput: 'enable-account' } as never)).text ?? '', /usage:/)
    assert.match((await def.handler({ rawInput: 'use' } as never)).text ?? '', /usage:/)
    assert.match((await def.handler({ rawInput: 'use missing_id' } as never)).text ?? '', /not found/)
    assert.match((await def.handler({ rawInput: 'dispatch 0' } as never)).text ?? '', /无限等待/)
    assert.match((await def.handler({ rawInput: 'dispatch 999' } as never)).text ?? '', /999 分钟/)
    assert.match((await def.handler({ rawInput: 'parallel on' } as never)).text ?? '', /开启/)
    assert.match((await def.handler({ rawInput: 'max-concurrent off' } as never)).text ?? '', /不限制/)
    assert.match((await def.handler({ rawInput: 'auth-code' } as never)).text ?? '', /usage:/)

    // Exercise status guidance branches (missing_file / system_protection / approval)
    const defErr = agyCommandDefinition({
      ...baseDeps,
      cfg: () => ({ ...cfg, permissionMode: 'plan' }),
      lastRun: () => ({
        processOk: false,
        processCode: 'TOOL_ERROR',
        model: 'gemini-4-argon',
        durationMs: 900,
        toolErrors: ['ENOENT: no such file', 'blocked by system protection', 'requires permission approval'],
      }),
    } as never)
    assert.match((await defErr.handler({ rawInput: 'auth-status' } as never)).text ?? '', /not available/)
    assert.match((await defErr.handler({ rawInput: 'refresh-quota' } as never)).text ?? '', /not available/)
    const statusErrOut = await defErr.handler({ rawInput: 'status' } as never)
    assert.match(statusErrOut.text ?? '', /last run tool errors/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agy goal delegates to GoalService (1:1 semantics, 0-redundancy & idempotent) and config handles mode/effort/workspace spaces', async () => {
  let goalState: {
    id: string; revision: number; objective: string; phase: string;
    activation: string; maxGoalRounds?: number; createdAt: number; updatedAt: number;
  } | null = null
  const ops: string[] = []
  const fakeGoals = {
    get: () => (goalState ? { ...goalState, roundsStarted: 1 } : undefined),
    create: (_a: unknown, req: { objective: string; maxGoalRounds?: number }) => {
      ops.push('set:' + req.objective)
      goalState = { id: 'g-1', revision: 1, objective: req.objective, phase: 'active', activation: 'armed', maxGoalRounds: req.maxGoalRounds ?? 256, createdAt: 100, updatedAt: 100 }
      return goalState
    },
    edit: (_a: unknown, _ref: { id: string; revision: number }, req: { objective: string }) => {
      ops.push('edit:' + req.objective)
      if (goalState) goalState = { ...goalState, revision: goalState.revision + 1, objective: req.objective }
      return goalState!
    },
    pause: () => {
      ops.push('pause')
      if (goalState) {
        goalState = { ...goalState, revision: goalState.revision + 1, phase: 'paused', activation: 'disarmed' }
      }
      return goalState!
    },
    resume: () => {
      ops.push('resume')
      if (goalState) {
        goalState = { ...goalState, revision: goalState.revision + 1, phase: 'active', activation: 'armed' }
      }
      return goalState!
    },
    complete: () => {
      ops.push('complete')
      if (goalState) {
        goalState = { ...goalState, revision: goalState.revision + 1, phase: 'complete', activation: 'disarmed' }
      }
      return goalState!
    },
    clear: () => {
      ops.push('clear')
      goalState = null
      return undefined
    },
  }
  const overrides: Record<string, unknown> = {}
  const def = agyCommandDefinition({
    ...baseDeps,
    setOverride: (k: string, v: unknown) => { overrides[k] = v },
    goals: () => fakeGoals,
    agents: () => ({ get: () => ({ id: 'sess-1' }) }),
  } as never)
  const inv = { agent: { id: 'sess-1' } }

  // Clear when empty is idempotent no-op
  assert.match((await def.handler({ rawInput: 'goal clear', ...inv } as never)).text ?? '', /No active goal/)
  assert.deepEqual(ops, [])

  // Set + idempotent resume + edit + pause (twice -> second is no-op)
  assert.match((await def.handler({ rawInput: 'goal set Ship feature X', ...inv } as never)).text ?? '', /Ship feature X/)
  assert.match((await def.handler({ rawInput: 'goal resume', ...inv } as never)).text ?? '', /already active (?:and|&) armed/)
  assert.match((await def.handler({ rawInput: 'goal edit Ship feature Y', ...inv } as never)).text ?? '', /Ship feature Y/)
  assert.match((await def.handler({ rawInput: 'goal pause', ...inv } as never)).text ?? '', /Paused goal/)
  assert.match((await def.handler({ rawInput: 'goal pause', ...inv } as never)).text ?? '', /already paused/)
  assert.match((await def.handler({ rawInput: 'goal resume', ...inv } as never)).text ?? '', /Resumed goal/)
  assert.match((await def.handler({ rawInput: 'goal complete', ...inv } as never)).text ?? '', /Marked goal .* complete/)
  assert.match((await def.handler({ rawInput: 'goal complete', ...inv } as never)).text ?? '', /already complete/)
  assert.match((await def.handler({ rawInput: 'goal clear', ...inv } as never)).text ?? '', /Cleared goal/)
  assert.match((await def.handler({ rawInput: 'goal clear', ...inv } as never)).text ?? '', /No active goal/)
  assert.deepEqual(ops, [
    'set:Ship feature X',
    'edit:Ship feature Y',
    'pause',
    'resume',
    'complete',
    'clear',
  ], 'redundant state transitions must be idempotent no-ops')

  // Config helpers: bare mode/effort and workspace path containing spaces
  assert.match((await def.handler({ rawInput: 'mode' } as never)).text ?? '', /Current permission mode/)
  assert.match((await def.handler({ rawInput: 'effort' } as never)).text ?? '', /Current default effort/)
  assert.match((await def.handler({ rawInput: 'effort invalid_tier' } as never)).text ?? '', /usage:/)
  // The intent is "a workspace path containing spaces survives intact", not
  // "a Windows path is absolute everywhere": the validator uses node:path's
  // platform-aware isAbsolute(), so `C:\\...` is only absolute on Windows. Pin
  // the intent with a path that is absolute on the host running the tests.
  const spacedWorkspace = process.platform === 'win32' ? 'C:\\My Projects\\dsh agy' : '/tmp/My Projects/dsh agy'
  const spacedReply = (await def.handler({ rawInput: 'workspace ' + spacedWorkspace } as never)).text ?? ''
  assert.ok(spacedReply.includes(spacedWorkspace), 'the spaced path must be echoed back intact: ' + spacedReply)
  assert.equal(overrides.workspaceRoot, spacedWorkspace)
})

test('commands normalize case, handle multi-word aliases, pick newest session binding, idempotent fallback goal resume, notifyPicker on models, and preserve help/hint parity', async (t) => {
  const { AccountPoolManager } = await import('../../src/host/pool.ts')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'agy-cmd-audit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const cfg = defaultConfig()
  const overrides: Record<string, unknown> = {}
  const pool = new AccountPoolManager(dir)
  const mwAcc = pool.createAccountSlot('Work Team Alpha')
  pool.recordFailure(mwAcc.id, 'google', '429')
  let authCodeSeen = ''
  let pickerCount = 0

  const absQuoteWs = process.platform === 'win32' ? 'C:\\Quoted Ws\\proj' : '/tmp/Quoted Ws/proj'
  const def = agyCommandDefinition({
    cfg: () => cfg,
    bin: () => 'agy',
    version: () => '1.5.12',
    auth: () => null,
    catalog: () => ({
      get: () => ({ source: 'fallback', models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] }),
      forceRefresh: async () => ({ source: 'discovered', models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }] }),
    }),
    store: () => ({
      all: () => ({
        'sess-1:older': { conversationId: 'conv-old', model: 'm-old', lastMessageCount: 2, updatedAt: 100 },
        'sess-1:newer': { conversationId: 'conv-new', model: 'm-new', lastMessageCount: 9, updatedAt: 200 },
      }),
      cleanupStaleAccounts: () => {},
    }),
    pool: () => pool,
    poolAuth: () => ({
      beginPrimary: async () => ({ ok: true }),
      beginAccount: async () => ({ ok: true }),
      submitCode: async (code: string) => { authCodeSeen = code; return { ok: true } },
      status: () => ({ phase: 'idle' }),
    }),
    lastRun: () => null,
    runDoctor: async () => '',
    acpStatus: () => ({ activeProcesses: 0, sessions: 0, keys: [] }),
    notifyPicker: () => { pickerCount++ },
    setOverride: (k: string, v: unknown) => {
      overrides[k] = v
      ;(cfg as unknown as Record<string, unknown>)[k] = v
    },
  } as never)

  // Case-insensitive commands/args & quoted workspace
  assert.match((await def.handler({ rawInput: 'STATUS' } as never)).text ?? '', /1\.5\.12/)
  assert.equal((await def.handler({ rawInput: 'MODE AUTO' } as never)).kind, 'success')
  assert.equal(overrides.permissionMode, 'auto')
  assert.equal((await def.handler({ rawInput: 'SANDBOX ON' } as never)).kind, 'success')
  assert.equal(overrides.sandbox, true)
  assert.equal((await def.handler({ rawInput: 'AGENT custom-one' } as never)).kind, 'success')
  assert.equal((await def.handler({ rawInput: 'AGENT OFF' } as never)).kind, 'success')
  assert.equal(overrides.agent, '')
  assert.equal((await def.handler({ rawInput: 'SETTINGS CLEAR' } as never)).kind, 'success')
  assert.equal(overrides.agySettings, '')
  assert.match((await def.handler({ rawInput: 'TRANSPORT STATUS' } as never)).text ?? '', /ACP active processes/)
  assert.equal((await def.handler({ rawInput: `WORKSPACE "${absQuoteWs}"` } as never)).kind, 'success')
  assert.equal(overrides.workspaceRoot, absQuoteWs)
  assert.equal((await def.handler({ rawInput: 'WORKSPACE DEFAULT' } as never)).kind, 'success')
  assert.equal(overrides.workspaceRoot, '')

  // Multi-word alias support across pool actions + quoted multi-token auth-code
  assert.match((await def.handler({ rawInput: 'use Work Team Alpha claude' } as never)).text ?? '', new RegExp(mwAcc.id))
  assert.equal(pool.getActiveAccountId('anthropic'), mwAcc.id)
  const badFam = await def.handler({ rawInput: 'use Work Team Alpha badfam' } as never)
  assert.equal(badFam.kind, 'error')
  assert.match(badFam.text ?? '', /Unknown model family "badfam"/)
  assert.match((await def.handler({ rawInput: 'disable-account Work Team Alpha' } as never)).text ?? '', /Disabled/)
  assert.equal(pool.getAccount(mwAcc.id)?.enabled, false)
  assert.match((await def.handler({ rawInput: 'enable-account Work Team Alpha' } as never)).text ?? '', /Enabled/)
  assert.equal(pool.getAccount(mwAcc.id)?.enabled, true)
  assert.match((await def.handler({ rawInput: 'clear-cooldown Work Team Alpha gemini' } as never)).text ?? '', /Cleared cooldown/)
  assert.match((await def.handler({ rawInput: 'auth-code "code part one"' } as never)).text ?? '', /Logged in/)
  assert.equal(authCodeSeen, 'code part one')
  assert.match((await def.handler({ rawInput: 'remove-account Work Team Alpha' } as never)).text ?? '', new RegExp(`Removed account ${mwAcc.id}`))

  // /agy session info picks newest binding by updatedAt and reports binding count
  const sessInfo = await def.handler({ rawInput: 'SESSION INFO', agent: { id: 'sess-1' } } as never)
  assert.match(sessInfo.text ?? '', /conv-new/)
  assert.match(sessInfo.text ?? '', /Account Bindings.*2/)

  // Fallback /agy goal resume idempotency when already active
  let appended = false
  const fbGoalRes = await def.handler({
    rawInput: 'goal resume',
    agent: {
      id: 'sess-goal-fb',
      session: {
        snapshotEvents: () => [
          { type: 'goal/change', data: { kind: 'goal/change', operation: 'create', goal: { id: 'g-fb', revision: 1, objective: 'Ship Y', phase: 'active' } } },
        ],
        append: () => { appended = true },
      },
    },
  } as never)
  assert.equal(fbGoalRes.kind, 'success')
  assert.match(fbGoalRes.text ?? '', /already active/)
  assert.equal(appended, false)

  // /agy models notifies picker
  const prevPicker = pickerCount
  await def.handler({ rawInput: 'models' } as never)
  assert.equal(pickerCount, prevPicker + 1)

  // Completeness parity across COMMAND_REGISTRY, HELP, and input.hint
  const registrySubs = new Set(COMMAND_REGISTRY.flatMap((e) => e.subs))
  for (const sub of registrySubs) {
    assert.ok(HELP.includes(`/agy ${sub}`), `HELP is missing documentation for /agy ${sub}`)
  }
  const hintTokens = def.input!.hint.replace(/^<|>$/g, '').split('|').filter(Boolean)
  for (const token of hintTokens) {
    assert.ok(token === 'help' || registrySubs.has(token), `input.hint token "${token}" missing from COMMAND_REGISTRY`)
  }
})

