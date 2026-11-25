// Argon is its own quota book: its row comes from Argon’s own group or
// model reading, never from the Gemini bucket, and a retired dedicated
// group releases the cooldown it took.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaService } from '../../../src/host/quota.ts'
import { makeTempPool, writeAccountToken } from './quota-fixtures.ts'

test('Gemini 4 Argon quota group lands in its own family, never on google', async () => {
  const { dir, pool } = makeTempPool('agy-quota-argon-')
  const acc = pool.createAccountSlot('argon-user')

  // Valid on-disk token so no refresh flow runs.
  writeAccountToken(acc.dir!, 'ya29.argo')

  class ArgonService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      return { email: 'pro-user@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-10-20T12:00:00Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-10-23T12:00:00Z' },
            ],
          },
          {
            // Real shape: the argon group name still contains "gemini" but
            // carries ONLY its own weekly bucket (paid Pro/Ultra accounts).
            displayName: 'Gemini 4 Argon',
            description: 'Models within this group: Gemini 4 Argon',
            buckets: [
              { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.66, resetTime: '2026-10-23T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon-low': { displayName: 'Gemini 4 Argon (Low)', quotaInfo: { remainingFraction: 0.66, resetTime: '2026-10-23T12:00:00Z' } },
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-10-20T12:00:00Z' } },
        },
      } as never
    }
  }

  const svc = new ArgonService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas, 'quota refresh succeeded')
  // Argon group + argon model ids live under their OWN family...
  assert.equal(quotas.argon?.weeklyFraction, 0.66)
  assert.equal(quotas.argon?.weeklyResetTime, '2026-10-23T12:00:00Z')
  assert.equal(quotas.argon?.models?.length, 1)
  assert.equal(quotas.argon?.models?.[0]?.modelId, 'gemini-4-argon-low')
  // ...without clobbering the plain Gemini family.
  assert.equal(quotas.google?.remainingFraction, 0.7)
  assert.equal(quotas.google?.weeklyFraction, 0.42)

  const stored = pool.getAccount(acc.id)!
  assert.equal(stored.quotas.argon?.weeklyFraction, 0.66)
  assert.equal(stored.quotas.google?.weeklyFraction, 0.42)
})

test('accounts without Argon access carry no argon quota entry (UI hides the row)', async () => {
  const { dir, pool } = makeTempPool('agy-quota-noargon-')
  const acc = pool.createAccountSlot('free-user')

  writeAccountToken(acc.dir!, 'ya29.free')

  class FreeService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
      return { email: 'free-user@gmail.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-10-20T12:00:00Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-10-23T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
  }

  const svc = new FreeService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas, 'quota refresh succeeded')
  assert.equal(quotas.argon, undefined, 'no argon permission 鈫?no argon quota family')
  assert.equal(pool.getAccount(acc.id)!.quotas.argon, undefined, 'argon row must stay hidden for this account')
})

test('Argon model rows build the Argon family from their OWN reading, never from Gemini', async () => {
  const { dir, pool } = makeTempPool('agy-quota-argonmodel-')
  const acc = pool.createAccountSlot('argon-model-user')

  writeAccountToken(acc.dir!, 'ya29.argonmodel')

  class ArgonModelService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'argonmodel@example.com' }
    }
    override async fetchQuotaSummary() {
      // Only plain Gemini in summary; Argon is missing from summary
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-10-20T12:00:00Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaInfo: {
              remainingFraction: 0.85,
              resetTime: '2026-10-25T12:00:00Z',
            },
          },
        },
      } as never
    }
  }

  const svc = new ArgonModelService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // Argon and Gemini are separate quota books (.spec/quota-and-risk-control.md).
  // The argon model row carries Argon's OWN reading, so it becomes the Argon
  // family's weekly window — and it must never touch the Gemini row.
  assert.equal(quotas.argon?.weeklyFraction, 0.85, 'the argon model reading becomes Argon weekly')
  assert.equal(quotas.argon?.weeklyResetTime, '2026-10-25T12:00:00Z')
  assert.equal(quotas.argon?.remainingFraction, undefined, 'argon is weekly-only here, never a 5h slot')
  assert.equal(quotas.google?.remainingFraction, 0.9, 'the Gemini summary row is untouched')
  assert.equal(quotas.google?.weeklyFraction, undefined, 'no Gemini weekly bucket was invented')
  assert.ok(
    !quotas.google?.models?.some((m) => m.modelId === 'gemini-4-argon'),
    'the argon model is not re-homed under Gemini',
  )
  assert.ok(
    quotas.argon?.models?.some((m) => m.modelId === 'gemini-4-argon'),
    'the argon model is listed under its true family',
  )
})

