// External credential leases (src/host/external-lease.ts): selection, pinning,
// TTL, settlement and teardown against a real pool in a temp dir. The slot is a
// fake — no test may touch the Windows Credential Manager.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { defaultConfig, type PluginConfig } from '../../src/common/types.ts'
import { SlotUnavailableError, WaitTimeoutError, type ResolveOptions } from '../../src/host/credential-slot.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import { getValidAccessToken, type QuotaTokenDeps } from '../../src/features/quota/token.ts'
import {
  ExternalLeaseRegistry,
  LEASE_DEFAULT_TTL_MS,
  LEASE_MAX_TTL_MS,
  LEASE_MIN_TTL_MS,
  leaseAgyEnv,
  linkEndpointPath,
  removeLinkEndpoint,
  writeLinkEndpoint,
  type LeaseGrant,
} from '../../src/host/external-lease.ts'

type SlotCall = { account: ManagedAccount; options: ResolveOptions }

function setup(t: test.TestContext, cfg: Partial<PluginConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lease-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts()[0]!
  const second = pool.createAccountSlot('Second')
  let clock = 1_000_000
  const calls: SlotCall[] = []
  const released: string[] = []
  const logs: string[] = []
  let behavior: (account: ManagedAccount) => void = () => undefined
  // Pre-SSH-isolation agy by default, so every account goes through the slot.
  let version: () => Promise<string | null> = async () => '1.4.9'
  let prepResult = true
  const prepared: string[] = []
  const registry = new ExternalLeaseRegistry({
    pool,
    getConfig: () => ({ ...defaultConfig(), proxyUrl: 'http://proxy.test:1', ...cfg }),
    log: (m) => logs.push(m),
    agyVersion: () => version(),
    prepareIsolatedToken: async (account) => {
      prepared.push(account.id)
      return prepResult
    },
    now: () => clock,
    acquireSlot: async (account, _pool, options) => {
      calls.push({ account: account!, options: options ?? {} })
      behavior(account!)
      return { release: () => released.push(account!.id) }
    },
  })
  t.after(() => {
    registry.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir,
    pool,
    primary,
    second,
    registry,
    calls,
    released,
    logs,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
    setBehavior: (fn: (account: ManagedAccount) => void) => { behavior = fn },
    setVersion: (fn: () => Promise<string | null>) => { version = fn },
    setPrep: (ok: boolean) => { prepResult = ok },
    prepared,
  }
}

async function grant(s: ReturnType<typeof setup>, req: Parameters<ExternalLeaseRegistry['acquire']>[0]): Promise<LeaseGrant> {
  const out = await s.registry.acquire(req)
  assert.equal(out.ok, true, JSON.stringify(out))
  return out as LeaseGrant
}

test('acquire selects through the pool and wires the same slot options as the provider', async (t) => {
  const s = setup(t, { dispatchTimeoutMinutes: 3, parallelSameAccount: false, respectExternalSignIn: true })
  const g = await grant(s, { holder: 'runner-1', model: 'gemini-3-flash' })
  assert.match(g.leaseId, /^[0-9a-f]{32}$/)
  assert.equal(g.ttlMs, LEASE_DEFAULT_TTL_MS)
  assert.equal(g.expiresAt, s.now() + LEASE_DEFAULT_TTL_MS)
  assert.equal(g.account.id, s.primary.id)
  assert.equal(g.account.primary, true)
  assert.equal(g.account.home, homedir(), 'the primary runs in the host profile')
  assert.equal(g.account.proxyUrl, s.primary.proxyUrl || 'http://proxy.test:1')
  const opts = s.calls[0]!.options
  assert.equal(opts.baseDir, s.dir)
  assert.equal(opts.dispatchTimeoutMs, 180_000)
  assert.equal(opts.parallel, false)
  assert.equal(opts.respectExternalSignIn, true)
  assert.equal(opts.proxyUrl, g.account.proxyUrl)
  assert.ok(opts.signal instanceof AbortSignal)
  assert.deepEqual(s.registry.list().map((l) => [l.leaseId, l.holder, l.accountId]), [[g.leaseId, 'runner-1', s.primary.id]])
})

test('waitMs bounds the slot wait; ttl is clamped', async (t) => {
  const s = setup(t)
  const low = await grant(s, { holder: 'h', waitMs: 5_000, ttlMs: 1 })
  assert.equal(s.calls[0]!.options.dispatchTimeoutMs, 5_000)
  assert.equal(low.ttlMs, LEASE_MIN_TTL_MS)
  const high = await grant(s, { holder: 'h', ttlMs: 10 * LEASE_MAX_TTL_MS })
  assert.equal(high.ttlMs, LEASE_MAX_TTL_MS)
  assert.equal(s.calls[1]!.options.dispatchTimeoutMs, defaultConfig().dispatchTimeoutMinutes * 60_000)
})

test('pinned by accountId or by accountDir (case/trailing-separator insensitive on Windows)', async (t) => {
  const s = setup(t)
  const byId = await grant(s, { holder: 'h', accountId: s.second.id })
  assert.equal(byId.account.id, s.second.id)
  assert.equal(byId.account.primary, false)
  assert.equal(byId.account.home, s.second.dir)
  const dirVariant = process.platform === 'win32' ? s.second.dir.toUpperCase() + '\\' : s.second.dir + '/'
  const byDir = await grant(s, { holder: 'h', accountDir: dirVariant })
  assert.equal(byDir.account.id, s.second.id)
  // A recorded primary home (the host's os.homedir()) pins the primary.
  const homeVariant = process.platform === 'win32' ? homedir().toUpperCase() + '\\' : homedir() + '/'
  const byHome = await grant(s, { holder: 'h', accountDir: homeVariant })
  assert.equal(byHome.account.id, s.primary.id)
  assert.equal(byHome.account.primary, true)
})

test('pinned account: unknown → 404, disabled/authRequired → 409, cooldown is ignored', async (t) => {
  const s = setup(t)
  assert.deepEqual(await s.registry.acquire({ holder: 'h', accountId: 'nope' }), {
    ok: false, status: 404, code: 'account_not_found', error: 'no pool account matches accountId',
  })
  const missingDir = await s.registry.acquire({ holder: 'h', accountDir: join(s.dir, 'missing') })
  assert.equal(missingDir.ok === false && missingDir.code, 'account_not_found')

  s.pool.recordFailure(s.second.id, 'google', 'quota exhausted', new Date(s.now() + 3_600_000).toISOString())
  const cooled = await s.registry.acquire({ holder: 'h', accountId: s.second.id })
  assert.equal(cooled.ok, true, 'a pinned account ignores its cooldown')

  s.pool.markAuthRequired(s.second.id, 'expired')
  const auth = await s.registry.acquire({ holder: 'h', accountId: s.second.id })
  assert.equal(auth.ok === false && auth.status, 409)
  assert.equal(auth.ok === false && auth.code, 'account_unavailable')

  s.pool.setAccountEnabled(s.primary.id, false)
  const disabled = await s.registry.acquire({ holder: 'h', accountId: s.primary.id })
  assert.equal(disabled.ok === false && disabled.code, 'account_unavailable')
})

test('SlotUnavailableError settles like one-shot and moves to the next account, never the same one twice', async (t) => {
  const s = setup(t)
  s.setBehavior((acc) => {
    if (acc.id === s.primary.id) throw new SlotUnavailableError('slot write rejected')
  })
  const g = await grant(s, { holder: 'h' })
  assert.equal(g.account.id, s.second.id)
  assert.equal(s.pool.getAccount(s.primary.id)!.authRequired, true, 'account target → quarantined')

  // Every account refuses: each is tried once, then 503 no_account with the last error.
  s.setBehavior(() => {
    throw new SlotUnavailableError('refused', 'primary')
  })
  s.registry.release(g.leaseId)
  const before = s.calls.length
  const out = await s.registry.acquire({ holder: 'h' })
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.status, 503)
  assert.equal(out.ok === false && out.code, 'no_account')
  assert.equal(out.ok === false && out.error, 'refused')
  assert.equal(s.calls.length - before, 1, 'second account tried exactly once')
  // primary-target failure on an isolated secondary only advances; no quarantine.
  assert.notEqual(s.pool.getAccount(s.second.id)!.authRequired, true)
})

