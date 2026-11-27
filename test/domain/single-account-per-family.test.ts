import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../../src/common/types.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import {
  orderByExpiry,
  pickEligibleAccount,
  resolveEligibleActiveAccountId,
} from '../../src/domain/accounts/selection.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { resolveSessionView } from '../../src/host/session-view.ts'
import type { HostServices } from '../../src/host/services.ts'
import { selectSessionAccount, stickyAccount } from '../../src/provider/account-selection.ts'

const NOW = Date.parse('2026-11-25T00:00:00Z')
const iso = (h: number) => new Date(NOW + h * 3600_000).toISOString()

const SHARED_GEMINI_DESC =
  'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash'

function acc(id: string, models: string[], weeklyInH = 100): ManagedAccount {
  return {
    id,
    alias: id,
    dir: '',
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 1,
        weeklyFraction: 1,
        resetTime: iso(5),
        weeklyResetTime: iso(weeklyInH),
        models: models.map((modelId) => ({ modelId, remainingFraction: 1 })),
      },
    },
  } as ManagedAccount
}

const hOnly = () => acc('h-only', ['gemini-4-hydrogen', 'gemini-4-carbon'], 100)
const dual = () => acc('dual', ['gemini-4-hydrogen-high', 'gemini-4-neon', 'gemini-4-carbon'], 10)

test('pinned broader account stays strictly locked for Hydrogen even when a narrower account exists', () => {
  const accounts = [hOnly(), dual()]
  assert.equal(pickEligibleAccount(accounts, null, { family: 'google', model: 'gemini-4-hydrogen', activeId: 'dual', now: NOW })?.id, 'dual')
  assert.equal(resolveEligibleActiveAccountId(accounts, { google: 'dual' }, 'google', null, NOW, 'gemini-4-hydrogen'), 'dual')
  assert.equal(resolveEligibleActiveAccountId(accounts, { google: 'dual' }, 'google', null, NOW), 'dual')
})

test('orderByExpiry strictly follows expiry order regardless of exclusive model capabilities', () => {
  const broadSoon = acc('broad-soon', ['gemini-4-hydrogen', 'gemini-4-neon'], 2)
  const narrowLater = acc('narrow-later', ['gemini-4-hydrogen'], 50)
  assert.deepEqual(orderByExpiry([narrowLater, broadSoon], [narrowLater, broadSoon], 'google', undefined, NOW).map((a) => a.id), [
    'broad-soon',
    'narrow-later',
  ])
})

