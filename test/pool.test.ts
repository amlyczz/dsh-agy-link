import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFamilyOf, needsAuthReverify, shouldPollAccount } from '../src/common/pool-types.ts'
import { AccountPoolManager, defaultPoolDir } from '../src/host/pool.ts'

test('modelFamilyOf correctly categorizes models', () => {
  assert.equal(modelFamilyOf('gemini-3.7-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-3.6-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-3.1-pro'), 'google')
  assert.equal(modelFamilyOf('gemma-2-9b'), 'google')
  // Gemini 4 Argon bills its own weekly pool — never the plain Gemini family.
  assert.equal(modelFamilyOf('gemini-4-argon'), 'argon')
  assert.equal(modelFamilyOf('gemini-4-argon-low'), 'argon')
  assert.equal(modelFamilyOf('gemini-4-argon-medium'), 'argon')
  assert.equal(modelFamilyOf('gemini-4-argon-high'), 'argon')
  assert.equal(modelFamilyOf('claude-sonnet-4-6'), 'anthropic')
  assert.equal(modelFamilyOf('claude-3-7-sonnet'), 'anthropic')
  assert.equal(modelFamilyOf('claude-opus-4-6-thinking'), 'anthropic')
  assert.equal(modelFamilyOf('gpt-oss-120b-medium'), 'openai')
  assert.equal(modelFamilyOf('openai/gpt-4o'), 'openai')
  assert.equal(modelFamilyOf('custom-other-model'), 'unknown')
  assert.equal(modelFamilyOf(undefined), 'unknown')
})

test('load() falls back to the last-good snapshot when pool.json is torn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-lastgood-'))
  const pool = new AccountPoolManager(dir)
  const ids = pool.getAccounts().map((a) => a.id)
  pool.markAccountActive(ids[0]!) // force a persist so pool.json.last-good exists
  // A concurrent host process truncating the file used to leave the user with
  // an empty account pool; the last good snapshot must win instead.
  writeFileSync(join(dir, 'pool.json'), '{"accounts":[{"id":"a1')
  const reloaded = new AccountPoolManager(dir)
  assert.deepEqual(reloaded.getAccounts().map((a) => a.id), ids)
  assert.ok(existsSync(join(dir, 'pool.json.last-good')), 'a last-good snapshot is kept next to pool.json')
})

test('persist never reuses the fixed .pool.json.tmp name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-tmp-'))
  const pool = new AccountPoolManager(dir)
  writeFileSync(join(dir, '.pool.json.tmp'), 'sentinel')
  pool.markAccountActive(pool.getAccounts()[0]!.id)
  assert.equal(readFileSync(join(dir, '.pool.json.tmp'), 'utf8'), 'sentinel', 'a foreign fixed-name tmp is never written')
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), ['.pool.json.tmp'], 'no tmp litter is left behind')
})

test('markAccountActive records exactly one in-use account and persists it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-active-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  assert.equal(pool.getPoolData().lastActiveAccountId, undefined, 'nothing in use before the first spawn')

  pool.markAccountActive(a.id)
  assert.equal(pool.getPoolData().lastActiveAccountId, a.id)

  // A reload from disk must see the same single pointer.
  const reloaded = new AccountPoolManager(dir)
  assert.equal(reloaded.getPoolData().lastActiveAccountId, a.id)

  // Moving to another account leaves exactly one active account (no per-family fan-out).
  const b = reloaded.createAccountSlot('Second')
  reloaded.markAccountActive(b.id)
  assert.equal(reloaded.getPoolData().lastActiveAccountId, b.id)
  const data = reloaded.getPoolData()
  const activeIds = [data.lastActiveAccountId, ...Object.values(data.activeAccountIds ?? {})].filter(
    (id): id is string => typeof id === 'string',
  )
  assert.equal(activeIds.includes(b.id), true)
})

test('AccountPoolManager bootstraps and manages isolated account slots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-test-'))
  const pool = new AccountPoolManager(dir)

  const accounts = pool.getAccounts()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0]?.id, 'acc_primary')
  // Primary rides the real system HOME: no isolated dir, Keychain keeps
  // agy signed in. Only secondary accounts get isolated directories.
  assert.equal(accounts[0]?.systemHome, true)
  assert.equal(accounts[0]?.dir, '')
  assert.ok(existsSync(join(dir, 'pool.json')))

  // Create new account slot
  const acc2 = pool.createAccountSlot('Account B')
  assert.equal(pool.getAccounts().length, 2)
  assert.equal(acc2.alias, 'Account B')
  assert.ok(existsSync(acc2.dir))

  // Set proxy override
  pool.setAccountProxy(acc2.id, 'http://127.0.0.1:7890')
  assert.equal(pool.getAccount(acc2.id)?.proxyUrl, 'http://127.0.0.1:7890')

  // Set primary
  pool.setPrimaryAccount(acc2.id)
  assert.equal(pool.getPoolData().primaryAccountId, acc2.id)
  assert.equal(pool.getAccounts()[0]?.id, acc2.id)

  // Persistence across manager instances
  const pool2 = new AccountPoolManager(dir)
  assert.equal(pool2.getAccounts().length, 2)
  assert.equal(pool2.getPoolData().primaryAccountId, acc2.id)

  // Delete account
  pool2.deleteAccount(acc2.id)
  assert.equal(pool2.getAccounts().length, 1)
  assert.ok(!existsSync(acc2.dir))
})