test('pinned SlotUnavailableError → 409; WaitTimeoutError → 504 slot_timeout; other slot errors → 502 slot_error', async (t) => {
  const s = setup(t)
  s.setBehavior(() => {
    throw new SlotUnavailableError('busy external sign-in')
  })
  const pinned = await s.registry.acquire({ holder: 'h', accountId: s.second.id })
  assert.deepEqual(pinned, { ok: false, status: 409, code: 'account_unavailable', error: 'busy external sign-in' })

  s.setBehavior(() => {
    throw new WaitTimeoutError('waited too long')
  })
  const timeout = await s.registry.acquire({ holder: 'h' })
  assert.equal(timeout.ok === false && timeout.status, 504)
  assert.equal(timeout.ok === false && timeout.code, 'slot_timeout')

  s.setBehavior(() => {
    throw new Error('could not verify the primary identity (network)')
  })
  const transient = await s.registry.acquire({ holder: 'h' })
  assert.equal(transient.ok === false && transient.status, 502)
  assert.equal(transient.ok === false && transient.code, 'slot_error')
  assert.notEqual(s.pool.getAccount(s.primary.id)!.authRequired, true, 'a transient slot error never quarantines')
})

test('no selectable account → 503 no_account with retryAfterMs from the earliest reset', async (t) => {
  const s = setup(t)
  const reset = new Date(Date.now() + 600_000).toISOString()
  s.pool.recordFailure(s.primary.id, 'google', 'quota exhausted', reset)
  s.pool.recordFailure(s.second.id, 'google', 'quota exhausted', reset)
  const out = await s.registry.acquire({ holder: 'h', model: 'gemini-3-flash' })
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.status, 503)
  assert.equal(out.code, 'no_account')
  assert.ok(typeof out.retryAfterMs === 'number' && out.retryAfterMs > 0, JSON.stringify(out))
  assert.equal(s.calls.length, 0, 'the slot is never touched without an account')
})

