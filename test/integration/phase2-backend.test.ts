import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeQuotaPacing } from '../../src/common/quota-pacing.ts'
import { orderByExpiry, nextQuotaResetAt } from '../../src/domain/accounts/selection.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { PoolStore } from '../../src/domain/accounts/store.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { ModelCatalog } from '../../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS } from '../../src/common/model-lineup.ts'
import { defaultConfig } from '../../src/common/types.ts'
import { QuotaService } from '../../src/host/quota.ts'
import { dispatcherKeyFor, agentForScope, closeProxyAgents } from '../../src/host/net.ts'
import { setRuntimeAgyVersion, getRuntimeAgyVersion } from '../../src/host/oauth.ts'
import { persistRefreshedToken } from '../../src/features/quota/token.ts'
import { SpawnLimiter } from '../../src/provider/spawn-limiter.ts'
import { inlineFiles, runAgyOnce } from '../../src/host/oneshot.ts'
import { redactLine } from '../../src/host/diagnostics.ts'
import { writeMcpConfig } from '../../src/host/mcp-bridge.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

function makeAcc(overrides: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    alias: overrides.id,
    dir: '',
    enabled: true,
    createdAt: 1_000,
    cooldowns: {},
    quotas: {},
    ...overrides,
  }
}

test('computeQuotaPacing classifies surplus, on_track, burning_fast, reset and unactivated', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const fiveH = 5 * 3_600_000
  const sevenD = 7 * 24 * 3_600_000

  // 80% left with only 1h (20% of 5h) remaining -> surplus
  const surplus = computeQuotaPacing(0.8, new Date(now + 3_600_000).toISOString(), fiveH, now)
  assert.equal(surplus.status, 'surplus')
  assert.ok(surplus.surplus > 0.5)

  // 25% left with 6 days (85.7% of 7d) remaining -> burning_fast
  const fast = computeQuotaPacing(0.25, new Date(now + 6 * 24 * 3_600_000).toISOString(), sevenD, now)
  assert.equal(fast.status, 'burning_fast')
  assert.ok(fast.surplus < -0.5)

  // 100% left with no resetTime -> unactivated
  const unact = computeQuotaPacing(1, undefined, sevenD, now)
  assert.equal(unact.status, 'unactivated')

  // Reset time in the past -> reset
  const reset = computeQuotaPacing(1, new Date(now - 60_000).toISOString(), fiveH, now)
  assert.equal(reset.status, 'reset')
})

test('orderByExpiry ignores second-level resetTime jitter in same cohort and prefers higher surplus', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const accDrained = makeAcc({
    id: 'acc_drained',
    quotas: {
      google: {
        remainingFraction: 0.15,
        resetTime: new Date(now + 2 * 3_600_000).toISOString(),
        weeklyFraction: 0.12,
        // 800ms earlier due to Google endpoint clock jitter, but nearly empty!
        weeklyResetTime: new Date(now + 3 * 24 * 3_600_000 - 800).toISOString(),
      },
    },
  })
  const accSurplus = makeAcc({
    id: 'acc_surplus',
    quotas: {
      google: {
        remainingFraction: 0.92,
        resetTime: new Date(now + 2 * 3_600_000 + 500).toISOString(),
        weeklyFraction: 0.88,
        weeklyResetTime: new Date(now + 3 * 24 * 3_600_000).toISOString(),
      },
    },
  })
  const pool = [accDrained, accSurplus]
  const ordered = orderByExpiry(pool, pool, 'google', undefined, now)
  assert.equal(ordered[0]?.id, 'acc_surplus')

  // Argon keeps its OWN book: an account with no `argon` row has an UNKNOWN
  // argon reset (NaN), and that Gemini surplus must never stand in for it.
  assert.equal(
    Number.isNaN(nextQuotaResetAt(accSurplus, 'argon')),
    true,
    'no argon row -> unknown argon reset, never the Gemini one',
  )
  const orderedArgon = orderByExpiry(pool, pool, 'argon', undefined, now)
  assert.equal(orderedArgon.length, 2, 'unknown-reset accounts stay orderable, just deprioritised')

  // A real argon row must outrank an unknown one.
  const accWithArgon = makeAcc({
    id: 'acc_with_argon',
    quotas: {
      argon: { weeklyFraction: 0.9, weeklyResetTime: new Date(now + 3 * 24 * 3_600_000).toISOString() },
    },
  })
  const withArgon = [...pool, accWithArgon]
  assert.equal(
    orderByExpiry(withArgon, withArgon, 'argon', undefined, now)[0]?.id,
    'acc_with_argon',
    'a known argon reset beats accounts with no argon row',
  )
})

