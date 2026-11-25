// Filing a quota summary into the 5-hour and weekly rows: endpoint
// fallthrough, model-derived tightening, and which window a per-model
// reading is allowed to land on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaService } from '../../../src/host/quota.ts'
import { makeTempPool, writeAccountToken } from './quota-fixtures.ts'

test('fetchQuotaSummary falls through partial summaries omitting Gemini to complete endpoints', async () => {
  const { QuotaService } = await import('../../../src/host/quota.ts')
  const { dir, pool } = makeTempPool('agy-quota-complete-')

  const partialSummary = {
    groups: [
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-16T12:00:00Z' },
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-23T12:00:00Z' },
        ],
      },
    ],
  }

  const completeSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-16T12:00:00Z' },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: '2026-10-21T12:00:00Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-16T12:00:00Z' },
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-23T12:00:00Z' },
        ],
      },
    ],
  }

  let callCount = 0
  class TestQuotaService extends QuotaService {
    override async fetchSummaryEndpoint(): Promise<Response> {
      callCount++
      if (callCount === 1) {
        return new Response(JSON.stringify(partialSummary), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify(completeSummary), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
  }

  const svc = new TestQuotaService(pool)
  const result = await svc.fetchQuotaSummary('fake_tok')
  assert.ok(result, 'summary should be returned')
  assert.equal(callCount, 2, 'should have fallen through the partial endpoint to the complete one')
  const hasGemini = result.groups?.some((g) => g.displayName?.toLowerCase().includes('gemini'))
  assert.equal(hasGemini, true, 'returned summary must contain Gemini models')
})

test('active 5h consumption in model discovery tightens coarse summary 5h quota', async () => {
  const { dir, pool } = makeTempPool('agy-quota-tighten-')
  const acc = pool.createAccountSlot('tighten-user')

  writeAccountToken(acc.dir!, 'ya29.tighten')

  const now = Date.now()
  const active5hReset = new Date(now + 15 * 60_000).toISOString() // 15 mins away (active 5h consumption)
  const summary5hReset = new Date(now + 5 * 3600_000).toISOString() // 5 hours away
  const weeklyReset = new Date(now + 3 * 24 * 3600_000).toISOString()

  class TightenService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'tighten@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: summary5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: weeklyReset },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-3.8-flash': {
            displayName: 'Gemini 3.8 Flash',
            quotaInfo: { remainingFraction: 0.72, resetTime: active5hReset },
          },
        },
      } as never
    }
  }

  const svc = new TightenService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // Even though summary reported 1.0 (coarse), model discovery tightened it to 0.72!
  assert.equal(quotas.google?.remainingFraction, 0.72)
  assert.equal(quotas.google?.resetTime, active5hReset)
  // Weekly limit from summary is preserved.
  assert.equal(quotas.google?.weeklyFraction, 0.8)
  assert.equal(quotas.google?.weeklyResetTime, weeklyReset)
})

test('weekly-bound model discovery must not overwrite the 5h row (2026-10-22 report)', async () => {
  // Live evidence (daoxzeex@gmail.com, 2026-10-22 23:23):
  //   summary: gemini-5h 0.822 / reset +4h18m, gemini-weekly 0.174 / reset +2d2h
  //   fetchAvailableModels: every gemini model 0.1736 / reset == THE WEEKLY RESET
  // The models endpoint reports whichever window Google deems binding for that
  // account, WITHOUT labelling it. The old merge folded that number into the
  // family's 5h slot, so the GUI painted "5h 19% 路 weekly 19%" with the weekly
  // reset on BOTH rows 鈥?exactly the screenshot the user filed.
  const { dir, pool } = makeTempPool('agy-quota-weeklymodels-')
  const acc = pool.createAccountSlot('weekly-models-user')

  writeAccountToken(acc.dir!, 'ya29.weeklymodels')

  const now = Date.now()
  const SUMMARY_5H_RESET = new Date(now + (4 * 60 + 18) * 60_000).toISOString()
  const SUMMARY_WEEKLY_RESET = new Date(now + (2 * 24 + 2) * 3600_000).toISOString()
  const SUMMARY_5H = 0.82211393
  const WEEKLY = 0.17376757
  const MODEL_WEEKLY = 0.17361549

  class WeeklyModelsService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'weeklymodels@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: WEEKLY, resetTime: SUMMARY_WEEKLY_RESET },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: SUMMARY_5H, resetTime: SUMMARY_5H_RESET },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-3.8-flash-high': {
            displayName: 'Gemini 3.8 Flash (High)',
            quotaInfo: { remainingFraction: MODEL_WEEKLY, resetTime: SUMMARY_WEEKLY_RESET },
          },
          'gemini-3-flash': {
            displayName: 'Gemini 3 Flash',
            quotaInfo: { remainingFraction: MODEL_WEEKLY, resetTime: SUMMARY_WEEKLY_RESET },
          },
        },
      } as never
    }
  }

  const svc = new WeeklyModelsService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // 5h row: untouched by the weekly-shaped model data.
  assert.equal(quotas.google?.remainingFraction, SUMMARY_5H, '5h row keeps the 5h bucket')
  assert.equal(quotas.google?.resetTime, SUMMARY_5H_RESET, '5h row keeps the 5h reset (鈮?h out, not 2d)')
  // Weekly row: tightened to the fresher model-side weekly figure.
  assert.equal(quotas.google?.weeklyFraction, MODEL_WEEKLY, 'weekly row takes the model-side weekly value')
  assert.equal(quotas.google?.weeklyResetTime, SUMMARY_WEEKLY_RESET)
  // The two rows must never be identical in value AND reset 鈥?that is the bug.
  assert.notEqual(quotas.google?.remainingFraction, quotas.google?.weeklyFraction)
  assert.notEqual(quotas.google?.resetTime, quotas.google?.weeklyResetTime)
})

