// Credential token documents, durable primary-credential store, and per-account
// token-file helpers.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g). The parsing,
// fingerprinting, atomic-write and on-disk layout are byte-identical; only the
// two default-argument entry points were renamed to `*At` so the host facade
// can keep the original `defaultPoolDir()` defaults without this module
// depending on the host.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryWriteFileAtomic } from '../../common/atomic-write.ts'
import { unwrapGoKeyringPayload } from '../../common/go-keyring.ts'
import type { ManagedAccount } from '../../common/pool-types.ts'
import { readAccountCredential, saveCredentialBackup } from './backup.ts'

const PRIMARY_STORE_FILE = '.primary-credential.json'
const LAST_INSTALLED_FILE = '.last-installed-fingerprint.json'

// ---- token document helpers ----------------------------------------------

export interface CredentialDoc {
  accessToken?: string
  refreshToken?: string
  expiryMs?: number
  /**
   * Account identity carried by agy's own slot document (`id_token_email`).
   * The Windows credential slot is machine-wide, so this is the only reliable
   * way to tell WHOSE token currently sits in it without a network round-trip.
   */
  email?: string
}

/** Parse either agy's nested `{token:{…}}` shape or a flat `{access_token}` doc. */
export function parseCredentialDoc(raw: string | null | undefined): CredentialDoc | null {
  if (!raw) return null
  let parsed: unknown
  try {
    // Issue #203: the Windows desktop app writes the Credential Manager entry
    // with a `go-keyring-base64:` prefix. Parsing raw text rejected it, so the
    // external-slot guard never saw the desktop sign-in it was meant to protect.
    parsed = JSON.parse(unwrapGoKeyringPayload(raw))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const outer = parsed as Record<string, unknown>
  const inner =
    typeof outer.token === 'object' && outer.token !== null
      ? (outer.token as Record<string, unknown>)
      : outer
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = inner[k]
      if (typeof v === 'string' && v) return v
    }
    return undefined
  }
  const rawExpiry = inner.expiry ?? inner.expiryMs
  let expiryMs: number | undefined
  if (typeof rawExpiry === 'number' && Number.isFinite(rawExpiry)) {
    expiryMs = rawExpiry < 1e11 ? rawExpiry * 1000 : rawExpiry
  } else if (typeof rawExpiry === 'string') {
    const parsedMs = Date.parse(rawExpiry)
    if (!Number.isNaN(parsedMs)) expiryMs = parsedMs
  }
  // agy writes the identity it loaded the token for next to (not inside) the
  // token object, so the outer document is consulted as well.
  const emailOf = (): string | undefined => {
    for (const k of ['id_token_email', 'idTokenEmail', 'email']) {
      for (const src of [inner, outer]) {
        const v = src[k]
        if (typeof v === 'string' && v.trim() !== '') return v.trim()
      }
    }
    return undefined
  }
  return {
    accessToken: str('access_token', 'accessToken'),
    refreshToken: str('refresh_token', 'refreshToken'),
    expiryMs,
    email: emailOf(),
  }
}

/**
 * Extract a refresh token from raw token string, full/partial JSON document,
 * or token document.
 */