test('PoolAdmin.recordSuccess never erases terminal TOS_VIOLATION quarantine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-pool-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.markAuthRequired('acc_primary', 'TOS_VIOLATION: disabled for violation of Terms of Service https://support.google.com/appeal')
    pool.recordSuccess('acc_primary', 'google')
    const primary = pool.getAccount('acc_primary')
    assert.equal(primary?.authRequired, true)
    assert.match(primary?.authError ?? '', /TOS_VIOLATION/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PoolStore.persist merges fresher quotas, longer cooldowns and terminal TOS bans across processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-store-'))
  try {
    const storeA = new PoolStore(dir)
    const initial = storeA.bootstrapDefaultAccount(storeA.load().data)
    storeA.markKnown('acc_primary')

    // Process B loads the same pool.json and writes a 429 cooldown + newer quota + TOS ban
    const storeB = new PoolStore(dir)
    const dataB = storeB.load().data
    storeB.markKnown('acc_primary')
    const accB = dataB.accounts[0]!
    accB.cooldowns.anthropic = { cooldownUntil: Date.now() + 120_000, reason: '429 rate limit', consecutiveFailures: 1 }
    accB.quotas.google = { remainingFraction: 0.42, updatedAt: 5_000 }
    accB.authRequired = true
    accB.authError = 'TOS_VIOLATION: suspended'
    storeB.persist(dataB)

    // Process A persists older quota (updatedAt: 1_000) without knowing about B's write
    initial.accounts[0]!.quotas.google = { remainingFraction: 0.99, updatedAt: 1_000 }
    const merged = storeA.persist(initial)
    const mergedPrimary = merged.accounts[0]!
    assert.equal(mergedPrimary.quotas.google?.remainingFraction, 0.42)
    assert.ok((mergedPrimary.cooldowns.anthropic?.cooldownUntil ?? 0) > Date.now())
    assert.equal(mergedPrimary.authRequired, true)
    assert.match(mergedPrimary.authError ?? '', /TOS_VIOLATION/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionStore reloads external writes, writes .last-good and prunes stale bindings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-sess-'))
  try {
    const file = join(dir, 'sessions.json')
    const s1 = new SessionStore(file)
    s1.set('sess-old:acc_primary', { conversationId: 'conv-old', lastMessageCount: 1, updatedAt: 1_000 })

    // Second process updates sess-new
    const s2 = new SessionStore(file)
    s2.set('sess-live:acc_primary', { conversationId: 'conv-live', lastMessageCount: 4, updatedAt: Date.now() })

    // s1 sees s2's binding without restarting!
    assert.equal(s1.get('sess-live:acc_primary')?.conversationId, 'conv-live')

    // Prune bindings older than 30 days
    const pruned = s1.pruneStaleBindings(Date.now() - 30 * 24 * 3_600_000, 100)
    assert.equal(pruned, 1)
    assert.equal(s1.get('sess-old:acc_primary'), undefined)
    assert.equal(s1.get('sess-live:acc_primary')?.conversationId, 'conv-live')

    // Corrupt sessions.json -> new SessionStore recovers from sessions.json.last-good
    writeFileSync(file, '{corrupt-json', 'utf8')
    const s3 = new SessionStore(file)
    assert.equal(s3.get('sess-live:acc_primary')?.conversationId, 'conv-live')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ModelCatalog persists to disk for 0ms cold start and invalidates on agyVersion upgrade', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-cat-'))
  try {
    const cacheFile = join(dir, 'model-catalog.json')
    let spawns = 0
    let ver = '1.5.11'
    const discover = async (_sig?: AbortSignal, accId?: string) => {
      spawns++
      const stdout = accId === 'acc_pro'
        ? 'gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n'
        : 'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n'
      return { stdout, stderr: '' }
    }

    const cat1 = new ModelCatalog(discover, [...DEFAULT_FALLBACK_MODELS], 3_600_000, undefined, {
      cacheFile,
      agyVersion: () => ver,
    })
    await cat1.forceRefresh('acc_pro')
    assert.equal(spawns, 1)

    // Cold boot with same version -> 0ms discovered catalog, warmAccounts skips fresh acc_pro!
    const cat2 = new ModelCatalog(discover, [...DEFAULT_FALLBACK_MODELS], 3_600_000, undefined, {
      cacheFile,
      agyVersion: () => ver,
    })
    assert.equal(cat2.getAccountCatalog('acc_pro')?.source, 'discovered')
    assert.ok(cat2.getAccountCatalog('acc_pro')?.models.some((m) => m.id === 'gemini-4-argon'))
    await cat2.warmAccounts([makeAcc({ id: 'acc_pro' })])
    assert.equal(spawns, 1)

    // Upgrade agy version -> invalidated and re-probed
    ver = '1.5.12'
    const cat3 = new ModelCatalog(discover, [...DEFAULT_FALLBACK_MODELS], 3_600_000, undefined, {
      cacheFile,
      agyVersion: () => ver,
    })
    assert.equal(cat3.getAccountCatalog('acc_pro'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('QuotaService.refreshAllQuotas(true) skips disabled/TOS accounts and staggers same-proxy egress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-quota-'))
  try {
    const pool = new AccountPoolManager(dir)
    const a1 = pool.createAccountSlot('A1')
    pool.clearAuthRequired(a1.id, true)
    pool.setAccountProxy(a1.id, 'http://127.0.0.1:7890')

    const a2 = pool.createAccountSlot('A2')
    pool.clearAuthRequired(a2.id, true)
    pool.setAccountProxy(a2.id, 'http://127.0.0.1:7890')

    const aBanned = pool.createAccountSlot('Banned')
    pool.markAuthRequired(aBanned.id, 'TOS_VIOLATION: disabled for violation of Terms of Service')

    const aDisabled = pool.createAccountSlot('Disabled')
    pool.clearAuthRequired(aDisabled.id, true)
    pool.setAccountEnabled(aDisabled.id, false)

    // Disable primary so only our test accounts participate
    pool.setAccountEnabled('acc_primary', false)

    const starts = new Map<string, number>()
    class TestQuota extends QuotaService {
      override async refreshAccountQuota(acc: ManagedAccount): Promise<null> {
        starts.set(acc.id, Date.now())
        return null
      }
    }
    const qs = new TestQuota(pool, () => '', () => '1.5.12', { forceStaggerMs: () => 60 })
    await qs.refreshAllQuotas(true)

    assert.equal(starts.has(aBanned.id), false, 'TOS banned account must never be polled in bulk refresh')
    assert.equal(starts.has(aDisabled.id), false, 'Disabled account must never be polled in bulk refresh')
    assert.equal(starts.has(a1.id), true)
    assert.equal(starts.has(a2.id), true)
    const gap = Math.abs((starts.get(a2.id) ?? 0) - (starts.get(a1.id) ?? 0))
    assert.ok(gap >= 45, `expected same-proxy stagger >=45ms, got ${gap}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('agyFetch isolates ProxyAgent per accountScope, oauth tracks live agyVersion, persistRefreshedToken writes atomic local ISO', async () => {
  assert.notEqual(
    dispatcherKeyFor('http://127.0.0.1:7890', 'acc_1'),
    dispatcherKeyFor('http://127.0.0.1:7890', 'acc_2'),
  )
  const ag1 = agentForScope('http://127.0.0.1:7890', 'acc_1')
  const ag2 = agentForScope('http://127.0.0.1:7890', 'acc_2')
  assert.notEqual(ag1, ag2)
  await closeProxyAgents()

  setRuntimeAgyVersion('1.5.19')
  assert.equal(getRuntimeAgyVersion(), '1.5.19')
  setRuntimeAgyVersion(null)

  const dir = mkdtempSync(join(tmpdir(), 'agy-p2-tok-'))
  try {
    const acc = makeAcc({ id: 'acc_sec', dir })
    persistRefreshedToken(
      {
        pool: { dir, clearAuthRequired: () => {}, markAuthRequired: () => {} },
        proxyFor: () => undefined,
        readSystemKeychainToken: async () => null,
        getStoredToken: async () => null,
        persistRefreshedToken: () => {},
        readPrimaryCredential: () => null,
        writePrimaryCredential: () => false,
        parseCredentialDoc: () => ({ refreshToken: '1//0refresh' }),
      },
      acc,
      { access_token: 'ya29.fresh', refresh_token: '1//0refresh', expiryMs: Date.now() + 3_600_000 },
    )
    const tokenFile = join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    const parsed = JSON.parse(readFileSync(tokenFile, 'utf8')) as { token: { expiry: string } }
    assert.match(parsed.token.expiry, /[+-]\d{2}:\d{2}$/, 'expiry should use local ISO offset matching agy')
    if (process.platform !== 'win32') {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SpawnLimiter reserves TAT slots atomically without thundering herd', async () => {
  const limiter = new SpawnLimiter()
  const now = 10_000
  const d1 = limiter.reserveSpawnDelay('acc_1', 'http://proxy:7890', 500, 0, now)
  const d2 = limiter.reserveSpawnDelay('acc_1', 'http://proxy:7890', 500, 0, now)
  // Different account on the SAME proxy also gets egress spacing!
  const d3 = limiter.reserveSpawnDelay('acc_2', 'http://proxy:7890', 500, 0, now)
  assert.equal(d1, 0)
  assert.equal(d2, 500)
  assert.ok(d3 > 500, `expected cross-account shared-egress spacing > 500ms, got ${d3}`)

  const r1 = limiter.reserveRateLimitSlot(2, now)
  const r2 = limiter.reserveRateLimitSlot(2, now + 100)
  const r3 = limiter.reserveRateLimitSlot(2, now + 200)
  assert.equal(r1.delayMs, 0)
  assert.equal(r2.delayMs, 0)
  assert.equal(r3.delayMs, 59_800)
  limiter.cancelRateLimitSlot(r3.slotAt)
  // Expired slots pruned on next reservation
  const r4 = limiter.reserveRateLimitSlot(2, now + 70_000)
  assert.equal(r4.delayMs, 0)
  // Missing keys & zero interval fast-path
  assert.equal(limiter.reserveSpawnDelay(undefined, undefined, 500, 0, now), 0)
  assert.equal(limiter.reserveSpawnDelay('acc_1', undefined, 0, 0, now), 0)
})

test('oneshot confines inlineFiles to workspace, joins fragments cleanly, diagnostics fixes 4/ regex, and writeMcpConfig is 0600 + prunes dead ports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-p2-oneshot-'))
  const outside = mkdtempSync(join(tmpdir(), 'agy-p2-secret-'))
  try {
    const okFile = join(root, 'notes.txt')
    const secretFile = join(outside, 'secret.txt')
    writeFileSync(okFile, 'hello workspace', 'utf8')
    writeFileSync(secretFile, 'TOP_SECRET_TOKEN', 'utf8')

    const inlined = await inlineFiles('summarize', ['notes.txt', secretFile, '../../escape.txt'], root)
    assert.match(inlined, /hello workspace/)
    assert.doesNotMatch(inlined, /TOP_SECRET_TOKEN/)

    // Fragmented stream-json JSON output must NOT have newlines injected mid-token
    const fakeBin = join(root, 'fake-agy.mjs')
    writeFileSync(
      fakeBin,
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "{\\"ok\\":" } }))',
        'console.log(JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "true}" } }))',
        'console.log(JSON.stringify({ event: "result", result: { status: "OK", response: "{\\"ok\\":true}", conversation_id: "c1" } }))',
      ].join('\n'),
      { mode: 0o755 },
    )
    if (process.platform !== 'win32') {
      const res = await runAgyOnce(
        {
          cfg: () => ({
            ...defaultConfig(),
            agyBin: fakeBin,
            permissionMode: 'plan',
            workspaceRoot: root,
            timeoutMs: 5_000,
            fallbackModels: [...DEFAULT_FALLBACK_MODELS],
            mcpBridge: false,
          }),
          bin: () => fakeBin,
        },
        { prompt: 'json test' },
      )
      assert.equal(res.ok, true)
      assert.equal(res.text, '{"ok":true}')

      // Exercise long-prompt stdin stream-json + schema temp cleanup + missing-bin paths in runAgyOnce
      const noBin = await runAgyOnce({ cfg: () => defaultConfig(), bin: () => null }, { prompt: 'hi' })
      assert.equal(noBin.ok, false)
      assert.match(noBin.error ?? '', /not found/)

      const longRes = await runAgyOnce(
        { cfg: () => ({ ...defaultConfig(), agyBin: fakeBin, mcpBridge: false }), bin: () => fakeBin },
        { prompt: 'x'.repeat(25_000), schema: { type: 'object', properties: { a: { type: 'string' } } } },
      )
      assert.equal(longRes.ok, true)
    }

    // redactLine: preserves dates like 2026/11/18 while redacting real 4/0Af... codes
    const redacted = redactLine('date 2026/11/18 code 4/0AfJohXl9AbCdEfGhIjKlMnOpQrStUvWxYz')
    assert.match(redacted, /2026\/11\/18/)
    assert.doesNotMatch(redacted, /0AfJohXl9/)
    assert.match(redacted, /4\/<code-redacted>/)

    // writeMcpConfig: 0600 permissions + prunes dead dsh-tools-<deadPort> entries
    const mcpDir = join(root, '.gemini', 'config')
    mkdirSync(mcpDir, { recursive: true })
    const mcpFile = join(mcpDir, 'mcp_config.json')
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          'user-custom': { command: 'npx', args: ['foo'] },
          'dsh-tools-59999': {
            type: 'stdio',
            command: process.execPath,
            args: ['/old/bridge.mjs'],
            env: { DSH_MCP_URL: 'http://127.0.0.1:59999', DSH_MCP_TOKEN: 'dead', DSH_MCP_PID: '999999' },
          },
        },
      }),
      'utf8',
    )
    const restore = writeMcpConfig(mcpFile, {
      port: 51234,
      url: 'http://127.0.0.1:51234',
      token: 'live-secret-token',
      bridgeScript: '/new/bridge.mjs',
      close: async () => {},
    })
    const after = JSON.parse(readFileSync(mcpFile, 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.ok('user-custom' in after.mcpServers)
    assert.ok('dsh-tools-51234' in after.mcpServers)
    assert.equal('dsh-tools-59999' in after.mcpServers, false, 'stale crashed bridge entry should be pruned')
    if (process.platform !== 'win32') {
      assert.equal(statSync(mcpFile).mode & 0o777, 0o600)
    }
    restore()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
