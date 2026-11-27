// Regression coverage for Windows WSL UNC path credential sync, plain-JSON
// isolated token hygiene, ACP pre-stream auth error propagation, zombie
// process eviction, and single-retry auth self-heal across BOTH primary and
// non-primary isolated accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig } from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import {
  accountTokenFilePath,
  ensureIsolatedDiskTokenClean,
  isWslUncPath,
  normalizeCredentialJsonForDisk,
  syncPrimaryDiskTokenFile,
  writePrimaryCredentialAt,
} from '../../../src/domain/credentials/docs.ts'
import { acquireCredentialSlotAt } from '../../../src/domain/credentials/slot.ts'
import { prepareAccountTokenForSpawn } from '../../../src/host/credential-slot.ts'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { PoolAuthFlow } from '../../../src/host/pool-auth.ts'
import { QuotaService } from '../../../src/host/quota.ts'
import { RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import { persistRefreshedToken, quotaTokenFilePath, type QuotaTokenDeps } from '../../../src/features/quota/token.ts'
import { AcpProcess } from '../../../src/features/acp/client.ts'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'
import { runAcpAttempt } from '../../../src/features/acp/run-attempt.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../../../src/provider/attempt.ts'

function tokenDoc(refreshToken: string, accessToken = 'ya29.access', expiryMs = Date.now() + 3_600_000, email?: string): string {
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(expiryMs).toISOString(),
    },
    auth_method: 'consumer',
    ...(email ? { id_token_email: email } : {}),
  })
}

function makeAccount(overrides: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    alias: overrides.id,
    email: `${overrides.id}@example.com`,
    dir: '',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {},
    ...overrides,
  }
}

function makeSlot(): AttemptSlot {
  return {
    armHandoff: () => ({ onFirstEvent: () => {}, dispose: () => {}, released: () => false, timedOut: () => false }),
    releaseOnce: () => {},
  }
}

function makeAttemptInput(overrides: Partial<AttemptInput> & { workspaceRoot: string }): AttemptInput {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as Message]
  return {
    cfg: { ...defaultConfig(), transport: 'acp', permissionMode: 'skip' },
    bin: 'agy',
    permissionMode: 'skip',
    sessionKey: 'sess-test',
    isAux: false,
    account: undefined,
    prompt: 'hi',
    model: 'gemini-4-neon',
    activeModel: 'gemini-4-neon',
    effort: '',
    addDirs: [],
    persistBinding: false,
    binding: undefined,
    messages,
    newlySentImageIds: [],
    sessionAccountKey: 'sess-test',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
    ...overrides,
  }
}

function wrapGoKeyring(raw: string): string {
  return 'go-keyring-base64:' + Buffer.from(raw, 'utf8').toString('base64')
}

function setPlatform(value: NodeJS.Platform): () => void {
  const prev = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => {
    if (prev) Object.defineProperty(process, 'platform', prev)
  }
}

