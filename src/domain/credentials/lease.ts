// The caller-facing slot lease plus the slot-install guards.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g).
import { SlotUnavailableError } from './errors.ts'
import type { CredentialPlatform } from './platform.ts'

export interface SlotLease {
  release(): void
  /** Identity the slot was verified to hold while this lease was active. */
  identity?: string
}

/**
 * Install an identity into the machine-wide slot and PROVE the write landed.
 *
 * The four install sites here used to ignore `io.writeSlot()`'s boolean. On
 * Windows that write is a PowerShell cold start that compiles a C# P/Invoke
 * shim, so on a loaded machine it can exceed its own timeout and return false
 * WITHOUT touching the slot (reproduced 2026-10-23 while probing: a delete
 * followed by a write reported false and left the slot empty). The run then
 * spawned anyway and authenticated as whichever account was already installed —
 * silently spending the wrong account's quota, which is the exact corruption
 * class this module exists to prevent. One retry, then refuse.
 */
export function installSlotOrThrow(
  io: CredentialPlatform,
  raw: string,
  log: (msg: string) => void,
  label: string,
): void {
  if (io.writeSlot(raw)) return
  log('[agy-link] credential slot write failed for ' + label + ' — retrying once')
  if (io.writeSlot(raw)) return
  throw new SlotUnavailableError(
    'could not install the ' + label + ' credential into the Windows credential slot (the write was rejected) — ' +
    'refusing to run, because agy would authenticate as whichever account is already in the slot',
  )
}

/** Restore path: never fail a teardown, but say so loudly. */
export function installSlotBestEffort(
  io: CredentialPlatform,
  raw: string,
  log: (msg: string) => void,
  label: string,
): void {
  try {
    installSlotOrThrow(io, raw, log, label)
  } catch (err) {
    log(
      '[agy-link] WARNING: could not restore the ' + label + ' credential into the slot (' +
      (err instanceof Error ? err.message : String(err)) + ') — the next run re-installs it',
    )
  }
}