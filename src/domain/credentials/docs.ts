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
import { readAccountCredential } from './backup.ts'

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

/** Atomic replace: write a sibling temp file then rename over the target. */
export function writeFileAtomic(file: string, data: string): boolean {
  return tryWriteFileAtomic(file, data)
}

export function accountTokenFilePath(account: ManagedAccount, homeDir: string): string {
  const home = account.dir ? account.dir : homeDir
  return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
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