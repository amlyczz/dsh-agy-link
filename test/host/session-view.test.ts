import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../../src/common/types.ts'
import type { AccountPoolData, ManagedAccount } from '../../src/common/pool-types.ts'
import { ActiveRunTracker } from '../../src/host/active-runs.ts'
import { RunRecording } from '../../src/host/recording.ts'
import { resolveSessionView } from '../../src/host/session-view.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import type { HostServices } from '../../src/host/services.ts'

const RESET_FUTURE = new Date(Date.now() + 6 * 86_400_000).toISOString()

function makeAccount(id: string, alias: string, googleFrac: number, argonFrac = 0.9): ManagedAccount {
  return {
    id,
    alias,
    dir: '',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: googleFrac,
        weeklyFraction: 0.9,
        resetTime: RESET_FUTURE,
        weeklyResetTime: RESET_FUTURE,
        updatedAt: Date.now(),
      },
      argon: {
        weeklyFraction: argonFrac,
        weeklyResetTime: RESET_FUTURE,
        updatedAt: Date.now(),
      },
    },
  } as ManagedAccount
}

function makeServices(opts: {
  accounts: ManagedAccount[]
  activeGoogle: string
  activeArgon?: string
  sessionModel: string
  store: SessionStore
  adapter?: Partial<HostServices['adapter']>
}): HostServices {
  const poolData: AccountPoolData = {
    version: 1,
    mode: 'sequential',
    defaultCooldownMs: 900_000,
    maxCooldownMs: 3_600_000,
    activeAccountIds: { google: opts.activeGoogle, ...(opts.activeArgon ? { argon: opts.activeArgon } : {}) },
    resolvedActiveAccountIds: { google: opts.activeGoogle, ...(opts.activeArgon ? { argon: opts.activeArgon } : {}) },
    lastActiveAccountId: opts.activeGoogle,
    accounts: opts.accounts,
  }
  const pool = {
    getPoolData: () => poolData,
    getAccounts: () => opts.accounts,
    getAccount: (id: string) => opts.accounts.find((a) => a.id === id),
    isAccountEligibleForModel: (acc: ManagedAccount) => acc.enabled,
    isAccountEligible: (acc: ManagedAccount) => acc.enabled,
  }
  return {
    getConfig: () => ({ ...defaultConfig(), defaultModel: 'gemini-4-neon' }),
    pool,
    store: opts.store,
    sessionsSvc: () => ({
      get: () => ({ log: [{ type: 'model/selection', data: { provider: 'antigravity', model: opts.sessionModel } }] }),
    }),
    lastRun: null,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  } as unknown as HostServices
}

