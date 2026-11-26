import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig, type PluginConfig } from '../../src/common/types.ts'
import { isFamilyCooling } from '../../src/common/quota-bench.ts'
import { baseModelSlug, type ManagedAccount } from '../../src/common/pool-types.ts'
import { COOLDOWN_FRESH_GRACE_MS, reconcileCooldownsFromQuota } from '../../src/domain/accounts/cooldown-reconcile.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { WarmupHistoryStore, WarmupService } from '../../src/host/warmup.ts'

const SHARED_GEMINI_DESC =
  'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash'

test('updateAccountQuotas clears stale cooldown when fresh 100% quota arrives (screenshot regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cd-reconcile-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('jack')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3_600_000 + 16 * 60_000).toISOString()
    const reset7d = new Date(now + 7 * 86_400_000 - 44 * 60_000).toISOString()

    // Simulate legacy/older cooldown without recordedAt (or older than grace window)
    // alongside an already-100% cached row before the next sync runs.
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 1,
        resetTime: reset5h,
        weeklyFraction: 1,
        weeklyResetTime: reset7d,
        updatedAt: now - 60_000,
      },
    })
    pool.getAccount(acc.id)!.cooldowns.google = {
      cooldownUntil: now + 30 * 60_000,
      reason: '429 Rate Limit',
      consecutiveFailures: 2,
    }
    assert.equal(isFamilyCooling(pool.getAccount(acc.id)!, 'google', now), true)

    // Fresh sync reports 100% on both 5h and weekly windows -> cooldown cleared.
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 1,
        resetTime: reset5h,
        weeklyFraction: 1,
        weeklyResetTime: reset7d,
        updatedAt: now + 1000,
      },
    })

    const updated = pool.getAccount(acc.id)!
    assert.equal(updated.cooldowns.google, undefined)
    assert.equal(isFamilyCooling(updated, 'google', now + 1000), false)
    assert.equal(pool.explainIneligibility(updated, 'google', now + 1000), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateAccountQuotas clears cooldown immediately on window rollover even if new quota < 100%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cd-rollover-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('rollover')
    const now = Date.now()
    const oldReset5h = new Date(now + 30 * 60_000).toISOString()
    const newReset5h = new Date(now + 5 * 3_600_000).toISOString()
    const reset7d = new Date(now + 6 * 86_400_000).toISOString()

    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 0,
        resetTime: oldReset5h,
        weeklyFraction: 0.8,
        weeklyResetTime: reset7d,
        updatedAt: now - 1000,
      },
    })
    pool.recordFailure(acc.id, 'google', '429 Rate Limit')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), 'cooldown')

    // Window rolled over to +5h and recovered to 85% within seconds of the 429
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 0.85,
        resetTime: newReset5h,
        weeklyFraction: 0.8,
        weeklyResetTime: reset7d,
        updatedAt: Date.now() + 50,
      },
    })

    assert.equal(pool.getAccount(acc.id)!.cooldowns.google, undefined)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'google'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reconcileCooldownsFromQuota preserves fresh 429s, partial-weekly-exhausted rows, and stale fallbacks', () => {
  const now = Date.now()
  const reset5h = new Date(now + 4 * 3_600_000).toISOString()
  const reset7d = new Date(now + 6 * 86_400_000).toISOString()

  // 1. Brand-new 429 (< 2m grace) on unchanged 100% snapshot stays protected
  const freshAcc: ManagedAccount = {
    id: 'a1',
    alias: 'A1',
    dir: '',
    enabled: true,
    createdAt: now,
    cooldowns: {
      google: { cooldownUntil: now + 900_000, reason: '429', consecutiveFailures: 1, recordedAt: now - 5_000 },
    },
    quotas: {
      google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now + 100 },
    },
  }
  const changedFresh = reconcileCooldownsFromQuota(
    freshAcc,
    { google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now - 10_000 } },
    freshAcc.quotas,
    now,
  )
  assert.equal(changedFresh, false)
  assert.ok(freshAcc.cooldowns.google)

  // After grace period passes, a 100% refresh clears it
  const changedAfterGrace = reconcileCooldownsFromQuota(
    freshAcc,
    { google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now + 100 } },
    { google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now + COOLDOWN_FRESH_GRACE_MS + 1000 } },
    now + COOLDOWN_FRESH_GRACE_MS + 1000,
  )
  assert.equal(changedAfterGrace, true)
  assert.equal(freshAcc.cooldowns.google, undefined)

  // 2. 5h=100% while weekly=2% keeps cooldown (not all windows recovered)
  const weeklyLowAcc: ManagedAccount = {
    id: 'a2',
    alias: 'A2',
    dir: '',
    enabled: true,
    createdAt: now,
    cooldowns: {
      google: { cooldownUntil: now + 900_000, reason: '429', consecutiveFailures: 1 },
    },
    quotas: {
      google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 0.02, weeklyResetTime: reset7d, updatedAt: now + 100 },
    },
  }
  assert.equal(reconcileCooldownsFromQuota(weeklyLowAcc, {}, weeklyLowAcc.quotas, now), false)
  assert.ok(weeklyLowAcc.cooldowns.google)

  // 3. Partial fallback under quotaUnavailable does not clear cooldown
  const partialAcc: ManagedAccount = {
    id: 'a3',
    alias: 'A3',
    dir: '',
    enabled: true,
    createdAt: now,
    quotaUnavailable: { reason: 'partial', since: now - 10_000, retryAfter: now + 60_000 },
    cooldowns: {
      google: { cooldownUntil: now + 900_000, reason: '429', consecutiveFailures: 1 },
    },
    quotas: {
      google: { remainingFraction: 1, resetTime: reset5h, updatedAt: now + 100 },
    },
  }
  assert.equal(reconcileCooldownsFromQuota(partialAcc, {}, partialAcc.quotas, now), false)
  assert.ok(partialAcc.cooldowns.google)
})

