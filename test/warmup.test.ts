import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractWarmupProjectId,
  toCanonicalWarmupModel,
  pickWarmupModelForFamily,
  WarmupHistoryStore,
  WarmupService,
} from '../src/host/warmup.ts'
import type { ManagedAccount } from '../src/common/pool-types.ts'
import type { AccountPoolManager } from '../src/host/pool.ts'
import type { QuotaService } from '../src/host/quota.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'

test('autoWarmup is opt-in: the default config never probes on upgrade', () => {
  assert.equal(defaultConfig().autoWarmup, false)
  assert.deepEqual(defaultConfig().warmupModels, ['gemini-3.8-flash', 'claude-sonnet-4-6'])
})

test('toCanonicalWarmupModel maps bare models to official physical entities', () => {
  assert.equal(toCanonicalWarmupModel('gemini-3.8-flash'), 'gemini-3.8-flash-tiered')
  assert.equal(toCanonicalWarmupModel('gemini-3.7-flash'), 'gemini-3.7-flash-tiered')
  assert.equal(toCanonicalWarmupModel('gemini-3-flash'), 'gemini-3.8-flash-tiered')
  assert.equal(toCanonicalWarmupModel('gemini-4-argon'), 'gemini-4-argon')
  assert.equal(toCanonicalWarmupModel('claude-sonnet-4-6'), 'claude-sonnet-4-6')
  assert.equal(toCanonicalWarmupModel('gpt-oss-120b-medium'), 'gpt-oss-120b-medium')
  assert.equal(toCanonicalWarmupModel('custom-model-id'), 'custom-model-id')
})

test('extractWarmupProjectId accepts both loadCodeAssist shapes and rejects missing ids', () => {
  assert.equal(extractWarmupProjectId({ cloudaicompanionProject: 'proj-str' }), 'proj-str')
  assert.equal(extractWarmupProjectId({ cloudaicompanionProject: { id: 'proj-obj' } }), 'proj-obj')
  assert.equal(extractWarmupProjectId({ cloudaicompanionProject: { id: '' } }), '')
  assert.equal(extractWarmupProjectId({}), '')
  assert.equal(extractWarmupProjectId(null), '')
})

