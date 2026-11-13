// Boot-time hygiene for the account pool, moved verbatim out of apply().
// Covers stale staging/log cleanup, per-account login keychains (macOS) and the
// process-global credential slot (Windows). Keeps index.ts a thin root.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectSystemProxy } from './wincred.ts'
import { ensureIsolatedKeychain, purgeStaleIsolatedKeychain, repairMacSystemKeychain } from './runner.ts'
import { resolvePrimaryCredential, findDuplicateCredentialIdentities } from './credential-slot.ts'
import { hasRefreshToken, readAccountCredential, saveCredentialBackup } from './credential-backup.ts'
import type { HostServices } from './services.ts'

/**
 * On macOS, agy uses go-keyring which stores OAuth credentials inside the
 * account's isolated keychain (acc.dir/Library/Keychains/login.keychain-db) rather
 * than writing a file to ~/.gemini/antigravity-cli/antigravity-oauth-token.
 * When the disk token file is absent, recover it from the keychain so the account
 * is not falsely quarantined as auth_required.
 */
export function restoreTokenFromMacKeychain(accDir: string, tokenFile: string, log?: (msg: string) => void): string | null {
  if (process.platform !== 'darwin') return null
  const candidates = [
    join(accDir, 'Library', 'Keychains', 'login.keychain-db'),
    join(accDir, 'Library', 'Keychains', 'login.keychain'),
  ]
  const targetKc = candidates.find((p) => existsSync(p))
  if (!targetKc) return null
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w', targetKc], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).trim()
    if (!raw.startsWith('go-keyring-base64:')) return null
    const jsonStr = Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
    if (!hasRefreshToken(jsonStr)) return null
    mkdirSync(dirname(tokenFile), { recursive: true })
    writeFileSync(tokenFile, jsonStr, { mode: 0o600 })
    saveCredentialBackup(tokenFile, jsonStr)
    log?.(`[agy-link] restored account credential from macOS isolated keychain for ${accDir}`)
    return jsonStr
  } catch {
    return null
  }
}

export function runBootHygiene(services: HostServices): void {
  const { pool, store, log, getConfig } = services
  try {
    const validAccIds = new Set(pool.getAccounts().map((a) => a.id))
    store.cleanupStaleAccounts(validAccIds)
  } catch {
    // best-effort hygiene
  }
  const swept = pool.sweepStaleStaging()
  if (swept > 0) log('swept ' + swept + ' stale staging dir(s)')
  const logsSwept = pool.sweepOldLogs(getConfig().logRetentionDays)
  if (logsSwept > 0) log('swept ' + logsSwept + ' old log file(s)')
  // Provision per-account login keychains for isolated pool homes (macOS):
  // without one, agy's keyring save pops the system "create login keychain"
  // password dialog on every token refresh. Idempotent; pre-existing homes
  // from older versions are covered here too.
  if (process.platform === 'darwin') {
    try {
      const repaired = repairMacSystemKeychain()
      if (repaired) log('repaired macOS system keychain settings (restored real login keychain)')
    } catch {
      // ignore
    }
  }
  let kcProvisioned = 0
  for (const acc of pool.getAccounts()) {
    if (acc.dir && !acc.systemHome) {
      purgeStaleIsolatedKeychain(acc.dir)
      if (ensureIsolatedKeychain(acc.dir)) kcProvisioned++
      const tokenFile = join(acc.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      let token = readAccountCredential(tokenFile, log)
      if (!token && process.platform === 'darwin') {
        token = restoreTokenFromMacKeychain(acc.dir, tokenFile, log)
      }
      if (!token && !acc.authRequired) {
        pool.markAuthRequired?.(acc.id, 'credential file is missing or corrupted')
        log(`account ${acc.alias || acc.id} has no valid credential file; marked as auth_required`)
      } else if (token && acc.authRequired && (acc.authError?.includes('credential file') || acc.authError?.includes('stored credential'))) {
        pool.clearAuthRequired?.(acc.id)
        log(`account ${acc.alias || acc.id} credential restored; cleared auth_required flag`)
      }
    }
  }
  if (kcProvisioned > 0) log('provisioned isolated keychains for ' + kcProvisioned + ' pool account(s)')
  // Windows shares ONE process-global credential slot across every agy
  // process. Establish the durable, identity-verified primary credential that
  // the slot is handed back to, and report pool corruption loudly instead of
  // silently reporting the wrong account's quota.
  if (process.platform === 'win32') {
    void resolvePrimaryCredential(pool, {
      baseDir: pool.dir,
      log,
      proxyUrl: getConfig().proxyUrl || detectSystemProxy(),
    })
      .then((cred) => {
        if (cred) log('primary credential verified' + (cred.email ? ' <' + cred.email + '>' : ''))
      })
      .catch(() => undefined)
    for (const dupe of findDuplicateCredentialIdentities(pool.getAccounts(), homedir())) {
      log(
        'WARNING: accounts share one credential identity (their login was overwritten — sign in again): ' +
          dupe.locations.join(', '),
      )
    }
  }
}
