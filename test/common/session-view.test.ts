// The header badge must describe the FAMILY the session's model belongs to.
//
// Reported 2026-11-23: a session showing `Gemini 4 Argon High` in the composer
// displayed `AGY · dao 98%` — dao's *Gemini* 5-hour quota — while the console's
// Argon row correctly said `ele`. The badge resolved the `google` pointer alone.
// These tests pin the resolution the badge now uses: model -> family -> the
// account that family actually serves, and THAT family's own quota book.
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionView } from '../../src/common/session-view.ts'
import type { AccountPoolData, ManagedAccount } from '../../src/common/pool-types.ts'

const RESET_FUTURE = new Date(Date.now() + 6 * 86_400_000).toISOString()
const RESET_PAST = new Date(Date.now() - 3 * 3_600_000).toISOString()

function account(over: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    alias: over.id,
    dir: '',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    ...over,
  } as ManagedAccount
}

const dao = account({
  id: 'acc_dao',
  alias: 'dao',
  email: 'dao@example.com',
  quotas: {
    google: { remainingFraction: 0.98, weeklyFraction: 0.56, resetTime: RESET_FUTURE, updatedAt: Date.now() },
    argon: { weeklyFraction: 0.99, weeklyResetTime: RESET_FUTURE, updatedAt: Date.now() },
  },
})

const ele = account({
  id: 'acc_ele',
  alias: 'ele',
  email: 'ele@example.com',
  quotas: {
    google: { remainingFraction: 0.95, weeklyFraction: 0.13, resetTime: RESET_FUTURE, updatedAt: Date.now() },
    argon: { weeklyFraction: 0.58, weeklyResetTime: RESET_FUTURE, updatedAt: Date.now() },
  },
})

const accounts = [dao, ele]

const poolData: AccountPoolData = {
  version: 1,
  mode: 'sequential',
  defaultCooldownMs: 900_000,
  maxCooldownMs: 3_600_000,
  activeAccountIds: { google: 'acc_dao', argon: 'acc_ele' },
  resolvedActiveAccountIds: { google: 'acc_dao', argon: 'acc_ele' },
  lastActiveAccountId: 'acc_dao',
  accounts,
}

test('an Argon session reports the Argon account and the Argon weekly book', () => {
  const view = buildSessionView({ poolData, accounts, model: 'gemini-4-argon-high' })
  assert.equal(view.family, 'argon')
  assert.equal(view.accountId, 'acc_ele', 'the argon pointer, not the google one')
  assert.equal(view.alias, 'ele')
  assert.equal(view.percent, 58, "ele's Argon weekly — never dao's Gemini 98%")
  assert.equal(view.window, 'weekly')
  assert.equal(view.source, 'session')
  assert.equal(view.cooling, false)
  assert.equal(view.eligible, true)
})

test('a Gemini session still reports the google account and its 5-hour window', () => {
  const view = buildSessionView({ poolData, accounts, model: 'gemini-4-pro' })
  assert.equal(view.family, 'google')
  assert.equal(view.accountId, 'acc_dao')
  assert.equal(view.percent, 98)
  assert.equal(view.window, 'five-hour')
  assert.equal(view.source, 'session')
})

test('an absent Argon row stays unknown instead of borrowing the Gemini reading', () => {
  const noArgon = account({
    id: 'acc_ele',
    alias: 'ele',
    quotas: { google: { remainingFraction: 0.95, weeklyFraction: 0.95, resetTime: RESET_FUTURE, updatedAt: Date.now() } },
  })
  const view = buildSessionView({
    poolData: { ...poolData, activeAccountIds: { argon: 'acc_ele' }, resolvedActiveAccountIds: { argon: 'acc_ele' } },
    accounts: [noArgon],
    model: 'gemini-4-argon',
  })
  assert.equal(view.accountId, 'acc_ele')
  assert.equal(view.percent, null, 'no argon data means no percentage')
  assert.equal(view.window, 'none')
})

test('this session\'s sticky account outranks another account\'s pin', () => {
  const view = buildSessionView({
    poolData,
    accounts,
    model: 'gemini-4-argon-high',
    stickyAccountId: 'acc_dao',
  })
  assert.equal(view.accountId, 'acc_dao', 'the session really ran on dao for argon')
  assert.equal(view.percent, 99, "dao's own argon reading")
  assert.equal(view.source, 'session')
})

test('an unpinned family is reported as a prediction, never as "in use"', () => {
  const view = buildSessionView({
    poolData: {
      ...poolData,
      activeAccountIds: { google: 'acc_dao' },
      resolvedActiveAccountIds: { google: 'acc_dao', argon: 'acc_ele' },
    },
    accounts,
    model: 'gemini-4-argon-medium',
  })
  assert.equal(view.accountId, 'acc_ele')
  assert.equal(view.source, 'predicted')
})

test('a stale pin is not announced: the eligible pick is shown as predicted', () => {
  const view = buildSessionView({
    poolData: {
      ...poolData,
      activeAccountIds: { google: 'acc_dao', argon: 'acc_gone' },
      resolvedActiveAccountIds: { google: 'acc_dao', argon: 'acc_ele' },
    },
    accounts,
    model: 'gemini-4-argon',
  })
  assert.equal(view.accountId, 'acc_ele')
  assert.equal(view.source, 'predicted')
})

test('a reset boundary already in the past marks the percentage stale', () => {
  const stale = account({
    id: 'acc_ele',
    alias: 'ele',
    quotas: { argon: { weeklyFraction: 0.33, weeklyResetTime: RESET_PAST, updatedAt: Date.now() - 30 * 3_600_000 } },
  })
  const view = buildSessionView({
    poolData: { ...poolData, activeAccountIds: { argon: 'acc_ele' }, resolvedActiveAccountIds: { argon: 'acc_ele' } },
    accounts: [stale],
    model: 'gemini-4-argon',
  })
  assert.equal(view.percent, 33)
  assert.equal(view.stale, true, 'a passed boundary must not read as live data')
})

test('no model means no claim: an empty selection reports nothing', () => {
  const view = buildSessionView({ poolData, accounts, model: '' })
  assert.equal(view.family, null)
  assert.equal(view.accountId, null)
  assert.equal(view.percent, null)
  assert.equal(view.source, 'none')
})

test('a model family with no eligible account reports none, not a neighbour', () => {
  const view = buildSessionView({
    poolData: { ...poolData, activeAccountIds: { google: 'acc_dao' }, resolvedActiveAccountIds: { google: 'acc_dao' } },
    accounts,
    model: 'claude-opus-5-5',
  })
  assert.equal(view.family, 'anthropic')
  assert.equal(view.accountId, null)
  assert.equal(view.source, 'none')
})