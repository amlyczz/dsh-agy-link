// CLI usage scraping guards: when the `agy` CLI is allowed to answer for a
// credential slot, the credential-slot mutex, and the REST fallback when it
// is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaService } from '../../../src/host/quota.ts'
import { credentialSlotMutex } from '../../../src/host/credential-slot.ts'
import { makeTempPool, writeAccountToken } from './quota-fixtures.ts'

test('REGRESSION: isolated pool accounts never consult the CLI nor pay a keystore read', async () => {
  // 2026-10-26: every pool row displayed the slot owner's numbers with identical
  // reset instants. gy reads the OS keystore before the per-HOME token file,
  // so the CLI can only ever answer for the account that owns that store — the
  // system login. Isolated accounts must therefore never spawn it, and the
  // rejection must not even read the keystore (four PowerShell cold starts per
  // poll would make the pool needlessly slow).
  const { dir, pool } = makeTempPool('agy-quota-cliiso-')
  const acc = pool.createAccountSlot('isolated')
  let keystoreReads = 0
  class CountingService extends QuotaService {
    override async readSystemKeychainToken() {
      keystoreReads++
      return { accessToken: 'ya29.owner', refreshToken: '1//OWNER' }
    }
  }
  const svc = new CountingService(pool, () => '', () => null, { bin: () => 'agy' })
  const read = (
    svc as unknown as { readCliUsageFamilies(a: unknown): Promise<unknown> }
  ).readCliUsageFamilies.bind(svc)
  assert.equal(await read(acc), null, 'an isolated account must fall back to the REST path')
  assert.equal(keystoreReads, 0, 'the fast reject must not touch the keystore')
})

test('the CLI is refused for the primary while the slot carries another grant', async () => {
  const { dir, pool } = makeTempPool('agy-quota-cliguard-')
  const primary = pool.getAccounts().find((a) => a.systemHome)
  assert.ok(primary, 'bootstrap default primary exists')

  const build = (slot: { refreshToken: string }, own: { refreshToken: string }) => {
    class Guarded extends QuotaService {
      override async readSystemKeychainToken() {
        return { accessToken: 'ya29.' + slot.refreshToken, ...slot }
      }
      override async getStoredToken() {
        return { accessToken: 'ya29.' + own.refreshToken, ...own }
      }
    }
    return new Guarded(pool, () => '', () => null, { bin: () => 'agy' }) as unknown as {
      cliSlotHoldsAccount(a: unknown): Promise<boolean>
    }
  }

  assert.equal(
    await build({ refreshToken: '1//OTHER' }, { refreshToken: '1//PRIMARY' }).cliSlotHoldsAccount(primary),
    false,
    'a handed-over slot belongs to a secondary; its numbers must not land on the primary',
  )
  assert.equal(
    await build({ refreshToken: '1//PRIMARY' }, { refreshToken: '1//PRIMARY' }).cliSlotHoldsAccount(primary),
    true,
    'the owner is allowed to read Argon through the CLI',
  )
})

test('REGRESSION: readCliUsageFamilies fast-reject must NOT wipe Argon quota from isolated accounts', async () => {
  const { dir, pool } = makeTempPool('agy-quota-cli-iso-argon-')
  const acc = pool.createAccountSlot('isolated-pro')
  pool.updateAccountQuotas(acc.id, {
    argon: { weeklyFraction: 0.55, weeklyResetTime: '2026-10-30T00:00:00Z' },
  })

  const svc = new QuotaService(pool, () => '', () => null, { bin: () => 'agy' })
  const read = (
    svc as unknown as { readCliUsageFamilies(a: unknown): Promise<unknown> }
  ).readCliUsageFamilies.bind(svc)

  assert.equal(await read(pool.getAccount(acc.id)!), null, 'isolated account fast-rejects CLI')
  assert.equal(
    pool.getAccount(acc.id)!.quotas.argon?.weeklyFraction,
    0.55,
    'Argon quota must NOT be cleared by the CLI fast-reject',
  )
})

test('authoritative REST summary cleans up stale Argon on free accounts but preserves Pro accounts', async () => {
  const { dir, pool } = makeTempPool('agy-quota-authoritative-argon-')

  // 1. Free account with stale Argon leaked from previous slot bug
  const freeAcc = pool.createAccountSlot('free-user')
  writeAccountToken(freeAcc.dir!, 'ya29.free')
  pool.updateAccountQuotas(freeAcc.id, {
    argon: { weeklyFraction: 0.8 },
    google: { remainingFraction: 1 },
  })

  // 2. Pro account with legitimate Argon
  const proAcc = pool.createAccountSlot('pro-user')
  writeAccountToken(proAcc.dir!, 'ya29.pro')

  class MockRestService extends QuotaService {
    override async fetchUserInfo(token: string) {
      return token.includes('pro') ? { email: 'pro@test.com' } : { email: 'free@test.com' }
    }
    override async fetchAvailableModels() {
      return { models: {} } as never
    }
    // Without this the empty model list sends the pipeline into the legacy
    // retrieveUserQuota fallback, which used to reach the REAL endpoints with a
    // fake token (2 x 10s timeout: 22s per run, and pointless Google traffic
    // from a unit test).
    protected override async fetchUserQuotaEndpoint(): Promise<Response> {
      return new Response('{}', { status: 200 })
    }
    override async fetchQuotaSummary(token: string) {
      if (token.includes('pro')) {
        return {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-28T00:00:00Z' }],
            },
            {
              displayName: 'Gemini 4 Argon',
              buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.55, resetTime: '2026-10-30T00:00:00Z' }],
            },
          ],
        } as never
      }
      return {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-28T00:00:00Z' }],
          },
        ],
      } as never
    }
  }

  const svc = new MockRestService(pool, () => '', () => '1.4.5', { bin: () => 'agy' })

  // Refresh free account: authoritative summary has NO Argon, stale row must be wiped
  await svc.refreshAccountQuota(pool.getAccount(freeAcc.id)!, true)
  assert.equal(pool.getAccount(freeAcc.id)!.quotas.argon, undefined, 'free account stale Argon cleared')

  // Refresh pro account: authoritative summary has Argon, row must be populated
  await svc.refreshAccountQuota(pool.getAccount(proAcc.id)!, true)
  assert.equal(pool.getAccount(proAcc.id)!.quotas.argon?.weeklyFraction, 0.55, 'pro account Argon retained')
})