test('Argon model quota must never fill the 5-hour slot when the summary has no argon group', async () => {
  // Regression: when the plan folds Argon into the shared Gemini bucket, the
  // per-model quotaInfo carries the WEEKLY window. The old fallback filed that
  // number under `remainingFraction` (the 5-hour slot), so the 10% 5h floor
  // benched an account whose weekly quota was still above the 5% weekly floor:
  //   "no account can serve argon right now (1 in cooldown)"
  // `/agy clear-cooldown` could not clear it because no cooldown existed.
  const { dir, pool } = makeTempPool('agy-quota-argonweekly-')
  const acc = pool.createAccountSlot('argon-weekly-user')

  writeAccountToken(acc.dir!, 'ya29.argonweekly')

  const weeklyReset = new Date(Date.now() + 2 * 3600_000).toISOString()
  const fiveHourReset = new Date(Date.now() + 3 * 3600_000).toISOString()

  // Seed the WRONG row a previous poll produced, so the test proves the fix
  // also heals existing installs instead of only never writing it again.
  pool.updateAccountQuotas(acc.id, {
    argon: {
      remainingFraction: 0.093,
      resetTime: weeklyReset,
      weeklyFraction: 0.093,
      weeklyResetTime: weeklyReset,
      updatedAt: 1,
    },
  })

  class WeeklyArgonService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'argonweekly@example.com' }
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.093, resetTime: weeklyReset },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.924, resetTime: fiveHourReset },
            ],
          },
        ],
      } as never
    }
    override async fetchUserQuota() {
      return null
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon-high': {
            displayName: 'Gemini 4 Argon (High)',
            quotaInfo: { remainingFraction: 0.093, resetTime: weeklyReset },
          },
        },
      } as never
    }
  }

  const svc = new WeeklyArgonService(pool)
  const quotas = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)
  assert.ok(quotas)
  // Argon keeps its own weekly-only row; the stale seeded 5h value is healed
  // away, and the Gemini row is never used as a stand-in.
  assert.equal(quotas.argon?.weeklyFraction, 0.093, 'argon weekly comes from its own model row')
  assert.equal(quotas.argon?.remainingFraction, undefined, 'the stale 5h slot on argon is healed')
  assert.equal(
    quotas.google?.remainingFraction,
    0.924,
    'the argon model reading must not be filed under the Gemini 5-hour slot',
  )
  assert.equal(quotas.google?.weeklyFraction, 0.093)

  const stored = pool.getAccount(acc.id)!
  assert.equal(stored.quotas.argon?.weeklyFraction, 0.093, 'the stale argon reading does not survive')
  assert.equal(stored.quotas.argon?.remainingFraction, undefined, 'argon never carries a 5h slot')
  assert.equal(
    pool.isAccountEligible(stored, 'argon'),
    true,
    'weekly 9.3% is above the 5% weekly floor, so Argon must stay serviceable (gated by Gemini)',
  )
})

test('a retired Argon group releases its cooldown even when argon models synthesize a row', async () => {
  // Regression: the orphan-release branch was gated on
  // `summaryHasArgonGroup(...) || familyQuotas.argon`, but the model-level
  // fallback creates `familyQuotas.argon` for any account that lists argon
  // models — so the branch was unreachable in exactly the Pro -> Ultra fold it
  // was written for, and a cooldown taken against the retired pool survived.
  const { dir, pool } = makeTempPool('agy-quota-argonorphan-')
  const acc = pool.createAccountSlot('argon-orphan-user')

  writeAccountToken(acc.dir!, 'ya29.argonorphan')

  const weeklyReset = new Date(Date.now() + 2 * 3600_000).toISOString()
  pool.noteDedicatedGroup(acc.id, 'argon')
  pool.recordFailure(acc.id, 'argon', '429 Rate Limit', weeklyReset)

  class FoldedArgonService extends QuotaService {
    override async fetchUserInfo() {
      return { email: 'argonorphan@example.com' }
    }
    override async fetchQuotaSummary() {
      // No dedicated Argon group: the plan folded it into the Gemini bucket.
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: weeklyReset },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: weeklyReset },
            ],
          },
        ],
      } as never
    }
    override async fetchUserQuota() {
      return null
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon-high': {
            displayName: 'Gemini 4 Argon (High)',
            quotaInfo: { remainingFraction: 0.4, resetTime: weeklyReset },
          },
        },
      } as never
    }
  }

  const svc = new FoldedArgonService(pool)
  await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)

  const stored = pool.getAccount(acc.id)!
  assert.equal(stored.cooldowns.argon, undefined, 'the retired pool’s 429 cooldown must be released')
  assert.equal(pool.hasDedicatedGroup(acc.id, 'argon'), false, 'the family is no longer dedicated')
  assert.equal(stored.quotas.argon?.weeklyFraction, 0.4, 'argon keeps its own row from its own model reading')
  assert.equal(stored.quotas.argon?.remainingFraction, undefined)
})

