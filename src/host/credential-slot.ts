// Windows credential-slot handoff (dsh-agy-link) — host facade.
//
// WHY THIS MODULE EXISTS
// ---------------------
// On Windows every `agy.exe` process resolves its Google credential from ONE
// process-global store: Windows Credential Manager target `gemini:antigravity`.
// `agy` ignores HOME/USERPROFILE there, so an isolated per-account directory
// does NOT isolate credentials the way a per-account Keychain does on macOS.
// Multi-account support therefore requires handing the single slot back and
// forth around each run.
//
// The previous implementation corrupted real accounts. Three defects:
//
//   1. It snapshotted "whatever is currently in the slot" as the primary
//      backup. Any secondary run could overwrite the backup with a secondary's
//      credential, and the next restore then installed that secondary as the
//      system-wide login ("refreshing an account replaced my main account").
//
//   2. After a run it wrote the slot's content back into the account's token
//      file whenever it differed. While another account owned the slot, that
//      copied a FOREIGN credential into the account file. Observed end state:
//      all four accounts held the primary's refresh token and every quota row
//      reported the same identity.
//
//   3. Nothing serialized slot ownership. Interactive runs, background quota
//      polls and manual refreshes raced on the single slot.
//
// INVARIANTS ENFORCED HERE
// ------------------------
//   * The primary credential is resolved from a durable, identity-VERIFIED
//     store; it is never inferred from "whatever happens to be in the slot".
//   * Slot ownership is serialized by one process-wide mutex spanning the
//     whole run, so two accounts can never interleave.
//   * A run may only take the slot when the slot can be handed back afterwards.
//   * Writes into an account's own token file require that the slot still
//     carries THAT account's refresh token. Otherwise nothing is written.
//   * A secondary whose credential has been clobbered by another account's is
//     detected and refused, so it can never silently spend the primary's quota.
//
// Phase 5g moved the state machine, locking, lease/handoff logic and the token
// document helpers into src/domain/credentials/ (they receive platform
// operations through `CredentialPlatform`). This module keeps the public
// surface frozen and owns the platform-specific pieces: Windows Credential
// Manager IO, the OAuth identity probe, and the `defaultPoolDir()` defaults.
import type { ManagedAccount } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { defaultPoolDir } from './pool.ts'
import { readWindowsCredentialRaw, writeWindowsCredentialRaw } from './wincred.ts'
import { refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'
import {
  parseCredentialDoc,
  readPrimaryCredentialAt,
  writePrimaryCredentialAt,
  type PrimaryCredential,
} from '../domain/credentials/docs.ts'
import { resolvePrimaryCredentialAt } from '../domain/credentials/resolve.ts'
import { acquireCredentialSlotAt } from '../domain/credentials/slot.ts'
import type { SlotIo } from '../domain/credentials/platform.ts'
import type { SlotLease } from '../domain/credentials/lease.ts'

const SLOT_TARGET = 'gemini:antigravity'

const noop = (): void => {}

// ---- platform seam ---------------------------------------------------------

export function defaultSlotIo(): SlotIo {
  return {
    platform: process.platform,
    readSlot: () => readWindowsCredentialRaw(SLOT_TARGET),
    writeSlot: (raw) => writeWindowsCredentialRaw(raw, SLOT_TARGET),
    identify: identifyCredential,
  }
}

// ---- identity probing ------------------------------------------------------

/** Resolve the Google email a credential blob belongs to (refresh if needed). */
export async function identifyCredential(
  raw: string | null | undefined,
  proxyUrl?: string,
): Promise<string | undefined> {
  const doc = parseCredentialDoc(raw)
  if (!doc) return undefined
  const probe = async (accessToken: string): Promise<string | undefined> => {
    try {
      const res = await agyFetch(
        'https://www.googleapis.com/oauth2/v1/userinfo',
        { headers: { Authorization: 'Bearer ' + accessToken } },
        proxyUrl,
      )
      if (!res.ok) return undefined
      const body = (await res.json()) as { email?: string }
      return body.email
    } catch {
      return undefined
    }
  }
  if (doc.accessToken && (!doc.expiryMs || doc.expiryMs > Date.now() + 60_000)) {
    const email = await probe(doc.accessToken)
    if (email) return email
  }
  if (doc.refreshToken) {
    try {
      const refreshed = await refreshTokens(doc.refreshToken, proxyUrl)
      if (refreshed?.access_token) return await probe(refreshed.access_token)
    } catch {
      return undefined
    }
  }
  return undefined
}

// ---- public options --------------------------------------------------------

export interface ResolveOptions {
  baseDir?: string
  homeDir?: string
  proxyUrl?: string
  log?: (message: string) => void
  io?: Partial<SlotIo>
  /**
   * Cancels a queued wait for the slot (Stop propagation for the dispatch
   * phase). Only consulted by acquireCredentialSlot.
   */
  signal?: AbortSignal
  /**
   * Bounds the queued wait for the slot in ms; 0/undefined = wait
   * indefinitely. Only consulted by acquireCredentialSlot.
   */
  dispatchTimeoutMs?: number
  /**
   * Same-account fast path (default true): a run whose credential is already
   * in the slot starts immediately without the mutex, so multiple sessions on
   * one account run in parallel. Only identity switches serialize. false
   * restores full-run exclusivity.
   */
  parallel?: boolean
  /**
   * Re-derive the primary credential from live sources instead of trusting the
   * durable store. Used by the repair tool when the store itself may hold a
   * degraded (refresh-token-less) document.
   */
  force?: boolean
}

function resolveIo(options: ResolveOptions): SlotIo {
  const base = defaultSlotIo()
  const overrides = options.io
  if (!overrides) return base
  return {
    platform: overrides.platform ?? base.platform,
    readSlot: overrides.readSlot ?? base.readSlot,
    writeSlot: overrides.writeSlot ?? base.writeSlot,
    identify: overrides.identify ?? base.identify,
  }
}

function resolvedDirs(options: ResolveOptions): { baseDir: string; homeDir: string } {
  return {
    baseDir: options.baseDir ?? defaultPoolDir(),
    homeDir: options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '',
  }
}

// ---- durable primary credential (host defaults) --------------------------

export function readPrimaryCredential(baseDir = defaultPoolDir()): PrimaryCredential | null {
  return readPrimaryCredentialAt(baseDir)
}

export function writePrimaryCredential(cred: PrimaryCredential, baseDir = defaultPoolDir()): boolean {
  return writePrimaryCredentialAt(cred, baseDir)
}

/** See `resolvePrimaryCredentialAt` in src/domain/credentials/resolve.ts. */
export async function resolvePrimaryCredential(
  pool: AccountPoolManager | undefined,
  options: ResolveOptions = {},
): Promise<PrimaryCredential | null> {
  const io = resolveIo(options)
  const { baseDir, homeDir } = resolvedDirs(options)
  return resolvePrimaryCredentialAt(pool, {
    baseDir,
    homeDir,
    platform: io,
    log: options.log ?? noop,
    ...(options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
    ...(options.force === undefined ? {} : { force: options.force }),
  })
}

// ---- slot lease ------------------------------------------------------------

/**
 * Take ownership of the credential slot for a run. See
 * `acquireCredentialSlotAt` in src/domain/credentials/slot.ts for the state
 * machine; this delegate only resolves platform IO and the directory defaults.
 *
 * @throws SlotUnavailableError when the slot cannot be handed over safely.
 * @throws AbortedWaitError when the signal aborted while queued.
 * @throws WaitTimeoutError when the bounded wait elapsed.
 */
export async function acquireCredentialSlot(
  account: ManagedAccount | undefined,
  pool: AccountPoolManager | undefined,
  options: ResolveOptions = {},
): Promise<SlotLease | undefined> {
  // Resolve platform IO first and bail exactly where the original did, before
  // the directory defaults are evaluated.
  const io = resolveIo(options)
  if (io.platform !== 'win32' || !account) return undefined
  const { baseDir, homeDir } = resolvedDirs(options)
  return acquireCredentialSlotAt(account, pool, {
    baseDir,
    homeDir,
    platform: io,
    log: options.log ?? noop,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.dispatchTimeoutMs === undefined ? {} : { dispatchTimeoutMs: options.dispatchTimeoutMs }),
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
    ...(options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl }),
    ...(options.force === undefined ? {} : { force: options.force }),
  })
}

