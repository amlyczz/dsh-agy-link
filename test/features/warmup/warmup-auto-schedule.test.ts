// Scheduled (automatic) warmup: overlap, daily jitter and failure amplification.
//
// Three defects this pins, all of which only bite once autoWarmup is switched on:
//  1. The 5-minute scheduler only guarded ITS OWN ticks. A manual one-click run
//     lasts minutes (30–120s per account), so the next tick stacked a second
//     full-pool sweep on top of it — double probes, interleaved lastRun.
//  2. A daily anchor fired on the exact same minute every day: a machine-regular
//     pattern, which is the thing this whole subsystem exists to avoid.
//  3. A model the CLI reports as retired/unknown was treated as a transient
//     failure and retried every 30 minutes, forever (48 probes/day/family).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WarmupHistoryStore, WarmupService } from '../../../src/host/warmup.ts'
import { clampWarmupIntervalHours } from '../../../src/common/config.ts'
import { dailyJitterMinutes, isDailyScheduleDue } from '../../../src/features/warmup/schedule.ts'
import { isModelUnavailableError, MODEL_UNAVAILABLE_PARK_MS, planWarmupTargets } from '../../../src/features/warmup/policy.ts'
import { defaultConfig, type PluginConfig } from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import type { AccountPoolManager } from '../../../src/host/pool.ts'
import type { QuotaService } from '../../../src/host/quota.ts'
import type { WarmupCliDeps } from '../../../src/host/warmup.ts'

const OK_PROBE = {
  code: 0,
  stdout: '{"type":"result","subtype":"success","status":"OK","response":"hi"}\n',
  stderr: '',
  durationMs: 12,
}

function makeAccount(id: string, now: number, family: 'google' | 'anthropic' = 'google'): ManagedAccount {
  return {
    id,
    alias: id,
    email: `${id}@example.com`,
    dir: '',
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {
      [family]: {
        remainingFraction: 1,
        weeklyFraction: 1,
        weeklyResetTime: new Date(now + 7 * 24 * 3600_000).toISOString(),
      },
    },
  }
}

function makeService(opts: { accounts: ManagedAccount[]; cfg?: Partial<PluginConfig>; deps: WarmupCliDeps; dir: string }): WarmupService {
  const pool = {
    dir: opts.dir,
    getAccounts: () => opts.accounts,
    getAccount: (id: string) => opts.accounts.find((a) => a.id === id),
    markAuthRequired: () => undefined,
  }
  return new WarmupService(
    pool as unknown as AccountPoolManager,
    {} as QuotaService,
    () => '',
    () => '1.5.15',
    () => ({ ...defaultConfig(), autoWarmup: true, ...opts.cfg }) as PluginConfig,
    () => undefined,
    new WarmupHistoryStore(join(opts.dir, 'history.json')),
    opts.deps,
  )
}