export function extractRefreshToken(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null
  const trimmedInput = input.trim()
  if (!trimmedInput) return null
  // A keyring-wrapped document is JSON once unwrapped; leaving the envelope on
  // would make the regex miss and the base64 blob be returned as a "token".
  const trimmed = unwrapGoKeyringPayload(trimmedInput).trim()
  if (trimmed === '') return null

  // 1. Try parsing structured JSON
  if (trimmed.startsWith('{') || trimmed.endsWith('}')) {
    try {
      const parsed = parseCredentialDoc(trimmed)
      if (parsed?.refreshToken && parsed.refreshToken.trim()) {
        return parsed.refreshToken.trim()
      }
    } catch {
      // ignore
    }
  }

  // 2. Try JSON pattern match if parse failed (e.g. partial or escaped JSON)
  const match = trimmed.match(/"refresh_token"\s*:\s*"([^"]+)"/i) ?? trimmed.match(/"refreshToken"\s*:\s*"([^"]+)"/i)
  if (match && match[1]?.trim()) {
    return match[1].trim()
  }

  // 3. Raw token string (strip enclosing quotes if any)
  const unquoted = trimmed.replace(/^["']|["']$/g, '').trim()
  return unquoted.length > 0 ? unquoted : null
}

/**
 * Identity anchor for a credential blob. A Google OAuth refresh token is
 * unique per account grant and stays the same across access-token refreshes,
 * so it is the right thing to compare. Falls back to the access token when a
 * refresh token is unavailable.
 */
export function credentialFingerprint(raw: string | null | undefined): string | null {
  const doc = parseCredentialDoc(raw)
  if (!doc) return null
  if (doc.refreshToken) return 'r:' + doc.refreshToken
  if (doc.accessToken) return 'a:' + doc.accessToken
  return null
}

/**
 * True only when both blobs provably belong to the SAME OAuth grant.
 *
 * A refresh token is required on both sides. Falling back to the access token
 * would be unsound here: it rotates on every refresh, so two snapshots of one
 * account would compare unequal and two accounts could compare equal. This
 * predicate gates every destructive decision (refusing to run, writing a token
 * back into an account file, re-asserting the primary), so "cannot prove it"
 * must mean "not the same".
 */
export function sameCredentialGrant(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const docA = parseCredentialDoc(a)
  const docB = parseCredentialDoc(b)
  if (!docA?.refreshToken || !docB?.refreshToken) return false
  return docA.refreshToken === docB.refreshToken
}

/**
 * True when both blobs belong to the same OAuth grant AND carry identical
 * live access-token state (`accessToken` + `expiryMs`).
 */
export function sameCredentialTokenState(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!sameCredentialGrant(a, b)) return false
  const docA = parseCredentialDoc(a)
  const docB = parseCredentialDoc(b)
  if (!docA?.accessToken || !docB?.accessToken) return false
  if (docA.accessToken !== docB.accessToken) return false
  return docA.expiryMs === docB.expiryMs
}

/**
 * True when `liveRaw` already holds `targetRaw`'s exact token state OR a
 * strictly newer expiry for the same OAuth grant, so syncing does not
 * overwrite a fresher slot with an older mirror (issue #199).
 */
export function isSlotAtLeastAsFresh(
  liveRaw: string | null | undefined,
  targetRaw: string | null | undefined,
): boolean {
  if (sameCredentialTokenState(liveRaw, targetRaw)) return true
  if (!sameCredentialGrant(liveRaw, targetRaw)) return false
  const liveDoc = parseCredentialDoc(liveRaw)
  const targetDoc = parseCredentialDoc(targetRaw)
  if (!liveDoc?.accessToken || typeof liveDoc.expiryMs !== 'number') return false
  if (typeof targetDoc?.expiryMs !== 'number') return false
  return liveDoc.expiryMs > targetDoc.expiryMs
}

export function readTokenFileRaw(file: string): string | null {
  const raw = readAccountCredential(file)
  return raw && raw.trim() ? raw : null
}

/**
 * True when `liveRaw` holds a provably distinct OAuth grant: not the saved
 * primary's grant, and not the grant this plugin last installed (tracked by
 * the irreversible fingerprint in `baseDir`). "Cannot prove it" (no refresh
 * token) is NOT external — the same rule the Windows slot guard follows.
 * Shared by the slot guard (`external-guard.ts`) and the file-based/WSL disk
 * mirror (`syncPrimaryDiskTokenFile`, issue #232) so `respectExternalSignIn`
 * means the same thing for both stores.
 */
export function isExternalCredentialGrant(
  liveRaw: string | null | undefined,
  primaryRaw: string | null | undefined,
  baseDir?: string,
): boolean {
  if (!liveRaw) return false
  if (sameCredentialGrant(liveRaw, primaryRaw)) return false
  const liveHash = hashCredentialFingerprint(liveRaw)
  if (!liveHash) return false
  if (baseDir) {
    const lastInstalled = readLastInstalledFingerprintAt(baseDir)
    if (lastInstalled !== null && liveHash === lastInstalled) return false
  }
  return true
}

/**
 * True when the on-disk token file holds a complete sign-in that belongs to
 * neither the saved primary nor a grant this plugin installed: an external,
 * file-based standalone AGY sign-in (Windows + WSL UNC `cwd` reads this file
 * instead of Credential Manager). A document without a refresh token cannot
 * authenticate anyone, so it never counts as an external sign-in.
 */
export function isExternalDiskSignIn(
  existingRaw: string | null | undefined,
  primaryRaw: string | null | undefined,
  baseDir?: string,
): boolean {
  if (!isExternalCredentialGrant(existingRaw, primaryRaw, baseDir)) return false
  return Boolean(parseCredentialDoc(existingRaw)?.refreshToken)
}

/** Atomic replace: write a sibling temp file then rename over the target. */
export function writeFileAtomic(file: string, data: string): boolean {
  return tryWriteFileAtomic(file, data)
}

export function accountTokenFilePath(account: ManagedAccount, homeDir: string): string {
  const home = account.dir ? account.dir : homeDir
  return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
}

/** True when `p` is a Windows WSL UNC path (`\\wsl.localhost\...`, `\\wsl$\...`, or `//wsl...`). */
export function isWslUncPath(p: string | undefined): boolean {
  return typeof p === 'string' && /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)(?:[\\/]|$)/i.test(p.trim())
}

