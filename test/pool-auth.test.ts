import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
  assert.match(wrongState.message ?? '', /state/)

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
    assert.match(res.message ?? '', /交换失败|exchange/i)
    const { readdirSync } = await import('node:fs')
    assert.ok(!readdirSync(dir).some((e) => e.startsWith('staging_')))
  } catch (err) {
    if (String(err).includes('fetch failed')) return // offline: skip
    throw err
  }
})