test('blank aliases persist only canonical server defaults and carry a display-only marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-default-alias-'))
  const pool = new AccountPoolManager(dir)
  const staged = pool.createStagingSlot()
  const account = pool.commitStagingAccount(staged.id, staged.dir)
  assert.equal(account.alias, 'Backup Google account 2')
  assert.equal(account.defaultAlias, true)
  const persisted = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8'))
  assert.equal(persisted.accounts[1].alias, 'Backup Google account 2')
  assert.equal(persisted.accounts[1].defaultAlias, true)
  assert.doesNotMatch(persisted.accounts[1].alias, /Conta Google reserva|Cuenta de Google de respaldo|备用 Google/)
})

test('loading legacy primary aliases never rewrites account data for localization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-primary-alias-'))
  writeFileSync(join(dir, 'pool.json'), JSON.stringify({
    version: 1, mode: 'sequential', defaultCooldownMs: 900000, maxCooldownMs: 3600000,
    primaryAccountId: 'acc_primary', accounts: [{ id: 'acc_primary', alias: '主账号 (系统登录)', dir: '', systemHome: true, enabled: true, createdAt: 1, cooldowns: {}, quotas: {} }],
  }), 'utf8')
  const before = readFileSync(join(dir, 'pool.json'), 'utf8')
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccount('acc_primary')!
  assert.equal(primary.alias, '主账号 (系统登录)')
  assert.equal(primary.defaultAlias, undefined)
  assert.equal(readFileSync(join(dir, 'pool.json'), 'utf8'), before)
  pool.setAccountAlias('acc_primary', 'Primary account (system sign-in)')
  const reloaded = new AccountPoolManager(dir).getAccount('acc_primary')!
  assert.equal(reloaded.alias, 'Primary account (system sign-in)')
  assert.equal(reloaded.defaultAlias, false)
})

test('Sequential Drain: family-scoped rate limit fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-drain-'))
  const pool = new AccountPoolManager(dir)
  const accA = pool.getAccounts()[0]!
  const accB = pool.createAccountSlot('Account B')
  const accC = pool.createAccountSlot('Account C')

  // Both Gemini and Claude initially pick Account A
  assert.equal(pool.selectAccount('anthropic')?.id, accA.id)
  assert.equal(pool.selectAccount('google')?.id, accA.id)

  // Account A hits 429 on Claude
  pool.recordFailure(accA.id, 'anthropic', '429 Rate Limit')

  // Claude requests fail over to Account B!
  assert.equal(pool.selectAccount('anthropic')?.id, accB.id)

  // Gemini requests still use Account A (family isolation!)
  assert.equal(pool.selectAccount('google')?.id, accA.id)

  // Account B hits 429 on Claude with a future reset time
  const futureReset = new Date(Date.now() + 300_000).toISOString()
  pool.recordFailure(accB.id, 'anthropic', '429 Rate Limit', futureReset)

  // Claude requests fail over to Account C!
  assert.equal(pool.selectAccount('anthropic')?.id, accC.id)

  // Account C hits 429 on Claude
  pool.recordFailure(accC.id, 'anthropic', '429 Rate Limit')

  // All accounts are in cooldown for Claude
  assert.equal(pool.selectAccount('anthropic'), null)
  const countdown = pool.getEarliestResetCountdown('anthropic')
  assert.ok(typeof countdown === 'number' && countdown > 0)

  // Clearing cooldown on Account A restores it
  pool.clearCooldown(accA.id, 'anthropic')
  assert.equal(pool.selectAccount('anthropic')?.id, accA.id)
})

test('Sticky Sequential Drain: stays on current active account until it runs out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-sticky-'))
  const pool = new AccountPoolManager(dir)
  const accA = pool.getAccounts()[0]!
  const accB = pool.createAccountSlot('Account B')
  const accC = pool.createAccountSlot('Account C')

  // 1. Initial request picks Account A
  assert.equal(pool.selectAccount('google')?.id, accA.id)

  // 2. Account A runs out of quota (hits 429) -> failover to Account B
  pool.recordFailure(accA.id, 'google', '429 Rate Limit')
  assert.equal(pool.selectAccount('google')?.id, accB.id)

  // 3. User continues chatting with Account B
  assert.equal(pool.selectAccount('google')?.id, accB.id)

  // 4. Now Account A recovers its quota / cooldown expires!
  pool.clearCooldown(accA.id, 'google')

  // 5. CRITICAL: Account B is still healthy and in-use, so it MUST stay on Account B!
  assert.equal(pool.selectAccount('google')?.id, accB.id)

  // 6. Only when Account B runs out of quota does it move to Account C
  pool.recordFailure(accB.id, 'google', '429 Rate Limit')
  assert.equal(pool.selectAccount('google')?.id, accC.id)

  // 7. When Account C also runs out, and A is recovered, it wraps back to Account A
  pool.recordFailure(accC.id, 'google', '429 Rate Limit')
  assert.equal(pool.selectAccount('google')?.id, accA.id)
})

