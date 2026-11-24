import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService } from '../src/host/quota.ts'
import {
  CLI_TOKEN_SAFETY_MS,
  isTokenSafeForCli,
  prepareCliToken,
  tokenRemainingMs,
} from '../src/features/quota/cli-token.ts'
import { cliTokenSource, isAccessTokenFresh } from '../src/features/quota/token.ts'

// The bug these guard: agy gives its keyring read a FIXED 10s budget and runs
// the token refresh in a separate goroutine. When the stored access token was
// already dying, the budget lost the race and agy fell back to INTERACTIVE
// OAuth — it opened the user's browser and waited for a human. Live evidence on
// this machine: 9 of 375 hourly `agy -p /usage` polls (2.4%) popped a browser,
// every one of them with <=60s of token life, and 0 of the 746 polls that had
// >=1min left. So the poll must never hand agy a nearly-expired token.

test('tokenRemainingMs reports -Infinity when the expiry is unknown', () => {
  assert.equal(tokenRemainingMs(null), Number.NEGATIVE_INFINITY)
  assert.equal(tokenRemainingMs(undefined), Number.NEGATIVE_INFINITY)
  assert.equal(tokenRemainingMs({}), Number.NEGATIVE_INFINITY)
  assert.equal(tokenRemainingMs({ expiryMs: 5_000 }, 1_000), 4_000)
})

test('isTokenSafeForCli requires a known expiry beyond the safety window', () => {
  const now = 1_000_000
  assert.equal(CLI_TOKEN_SAFETY_MS, 120_000, 'two minutes is far above the observed <=60s failure band')
  assert.equal(isTokenSafeForCli({ accessToken: 'a', expiryMs: now + 119_999 }, now), false, 'one second short is not safe')
  assert.equal(isTokenSafeForCli({ accessToken: 'a', expiryMs: now + CLI_TOKEN_SAFETY_MS }, now), true)
  assert.equal(isTokenSafeForCli({ accessToken: 'a', expiryMs: now + 3_600_000 }, now), true)
  // No expiry is NOT "valid forever": agy would treat it as unusable and refresh
  // at startup, which is exactly the browser-popping path. Issue #112 made the
  // same misreading a permanent 401 loop.
  assert.equal(isTokenSafeForCli({ accessToken: 'a' }, now), false)
  assert.equal(isTokenSafeForCli({ expiryMs: now + 3_600_000 }, now), false, 'an expiry without an access token is useless')
  assert.equal(isTokenSafeForCli(null, now), false)
})

test('the refresh window is a parameter: an HTTP call needs 60s, a child process needs the CLI window', () => {
  const now = 1_000_000
  const ninety = { accessToken: 'a', expiryMs: now + 90_000 }
  assert.equal(isAccessTokenFresh(ninety, now), true, '90s is plenty for one HTTP request')
  assert.equal(
    isAccessTokenFresh(ninety, now, CLI_TOKEN_SAFETY_MS),
    false,
    'but not for agy: it spends seconds before its first request and refreshes racy at startup',
  )
})

test('prepareCliToken leaves a healthy token alone and never refreshes it', async () => {
  let refreshes = 0
  const ok = await prepareCliToken({
    readStored: async () => ({ accessToken: 'ya29.healthy', expiryMs: Date.now() + 3_600_000 }),
    refresh: async () => {
      refreshes++
      return true
    },
  })
  assert.equal(ok, true)
  assert.equal(refreshes, 0, 'a token inside the window must not cost a refresh round-trip')
})

