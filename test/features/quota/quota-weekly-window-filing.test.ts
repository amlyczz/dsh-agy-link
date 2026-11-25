// A per-model quota reading with NO window label must land in the row whose
// window it actually describes.
//
// `fetchAvailableModels` returns `quotaInfo: { remainingFraction, resetTime }`
// with no window name: for some accounts that is the rolling 5-hour bucket, for
// others the weekly one. When `retrieveUserQuotaSummary` is refused (free tier)
// there is nothing to match the reset against, and the old fallback filed the
// WEEKLY number into the 5-HOUR slot. On the primary account of
// `session-e778203d` that rendered "5 小时额度 100% · 周额度 (empty) · 11/30 22:46"
// plus a Pro badge — four numbers that described no bucket the account had
// (live 2026-11-23/24). The discriminator used here is physical, not cosmetic:
// a live 5-hour bucket always resets within five hours of now.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { resolveAccountPlanTier } from '../../../src/common/plan-tier.ts'
import type { FamilyQuotaInfo, ManagedAccount } from '../../../src/common/pool-types.ts'
import {
  WEEKLY_WINDOW_MIN_RESET_MS,
  looksLikeWeeklyWindow,
  undoWeeklyInFiveHourSlot,
} from '../../../src/domain/quota/buckets.ts'
import { buildFamilyQuotas } from '../../../src/domain/quota/parse.ts'

const NOW = Date.parse('2026-11-24T01:04:00Z')
const HOUR = 3600_000

function iso(msFromNow: number): string {
  return new Date(NOW + msFromNow).toISOString()
}

function rows(summary: Parameters<typeof buildFamilyQuotas>[0]['summary'], resetInMs: number, prevQuotas: Partial<Record<'google', FamilyQuotaInfo>> = {}) {
  return buildFamilyQuotas({
    summary,
    modelsCatalog: {
      'gemini-4-neon': { quotaInfo: { remainingFraction: 1, resetTime: iso(resetInMs) } },
    },
    prevQuotas: prevQuotas as never,
    now: NOW,
  }).familyQuotas
}

describe('weekly window classification', () => {
  test('the 6-hour floor separates the rolling 5h window from the weekly one', () => {
    assert.equal(WEEKLY_WINDOW_MIN_RESET_MS, 6 * HOUR)
    assert.equal(looksLikeWeeklyWindow(iso(3 * HOUR), NOW), false, 'a 5h bucket always resets inside five hours')
    assert.equal(looksLikeWeeklyWindow(iso(6.5 * 24 * HOUR), NOW), true)
    assert.equal(looksLikeWeeklyWindow(iso(0.5 * HOUR), NOW), false)
    assert.equal(looksLikeWeeklyWindow('', NOW), false)
    assert.equal(looksLikeWeeklyWindow('not a date', NOW), false)
  })

  test('a mis-filed weekly row is moved to the weekly slot; a real 5h row is untouched', () => {
    const weeklyInFiveHourSlot: FamilyQuotaInfo = {
      remainingFraction: 1,
      resetTime: iso(6.5 * 24 * HOUR),
      updatedAt: NOW - 10 * HOUR,
    }
    const repaired = undoWeeklyInFiveHourSlot(weeklyInFiveHourSlot, NOW)
    assert.equal(repaired?.remainingFraction, undefined, 'the 5h slot is emptied')
    assert.equal(repaired?.resetTime, undefined)
    assert.equal(repaired?.weeklyFraction, 1, 'and lands on the weekly row')
    assert.equal(repaired?.weeklyResetTime, weeklyInFiveHourSlot.resetTime)

    const realFiveHour: FamilyQuotaInfo = { remainingFraction: 0.42, resetTime: iso(2 * HOUR), updatedAt: NOW }
    assert.deepEqual(undoWeeklyInFiveHourSlot(realFiveHour, NOW), realFiveHour)

    // A complete row already carrying a DIFFERENT weekly window is genuine data.
    const complete: FamilyQuotaInfo = {
      remainingFraction: 0.8,
      resetTime: iso(4 * HOUR),
      weeklyFraction: 0.9,
      weeklyResetTime: iso(5 * 24 * HOUR),
    }
    assert.deepEqual(undoWeeklyInFiveHourSlot(complete, NOW), complete)
    assert.equal(undoWeeklyInFiveHourSlot(undefined, NOW), undefined)
  })
})

