// Issue #232: the Windows file-based/WSL disk token mirror must honour
// `respectExternalSignIn` exactly like the Windows Credential Manager slot —
// an external standalone sign-in on disk is preserved, while the plugin's own
// (possibly revoked) grant stays replaceable so the WSL self-heal keeps working.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isExternalCredentialGrant,
  isExternalDiskSignIn,
  readLastInstalledFingerprintAt,
  syncPrimaryDiskTokenFile,
  writeLastInstalledFingerprintAt,
  writePrimaryCredentialAt,
} from '../../src/domain/credentials/docs.ts'
import { isExternalSlotSignIn } from '../../src/domain/credentials/external-guard.ts'
import { prepareAccountTokenForSpawn } from '../../src/host/credential-slot.ts'
import { persistRefreshedToken, quotaTokenFilePath, type QuotaTokenDeps } from '../../src/features/quota/token.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

function tokenDoc(refreshToken: string, accessToken = 'ya29.access', expiryMs = Date.now() + 3_600_000): string {
  return JSON.stringify({
    token: { access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expiry: new Date(expiryMs).toISOString() },
    auth_method: 'consumer',
  })
}

function setPlatform(value: NodeJS.Platform): () => void {
  const prev = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => { if (prev) Object.defineProperty(process, 'platform', prev) }
}

function makeAccount(id: string, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return { id, alias: id, email: `${id}@example.com`, dir: '', enabled: true, createdAt: 1, cooldowns: {}, quotas: {}, ...overrides }
}

const PRIMARY_RAW = tokenDoc('rt-primary', 'acc-primary')
const primaryRaw = (): string => PRIMARY_RAW

