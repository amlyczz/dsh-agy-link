// The plan badge has exactly one honest Ultra source: the user.
//
// Quota data cannot separate Pro from Ultra (agy 1.5.15 lists Argon inside the
// shared Gemini group for every paid plan, exposes no tier field, and the
// Antigravity licence service is not reachable from the plugin). Inference
// therefore reports the conservative `pro`, and `/agy plan <id|alias> <tier>`
// is the pin that lets a genuinely different plan show correctly — including
// across the hourly quota refresh that would otherwise re-infer `pro`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveAccountPlanTier } from '../../src/common/plan-tier.ts'
import type { AccountPlanTier, ManagedAccount } from '../../src/common/pool-types.ts'
import { PoolAdmin } from '../../src/domain/accounts/admin.ts'
import { handlePool } from '../../src/host/commands/pool.ts'
import type { CommandContext, CommandDeps } from '../../src/host/commands/shared.ts'

const paidShape = {
  google: { remainingFraction: 0.9, weeklyFraction: 0.8, description: 'Models within this group: Gemini 4 Neon, Gemini 4 Argon' },
} as never

function acc(over: Partial<ManagedAccount> = {}): ManagedAccount {
  return { id: 'a1', alias: 'dao', dir: '/tmp/a1', enabled: true, createdAt: 1, cooldowns: {}, quotas: paidShape, ...over } as ManagedAccount
}

test('a pinned tier outranks the inference, in both directions', () => {
  assert.equal(resolveAccountPlanTier(acc({ planTierOverride: 'ultra' })), 'ultra', 'a real Ultra account can say so')
  assert.equal(resolveAccountPlanTier(acc({ planTierOverride: 'pro' })), 'pro')
  // Free-shaped evidence (no 5h) plus an explicit pin: the pin wins, so a user
  // who knows better is never overruled by a refused summary.
  const freeShape = { google: { weeklyFraction: 0.4 } } as never
  assert.equal(resolveAccountPlanTier(acc({ quotas: freeShape, planTierOverride: 'enterprise' })), 'enterprise')
  assert.equal(resolveAccountPlanTier(acc({ planTierOverride: 'unknown' })), 'pro', 'unknown is not a pin')
  assert.equal(resolveAccountPlanTier(acc({ quotas: freeShape })), 'free', 'no pin: inference still decides')
})

function adminWith(account: ManagedAccount): { admin: PoolAdmin; persisted: () => number } {
  let persists = 0
  const data = { version: 1, mode: 'sequential', accounts: [account], activeAccountIds: {} } as never
  const admin = new PoolAdmin({
    getData: () => data,
    persist: () => { persists += 1 },
    baseDir: '/tmp/pool',
    log: () => undefined,
  } as never)
  return { admin, persisted: () => persists }
}

test('the override persists on the account and can be cleared', () => {
  const account = acc()
  const { admin, persisted } = adminWith(account)
  assert.equal(admin.setPlanTierOverride('a1', 'ultra'), true)
  assert.equal(account.planTierOverride, 'ultra')
  assert.equal(persisted(), 1, 'the pool is written through')
  assert.equal(admin.setPlanTierOverride('a1', undefined), true)
  assert.equal(account.planTierOverride, undefined)
  assert.equal(admin.setPlanTierOverride('missing', 'ultra'), false)
})

function commandDeps(pool: unknown): CommandDeps {
  return {
    pool: () => pool,
    notifyPicker: () => undefined,
  } as unknown as CommandDeps
}

function poolFake(account: ManagedAccount) {
  const pins: Array<AccountPlanTier | undefined> = []
  return {
    pins,
    getAccount: (id: string) => (id === account.id ? account : undefined),
    getAccounts: () => [account],
    setPlanTierOverride: (_id: string, tier: AccountPlanTier | undefined) => {
      pins.push(tier)
      return true
    },
  }
}

function ctx(sub: string, tail: string[]): CommandContext {
  return { sub, arg: tail.join(' '), parts: [sub, ...tail], raw: '/agy ' + [sub, ...tail].join(' ') }
}

test('/agy plan pins and clears a tier, and rejects nonsense', async () => {
  const account = acc()
  const pool = poolFake(account)
  const deps = commandDeps(pool)

  const pinned = await handlePool(deps, ctx('plan', ['dao', 'ultra']))
  assert.equal(pinned.kind, 'success')
  assert.match(pinned.text ?? '', /pinned to \*\*ultra\*\*/)
  assert.deepEqual(pool.pins, ['ultra'])

  const cleared = await handlePool(deps, ctx('plan', ['dao', 'auto']))
  assert.equal(cleared.kind, 'success')
  assert.deepEqual(pool.pins, ['ultra', undefined])

  const bad = await handlePool(deps, ctx('plan', ['dao', 'platinum']))
  assert.equal(bad.kind, 'error')
  assert.match(bad.text ?? '', /Unknown plan/)

  const usage = await handlePool(deps, ctx('plan', ['dao']))
  assert.equal(usage.kind, 'error')
})