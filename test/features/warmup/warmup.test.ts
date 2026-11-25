import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pickWarmupModelForFamily,
  WarmupHistoryStore,
  WarmupService,
} from '../../../src/host/warmup.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import type { AccountPoolManager } from '../../../src/host/pool.ts'
import type { QuotaService } from '../../../src/host/quota.ts'
import { defaultConfig, type PluginConfig } from '../../../src/common/types.ts'
import { describeWarmupError } from '../../../src/features/warmup/policy.ts'

const TOS_403_BODY = JSON.stringify({
  error: {
    code: 403,
    message: 'This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.',
    status: 'PERMISSION_DENIED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TOS_VIOLATION', domain: 'cloudcode-pa.googleapis.com', metadata: { uiMessage: 'true', appeal_url: 'https://forms.gle/hGzM9MEUv2azZsrb9' } }],
  },
})

test('issue #112: TOS_VIOLATION (JSON or CLI warning text) is terminal and preserves appeal/validation URLs', () => {
  const info = describeWarmupError(403, TOS_403_BODY)
  assert.equal(info.terminal, true)
  assert.equal(info.appealUrl, 'https://forms.gle/hGzM9MEUv2azZsrb9')
  assert.ok(info.error.includes('TOS_VIOLATION'))
  assert.ok(info.error.includes('https://forms.gle/hGzM9MEUv2azZsrb9'))

  // CLI stream text notice shape (oh-my-pi #19343)
  const cliTos = describeWarmupError(1, '[warning] This service has been disabled in this account for violation of Terms of Service. Appeal at https://forms.gle/abc123XYZ')
  assert.equal(cliTos.terminal, true)
  assert.equal(cliTos.appealUrl, 'https://forms.gle/abc123XYZ')

  // VALIDATION_REQUIRED is non-terminal (never permanently bans), surfaces validation_url
  const valBody = JSON.stringify({ error: { details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.google.com/verify' } }] } })
  const valInfo = describeWarmupError(403, valBody)
  assert.equal(valInfo.terminal, false)
  assert.equal(valInfo.validationUrl, 'https://accounts.google.com/verify')
  assert.ok(valInfo.error.includes('https://accounts.google.com/verify'))

  assert.equal(describeWarmupError(403, 'rate limited').terminal, false)
  assert.equal(describeWarmupError(401, 'invalid_grant').terminal, false)
})

test('anti-ban invariant: warmup source contains ZERO direct HTTP inference / loadCodeAssist / anthropic-beta headers', () => {
  const svcSrc = readFileSync(new URL('../../../src/features/warmup/service.ts', import.meta.url), 'utf8')
  const polSrc = readFileSync(new URL('../../../src/features/warmup/policy.ts', import.meta.url), 'utf8')
  for (const forbidden of ['streamGenerateContent', 'generateContent', 'loadCodeAssist', 'anthropic-beta', 'claude-code-20250219', 'Client-Metadata']) {
    assert.equal(svcSrc.includes(forbidden), false, `warmup/service.ts must not contain ${forbidden}`)
    assert.equal(polSrc.includes(forbidden), false, `warmup/policy.ts must not contain ${forbidden}`)
  }
})

test('issue #112 + sweep protection: terminal TOS_VIOLATION quarantines account AND halts warmupAllAccounts cascade', async () => {
  const marked: string[] = []
  const probedAccounts: string[] = []
  const now = Date.now()
  const accounts: ManagedAccount[] = [
    {
      id: 'acc_tos',
      alias: 'TOS',
      email: 'tos@example.com',
      dir: '',
      enabled: true,
      createdAt: 0,
      cooldowns: {},
      quotas: { google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now - 60_000).toISOString() } },
    },
    {
      id: 'acc_healthy_sibling',
      alias: 'Sibling',
      email: 'sibling@example.com',
      dir: '/tmp/acc2',
      enabled: true,
      createdAt: 0,
      cooldowns: {},
      quotas: { google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now - 60_000).toISOString() } },
    },
  ]
  const pool = {
    getAccounts: () => accounts,
    markAuthRequired: (id: string, msg: string) => { marked.push(`${id}|${msg}`) },
  }
  const dir = mkdtempSync(join(tmpdir(), 'warmup-tos-'))
  try {
    const service = new WarmupService(
      pool as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => '1.5.10',
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (acc) => {
          probedAccounts.push(acc.id)
          return { code: 1, stdout: '', stderr: TOS_403_BODY, durationMs: 25 }
        },
      },
    )
    const results = await service.warmupAllAccounts({ force: true })
    assert.equal(probedAccounts.length, 1, 'sweep circuit breaker must stop before probing sibling account')
    assert.deepEqual(probedAccounts, ['acc_tos'])
    assert.equal(results[0]?.success, false)
    assert.equal(marked.length, 1)
    assert.ok(marked[0]!.startsWith('acc_tos|'))
    assert.ok(marked[0]!.includes('https://forms.gle/hGzM9MEUv2azZsrb9'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-terminal warmup failure (e.g. 401 / transient network blip) NEVER marks account authRequired', async () => {
  let authMarked = false
  const pool = {
    getAccounts: () => [],
    markAuthRequired: () => { authMarked = true },
  }
  const dir = mkdtempSync(join(tmpdir(), 'warmup-401-'))
  try {
    const service = new WarmupService(
      pool as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => '1.5.10',
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async () => ({ code: 1, stdout: '', stderr: 'HTTP 401 Unauthorized: token validation failed due to network error', durationMs: 15 }),
      },
    )
    const acc: ManagedAccount = {
      id: 'acc-1',
      alias: 'A1',
      dir: '',
      enabled: true,
      createdAt: 0,
      cooldowns: {},
      quotas: {},
    }
    const res = await service.warmupAccount(acc, { force: true, model: 'gemini-3.8-flash' })
    assert.equal(res[0]?.success, false)
    assert.equal(authMarked, false, 'transient 401/network failure in warmup must never quarantine account as authRequired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('autoWarmup is opt-in: the default config never probes on upgrade', () => {
  assert.equal(defaultConfig().autoWarmup, false)
  assert.deepEqual(defaultConfig().warmupModels, ['gemini-3.8-flash', 'claude-sonnet-5-5'])
})

test('pickWarmupModelForFamily selects appropriate CLI models honoring monitored preferences', () => {
  assert.equal(pickWarmupModelForFamily('google'), 'gemini-3.8-flash')
  assert.equal(pickWarmupModelForFamily('google', ['gemini-3.7-flash']), 'gemini-3.7-flash')
  assert.equal(pickWarmupModelForFamily('argon'), 'gemini-4-argon')
  assert.equal(pickWarmupModelForFamily('anthropic'), 'claude-sonnet-5-5')
  assert.equal(pickWarmupModelForFamily('anthropic', ['claude-opus-4-6-thinking']), 'claude-opus-4-6-thinking')
  assert.equal(pickWarmupModelForFamily('openai'), 'gpt-oss-120b-medium')
})

test('WarmupHistoryStore tracks records and cooldowns correctly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-store-'))
  try {
    const storeFile = join(dir, 'warmup-history.json')
    const store = new WarmupHistoryStore(storeFile)
    const now = Date.now()

    assert.equal(store.checkCooldown('test:weekly:1', 60000, now), false)
    store.record('test:weekly:1', now)
    assert.equal(store.checkCooldown('test:weekly:1', 60000, now + 30000), true)
    assert.equal(store.checkCooldown('test:weekly:1', 60000, now + 70000), false)

    const reloaded = new WarmupHistoryStore(storeFile)
    assert.equal(reloaded.checkCooldown('test:weekly:1', 60000, now + 30000), true)

    store.record('old:entry', now - 35 * 86400 * 1000)
    store.pruneOldEntries(now)
    assert.equal(store.checkCooldown('old:entry', 86400000, now), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService warmupAccount screens accounts and identifies weekly targets via official CLI probe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-svc-'))
  try {
    const store = new WarmupHistoryStore(join(dir, 'warmup-history.json'))
    let probedModels: string[] = []
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => '1.5.10',
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash', 'claude-sonnet-5-5'] } as unknown as PluginConfig),
      () => undefined,
      store,
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (_acc, model) => {
          probedModels.push(model)
          return { code: 0, stdout: '{"event":"result","result":{"status":"OK","response":"hi"}}\n', stderr: '', durationMs: 42 }
        },
      },
    )

    const now = Date.now()
    const testAccount: ManagedAccount = {
      id: 'acc-1',
      alias: 'Test Account',
      email: 'test@example.com',
      dir: '',
      enabled: true,
      createdAt: now - 100000,
      cooldowns: {},
      quotas: {
        google: {
          remainingFraction: 1.0,
          weeklyFraction: 1.0,
          weeklyResetTime: new Date(now - 120_000).toISOString(),
        },
      },
    }

    const res1 = await service.warmupAccount(testAccount, { force: false })
    assert.equal(res1.length, 1)
    assert.equal(res1[0]?.success, true)
    assert.equal(res1[0]?.model, 'gemini-3.8-flash')
    assert.deepEqual(probedModels, ['gemini-3.8-flash'])

    probedModels = []
    const res2 = await service.warmupAccount(testAccount, { force: false })
    assert.equal(res2[0]?.skipped, true)
    assert.deepEqual(probedModels, [])

    const res3 = await service.warmupAccount(testAccount, { force: true })
    assert.equal(res3[0]?.success, true)
    assert.equal(probedModels.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService never treats a missing weeklyFraction as a full bucket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-partial-'))
  try {
    const probed: string[] = []
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (_acc, model) => {
          probed.push(model)
          return { code: 0, stdout: 'hi', stderr: '', durationMs: 1 }
        },
      },
    )
    const account: ManagedAccount = {
      id: 'acc-partial',
      alias: 'Partial',
      dir: '',
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: { google: { remainingFraction: 0.5 } },
    }
    const res = await service.warmupAccount(account, { force: false })
    assert.equal(res[0]?.skipped, true)
    assert.deepEqual(probed, [], 'unknown weekly data must not trigger a cold-start probe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService backs off after a failed probe instead of retrying every tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-fail-'))
  try {
    const probed: string[] = []
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (_acc, model) => {
          probed.push(model)
          return { code: 1, stdout: '', stderr: '429 rate limited', durationMs: 1 }
        },
      },
    )
    const now = Date.now()
    const account: ManagedAccount = {
      id: 'acc-fail',
      alias: 'Fail',
      dir: '',
      enabled: true,
      createdAt: now,
      cooldowns: {},
      quotas: {
        google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now - 120_000).toISOString() },
      },
    }
    const first = await service.warmupAccount(account, { force: false })
    assert.equal(first[0]?.success, false)
    assert.equal(probed.length, 1)
    const second = await service.warmupAccount(account, { force: false })
    assert.equal(second[0]?.skipped, true)
    assert.equal(probed.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService skips accounts in cooldown, disabled, authRequired, or with empty warmupModels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-guards-'))
  try {
    const probed: string[] = []
    let warmupModels: string[] | undefined = ['gemini-3.8-flash']
    let autoWarmup = false
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup, warmupModels } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (_acc, model) => {
          probed.push(model)
          return { code: 0, stdout: 'hi', stderr: '', durationMs: 1 }
        },
      },
    )
    const now = Date.now()
    const baseQuot = { google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now - 120_000).toISOString() } }

    const cooling = await service.warmupAccount({ id: 'c', alias: 'C', dir: '', enabled: true, createdAt: now, cooldowns: { google: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 } }, quotas: baseQuot }, { force: false })
    assert.equal(cooling[0]?.skipped, true)

    const disabled = await service.warmupAccount({ id: 'd', alias: 'D', dir: '', enabled: false, createdAt: now, cooldowns: {}, quotas: baseQuot })
    assert.equal(disabled[0]?.skipped, true)

    const authReq = await service.warmupAccount({ id: 'a', alias: 'A', dir: '', enabled: true, authRequired: true, createdAt: now, cooldowns: {}, quotas: baseQuot })
    assert.equal(authReq[0]?.skipped, true)

    warmupModels = []
    const emptyModels = await service.warmupAccount({ id: 'e', alias: 'E', dir: '', enabled: true, createdAt: now, cooldowns: {}, quotas: baseQuot }, { force: false })
    assert.equal(emptyModels[0]?.skipped, true)

    assert.deepEqual(await service.runScheduledWarmup(), [])
    autoWarmup = true
    assert.deepEqual(await service.runScheduledWarmup(), [])
    assert.deepEqual(probed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService triggers probe for floating/post-reset ~7-day window and skips mid-cycle countdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-post-reset-'))
  try {
    const probed: string[] = []
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (_acc, model) => {
          probed.push(model)
          return { code: 0, stdout: 'hi', stderr: '', durationMs: 1 }
        },
      },
    )
    const now = Date.now()
    const postResetAccount: ManagedAccount = {
      id: 'acc-post-reset',
      alias: 'Post-Reset Account',
      dir: '',
      enabled: true,
      createdAt: now - 86400 * 1000 * 10,
      cooldowns: {},
      quotas: { google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now + 7 * 86400 * 1000).toISOString() } },
    }

    const res1 = await service.warmupAccount(postResetAccount, { force: false })
    assert.equal(res1[0]?.success, true)
    assert.deepEqual(probed, ['gemini-3.8-flash'])

    probed.length = 0
    const res2 = await service.warmupAccount(postResetAccount, { force: false })
    assert.equal(res2[0]?.skipped, true)

    const midCycleAccount: ManagedAccount = {
      id: 'acc-mid-cycle',
      alias: 'Mid-Cycle Account',
      dir: '',
      enabled: true,
      createdAt: now - 86400 * 1000 * 15,
      cooldowns: {},
      quotas: { google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now + 4 * 86400 * 1000).toISOString() } },
    }
    const res3 = await service.warmupAccount(midCycleAccount, { force: false })
    assert.equal(res3[0]?.skipped, true)
    assert.deepEqual(probed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pickWarmupModelForFamily dynamically resolves per-account available Claude and Argon models', () => {
  const accWithClaude55 = {
    id: 'acc-4',
    quotas: {
      anthropic: {
        models: [
          { modelId: 'claude-opus-5-5-medium', displayName: 'Claude Opus 5.5 (Medium)' },
          { modelId: 'claude-sonnet-5-5-medium', displayName: 'Claude Sonnet 5.5 (Medium)' },
        ],
      },
      argon: {
        models: [
          { modelId: 'gemini-4-argon-medium', displayName: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gemini-4-argon-low', displayName: 'Gemini 4 Argon (Low)' },
        ],
      },
    },
  } as unknown as ManagedAccount

  assert.equal(pickWarmupModelForFamily('anthropic', [], accWithClaude55), 'claude-sonnet-5-5')
  assert.equal(pickWarmupModelForFamily('argon', [], accWithClaude55), 'gemini-4-argon')

  const accWithClaude46 = {
    id: 'acc-3',
    quotas: {
      anthropic: {
        models: [
          { modelId: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' },
          { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' },
        ],
      },
    },
  } as unknown as ManagedAccount

  assert.equal(pickWarmupModelForFamily('anthropic', [], accWithClaude46), 'claude-sonnet-4-6')
})

test('WarmupService.status() tracks live progress + lastRun, retries backoff with ignoreFailureBackoff, respects per-family cooling, and skips without sleep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-status-family-'))
  try {
    const now = Date.now()
    const dueReset = new Date(now + 7 * 86400 * 1000).toISOString()
    const midCycleReset = new Date(now + 3 * 86400 * 1000).toISOString()

    // Account 1: google is in 429 cooldown, argon is due; recent argon failure exists in history.
    const partialCoolingAcc: ManagedAccount = {
      id: 'acc-partial',
      alias: 'Partial',
      dir: '',
      enabled: true,
      createdAt: now - 20 * 86400 * 1000,
      cooldowns: {
        google: { cooldownUntil: now + 60_000, reason: '429 Rate Limit', consecutiveFailures: 1 },
      },
      quotas: {
        google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: dueReset, updatedAt: now },
        argon: { weeklyFraction: 1, weeklyResetTime: dueReset, updatedAt: now },
      },
    }
    // Account 2: mid-cycle everywhere -> completely skipped (must add 0 inter-account sleep).
    const skippedAcc: ManagedAccount = {
      id: 'acc-mid-skip',
      alias: 'MidSkip',
      dir: '',
      enabled: true,
      createdAt: now - 20 * 86400 * 1000,
      cooldowns: {},
      quotas: {
        google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: midCycleReset, updatedAt: now },
      },
    }

    const history = new WarmupHistoryStore(join(dir, 'history.json'))
    // Stamp recent argon failure backoff for partialCoolingAcc.
    history.record('acc-partial:argon:failed', now - 1000)

    let releaseProbe: (() => void) | null = null
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const probed: string[] = []

    const service = new WarmupService(
      { getAccounts: () => [skippedAcc, partialCoolingAcc] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash', 'gemini-4-argon'] } as unknown as PluginConfig),
      () => undefined,
      history,
      {
        bin: () => '/usr/local/bin/agy',
        runCliProbe: async (_acc, model) => {
          probed.push(model)
          await probeGate
          return { code: 0, stdout: 'ok', stderr: '', durationMs: 5 }
        },
      },
    )

    // Initially idle.
    assert.equal(service.isRunning(), false)
    assert.equal(service.status().running, false)
    assert.equal(service.status().lastRun, null)

    const startMs = Date.now()
    const runPromise = service.warmupAllAccounts({ force: false, ignoreFailureBackoff: true })
    // Wait until skippedAcc finishes instantaneously and partialCoolingAcc enters runCliProbe.
    for (let i = 0; i < 20 && probed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const midStatus = service.status()
    assert.equal(service.isRunning(), true)
    assert.equal(midStatus.running, true)
    assert.equal(midStatus.scope, 'all')
    assert.equal(midStatus.total, 2)
    assert.equal(midStatus.currentAccountId, partialCoolingAcc.id)
    assert.deepEqual(midStatus.activeAccountIds, [skippedAcc.id, partialCoolingAcc.id])

    releaseProbe!()
    const results = await runPromise
    const elapsedMs = Date.now() - startMs

    // Must not sleep warmupDelayMs (~15s+) after skippedAcc.
    assert.ok(elapsedMs < 3000, `skipped account must not trigger inter-account sleep (elapsed=${elapsedMs}ms)`)
    // Only healthy due argon was probed; cooling google & mid-cycle skippedAcc were skipped.
    assert.deepEqual(probed, ['gemini-4-argon'])
    assert.equal(results.some((r) => r.accountId === skippedAcc.id && r.skipped === true), true)
    assert.equal(results.some((r) => r.accountId === partialCoolingAcc.id && r.model === 'gemini-4-argon' && r.success === true), true)

    const finalStatus = service.status()
    assert.equal(service.isRunning(), false)
    assert.equal(finalStatus.running, false)
    assert.ok(finalStatus.lastRun !== null)
    assert.equal(finalStatus.lastRun!.succeeded, 1)
    assert.equal(finalStatus.lastRun!.skipped, 1)
    assert.equal(finalStatus.lastRun!.failed, 0)
    assert.equal(finalStatus.lastRun!.accounts.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