test('cliSlotHoldsAccount refuses when neither durable primary credential nor disk token exists', async () => {
  const { dir, pool } = makeTempPool('agy-quota-noselfmatch-')
  const primary = pool.getAccounts().find((a) => a.systemHome)
  assert.ok(primary)

  class ServiceWithoutAuthoritativeStore extends QuotaService {
    override async readSystemKeychainToken() {
      // The slot holds some token (e.g. secondary account's token)
      return { accessToken: 'ya29.slot', refreshToken: '1//SLOT' }
    }
    // The contract under test is "no durable primary AND no disk token". Without
    // this stub the test reads the DEVELOPER's real ~/.gemini token file: on a
    // machine where agy has signed in it takes the `stored !== null` branch and
    // fails, while a clean CI runner passes. Pin the environment instead.
    override async getStoredToken(): Promise<null> {
      return null
    }
  }

  const svc = new ServiceWithoutAuthoritativeStore(pool, () => '', () => null, { bin: () => 'agy' }) as unknown as {
    cliSlotHoldsAccount(a: unknown): Promise<boolean>
  }

  // The refusal contract differs per platform because only Windows swaps the
  // shared credential slot between accounts:
  //  - Windows: no durable primary credential and no disk token means we cannot
  //    prove the slot is ours, so it must refuse (never self-match).
  //  - Linux/macOS: `agy` keeps the primary credential in the OS keyring only
  //    (#143), so a pool with no sibling can safely claim the slot; refusing
  //    here would kill CLI-based quota for every keyring-only primary.
  const expected = process.platform === "win32" ? false : true
  assert.equal(await svc.cliSlotHoldsAccount(primary), expected)
})

test('readCliUsageFamilies acquires credentialSlotMutex and degrades to REST on contention', async () => {
  if (process.platform !== 'win32') return
  const { dir, pool } = makeTempPool('agy-quota-mutex-')
  const primary = pool.getAccounts().find((a) => a.systemHome)
  assert.ok(primary)

  class MutexAwareService extends QuotaService {
    override async readSystemKeychainToken() {
      return { accessToken: 'ya29.primary', refreshToken: '1//PRIMARY' }
    }
    override async getStoredToken() {
      return { accessToken: 'ya29.primary', refreshToken: '1//PRIMARY' }
    }
  }

  const svc = new MutexAwareService(pool, () => '', () => null, { bin: () => 'agy' })
  const read = (
    svc as unknown as { readCliUsageFamilies(a: unknown): Promise<unknown> }
  ).readCliUsageFamilies.bind(svc)

  // Hold the mutex externally (simulating a secondary account's in-flight turn)
  const release = await credentialSlotMutex.acquire({ timeoutMs: 10_000 })
  try {
    // With mutex held by another turn, readCliUsageFamilies must time out on the mutex
    // and safely return null (triggering REST fallback) instead of reading the secondary's slot
    const result = await read(primary)
    assert.equal(result, null, 'must degrade to REST when credential slot is busy')
  } finally {
    release()
  }
})

test("cliSlotHoldsAccount refuses a slot that belongs to a sibling isolated account", async () => {
  const { dir, pool } = makeTempPool('agy-quota-sibling-slot-')
  pool.setAccountEnabled("acc_primary", false)
  const secondary = pool.createAccountSlot("sib")
  const primary = pool.getAccounts().find((a) => a.systemHome)
  assert.ok(primary)
  assert.ok(secondary.dir)
  const token = { accessToken: "a-sib", refreshToken: "1//SIBLING" }
  class SiblingSlotService extends QuotaService {
    override async readSystemKeychainToken() {
      return token
    }
    override async getStoredToken(a: { id?: string }) {
      return a.id === secondary.id ? token : null
    }
  }
  const svc = new SiblingSlotService(pool, () => "", () => null, { bin: () => "agy" }) as unknown as {
    cliSlotHoldsAccount(a: unknown): Promise<boolean>
  }
  assert.equal(await svc.cliSlotHoldsAccount(primary), false)
})
