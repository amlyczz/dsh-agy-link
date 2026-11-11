// Primary-credential resolution: prove which blob belongs to the primary
// account before the slot is ever swapped.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g). The host facade
// supplies the already-resolved base dir, home dir and platform operations, so
// this module has no host dependency of its own.
import type { ManagedAccount } from '../../common/pool-types.ts'
import {
  credentialFingerprint,
  parseCredentialDoc,
  readPrimaryCredentialAt,
  readTokenFileRaw,
  writePrimaryCredentialAt,
  accountTokenFilePath,
  type PrimaryCredential,
} from './docs.ts'
import type { CredentialPlatform } from './platform.ts'

/** The slice of AccountPoolManager this module needs. */
export interface AccountPoolLike {
  getAccounts(): readonly ManagedAccount[]
}

/** Resolved inputs for {@link resolvePrimaryCredentialAt}. */
export interface ResolvePrimaryInput {
  baseDir: string
  homeDir: string
  platform: CredentialPlatform
  proxyUrl?: string
  log?: (message: string) => void
  /**
   * Re-derive the primary credential from live sources instead of trusting the
   * durable store. Used by the repair tool when the store itself may hold a
   * degraded (refresh-token-less) document.
   */
  force?: boolean
}

/**
 * Produce a primary credential we can PROVE belongs to the primary account.
 *
 * Order of trust:
 *   1. the durable store (written only from verified-primary sources)
 *   2. the primary's own on-disk token file
 *   3. the live credential slot
 * Candidates 2 and 3 are adopted only after a successful Google identity probe
 * that matches the pool's recorded primary email.
 *
 * Returns null when nothing can be proven — callers must then refuse to swap
 * the slot rather than guess.
 */
export async function resolvePrimaryCredentialAt(
  pool: AccountPoolLike | undefined,
  input: ResolvePrimaryInput,
): Promise<PrimaryCredential | null> {
  const { baseDir, homeDir, proxyUrl, force, platform } = input
  const log = input.log ?? ((): void => {})

  const stored = readPrimaryCredentialAt(baseDir)
  if (stored && force !== true) return stored

  const accounts = pool?.getAccounts() ?? []
  const primary =
    accounts.find((a) => a.systemHome) ?? accounts.find((a) => a.id === 'acc_primary') ?? accounts[0]
  const expectedEmail = primary?.email

  const candidates: Array<{ where: string; raw: string | null }> = []
  if (primary) {
    candidates.push({
      where: 'primary token file',
      raw: readTokenFileRaw(accountTokenFilePath(primary, homeDir)),
    })
  }
  if (platform.platform === 'win32') candidates.push({ where: 'credential slot', raw: platform.readSlot() })

  for (const candidate of candidates) {
    if (!candidate.raw) continue
    // A credential without a refresh token cannot be identified across access
    // token rotations, and would degrade the durable store back to an
    // unidentifiable document. Never adopt one.
    if (!parseCredentialDoc(candidate.raw)?.refreshToken) {
      log(`[agy-link] primary credential candidate "${candidate.where}" has no refresh token — skipped`)
      continue
    }
    const email = await platform.identify(candidate.raw, proxyUrl)
    if (!email) continue
    if (expectedEmail && email !== expectedEmail) {
      log(
        `[agy-link] primary credential candidate "${candidate.where}" belongs to ${email}, ` +
          `expected ${expectedEmail} — skipped`,
      )
      continue
    }
    const cred: PrimaryCredential = { raw: candidate.raw, email, savedAt: Date.now() }
    writePrimaryCredentialAt(cred, baseDir)
    log(`[agy-link] adopted primary credential from ${candidate.where} <${email}>`)
    return cred
  }

  log('[agy-link] could not verify a primary credential; slot handoff disabled to protect the system login')
  return null
}