test('Corrupt pool.json recovers gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-corrupt-'))
  writeFileSync(join(dir, 'pool.json'), '{ broken json', 'utf8')
  const pool = new AccountPoolManager(dir)
  assert.equal(pool.getAccounts().length, 1)
  assert.equal(pool.getAccounts()[0]?.id, 'acc_primary')
})

import { parseResetDurationMs } from '../src/common/types.ts'

test('parseResetDurationMs parses various rate limit durations', () => {
  // Compact durations
  assert.equal(parseResetDurationMs('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 21m25s.'), 1285000)
  assert.equal(parseResetDurationMs('Rate limited. Resets in 2h26m6s.'), 8766000)
  assert.equal(parseResetDurationMs('Resets in 3m30s'), 210000)
  assert.equal(parseResetDurationMs('resets in 45s'), 45000)
  assert.equal(parseResetDurationMs('Resets in 1h'), 3600000)

  // Word-based durations
  assert.equal(parseResetDurationMs('Resets in 15 minutes'), 900000)
  assert.equal(parseResetDurationMs('retry after 30 seconds'), 30000)
  assert.equal(parseResetDurationMs('resets in 2 hours'), 7200000)

  // Invalid / empty
  assert.equal(parseResetDurationMs(undefined), undefined)
  assert.equal(parseResetDurationMs(''), undefined)
  assert.equal(parseResetDurationMs('regular error message without reset info'), undefined)
})

test('recordFailure parses reset duration from error text and sets safety buffer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-reset-'))
  const pool = new AccountPoolManager(dir)
  const accA = pool.getAccounts()[0]!

  // Record failure with reset text
  const errText = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 21m25s.'
  const t0 = Date.now()
  pool.recordFailure(accA.id, 'google', errText)

  const cd = pool.getAccount(accA.id)?.cooldowns.google
  assert.ok(cd)
  // Expected cooldown = now + 1285s + 10s buffer
  const expectedMin = t0 + 1295 * 1000 - 500
  const expectedMax = t0 + 1295 * 1000 + 5000
  assert.ok(cd.cooldownUntil >= expectedMin && cd.cooldownUntil <= expectedMax)
})

import { getAccountHealth } from '../src/common/pool-types.ts'

test('primary slot is re-bootstrapped when missing while other accounts remain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-primary-reboot-'))
  // Simulate the broken on-disk state: user deleted the primary slot while
  // an isolated account remained (old code never recreated it).
  const orphan = {
    id: 'acc_1787000000000_xx',
    alias: 'orphan',
    dir: join(dir, 'acc_1787000000000_xx'),
    enabled: true,
    createdAt: 1787000000000,
    cooldowns: {},
    quotas: {},
    email: 'old.pool.account@gmail.com',
  }
  writeFileSync(
    join(dir, 'pool.json'),
    JSON.stringify({ version: 1, mode: 'sequential', defaultCooldownMs: 900000, maxCooldownMs: 3600000, accounts: [orphan], primaryAccountId: orphan.id }),
    'utf8',
  )

  const pool = new AccountPoolManager(dir)
  const accounts = pool.getAccounts()
  assert.equal(accounts.length, 2)
  // Primary recreated at the FRONT and marked as the pool primary.
  assert.equal(accounts[0]?.id, 'acc_primary')
  assert.equal(accounts[0]?.systemHome, true)
  assert.equal(pool.getPoolData().primaryAccountId, 'acc_primary')
  // The isolated account is untouched.
  assert.equal(accounts[1]?.id, orphan.id)
  assert.equal(accounts[1]?.email, 'old.pool.account@gmail.com')
})

test('resetAccountIdentity clears identity-bound state on external re-login', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-identity-reset-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('switched')

  // Simulate the old account going down hard before the user re-logged in:
  pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 2h26m6s.')
  pool.markAuthRequired(acc.id, 'invalid_grant')
  pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0, updatedAt: Date.now() } }, 'old.account@gmail.com')
  const flagged = pool.getAccount(acc.id)!
  assert.equal(flagged.email, 'old.account@gmail.com')
  assert.equal(flagged.authRequired, true)
  assert.ok(flagged.cooldowns.google)
  assert.ok(flagged.quotas.google)
  assert.equal(shouldPollAccount(flagged), false)

  // External re-login detected from logs → full identity reset.
  pool.resetAccountIdentity(acc.id, 'new.account@gmail.com')
  const fresh = pool.getAccount(acc.id)!
  assert.equal(fresh.email, 'new.account@gmail.com')
  assert.equal(fresh.authRequired, undefined)
  assert.equal(fresh.authError, undefined)
  assert.deepEqual(fresh.cooldowns, {})
  assert.deepEqual(fresh.quotas, {})
  // Slot config survives the switch.
  assert.equal(fresh.id, acc.id)
  assert.equal(fresh.enabled, true)
  // And the slot is pollable/selectable again immediately.
  assert.equal(shouldPollAccount(fresh), true)
  // (silence the bootstrapped primary so our slot is the sole candidate)
  pool.setAccountEnabled('acc_primary', false)
  const picked = pool.selectAccount('google')
  assert.equal(picked?.id, acc.id)
})