test('renew extends; an expired or unknown lease is 404 and its slot is released', async (t) => {
  const s = setup(t)
  const g = await grant(s, { holder: 'h', ttlMs: 20_000 })
  s.advance(10_000)
  const r = s.registry.renew(g.leaseId, 30_000)
  assert.deepEqual(r, { ok: true, expiresAt: s.now() + 30_000 })
  s.advance(31_000)
  assert.equal(s.registry.renew(g.leaseId).ok, false)
  assert.deepEqual(s.released, [s.primary.id])
  assert.equal(s.registry.list().length, 0)
  assert.equal(s.registry.renew('unknown').ok, false)
})

test('sweep releases expired leases without settling', async (t) => {
  const s = setup(t)
  const g = await grant(s, { holder: 'evil\nholder' })
  const keep = await grant(s, { holder: 'k', ttlMs: LEASE_MAX_TTL_MS })
  s.advance(LEASE_DEFAULT_TTL_MS + 1)
  const before = JSON.stringify(s.pool.getAccounts())
  assert.equal(s.registry.sweep(), 1)
  assert.deepEqual(s.registry.list().map((l) => l.leaseId), [keep.leaseId])
  assert.equal(s.released.length, 1)
  assert.equal(s.registry.release(g.leaseId).ok, false, 'swept lease is gone')
  assert.equal(JSON.stringify(s.pool.getAccounts()), before, 'sweeping never settles the pool')
  const line = s.logs.find((l) => l.includes('released: expired'))!
  assert.ok(line.includes('"evil\\nholder"'), 'holder is escaped in the log: ' + line)
})

test('release settles exactly once with the shared one-shot classification', async (t) => {
  const s = setup(t)
  const cases: Array<[Parameters<ExternalLeaseRegistry['release']>[1], string]> = [
    [{}, 'none'],
    [{ ok: true }, 'success'],
    [{ ok: false, error: 'RESOURCE_EXHAUSTED: individual quota reached' }, 'quota'],
    [{ ok: false, error: 'model "gemini-x" is not recognized as a known model' }, 'model_unsupported'],
    [{ ok: false, error: 'eligibility check failed' }, 'eligibility'],
    [{ ok: false, error: 'authentication required' }, 'auth'],
    [{ ok: false, error: 'something else broke' }, 'other'],
    [{ ok: false }, 'other'],
    [{ ok: false, error: 'TOS_VIOLATION: violation of Terms of Service' }, 'tos'],
  ]
  for (const [report, outcome] of cases) {
    const g = await grant(s, { holder: 'h', accountId: s.second.id })
    assert.deepEqual(s.registry.release(g.leaseId, report), { ok: true, outcome }, JSON.stringify(report))
    assert.equal(s.registry.release(g.leaseId, report).ok, false, 'second release is 404')
  }
  assert.equal(s.released.length, cases.length, 'every slot released exactly once')
  const acc = s.pool.getAccount(s.second.id)!
  assert.equal(acc.authRequired, true, 'TOS quarantines')
  assert.ok((acc.cooldowns.google?.cooldownUntil ?? 0) > Date.now(), 'quota cooled the family')
  assert.equal(s.pool.isModelSupported(acc, 'gemini-x'), false, 'model marked unsupported')
})