test('when pinned account cannot serve Neon, pool rotates to Neon-capable account and keeps Hydrogen there with zero ping-pong', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-single-family-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const free = pool.createAccountSlot('h-only')
    const pro = pool.createAccountSlot('dual')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3600_000).toISOString()
    const reset7d = new Date(now + 6 * 86400_000).toISOString()
    pool.updateAccountQuotas(free.id, {
      google: { remainingFraction: 1, weeklyFraction: 1, resetTime: reset5h, weeklyResetTime: reset7d, models: [{ modelId: 'gemini-4-hydrogen', remainingFraction: 1 }], updatedAt: now },
    })
    pool.updateAccountQuotas(pro.id, {
      google: { remainingFraction: 1, weeklyFraction: 1, resetTime: reset5h, weeklyResetTime: reset7d, description: SHARED_GEMINI_DESC, models: [{ modelId: 'gemini-4-hydrogen', remainingFraction: 1 }, { modelId: 'gemini-4-neon', remainingFraction: 1 }], updatedAt: now },
    })

    pool.setActiveAccount(free.id, 'google')
    assert.equal(pool.selectAccount('google', 'gemini-4-hydrogen')?.id, free.id)

    // Neon is unsupported on h-only -> rotates active google pointer to pro
    assert.equal(pool.selectAccount('google', 'gemini-4-neon')?.id, pro.id)
    assert.equal(pool.getPoolData().activeAccountIds?.google, pro.id)

    // Subsequent Hydrogen turns stay strictly locked on pro (no ping-pong back to h-only)
    assert.equal(pool.selectAccount('google', 'gemini-4-hydrogen')?.id, pro.id)
    assert.equal(pool.getPoolData().activeAccountIds?.google, pro.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('REGRESSION: rotated-away account whose 5h quota recovers must never be resurrected by stale session binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-no-resurrect-'))
  try {
    const pool = new AccountPoolManager(dir)
    const primary = pool.getAccounts()[0]!
    const god = pool.createAccountSlot('god')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3600_000).toISOString()
    const reset7d = new Date(now + 6 * 86400_000).toISOString()
    for (const id of [primary.id, god.id]) {
      pool.updateAccountQuotas(id, {
        google: { remainingFraction: 0.9, weeklyFraction: 0.8, resetTime: reset5h, weeklyResetTime: reset7d, description: SHARED_GEMINI_DESC, updatedAt: now },
      })
    }
    pool.setActiveAccount(god.id, 'google')
    const store = new SessionStore(join(dir, 'sessions.json'))
    const cfg = { ...defaultConfig(), parallelSameAccount: true, autoFallbackModel: false }

    // Session A previously ran on god and wrote a session binding
    store.set(`session-A:${god.id}`, {
      conversationId: 'conv-god-1',
      lastMessageCount: 20,
      updatedAt: now + 50,
      model: 'gemini-pro-orchestrator-neon',
    })

    // god hits 429 -> pool automatically rotates google pointer to primary (manualPinAt unchanged!)
    pool.recordFailure(god.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', new Date(now + 3600_000).toISOString())
    assert.equal(pool.getPoolData().activeAccountIds?.google, primary.id)

    // Later, god's cooldown expires / 5h quota resets back to healthy
    pool.clearCooldown(god.id, 'google')
    pool.updateAccountQuotas(god.id, {
      google: { remainingFraction: 1, weeklyFraction: 0.8, resetTime: reset5h, weeklyResetTime: reset7d, description: SHARED_GEMINI_DESC, updatedAt: now + 1000 },
    })

    // Session A's next turn MUST converge onto primary, never resurrecting god or flipping activeAccountIds.google
    const res = await selectSessionAccount({
      deps: { pool, store },
      cfg,
      model: 'gemini-pro-orchestrator-neon',
      isAux: false,
      sessionKey: 'session-A',
    })
    assert.equal(res.account?.id, primary.id, 'stale binding on god must not resurrect god')
    assert.equal(pool.getPoolData().activeAccountIds?.google, primary.id, 'family pointer must stay on primary')
    assert.equal(stickyAccount({ pool, store }, 'google', 'session-A', 'gemini-pro-orchestrator-neon'), undefined)

    const services = {
      getConfig: () => ({ ...cfg, defaultModel: 'gemini-pro-orchestrator-neon' }),
      pool,
      store,
      sessionsSvc: () => ({
        get: () => ({ log: [{ type: 'model/selection', data: { provider: 'antigravity', model: 'gemini-pro-orchestrator-neon' } }] }),
      }),
      lastRun: null,
    } as unknown as HostServices
    assert.equal(resolveSessionView(services, 'session-A').accountId, primary.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('shared google <-> argon group converges onto active google account even when quotas.argon mirrors the weekly row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-shared-converge-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const god = pool.createAccountSlot('god')
    const other = pool.createAccountSlot('other')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3600_000).toISOString()
    // other expires earlier -> orderByExpiry would pick other if argon didn't honor google's active shared-group pointer
    pool.updateAccountQuotas(god.id, {
      google: { remainingFraction: 0.9, weeklyFraction: 0.8, resetTime: reset5h, weeklyResetTime: new Date(now + 6 * 86400_000).toISOString(), description: SHARED_GEMINI_DESC, updatedAt: now },
      argon: { weeklyFraction: 0.8, weeklyResetTime: new Date(now + 6 * 86400_000).toISOString(), description: SHARED_GEMINI_DESC, updatedAt: now },
    })
    pool.updateAccountQuotas(other.id, {
      google: { remainingFraction: 0.9, weeklyFraction: 0.8, resetTime: reset5h, weeklyResetTime: new Date(now + 1 * 86400_000).toISOString(), description: SHARED_GEMINI_DESC, updatedAt: now },
      argon: { weeklyFraction: 0.8, weeklyResetTime: new Date(now + 1 * 86400_000).toISOString(), description: SHARED_GEMINI_DESC, updatedAt: now },
    })

    pool.markAccountActive(god.id, 'google')
    // Clear argon pointer to simulate only google being set
    delete (pool.getPoolData() as { activeAccountIds?: Record<string, string> }).activeAccountIds?.argon

    const picked = pool.selectAccount('argon', 'gemini-pro-orchestrator-argon')
    assert.equal(picked?.id, god.id)
    assert.equal(pool.getPoolData().activeAccountIds?.argon, god.id)
    assert.equal(pool.getPoolData().activeAccountIds?.google, god.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('different model families (google vs anthropic vs dedicated argon) stay independent while image quotaModel rotates without moving google pointer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fam-and-img-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const acc1 = pool.createAccountSlot('acc1')
    const acc2 = pool.createAccountSlot('acc2')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3600_000).toISOString()
    const reset7d = new Date(now + 6 * 86400_000).toISOString()
    for (const id of [acc1.id, acc2.id]) {
      pool.updateAccountQuotas(id, {
        google: { remainingFraction: 0.9, weeklyFraction: 0.9, resetTime: reset5h, weeklyResetTime: reset7d, updatedAt: now },
        anthropic: { weeklyFraction: 0.9, weeklyResetTime: reset7d, updatedAt: now },
        argon: { weeklyFraction: 0.9, weeklyResetTime: reset7d, updatedAt: now },
      })
    }
    pool.setActiveAccount(acc1.id, 'google')
    pool.setActiveAccount(acc2.id, 'anthropic')
    pool.setActiveAccount(acc2.id, 'argon')

    const store = new SessionStore(join(dir, 'sessions.json'))
    const cfg = { ...defaultConfig(), parallelSameAccount: false }
    const gRes = await selectSessionAccount({ deps: { pool, store }, cfg, model: 'gemini-4-neon', isAux: false, sessionKey: 's1' })
    const cRes = await selectSessionAccount({ deps: { pool, store }, cfg, model: 'claude-opus-5-5', isAux: false, sessionKey: 's2' })
    const aRes = await selectSessionAccount({ deps: { pool, store }, cfg, model: 'gemini-4-argon', isAux: false, sessionKey: 's3' })
    assert.equal(gRes.account?.id, acc1.id)
    assert.equal(cRes.account?.id, acc2.id)
    assert.equal(aRes.account?.id, acc2.id)

    // Image local rotation avoids acc1 without moving activeAccountIds.google
    pool.recordModelFailure(acc1.id, 'gemini-3.1-flash-image', 'image 429', reset5h)
    const imgRes = await selectSessionAccount({
      deps: { pool, store },
      cfg,
      model: 'gemini-4-hydrogen',
      quotaModel: 'gemini-3.1-flash-image',
      avoidAccountIds: [acc1.id],
      isAux: false,
      sessionKey: 's-img',
    })
    assert.equal(imgRes.account?.id, acc2.id)
    assert.equal(pool.getPoolData().activeAccountIds?.google, acc1.id, 'image local rotation must never steal google pointer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
