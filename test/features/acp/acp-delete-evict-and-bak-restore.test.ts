// Regression coverage for force-evicting ACP processes on account deletion
// and restoring missing/corrupted isolated account tokens from .bak before spawn.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import { defaultConfig } from '../../../src/common/types.ts'
import { saveCredentialBackup } from '../../../src/domain/credentials/backup.ts'
import { accountTokenFilePath } from '../../../src/domain/credentials/docs.ts'
import { AcpProcess, AcpSessionPool, runAcpAttempt } from '../../../src/features/acp/index.ts'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import { createAttemptRecorder, type AttemptDeps, type AttemptInput, type AttemptSlot } from '../../../src/provider/attempt.ts'
import { startAttemptProcess } from '../../../src/provider/attempt-spawn.ts'

function tokenDoc(refreshToken: string): string {
  return JSON.stringify({
    token: {
      access_token: 'ya29.test-access',
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    },
    auth_method: 'consumer',
  })
}

function makeStubProc(openSid?: string): AcpProcess & { closedForce: number; closedGraceful: number } {
  const ee = new EventEmitter() as unknown as AcpProcess & { closedForce: number; closedGraceful: number }
  let alive = true
  ee.closedForce = 0
  ee.closedGraceful = 0
  Object.assign(ee, {
    lastUsedAt: Date.now(),
    logFilePath: null,
    supportsImageBlocks: false,
    sessionCount: openSid ? 1 : 0,
    isBusy: false,
    advertisedCommands: [],
    isAlive: () => alive,
    hasActivePrompt: () => false,
    hasOpenSession: (sid: string) => openSid !== undefined && sid === openSid,
    stderrOffset: () => 0,
    readStderrSince: () => '',
    cancelSession: () => {},
    openSession: async () => ({ sessionId: openSid ?? 'sid-1', status: 'created' as const, resumeFailed: false }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    close: () => {
      alive = false
      ee.closedForce += 1
      ee.emit('exit', 0, null)
    },
    closeGracefully: async () => {
      alive = false
      ee.closedGraceful += 1
      ee.emit('exit', 0, null)
    },
  })
  return ee
}

function makeDeps(store: SessionStore, overrides: Partial<AttemptDeps> = {}): AttemptDeps {
  return {
    acquire: async () => () => {},
    runs: new RunRegistry(),
    store,
    clearInFlightPrompt: () => {},
    registerActiveRun: () => {},
    unregisterActiveRun: () => {},
    isSuperseded: () => false,
    noteNetworkFailure: () => 0,
    clearNetworkStreak: () => {},
    dropFailoverBudget: () => {},
    clearRateLimitFailover: () => {},
    sharesSingleEgress: () => false,
    lastAccountSpawnTime: new Map(),
    minSpawnIntervalMs: 0,
    ...overrides,
  }
}

function makeInput(dir: string, overrides: Partial<AttemptInput> = {}): AttemptInput {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as Message]
  return {
    cfg: { ...defaultConfig(), transport: 'acp', permissionMode: 'skip' },
    bin: 'agy',
    permissionMode: 'skip',
    sessionKey: 'sess-bak',
    workspaceRoot: dir,
    isAux: false,
    account: undefined,
    prompt: 'hi',
    model: 'gemini-3.8-flash',
    activeModel: 'gemini-3.8-flash',
    effort: '',
    addDirs: [],
    persistBinding: false,
    binding: undefined,
    messages,
    newlySentImageIds: [],
    sessionAccountKey: 'sess-bak',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
    ...overrides,
  }
}

function makeSlot(): AttemptSlot {
  return {
    releaseOnce: () => {},
    armHandoff: () => ({ onFirstEvent: () => {}, dispose: () => {}, released: () => false, timedOut: () => false }),
  }
}

test('AcpSessionPool.evictAccount(id, true) force-closes live, retained, and draining processes for that account only', () => {
  const procs = new Map<string, ReturnType<typeof makeStubProc>>()
  const acpPool = new AcpSessionPool({
    bin: () => 'agy',
    cfg: () => defaultConfig(),
    createProcess: (opts) => {
      const label = opts.env?.TEST_PROC ?? 'unknown'
      const p = makeStubProc(opts.env?.TEST_SID)
      procs.set(label, p)
      return p
    },
  })
  try {
    // Active retained process for acc-a (will be moved to draining first)
    acpPool.acquireProcess({
      bin: 'agy', cwd: '/tmp', accountId: 'acc-a', mode: 'skip', sandbox: false, agent: '',
      env: { TEST_PROC: 'a-draining', TEST_SID: 'sid-a1' },
    })
    const releaseA1 = acpPool.retainSession('sid-a1', 'dsh-a1')
    // Non-forced evictAccount moves retained process into draining instead of force-closing it.
    assert.equal(acpPool.evictAccount('acc-a'), 1)
    assert.equal(acpPool.status().drainingProcesses, 1)
    assert.equal(procs.get('a-draining')!.closedForce, 0)

    // Spawn a second live retained process for acc-a and one live process for acc-b.
    acpPool.acquireProcess({
      bin: 'agy', cwd: '/tmp', accountId: 'acc-a', mode: 'skip', sandbox: false, agent: '',
      env: { TEST_PROC: 'a-live', TEST_SID: 'sid-a2' },
    })
    const releaseA2 = acpPool.retainSession('sid-a2', 'dsh-a2')
    acpPool.acquireProcess({
      bin: 'agy', cwd: '/tmp', accountId: 'acc-b', mode: 'skip', sandbox: false, agent: '',
      env: { TEST_PROC: 'b-live' },
    })
    assert.equal(acpPool.status().activeProcesses, 2)
    assert.equal(acpPool.status().drainingProcesses, 1)

    // Forced eviction removes BOTH the live retained process AND the already-draining process of acc-a.
    assert.equal(acpPool.evictAccount('acc-a', true), 2)
    assert.equal(procs.get('a-draining')!.closedForce, 1)
    assert.equal(procs.get('a-live')!.closedForce, 1)
    assert.equal(procs.get('b-live')!.closedForce, 0)
    assert.equal(acpPool.status().activeProcesses, 1)
    assert.equal(acpPool.status().drainingProcesses, 0)
    assert.deepEqual(acpPool.status().keys, ['acc-b|skip|0||'])

    releaseA1()
    releaseA2()
  } finally {
    acpPool.dispose()
  }
})