/**
 * Unwrap any `go-keyring-base64:` envelope and validate that the credential is
 * valid JSON carrying a non-empty refresh token suitable for file-based agy auth.
 */
export function normalizeCredentialJsonForDisk(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  const unwrapped = unwrapGoKeyringPayload(raw).trim()
  if (!unwrapped) return null
  try {
    JSON.parse(unwrapped)
  } catch {
    return null
  }
  const doc = parseCredentialDoc(unwrapped)
  if (!doc?.refreshToken) return null
  return unwrapped
}

/**
 * Mirror an authoritative primary credential as plain JSON into
 * `<homeDir>/.gemini/antigravity-cli/antigravity-oauth-token` so `agy` runs
 * with WSL UNC `cwd` (`Using file-based token storage because WSL environment detected`)
 * authenticate with the live primary account instead of a stale disk leftover.
 *
 * Issue #232: the mirror honours `respectExternalSignIn` the same way the
 * Windows slot does. An existing file that provably belongs to another grant
 * (a complete, external file-based sign-in) is preserved when the setting is
 * on; the plugin's own grant — same refresh token, or the one this plugin
 * last installed — is always replaceable, so the revoked-token self-heal that
 * motivated this mirror keeps working for the primary account itself.
 */
export function syncPrimaryDiskTokenFile(
  raw: string | null | undefined,
  homeDir: string,
  log?: (msg: string) => void,
  opts: { baseDir?: string; respectExternalSignIn?: boolean } = {},
): boolean {
  if (!homeDir || homeDir.trim() === '') return false
  const plain = normalizeCredentialJsonForDisk(raw)
  if (!plain) return false
  const dir = join(homeDir, '.gemini', 'antigravity-cli')
  const file = join(dir, 'antigravity-oauth-token')
  if (existsSync(file)) {
    try {
      const existing = readFileSync(file, 'utf8')
      if (existing.trim() !== '') {
        if (isExternalDiskSignIn(existing, plain, opts.baseDir)) {
          if (opts.respectExternalSignIn === true) {
            log?.('[agy-link] external standalone AGY sign-in detected in the file-based token — preserving it (respectExternalSignIn)')
            return false
          }
          log?.('[agy-link] notice: file-based token holds an external standalone AGY sign-in; enable respectExternalSignIn to preserve it')
        } else if (!existing.trim().startsWith('go-keyring-base64:') && isSlotAtLeastAsFresh(existing, plain)) {
          return true
        }
      }
    } catch {
      // treat unreadable existing file as stale and overwrite below
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
  if (!writeFileAtomic(file, plain)) return false
  saveCredentialBackup(file, plain)
  log?.('[agy-link] synced primary credential to disk token file for file-based/WSL auth')
  return true
}

/**
 * Ensure an isolated account's on-disk token file is intact (recovered from `.bak`
 * if missing/corrupt) and stored as plain JSON (never `go-keyring-base64:` encoded).
 */
export function ensureIsolatedDiskTokenClean(accountFile: string, log?: (msg: string) => void): boolean {
  const raw = readAccountCredential(accountFile, log)
  if (!raw) return false
  if (raw.trim().startsWith('go-keyring-base64:')) {
    const plain = normalizeCredentialJsonForDisk(raw)
    if (plain && writeFileAtomic(accountFile, plain)) {
      saveCredentialBackup(accountFile, plain)
      log?.('[agy-link] unwrapped keyring-encoded isolated account token file to plain JSON')
      return true
    }
  }
  return Boolean(parseCredentialDoc(raw)?.refreshToken)
}

// ---- durable primary credential ------------------------------------------

export interface PrimaryCredential {
  raw: string
  email?: string
  savedAt: number
}

export function primaryStorePath(baseDir: string): string {
  return join(baseDir, PRIMARY_STORE_FILE)
}

/** Same as the host's `readPrimaryCredential`, with the base dir mandatory. */
export function readPrimaryCredentialAt(baseDir: string): PrimaryCredential | null {
  const file = primaryStorePath(baseDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PrimaryCredential>
    if (typeof parsed.raw === 'string' && parsed.raw.trim() && credentialFingerprint(parsed.raw)) {
      return {
        raw: parsed.raw,
        email: typeof parsed.email === 'string' ? parsed.email : undefined,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      }
    }
  } catch {
    // corrupted store — treat as absent rather than guessing
  }
  return null
}

/** Same as the host's `writePrimaryCredential`, with the base dir mandatory. */
export function writePrimaryCredentialAt(cred: PrimaryCredential, baseDir: string): boolean {
  try {
    mkdirSync(baseDir, { recursive: true })
  } catch {
    // ignore
  }
  return writeFileAtomic(primaryStorePath(baseDir), JSON.stringify(cred, null, 2))
}

/** Irreversible SHA-256 hash of a credential grant fingerprint (safe to persist, issue #145). */
export function hashCredentialFingerprint(raw: string | null | undefined): string | null {
  const fp = credentialFingerprint(raw)
  if (!fp) return null
  return createHash('sha256').update(fp).digest('hex')
}

export function lastInstalledFingerprintPath(baseDir: string): string {
  return join(baseDir, LAST_INSTALLED_FILE)
}

/** Read the irreversible fingerprint hash last written to the Windows slot by this plugin (#145). */
export function readLastInstalledFingerprintAt(baseDir: string): string | null {
  const file = lastInstalledFingerprintPath(baseDir)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hash?: unknown }
    return typeof parsed.hash === 'string' && parsed.hash.length === 64 ? parsed.hash : null
  } catch {
    return null
  }
}