test('markAuthRequired quarantines broken accounts from selectAccount', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-auth-'))
  const pool = new AccountPoolManager(dir)
  const accA = pool.getAccounts()[0]!
  const accB = pool.createAccountSlot('Account B')

  assert.equal(pool.selectAccount('google')?.id, accA.id)

  // Mark A as auth required (token revoked/invalid_grant)
  pool.markAuthRequired(accA.id, 'invalid_grant: Token expired')
  const accAUpdated = pool.getAccount(accA.id)!
  assert.equal(accAUpdated.authRequired, true)

  const healthA = getAccountHealth(accAUpdated, 'google')
  assert.equal(healthA.status, 'auth_required')

  // Pool automatically bypasses account A and selects account B
  assert.equal(pool.selectAccount('google')?.id, accB.id)

  // When A is re-authenticated or cleared, it recovers
  pool.clearAuthRequired(accA.id)
  assert.equal(pool.getAccount(accA.id)?.authRequired, undefined)
})

test('sweepOldLogs sweeps log files older than retention days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-logs-'))
  const pool = new AccountPoolManager(dir)
  const accB = pool.createAccountSlot('Account B')

  const logDir = join(accB.dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })

  const oldLog = join(logDir, 'cli-old.log')
  const freshLog = join(logDir, 'cli-fresh.log')
  writeFileSync(oldLog, 'old log data', 'utf8')
  writeFileSync(freshLog, 'fresh log data', 'utf8')

  // Set old log mtime to 10 days ago
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
  utimesSync(oldLog, tenDaysAgo, tenDaysAgo)

  const swept = pool.sweepOldLogs(7)
  assert.ok(swept >= 1)
  assert.equal(existsSync(oldLog), false)
  assert.equal(existsSync(freshLog), true)
})

test('getActiveAccountId and proactive rotation when account enters cooldown or exhausts quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-active-rotate-'))
  const pool = new AccountPoolManager(dir)
  const accA = pool.getAccounts()[0]!
  const accB = pool.createAccountSlot('Account B')

  // Initially getActiveAccountId picks Account A
  assert.equal(pool.getActiveAccountId('google'), accA.id)
  assert.equal(pool.getPoolData().lastActiveAccountId, accA.id)

  // When A fails and hits 429, pool proactively rotates to Account B immediately
  pool.recordFailure(accA.id, 'google', '429 Rate Limit')
  assert.equal(pool.getPoolData().lastActiveAccountId, accB.id)
  assert.equal(pool.getActiveAccountId('google'), accB.id)

  // When B quota is exhausted via updateAccountQuotas, and A is still in cooldown:
  // getActiveAccountId returns primaryAccountId / first account fallback
  const futureReset = new Date(Date.now() + 300_000).toISOString()
  pool.updateAccountQuotas(accB.id, {
    google: {
      remainingFraction: 0.01,
      resetTime: futureReset,
      models: [],
    },
  })
  // Both are exhausted, but getActiveAccountId doesn't throw and falls back gracefully
  assert.equal(pool.getActiveAccountId('google'), accA.id)
})

test('proactive rotation benches a 4% account before it dies (2026-10-17 incident)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-lowquota-'))
  const pool = new AccountPoolManager(dir)
  const accA = pool.getAccounts()[0]!
  const accB = pool.createAccountSlot('Account B')

  // Primary is pinned (active) and reported 4.07% remaining with a future
  // reset. The old 2% gate called this "still eligible", so the sticky
  // affinity kept every session pinned to it while three parallel turns
  // slammed into the wall together — q98 sat idle at 100% the whole time.
  const futureReset = new Date(Date.now() + 13.5 * 3600_000).toISOString()
  // Production order: the account was IN USE (pinned active), then its quota
  // refresh reported 4.07% — the refresh itself must rotate away from it.
  pool.markAccountActive(accA.id)
  pool.updateAccountQuotas(accA.id, {
    google: {
      remainingFraction: 0.040659066,
      resetTime: futureReset,
      weeklyFraction: 0.040659066,
      weeklyResetTime: futureReset,
      models: [],
    },
  })

  // The quota refresh itself must rotate away from the drying account...
  assert.equal(
    pool.getPoolData().lastActiveAccountId,
    accB.id,
    'updateAccountQuotas must advance off an account below the rotation threshold',
  )
  // ...and the benched account stays out of sticky affinity and selection.
  assert.equal(pool.isAccountEligible(pool.getAccount(accA.id)!, 'google'), false, '4% must be benched proactively, not served until it dies')
  assert.equal(pool.getActiveAccountId('google'), accB.id)
  assert.equal(pool.selectAccount('google')?.id, accB.id)
})

