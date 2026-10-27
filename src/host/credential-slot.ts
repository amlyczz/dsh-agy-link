// Windows credential-slot handoff (dsh-agy-link).
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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { defaultPoolDir } from './pool.ts'
import { readWindowsCredentialRaw, writeWindowsCredentialRaw } from './wincred.ts'
import { refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'

const SLOT_TARGET = 'gemini:antigravity'
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

function readTokenFileRaw(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    return raw.trim() ? raw : null
  } catch {
    return null
  }
}

/** Atomic-ish replace: write a sibling temp file then rename over the target. */
function writeFileAtomic(file: string, data: string): boolean {
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

// ---- process-wide serialization ------------------------------------------

/**
 * FIFO async mutex. One instance guards the single Windows credential slot;
 * holding it across an entire agy run is what makes the handoff safe.
 *
 * The original implementation chained promises (`tail.then(gate)`), which is
 * FIFO but structurally unable to remove a waiter: a turn abandoned or aborted
 * while queued stayed in the chain forever, and if its gate was never resolved
 * every later waiter wedged with it (the 2026-10-16 cardboard-empire zombie
 * turn: queued 30+ minutes past the slot's release, immune to Stop, because
 * nothing observed the wait). This rewrite keeps an explicit queue so a
 * cancelled or timed-out waiter is REMOVED and the next waiter is woken in its
 * place, and the wait is guarded by a short poll that re-checks liveness — a
 * lost wakeup can no longer park a turn silently.
 */
export class AsyncMutex {
  private holders = 0
  private readonly queue: Array<() => void> = []

  /** Number of holders plus waiters; 0 means the mutex is free. */
  get pending(): number {
    return this.holders + this.queue.length
  }

  /** Waiters currently queued behind the holder(s). */
  get waiting(): number {
    return this.queue.length
  }

  /**
   * Acquire the mutex.
   *
   * @param opts.signal  cancel the wait (the waiter is removed and the next
   *   one is woken); rejects with `AbortedWaitError`
   * @param opts.timeoutMs  bound the wait; rejects with `WaitTimeoutError`
   * @param opts.pollMs  liveness self-check interval while queued (0 = off).
   *   The poll re-checks `shouldProceed` — a hook that lets the caller verify
   *   the wait is still legitimate (e.g. the queue actually advanced). If it
   *   returns true while the mutex appears free, the waiter takes the mutex
   *   directly, healing a lost wakeup within one poll interval instead of
   *   hanging forever.
   */
  async acquire(opts: {
    signal?: AbortSignal
    timeoutMs?: number
    pollMs?: number
    /** Liveness hook consulted by the poll: true = the wait is still wanted. */
    shouldProceed?: () => boolean
  } = {}): Promise<() => void> {
    const signal = opts.signal
    if (signal?.aborted) throw new AbortedWaitError('aborted before mutex acquisition')
    if (this.holders < 1 && this.queue.length === 0) {
      this.holders = 1
      return () => this.releaseOne()
    }

    const pollMs = opts.pollMs ?? 0
    const timeoutMs = opts.timeoutMs
    let onAbort: (() => void) | null = null
    let timer: NodeJS.Timeout | null = null
    let pollTimer: NodeJS.Timeout | null = null

    const result = new Promise<() => void>((resolve, reject) => {
      let settled = false
      let entry: (() => void) | null = null
      let takenDirectly = false

      const cleanup = (): void => {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort)
          onAbort = null
        }
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      const grant = (): void => {
        if (settled) return
        settled = true
        cleanup()
        entry = null
        resolve(() => this.releaseOne())
      }

      const fail = (err: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (entry !== null) {
          // Remove this waiter from the queue. If it was already shifted out
          // by releaseOne(), ownership was handed off to it: pass ownership on.
          const idx = this.queue.indexOf(entry)
          if (idx >= 0) {
            this.queue.splice(idx, 1)
          } else {
            this.releaseOne()
          }
          entry = null
        } else if (takenDirectly) {
          // The poll granted the mutex between a cancel arriving and this
          // failure landing. Honor the grant: the caller released nothing yet.
          this.releaseOne()
        }
        reject(err)
      }

      entry = (): void => grant()
      this.queue.push(entry)

      onAbort = (): void => {
        fail(new AbortedWaitError('aborted while waiting for the mutex'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => fail(new WaitTimeoutError('timed out waiting for the mutex')), timeoutMs)
        timer.unref?.()
      }

      // Lost-wakeup self-heal: while queued, periodically re-check whether the
      // mutex has actually become free. If the wake call was lost (an earlier
      // defect parked a turn 30+ minutes past a released slot), the poll takes
      // the mutex directly instead of waiting forever.
      if (pollMs > 0 && opts.shouldProceed !== undefined) {
        pollTimer = setInterval(() => {
          if (settled) return
          if (this.holders < 1 && this.queue[0] === entry && opts.shouldProceed?.()) {
            const idx = this.queue.indexOf(entry)
            if (idx >= 0) this.queue.splice(idx, 1)
            entry = null
            takenDirectly = true
            this.holders = 1
            grant()
          }
        }, pollMs)
        pollTimer.unref?.()
      }
    })

    return result
  }

  private releaseOne(): void {
    const next = this.queue.shift()
    if (next) {
      // Direct handoff: holders remains 1 so concurrent callers cannot barge.
      queueMicrotask(next)
    } else {
      this.holders = Math.max(0, this.holders - 1)
    }
  }
}

/** The caller's abort signal fired while queued on the mutex. */
export class AbortedWaitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortedWaitError'
  }
}