test('shared Argon peer cooldown is cleared by both 100% google quota refresh and clearCooldown("google") even when quotas.argon exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-shared-cd-clear-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('SharedArgon')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3_600_000).toISOString()
    const reset7d = new Date(now + 6 * 86_400_000).toISOString()

    pool.updateAccountQuotas(acc.id, {
      google: { remainingFraction: 0.5, resetTime: reset5h, weeklyFraction: 0.5, weeklyResetTime: reset7d, description: SHARED_GEMINI_DESC, updatedAt: now },
      argon: { weeklyFraction: 0.5, weeklyResetTime: reset7d, description: SHARED_GEMINI_DESC, updatedAt: now },
    })
    // Even if only argon has a cooldown, clearCooldown(id, 'google', true) must drop both
    pool.getAccount(acc.id)!.cooldowns.argon = { cooldownUntil: now + 600_000, reason: '429', consecutiveFailures: 1 }
    assert.equal(isFamilyCooling(pool.getAccount(acc.id)!, 'google', now), true)

    pool.clearCooldown(acc.id, 'google', true)
    assert.equal(pool.getAccount(acc.id)!.cooldowns.argon, undefined)
    assert.equal(isFamilyCooling(pool.getAccount(acc.id)!, 'google', now), false)

    // And fresh 100% google quota clears shared argon peer cooldown as well
    pool.getAccount(acc.id)!.cooldowns.argon = { cooldownUntil: now + 600_000, reason: '429', consecutiveFailures: 1 }
    pool.updateAccountQuotas(acc.id, {
      google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, description: SHARED_GEMINI_DESC, updatedAt: now + 1000 },
    })
    assert.equal(pool.getAccount(acc.id)!.cooldowns.argon, undefined)
    assert.equal(isFamilyCooling(pool.getAccount(acc.id)!, 'google', now + 1000), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('modelCooldowns are reconciled when fresh model-level quota recovers to 100%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-model-cd-reconcile-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('Img')
    const now = Date.now()
    const imgModel = 'gemini-3.1-flash-image'

    pool.recordModelFailure(acc.id, imgModel, 'capacity exhausted', new Date(now + 4 * 3_600_000).toISOString())
    assert.equal(pool.isAccountEligibleForModel(pool.getAccount(acc.id)!, 'google', imgModel), false)

    // Same window after grace period with 100% model quota -> clears model cooldown
    const imgSlug = baseModelSlug(imgModel)
    pool.getAccount(acc.id)!.modelCooldowns![imgSlug]!.recordedAt = now - COOLDOWN_FRESH_GRACE_MS - 1000
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 1,
        weeklyFraction: 1,
        updatedAt: now + 100,
        models: [{ modelId: imgModel, remainingFraction: 1, resetTime: new Date(now + 5 * 3_600_000).toISOString() }],
      },
    })

    assert.equal(pool.getAccount(acc.id)!.modelCooldowns?.[imgSlug], undefined)
    assert.equal(pool.isAccountEligibleForModel(pool.getAccount(acc.id)!, 'google', imgModel), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('WarmupService clears family and model cooldown when a probe succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-warmup-clear-cd-'))
  try {
    const pool = new AccountPoolManager(join(dir, 'pool'))
    const acc = pool.createAccountSlot('WarmupAcc')
    const now = Date.now()
    pool.updateAccountQuotas(acc.id, {
      google: {
        remainingFraction: 1,
        weeklyFraction: 1,
        weeklyResetTime: new Date(now - 60_000).toISOString(),
        updatedAt: now - 1000,
      },
    })
    pool.recordFailure(acc.id, 'google', '429 Rate Limit')
    pool.recordModelFailure(acc.id, 'gemini-3.8-flash', '429')
    assert.equal(isFamilyCooling(pool.getAccount(acc.id)!, 'google', now), true)

    const svc = new WarmupService(
      pool,
      undefined,
      () => '',
      () => '1.5.15',
      () => ({ ...defaultConfig(), warmupModels: ['gemini-3.8-flash'] }) as PluginConfig,
      () => undefined,
      new WarmupHistoryStore(join(dir, 'warmup-history.json')),
      {
        bin: () => '/fake/agy',
        runCliProbe: async () => ({
          code: 0,
          stdout: '{"event":"result","result":{"status":"OK","response":"hi","usage":{"total_tokens":10}}}\n',
          stderr: '',
          durationMs: 20,
        }),
      },
    )

    const res = await svc.warmupAccount(pool.getAccount(acc.id)!, { force: true })
    assert.equal(res[0]?.success, true)
    assert.equal(pool.getAccount(acc.id)!.cooldowns.google, undefined)
    assert.equal(pool.getAccount(acc.id)!.modelCooldowns?.['gemini-3-8-flash'], undefined)
    assert.equal(isFamilyCooling(pool.getAccount(acc.id)!, 'google', Date.now()), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