test('explainIneligibility separates quota rotation from cooldown, and clear-cooldown can lift it', () => {
  // Regression: every ineligible account used to be reported as "in cooldown",
  // and the advertised remedy `/agy clear-cooldown` only deleted cooldowns — so
  // a quota-benched account produced the same error forever.
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-quota-bench-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.getAccounts()[0]!
  const reset = new Date(Date.now() + 2 * 3600_000).toISOString()

  pool.updateAccountQuotas(acc.id, {
    google: {
      remainingFraction: 0.093,
      resetTime: reset,
      weeklyFraction: 0.5,
      weeklyResetTime: reset,
      updatedAt: Date.now(),
    },
  })

  const benched = pool.getAccount(acc.id)!
  assert.equal(pool.explainIneligibility(benched, 'google'), 'quota', 'a low-quota bench is not a cooldown')
  assert.equal(pool.isAccountEligible(benched, 'google'), false)
  const countdown = pool.getEarliestAvailableCountdown('google')
  assert.ok(countdown !== null && countdown > 1.9 * 3600_000 && countdown <= 2 * 3600_000)

  // A real 429 is a different reason, so the adapter can word its hint correctly.
  pool.recordFailure(acc.id, 'anthropic', '429 Rate Limit', reset)
  assert.equal(pool.explainIneligibility(pool.getAccount(acc.id)!, 'anthropic'), 'cooldown')

  // An account without Argon access reports 'unsupported', never 'quota' or 'cooldown'
  assert.equal(pool.explainIneligibility(acc, 'argon'), 'unsupported')

  // The user-facing clear also lifts the low-quota bench for the cached snapshot.
  pool.clearCooldown(acc.id, 'google', true)
  assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), true)
  assert.equal(pool.getEarliestAvailableCountdown('google'), null)

  // It only bridges the snapshot it overrode: fresh data re-arms the gate.
  pool.updateAccountQuotas(acc.id, {
    google: {
      remainingFraction: 0.093,
      resetTime: reset,
      weeklyFraction: 0.5,
      weeklyResetTime: reset,
      updatedAt: Date.now() + 1,
    },
  })
  assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), false)

  // Internal callers (orphan release, CLI quota cleanup) must not disable the gate.
  pool.clearCooldown(acc.id, 'google')
  assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), false)
})

test('lastActiveAccountId is cleared when the active account is deleted, disabled or requires auth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-cleanup-active-'))
  const pool = new AccountPoolManager(dir)
  const accB = pool.createAccountSlot('Account B')

  pool.markAccountActive(accB.id)
  assert.equal(pool.getPoolData().lastActiveAccountId, accB.id)

  // Disable B -> lastActiveAccountId cleared
  pool.setAccountEnabled(accB.id, false)
  assert.equal(pool.getPoolData().lastActiveAccountId, undefined)

  // Re-enable and mark active, then markAuthRequired -> cleared
  pool.setAccountEnabled(accB.id, true)
  pool.markAccountActive(accB.id)
  pool.markAuthRequired(accB.id, 'revoked')
  assert.equal(pool.getPoolData().lastActiveAccountId, undefined)

  // Clear auth and mark active, then delete -> cleared
  pool.clearAuthRequired(accB.id)
  pool.markAccountActive(accB.id)
  pool.deleteAccount(accB.id)
  assert.equal(pool.getPoolData().lastActiveAccountId, undefined)
})

test('getPoolData exposes authoritative activeAccountId and purges ghost abort cooldowns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-ghost-cd-'))
  const rawPool = {
    version: 1,
    accounts: [
      {
        id: 'acc_primary',
        alias: 'Primary',
        systemHome: true,
        dir: '',
        enabled: true,
        cooldowns: {
          google: {
            cooldownUntil: Date.now() + 600_000,
            reason: 'agy run aborted by caller',
          },
        },
        quotas: {},
      },
      {
        id: 'acc_sec',
        alias: 'Secondary',
        systemHome: false,
        dir: join(dir, 'acc_sec'),
        enabled: true,
        cooldowns: {},
        quotas: {},
      },
    ],
  }
  writeFileSync(join(dir, 'pool.json'), JSON.stringify(rawPool), 'utf8')

  const pool = new AccountPoolManager(dir)
  // Ghost cooldown on primary was purged
  assert.equal(pool.getAccount('acc_primary')?.cooldowns.google, undefined)
  // getPoolData exposes activeAccountId
  const data = pool.getPoolData()
  assert.equal(data.activeAccountId, 'acc_primary')
})