test('release truncates a huge error to 8 KiB before it reaches the pool', async (t) => {
  const s = setup(t)
  const g = await grant(s, { holder: 'h', accountId: s.second.id })
  const out = s.registry.release(g.leaseId, { ok: false, error: 'TOS_VIOLATION ' + 'é'.repeat(20_000) })
  assert.deepEqual(out, { ok: true, outcome: 'tos' })
  const reason = s.pool.getAccount(s.second.id)!.authError ?? ''
  assert.match(reason, /^TOS_VIOLATION/)
  assert.ok(Buffer.byteLength(reason, 'utf8') <= 8 * 1024, 'reason bytes: ' + Buffer.byteLength(reason, 'utf8'))
})

test('dispose releases every lease and refuses new ones', async (t) => {
  const s = setup(t)
  await grant(s, { holder: 'a' })
  await grant(s, { holder: 'b', accountId: s.second.id })
  s.registry.dispose()
  assert.deepEqual(s.released.sort(), [s.primary.id, s.second.id].sort())
  assert.equal(s.registry.list().length, 0)
  const out = await s.registry.acquire({ holder: 'c' })
  assert.equal(out.ok === false && out.status, 503)
})

test('discovery file: atomic write, removed only while it still names this pid and url', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-endpoint-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ep = writeLinkEndpoint(dir, 4567, 'tok', 42)
  assert.deepEqual(JSON.parse(readFileSync(linkEndpointPath(dir), 'utf8')), {
    url: 'http://127.0.0.1:4567/plugins/agy-link', pid: process.pid, startedAt: 42, token: 'tok',
  })
  // Another host took over the file: leave it alone.
  writeFileSync(linkEndpointPath(dir), JSON.stringify({ ...ep, pid: ep.pid + 1 }))
  assert.equal(removeLinkEndpoint(dir, ep), false)
  assert.ok(existsSync(linkEndpointPath(dir)))
  writeFileSync(linkEndpointPath(dir), JSON.stringify(ep))
  assert.equal(removeLinkEndpoint(dir, ep), true)
  assert.equal(existsSync(linkEndpointPath(dir)), false)
  assert.equal(removeLinkEndpoint(dir, ep), false)
})

test('isolated account on agy >= 1.5: no slot, token prepared, SSH-isolation env handed out', async (t) => {
  const s = setup(t)
  s.setVersion(async () => '1.5.12')
  const g = await grant(s, { holder: 'h', accountId: s.second.id })
  assert.equal(s.calls.length, 0, 'the Windows slot is never taken')
  assert.deepEqual(s.prepared, [s.second.id])
  assert.equal(g.slot, false)
  assert.equal(g.account.isolated, true)
  assert.equal(g.account.home, s.second.dir)
  assert.equal(g.env.SSH_CONNECTION, '127.0.0.1 0 127.0.0.1 0')
  assert.equal(g.env.HOME, s.second.dir)
  assert.equal(g.env.GEMINI_CLI_HOME, join(s.second.dir, '.gemini'))
  if (process.platform === 'win32') {
    assert.equal(g.env.USERPROFILE, s.second.dir)
    assert.equal(g.env.HOMEDRIVE! + g.env.HOMEPATH!, s.second.dir)
  }
  assert.equal(g.env.AGY_CLI_NONINTERACTIVE_HEADLESS, '1')
  assert.equal(g.env.PATH, undefined, 'the host env is never copied')
  assert.deepEqual(s.registry.list().map((l) => l.slot), [false])
  assert.deepEqual(s.registry.release(g.leaseId, { ok: true }), { ok: true, outcome: 'success' })
  assert.equal(s.released.length, 0)
  assert.equal(s.registry.list().length, 0)
})

