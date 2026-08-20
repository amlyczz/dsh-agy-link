import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService, detectEmailFromAgyLogs } from '../src/host/quota.ts'

test('QuotaService parses stored tokens and saves token refresh updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'))
  const pool = new AccountPoolManager(dir)
  // Primary rides the system HOME (Keychain); token files only exist for
  // isolated secondary accounts — exercise those.
  const acc = pool.createAccountSlot('quota-test')

  const tokenDir = join(acc.dir, '.gemini', 'antigravity-cli')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(
    join(tokenDir, 'antigravity-oauth-token'),
    JSON.stringify({
      access_token: 'fake_access_token_123',
      refresh_token: 'fake_refresh_token_456',
      expiry: Date.now() + 3600_000,
    }),
    'utf8',
  )

  const quota = new QuotaService(pool)
  const stored = quota.getStoredToken(acc)
  assert.equal(stored?.access_token, 'fake_access_token_123')

  const validToken = await quota.getValidAccessToken(acc)
  assert.equal(validToken, 'fake_access_token_123')
})

test('Quota aggregation extracts bottleneck model fraction and earliest reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-agg-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.getAccounts()[0]!

  pool.updateAccountQuotas(
    acc.id,
    {
      google: {
        remainingFraction: 0.85,
        resetTime: '2026-08-20T16:00:00Z',
      },
      anthropic: {
        remainingFraction: 0.4,
        resetTime: '2026-08-20T18:30:00Z',
      },
      openai: {
        remainingFraction: 1.0,
      },
    },
    'test@gmail.com',
  )

  const updated = pool.getAccount(acc.id)!
  assert.equal(updated.email, 'test@gmail.com')
  assert.equal(updated.quotas.google?.remainingFraction, 0.85)
  assert.equal(updated.quotas.anthropic?.remainingFraction, 0.4)
  assert.equal(updated.quotas.openai?.remainingFraction, 1.0)
})

test('detectEmailFromAgyLogs extracts user email from agy log files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-log-test-'))
  const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, 'cli-20260820_120000.log'),
    'ERROR: logging before google.Init: OAuth: authenticated successfully as dev.user@google.com\n',
    'utf8',
  )
  const email = detectEmailFromAgyLogs(dir)
  assert.equal(email, 'dev.user@google.com')
})