test('prepareCliToken refreshes a dying token, then re-reads and writes the slot before the spawn', async () => {
  const steps: string[] = []
  let stored: { accessToken?: string; expiryMs?: number } | null = {
    accessToken: 'ya29.dying',
    expiryMs: Date.now() + 12_000,
  }
  const logs: string[] = []
  const ok = await prepareCliToken({
    readStored: async () => {
      steps.push('read')
      return stored
    },
    refresh: async () => {
      steps.push('refresh')
      stored = { accessToken: 'ya29.fresh', expiryMs: Date.now() + 3_600_000 }
      return true
    },
    syncSlot: () => {
      steps.push('syncSlot')
      return true
    },
    log: (m) => logs.push(m),
  })
  assert.equal(ok, true)
  assert.deepEqual(steps, ['read', 'refresh', 'syncSlot', 'read'], 'the slot write must precede the verification read: on Windows the slot is what agy loads')
  assert.ok(logs.some((m) => m.includes('has 12s left')), 'the decision must be diagnosable: ' + logs.join(' | '))
})

test('prepareCliToken refuses the CLI when the token cannot be refreshed', async () => {
  const logs: string[] = []
  const ok = await prepareCliToken({
    readStored: async () => ({ accessToken: 'ya29.dying', expiryMs: Date.now() + 1_000 }),
    refresh: async () => false,
    log: (m) => logs.push(m),
  })
  assert.equal(ok, false, 'a skipped round costs one quota sample; a browser window costs the user attention')
  assert.ok(logs.some((m) => m.includes('could not be refreshed')))
})

test('prepareCliToken refuses the CLI when the refreshed token is still outside the window', async () => {
  const logs: string[] = []
  const ok = await prepareCliToken({
    readStored: async () => ({ accessToken: 'ya29.dying', expiryMs: Date.now() + 1_000 }),
    // Refresh "succeeds" but the backend handed back a token that is still
    // about to expire (clock skew, short-lived grant) — spawning would still
    // lose agy's 10s race.
    refresh: async () => true,
    syncSlot: () => true,
    log: (m) => logs.push(m),
  })
  assert.equal(ok, false)
  assert.ok(logs.some((m) => m.includes('still outside the safety window')))
})

test('prepareCliToken refuses the CLI when the slot write fails', async () => {
  const logs: string[] = []
  let stored: { accessToken?: string; expiryMs?: number } | null = {
    accessToken: 'ya29.dying',
    expiryMs: Date.now() + 1_000,
  }
  const ok = await prepareCliToken({
    readStored: async () => stored,
    refresh: async () => {
      stored = { accessToken: 'ya29.fresh', expiryMs: Date.now() + 3_600_000 }
      return true
    },
    syncSlot: () => false,
    log: (m) => logs.push(m),
  })
  assert.equal(ok, false, 'agy would load the OLD slot content — the refresh is worthless until it lands')
  assert.ok(logs.some((m) => m.includes('could not be written to the credential slot')))
})

test('prepareCliToken tries one refresh when no credential is stored at all', async () => {
  let refreshes = 0
  const logs: string[] = []
  const ok = await prepareCliToken({
    readStored: async () => null,
    refresh: async () => {
      refreshes++
      return true
    },
    log: (m) => logs.push(m),
  })
  assert.equal(refreshes, 1, 'a missing credential is "no known expiry", so it gets one refresh attempt')
  assert.equal(ok, false, 'and when the refresh produces nothing, the CLI stands down')
  assert.ok(logs.some((m) => m.includes('no known expiry')), logs.join(' | '))
})

// ---- QuotaService integration -------------------------------------------

function primaryAccount(pool: AccountPoolManager) {
  const primary = pool.getAccounts().find((a) => a.systemHome)
  assert.ok(primary, 'bootstrap default primary exists')
  return primary
}

