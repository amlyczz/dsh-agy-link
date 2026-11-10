import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { PoolAuthFlow } from '../src/host/pool-auth.ts'
import { QuotaService } from '../src/host/quota.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-auth-'))
  const pool = new AccountPoolManager(dir)
  const quota = new QuotaService(pool)
  return { dir, pool, quota }
}

test('PoolAuthFlow begin produces a PKCE authorize URL and auto mode', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => true })
  const st = await flow.begin('测试账号')
  assert.equal(st.ok, true)
  assert.equal(st.phase, 'waiting')
  assert.equal(st.mode, 'auto')
  assert.equal(st.browserOpened, true)
  assert.ok(st.url?.includes('accounts.google.com'))
  assert.ok(st.url?.includes('code_challenge='))
  assert.ok(st.url?.includes('code_challenge_method=S256'))
  assert.ok(st.url?.includes('redirect_uri=http%3A%2F%2Flocalhost%3A51121'))
  // openid must NOT be in the scope (hangs consent for this client)
  assert.ok(!st.url?.includes('openid'))
  // staging slot exists but no account committed yet
  assert.equal(pool.getAccounts().length, 1) // only the bootstrapped primary
  await flow.cancel()
  assert.equal(flow.status().phase, 'idle')
})

test('PoolAuthFlow cancel cleans the staging dir', async () => {
  const { dir, pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => false })
  const st = await flow.begin()
  assert.equal(st.ok, true)
  const { readdirSync } = await import('node:fs')
  assert.ok(readdirSync(dir).some((e) => e.startsWith('staging_')))
  await flow.cancel()
  assert.ok(!readdirSync(dir).some((e) => e.startsWith('staging_')))
})

test('PoolAuthFlow rejects bogus paste and wrong-state URLs', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => true })
  const st = await flow.begin()
  assert.equal(st.ok, true)

  const bogus = await flow.submitCode('not a code at all!!!')
  assert.equal(bogus.ok, false)
  assert.equal(bogus.phase, 'waiting') // still waiting, not failed

  const wrongState = await flow.submitCode('http://localhost:51121/oauth-callback?code=4/1AfValidLookingCode&state=WRONG')
  assert.equal(wrongState.ok, false)
  assert.equal(wrongState.phase, 'waiting')
  assert.equal(wrongState.code, 'invalid_state')

  await flow.cancel()
})

test('PoolAuthFlow fails cleanly when the exchange is rejected', async () => {
  const { dir, pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => true })
  const st = await flow.begin()
  assert.equal(st.ok, true)
  // A real-looking but invalid code reaches the token endpoint and is
  // rejected; the flow must fail (not hang) and clean up staging.
  // NOTE: this test requires network; skip silently when offline.
  try {
    const res = await flow.submitCode('4/1AfDefinitelyInvalidCode123')
    assert.equal(res.ok, false)
    assert.equal(res.phase, 'failed')
    assert.equal(res.code, 'exchange_failed')
    const { readdirSync } = await import('node:fs')
    assert.ok(!readdirSync(dir).some((e) => e.startsWith('staging_')))
  } catch (err) {
    if (String(err).includes('fetch failed')) return // offline: skip
    throw err
  }
})

test('reauthentication restores an existing account without changing its settings', async () => {
  const { pool, quota } = fixture()
  const account = pool.createAccountSlot('Backup')
  pool.updateAccountQuotas(account.id, {}, 'backup@example.com')
  pool.markAuthRequired(account.id, 'missing')
  pool.setAccountEnabled(account.id, false)
  const file = join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  writeFileSync(file, 'previous credential')
  writeFileSync(file + '.bak', JSON.stringify({ token: { refresh_token: 'old' } }))
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    openBrowser: async () => true,
    exchangeCode: async () => ({ access_token: 'access', refresh_token: 'refresh' }),
    fetchUserEmail: async () => 'backup@example.com',
  })
  const started = await flow.beginAccount(account.id)
  assert.equal(started.ok, true)
  const result = await flow.submitCode('4/1AfValidLookingCode')
  assert.equal(result.phase, 'done')
  assert.equal(pool.getAccounts().length, 2)
  assert.equal(account.enabled, false)
  assert.equal(account.authRequired, undefined)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token.refresh_token, 'refresh')
  assert.equal(JSON.parse(readFileSync(file + '.bak', 'utf8')).token.refresh_token, 'refresh')
  assert.equal(existsSync(started.dir!), false)
})

