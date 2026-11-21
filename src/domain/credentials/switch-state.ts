// Fast-path counters and identity-switch bookkeeping for the credential slot.
//
// This is the module state slot.ts's concurrency rules are built on. It lives in
// its own file so the state machine stays under the module budget, and it must
// stay a leaf that imports nothing: every caller shares these exact counters.

import { EventEmitter } from 'node:events'

let primaryFastRuns = 0

/** Event bus to immediately wake queued same-identity runs when an identity is installed. */
export const slotEvents = new EventEmitter()
slotEvents.setMaxListeners(500)

export interface InstalledIdentity {
  /** Credential grant currently installed in the Windows slot. */
  fingerprint: string
  /** Runs relying on it: the handoff owner plus same-identity fast leases. */
  holders: number
  /** Persist a rotated token, restore the primary, release the mutex. */
  finish: () => void
}

/** The secondary identity currently installed in the slot, if any. */
let installedIdentity: InstalledIdentity | null = null

/**
 * Identities that waiting runs want installed, keyed by grant fingerprint
 * (`'primary'` for the system account). Same-identity peers may still join
 * while a key for their OWN grant is pending; joins are refused as soon as a
 * DIFFERENT identity waits, so a switcher can never be postponed forever.
 */
const pendingSwitchTargets = new Map<string, number>()

export function claimSwitchTarget(key: string): void {
  pendingSwitchTargets.set(key, (pendingSwitchTargets.get(key) ?? 0) + 1)
}

export function releaseSwitchTarget(key: string): void {
  const left = (pendingSwitchTargets.get(key) ?? 0) - 1
  if (left > 0) pendingSwitchTargets.set(key, left)
  else pendingSwitchTargets.delete(key)
}

/** Live same-identity run count — exported for diagnostics. */
export function fastPathRunCount(): number {
  return primaryFastRuns + (installedIdentity?.holders ?? 0)
}

/** Identities waiting to be installed; other keys block a join. */
export function pendingSwitchKeys(): string[] {
  return [...pendingSwitchTargets.keys()]
}

/** True while a run is waiting for (or performing) a slot identity switch. */
export function isSlotSwitchPending(): boolean {
  return pendingSwitchTargets.size > 0
}

/** Count a run that took the primary fast path. */
export function enterPrimaryFastRun(): void {
  primaryFastRuns += 1
}

/** Live primary fast-path run count (primary account only). */
export function primaryFastRunCount(): number {
  return primaryFastRuns
}

/** Leave the primary fast path (idempotent per run). */
export function leavePrimaryFastRun(): void {
  if (primaryFastRuns > 0) primaryFastRuns -= 1
}

/** The secondary identity currently installed in the slot, if any. */
export function currentInstalledIdentity(): InstalledIdentity | null {
  return installedIdentity
}

export function setInstalledIdentity(state: InstalledIdentity | null): void {
  installedIdentity = state
}

/** Register a lease on an installed identity and return its release function. */
export function holdInstalledIdentity(state: InstalledIdentity): void {
  state.holders += 1
}