test('advanceAccount rotates to the next eligible account without a cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-advance-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  const b = pool.createAccountSlot('Second')
  const c = pool.createAccountSlot('Third')
  pool.markAccountActive(a.id)

  // Second is unavailable (disabled): the pointer must skip it.
  pool.setAccountEnabled(b.id, false)
  assert.equal(pool.advanceAccount(a.id, 'google'), c.id)
  assert.equal(pool.getPoolData().lastActiveAccountId, c.id)
  // No cooldown penalty is applied to the account we rotated away from.
  assert.equal(pool.getAccount(a.id)?.cooldowns.google, undefined)
  assert.equal(pool.getAccount(c.id)?.cooldowns.google, undefined)

})

test('advanceAccount returns null when no other account is eligible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-advance-none-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  pool.markAccountActive(a.id)
  // Only the account we are rotating away from exists: no move, no throw.
  assert.equal(pool.advanceAccount(a.id, 'google'), null)
  assert.equal(pool.getPoolData().lastActiveAccountId, a.id)
})

test('rotation drains the account whose quota expires soonest (use it or lose it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-expiry-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  const later = pool.createAccountSlot('Later')
  const sooner = pool.createAccountSlot('Sooner')
  const iso = (ms: number): string => new Date(ms).toISOString()
  const now = Date.now()
  // "later" sits next in pool order and is full; "sooner" has less quota but
  // its window refreshes in 20 minutes, so its residual is about to be lost.
  pool.updateAccountQuotas(later.id, { google: { remainingFraction: 1, resetTime: iso(now + 4 * 3600_000) } })
  pool.updateAccountQuotas(sooner.id, { google: { remainingFraction: 0.6, resetTime: iso(now + 20 * 60_000) } })
  pool.markAccountActive(a.id)

  // a is drained -> rotation must pick "sooner", not the next slot in order.
  pool.recordFailure(a.id, 'google', '429 Rate Limit')
  assert.equal(pool.getPoolData().lastActiveAccountId, sooner.id, 'soonest expiry wins over pool order')

  // And the no-cooldown timeout rotation follows the same policy.
  pool.markAccountActive(a.id)
  assert.equal(pool.advanceAccount(a.id, 'google'), sooner.id)
  assert.equal(pool.getAccount(sooner.id)?.cooldowns.google, undefined, 'rotation must not cool it down')
})

test('rotation falls back to pool order when no quota metadata exists yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-expiry-none-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  const b = pool.createAccountSlot('Second')
  pool.createAccountSlot('Third')
  pool.markAccountActive(a.id)
  // No resetTime anywhere: keep the legacy cyclic advance (next slot over,
  // never a bounce back to the drained primary).
  pool.recordFailure(a.id, 'google', '429 Rate Limit')
  assert.equal(pool.getPoolData().lastActiveAccountId, b.id)
})

test('rotation prioritizes weekly quota expiring soonest over 5h quota window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-weekly-prio-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  const weeklySooner = pool.createAccountSlot('WeeklySooner')
  const fiveHourSooner = pool.createAccountSlot('FiveHourSooner')
  const iso = (ms: number): string => new Date(ms).toISOString()
  const now = Date.now()

  // weeklySooner: weekly quota resets in 1 day, 5h window resets in 4 hours
  pool.updateAccountQuotas(weeklySooner.id, {
    google: {
      weeklyFraction: 0.7,
      weeklyResetTime: iso(now + 86_400_000), // 1 day
      remainingFraction: 0.8,
      resetTime: iso(now + 4 * 3600_000), // 4 hours
    },
  })
  // fiveHourSooner: weekly quota resets in 6 days, 5h window resets in 15 minutes
  pool.updateAccountQuotas(fiveHourSooner.id, {
    google: {
      weeklyFraction: 0.9,
      weeklyResetTime: iso(now + 6 * 86_400_000), // 6 days
      remainingFraction: 0.5,
      resetTime: iso(now + 15 * 60_000), // 15 mins
    },
  })
  pool.markAccountActive(a.id)

  // a is drained -> rotation must pick weeklySooner because weekly quota is expiring sooner
  pool.recordFailure(a.id, 'google', '429 Rate Limit')
  assert.equal(pool.getPoolData().lastActiveAccountId, weeklySooner.id, 'weekly expiry must take precedence over 5h window')
})