test('adding an account saves a backup of the newly authorized credential', async () => {
  const { pool, quota } = fixture()
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    openBrowser: async () => true,
    exchangeCode: async () => ({ access_token: 'access', refresh_token: 'new-grant' }),
    fetchUserEmail: async () => 'new@example.com',
  })
  await flow.begin('Backup')
  assert.equal((await flow.submitCode('4/1AfValidLookingCode')).phase, 'done')
  const account = pool.getAccounts().find((item) => item.email === 'new@example.com')!
  const file = join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  assert.equal(JSON.parse(readFileSync(file + '.bak', 'utf8')).token.refresh_token, 'new-grant')
})

test('reauthentication rejects wrong or unverifiable identities without overwriting credentials', async () => {
  for (const [email, refresh, expected] of [
    ['wrong@example.com', 'refresh', 'identity_mismatch'],
    [undefined, 'refresh', 'identity_unverified'],
    ['backup@example.com', undefined, 'identity_unverified'],
  ] as const) {
    const { pool, quota } = fixture()
    const account = pool.createAccountSlot('Backup')
    pool.updateAccountQuotas(account.id, {}, 'backup@example.com')
    const file = join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    writeFileSync(file, 'original')
    const flow = new PoolAuthFlow(pool, quota, () => {}, {
      openBrowser: async () => true,
      exchangeCode: async () => ({ access_token: 'access', refresh_token: refresh }),
      fetchUserEmail: async () => email,
    })
    const started = await flow.beginAccount(account.id)
    const result = await flow.submitCode('4/1AfValidLookingCode')
    assert.equal(result.code, expected)
    assert.equal(readFileSync(file, 'utf8'), 'original')
    assert.equal(existsSync(started.dir!), false)
    assert.equal(existsSync(account.dir), true)
  }
})

test('cancelled reauthentication never deletes the existing account or commits a late exchange', async () => {
  const { pool, quota } = fixture()
  const account = pool.createAccountSlot('Backup')
  let resolveExchange!: (value: { access_token: string; refresh_token: string }) => void
  const flow = new PoolAuthFlow(pool, quota, () => {}, {
    openBrowser: async () => true,
    exchangeCode: async () => new Promise((resolve) => { resolveExchange = resolve }),
    fetchUserEmail: async () => 'backup@example.com',
  })

  test('reauthentication rejects an identity already assigned to a sibling account', async () => {
    const { pool, quota } = fixture()
    const account = pool.createAccountSlot('Backup')
    const sibling = pool.createAccountSlot('Other')
    pool.updateAccountQuotas(sibling.id, {}, 'other@example.com')
    const flow = new PoolAuthFlow(pool, quota, () => {}, {
      openBrowser: async () => true,
      exchangeCode: async () => ({ access_token: 'access', refresh_token: 'refresh' }),
      fetchUserEmail: async () => 'OTHER@example.com',
    })
    await flow.beginAccount(account.id)
    const result = await flow.submitCode('4/1AfValidLookingCode')
    assert.equal(result.code, 'identity_mismatch')
    assert.equal(existsSync(join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')), false)
    assert.equal(pool.getAccounts().length, 3)
  })
  const started = await flow.beginAccount(account.id)
  const pending = flow.submitCode('4/1AfValidLookingCode')
  await flow.cancel()
  resolveExchange({ access_token: 'access', refresh_token: 'refresh' })
  await pending
  assert.equal(existsSync(started.dir!), false)
  assert.equal(existsSync(account.dir), true)
  assert.equal(existsSync(join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')), false)
  assert.equal(flow.status().phase, 'idle')
})
