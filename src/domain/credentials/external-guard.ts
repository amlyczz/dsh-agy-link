// Three-branch external standalone AGY sign-in detector (issue #145).
// Distinguishes:
//   1. `slot == primary`         -> already holds primary, reuse
//   2. `slot == lastInstalled`   -> leftover from our own plugin lease, safe to restore
//   3. `slot ∉ {primary, last}`  -> external manual sign-in (refuse overwrite when respectExternalSignIn is on)
import {
  isExternalCredentialGrant,
  sameCredentialGrant,
  writeLastInstalledFingerprintAt,
} from './docs.ts'
import { SlotUnavailableError } from './errors.ts'
import { installSlotBestEffort, installSlotOrThrow } from './lease.ts'
import type { CredentialPlatform } from './platform.ts'

/** True when `liveSlotRaw` holds a grant distinct from both `primaryRaw` and our last plugin-installed grant. */
export function isExternalSlotSignIn(
  liveSlotRaw: string | null | undefined,
  primaryRaw: string,
  baseDir: string,
): boolean {
  return isExternalCredentialGrant(liveSlotRaw, primaryRaw, baseDir)
}

/** Record our install fingerprint immediately after writing to the Windows slot. */
export function installSlotTracked(
  io: CredentialPlatform,
  raw: string,
  baseDir: string,
  log: (msg: string) => void,
  label: string,
): void {
  installSlotOrThrow(io, raw, log, label)
  writeLastInstalledFingerprintAt(raw, baseDir)
}

/** Best-effort restore that respects an external manual sign-in when `respectExternalSignIn` is enabled. */
export function restorePrimarySlotRespectingExternal(opts: {
  io: CredentialPlatform
  primaryRaw: string
  baseDir: string
  log: (msg: string) => void
  respectExternalSignIn: boolean
  contextLabel: string
}): boolean {
  const { io, primaryRaw, baseDir, log, respectExternalSignIn, contextLabel } = opts
  const live = io.readSlot()
  if (sameCredentialGrant(live, primaryRaw)) return true
  if (isExternalSlotSignIn(live, primaryRaw, baseDir)) {
    if (respectExternalSignIn) {
      log(`[agy-link] external standalone AGY sign-in detected (${contextLabel}) — preserving external credential in Windows slot`)
      return false
    }
    log(`[agy-link] notice: external standalone AGY sign-in detected (${contextLabel}); enable respectExternalSignIn to preserve it`)
  }
  installSlotBestEffort(io, primaryRaw, log, 'primary')
  writeLastInstalledFingerprintAt(primaryRaw, baseDir)
  return true
}

/** Throw SlotUnavailableError when `respectExternalSignIn` is enabled and an external sign-in occupies the slot. */
export function assertPrimarySlotSafeToReassert(opts: {
  liveSlotRaw: string | null | undefined
  primaryRaw: string
  baseDir: string
  log: (msg: string) => void
  respectExternalSignIn: boolean
}): void {
  const { liveSlotRaw, primaryRaw, baseDir, log, respectExternalSignIn } = opts
  if (!isExternalSlotSignIn(liveSlotRaw, primaryRaw, baseDir)) return
  if (respectExternalSignIn) {
    throw new SlotUnavailableError(
      'Windows Credential Manager holds a newer standalone AGY sign-in that differs from the saved primary credential. ' +
        'Re-authenticate primary via `/agy auth` or disable `respectExternalSignIn` to allow overwriting it.',
      'primary',
    )
  }
  log('[agy-link] notice: Windows credential slot holds an unrecognised external sign-in; re-asserting saved primary (set respectExternalSignIn: true to preserve external sign-ins)')
}