/** The bounded wait elapsed before the mutex became available. */
export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaitTimeoutError'
  }
}

export const credentialSlotMutex = new AsyncMutex()

// ---- cross-process slot lock with process liveness probing -----------------

/**
 * Detect whether an external process by PID is currently running.
 * Uses process.kill(pid, 0) which tests for process existence without sending a signal.
 * - Returns true if the process exists (including EPERM when owned by another user).
 * - Returns false if ESRCH (process does not exist / exited), or if the PID is invalid.
 */
export function isProcessAlive(pid: number | undefined | null): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return true
    return false
  }
}

export const SLOT_LOCK_NAME = '.credential-slot.lock'
export const SLOT_LOCK_STALE_MS = 45_000

export function slotLockFilePath(baseDir: string): string {
  return join(baseDir, SLOT_LOCK_NAME)
}

export interface SlotLockData {
  pid: number
  acquiredAt: number
  holder?: string
}

/**
 * Acquire a cross-process lock for the Windows credential slot.
 * Inspects any existing lock's PID via `process.kill(pid, 0)`.
 * If the recorded holder process has crashed/exited, the dead lock is reclaimed
 * immediately instead of stalling for timeout.
 */
export async function acquireCrossProcessSlotLock(
  baseDir: string,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
    signal?: AbortSignal
    log?: (msg: string) => void
    holder?: string
  } = {},
): Promise<() => void> {
  const lockFile = slotLockFilePath(baseDir)
  const timeoutMs = options.timeoutMs ?? 15_000
  const pollMs = options.pollIntervalMs ?? 50
  const log = options.log ?? ((): void => {})
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0

  try {
    mkdirSync(baseDir, { recursive: true })
  } catch {
    // ignore
  }

  for (;;) {
    if (options.signal?.aborted) {
      throw new AbortedWaitError('aborted while waiting for cross-process slot lock')
    }

    if (existsSync(lockFile)) {
      let isStale = false
      let holderPid: number | undefined
      try {
        const content = readFileSync(lockFile, 'utf8')
        const parsed = JSON.parse(content) as SlotLockData
        holderPid = parsed.pid
        if (typeof holderPid === 'number') {
          if (!isProcessAlive(holderPid)) {
            isStale = true
            log(`[agy-link] removing stale slot lock from dead process ${holderPid} (instant self-heal)`)
          } else if (Date.now() - (parsed.acquiredAt || 0) > SLOT_LOCK_STALE_MS) {
            isStale = true
            log(`[agy-link] removing stale slot lock exceeding ${SLOT_LOCK_STALE_MS}ms timeout`)
          }
        } else {
          isStale = true
        }
      } catch {
        isStale = true
      }

      if (isStale) {
        try {
          unlinkSync(lockFile)
        } catch {
          // ignore
        }
      }
    }

    // Try atomic write of temporary file and rename
    const payload: SlotLockData = {
      pid: process.pid,
      acquiredAt: Date.now(),
      holder: options.holder,
    }
    const tempFile = lockFile + '.tmp-' + process.pid + '-' + Date.now()
    try {
      writeFileSync(tempFile, JSON.stringify(payload), { flag: 'wx', encoding: 'utf8' })
      renameSync(tempFile, lockFile)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          if (existsSync(lockFile)) {
            const raw = readFileSync(lockFile, 'utf8')
            const parsed = JSON.parse(raw) as SlotLockData
            if (parsed.pid === process.pid) {
              unlinkSync(lockFile)
            }
          }
        } catch {
          // best-effort cleanup
        }
      }
    } catch {
      try {
        unlinkSync(tempFile)
      } catch {
        // ignore
      }
    }

    if (deadline > 0 && Date.now() >= deadline) {
      throw new WaitTimeoutError('timed out waiting for cross-process slot lock')
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// ---- platform seam ---------------------------------------------------------

/**
 * The platform-specific operations the slot manager needs. Injectable so the
 * handoff guards can be tested without touching the real Windows Credential
 * Manager.
 */
export interface SlotIo {
  platform: NodeJS.Platform
  readSlot(): string | null
  writeSlot(raw: string): boolean
  identify(raw: string | null | undefined, proxyUrl?: string): Promise<string | undefined>
}

export function defaultSlotIo(): SlotIo {
  return {
    platform: process.platform,
    readSlot: () => readWindowsCredentialRaw(SLOT_TARGET),
    writeSlot: (raw) => writeWindowsCredentialRaw(raw, SLOT_TARGET),
    identify: identifyCredential,
  }
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

export function readPrimaryCredential(baseDir = defaultPoolDir()): PrimaryCredential | null {
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

export function writePrimaryCredential(cred: PrimaryCredential, baseDir = defaultPoolDir()): boolean {
  try {
    mkdirSync(baseDir, { recursive: true })
  } catch {
    // ignore
  }
  return writeFileAtomic(primaryStorePath(baseDir), JSON.stringify(cred, null, 2))
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

// ---- primary credential resolution ---------------------------------------

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
export async function resolvePrimaryCredential(
  pool: AccountPoolManager | undefined,
  options: ResolveOptions = {},
): Promise<PrimaryCredential | null> {
  const io = resolveIo(options)
  const baseDir = options.baseDir ?? defaultPoolDir()
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
  const log = options.log ?? ((): void => {})

  const stored = readPrimaryCredential(baseDir)
  if (stored && options.force !== true) return stored

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
  if (io.platform === 'win32') candidates.push({ where: 'credential slot', raw: io.readSlot() })

  for (const candidate of candidates) {
    if (!candidate.raw) continue
    // A credential without a refresh token cannot be identified across access
    // token rotations, and would degrade the durable store back to an
    // unidentifiable document. Never adopt one.
    if (!parseCredentialDoc(candidate.raw)?.refreshToken) {
      log(`[agy-link] primary credential candidate "${candidate.where}" has no refresh token — skipped`)
      continue
    }
    const email = await io.identify(candidate.raw, options.proxyUrl)
    if (!email) continue
    if (expectedEmail && email !== expectedEmail) {
      log(
        `[agy-link] primary credential candidate "${candidate.where}" belongs to ${email}, ` +
          `expected ${expectedEmail} — skipped`,
      )
      continue
    }
    const cred: PrimaryCredential = { raw: candidate.raw, email, savedAt: Date.now() }
    writePrimaryCredential(cred, baseDir)
    log(`[agy-link] adopted primary credential from ${candidate.where} <${email}>`)
    return cred
  }

  log('[agy-link] could not verify a primary credential; slot handoff disabled to protect the system login')
  return null
}

// ---- slot lease ------------------------------------------------------------

export interface SlotLease {
  release(): void
  /** Identity the slot was verified to hold while this lease was active. */
  identity?: string
}

export class SlotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlotUnavailableError'
  }
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
function installSlotOrThrow(io: SlotIo, raw: string, log: (msg: string) => void, label: string): void {
  if (io.writeSlot(raw)) return
  log('[agy-link] credential slot write failed for ' + label + ' — retrying once')
  if (io.writeSlot(raw)) return
  throw new SlotUnavailableError(
    'could not install the ' + label + ' credential into the Windows credential slot (the write was rejected) — ' +
    'refusing to run, because agy would authenticate as whichever account is already in the slot',
  )
}

/** Restore path: never fail a teardown, but say so loudly. */
function installSlotBestEffort(io: SlotIo, raw: string, log: (msg: string) => void, label: string): void {
  try {
    installSlotOrThrow(io, raw, log, label)
  } catch (err) {
    log(
      '[agy-link] WARNING: could not restore the ' + label + ' credential into the slot (' +
      (err instanceof Error ? err.message : String(err)) + ') — the next run re-installs it',
    )
  }
}

// ---- same-account concurrency ----------------------------------------------
//
// agy is a stateless CLI process and natively supports concurrent runs. The
// ONLY thing that must stay exclusive on Windows is the machine-global
// credential slot, and only when its IDENTITY has to change:
//
//   * Runs on the identity ALREADY in the slot only ever READ the credential.
//     Google refresh tokens are not single-use, so parallel token refreshes on
//     one grant produce multiple valid access tokens — no conflict. These runs
//     bypass the mutex entirely (FAST PATH) and are pure parallelism.
//   * A run that needs a DIFFERENT identity in the slot must first wait out
//     every same-identity run: swapping the slot under a live process would
//     feed it the wrong credential on its next in-run token refresh — the
//     exact corruption class this module exists to prevent. While a switch
//     waits, new fast paths are refused so the switcher cannot starve.
//
// A SECONDARY account's installed identity is reference-counted: the first run
// performs the exclusive handoff and keeps the mutex, later runs on the same
// grant join it as fast leases, and the LAST holder persists any rotated token
// and restores the primary. Before this existed every secondary run held the
// slot exclusively (only the primary had a fast path), so one long agy run on
// the active pool account starved every other session — three cardboard-empire
// turns parked ~9 minutes behind a single run on 2026-10-17.

let primaryFastRuns = 0

interface InstalledIdentity {
  /** Credential grant currently installed in the Windows slot. */
  fingerprint: string
  /** Runs relying on it: the handoff owner plus same-identity fast leases. */
  holders: number
  /** Persist a rotated token, restore the primary, release the mutex. */
  finish: () => void
}

/** The secondary identity currently installed in the slot, if any. */
let installedIdentity: InstalledIdentity | null = null

/** Event bus to immediately wake queued same-identity runs when an identity is installed. */
const slotEvents = new EventEmitter()
slotEvents.setMaxListeners(500)

/**
 * Identities that waiting runs want installed, keyed by grant fingerprint
 * (`'primary'` for the system account). Same-identity peers may still join
 * while a key for their OWN grant is pending; joins are refused as soon as a
 * DIFFERENT identity waits, so a switcher can never be postponed forever.
 */
const pendingSwitchTargets = new Map<string, number>()

function claimSwitchTarget(key: string): void {
  pendingSwitchTargets.set(key, (pendingSwitchTargets.get(key) ?? 0) + 1)
}

function releaseSwitchTarget(key: string): void {
  const left = (pendingSwitchTargets.get(key) ?? 0) - 1
  if (left > 0) pendingSwitchTargets.set(key, left)
  else pendingSwitchTargets.delete(key)
}

/** Live same-identity run count — exported for diagnostics. */
export function fastPathRunCount(): number {
  return primaryFastRuns + (installedIdentity?.holders ?? 0)
}

// ---- narrow exclusive window: hand the slot back after the startup read ----
//
// MEASURED 2026-10-22 (agy 1.4.3, live 14-minute run):
//   I ... 23:02:35.889 printmode.go:403  Print mode: not authenticated, trying silent auth
//   I ... 23:02:38.617 printmode.go:405  Print mode: silent auth succeeded
//   ... 14 minutes of streamGenerateContent with ZERO further token/auth lines.
// In print mode agy resolves its credential ONCE at startup and keeps it in
// memory afterwards. Holding the machine-wide slot for the whole run is
// therefore unnecessary serialization: it lets one healthy long run in one
// workspace freeze every other session on every other account (2026-10-22:
// two promo-tcn sessions parked 15 minutes behind a 14-minute run in another
// project — the "sessions look stuck" report).
//
// This controller releases the lease as soon as the child proves it is past
// credential resolution (first stdout/stderr line), with a timeout for a run
// whose startup is slow. It is idempotent and never throws.

/** Default ceiling for holding the slot while waiting for the first event. */
export const SLOT_HANDOFF_TIMEOUT_MS = 45_000

export interface SlotHandoff {
  /** The run produced its first event: agy has read the credential. */
  onFirstEvent(): void
  /** The run ended (or was abandoned) before the first event. */
  dispose(): void
  /** True once the lease was handed back. */
  released(): boolean
  /** True when the timeout (not the first event) triggered the hand-off. */
  timedOut(): boolean
}

/**
 * Arrange for a credential-slot lease to be released after the startup read.
 *
 * Correctness rests on the caller's spawn ordering, which does not change: the
 * identity is installed UNDER the mutex immediately before the spawn, so
 * whatever a later switcher does cannot affect a run that is already past its
 * read. The residual exposure is a mid-run 401 forcing a re-auth (agy would
 * then read whatever identity is installed at that moment); the hand-off logs
 * when it fires so that case is diagnosable instead of silent.
 */
export function armSlotHandoff(opts: {
  release: () => void
  timeoutMs?: number
  log?: (msg: string) => void
}): SlotHandoff {
  const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : SLOT_HANDOFF_TIMEOUT_MS
  const log = opts.log ?? ((): void => {})
  let done = false
  let byTimeout = false
  let timer: NodeJS.Timeout | null = null
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const fire = (reason: 'first-event' | 'timeout' | 'run-end'): void => {
    if (done) return
    done = true
    clear()
    try {
      opts.release()
    } catch {
      // best effort — the lease is refcounted and its release is idempotent
    }
    if (reason !== 'first-event') {
      log('[agy-link] credential slot handed back at ' + reason + ' (no first event yet)')
    }
  }
  timer = setTimeout(() => {
    timer = null
    if (done) return
    byTimeout = true
    log(
      '[agy-link] credential slot held for ' + Math.round(timeoutMs / 1000) +
      's without a first event — handing it back so other sessions are not blocked',
    )
    fire('timeout')
  }, timeoutMs)
  timer.unref?.()
  return {
    onFirstEvent: (): void => fire('first-event'),
    dispose: (): void => fire('run-end'),
    released: (): boolean => done,
    timedOut: (): boolean => byTimeout,
  }
}

/** True while a run is waiting for (or performing) a slot identity switch. */
export function isSlotSwitchPending(): boolean {
  return pendingSwitchTargets.size > 0
}

/**
 * Leave a reference-counted secondary identity. The last holder completes the
 * handoff: persist a rotated token, restore the primary, release the mutex.
 */
function leaveInstalledIdentity(state: InstalledIdentity): void {
  if (state.holders <= 0) return
  state.holders -= 1
  if (state.holders > 0) return
  if (installedIdentity === state) installedIdentity = null
  state.finish()
}

/**
 * Take ownership of the credential slot for a run and arrange its guaranteed
 * restoration.
 *
 * Non-Windows platforms have no shared slot (per-account Keychain isolation
 * works), so this is a no-op there.
 *
 * Same-identity runs take a FAST PATH: when the slot provably holds THIS
 * account's credential and no switch is pending, the run starts IMMEDIATELY
 * without the mutex, so multiple sessions on one account run truly in parallel
 * (agy is a stateless CLI and handles concurrent processes natively). For a
 * secondary account the first run performs the handoff and later runs on the
 * same grant join it — including runs that were already QUEUED for the slot,
 * which poll and join as soon as their own grant is installed. The last holder
 * restores the primary. Only identity SWITCHES serialize.
 *
 * @param options.signal  cancels the wait for the slot — without it a turn
 *   queued behind another session's long run ignored Stop entirely (the
 *   cardboard-empire zombie turn, 2026-10-16).
 * @param options.dispatchTimeoutMs  bounds the wait; 0/undefined waits
 *   indefinitely (the wait stays observable and cancellable either way).
 * @param options.parallel  same-account fast path (default true). false
 *   restores full-run exclusivity.
 * @throws SlotUnavailableError when the slot cannot be handed over safely.
 *   The caller must abort the run instead of silently signing in as the wrong
 *   account (which would spend that account's quota).
 * @throws AbortedWaitError when the signal aborted while queued.
 * @throws WaitTimeoutError when the bounded wait elapsed.
 */
export async function acquireCredentialSlot(
  account: ManagedAccount | undefined,
  pool: AccountPoolManager | undefined,
  options: ResolveOptions = {},
): Promise<SlotLease | undefined> {
  const io = resolveIo(options)
  if (io.platform !== 'win32' || !account) return undefined

  const baseDir = options.baseDir ?? defaultPoolDir()
  const homeDir = options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? ''
  const log = options.log ?? ((): void => {})
  const parallel = options.parallel !== false
  const isPrimarySlot = Boolean(account.systemHome) || !account.dir

  // -- FAST PATH: same-account, slot identity already correct ---------------
  // No mutex, no wait: N sessions on the primary account run in parallel.
  if (parallel && isPrimarySlot && !isSlotSwitchPending() && !options.signal?.aborted) {
    const stored = readPrimaryCredential(baseDir)
    if (stored && sameCredentialGrant(io.readSlot(), stored.raw)) {
      primaryFastRuns += 1
      log('[agy-link] same-account fast path: slot already holds the primary credential — running without exclusivity')
      return {
        identity: stored.email,
        release: (): void => {
          primaryFastRuns = Math.max(0, primaryFastRuns - 1)
          // Opportunistic in-place refresh capture: agy may have rotated the
          // access token (same grant). Cheap and guarded by the grant check —
          // concurrent releases writing identical content are harmless.
          try {
            const afterRaw = io.readSlot()
            if (afterRaw && afterRaw !== stored.raw && sameCredentialGrant(afterRaw, stored.raw)) {
              writePrimaryCredential({ raw: afterRaw, email: stored.email, savedAt: Date.now() }, baseDir)
            }
          } catch {
            // best effort — the durable store is refreshed on the next slow path
          }
        },
      }
    }
  }

  // Requested identity (cheap file read): needed both to join an identity that
  // is already installed and to register this run's switch intent while queued.
  const requestedFile = isPrimarySlot ? null : accountTokenFilePath(account, homeDir)
  const requestedRaw = requestedFile === null ? null : readTokenFileRaw(requestedFile)
  const requestedFingerprint = isPrimarySlot ? null : credentialFingerprint(requestedRaw)
  const switchKey = isPrimarySlot ? 'primary' : (requestedFingerprint ?? 'unknown')

  // -- FAST PATH: reuse a secondary identity ALREADY installed --------------
  // The first run on a secondary account wrote its credential into the slot and
  // owns the handoff mutex until its LAST same-identity peer exits. A later run
  // on the same grant needs no switch at all: it only has to prove the slot
  // still carries that grant (an external writer may have replaced it), then it
  // joins as a fast lease. Google refresh tokens are not single-use, so
  // concurrent in-run refreshes on one grant are harmless.
  const joinInstalled = (): SlotLease | null => {
    if (!parallel || isPrimarySlot || requestedRaw === null || requestedFingerprint === null) return null
    if (options.signal?.aborted) return null
    const state = installedIdentity
    if (state === null || state.fingerprint !== requestedFingerprint) return null
    // Refuse to extend an installed identity while ANOTHER identity waits to
    // switch in — that guard is what keeps the switcher from starving.
    for (const key of pendingSwitchTargets.keys()) {
      if (key !== switchKey) return null
    }
    // Prove the slot still carries this grant: never join an identity the
    // machine no longer holds (another host may have replaced it).
    if (!sameCredentialGrant(io.readSlot(), requestedRaw)) return null
    state.holders += 1
    return {
      identity: account.email,
      release: (): void => leaveInstalledIdentity(state),
    }
  }

  const immediate = joinInstalled()
  if (immediate) {
    log("[agy-link] same-identity fast path: slot already holds this account's credential — running without exclusivity")
    return immediate
  }

  // -- SWITCH GUARD: register the intent BEFORE queueing --------------------
  // Without this, same-identity peers could keep joining and hold the installed
  // identity forever (the 2026-10-17 starvation shape).
  let claimSwitch = false
  const claim = (): void => {
    if (claimSwitch || !parallel) return
    claimSwitch = true
    claimSwitchTarget(switchKey)
  }
  const releaseClaim = (): void => {
    if (!claimSwitch) return
    claimSwitch = false
    releaseSwitchTarget(switchKey)
  }
  claim()

  // -- SLOW PATH: serialized handoff (identity switch or slot repair) ------
  // While queued, poll for a join opportunity: another run on this SAME grant
  // may install the identity first, and joining it is how a backlog of sessions
  // drains in parallel instead of one whole run at a time. Aborting the mutex
  // wait is safe — AsyncMutex removes the waiter and wakes the next one.
  const joinAbort = new AbortController()
  const waitSignal = options.signal
    ? AbortSignal.any([options.signal, joinAbort.signal])
    : joinAbort.signal
  let joinLease: SlotLease | null = null

  const onSlotInstalled = (fp: string) => {
    if ((fp === switchKey || fp === 'any') && joinLease === null) {
      const lease = joinInstalled()
      if (lease !== null) {
        joinLease = lease
        joinAbort.abort()
      }
    }
  }
  slotEvents.on('installed', onSlotInstalled)

  const joinPoll = setInterval(() => {
    if (joinLease !== null) return
    const lease = joinInstalled()
    if (lease !== null) {
      joinLease = lease
      joinAbort.abort()
    }
  }, 100)
  joinPoll.unref?.()

  let releaseMutex: (() => void) | null = null
  try {
    releaseMutex = await credentialSlotMutex.acquire({
      signal: waitSignal,
      timeoutMs: options.dispatchTimeoutMs,
      // Heal a lost wakeup within seconds instead of parking the turn forever.
      pollMs: 5_000,
      shouldProceed: () => true,
    })
  } catch (err) {
    clearInterval(joinPoll)
    slotEvents.off('installed', onSlotInstalled)
    if (joinLease !== null) {
      const lease = joinLease
      releaseClaim()
      log('[agy-link] queued run joined an installed same-identity slot lease — running in parallel')
      return lease
    }
    releaseClaim()
    throw err
  }
  clearInterval(joinPoll)
  slotEvents.off('installed', onSlotInstalled)
  if (joinLease !== null) {
    // Both paths won in the same tick: keep the join, hand the mutex back.
    const lease = joinLease
    joinLease = null
    releaseMutex()
    releaseClaim()
    log('[agy-link] queued run joined an installed same-identity slot lease — running in parallel')
    return lease
  }
  const releaseMutexSlot = releaseMutex

  let releaseFileLock: (() => void) | null = null
  if (io.platform === 'win32') {
    try {
      releaseFileLock = await acquireCrossProcessSlotLock(baseDir, {
        timeoutMs: options.dispatchTimeoutMs,
        signal: options.signal,
        log,
        holder: account.alias || account.id,
      })
    } catch (err) {
      releaseClaim()
      releaseMutexSlot()
      throw err
    }
  }

  const releaseLockFileNow = (): void => {
    try {
      releaseFileLock?.()
      releaseFileLock = null
    } catch {
      // best-effort cleanup
    }
  }

  let released = false
  const done = (): void => {
    if (released) return
    released = true
    releaseLockFileNow()
    releaseClaim()
    releaseMutexSlot()
  }

  // An abort that landed in the same tick as the grant must not run a turn
  // nobody is reading anymore.
  if (options.signal?.aborted) {
    done()
    throw new AbortedWaitError('aborted after acquiring the credential slot')
  }

  try {
    const primary = await resolvePrimaryCredential(pool, { ...options, baseDir, homeDir })
    const accountFile = accountTokenFilePath(account, homeDir)
    const accountRaw = readTokenFileRaw(accountFile)

    if (!primary) {
      done()
      throw new SlotUnavailableError(
        'Cannot verify the primary Antigravity credential, so the Windows credential slot cannot be ' +
          'handed over safely. Sign the primary account in again, then retry.',
      )
    }

    // -- Primary run (serialized: slot repair or parallel disabled) -------
    if (isPrimarySlot) {
      if (!sameCredentialGrant(io.readSlot(), primary.raw)) {
        log('[agy-link] re-asserting the primary credential into the Windows credential slot')
        installSlotOrThrow(io, primary.raw, log, 'primary')
      }
      releaseLockFileNow()
      // The identity is installed: same-account peers may fast-path again.
      releaseClaim()
      slotEvents.emit('installed', 'primary')
      return {
        identity: primary.email,
        release: (): void => {
          try {
            const afterRaw = io.readSlot()
            if (sameCredentialGrant(afterRaw, primary.raw)) {
              // agy may have refreshed the access token in place — keep the
              // durable copy current. The identity is unchanged.
              if (afterRaw && afterRaw !== primary.raw) {
                writePrimaryCredential({ raw: afterRaw, email: primary.email, savedAt: Date.now() }, baseDir)
              }
            } else if (afterRaw) {
              // Something replaced the primary mid-run. Put it back.
              log('[agy-link] credential slot changed during a primary run — restoring the primary credential')
              installSlotBestEffort(io, primary.raw, log, 'primary')
              writePrimaryCredential(primary, baseDir)
            }
          } finally {
            done()
          }
        },
      }
    }

    // -- Secondary run: identity SWITCH — drain same-identity runs first --
    // Swapping the slot under a live primary process would feed it THIS
    // account's credential on its next in-run token refresh. The switch claim
    // registered above already refuses NEW fast paths; this loop waits out the
    // ones that were live when the claim landed.
    if (parallel && primaryFastRuns > 0) {
      const deadline = options.dispatchTimeoutMs !== undefined && options.dispatchTimeoutMs > 0
        ? Date.now() + options.dispatchTimeoutMs
        : 0
      log(`[agy-link] waiting for ${primaryFastRuns} same-account run(s) to finish before switching the credential slot to ${account.alias || account.id}`)
      while (primaryFastRuns > 0) {
        if (options.signal?.aborted) {
          throw new AbortedWaitError('aborted while waiting for same-account runs to finish')
        }
        if (deadline !== 0 && Date.now() > deadline) {
          throw new WaitTimeoutError(
            `timed out waiting for ${primaryFastRuns} same-account run(s) to finish before switching the credential slot`,
          )
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    if (!accountRaw) {
      done()
      throw new SlotUnavailableError(
        `Account ${account.alias || account.id} has no stored credential. Sign it in again before using it.`,
      )
    }

    const accountFingerprint = credentialFingerprint(accountRaw)
    if (!accountFingerprint) {
      done()
      throw new SlotUnavailableError(
        `Account ${account.alias || account.id} has an unreadable credential file. Sign it in again.`,
      )
    }

    // Guard against the historical corruption: a secondary whose file was
    // overwritten with the primary's credential would otherwise run as the
    // primary and quietly spend the primary's quota.
    if (sameCredentialGrant(accountRaw, primary.raw)) {
      done()
      throw new SlotUnavailableError(
        `Account ${account.alias || account.id} holds the SAME credential as the primary account — ` +
          'its login was overwritten. Sign this account in again to restore its own token.',
      )
    }

    installSlotOrThrow(io, accountRaw, log, account.alias || account.id)
    releaseLockFileNow()
    // This account's identity is installed and STAYS installed while any
    // same-identity peer is live: the mutex this lease holds is handed back by
    // the LAST holder, which also restores the primary. Until then agy may
    // rotate the access token in place as often as it likes — the grant (and
    // therefore the identity) is unchanged.
    const state: InstalledIdentity = {
      fingerprint: accountFingerprint,
      holders: 1,
      finish: (): void => {
        try {
          const afterRaw = io.readSlot()
          const afterFingerprint = credentialFingerprint(afterRaw)
          if (sameCredentialGrant(afterRaw, accountRaw)) {
            // Slot still belongs to this account: agy may have refreshed the
            // access token, so persist it back into the account's own file.
            if (afterRaw && afterRaw !== accountRaw) {
              writeFileAtomic(accountFile, afterRaw)
            }
          } else if (afterFingerprint !== null) {
            // The slot was taken over while this run was live. Writing it back
            // would copy a FOREIGN credential into this account's file — the
            // exact bug that destroyed this pool. Leave the file untouched.
            log(
              `[agy-link] credential slot was replaced during ${account.alias || account.id}'s run — ` +
                'refusing to write a foreign credential into the account file',
            )
          }
        } finally {
          try {
            installSlotBestEffort(io, primary.raw, log, 'primary')
          } finally {
            done()
          }
        }
      },
    }
    installedIdentity = state
    // Identity installed: peers on this grant may join now. A queued switcher
    // keeps its own claim, so this only releases THIS run's guard.
    releaseClaim()
    slotEvents.emit('installed', accountFingerprint)
    return {
      identity: account.email,
      release: (): void => leaveInstalledIdentity(state),
    }
  } catch (err) {
    done()
    throw err
  }
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