describe('family rows (free tier: summary refused)', () => {
  test('a weekly-only reading never becomes a 5-hour bar', () => {
    const out = rows(null, 6.5 * 24 * HOUR)
    const google = out.google
    assert.ok(google !== undefined)
    assert.equal(google.remainingFraction, undefined, 'no 5h number is invented')
    assert.equal(google.resetTime, undefined)
    assert.equal(google.weeklyFraction, 1)
    assert.equal(google.weeklyResetTime, iso(6.5 * 24 * HOUR))
    assert.equal(google.updatedAt, NOW, 'freshness advances with the reading')
  })

  test('a sub-6h reading still fills the 5-hour slot', () => {
    const out = rows(null, 3 * HOUR)
    assert.equal(out.google?.remainingFraction, 1)
    assert.equal(out.google?.resetTime, iso(3 * HOUR))
    assert.equal(out.google?.weeklyFraction, undefined)
  })

  test('an already-persisted mis-filed row is repaired instead of frozen forever', () => {
    const out = rows(null, 6.5 * 24 * HOUR, {
      google: {
        remainingFraction: 1,
        resetTime: iso(6.5 * 24 * HOUR),
        updatedAt: NOW - 10 * HOUR,
        models: [{ modelId: 'gemini-4-neon', remainingFraction: 1 }],
      },
    })
    assert.equal(out.google?.remainingFraction, undefined, 'the frozen 100% 5h bar disappears')
    assert.equal(out.google?.weeklyFraction, 1)
    assert.equal(out.google?.updatedAt, NOW)
  })
})

describe('family rows (paid plans keep their own windows)', () => {
  test('with an authoritative summary the 5h row is untouched and the weekly reading tightens the weekly row', () => {
    const out = rows(
      {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.31, resetTime: iso(2 * HOUR) },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: iso(6.5 * 24 * HOUR) },
            ],
          },
        ],
      },
      6.5 * 24 * HOUR,
    )
    assert.equal(out.google?.remainingFraction, 0.31, 'summary 5h survives a weekly-bound model reading')
    assert.equal(out.google?.resetTime, iso(2 * HOUR))
    assert.equal(out.google?.weeklyFraction, 0.9)
  })
})

describe('plan badge agrees with the card', () => {
  function account(over: Partial<ManagedAccount>): ManagedAccount {
    return {
      id: 'a', alias: 'a', dir: '', createdAt: 1, enabled: true, cooldowns: {}, quotas: {},
      ...over,
    } as ManagedAccount
  }

  test('a refused summary with no 5h window downgrades a stale Pro badge to Free', () => {
    const tier = resolveAccountPlanTier(account({
      planTier: 'pro',
      quotas: {
        google: { weeklyFraction: 1, weeklyResetTime: iso(6.5 * 24 * HOUR), updatedAt: NOW },
        anthropic: { weeklyFraction: 1, weeklyResetTime: iso(6.5 * 24 * HOUR), updatedAt: NOW },
        openai: { weeklyFraction: 1, weeklyResetTime: iso(6.5 * 24 * HOUR), updatedAt: NOW },
      } as never,
      quotaUnavailable: { reason: 'no_summary_access', since: NOW - HOUR, retryAfter: NOW + HOUR, detail: 'PERMISSION_DENIED' } as never,
    }))
    assert.equal(tier, 'free')
  })

  test('a paid account refused transiently keeps Pro: it still proves a 5h window', () => {
    const tier = resolveAccountPlanTier(account({
      planTier: 'pro',
      quotas: {
        google: { remainingFraction: 0.55, resetTime: iso(2 * HOUR), weeklyFraction: 0.8, weeklyResetTime: iso(6 * 24 * HOUR), updatedAt: NOW },
      } as never,
      quotaUnavailable: { reason: 'no_summary_access', since: NOW - HOUR, retryAfter: NOW + HOUR, detail: 'PERMISSION_DENIED' } as never,
    }))
    assert.equal(tier, 'pro')
  })
})