test('pickWarmupModelForFamily selects appropriate models honoring monitored preferences', () => {
  // Google family
  assert.equal(pickWarmupModelForFamily('google'), 'gemini-3.8-flash')
  assert.equal(pickWarmupModelForFamily('google', ['gemini-3.7-flash']), 'gemini-3.7-flash')

  // Argon family
  assert.equal(pickWarmupModelForFamily('argon'), 'gemini-4-argon')

  // Anthropic family
  assert.equal(pickWarmupModelForFamily('anthropic'), 'claude-sonnet-4-6')
  assert.equal(pickWarmupModelForFamily('anthropic', ['claude-opus-4-6-thinking']), 'claude-opus-4-6-thinking')

  // OpenAI family
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

    // Persistence reload test
    const reloaded = new WarmupHistoryStore(storeFile)
    assert.equal(reloaded.checkCooldown('test:weekly:1', 60000, now + 30000), true)

    // Prune test: records older than 30 days are removed
    store.record('old:entry', now - 35 * 86400 * 1000)
    store.pruneOldEntries(now)
    assert.equal(store.checkCooldown('old:entry', 86400000, now), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService warmupAccount screens accounts and identifies weekly targets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-svc-'))
  try {
    const storeFile = join(dir, 'warmup-history.json')
    const store = new WarmupHistoryStore(storeFile)

    const mockPool = {
      getAccounts: () => [],
    } as unknown as AccountPoolManager

    const mockQuota = {
      getValidAccessToken: async () => 'mock-access-token',
    } as unknown as QuotaService

    const mockConfig = {
      autoWarmup: true,
      warmupModels: ['gemini-3.8-flash', 'claude-sonnet-4-6'],
    } as unknown as PluginConfig

    const service = new WarmupService(
      mockPool,
      mockQuota,
      () => '',
      () => '2.24.0',
      () => mockConfig,
      () => undefined,
      store,
    )

    // Override fetchProjectId and warmupModelDirectly to mock backend network calls
    service.fetchProjectId = async () => 'test-project-123'
    let probedModels: string[] = []
    service.warmupModelDirectly = async (_account, model) => {
      probedModels.push(model)
      return { ok: true, status: 200, durationMs: 42 }
    }

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
          weeklyResetTime: new Date(now - 120_000).toISOString(), // reset passed 2 mins ago
        },
      },
    }

    // 1. Automatic screening finds the weekly due model
    const res1 = await service.warmupAccount(testAccount, { force: false })
    assert.equal(res1.length, 1)
    assert.equal(res1[0]?.success, true)
    assert.equal(res1[0]?.model, 'gemini-3.8-flash')
    assert.deepEqual(probedModels, ['gemini-3.8-flash'])

    // 2. Second automatic run is in 6-day cooldown
    probedModels = []
    const res2 = await service.warmupAccount(testAccount, { force: false })
    assert.equal(res2.length, 1)
    assert.equal(res2[0]?.skipped, true)
    assert.deepEqual(probedModels, [])

    // 3. Forced run bypasses cooldown
    const res3 = await service.warmupAccount(testAccount, { force: true })
    assert.equal(res3.length, 1)
    assert.equal(res3[0]?.success, true)
    assert.equal(probedModels.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService never treats a missing weeklyFraction as a full bucket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-partial-'))
  try {
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
    )
    const probed: string[] = []
    service.warmupModelDirectly = async (_account, model) => {
      probed.push(model)
      return { ok: true, status: 200, durationMs: 1 }
    }
    const account: ManagedAccount = {
      id: 'acc-partial',
      alias: 'Partial',
      dir: '',
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      // REST fallback rows look like this: no weekly fields at all.
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
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
    )
    const probed: string[] = []
    service.warmupModelDirectly = async (_account, model) => {
      probed.push(model)
      return { ok: false, status: 429, error: 'rate limited', durationMs: 1 }
    }
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
    assert.equal(probed.length, 1, 'a failed probe must enter the 30-minute backoff')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService skips accounts that are already in cooldown (non-force)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-cooldown-'))
  try {
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: ['gemini-3.8-flash'] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
    )
    const probed: string[] = []
    service.warmupModelDirectly = async (_account, model) => {
      probed.push(model)
      return { ok: true, status: 200, durationMs: 1 }
    }
    const now = Date.now()
    const account: ManagedAccount = {
      id: 'acc-cool',
      alias: 'Cooling',
      dir: '',
      enabled: true,
      createdAt: now,
      cooldowns: { google: { cooldownUntil: now + 60_000, reason: '429', consecutiveFailures: 1 } },
      quotas: {
        google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now - 120_000).toISOString() },
      },
    }
    const res = await service.warmupAccount(account, { force: false })
    assert.equal(res[0]?.skipped, true)
    assert.ok(res[0]?.skipReason?.includes('cooldown'))
    assert.deepEqual(probed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService treats an empty warmupModels list as disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-empty-'))
  try {
    const service = new WarmupService(
      { getAccounts: () => [] } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true, warmupModels: [] } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
    )
    const probed: string[] = []
    service.warmupModelDirectly = async (_account, model) => {
      probed.push(model)
      return { ok: true, status: 200, durationMs: 1 }
    }
    const now = Date.now()
    const account: ManagedAccount = {
      id: 'acc-empty',
      alias: 'Empty',
      dir: '',
      enabled: true,
      createdAt: now,
      cooldowns: {},
      quotas: {
        google: { remainingFraction: 1, weeklyFraction: 1, weeklyResetTime: new Date(now - 120_000).toISOString() },
      },
    }
    const res = await service.warmupAccount(account, { force: false })
    assert.equal(res[0]?.skipped, true)
    assert.deepEqual(probed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService skips disabled and authRequired accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-skip-'))
  try {
    const service = new WarmupService(
      {} as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: true } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
    )

    const disabledAcc: ManagedAccount = {
      id: 'acc-disabled',
      alias: 'Disabled',
      dir: '',
      enabled: false,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }
    const res1 = await service.warmupAccount(disabledAcc)
    assert.equal(res1[0]?.skipped, true)
    assert.ok(res1[0]?.skipReason?.includes('disabled'))

    const authAcc: ManagedAccount = {
      id: 'acc-auth',
      alias: 'Auth Required',
      dir: '',
      enabled: true,
      authRequired: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }
    const res2 = await service.warmupAccount(authAcc)
    assert.equal(res2[0]?.skipped, true)
    assert.ok(res2[0]?.skipReason?.includes('authentication'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService runScheduledWarmup respects autoWarmup flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-sched-'))
  try {
    let autoWarmupEnabled = false
    const service = new WarmupService(
      {
        getAccounts: () => [],
      } as unknown as AccountPoolManager,
      {} as unknown as QuotaService,
      () => '',
      () => null,
      () => ({ autoWarmup: autoWarmupEnabled } as unknown as PluginConfig),
      () => undefined,
      new WarmupHistoryStore(join(dir, 'history.json')),
    )

    const resDisabled = await service.runScheduledWarmup()
    assert.deepEqual(resDisabled, [])

    autoWarmupEnabled = true
    const resEnabled = await service.runScheduledWarmup()
    assert.deepEqual(resEnabled, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
