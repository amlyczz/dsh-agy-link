// Regressions for two reported panel bugs:
//  1. a paid account was badged Free (Flash-only Gemini group + a 5-hour window)
//     while its twin was badged Ultra — the account is actually Pro;
//  2. the same Google account sitting in the pool twice (primary + isolated
//     copy) was counted as two accounts' worth of quota.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectPlanTierEvidence,
  inferAccountPlanTier,
  isStalePlanTier,
  resolveAccountPlanTier,
} from '../../src/common/plan-tier.ts'
import {
  duplicateAccountIds,
  findDuplicateEmailGroups,
  siblingAliases,
} from '../../src/common/account-duplicates.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

const flashPaid = {
  google: {
    remainingFraction: 0.9845,
    weeklyFraction: 0.9927,
    description: 'Models within this group: Gemini 3.8 Flash',
  },
} as never

const weeklyOnly = {
  google: { weeklyFraction: 0.99, description: 'Models within this group: Gemini 3.8 Flash' },
} as never

const sharedArgon = {
  google: {
    remainingFraction: 0.5,
    weeklyFraction: 0.5,
    description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 4 Argon',
  },
} as never

const dedicatedArgon = {
  google: { remainingFraction: 1, weeklyFraction: 0.46, description: 'Models within this group: Gemini 4 Neon' },
  argon: { description: 'For paid Pro plans, Argon quota is separate.' },
} as never

function acc(over: Partial<ManagedAccount>): ManagedAccount {
  return { id: 'a', alias: 'a', dir: '/tmp/a', enabled: true, createdAt: 1, cooldowns: {}, ...over } as ManagedAccount
}

test('a Flash-only group with a 5-hour window is a paid Pro plan, never Free', () => {
  // The exact shape of the reported account: 98% 5h + 99% weekly, description
  // mentions only "Gemini 3.8 Flash". Free accounts have NO 5-hour window.
  assert.equal(inferAccountPlanTier({ quotas: flashPaid }), 'pro')
  assert.equal(resolveAccountPlanTier(acc({ quotas: flashPaid, planTier: 'free' })), 'pro')
})

test('weekly-only (no 5h window) stays Free', () => {
  assert.equal(inferAccountPlanTier({ quotas: weeklyOnly }), 'free')
  assert.equal(resolveAccountPlanTier(acc({ quotas: weeklyOnly, planTier: 'free' })), 'free')
})

test('a dedicated Argon bucket is Pro; a member list naming Argon proves nothing', () => {
  // 2026-11-24: agy 1.5.15 enumerates "… Gemini 4 Argon …" in the shared Gemini
  // group's description for EVERY paid plan and no longer emits a separate Argon
  // group, so the description shape below is all a Pro account looks like too.
  // Six Pro accounts were badged Ultra purely because of this string.
  assert.equal(inferAccountPlanTier({ quotas: sharedArgon }), 'pro')
  assert.equal(inferAccountPlanTier({ quotas: dedicatedArgon }), 'pro')
  assert.equal(inferAccountPlanTier({ quotas: dedicatedArgon, dedicatedGroups: ['argon'] }), 'pro')
})

test('a stale Ultra badge with no Argon evidence at all is corrected to Pro', () => {
  // Reported primary: stored 'ultra', but the group description and models carry
  // no Argon whatsoever -> the stored tier is stale.
  assert.equal(resolveAccountPlanTier(acc({ quotas: flashPaid, planTier: 'ultra' })), 'pro')
})

test('a stored Ultra is always re-derived: no quota signal can prove the fold', () => {
  // The licence service holds the real tier; until the plugin reads it, an Ultra
  // badge would be a guess — and the guess that misfired on six accounts is
  // exactly the one this rule refuses to make.
  const evidence = collectPlanTierEvidence({ quotas: sharedArgon })
  assert.equal(isStalePlanTier('ultra', evidence), true)
  assert.equal(resolveAccountPlanTier(acc({ quotas: sharedArgon, planTier: 'ultra' })), 'pro')
})

test('a Pro/Enterprise badge is never auto-downgraded by weaker evidence', () => {
  assert.equal(resolveAccountPlanTier(acc({ quotas: flashPaid, planTier: 'pro' })), 'pro')
  assert.equal(resolveAccountPlanTier(acc({ quotas: flashPaid, planTier: 'enterprise' })), 'enterprise')
  assert.equal(isStalePlanTier('pro', collectPlanTierEvidence({ quotas: weeklyOnly })), false)
})

test('quotaUnavailable no_summary_access with no 5h window is Free', () => {
  assert.equal(
    inferAccountPlanTier({
      quotas: { google: { weeklyFraction: 1 } } as never,
      quotaUnavailable: { reason: 'no_summary_access', since: 0, retryAfter: 0 } as never,
    }),
    'free',
  )
})

test('the same Google account twice is reported once, case-insensitively', () => {
  const accounts = [
    acc({ id: 'p', alias: '主账号', email: 'G986465568@gmail.com' }),
    acc({ id: 'd', alias: 'g98', email: 'g986465568@gmail.com' }),
    acc({ id: 'x', alias: 'dao', email: 'other@gmail.com' }),
    acc({ id: 'n', alias: 'noemail' }),
  ]
  const groups = findDuplicateEmailGroups(accounts)
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.email, 'g986465568@gmail.com')
  assert.deepEqual(groups[0]!.ids.sort(), ['d', 'p'])
  assert.deepEqual([...duplicateAccountIds(accounts)].sort(), ['d', 'p'])
  assert.deepEqual(siblingAliases(accounts[0]!, accounts), ['g98'])
  assert.deepEqual(siblingAliases(accounts[2]!, accounts), [])
  assert.deepEqual(siblingAliases(accounts[3]!, accounts), [], 'an empty email is never a duplicate')
})

test('a unique pool reports no duplicates and no siblings', () => {
  const accounts = [
    acc({ id: 'a', alias: 'a', email: 'a@x.com' }),
    acc({ id: 'b', alias: 'b', email: 'b@x.com' }),
  ]
  assert.deepEqual(findDuplicateEmailGroups(accounts), [])
  assert.equal(duplicateAccountIds(accounts).size, 0)
})

test('a free account reporting the unmetered 100% 5h placeholder is NOT Pro', () => {
  // Live 2026-11-23: a Free account (no Argon, 13 models) was badged "Pro" because
  // it reported a 5h bucket at 100% whose reset was always ~5h away — the
  // unmetered placeholder, not a paid window.
  const now = Date.now()
  const freeWithPlaceholder = {
    google: {
      remainingFraction: 1,
      resetTime: new Date(now + 4.8 * 3_600_000).toISOString(),
      weeklyFraction: 0.63,
      weeklyResetTime: new Date(now + 6 * 86_400_000).toISOString(),
    },
  } as never
  assert.equal(inferAccountPlanTier({ quotas: freeWithPlaceholder, now }), 'free')
  assert.equal(resolveAccountPlanTier(acc({ quotas: freeWithPlaceholder, planTier: 'free' })), 'free')
})

test('a 5h window that was actually used still proves a paid plan', () => {
  const now = Date.now()
  const paid = {
    google: {
      remainingFraction: 0.62,
      resetTime: new Date(now + 3 * 3_600_000).toISOString(),
      weeklyFraction: 0.9,
      weeklyResetTime: new Date(now + 5 * 86_400_000).toISOString(),
    },
  } as never
  assert.equal(inferAccountPlanTier({ quotas: paid, now }), 'pro')
})
