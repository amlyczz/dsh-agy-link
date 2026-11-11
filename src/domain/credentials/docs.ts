// Credential token documents, durable primary-credential store, and per-account
// token-file helpers.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g). The parsing,
// fingerprinting, atomic-write and on-disk layout are byte-identical; only the
// two default-argument entry points were renamed to `*At` so the host facade
// can keep the original `defaultPoolDir()` defaults without this module
// depending on the host.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ManagedAccount } from '../../common/pool-types.ts'

const PRIMARY_STORE_FILE = '.primary-credential.json'

// ---- token document helpers ----------------------------------------------

export interface CredentialDoc {
  accessToken?: string
  refreshToken?: string
  expiryMs?: number
}

/** Parse either agy's nested `{token:{…}}` shape or a flat `{access_token}` doc. */
export function parseCredentialDoc(raw: string | null | undefined): CredentialDoc | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
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
  return {
    accessToken: str('access_token', 'accessToken'),
    refreshToken: str('refresh_token', 'refreshToken'),
    expiryMs,
  }
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

export function readTokenFileRaw(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** Atomic-ish replace: write a sibling temp file then rename over the target. */
export function writeFileAtomic(file: string, data: string): boolean {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, data, { encoding: 'utf8' })
    renameSync(tmp, file)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // ignore
    }
    return false
  }
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