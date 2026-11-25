// Argon and Gemini are INDEPENDENT quota books (.spec/quota-and-risk-control.md).
//
// Live evidence (2026-11-23, agy 1.5.14): an account whose Gemini weekly pool had
// hit 0% still reported Argon weekly at 100%, and no account listed an argon
// model under its `google` family. Every layer below used to borrow one family's
// numbers for the other; this file pins the "never borrow" invariant at each of
// them so the fallback cannot quietly grow back.
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAccountModelRows } from '../../src/common/account-models.ts'
import { isQuotaBenched } from '../../src/common/quota-bench.ts'
import { nextQuotaResetAt, orderByExpiry } from '../../src/domain/accounts/selection.ts'
import { buildFamilyQuotas } from '../../src/domain/quota/parse.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

const NOW = Date.parse('2026-11-23T02:00:00Z')
const RESET = new Date(NOW + 3 * 24 * 3_600_000).toISOString()

function acc(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc_argon',
    alias: 'argon',
    dir: '/tmp/acc_argon',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {},
    ...overrides,
  }
}

test('no argon row means an UNKNOWN argon reset, never the Gemini one', () => {
  const a = acc({
    quotas: {
      google: { remainingFraction: 0.9, resetTime: RESET, weeklyFraction: 0.88, weeklyResetTime: RESET },
    },
  })
  assert.equal(
    Number.isNaN(nextQuotaResetAt(a, 'argon')),
    true,
    'an absent argon row must not inherit the Gemini reset time',
  )
  assert.equal(nextQuotaResetAt(a, 'google'), Math.min(Date.parse(RESET), Date.parse(RESET)))
})

test('a known argon reset outranks accounts with no argon row', () => {
  const withArgon = acc({ id: 'acc_with_argon', quotas: { argon: { weeklyFraction: 0.9, weeklyResetTime: RESET } } })
  const withoutArgon = acc({
    id: 'acc_no_argon',
    quotas: { google: { remainingFraction: 1, resetTime: RESET, weeklyFraction: 1, weeklyResetTime: RESET } },
  })
  const pool = [withoutArgon, withArgon]
  assert.equal(
    orderByExpiry(pool, pool, 'argon', undefined, NOW)[0]?.id,
    'acc_with_argon',
    'a known argon reset must beat a borrowed one',
  )
})

test('a drained Gemini pool must not bench Argon, and vice versa', () => {
  const geminiDrained = acc({
    quotas: { google: { remainingFraction: 0.02, resetTime: RESET, weeklyFraction: 0.01, weeklyResetTime: RESET } },
  })
  assert.equal(isQuotaBenched(geminiDrained, 'argon', NOW), false, 'Gemini exhaustion must not bench Argon')
  assert.equal(isQuotaBenched(geminiDrained, 'google', NOW), true, 'Gemini is genuinely benched')

  const argonDrained = acc({
    quotas: {
      argon: { weeklyFraction: 0.01, weeklyResetTime: RESET },
      google: { remainingFraction: 1, resetTime: RESET, weeklyFraction: 1, weeklyResetTime: RESET },
    },
  })
  assert.equal(isQuotaBenched(argonDrained, 'argon', NOW), true, 'Argon is genuinely benched')
  assert.equal(isQuotaBenched(argonDrained, 'google', NOW), false, 'Argon exhaustion must not bench Gemini')
})

test('an Argon model row never displays the Gemini bucket', () => {
  const geminiOnly = acc({
    quotas: { google: { remainingFraction: 0.42, resetTime: RESET, weeklyFraction: 0.3, weeklyResetTime: RESET } },
  })
  const borrowed = buildAccountModelRows(geminiOnly, [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low'] }])
  const borrowedArgon = borrowed.find((r) => r.id === 'gemini-4-argon')
  assert.equal(borrowedArgon?.family, 'argon')
  assert.equal(borrowedArgon?.remainingFraction, undefined, 'no borrowed percentage')
  assert.equal(borrowedArgon?.resetTime, undefined, 'no borrowed reset time')

  const withOwnRow = buildAccountModelRows(
    acc({ quotas: { argon: { weeklyFraction: 0.75, weeklyResetTime: RESET } } }),
    [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low'] }],
  )
  assert.equal(
    withOwnRow.find((r) => r.id === 'gemini-4-argon')?.remainingFraction,
    0.75,
    'its own weekly reading is what shows',
  )
})

test('an Argon model is ingested into the argon family and leaves google untouched', () => {
  const { familyQuotas } = buildFamilyQuotas({
    summary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.66, resetTime: RESET }],
        },
      ],
    },
    modelsCatalog: {
      'gemini-4-argon-high': { quotaInfo: { remainingFraction: 0.81, resetTime: RESET } },
    },
    prevQuotas: {},
    now: NOW,
  })

  assert.equal(familyQuotas.argon?.weeklyFraction, 0.81, 'the argon reading lands on argon weekly')
  assert.equal(familyQuotas.argon?.remainingFraction, undefined, 'argon never takes a 5-hour slot')
  assert.equal(familyQuotas.google?.remainingFraction, 0.66, 'the Gemini summary row is untouched')
  assert.equal(familyQuotas.google?.weeklyFraction, undefined, 'the argon reading is not a Gemini weekly')
  assert.ok(
    !familyQuotas.google?.models?.some((m) => m.modelId === 'gemini-4-argon-high'),
    'the argon model is not re-homed under google',
  )
  assert.ok(
    familyQuotas.argon?.models?.some((m) => m.modelId === 'gemini-4-argon-high'),
    'the argon model is listed under argon',
  )
})