test('rotation compares 5h quota window when weekly quota expiry is equal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-5h-tie-'))
  const pool = new AccountPoolManager(dir)
  const a = pool.getAccounts()[0]!
  const acc1 = pool.createAccountSlot('Acc1')
  const acc2 = pool.createAccountSlot('Acc2')
  const iso = (ms: number): string => new Date(ms).toISOString()
  const now = Date.now()

  // Both have identical weekly reset (2 days), but acc2 has 5h reset sooner (30 mins vs 3 hours)
  pool.updateAccountQuotas(acc1.id, {
    google: {
      weeklyFraction: 0.6,
      weeklyResetTime: iso(now + 2 * 86_400_000),
      remainingFraction: 0.8,
      resetTime: iso(now + 3 * 3600_000),
    },
  })
  pool.updateAccountQuotas(acc2.id, {
    google: {
      weeklyFraction: 0.6,
      weeklyResetTime: iso(now + 2 * 86_400_000),
      remainingFraction: 0.5,
      resetTime: iso(now + 30 * 60_000),
    },
  })
  pool.markAccountActive(a.id)

  pool.recordFailure(a.id, 'google', '429 Rate Limit')
  assert.equal(pool.getPoolData().lastActiveAccountId, acc2.id, 'sooner 5h reset wins when weekly reset is tied')
})

test('rotation remains sticky to active account while 5h and weekly quota remain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-sticky-drain-'))
  const pool = new AccountPoolManager(dir)
  const active = pool.getAccounts()[0]!
  const other = pool.createAccountSlot('OtherSooner')
  const iso = (ms: number): string => new Date(ms).toISOString()
  const now = Date.now()

  // active account has plenty of quota left
  pool.updateAccountQuotas(active.id, {
    google: {
      weeklyFraction: 0.6,
      weeklyResetTime: iso(now + 5 * 86_400_000),
      remainingFraction: 0.5,
      resetTime: iso(now + 3 * 3600_000),
    },
  })
  // other account has quota expiring much sooner
  pool.updateAccountQuotas(other.id, {
    google: {
      weeklyFraction: 0.3,
      weeklyResetTime: iso(now + 86_400_000),
      remainingFraction: 0.2,
      resetTime: iso(now + 20 * 60_000),
    },
  })
  pool.setActiveAccount(active.id, 'google')

  // selectAccount must stay sticky to active account as long as its quota is not exhausted
  const selected = pool.selectAccount('google')
  assert.equal(selected?.id, active.id, 'must not switch away from active account while quota remains')

  // Now active account exhausts its 5h quota (<= 2%)
  pool.updateAccountQuotas(active.id, {
    google: {
      weeklyFraction: 0.6,
      weeklyResetTime: iso(now + 5 * 86_400_000),
      remainingFraction: 0.01,
      resetTime: iso(now + 2 * 3600_000),
    },
  })
  const rotated = pool.selectAccount('google')
  assert.equal(rotated?.id, other.id, 'must automatically advance to next account once active account is exhausted')
})

test('getEarliestAvailableCountdown reports quota-window resets, not just cooldowns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-eta-'))
  const pool = new AccountPoolManager(dir)
  const iso = (ms: number): string => new Date(ms).toISOString()
  const now = Date.now()
  // A fully quota-drained pool knows exactly when it comes back; the old
  // cooldown-only countdown reported "no ETA" for it.
  pool.updateAccountQuotas(pool.getAccounts()[0]!.id, {
    google: { remainingFraction: 0, resetTime: iso(now + 30 * 60_000), weeklyFraction: 0.5, weeklyResetTime: iso(now + 5 * 86_400_000) },
  })
  const eta = pool.getEarliestAvailableCountdown('google')
  assert.ok(eta !== null && eta > 25 * 60_000 && eta <= 31 * 60_000, `expected ~30m ETA, got ${String(eta)}`)
  assert.equal(pool.getEarliestResetCountdown('google'), null, 'the cooldown-only view still sees nothing')
  // A cooling account with a nearer reset wins over a far quota reset.
  const other = pool.createAccountSlot('Second')
  pool.recordFailure(other.id, 'google', 'RESOURCE_EXHAUSTED (code 429). Resets in 2m0s.')
  const eta2 = pool.getEarliestAvailableCountdown('google')
  assert.ok(eta2 !== null && eta2 <= 3 * 60_000, `expected the cooldown to win, got ${String(eta2)}`)
})

test('a partial pool.json (missing cooldowns/quotas) is normalized instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-partial-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pool.json'), JSON.stringify({
    version: 1,
    accounts: [
      { id: 'acc_primary', alias: 'Primary', dir: '', systemHome: true, enabled: true, createdAt: Date.now() },
      { id: 'acc_partial', alias: 'Partial', dir: '/tmp/partial', createdAt: Date.now() },
    ],
  }), 'utf8')
  const pool = new AccountPoolManager(dir)
  // Before normalization `acc.cooldowns[family]` threw a TypeError inside
  // selectAccount, so EVERY turn failed with an opaque internal error.
  const picked = pool.selectAccount('google')
  assert.ok(picked !== null, 'a partial record must still be selectable')
  assert.equal(pool.isAccountEligible(pool.getAccount('acc_partial')!, 'google'), true, 'enabled defaults to true')
  assert.deepEqual(pool.getAccount('acc_partial')?.cooldowns, {})
  assert.deepEqual(pool.getAccount('acc_partial')?.quotas, {})
})