test('isWslUncPath distinguishes Windows WSL UNC paths from native Windows and POSIX paths', () => {
  assert.equal(isWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\zand\\proj\\gamecraft-pipeline'), true)
  assert.equal(isWslUncPath('//wsl.localhost/Ubuntu/home/zand/proj'), true)
  assert.equal(isWslUncPath('\\\\wsl$\\Ubuntu-22.04\\home\\zand'), true)
  assert.equal(isWslUncPath('D:\\proj\\dsh-agy-link'), false)
  assert.equal(isWslUncPath('/home/zand/proj'), false)
  assert.equal(isWslUncPath('\\\\fileserver\\share\\proj'), false)
  assert.equal(isWslUncPath(undefined), false)
})

test('normalizeCredentialJsonForDisk & syncPrimaryDiskTokenFile overwrite revoked grants and keep fresher tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-wsl-sync-'))
  try {
    const plain = tokenDoc('rt-new-grant', 'acc-fresh', Date.now() + 3_600_000, 'user@example.com')
    const wrapped = wrapGoKeyring(plain)
    assert.equal(normalizeCredentialJsonForDisk(wrapped), plain)
    assert.equal(normalizeCredentialJsonForDisk(JSON.stringify({ token: { access_token: 'only-access' } })), null)
    assert.equal(normalizeCredentialJsonForDisk('not-json'), null)

    const diskFile = join(root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    // 1. Overwrites an old revoked-grant disk file (the exact 2026-11-24 invalid_grant bug)
    mkdirSync(join(root, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(diskFile, tokenDoc('rt-revoked-old', 'acc-old', Date.now() - 86_400_000), 'utf8')
    assert.equal(syncPrimaryDiskTokenFile(wrapped, root), true)
    assert.equal(readFileSync(diskFile, 'utf8'), plain)
    assert.equal(readFileSync(diskFile + '.bak', 'utf8'), plain)

    // 2. Does not downgrade a strictly fresher same-grant token already on disk
    const evenFresher = tokenDoc('rt-new-grant', 'acc-fresher', Date.now() + 7_200_000, 'user@example.com')
    writeFileSync(diskFile, evenFresher, 'utf8')
    assert.equal(syncPrimaryDiskTokenFile(plain, root), true)
    assert.equal(readFileSync(diskFile, 'utf8'), evenFresher)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureIsolatedDiskTokenClean and secondaryLease unwrap go-keyring-base64 and repair from .bak for non-primary accounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-iso-clean-'))
  const baseDir = join(root, 'pool')
  const homeDir = join(root, 'home')
  const accDir = join(root, 'acc-2')
  mkdirSync(baseDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const accFile = join(accDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  mkdirSync(join(accDir, '.gemini', 'antigravity-cli'), { recursive: true })

  try {
    const cleanJson = tokenDoc('rt-acc2', 'acc2-a1', Date.now() + 3_600_000, 'acc2@example.com')
    // Corrupt file with go-keyring-base64: prefix is unwrapped to plain JSON
    writeFileSync(accFile, wrapGoKeyring(cleanJson), 'utf8')
    assert.equal(ensureIsolatedDiskTokenClean(accFile), true)
    assert.equal(readFileSync(accFile, 'utf8'), cleanJson)
    assert.equal(readFileSync(accFile + '.bak', 'utf8'), cleanJson)

    // Missing main file is recovered from .bak
    rmSync(accFile)
    assert.equal(ensureIsolatedDiskTokenClean(accFile), true)
    assert.equal(readFileSync(accFile, 'utf8'), cleanJson)

    // secondaryLease writes unwrapped JSON (not go-keyring-base64:) when capturing slot refresh
    const primaryRaw = tokenDoc('rt-primary', 'prim-a1', Date.now() + 3_600_000, 'prim@example.com')
    writePrimaryCredentialAt({ raw: primaryRaw, email: 'prim@example.com', savedAt: Date.now() }, baseDir)

    let slotValue: string | null = primaryRaw
    const rotatedForAcc2 = tokenDoc('rt-acc2', 'acc2-rotated', Date.now() + 7_200_000, 'acc2@example.com')
    const acc = makeAccount({ id: 'acc_2', alias: 'second', email: 'acc2@example.com', dir: accDir })
    const lease = await acquireCredentialSlotAt(acc, undefined, {
      baseDir,
      homeDir,
      log: () => {},
      platform: {
        platform: 'win32',
        readSlot: () => slotValue,
        writeSlot: (raw) => { slotValue = raw; return true },
        identify: async () => 'acc2@example.com',
      },
    })
    assert.ok(lease)
    // Simulate agy wrapping its refreshed token in go-keyring-base64: in Credential Manager
    slotValue = wrapGoKeyring(rotatedForAcc2)
    lease.release()
    assert.equal(readFileSync(accFile, 'utf8'), rotatedForAcc2, 'isolated file must stay plain JSON, never go-keyring-base64:')
    assert.equal(readFileSync(accFile + '.bak', 'utf8'), rotatedForAcc2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('persistRefreshedToken & prepareAccountTokenForSpawn update stale primary WSL disk file while keeping isolated guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-token-persist-'))
  const home = join(root, 'user-home')
  const poolDir = join(root, 'pool')
  const isoDir = join(root, 'acc-iso')
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  mkdirSync(join(isoDir, '.gemini', 'antigravity-cli'), { recursive: true })
  mkdirSync(poolDir, { recursive: true })

  const origHome = process.env.HOME
  const origUserProfile = process.env.USERPROFILE
  const restorePlatform = setPlatform('win32')
  process.env.HOME = home
  process.env.USERPROFILE = home

  try {
    // 1. Primary disk holds a revoked grant while .primary-credential.json has the new grant
    const stalePrimaryDisk = tokenDoc('rt-revoked-old', 'old-acc', Date.now() - 86_400_000)
    const primaryDiskFile = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    writeFileSync(primaryDiskFile, stalePrimaryDisk, 'utf8')

    const freshPrimaryRaw = tokenDoc('rt-live-primary', 'live-acc', Date.now() + 3_600_000, 'prim@example.com')
    writePrimaryCredentialAt({ raw: freshPrimaryRaw, email: 'prim@example.com', savedAt: Date.now() }, poolDir)

    let adopted: { raw: string } | null = null
    const deps: QuotaTokenDeps = {
      pool: { dir: poolDir, clearAuthRequired: () => {}, markAuthRequired: () => {} },
      proxyFor: () => undefined,
      readSystemKeychainToken: async () => null,
      getStoredToken: async () => null,
      persistRefreshedToken: () => {},
      readPrimaryCredential: () => ({ raw: freshPrimaryRaw, email: 'prim@example.com', savedAt: Date.now() }),
      writePrimaryCredential: (c) => { adopted = c; return true },
      parseCredentialDoc: (raw) => {
        if (!raw) return null
        const p = JSON.parse(raw) as { token?: { refresh_token?: string; access_token?: string } }
        return { refreshToken: p.token?.refresh_token, accessToken: p.token?.access_token }
      },
    }

    const primaryAcc = makeAccount({ id: 'acc_primary', alias: 'Primary', email: 'prim@example.com', dir: '', systemHome: true })
    persistRefreshedToken(deps, primaryAcc, { access_token: 'refreshed-access', expiryMs: Date.now() + 3_600_000 }, 'rt-live-primary')

    const updatedDisk = JSON.parse(readFileSync(primaryDiskFile, 'utf8')) as { token: { access_token: string; refresh_token: string } }
    assert.equal(updatedDisk.token.access_token, 'refreshed-access')
    assert.equal(updatedDisk.token.refresh_token, 'rt-live-primary', 'must NOT inherit revoked refresh_token from stale file')
    assert.ok(adopted !== null && (adopted as { raw: string }).raw.includes('rt-live-primary'))

    // 2. Isolated account STILL refuses cross-grant overwrite in persistRefreshedToken
    const isoAcc = makeAccount({ id: 'acc_iso', alias: 'Iso', dir: isoDir })
    const isoFile = quotaTokenFilePath(isoAcc)
    const isoExisting = tokenDoc('rt-iso-real', 'iso-real-acc', Date.now() + 3_600_000)
    writeFileSync(isoFile, isoExisting, 'utf8')
    persistRefreshedToken(deps, isoAcc, { access_token: 'foreign-acc', expiryMs: Date.now() + 3_600_000 }, 'rt-different')
    assert.equal(readFileSync(isoFile, 'utf8'), isoExisting, 'cross-grant safety guard for isolated account remains intact')

    // 3. prepareAccountTokenForSpawn requests 5m safety window, syncs primary disk when stale, and unwraps isolated file
    writeFileSync(primaryDiskFile, stalePrimaryDisk, 'utf8')
    const requestedMinValidity: number[] = []
    const okPrim = await prepareAccountTokenForSpawn({
      account: primaryAcc,
      quota: {
        getValidAccessToken: async (_acc, minMs = 0) => {
          requestedMinValidity.push(minMs)
          return 'tok-prim'
        },
      },
      poolDir,
      homeDir: home,
    })
    assert.equal(okPrim, true)
    assert.equal(requestedMinValidity[0], 5 * 60_000)
    assert.equal(readFileSync(primaryDiskFile, 'utf8'), freshPrimaryRaw)

    writeFileSync(isoFile, wrapGoKeyring(isoExisting), 'utf8')
    const okIso = await prepareAccountTokenForSpawn({
      account: isoAcc,
      quota: {
        getValidAccessToken: async (_acc, minMs = 0) => {
          requestedMinValidity.push(minMs)
          return 'tok-iso'
        },
      },
      poolDir,
      homeDir: home,
    })
    assert.equal(okIso, true)
    assert.equal(readFileSync(isoFile, 'utf8'), isoExisting)
  } finally {
    restorePlatform()
    if (origHome === undefined) delete process.env.HOME
    else process.env.HOME = origHome
    if (origUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = origUserProfile
    rmSync(root, { recursive: true, force: true })
  }
})

test('AcpSessionPool separates WSL UNC cwds from native Windows cwds and evicts per account without disturbing siblings', () => {
  const restorePlatform = setPlatform('win32')
  const closed: string[] = []
  const created: Array<{ accountId?: string; cwd: string }> = []
  try {
    const pool = new AcpSessionPool({
      bin: () => 'agy',
      cfg: () => defaultConfig(),
      createProcess: (opts) => {
        const tag = opts.cwd
        created.push({ cwd: opts.cwd })
        return {
          pid: created.length + 100,
          isAlive: () => true,
          isBusy: false,
          hasActivePrompt: () => false,
          hasOpenSession: () => false,
          sessionCount: 0,
          lastUsedAt: Date.now(),
          advertisedCommands: [],
          once: () => {},
          close: () => { closed.push(tag) },
        } as unknown as AcpProcess
      },
    })

    const pWin = pool.acquireProcess({
      bin: 'agy', cwd: 'D:\\proj\\rabbit', accountId: 'acc_primary',
      mode: 'skip', sandbox: false, agent: '',
    })
    const pWsl = pool.acquireProcess({
      bin: 'agy', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\zand\\proj\\gamecraft-pipeline', accountId: 'acc_primary',
      mode: 'skip', sandbox: false, agent: '',
    })
    const pIso = pool.acquireProcess({
      bin: 'agy', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\zand\\proj\\gamecraft-pipeline', accountId: 'acc_2',
      mode: 'skip', sandbox: false, agent: '',
    })
    assert.notEqual(pWin, pWsl, 'WSL UNC cwd must not reuse native Windows ACP process')
    assert.equal(pool.status().activeProcesses, 3)

    // Evicting acc_primary closes both pWin and pWsl while keeping acc_2 intact
    const evictedPrim = pool.evictAccount('acc_primary')
    assert.equal(evictedPrim, 2)
    assert.equal(pool.status().activeProcesses, 1)
    assert.equal(closed.length, 2)

    const evictedIso = pool.evictAccount('acc_2')
    assert.equal(evictedIso, 1)
    assert.equal(pool.status().activeProcesses, 0)
    assert.ok(pIso)
  } finally {
    restorePlatform()
  }
})

test('AcpProcess.restoreSession rethrows auth_required immediately instead of cascading into load/new', async () => {
  const proc = new AcpProcess({ bin: 'agy', cwd: '/tmp', permissionMode: 'skip' })
  const calls: string[] = []
  proc.ensureInitialized = async () => ({})
  proc.request = async (method: string) => {
    calls.push(method)
    if (method === 'session/resume') {
      throw new Error('Authentication required (auth_required): You are not logged into Antigravity')
    }
    return { sessionId: 'should-not-happen' }
  }
  await assert.rejects(
    () => proc.openSession({ cwd: '/tmp', resumeId: 'old-sid-1', mode: 'skip' }),
    /auth_required/i,
  )
  assert.deepEqual(calls, ['session/resume'], 'must bail immediately on auth error instead of retrying session/load or session/new')
})

test('runAcpAttempt discards auth_required/invalid_grant ACP process, heals once, and recovers for both primary and isolated accounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-acp-auth-heal-'))
  const restorePlatform = setPlatform('win32')
  try {
    const store = new SessionStore(join(root, 'sessions.json'))

    for (const account of [
      makeAccount({ id: 'acc_primary', alias: 'primary', email: 'prim@example.com', dir: '', systemHome: true }),
      makeAccount({ id: 'acc_2', alias: 'second', email: 'sec@example.com', dir: join(root, 'iso'), systemHome: false }),
    ]) {
      let spawnCount = 0
      const discarded: number[] = []
      const pool = new AcpSessionPool({
        bin: () => 'agy',
        cfg: () => defaultConfig(),
        createProcess: () => {
          spawnCount++
          const idx = spawnCount
          let alive = true
          return {
            pid: 500 + idx,
            logFilePath: null,
            supportsImageBlocks: false,
            isAlive: () => alive,
            isBusy: false,
            hasActivePrompt: () => false,
            hasOpenSession: () => false,
            sessionCount: 0,
            lastUsedAt: Date.now(),
            advertisedCommands: [],
            stderrOffset: () => 0,
            readStderrSince: () => '',
            once: () => {},
            close: () => { alive = false; discarded.push(idx) },
            openSession: async () => {
              if (idx === 1) {
                throw new Error(account.systemHome
                  ? 'Authentication required (auth_required)'
                  : 'token refresh failed: oauth2: "invalid_grant"')
              }
              return { sessionId: 'healed-sid-' + idx, status: 'created' as const, resumeFailed: false }
            },
            prompt: async ({ onUpdate }: { onUpdate: (u: Record<string, unknown>) => void }) => {
              onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } })
              return { stopReason: 'end_turn' }
            },
            cancelSession: () => {},
            closeSession: async () => {},
          } as unknown as AcpProcess
        },
      })

      let ensureCalls = 0
      let reinstallCalls = 0
      const deps: AttemptDeps = {
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
        agyVersion: () => '1.5.15',
        ensureFreshToken: async () => { ensureCalls++; return true },
        reinstallCredentialSlot: () => { reinstallCalls++; return true },
      }
      const input = makeAttemptInput({
        sessionKey: 'sess-' + account.id,
        sessionAccountKey: 'sess-' + account.id + ':' + account.id,
        persistBinding: true,
        workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\zand\\proj\\demo',
        account,
      })
      const slot = makeSlot()

      const rec = await runAcpAttempt(pool, deps, input, slot)
      assert.ok(rec, `${account.id}: healed retry should return a live RunRecording`)
      assert.equal(spawnCount, 2, `${account.id}: should discard first proc and spawn fresh second proc`)
      assert.ok(discarded.includes(1), `${account.id}: failed proc #1 must be discarded`)
      // 1 pre-flight + 1 heal call = 2 total
      assert.equal(ensureCalls, 2, `${account.id}: ensureFreshToken runs at pre-flight and during heal`)
      assert.equal(reinstallCalls, account.systemHome ? 1 : 0, 'primary re-asserts slot during heal; SSH-isolated skips shared slot')

      // Wait for background finishAcpAttempt settlement before removing temp dir
      const deadline = Date.now() + 3_000
      while (!(rec as { isSettled?: boolean }).isSettled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      pool.dispose()
    }
  } finally {
    restorePlatform()
    rmSync(root, { recursive: true, force: true })
  }
})

test('runAcpAttempt discards process on repeated auth failure and returns null cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-acp-auth-fail2-'))
  try {
    const store = new SessionStore(join(root, 'sessions.json'))
    const closed: number[] = []
    let count = 0
    const pool = new AcpSessionPool({
      bin: () => 'agy',
      cfg: () => defaultConfig(),
      createProcess: () => {
        const idx = ++count
        let alive = true
        return {
          pid: 900 + idx,
          logFilePath: null,
          isAlive: () => alive,
          isBusy: false,
          hasActivePrompt: () => false,
          hasOpenSession: () => false,
          sessionCount: 0,
          lastUsedAt: Date.now(),
          advertisedCommands: [],
          once: () => {},
          close: () => { alive = false; closed.push(idx) },
          openSession: async () => { throw new Error('You are not logged into Antigravity') },
        } as unknown as AcpProcess
      },
    })
    const acc = makeAccount({ id: 'acc_2', alias: 'second', email: 'sec@example.com', dir: root })
    const deps: AttemptDeps = {
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
      ensureFreshToken: async () => true,
    }
    const input = makeAttemptInput({
      sessionKey: 's-fail2',
      sessionAccountKey: 's-fail2:acc_2',
      persistBinding: false,
      workspaceRoot: root,
      account: acc,
    })
    const res = await runAcpAttempt(pool, deps, input, makeSlot())
    assert.equal(res, null)
    assert.deepEqual(closed, [1, 2], 'both unauthenticated processes must be discarded')
    assert.equal(pool.status().activeProcesses, 0, 'zero zombie processes may remain in pool')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PoolAuthFlow fires onAccountReauthenticated on isolated re-auth and refresh-token import', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-reauth-evict-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('Second')
    pool.updateAccountQuotas(acc.id, {}, 'sec@example.com')
    const quota = new QuotaService(pool)
    const evictedIds: string[] = []

    const flow = new PoolAuthFlow(pool, quota, () => {}, {
      writeSlot: () => true,
      writeKeyring: () => true,
      openBrowser: async () => true,
      exchangeCode: async () => ({ access_token: 'a-new', refresh_token: 'rt-new' }),
      refreshTokens: async () => ({ access_token: 'a-imp', refresh_token: 'rt-imp' }),
      fetchUserEmail: async () => 'sec@example.com',
      onAccountReauthenticated: (id) => { evictedIds.push(id) },
    })

    const started = await flow.beginAccount(acc.id)
    assert.equal(started.ok, true)
    const done = await flow.submitCode('4/1AfValidLookingCode')
    assert.equal(done.phase, 'done')
    assert.deepEqual(evictedIds, [acc.id])

    const imported = await flow.importRefreshToken('rt-imp')
    assert.equal(imported.ok, true)
    assert.deepEqual(evictedIds, [acc.id, acc.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