// ---- frozen public surface (moved implementations) ------------------------

export {
  AsyncMutex,
  credentialSlotMutex,
} from '../domain/credentials/mutex.ts'
export {
  AbortedWaitError,
  SlotUnavailableError,
  WaitTimeoutError,
} from '../domain/credentials/errors.ts'
export {
  acquireCrossProcessSlotLock,
  isProcessAlive,
  SLOT_LOCK_NAME,
  SLOT_LOCK_STALE_MS,
  slotLockFilePath,
  type SlotLockData,
} from '../domain/credentials/lock.ts'
export {
  accountTokenFilePath,
  credentialFingerprint,
  findDuplicateCredentialIdentities,
  parseCredentialDoc,
  primaryStorePath,
  sameCredentialGrant,
  type CredentialDoc,
  type DuplicateIdentityReport,
  type PrimaryCredential,
} from '../domain/credentials/docs.ts'
export { type CredentialPlatform, type SlotIo } from '../domain/credentials/platform.ts'
export { type SlotLease } from '../domain/credentials/lease.ts'
export {
  armSlotHandoff,
  SLOT_HANDOFF_TIMEOUT_MS,
  type SlotHandoff,
} from '../domain/credentials/handoff.ts'
export { fastPathRunCount, isSlotSwitchPending } from '../domain/credentials/slot.ts'