test('the CLI quota read refreshes a dying token before it ever spawns agy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-token-refresh-'))
  const pool = new AccountPoolManager(dir)
  const primary = primaryAccount(pool)
  let refreshes = 0
  let storedReads = 0

  class DyingTokenService extends QuotaService {
    override async readSystemKeychainToken() {
      return { accessToken: 'ya29.slot', refreshToken: '1//GRANT' }
    }
    override async getStoredToken() {
      storedReads++
      return storedReads === 1
        ? { accessToken: 'ya29.slot', refreshToken: '1//GRANT', expiryMs: Date.now() + 5_000 }
        : { accessToken: 'ya29.slot', refreshToken: '1//GRANT', expiryMs: Date.now() + 3_600_000 }
    }
    override async getValidAccessToken(_account: unknown, minValidityMs?: number) {
      refreshes++
      assert.equal(
        minValidityMs,
        CLI_TOKEN_SAFETY_MS,
        'the refresh must target the same window the gate enforces, or its result is rejected immediately',
      )
      return 'ya29.slot'
    }
  }

  const svc = new DyingTokenService(pool, () => '', () => null, { bin: () => 'agy' }) as unknown as {
    prepareCliToken(a: unknown): Promise<boolean>
  }
  assert.equal(await svc.prepareCliToken(primary), true, 'the refreshed credential clears the gate')
  assert.equal(refreshes, 1, 'exactly one refresh round-trip, not one per read')
})

test('a token that cannot be brought into the window makes the CLI quota read stand down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-token-skip-'))
  const pool = new AccountPoolManager(dir)
  const primary = primaryAccount(pool)
  let refreshes = 0

  class StuckTokenService extends QuotaService {
    override async readSystemKeychainToken() {
      return { accessToken: 'ya29.slot', refreshToken: '1//GRANT' }
    }
    override async getStoredToken() {
      return { accessToken: 'ya29.slot', refreshToken: '1//GRANT', expiryMs: Date.now() + 5_000 }
    }
    override async getValidAccessToken() {
      refreshes++
      return null
    }
  }

  const svc = new StuckTokenService(pool, () => '', () => null, { bin: () => 'agy' })
  const read = (
    svc as unknown as { readCliUsageFamilies(a: unknown): Promise<unknown> }
  ).readCliUsageFamilies.bind(svc)
  assert.equal(await read(primary), null, 'no spawn at all: the REST path answers this round')
  assert.equal(refreshes, 1, 'the refresh was attempted once before giving up')
})
test('prepareIsolatedCliToken refreshes the isolated token file but never writes the credential slot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-token-isolated-'))
  const pool = new AccountPoolManager(dir)
  const isolated = pool.createAccountSlot('Isolated')
  let storedReads = 0
  let slotWrites = 0

  class DyingIsolatedService extends QuotaService {
    override async getStoredToken() {
      storedReads++
      return { accessToken: 'ya29.iso', refreshToken: '1//ISO', expiryMs: Date.now() + (storedReads === 1 ? 5_000 : 3_600_000) }
    }
    override async getValidAccessToken() {
      return 'ya29.iso'
    }
  }

  const svc = new DyingIsolatedService(pool, () => '', () => null, {
    bin: () => 'agy',
    syncSlot: () => {
      slotWrites++
      return true
    },
  })
  assert.equal(await svc.prepareIsolatedCliToken(isolated), true)
  assert.equal(storedReads, 2, 'read, refresh, re-read')
  assert.equal(slotWrites, 0, 'SSH isolation reads the token file; the Windows slot is not touched')
})

// issue #199: the CLI safety gate must inspect the credential agy actually
// loads. On Windows the system-HOME primary runs off the Credential Manager
// slot; reading the on-disk mirror let the gate pass a token agy never sees.
test('issue #199: cliTokenSource picks the slot only for the Windows system-HOME primary', () => {
  assert.equal(cliTokenSource('win32', { systemHome: true, dir: 'C:\\acc' }), 'slot')
  assert.equal(cliTokenSource('win32', { dir: undefined }), 'slot')
  assert.equal(cliTokenSource('win32', { systemHome: false, dir: 'C:\\iso' }), 'stored')
  assert.equal(cliTokenSource('darwin', { systemHome: true }), 'stored')
  assert.equal(cliTokenSource('linux', { systemHome: true }), 'stored')
})
