import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import {
  exclusiveCapabilityScores,
  orderByExpiry,
  pickEligibleAccount,
  resolveEligibleActiveAccountId,
} from '../../src/domain/accounts/selection.ts'

const NOW = Date.parse('2026-11-25T00:00:00Z')
const iso = (h: number) => new Date(NOW + h * 3600_000).toISOString()

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
        weeklyRemainingFraction: 1,
        resetTime: iso(5),
        weeklyResetTime: iso(weeklyInH),
        models: models.map((modelId) => ({ modelId, remainingFraction: 1 })),
      },
    },
  } as ManagedAccount
}

const hOnly = () => acc('h-only', ['gemini-4-hydrogen', 'gemini-4-carbon'])
// Dual account's weekly quota resets sooner: old order would pick it first.
const dual = () => acc('dual', ['gemini-4-hydrogen-high', 'gemini-4-neon', 'gemini-4-carbon'], 1)

test('exclusive capability ignores models every candidate shares', () => {
  const scores = exclusiveCapabilityScores([hOnly(), dual()], 'google')
  assert.equal(scores.get('h-only'), 0)
  assert.equal(scores.get('dual'), 1)
})

test('narrower account wins even when the broader one resets sooner', () => {
  const accounts = [dual(), hOnly()]
  assert.deepEqual(orderByExpiry(accounts, accounts, 'google', undefined, NOW).map((a) => a.id), ['h-only', 'dual'])
})

test('equal capability keeps expiry order', () => {
  const a = acc('a', ['gemini-4-hydrogen'], 50)
  const b = acc('b', ['gemini-4-hydrogen'], 10)
  assert.deepEqual(orderByExpiry([a, b], [a, b], 'google', undefined, NOW).map((x) => x.id), ['b', 'a'])
})

test('sticky broader account yields to an eligible narrower one', () => {
  const accounts = [dual(), hOnly()]
  assert.equal(pickEligibleAccount(accounts, null, { family: 'google', activeId: 'dual', now: NOW })?.id, 'h-only')
  assert.equal(resolveEligibleActiveAccountId(accounts, { google: 'dual' }, 'google', null, NOW), 'h-only')
})

test('broader account is used when it is the only one serving the model', () => {
  const pool = { isModelSupported: (a: ManagedAccount, m: string) => a.id === 'dual' || m !== 'gemini-4-neon' }
  const accounts = [hOnly(), dual()]
  assert.equal(pickEligibleAccount(accounts, pool, { family: 'google', model: 'gemini-4-neon', now: NOW })?.id, 'dual')
})
