// Machine-wide Windows credential-slot guards (gates 1 and 3).
//
// The Windows slot (`gemini:antigravity`) is ONE store shared by every agy
// process on the machine, and agy reads it once at startup. Two failure modes
// are guarded here:
//
//   1. A slot whose document names a DIFFERENT account than the one requested.
//      Matching refresh grants are NOT proof of identity — signing the same
//      account in again mints a new grant — so the email agy itself wrote next
//      to the token is checked as well. Trusting a foreign slot spends that
//      account's quota with no error anywhere.
//   2. A slot left holding a secondary account after its last run (drain ended,
//      process crashed, host restarted). The next interactive turn on the
//      primary would then authenticate as the secondary.
//
// Split out of slot.ts to keep that state machine under the module budget; the
// counter is module state here so every caller shares one instance.

import { parseCredentialDoc, sameCredentialGrant, type PrimaryCredential } from './docs.ts'
import { installSlotTracked, isExternalSlotSignIn } from './external-guard.ts'
import { installSlotOrThrow } from './lease.ts'
import type { CredentialPlatform } from './platform.ts'
import { resolvePrimaryCredentialAt, type AccountPoolLike } from './resolve.ts'
import { fastPathRunCount, isSlotSwitchPending } from './switch-state.ts'

// ---- resolved inputs -------------------------------------------------------

/**
 * Everything a slot guard needs, already resolved by the host facade: platform
 * operations, the two base directories and the public options.
 */
export interface AcquireInput {
  baseDir: string
  homeDir: string
  platform: CredentialPlatform
  log: (msg: string) => void
  signal?: AbortSignal
  dispatchTimeoutMs?: number
  parallel?: boolean
  proxyUrl?: string
  force?: boolean
  /** Refuse to overwrite an unrecognised external standalone AGY sign-in in the Windows slot (#145). */
  respectExternalSignIn?: boolean
}

// ---- identity evidence -----------------------------------------------------

/** How many times a foreign identity was found sitting in the slot. */
let slotOverwriteDetected = 0

/** When the primary credential was last re-asserted into the slot. */
let lastSlotRecoveryAt: number | null = null

/** Diagnostics for /plugins/agy-link/status. */
export function slotGuardStats(): { overwriteDetected: number; lastRecoveryAt: number | null } {
  return { overwriteDetected: slotOverwriteDetected, lastRecoveryAt: lastSlotRecoveryAt }
}

/** Record that the slot was found holding a foreign identity. */
export function noteSlotOverwrite(): void {
  slotOverwriteDetected += 1
}

/** Read the account identity agy itself recorded in the slot document. */
export function slotIdentity(io: CredentialPlatform): string | null {
  try {
    return parseCredentialDoc(io.readSlot())?.email ?? null
  } catch {
    return null
  }
}

/**
 * True when the slot may be used for `expected`: either it names that account,
 * or it names nobody (a document without `id_token_email` cannot be judged
 * offline, and refusing it would break every older credential file).
 * A provably different identity is counted and refused.
 */
export function slotEmailMatches(io: CredentialPlatform, expected: string | undefined): boolean {
  const actual = slotIdentity(io)
  const want = (expected ?? '').trim().toLowerCase()
  if (actual === null || want === '') return true
  if (actual.toLowerCase() === want) return true
  noteSlotOverwrite()
  return false
}

// ---- gate 3: put the primary back ------------------------------------------

export interface PrimaryRecoveryResult {
  /** True when this call put the primary credential back into the slot. */
  restored: boolean
  reason: 'restored' | 'already-primary' | 'busy' | 'unverifiable' | 'failed'
}

/**
 * Install one account's credential blob into the slot OUTSIDE a lease.
 *
 * Used by gate 2: when a freshly spawned agy reports an identity that does not
 * match the account we dispatched, the slot itself is wrong (another process
 * refreshed it at its own ~1h mark), so it must be rewritten before the retry.
 * Returns false instead of throwing — the caller already has a failure to report.
 */
export function reinstallAccountCredentialAt(
  accountRaw: string,
  input: AcquireInput,
  label = 'primary',
): boolean {
  try {
    installSlotOrThrow(input.platform, accountRaw, input.log, label)
    return true
  } catch {
    return false
  }
}

/**
 * Put the PRIMARY credential back into the Windows slot once nothing else is
 * using it. Called after a secondary account's draining process exits and
 * periodically from the idle sweep, so an account switch can never leave the
 * machine holding someone else's login.
 *
 * Refuses while any same-identity run or queued switch is live: overwriting the
 * slot under a running agy would feed it the wrong credential on its next
 * in-run token refresh.
 */
/** True when the raw credential blob itself names `email` (or names nobody). */
function credentialDocEmailMatches(raw: string, email: string): boolean {
  const doc = parseCredentialDoc(raw)
  const actual = (doc?.email ?? '').trim().toLowerCase()
  return actual === '' || actual === email
}

export async function recoverPrimarySlotAt(
  pool: AccountPoolLike | undefined,
  input: AcquireInput,
): Promise<PrimaryRecoveryResult> {
  const io = input.platform
  if (io.platform !== 'win32') return { restored: false, reason: 'already-primary' }
  if (fastPathRunCount() > 0 || isSlotSwitchPending()) return { restored: false, reason: 'busy' }
  let primary: PrimaryCredential | null = null
  try {
    primary = await resolvePrimaryCredentialAt(pool, {
      baseDir: input.baseDir,
      homeDir: input.homeDir,
      platform: io,
      log: input.log,
      ...(input.proxyUrl === undefined ? {} : { proxyUrl: input.proxyUrl }),
      ...(input.force === undefined ? {} : { force: input.force }),
    })
  } catch {
    primary = null
  }
  if (primary === null) return { restored: false, reason: 'unverifiable' }
  // The identity the stored primary claims and the identity its blob carries
  // must agree. They disagree when the file was overwritten by another account's
  // refresh; installing it would put the wrong login in the slot and every later
  // run would fail authentication with no clue why.
  const want = (primary.email ?? '').trim().toLowerCase()
  if (want !== '' && !credentialDocEmailMatches(primary.raw, want)) {
    input.log(`[agy-link] primary slot recovery refused: stored primary claims ${primary.email} but its credential names another account`)
    return { restored: false, reason: 'unverifiable' }
  }
  if (sameCredentialGrant(io.readSlot(), primary.raw)) return { restored: false, reason: 'already-primary' }
  if (input.respectExternalSignIn && isExternalSlotSignIn(io.readSlot(), primary.raw, input.baseDir)) {
    input.log('[agy-link] primary slot recovery skipped: preserving external standalone AGY sign-in in Windows slot')
    return { restored: false, reason: 'already-primary' }
  }
  try {
    installSlotTracked(io, primary.raw, input.baseDir, input.log, 'primary')
  } catch {
    return { restored: false, reason: 'failed' }
  }
  // Write-then-verify, the same discipline gate 1 uses: a slot that silently
  // kept the old value would look restored while still serving the other login.
  const landed = slotIdentity(io)
  if (want !== '' && landed !== null && landed.toLowerCase() !== want) {
    input.log(`[agy-link] primary slot recovery failed: slot reads back as ${landed}`)
    return { restored: false, reason: 'failed' }
  }
  lastSlotRecoveryAt = Date.now()
  input.log('[agy-link] primary credential re-asserted into the Windows credential slot after the last run')
  return { restored: true, reason: 'restored' }
}