test('isolated token prep failure: 409 account_unavailable, pool untouched', async (t) => {
  const s = setup(t)
  s.setVersion(async () => '1.5.0')
  s.setPrep(false)
  const before = JSON.stringify(s.pool.getAccounts())
  const out = await s.registry.acquire({ holder: 'h', accountId: s.second.id })
  assert.equal(out.ok === false && out.status, 409)
  assert.equal(out.ok === false && out.code, 'account_unavailable')
  assert.match(out.ok === false ? out.error : '', /safety window/)
  assert.equal(JSON.stringify(s.pool.getAccounts()), before)
  assert.equal(s.calls.length, 0)
})

test('isolated account on agy < 1.5 keeps the slot; primary always takes the slot without HOME vars', async (t) => {
  const s = setup(t)
  const iso = await grant(s, { holder: 'h', accountId: s.second.id })
  assert.equal(iso.slot, true)
  assert.equal(iso.env.HOME, s.second.dir, 'the provider relocates HOME on every version')
  assert.deepEqual(s.prepared, [])
  s.setVersion(async () => '1.5.12')
  const prim = await grant(s, { holder: 'h', accountId: s.primary.id })
  assert.equal(prim.slot, true)
  assert.equal(prim.account.isolated, false)
  for (const k of ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SSH_CONNECTION', 'GEMINI_CLI_HOME']) {
    assert.equal(prim.env[k], undefined, k)
  }
  assert.deepEqual(s.calls.map((c) => c.account.id), [s.second.id, s.primary.id])
})

test('an unknown agy version is resolved before the slot decision', async (t) => {
  const s = setup(t)
  let resolveVersion: (v: string | null) => void = () => undefined
  s.setVersion(() => new Promise((r) => { resolveVersion = r }))
  const pending = s.registry.acquire({ holder: 'h', accountId: s.second.id })
  await new Promise((r) => setImmediate(r))
  assert.equal(s.calls.length + s.prepared.length, 0, 'nothing decided while the probe is pending')
  resolveVersion('1.5.3')
  const g = (await pending) as LeaseGrant
  assert.equal(g.slot, false)
  assert.deepEqual(s.prepared, [s.second.id])
  // A failed probe falls back to the slot, which is safe on every agy.
  s.setVersion(async () => { throw new Error('probe failed') })
  const fallback = await grant(s, { holder: 'h', accountId: s.second.id })
  assert.equal(fallback.slot, true)
})

test('leaseAgyEnv: proxy folded to one case on Windows, loopback NO_PROXY, quiet keys only', () => {
  const acc = { id: 'p', alias: 'P', dir: '', systemHome: true, enabled: true, createdAt: 0 } as unknown as ManagedAccount
  const win = leaseAgyEnv(acc, 'http://127.0.0.1:7890', 'win32')
  assert.deepEqual(Object.keys(win).sort(), [
    'AGY_CLI_DISABLE_AUTO_UPDATE', 'AGY_CLI_INTERACTIVE_HEADLESS', 'AGY_CLI_NONINTERACTIVE_HEADLESS',
    'ALL_PROXY', 'BROWSER', 'CI', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  ])
  assert.equal(win.NO_PROXY, '127.0.0.1,localhost,::1')
  const posix = leaseAgyEnv(acc, '', 'linux')
  assert.equal(posix.HTTPS_PROXY, undefined)
  assert.equal(posix.no_proxy, '127.0.0.1,localhost,::1')
})

test('concurrent leases of one account share a single token read/refresh (no racing token-file writes)', async () => {
  // prepareIsolatedCliToken → getValidAccessToken is single-flight per account:
  // overlapping acquires (and the plugin's own runs) await one in-flight attempt,
  // and a refresh is persisted with an atomic rename, so the file is never torn.
  let reads = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => { release = r })
  const deps = {
    getStoredToken: async () => {
      reads++
      await gate
      return { accessToken: 'at', expiryMs: Date.now() + 3_600_000 }
    },
  } as unknown as QuotaTokenDeps
  const account = { id: 'acc-1', dir: '/tmp/acc-1' } as ManagedAccount
  const inFlight = new Map<string, Promise<string | null>>()
  const a = getValidAccessToken(deps, account, inFlight)
  const b = getValidAccessToken(deps, account, inFlight)
  release()
  assert.deepEqual(await Promise.all([a, b]), ['at', 'at'])
  assert.equal(reads, 1)
  assert.equal(inFlight.size, 0, 'the slot is freed once settled')
})
