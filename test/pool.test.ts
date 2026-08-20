import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFamilyOf } from '../src/common/pool-types.ts'
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

test('Corrupt pool.json recovers gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-corrupt-'))
  writeFileSync(join(dir, 'pool.json'), '{ broken json', 'utf8')
  const pool = new AccountPoolManager(dir)
  assert.equal(pool.getAccounts().length, 1)
  assert.equal(pool.getAccounts()[0]?.id, 'acc_primary')
})
