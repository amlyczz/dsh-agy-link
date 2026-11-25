import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import type { AccountPoolManager } from '../../../src/host/pool.ts'
import {
  WarmupHistoryStore,
  WarmupService,
  detectSlidingIdleReset,
  dailyJitterMinutes,
  isDailyScheduleDue,
  isIntervalScheduleDue,
  planWarmupTargets,
} from '../../../src/host/warmup.ts'

function makeAccount(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id,
    alias: id,
    email: `${id}@example.com`,
    enabled: true,
    dir: '',
    systemHome: true,
    createdAt: Date.now(),
    cooldowns: {},
    quotas: {},
    ...overrides,
  }
}

describe('Slice 7: WarmupService 5h/daily/interval, sliding-idle detection & 50-entry audit log', () => {
  it('detects Antigravity sliding idle resetTime drift within ±5s on full quota and rejects active countdowns', () => {
    const t0 = Date.parse('2026-11-22T00:00:00Z')
    const r0 = '2026-11-22T05:00:00Z'
    const t1 = t0 + 60_000
    // Idle window: resetTime slides forward by ~60s (+1s jitter)
    const r1Idle = '2026-11-22T05:01:01Z'
    assert.equal(
      detectSlidingIdleReset(
        { resetTimeIso: r0, observedAtMs: t0, remainingFraction: 1.0 },
        { resetTimeIso: r1Idle, observedAtMs: t1, remainingFraction: 1.0 },
      ),
      true,
    )
    // Active window: resetTime stays fixed
    assert.equal(
      detectSlidingIdleReset(
        { resetTimeIso: r0, observedAtMs: t0, remainingFraction: 1.0 },
        { resetTimeIso: r0, observedAtMs: t1, remainingFraction: 1.0 },
      ),
      false,
    )
    // Partially used window: never considered idle
    assert.equal(
      detectSlidingIdleReset(
        { resetTimeIso: r0, observedAtMs: t0, remainingFraction: 0.9 },
        { resetTimeIso: r1Idle, observedAtMs: t1, remainingFraction: 0.9 },
      ),
      false,
    )
  })

  it('evaluates daily schedule with IANA timezone and fixed interval triggers accurately', () => {
    // 2026-11-22T00:15:00Z is 08:15 in Asia/Shanghai (UTC+8)
    const nowUtc = Date.parse('2026-11-22T00:15:00Z')
    const before = isDailyScheduleDue({ dailyTime: '08:30', timezone: 'Asia/Shanghai', now: nowUtc, lastFiredDayKey: null })
    assert.equal(before.due, false)

    const due = isDailyScheduleDue({ dailyTime: '08:00', timezone: 'Asia/Shanghai', now: nowUtc, lastFiredDayKey: null })
    assert.equal(due.due, true)
    assert.equal(due.dayKey, '2026-11-22')

    const alreadyFired = isDailyScheduleDue({ dailyTime: '08:00', timezone: 'Asia/Shanghai', now: nowUtc, lastFiredDayKey: '2026-11-22' })
    assert.equal(alreadyFired.due, false)

    assert.equal(isIntervalScheduleDue({ intervalHours: 6, now: nowUtc, lastRunAt: null }), true)
    assert.equal(isIntervalScheduleDue({ intervalHours: 6, now: nowUtc, lastRunAt: nowUtc - 3 * 3600_000 }), false)
    assert.equal(isIntervalScheduleDue({ intervalHours: 6, now: nowUtc, lastRunAt: nowUtc - 6 * 3600_000 }), true)
  })

  it('plans 5h rolling window targets and deduplicates weekly+5h probes for the same family/model', () => {
    const now = Date.parse('2026-11-22T00:00:00Z')
    const acc = makeAccount('pro-1', {
      quotas: {
        google: {
          remainingFraction: 1.0,
          resetTime: new Date(now + 5 * 3600_000).toISOString(),
          weeklyFraction: 1.0,
          weeklyResetTime: new Date(now + 7 * 24 * 3600_000).toISOString(),
        },
      },
    })

    const plan5h = planWarmupTargets({
      account: acc,
      force: false,
      configuredModels: ['gemini-3.8-flash'],
      windows: '5h',
      now,
      isCoolingDown: () => false,
    })
    assert.equal(plan5h.kind, 'targets')
    if (plan5h.kind === 'targets') {
      assert.equal(plan5h.targets.length, 1)
      assert.equal(plan5h.targets[0]?.window, '5h')
      assert.equal(plan5h.targets[0]?.historyKey, 'pro-1@example.com:google:5h')
    }

    const planBoth = planWarmupTargets({
      account: acc,
      force: false,
      configuredModels: ['gemini-3.8-flash'],
      windows: 'both',
      now,
      isCoolingDown: () => false,
    })
    assert.equal(planBoth.kind, 'targets')
    if (planBoth.kind === 'targets') {
      // Deduplicated into ONE CLI probe carrying both history keys
      assert.equal(planBoth.targets.length, 1)
      assert.equal(planBoth.targets[0]?.historyKey, 'pro-1@example.com:google:weekly')
      assert.deepEqual(planBoth.targets[0]?.extraHistoryKeys, ['pro-1@example.com:google:5h'])
    }
  })

  it('runs scheduled daily warmup via official CLI stub, detects sliding-idle windows, and caps audit history at 50 entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warmup-s7-'))
    try {
      const t0 = Date.parse('2026-11-22T00:00:00Z') // 08:00 Asia/Shanghai
      const acc = makeAccount('p1', {
        email: 'p1@example.com',
        quotas: {
          google: {
            remainingFraction: 1.0,
            resetTime: new Date(t0 + 2 * 3600_000).toISOString(), // not near 5h boundary unless sliding!
            weeklyFraction: 0.5,
          },
        },
      })
      const fakePool = {
        dir,
        getAccounts: () => [acc],
        getAccount: () => acc,
        markAuthRequired: () => {},
      } as unknown as AccountPoolManager

      let probes = 0
      const svc = new WarmupService(
        fakePool,
        undefined,
        () => '',
        () => '1.5.12',
        () => ({
          ...defaultConfig(),
          autoWarmup: true,
          warmupWindows: '5h',
          warmupDailyTime: '08:00',
          warmupTimezone: 'Asia/Shanghai',
          warmupModels: ['gemini-3.8-flash'],
        }),
        () => undefined,
        new WarmupHistoryStore(join(dir, 'history.json')),
        {
          runCliProbe: async () => {
            probes++
            return { code: 0, stdout: '{"type":"result","status":"OK","response":"hi"}\n', stderr: '', durationMs: 12 }
          },
        },
      )

      // Reading 1 at 07:50 Shanghai (before daily schedule) -> observes resetTime, does not fire
      const r0 = await svc.runScheduledWarmup(t0 - 10 * 60_000)
      assert.equal(r0.length, 0)
      assert.equal(probes, 0)

      // Reading 2 just after the daily anchor -> resetTime slides forward in
      // lockstep with the observation gap (idle window!) AND the daily schedule
      // is due. The anchor carries a deterministic per-day jitter (0–20 min), so
      // the reading and the slide both move by exactly that amount.
      const jitterMs = dailyJitterMinutes('2026-11-22') * 60_000
      const slideMs = 10 * 60_000 + jitterMs
      acc.quotas = {
        google: {
          remainingFraction: 1.0,
          resetTime: new Date(t0 + 2 * 3600_000 + slideMs).toISOString(),
          weeklyFraction: 0.5,
        },
      }
      const r1 = await svc.runScheduledWarmup(t0 + jitterMs)
      assert.equal(r1.length, 1)
      assert.equal(r1[0]?.success, true)
      assert.equal(probes, 1)
      assert.equal(svc.status().recentHistory?.[0]?.trigger, 'sliding-idle')

      // Running again same day does not re-fire daily schedule
      const r2 = await svc.runScheduledWarmup(t0 + jitterMs + 60_000)
      assert.equal(r2.length, 0)
      assert.equal(probes, 1)

      // Verify bounded 50-entry audit history cap
      for (let i = 0; i < 60; i++) {
        await svc.warmupAccount(acc, { force: true, model: 'gemini-3.8-flash' })
      }
      assert.equal(svc.status().recentHistory?.length, 50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