test('a scheduled tick never stacks a second sweep on top of a running warmup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-auto-overlap-'))
  const now = Date.now()
  const account = makeAccount('a', now)
  const probes: string[] = []
  let releaseProbe: (() => void) | null = null
  try {
    const service = makeService({
      dir,
      accounts: [account],
      cfg: { warmupModels: ['gemini-3.8-flash'] },
      deps: {
        runCliProbe: async (acc) => {
          probes.push(acc.id)
          await new Promise<void>((resolve) => { releaseProbe = resolve })
          return OK_PROBE
        },
      },
    })
    const manual = service.warmupAccount(account, { force: true })
    while (probes.length === 0) await new Promise((r) => setTimeout(r, 2))
    assert.equal(service.isRunning(), true)

    const scheduled = await service.runScheduledWarmup()
    assert.deepEqual(scheduled, [], 'a scheduled tick must stand down while a run is in flight')

    releaseProbe!()
    await manual
    assert.deepEqual(probes, ['a'], 'exactly one probe: the overlap would have doubled it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the daily anchor fires inside a deterministic per-day jitter window', () => {
  const timezone = 'Asia/Shanghai'
  const anchor = Date.parse('2026-11-23T08:00:00+08:00')
  const dayKey = '2026-11-23'
  const jitter = dailyJitterMinutes(dayKey)
  assert.ok(jitter >= 0 && jitter <= 20, `jitter out of range: ${jitter}`)
  assert.equal(dailyJitterMinutes(dayKey), jitter, 'same day must resolve to the same delay')
  assert.notEqual(dailyJitterMinutes('2026-11-24'), undefined)

  // At the exact anchor the warmup only fires if this day's jitter is zero.
  const atAnchor = isDailyScheduleDue({ dailyTime: '08:00', timezone, now: anchor, lastFiredDayKey: null })
  assert.equal(atAnchor.due, jitter === 0)
  // Once the jitter window has passed it is due, and it is due only once a day.
  const afterWindow = isDailyScheduleDue({ dailyTime: '08:00', timezone, now: anchor + 21 * 60_000, lastFiredDayKey: null })
  assert.equal(afterWindow.due, true)
  const alreadyFired = isDailyScheduleDue({ dailyTime: '08:00', timezone, now: anchor + 22 * 60_000, lastFiredDayKey: dayKey })
  assert.equal(alreadyFired.due, false)
})

test('an upstream-retired model parks its family for a day instead of retrying every 30 min', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-park-'))
  const now = Date.now()
  const account = makeAccount('p', now, 'anthropic')
  try {
    const service = makeService({
      dir,
      accounts: [account],
      cfg: { warmupModels: ['claude-sonnet-5-5'] },
      deps: {
        runCliProbe: async () => ({ code: 1, stdout: '', stderr: 'Model is retired upstream: claude-sonnet-5-5', durationMs: 5 }),
      },
    })
    const results = await service.warmupAccount(account, { force: true })
    assert.equal(results[0]?.success, false)
    assert.equal(isModelUnavailableError(results[0]?.error ?? ''), true)
    assert.equal(
      service.history.checkCooldown('p@example.com:anthropic:parked', MODEL_UNAVAILABLE_PARK_MS, now + 60_000),
      true,
      'the family must be parked so the next tick does not re-probe it',
    )

    // The planner honours the park: nothing left to do for that family.
    const plan = planWarmupTargets({
      account,
      force: false,
      configuredModels: ['claude-sonnet-5-5'],
      windows: 'weekly',
      now: now + 60_000,
      isCoolingDown: (key, ms) => service.history.checkCooldown(key, ms, now + 60_000),
    })
    assert.equal(plan.kind, 'skip')

    // ...but a manual force still overrides it (the user may know better).
    const forced = planWarmupTargets({
      account,
      force: true,
      configuredModels: ['claude-sonnet-5-5'],
      windows: 'weekly',
      now: now + 60_000,
      isCoolingDown: (key, ms) => service.history.checkCooldown(key, ms, now + 60_000),
    })
    assert.equal(forced.kind, 'targets')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('schedule anchors survive a plugin reload (no double fire on the same day)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-anchor-daily-'))
  const t0 = Date.parse('2026-11-23T08:00:00+08:00')
  const probes: string[] = []
  try {
    const deps = { runCliProbe: async (acc: ManagedAccount) => { probes.push(acc.id); return OK_PROBE } }
    const account = makeAccount('d1', t0)
    const first = makeService({
      dir,
      accounts: [account],
      cfg: { warmupDailyTime: '08:00', warmupTimezone: 'Asia/Shanghai', warmupModels: ['gemini-3.8-flash'] },
      deps,
    })
    // Past the (deterministic, ≤20 min) jitter window.
    const run1 = await first.runScheduledWarmup(t0 + 21 * 60_000)
    assert.equal(run1.filter((r) => !r.skipped).length, 1)
    assert.equal(probes.length, 1)

    // Plugin reload: same state dir, brand-new service (in-memory anchors gone).
    const second = makeService({
      dir,
      accounts: [account],
      cfg: { warmupDailyTime: '08:00', warmupTimezone: 'Asia/Shanghai', warmupModels: ['gemini-3.8-flash'] },
      deps,
    })
    const run2 = await second.runScheduledWarmup(t0 + 30 * 60_000)
    assert.deepEqual(run2, [], 'the day is already done; a reload must not re-fire it')
    assert.equal(probes.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the interval anchor is durable, so a reload does not re-arm immediately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-anchor-interval-'))
  const t0 = Date.parse('2026-11-23T09:00:00+08:00')
  let probes = 0
  try {
    const deps = { runCliProbe: async () => { probes++; return OK_PROBE } }
    const account = makeAccount('i1', t0)
    const cfg = { warmupIntervalHours: 3, warmupModels: ['gemini-3.8-flash'] }
    const first = makeService({ dir, accounts: [account], cfg, deps })
    await first.runScheduledWarmup(t0)
    assert.equal(probes, 1, 'first tick has no anchor yet, so it fires')

    const second = makeService({ dir, accounts: [account], cfg, deps })
    await second.runScheduledWarmup(t0 + 60 * 60_000)
    assert.equal(probes, 1, 'one hour later is not due for a 3-hour interval')

    // …and the anchor is what says so, not the missing in-memory field.
    assert.equal(second.history.lastRecordedAt('schedule:interval'), t0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('warmupIntervalHours has a floor: 0 disables, positive values cannot go below 3h', () => {
  assert.equal(clampWarmupIntervalHours(0), 0)
  assert.equal(clampWarmupIntervalHours(-5), 0)
  assert.equal(clampWarmupIntervalHours(1), 3)
  assert.equal(clampWarmupIntervalHours(2), 3)
  assert.equal(clampWarmupIntervalHours(3), 3)
  assert.equal(clampWarmupIntervalHours(72), 72)
  assert.equal(clampWarmupIntervalHours(9_999), 168)
})