test('AccountPoolManager.deleteAccount notifies onAccountRemoved for both active and non-active accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-del-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc1 = pool.createAccountSlot('Backup One')
    const acc2 = pool.createAccountSlot('Backup Two')
    const removed: string[] = []
    pool.onAccountRemoved = (id) => removed.push(id)

    assert.equal(pool.deleteAccount('does-not-exist'), false)
    assert.deepEqual(removed, [])

    // Delete a non-active secondary account: must still notify onAccountRemoved.
    assert.equal(pool.deleteAccount(acc2.id), true)
    assert.deepEqual(removed, [acc2.id])

    // Delete another account: must notify again.
    assert.equal(pool.deleteAccount(acc1.id), true)
    assert.deepEqual(removed, [acc2.id, acc1.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runAcpAttempt restores missing isolated account token from .bak before spawning ACP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-bak-'))
  try {
    const accDir = join(dir, 'acc-iso')
    const tokenDir = join(accDir, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    const account: ManagedAccount = {
      id: 'acc-iso',
      alias: 'Isolated',
      dir: accDir,
      enabled: true,
      createdAt: 1,
      cooldowns: {},
      quotas: {},
    }
    const tokenFile = accountTokenFilePath(account, accDir)
    const valid = tokenDoc('rt-acp-bak')
    writeFileSync(tokenFile, valid, 'utf8')
    assert.equal(saveCredentialBackup(tokenFile, valid), true)
    unlinkSync(tokenFile)
    assert.equal(existsSync(tokenFile), false)

    let tokenPresentAtAcquire = false
    const acpPool = new AcpSessionPool({
      bin: () => 'agy',
      cfg: () => defaultConfig(),
      createProcess: () => {
        tokenPresentAtAcquire = existsSync(tokenFile) && readFileSync(tokenFile, 'utf8') === valid
        const p = makeStubProc('sid-bak')
        p.prompt = async (opts: { onUpdate?: (u: Record<string, unknown>) => void }) => {
          opts.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })
          return { stopReason: 'end_turn' }
        }
        return p
      },
    })
    try {
      const logs: string[] = []
      const store = new SessionStore(join(dir, 'sessions.json'))
      const rec = await runAcpAttempt(
        acpPool,
        makeDeps(store, { log: (m) => logs.push(m) }),
        makeInput(dir, { account }),
        makeSlot(),
      )
      assert.ok(rec !== null)
      assert.equal(tokenPresentAtAcquire, true, 'isolated token file must be restored from .bak before ACP spawn')
      assert.ok(logs.some((m) => m.includes('restored missing or corrupted account credential from backup')))
    } finally {
      acpPool.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startAttemptProcess restores corrupted isolated account token from .bak before spawning CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-bak-'))
  try {
    const accDir = join(dir, 'acc-cli-iso')
    const tokenDir = join(accDir, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    const account: ManagedAccount = {
      id: 'acc-cli-iso',
      alias: 'CLI Isolated',
      dir: accDir,
      enabled: true,
      createdAt: 1,
      cooldowns: {},
      quotas: {},
    }
    const tokenFile = accountTokenFilePath(account, accDir)
    const valid = tokenDoc('rt-cli-bak')
    writeFileSync(tokenFile, valid, 'utf8')
    assert.equal(saveCredentialBackup(tokenFile, valid), true)
    // Corrupt the primary token file while leaving .bak intact.
    writeFileSync(tokenFile, '{corrupted', 'utf8')

    const observedFile = join(dir, 'observed-token.txt')
    const mockBin = join(dir, 'mock-agy-cli.mjs')
    writeFileSync(
      mockBin,
      [
        `import { readFileSync, writeFileSync } from 'node:fs'`,
        `writeFileSync(${JSON.stringify(observedFile)}, readFileSync(${JSON.stringify(tokenFile)}, 'utf8'), 'utf8')`,
        `process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'DONE', response: 'ok', usage: {} } }) + '\\n')`,
      ].join('\n'),
      'utf8',
    )

    const store = new SessionStore(join(dir, 'sessions.json'))
    const logs: string[] = []
    const deps = makeDeps(store, { log: (m) => logs.push(m) })
    const input = makeInput(dir, {
      cfg: { ...defaultConfig(), transport: 'cli', permissionMode: 'skip' },
      bin: mockBin,
      account,
    })
    const recorder = createAttemptRecorder(deps, input.cfg, account, undefined, false)
    const spawned = await startAttemptProcess(
      deps,
      input,
      { args: [], prompt: 'hi', stdinPayload: '' },
      recorder,
      makeSlot(),
    )
    const outcome = await spawned.proc.outcome
    recorder.stop()
    assert.equal(outcome.code, 0)
    assert.equal(readFileSync(observedFile, 'utf8'), valid, 'child CLI process must observe the .bak-restored token')
    assert.ok(logs.some((m) => m.includes('restored missing or corrupted account credential from backup')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
