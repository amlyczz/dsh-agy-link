import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGY_SSH_ISOLATION_VALUE, isolatedHomeEnv, supportsSshIsolation } from '../../src/runtime/agy/env.ts'
import { usageGroupsToFamilies } from '../../src/host/agy-usage.ts'
import { inferAccountPlanTier, resolveAccountPlanTier } from '../../src/common/plan-tier.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { PoolAuthFlow } from '../../src/host/pool-auth.ts'
import { QuotaService } from '../../src/host/quota.ts'
import {
  acquireCredentialSlot,
  SlotUnavailableError,
  writePrimaryCredential,
  type SlotIo,
} from '../../src/host/credential-slot.ts'
import { writeLastInstalledFingerprintAt } from '../../src/domain/credentials/docs.ts'

test('SSH_CONNECTION isolation: isolatedHomeEnv injects SSH_CONNECTION and supportsSshIsolation gates agy >= 1.5', () => {
  const env = isolatedHomeEnv('/tmp/acc-1')
  assert.equal(env.SSH_CONNECTION, AGY_SSH_ISOLATION_VALUE)
  assert.equal(supportsSshIsolation('1.5.0'), true)
  assert.equal(supportsSshIsolation('1.5.12'), true)
  assert.equal(supportsSshIsolation('2.0.0'), true)
  assert.equal(supportsSshIsolation('1.4.9'), false)
  assert.equal(supportsSshIsolation(null), false)
  assert.equal(supportsSshIsolation(''), false)
})

test('issue #130 & plan tier: the shared Gemini description naming Argon stays in google and no longer implies Ultra', () => {
  const groups = [
    {
      name: 'Gemini Models',
      description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-11-29T00:00:00Z' },
        { id: 'gemini-5h', window: '5h', remainingFraction: 0.85, resetTime: '2026-11-22T12:00:00Z' },
      ],
    },
  ]
  const fams = usageGroupsToFamilies(groups, 1000)
  assert.ok(fams.google)
  assert.equal(fams.argon, undefined)
  assert.equal(fams.google!.weeklyFraction, 0.9)
  assert.equal(fams.google!.remainingFraction, 0.85)
  // agy 1.5.15 lists Argon inside the shared group for EVERY paid plan (six Pro
  // accounts were badged Ultra because of this string, 2026-11-24), so the tier
  // is the paid default — Pro — until a real licence read says otherwise.
  assert.equal(inferAccountPlanTier({ groups, quotas: fams }), 'pro')
})

test('plan tier inference distinguishes Pro (dedicated Argon), Free (weekly-only / no_summary_access), and Enterprise', () => {
  const proGroups = [
    {
      name: 'Gemini Models',
      description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.55 },
        { id: 'gemini-5h', window: '5h', remainingFraction: 0.32 },
      ],
    },
    {
      name: 'Gemini 4 Argon',
      description: 'For paid Pro plans, Argon quota is separate.',
      buckets: [{ id: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 1 }],
    },
  ]
  assert.equal(inferAccountPlanTier({ groups: proGroups }), 'pro')

  const freeGroups = [
    {
      name: 'Gemini Models',
      description: 'Models within this group: Gemini 3.8 Flash',
      buckets: [{ id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.99 }],
    },
  ]
  assert.equal(inferAccountPlanTier({ groups: freeGroups }), 'free')

  // Legacy downgraded free account with stale dedicatedGroups but no_summary_access
  const downgradedFree: ManagedAccount = {
    id: 'acc_free',
    alias: 'ele',
    dir: '/tmp/ele',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: { google: { weeklyFraction: 0.44 } },
    dedicatedGroups: ['argon'],
    quotaUnavailable: { reason: 'no_summary_access', since: 1, retryAfter: Date.now() + 60_000 },
  }
  assert.equal(resolveAccountPlanTier(downgradedFree), 'free')

  const entGroups = [{ name: 'Enterprise Gemini', description: 'Google Workspace Enterprise tier', buckets: [] }]
  assert.equal(inferAccountPlanTier({ groups: entGroups }), 'enterprise')
})

