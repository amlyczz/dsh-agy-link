import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFamilyOf, shouldPollAccount } from '../src/common/pool-types.ts'
import { AccountPoolManager } from '../src/host/pool.ts'

test('modelFamilyOf correctly categorizes models', () => {
  assert.equal(modelFamilyOf('gemini-3.7-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-3.6-flash'), 'google')
  assert.equal(modelFamilyOf('gemini-3.1-pro'), 'google')
  assert.equal(modelFamilyOf('gemma-2-9b'), 'google')
  assert.equal(modelFamilyOf('claude-sonnet-4-6'), 'anthropic')
  assert.equal(modelFamilyOf('claude-3-7-sonnet'), 'anthropic')
  assert.equal(modelFamilyOf('claude-opus-4-6-thinking'), 'anthropic')
  assert.equal(modelFamilyOf('gpt-oss-120b-medium'), 'openai')
  assert.equal(modelFamilyOf('openai/gpt-4o'), 'openai')
  assert.equal(modelFamilyOf('custom-other-model'), 'unknown')
  assert.equal(modelFamilyOf(undefined), 'unknown')
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