test('agy 1.5.5: the Argon row comes from Argon’s own reading, not the Gemini bucket', async () => {
  // Live 2026-11-11 (agy 1.5.5): `/usage` returned only `Gemini Models` and
  // `Claude and GPT models` — no dedicated `Gemini 4 Argon` group. Argon and
  // Gemini are still SEPARATE quota books (.spec/quota-and-risk-control.md),
  // so the argon model nameplate's own reading becomes Argon's weekly row
  // instead of being re-homed under the Gemini family.
  const { dir, pool } = makeTempPool('agy-quota-argon-fold-')
  const acc = pool.createAccountSlot('argon-fold')
  // Seed a stale argon row from a previous (three-group) backend to prove it is
  // dropped once the summary stops reporting the dedicated group.
  pool.updateAccountQuotas(acc.id, { argon: { weeklyFraction: 1 } }, 'fold@gmail.com')

  writeAccountToken(acc.dir!, 'ya29.argon_fold')

  class NoArgonGroupService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string } | null> {
      return null
    }
    override async fetchUserQuota() {
      return null
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.997_889_5, resetTime: '2026-11-11T07:53:21Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.530_828_5, resetTime: '2026-11-14T01:18:35Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            buckets: [
              { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-11T08:07:09Z' },
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-18T03:07:09Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon-low': {
            displayName: 'Gemini 4 Argon (Low)',
            quotaInfo: { remainingFraction: 0.53, resetTime: '2026-11-14T01:18:35Z' },
          },
          'gemini-4-argon-high': {
            displayName: 'Gemini 4 Argon (High)',
            quotaInfo: { remainingFraction: 0.53, resetTime: '2026-11-14T01:18:35Z' },
          },
          'gemini-4-carbon-high': {
            displayName: 'Gemini 4 Carbon (High)',
            quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-11T07:53:21Z' },
          },
        },
      } as never
    }
  }

  const svc = new NoArgonGroupService(pool)
  const out = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, false)

  assert.equal(out?.argon?.weeklyFraction, 0.53, 'Argon weekly comes from its own model reading')
  assert.equal(out?.argon?.weeklyResetTime, '2026-11-14T01:18:35Z')
  assert.equal(out?.argon?.remainingFraction, undefined, 'Argon never takes a 5-hour slot')
  assert.equal(pool.getAccount(acc.id)!.quotas.argon?.weeklyFraction, 0.53, 'the stale row is replaced')
  assert.equal(out?.google?.weeklyFraction, 0.530_828_5, 'the Gemini bucket is untouched by Argon')
  assert.ok(
    out?.google?.models?.some((m) => m.modelId === 'gemini-4-carbon-high'),
    'Carbon lands under the Gemini family',
  )
  assert.equal(
    out?.google?.models?.some((m) => m.modelId.startsWith('gemini-4-argon')),
    false,
    'Argon model rows are no longer re-homed under Gemini',
  )
})

test('a dedicated Argon group still surfaces its own weekly pool (old backend)', async () => {
  // Guard against over-fixing: while the backend keeps returning a separate
  // `Gemini 4 Argon` group, its weekly row (and per-model detail) must survive.
  const { dir, pool } = makeTempPool('agy-quota-argon-group-')
  const acc = pool.createAccountSlot('argon-group')
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.8 } }, 'group@gmail.com')

  writeAccountToken(acc.dir!, 'ya29.argon_group')

  class DedicatedArgonGroupService extends QuotaService {
    override async fetchUserInfo(): Promise<{ email?: string } | null> {
      return null
    }
    override async fetchUserQuota() {
      return null
    }
    override async fetchQuotaSummary() {
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-11T07:53:21Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.7, resetTime: '2026-11-14T01:18:35Z' },
            ],
          },
          {
            displayName: 'Gemini 4 Argon',
            description: 'Gemini 4 Argon quota bucket',
            buckets: [
              { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-11-14T01:18:35Z' },
            ],
          },
        ],
      } as never
    }
    override async fetchAvailableModels() {
      return {
        models: {
          'gemini-4-argon-low': {
            displayName: 'Gemini 4 Argon (Low)',
            quotaInfo: { remainingFraction: 0.42, resetTime: '2026-11-14T01:18:35Z' },
          },
        },
      } as never
    }
  }

  const svc = new DedicatedArgonGroupService(pool)
  const out = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, false)

  assert.equal(out?.argon?.weeklyFraction, 0.42, 'the dedicated Argon weekly row survives')
  assert.ok(
    out?.argon?.models?.some((m) => m.modelId === 'gemini-4-argon-low'),
    'per-model Argon detail is still attached when the group exists',
  )
  assert.equal(
    pool.getAccount(acc.id)!.dedicatedGroups?.includes('argon'),
    true,
    'the account is remembered as Argon-capable',
  )
})