test('#232 isExternalDiskSignIn: only a complete sign-in with a provably distinct grant is external', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'agy-ext-guard-'))
  try {
    // Same grant as the saved primary -> ours
    assert.equal(isExternalDiskSignIn(tokenDoc('rt-primary'), primaryRaw(), baseDir), false)
    // A grant this plugin installed last -> ours (leftover mirror), never external
    const installed = tokenDoc('rt-previous-primary', 'acc-prev')
    writeLastInstalledFingerprintAt(installed, baseDir)
    assert.ok(readLastInstalledFingerprintAt(baseDir))
    assert.equal(isExternalDiskSignIn(installed, primaryRaw(), baseDir), false)
    // Without the baseDir the fingerprint cannot be consulted: same blob counts as external
    assert.equal(isExternalDiskSignIn(installed, primaryRaw()), true)
    // A complete sign-in with another grant -> external
    assert.equal(isExternalDiskSignIn(tokenDoc('rt-someone-else'), primaryRaw(), baseDir), true)
    // Dead documents never count as an external sign-in (they authenticate nobody)
    assert.equal(isExternalDiskSignIn(JSON.stringify({ token: { access_token: 'only-access' } }), primaryRaw(), baseDir), false)
    assert.equal(isExternalDiskSignIn('not json', primaryRaw(), baseDir), false)
    assert.equal(isExternalDiskSignIn(null, primaryRaw(), baseDir), false)
    // The slot guard and the disk guard share one predicate
    assert.equal(isExternalSlotSignIn(tokenDoc('rt-someone-else'), primaryRaw(), baseDir), true)
    assert.equal(isExternalSlotSignIn(installed, primaryRaw(), baseDir), false)
    assert.equal(isExternalCredentialGrant(installed, primaryRaw(), baseDir), false)
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('#232 syncPrimaryDiskTokenFile preserves an external file-based sign-in only when respectExternalSignIn is on', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-ext-home-'))
  const baseDir = mkdtempSync(join(tmpdir(), 'agy-ext-pool-'))
  const diskFile = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  try {
    // An OLDER but still valid external sign-in (the exact corner from the issue)
    const external = tokenDoc('rt-external-user', 'acc-external', Date.now() + 3_600_000)
    writeFileSync(diskFile, external, 'utf8')

    // 1. Setting on: untouched, and the log says why
    const logsOn: string[] = []
    assert.equal(syncPrimaryDiskTokenFile(primaryRaw(), home, (m) => logsOn.push(m), { baseDir, respectExternalSignIn: true }), false)
    assert.equal(readFileSync(diskFile, 'utf8'), external)
    assert.match(logsOn.join('\n'), /preserving it \(respectExternalSignIn\)/)

    // 2. Setting off (default): overwritten, with the opt-in notice
    const logsOff: string[] = []
    assert.equal(syncPrimaryDiskTokenFile(primaryRaw(), home, (m) => logsOff.push(m), { baseDir }), true)
    assert.equal(readFileSync(diskFile, 'utf8'), primaryRaw())
    assert.match(logsOff.join('\n'), /enable respectExternalSignIn to preserve it/)

    // 3. Self-heal kept: the plugin's OWN revoked grant on disk is replaced even with the setting on
    const ownRevoked = tokenDoc('rt-primary', 'acc-revoked-old', Date.now() - 86_400_000)
    writeFileSync(diskFile, ownRevoked, 'utf8')
    assert.equal(syncPrimaryDiskTokenFile(primaryRaw(), home, undefined, { baseDir, respectExternalSignIn: true }), true)
    assert.equal(readFileSync(diskFile, 'utf8'), primaryRaw())

    // 4. A previous grant of the primary that this plugin installed is also replaceable
    const previousOwn = tokenDoc('rt-previous-primary', 'acc-prev')
    writeLastInstalledFingerprintAt(previousOwn, baseDir)
    writeFileSync(diskFile, previousOwn, 'utf8')
    assert.equal(syncPrimaryDiskTokenFile(primaryRaw(), home, undefined, { baseDir, respectExternalSignIn: true }), true)
    assert.equal(readFileSync(diskFile, 'utf8'), primaryRaw())

    // 5. A dead external document (no refresh token) is not a sign-in: replaced
    writeFileSync(diskFile, JSON.stringify({ token: { access_token: 'only-access' } }), 'utf8')
    assert.equal(syncPrimaryDiskTokenFile(primaryRaw(), home, undefined, { baseDir, respectExternalSignIn: true }), true)
    assert.equal(readFileSync(diskFile, 'utf8'), primaryRaw())
    assert.ok(existsSync(diskFile + '.bak'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('#232 prepareAccountTokenForSpawn and persistRefreshedToken honour respectExternalSignIn for the win32 primary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-ext-spawn-'))
  const home = join(root, 'home')
  const poolDir = join(root, 'pool')
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  mkdirSync(poolDir, { recursive: true })
  const diskFile = join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const restore = setPlatform('win32')
  // `quotaTokenFilePath(primary)` resolves through `os.homedir()`: sandbox it so a
  // unit test can never touch the developer's real `~/.gemini` token file.
  const savedHome = process.env.HOME
  const savedUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const primary = makeAccount('acc_primary', { systemHome: true })
    const external = tokenDoc('rt-external-user', 'acc-external', Date.now() + 3_600_000)
    writeFileSync(diskFile, external, 'utf8')
    writePrimaryCredentialAt({ raw: primaryRaw(), email: 'prim@example.com', savedAt: Date.now() }, poolDir)
    const quota = { getValidAccessToken: async () => 'tok' }

    // Spawn pre-flight: preserved with the setting on, replaced with it off
    await prepareAccountTokenForSpawn({ account: primary, quota, poolDir, homeDir: home, respectExternalSignIn: true })
    assert.equal(readFileSync(diskFile, 'utf8'), external, 'external file-based sign-in survives the spawn pre-flight')
    await prepareAccountTokenForSpawn({ account: primary, quota, poolDir, homeDir: home })
    assert.equal(readFileSync(diskFile, 'utf8'), primaryRaw())

    // Background refresh that used the primary's own grant while the disk holds an external sign-in
    writeFileSync(diskFile, external, 'utf8')
    const adopted: Array<{ raw: string }> = []
    const deps: QuotaTokenDeps = {
      pool: { dir: poolDir, clearAuthRequired: () => {}, markAuthRequired: () => {} },
      proxyFor: () => undefined,
      readSystemKeychainToken: async () => null,
      getStoredToken: async () => null,
      persistRefreshedToken: () => {},
      readPrimaryCredential: () => ({ raw: primaryRaw(), email: 'prim@example.com', savedAt: Date.now() }),
      writePrimaryCredential: (c) => { adopted.push(c); return true },
      parseCredentialDoc: (raw) => {
        if (!raw) return null
        const p = JSON.parse(raw) as { token?: { refresh_token?: string; access_token?: string } }
        return { refreshToken: p.token?.refresh_token, accessToken: p.token?.access_token }
      },
      respectExternalSignIn: true,
    }
    persistRefreshedToken(deps, primary, { access_token: 'refreshed', expiryMs: Date.now() + 3_600_000 }, 'rt-primary')
    assert.equal(readFileSync(diskFile, 'utf8'), external, 'external disk sign-in is not overwritten by a background refresh')
    assert.ok(adopted[0]?.raw.includes('refreshed') && adopted[0].raw.includes('rt-primary'), 'the refreshed primary grant still lands in the durable store')

    // Same situation with the setting off: the stale external file is replaced (v0.6.106 behaviour)
    writeFileSync(diskFile, external, 'utf8')
    persistRefreshedToken({ ...deps, respectExternalSignIn: false }, primary, { access_token: 'refreshed-2', expiryMs: Date.now() + 3_600_000 }, 'rt-primary')
    assert.ok(readFileSync(diskFile, 'utf8').includes('refreshed-2'))
    // And the isolated-account cross-grant guard is untouched by the setting
    const iso = makeAccount('acc_iso', { dir: join(root, 'iso'), systemHome: false })
    mkdirSync(join(iso.dir!, '.gemini', 'antigravity-cli'), { recursive: true })
    const isoFile = quotaTokenFilePath(iso)
    const isoExisting = tokenDoc('rt-iso')
    writeFileSync(isoFile, isoExisting, 'utf8')
    persistRefreshedToken({ ...deps, respectExternalSignIn: false }, iso, { access_token: 'x', expiryMs: Date.now() + 3_600_000 }, 'rt-other')
    assert.equal(readFileSync(isoFile, 'utf8'), isoExisting)
  } finally {
    restore()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedUserProfile
    rmSync(root, { recursive: true, force: true })
  }
})