test('exhausted 5h bucket: per-model weekly-boundary remaining lands on the WEEKLY row, not 5h', async () => {
  // 2026-10-17 00:37 incident: the coarse summary reported the meaningless
  // placeholder "100%, resets in now+5h" while the account was actually down
  // to 4.06% 鈥?every model row carried that remaining with the NEXT reset at
  // the weekly boundary, 14.5 hours out.
  //
  // 2026-10-22 correction: that per-model number IS the weekly bucket (its
  // reset is the weekly reset), so it belongs on the weekly row. Folding it
  // into the 5h row made both rows print the same percentage and the same
  // reset (the filed screenshot). The account still reads as dry, because the
  // weekly row is what drives eligibility (LOW_QUOTA_WEEKLY = 5%).
  const { dir, pool } = makeTempPool('agy-quota-weeklytighten-')
  const acc = pool.createAccountSlot('weekly-tighten-user')

  writeAccountToken(acc.dir!, 'ya29.weeklytighten')

  const now = Date.now()
  const summary5hReset = new Date(now + 5 * 3600_000).toISOString() // the "now+5h" placeholder
  const weeklyBoundaryReset = new Date(now + 14.5 * 3600_000).toISOString() // 14.5h out 鈥?beyond the old 6h gate
  const REAL_REMAINING = 0.040659066

  class WeeklyTightenService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'weeklytighten@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: summary5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: REAL_REMAINING, resetTime: weeklyBoundaryReset },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-3.8-flash-tiered': {
            displayName: 'gemini-3.8-flash-tiered',
            quotaInfo: { remainingFraction: REAL_REMAINING, resetTime: weeklyBoundaryReset },
          },
          'gemini-3.6-flash-high': {
            displayName: 'Gemini 3.6 Flash (High)',
            quotaInfo: { remainingFraction: REAL_REMAINING, resetTime: weeklyBoundaryReset },
          },
        },
      } as never
    }
  }

  const svc = new WeeklyTightenService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // The weekly row carries the real remaining and its weekly-boundary reset,
  // even though that reset sits beyond the old 6-hour gate.
  assert.equal(quotas.google?.weeklyFraction, REAL_REMAINING)
  assert.equal(quotas.google?.weeklyResetTime, weeklyBoundaryReset)
  // The 5h row is NOT rewritten from the weekly reading any more.
  assert.equal(quotas.google?.remainingFraction, 1, '5h placeholder stays on the 5h row')
  assert.equal(quotas.google?.resetTime, summary5hReset)
  // The account is still treated as dry 鈥?the weekly row is what excludes it.
  const refreshed = pool.getAccount(acc.id)!
  assert.equal(refreshed.quotas.google?.weeklyFraction, REAL_REMAINING)
  assert.equal(pool.isAccountEligible(refreshed, 'google', now), false, 'a 4% weekly account is not usable')
})

test('stale 5h summary placeholder with 100% and now+5h is replaced by live model quota (#48)', async () => {
  const { dir, pool } = makeTempPool('agy-quota-stale5h-')
  const acc = pool.createAccountSlot('stale5h-user')

  writeAccountToken(acc.dir!, 'ya29.stale5h')

  const now = Date.now()
  const stale5hReset = new Date(now + 5 * 3600_000).toISOString()
  const liveActiveReset = '2026-10-18T21:14:37Z'

  class StaleService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'stale@example.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: stale5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.92, resetTime: '2026-10-24T11:11:37Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-2.5-flash': {
            displayName: 'Gemini 2.5 Flash',
            quotaInfo: {
              remainingFraction: 0.9711094,
              resetTime: liveActiveReset,
            },
          },
        },
      } as never
    }
  }

  const svc = new StaleService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // Stale 1.0 / now+5h was replaced by live model fraction (0.9711094) and live reset time!
  assert.equal(quotas.google?.remainingFraction, 0.9711094)
  assert.equal(quotas.google?.resetTime, liveActiveReset)
  assert.equal(quotas.google?.weeklyFraction, 0.92)
  assert.equal(quotas.google?.weeklyResetTime, '2026-10-24T11:11:37Z')
})

test('fetchUserQuota integrates /v1internal:retrieveUserQuota per-model buckets (#48)', async () => {
  const { dir, pool } = makeTempPool('agy-quota-retrieve-')
  const acc = pool.createAccountSlot('retrieve-user')

  writeAccountToken(acc.dir!, 'ya29.retrieve')

  const now = Date.now()
  const stale5hReset = new Date(now + 5 * 3600_000).toISOString()
  const activeReset = '2026-10-18T21:14:37Z'

  class RetrieveService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'ret@example.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1.0, resetTime: stale5hReset },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.92, resetTime: '2026-10-24T11:11:37Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      // Empty model catalog from models endpoint
      return { models: {} } as never
    }
    override async fetchUserQuota() {
      // retrieveUserQuota returns the 12 gemini buckets
      return {
        buckets: [
          {
            modelId: 'gemini-2.5-flash',
            tokenType: 'WTUS',
            remainingFraction: 0.9711094,
            resetTime: activeReset,
          },
        ],
      }
    }
  }

  const svc = new RetrieveService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  assert.equal(quotas.google?.remainingFraction, 0.9711094)
  assert.equal(quotas.google?.resetTime, activeReset)
  assert.equal(quotas.google?.models?.length, 1)
  assert.equal(quotas.google?.models?.[0]?.modelId, 'gemini-2.5-flash')
})