test('resolveSessionView prefers live active run account over stale sticky binding in sessions.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-view-live-'))
  try {
    const dao = makeAccount('acc_dao', 'dao', 0.99)
    const god = makeAccount('acc_god', 'god', 0.63)
    const alb = makeAccount('acc_alb', 'alb', 0.61)
    const store = new SessionStore(join(dir, 'sessions.json'))
    // Stale older binding left behind after god rotated/switched models mid-flight
    store.set('sess-1:acc_dao', {
      conversationId: 'conv-dao',
      lastMessageCount: 895,
      updatedAt: Date.now() - 3_600_000,
      model: 'gemini-4-neon',
    })

    const rec = new RunRecording('run-god') as RunRecording & { accountId?: string; family?: string }
    rec.accountId = 'acc_god'
    rec.family = 'google'

    const services = makeServices({
      accounts: [dao, god, alb],
      activeGoogle: 'acc_alb',
      sessionModel: 'gemini-pro-orchestrator-neon',
      store,
      adapter: {
        getActiveRun: (id: string) => (id === 'sess-1' ? rec : undefined),
        activeAccountForSession: (id: string) => (id === 'sess-1' ? { accountId: 'acc_god', family: 'google' } : undefined),
      } as never,
    })

    const view = resolveSessionView(services, 'sess-1')
    assert.equal(view.accountId, 'acc_god', 'live in-flight run on god must override stale dao binding and alb pool pointer')
    assert.equal(view.alias, 'god')
    assert.equal(view.percent, 63)
    assert.equal(view.source, 'session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSessionView ignores live run when the session switched to a different isolated model family', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-view-fam-'))
  try {
    const dao = makeAccount('acc_dao', 'dao', 0.99, 0.42)
    const god = makeAccount('acc_god', 'god', 0.63, 0.88)
    const store = new SessionStore(join(dir, 'sessions.json'))
    store.set('sess-2:acc_dao', {
      conversationId: 'conv-dao-argon',
      lastMessageCount: 10,
      updatedAt: Date.now() - 10_000,
      model: 'gemini-4-argon',
    })

    const rec = new RunRecording('run-god-google') as RunRecording & { accountId?: string; family?: string }
    rec.accountId = 'acc_god'
    rec.family = 'google'

    const services = makeServices({
      accounts: [dao, god],
      activeGoogle: 'acc_god',
      activeArgon: 'acc_dao',
      sessionModel: 'gemini-4-argon-high',
      store,
      adapter: {
        getActiveRun: (id: string) => (id === 'sess-2' ? rec : undefined),
        activeAccountForSession: (id: string) => (id === 'sess-2' ? { accountId: 'acc_god', family: 'google' } : undefined),
      } as never,
    })

    const view = resolveSessionView(services, 'sess-2')
    assert.equal(view.family, 'argon')
    assert.equal(view.accountId, 'acc_dao', 'dedicated argon family must not be overridden by a settling google run')
    assert.equal(view.percent, 42)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ActiveRunTracker covers pending pre-spawn window, live run, and settle cleanup', () => {
  const tracker = new ActiveRunTracker()
  const tok = tracker.setPending('sess-3', 'acc_god', 'google')
  assert.deepEqual(tracker.activeAccountFor('sess-3'), { accountId: 'acc_god', family: 'google' })

  const rec = new RunRecording('run-1')
  rec.accountId = 'acc_god'
  rec.family = 'google'
  tracker.register('sess-3', rec)
  tracker.clearPending('sess-3', tok)
  assert.deepEqual(tracker.activeAccountFor('sess-3'), { accountId: 'acc_god', family: 'google' })

  rec.settle(null)
  assert.equal(tracker.activeAccountFor('sess-3'), undefined)
  tracker.unregister('sess-3', rec)
  assert.equal(tracker.activeAccountFor('sess-3'), undefined)
})

test('resolveSessionView honors live run across shared google/argon peer group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-view-shared-'))
  try {
    const sharedGod: ManagedAccount = {
      id: 'acc_god',
      alias: 'god',
      dir: '',
      enabled: true,
      createdAt: 1,
      cooldowns: {},
      quotas: {
        google: {
          remainingFraction: 0.72,
          weeklyFraction: 0.88,
          resetTime: RESET_FUTURE,
          weeklyResetTime: RESET_FUTURE,
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Argon',
          updatedAt: Date.now(),
        },
      },
    } as ManagedAccount
    const dao = makeAccount('acc_dao', 'dao', 0.99, 0.42)
    const store = new SessionStore(join(dir, 'sessions.json'))
    store.set('sess-4:acc_dao', {
      conversationId: 'conv-dao',
      lastMessageCount: 10,
      updatedAt: Date.now() - 10_000,
      model: 'gemini-4-argon',
    })
    const rec = new RunRecording('run-shared')
    rec.accountId = 'acc_god'
    rec.family = 'google'
    const services = makeServices({
      accounts: [dao, sharedGod],
      activeGoogle: 'acc_dao',
      sessionModel: 'gemini-4-argon-high',
      store,
      adapter: {
        getActiveRun: (id: string) => (id === 'sess-4' ? rec : undefined),
        activeAccountForSession: (id: string) => (id === 'sess-4' ? { accountId: 'acc_god', family: 'google' } : undefined),
      } as never,
    })

    const view = resolveSessionView(services, 'sess-4')
    assert.equal(view.family, 'argon')
    assert.equal(view.accountId, 'acc_god')
    assert.equal(view.percent, 72)
    assert.equal(view.window, 'five-hour')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