test('disabled account handling: needsAuthReverify skips disabled, getActiveAccountId never falls back to disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-disabled-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts()[0]!
  const secondary = pool.createAccountSlot('Secondary')

  // needsAuthReverify returns false when account is disabled
  primary.authRequired = true
  primary.authMarkedAt = Date.now() - 20 * 60_000
  primary.enabled = false
  assert.equal(needsAuthReverify(primary), false, 'disabled account must never be polled for reverification')
  primary.enabled = true
  assert.equal(needsAuthReverify(primary), true, 'enabled account is eligible for reverification')

  // Primary disabled -> getActiveAccountId falls back to secondary (enabled)
  pool.setAccountEnabled(primary.id, false)
  assert.equal(pool.getActiveAccountId('google'), secondary.id)

  // Both disabled -> getActiveAccountId returns undefined, does not throw or return disabled account
  pool.setAccountEnabled(secondary.id, false)
  assert.equal(pool.getActiveAccountId('google'), undefined)
  assert.equal(pool.selectAccount('google'), null)
  assert.equal(pool.advanceAccount(primary.id, 'google'), null)

  // setPrimaryAccount re-enables a disabled account
  pool.setPrimaryAccount(secondary.id)
  assert.equal(pool.getAccount(secondary.id)?.enabled, true)
  assert.equal(pool.getActiveAccountId('google'), secondary.id)
})

test('getPoolData exposes systemProxy when defaultProxy is provided or system proxy is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-system-proxy-'))
  const pool = new AccountPoolManager(dir)
  const poolData = pool.getPoolData('http://127.0.0.1:17891')
  assert.equal(poolData.systemProxy, 'http://127.0.0.1:17891')
})

test('selectAccount for family=argon routes only to Argon-capable accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-argon-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts()[0]!
  pool.updateAccountQuotas(primary.id, { google: { remainingFraction: 1 } })

  const secondary = pool.createAccountSlot('Pro Account')
  pool.updateAccountQuotas(secondary.id, { argon: { remainingFraction: 1 } })

  assert.equal(pool.selectAccount('argon')?.id, secondary.id, 'must select secondary account with Argon')
  assert.equal(pool.selectAccount('google')?.id, primary.id, 'google requests can still use primary')
})

test('defaultPoolDir recovers when home directory is inside an isolated account path', () => {
  assert.equal(
    defaultPoolDir('C:\\Users\\kybco\\.dsh\\agy-accounts\\acc_1793341113485_51ytc'),
    join('C:\\Users\\kybco', '.dsh', 'agy-accounts'),
  )
  assert.equal(
    defaultPoolDir('/home/user/.dsh/agy-accounts/acc_1793341113485_51ytc'),
    join('/home/user', '.dsh', 'agy-accounts'),
  )
  assert.equal(
    defaultPoolDir('C:\\Users\\kybco'),
    join('C:\\Users\\kybco', '.dsh', 'agy-accounts'),
  )
})

test('selectAccount routes to account supporting requested model (Opus 4.6 vs Opus 5.5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-models-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts()[0]!
  // Primary has Claude 5.5 only
  pool.updateAccountQuotas(primary.id, {
    anthropic: {
      remainingFraction: 1,
      models: [
        { modelId: 'claude-opus-5-5-low' },
        { modelId: 'claude-opus-5-5-medium' },
        { modelId: 'claude-opus-5-5-high' },
      ],
    },
  })

  // Secondary has Claude 4.6
  const secondary = pool.createAccountSlot('Legacy Opus Account')
  pool.updateAccountQuotas(secondary.id, {
    anthropic: {
      remainingFraction: 1,
      models: [
        { modelId: 'claude-opus-4-6-thinking' },
        { modelId: 'claude-sonnet-4-6' },
      ],
    },
  })

  assert.equal(
    pool.selectAccount('anthropic', 'claude-opus-4-6-thinking')?.id,
    secondary.id,
    'must route claude-opus-4-6-thinking to secondary account supporting it',
  )
  assert.equal(
    pool.selectAccount('anthropic', 'claude-opus-5-5')?.id,
    primary.id,
    'must route claude-opus-5-5 to primary account supporting it',
  )
  assert.equal(
    pool.getActiveAccountId('anthropic', 'claude-opus-4-6-thinking'),
    secondary.id,
    'getActiveAccountId must reflect model-scoped account',
  )
})

test('markModelUnsupported excludes failed model from account and rotates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-unsupported-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts()[0]!
  const secondary = pool.createAccountSlot('Backup Account')
  pool.updateAccountQuotas(primary.id, { anthropic: { remainingFraction: 1 } })
  pool.updateAccountQuotas(secondary.id, { anthropic: { remainingFraction: 1 } })

  assert.equal(pool.selectAccount('anthropic', 'claude-opus-4-6')?.id, primary.id)
  pool.markModelUnsupported(primary.id, 'claude-opus-4-6')
  assert.equal(
    pool.selectAccount('anthropic', 'claude-opus-4-6')?.id,
    secondary.id,
    'must rotate away from account marked unsupported for that model',
  )
})