test('issue #143: free-account 3p-5h epoch-zero sentinel (1970-01-01) is stripped so cards show weekly-only quotas', () => {
  const groups = [
    {
      name: 'Gemini Models',
      description: 'Models within this group: Gemini 3.8 Flash',
      buckets: [
        { id: 'gemini-weekly', window: 'weekly', remainingFraction: 0.989, resetTime: '2026-11-29T05:43:25Z' },
      ],
    },
    {
      name: 'Claude and GPT models',
      description: 'Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B',
      buckets: [
        { id: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-28T06:06:16Z' },
        { id: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '1970-01-01T00:00:00Z' },
      ],
    },
  ]
  const fam = usageGroupsToFamilies(groups)
  assert.equal(fam.google?.remainingFraction, undefined)
  assert.equal(fam.google?.weeklyFraction, 0.989)
  assert.equal(fam.anthropic?.remainingFraction, undefined)
  assert.equal(fam.anthropic?.weeklyFraction, 1)
  assert.equal(fam.openai?.remainingFraction, undefined)
  assert.equal(fam.openai?.weeklyFraction, 1)
  assert.equal(fam.argon, undefined)
  assert.equal(inferAccountPlanTier({ groups, quotas: fam }), 'free')
})

test('issue #145: respectExternalSignIn protects a newer external standalone AGY sign-in before & during lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-slot-145-'))
  try {
    const primaryRaw = JSON.stringify({ token: { access_token: 'a1', refresh_token: 'ref-A', expiry: '2099-01-01T00:00:00Z' } })
    const externalRaw = JSON.stringify({ token: { access_token: 'b1', refresh_token: 'ref-B', expiry: '2099-01-01T00:00:00Z' } })
    const secRaw = JSON.stringify({ token: { access_token: 'c1', refresh_token: 'ref-C', expiry: '2099-01-01T00:00:00Z' } })
    writePrimaryCredential({ raw: primaryRaw, email: 'a@example.com', savedAt: Date.now() }, dir)
    writeLastInstalledFingerprintAt(primaryRaw, dir)

    // Case 1: External sign-in B happens BEFORE acquiring primary lease
    let slotValue: string | null = externalRaw
    const io: SlotIo = {
      platform: 'win32',
      readSlot: () => slotValue,
      writeSlot: (raw) => { slotValue = raw; return true },
      identify: async () => 'a@example.com',
    }
    const primaryAcc: ManagedAccount = {
      id: 'acc_primary', alias: 'Primary', dir: '', systemHome: true, email: 'a@example.com',
      enabled: true, createdAt: 1, cooldowns: {}, quotas: {},
    }

    await assert.rejects(
      () => acquireCredentialSlot(primaryAcc, undefined, { baseDir: dir, homeDir: dir, io, respectExternalSignIn: true }),
      (err: unknown) => err instanceof SlotUnavailableError && err.target === 'primary',
    )
    // External sign-in B was NOT overwritten!
    assert.equal(slotValue, externalRaw)

    // Case 2: External sign-in B happens DURING a secondary lease -> finally preserves B instead of overwriting with A
    const secDir = join(dir, 'sec')
    mkdirSync(join(secDir, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(join(secDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), secRaw, 'utf8')
    const secAcc: ManagedAccount = {
      id: 'acc_sec', alias: 'Sec', dir: secDir, email: 'c@example.com',
      enabled: true, createdAt: 1, cooldowns: {}, quotas: {},
    }
    slotValue = primaryRaw
    const lease = await acquireCredentialSlot(secAcc, undefined, { baseDir: dir, homeDir: dir, io, respectExternalSignIn: true })
    assert.ok(lease)
    assert.equal(slotValue, secRaw)
    // Simulate user signing into standalone AGY as B while secondary lease is held
    slotValue = externalRaw
    lease!.release()
    assert.equal(slotValue, externalRaw, 'external sign-in during secondary lease must be preserved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue #152 part 2: re-authenticating primary with a different Google account resets stale custom alias', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-152-p2-'))
  try {
    const pool = new AccountPoolManager(dir)
    const primary = pool.getAccounts()[0]!
    pool.updateAccountQuotas(primary.id, { google: { weeklyFraction: 0.5 } }, 'old@gmail.com')
    pool.setAccountAlias(primary.id, 'Old Custom Name')
    assert.equal(pool.getAccount(primary.id)?.alias, 'Old Custom Name')
    assert.equal(pool.getAccount(primary.id)?.defaultAlias, false)

    const quota = new QuotaService(pool, () => '', () => '1.5.12')
    quota.refreshAccountQuota = async () => null
    const auth = new PoolAuthFlow(pool, quota, () => {}, {
      openBrowser: async () => false,
      exchangeCode: async () => ({
        access_token: 'tok-new',
        refresh_token: 'ref-new',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
      fetchUserEmail: async () => 'new@gmail.com',
      // Never the real Windows slot / login keychain: they are machine-wide.
      writeSlot: () => true,
      writeKeyring: () => true,
    })
    const started = await auth.beginPrimary()
    assert.equal(started.ok, true)
    // beginPrimary() targets the real home; write the token file into the temp dir instead.
    ;(auth as any).flow.dir = dir
    const stateParam = new URL(started.url!).searchParams.get('state')!
    const done = await auth.submitCode(`http://localhost/cb?code=abc123&state=${encodeURIComponent(stateParam)}`)
    assert.equal(done.ok, true)

    const updated = pool.getAccount(primary.id)!
    assert.equal(updated.email, 'new@gmail.com')
    assert.equal(updated.defaultAlias, true)
    assert.equal(updated.alias, 'Primary account (system sign-in)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