/** Persist the irreversible fingerprint hash of a credential blob we just wrote to the slot (#145). */
export function writeLastInstalledFingerprintAt(raw: string | null | undefined, baseDir: string): boolean {
  const hash = hashCredentialFingerprint(raw)
  if (!hash) return false
  try {
    mkdirSync(baseDir, { recursive: true })
  } catch {
    // ignore
  }
  return writeFileAtomic(lastInstalledFingerprintPath(baseDir), JSON.stringify({ hash, updatedAt: Date.now() }, null, 2))
}

// ---- corruption detection --------------------------------------------------

export interface DuplicateIdentityReport {
  fingerprint: string
  locations: string[]
}

/**
 * Detect several accounts sharing one credential identity — the signature of
 * the historical slot-corruption bug. Read-only.
 */
export function findDuplicateCredentialIdentities(
  accounts: readonly ManagedAccount[],
  homeDir: string,
): DuplicateIdentityReport[] {
  const byFingerprint = new Map<string, string[]>()
  for (const account of accounts) {
    const raw = readTokenFileRaw(accountTokenFilePath(account, homeDir))
    const fp = credentialFingerprint(raw)
    if (!fp) continue
    const list = byFingerprint.get(fp) ?? []
    list.push(account.alias || account.id)
    byFingerprint.set(fp, list)
  }
  const reports: DuplicateIdentityReport[] = []
  for (const [fingerprint, locations] of byFingerprint) {
    if (locations.length > 1) reports.push({ fingerprint, locations })
  }
  return reports
}