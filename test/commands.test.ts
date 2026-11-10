import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agyCommandDefinition } from '../src/host/commands.ts'
import { defaultConfig } from '../src/common/types.ts'

const baseDeps = {
  cfg: () => defaultConfig(),
  bin: () => null,
  version: () => '0.0.0',
  auth: () => null,
  catalog: () => ({ get: () => ({ source: 'fallback', models: [] }) }),
  store: () => ({ all: () => ({}) }),
}

test('agy auth defaults to primary and selects existing accounts unambiguously', async () => {
  const { AccountPoolManager } = await import('../src/host/pool.ts')
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
  const { AccountPoolManager } = await import('../src/host/pool.ts')
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

