// The credential-slot state machine: same-account fast paths, refcounted
// installed secondary identities, identity-switch serialization and the
// acquire/release transitions.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g). Module-level
// mutable state (fast-path counters / installed identity / pending targets)
// lives in switch-state.ts so the host facade and every caller share exactly one
// instance.
// Platform operations arrive through `CredentialPlatform`; nothing in this file
// imports host/wincred/oauth/net.

import type { ManagedAccount } from '../../common/pool-types.ts'
import {
  accountTokenFilePath,
  credentialFingerprint,
  readPrimaryCredentialAt,
  readTokenFileRaw,
  sameCredentialGrant,
  writeFileAtomic,
  writePrimaryCredentialAt,
  type PrimaryCredential,
} from './docs.ts'
import { AbortedWaitError, SlotUnavailableError, WaitTimeoutError } from './errors.ts'
import { acquireCrossProcessSlotLock } from './lock.ts'
import { credentialSlotMutex } from './mutex.ts'
import { saveCredentialBackup } from './backup.ts'
import { installSlotBestEffort, installSlotOrThrow, type SlotLease } from './lease.ts'
import type { CredentialPlatform } from './platform.ts'
import { resolvePrimaryCredentialAt, type AccountPoolLike } from './resolve.ts'

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

import {
  claimSwitchTarget,
  currentInstalledIdentity,
  enterPrimaryFastRun,
  leavePrimaryFastRun,
  isSlotSwitchPending,
  pendingSwitchKeys,
  primaryFastRunCount,
  releaseSwitchTarget,
  setInstalledIdentity,
  slotEvents,
  type InstalledIdentity,
} from './switch-state.ts'
import { slotEmailMatches as slotEmailMatchesIn, slotIdentity, type AcquireInput } from './guards.ts'

export { fastPathRunCount, isSlotSwitchPending } from './switch-state.ts'

// The identity checks (gate 1), the primary re-assertion (gate 3) and the
// `AcquireInput` they share live in guards.ts, the fast-path counters and the
// switch-target bookkeeping in switch-state.ts, so this state machine stays
// under the module budget.


/**
 * Leave a reference-counted secondary identity. The last holder completes the
 * handoff: persist a rotated token, restore the primary, release the mutex.
 */
function leaveInstalledIdentity(state: InstalledIdentity): void {
  if (state.holders <= 0) return
  state.holders -= 1
  if (state.holders > 0) return
  if (currentInstalledIdentity() === state) setInstalledIdentity(null)
  state.finish()
}


export interface SlotAcquireOptions {
  account: ManagedAccount
  pool: AccountPoolLike | undefined
  io: CredentialPlatform
  baseDir: string
  homeDir: string
  log: (msg: string) => void
  parallel: boolean
  isPrimarySlot: boolean
  signal: AbortSignal | undefined
  dispatchTimeoutMs: number | undefined
  proxyUrl: string | undefined
  force: boolean | undefined
}

/**
 * Take ownership of the credential slot for a run and arrange its guaranteed
 * restoration.
 *
 * Non-Windows platforms have no shared slot (per-account Keychain isolation
 * works), so this is a no-op there.
 */
export async function acquireCredentialSlotAt(
  account: ManagedAccount | undefined,
  pool: AccountPoolLike | undefined,
  input: AcquireInput,
): Promise<SlotLease | undefined> {
  const io = input.platform
  if (io.platform !== 'win32' || !account) return undefined
  return new SlotAcquire({
    account,
    pool,
    io,
    baseDir: input.baseDir,
    homeDir: input.homeDir,
    log: input.log,
    parallel: input.parallel !== false,
    isPrimarySlot: Boolean(account.systemHome) || !account.dir,
    signal: input.signal,
    dispatchTimeoutMs: input.dispatchTimeoutMs,
    proxyUrl: input.proxyUrl,
    force: input.force,
  }).run()
}

/** One acquisition attempt. Mirrors the original inline control flow exactly. */
class SlotAcquire {
  private readonly account: ManagedAccount
  private readonly pool: AccountPoolLike | undefined
  private readonly io: CredentialPlatform
  private readonly baseDir: string
  private readonly homeDir: string
  private readonly log: (msg: string) => void
  private readonly parallel: boolean
  private readonly isPrimarySlot: boolean
  private readonly signal: AbortSignal | undefined
  private readonly dispatchTimeoutMs: number | undefined
  private readonly proxyUrl: string | undefined
  private readonly force: boolean | undefined

  private claimSwitch = false
  private requestedRaw: string | null = null
  private requestedFingerprint: string | null = null
  private switchKey = 'unknown'
  private readonly joinAbort = new AbortController()
  private joinLease: SlotLease | null = null
  private releaseMutexSlot: (() => void) | null = null
  private releaseFileLock: (() => void) | null = null
  private released = false

  constructor(opts: SlotAcquireOptions) {
    this.account = opts.account
    this.pool = opts.pool
    this.io = opts.io
    this.baseDir = opts.baseDir
    this.homeDir = opts.homeDir
    this.log = opts.log
    this.parallel = opts.parallel
    this.isPrimarySlot = opts.isPrimarySlot
    this.signal = opts.signal
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs
    this.proxyUrl = opts.proxyUrl
    this.force = opts.force
  }

  async run(): Promise<SlotLease | undefined> {
    const fast = this.fastPathPrimary()
    if (fast !== null) return fast

    // Requested identity (cheap file read): needed both to join an identity
    // that is already installed and to register this run's switch intent.
    const requestedFile = this.isPrimarySlot ? null : accountTokenFilePath(this.account, this.homeDir)
    this.requestedRaw = requestedFile === null ? null : readTokenFileRaw(requestedFile)
    this.requestedFingerprint = this.isPrimarySlot ? null : credentialFingerprint(this.requestedRaw)
    this.switchKey = this.isPrimarySlot ? 'primary' : (this.requestedFingerprint ?? 'unknown')

    const immediate = this.joinInstalled()
    if (immediate !== null) {
      this.log("[agy-link] same-identity fast path: slot already holds this account's credential — running without exclusivity")
      return immediate
    }

    // Register the intent BEFORE queueing: without this, same-identity peers
    // could keep joining and hold the installed identity forever.
    this.claim()

    const joined = await this.acquireMutexOrJoin()
    if (joined !== null) return joined

    await this.acquireFileLock()
    // An abort that landed in the same tick as the grant must not run a turn
    // nobody is reading anymore.
    if (this.signal?.aborted) {
      this.done()
      throw new AbortedWaitError('aborted after acquiring the credential slot')
    }
    return this.finish()
  }

  /**
   * Gate 1: prove the slot document really names `expected` before trusting it.
   *
   * A matching refresh grant is NOT proof of identity (signing the same account
   * in again mints a new grant), and the slot is shared by every agy process on
   * the machine. Returns false when agy's own recorded identity disagrees, so
   * the caller reinstalls instead of silently spending another account's quota.
   */
  private slotEmailMatches(expected: string | undefined): boolean {
    const matches = slotEmailMatchesIn(this.io, expected)
    if (!matches) {
      this.log(
        '[agy-link] credential slot holds ' + (slotIdentity(this.io) ?? 'an unreadable document') +
          ' but ' + expected + ' was requested — reinstalling the credential',
      )
    }
    return matches
  }

  /**
   * Same-account fast path: no mutex, no wait. N sessions on the primary
   * account run in parallel.
   */
  private fastPathPrimary(): SlotLease | null {
    if (!this.parallel || !this.isPrimarySlot || isSlotSwitchPending() || this.signal?.aborted) return null
    const stored = readPrimaryCredentialAt(this.baseDir)
    if (!stored || !sameCredentialGrant(this.io.readSlot(), stored.raw)) return null
    // The slot's grant matches the stored primary, but the identity agy recorded
    // in it may belong to another account (a refreshed foreign document can keep
    // the same shape). Never fast-path a slot we cannot identify.
    if (!this.slotEmailMatches(stored.email)) return null
    enterPrimaryFastRun()
    this.log('[agy-link] same-account fast path: slot already holds the primary credential — running without exclusivity')
    return {
      identity: stored.email,
      release: (): void => {
        leavePrimaryFastRun()
        // Opportunistic in-place refresh capture: agy may have rotated the
        // access token (same grant). Cheap and guarded by the grant check —
        // concurrent releases writing identical content are harmless.
        try {
          const afterRaw = this.io.readSlot()
          if (afterRaw && afterRaw !== stored.raw && sameCredentialGrant(afterRaw, stored.raw) && this.slotEmailMatches(stored.email)) {
            writePrimaryCredentialAt({ raw: afterRaw, email: stored.email, savedAt: Date.now() }, this.baseDir)
          }
        } catch {
          // best effort — the durable store is refreshed on the next slow path
        }
      },
    }
  }

  /** Join a secondary identity that is already installed in the slot. */
  private joinInstalled(): SlotLease | null {
    if (!this.parallel || this.isPrimarySlot || this.requestedRaw === null || this.requestedFingerprint === null) return null
    if (this.signal?.aborted) return null
    const state = currentInstalledIdentity()
    if (state === null || state.fingerprint !== this.requestedFingerprint) return null
    // Refuse to extend an installed identity while ANOTHER identity waits to
    // switch in — that guard is what keeps the switcher from starving.
    for (const key of pendingSwitchKeys()) {
      if (key !== this.switchKey) return null
    }
    // Prove the slot still carries this grant: never join an identity the
    // machine no longer holds (another host may have replaced it).
    if (!sameCredentialGrant(this.io.readSlot(), this.requestedRaw)) return null
    if (!this.slotEmailMatches(this.account.email)) return null
    state.holders += 1
    return {
      identity: this.account.email,
      release: (): void => leaveInstalledIdentity(state),
    }
  }

  private claim(): void {
    if (this.claimSwitch || !this.parallel) return
    this.claimSwitch = true
    claimSwitchTarget(this.switchKey)
  }

  private releaseClaim(): void {
    if (!this.claimSwitch) return
    this.claimSwitch = false
    releaseSwitchTarget(this.switchKey)
  }

  /**
   * Wait for the process-wide mutex, but keep polling for a same-grant join: a
   * backlog of sessions on one identity drains in parallel instead of one
   * whole run at a time. Returns a lease when the queue was joined; returns
   * null when the mutex is held (release fn stored in `releaseMutexSlot`).
   */
  private async acquireMutexOrJoin(): Promise<SlotLease | null> {
    const waitSignal = this.signal
      ? AbortSignal.any([this.signal, this.joinAbort.signal])
      : this.joinAbort.signal
    const onSlotInstalled = (fp: string): void => {
      if ((fp === this.switchKey || fp === 'any') && this.joinLease === null) {
        const lease = this.joinInstalled()
        if (lease !== null) {
          this.joinLease = lease
          this.joinAbort.abort()
        }
      }
    }
    slotEvents.on('installed', onSlotInstalled)

    const joinPoll = setInterval(() => {
      if (this.joinLease !== null) return
      const lease = this.joinInstalled()
      if (lease !== null) {
        this.joinLease = lease
        this.joinAbort.abort()
      }
    }, 100)
    joinPoll.unref?.()

    let releaseMutex: (() => void) | null = null
    try {
      releaseMutex = await credentialSlotMutex.acquire({
        signal: waitSignal,
        timeoutMs: this.dispatchTimeoutMs,
        // Heal a lost wakeup within seconds instead of parking the turn forever.
        pollMs: 5_000,
        shouldProceed: () => true,
      })
    } catch (err) {
      clearInterval(joinPoll)
      slotEvents.off('installed', onSlotInstalled)
      if (this.joinLease !== null) {
        const lease = this.joinLease
        this.releaseClaim()
        this.log('[agy-link] queued run joined an installed same-identity slot lease — running in parallel')
        return lease
      }
      this.releaseClaim()
      throw err
    }
    clearInterval(joinPoll)
    slotEvents.off('installed', onSlotInstalled)
    if (this.joinLease !== null) {
      // Both paths won in the same tick: keep the join, hand the mutex back.
      const lease = this.joinLease
      this.joinLease = null
      releaseMutex()
      this.releaseClaim()
      this.log('[agy-link] queued run joined an installed same-identity slot lease — running in parallel')
      return lease
    }
    this.releaseMutexSlot = releaseMutex
    return null
  }

  private async acquireFileLock(): Promise<void> {
    if (this.io.platform !== 'win32') return
    try {
      this.releaseFileLock = await acquireCrossProcessSlotLock(this.baseDir, {
        timeoutMs: this.dispatchTimeoutMs,
        signal: this.signal,
        log: this.log,
        holder: this.account.alias || this.account.id,
      })
    } catch (err) {
      this.releaseClaim()
      this.releaseMutexSlot?.()
      throw err
    }
  }

  private releaseLockFileNow(): void {
    try {
      this.releaseFileLock?.()
      this.releaseFileLock = null
    } catch {
      // best-effort cleanup
    }
  }

  private done(): void {
    if (this.released) return
    this.released = true
    this.releaseLockFileNow()
    this.releaseClaim()
    this.releaseMutexSlot?.()
    this.releaseMutexSlot = null
  }

  private async finish(): Promise<SlotLease> {
    try {
      const primary = await resolvePrimaryCredentialAt(this.pool, {
        baseDir: this.baseDir,
        homeDir: this.homeDir,
        platform: this.io,
        log: this.log,
        ...(this.proxyUrl === undefined ? {} : { proxyUrl: this.proxyUrl }),
        ...(this.force === undefined ? {} : { force: this.force }),
      })
      const accountFile = accountTokenFilePath(this.account, this.homeDir)
      const accountRaw = readTokenFileRaw(accountFile)

      if (!primary) {
        this.done()
        throw new SlotUnavailableError(
          'Cannot verify the primary Antigravity credential, so the Windows credential slot cannot be ' +
            'handed over safely. Sign the primary account in again, then retry.',
          'primary',
        )
      }

      if (this.isPrimarySlot) return this.primaryLease(primary)

      await this.drainPrimaryFastRuns()
      const checked = this.validateSecondary(primary, accountRaw)
      return this.secondaryLease(primary, checked.accountRaw, accountFile, checked.fingerprint)
    } catch (err) {
      this.done()
      throw err
    }
  }

  /** Primary run: slot repair (or full serialization when parallel is off). */
  private primaryLease(primary: PrimaryCredential): SlotLease {
    const identityOk = this.slotEmailMatches(primary.email)
    if (!identityOk || !sameCredentialGrant(this.io.readSlot(), primary.raw)) {
      this.log('[agy-link] re-asserting the primary credential into the Windows credential slot')
      installSlotOrThrow(this.io, primary.raw, this.log, 'primary')
    }
    this.releaseLockFileNow()
    // The identity is installed: same-account peers may fast-path again.
    this.releaseClaim()
    slotEvents.emit('installed', 'primary')
    return {
      identity: primary.email,
      release: (): void => {
        try {
          const afterRaw = this.io.readSlot()
          if (sameCredentialGrant(afterRaw, primary.raw)) {
            // agy may have refreshed the access token in place — keep the
            // durable copy current. The identity is unchanged, and the recorded
            // identity must say so before anything is copied over.
            if (afterRaw && afterRaw !== primary.raw && this.slotEmailMatches(primary.email)) {
              writePrimaryCredentialAt({ raw: afterRaw, email: primary.email, savedAt: Date.now() }, this.baseDir)
            }
          } else if (afterRaw) {
            // Something replaced the primary mid-run. Put it back.
            this.log('[agy-link] credential slot changed during a primary run — restoring the primary credential')
            installSlotBestEffort(this.io, primary.raw, this.log, 'primary')
            writePrimaryCredentialAt(primary, this.baseDir)
          }
        } finally {
          this.done()
        }
      },
    }
  }

  /** Wait out live same-account primary runs before swapping the slot. */
  private async drainPrimaryFastRuns(): Promise<void> {
    if (!this.parallel || primaryFastRunCount() <= 0) return
    const deadline = this.dispatchTimeoutMs !== undefined && this.dispatchTimeoutMs > 0
      ? Date.now() + this.dispatchTimeoutMs
      : 0
    this.log(`[agy-link] waiting for ${primaryFastRunCount()} same-account run(s) to finish before switching the credential slot to ${this.account.alias || this.account.id}`)
    while (primaryFastRunCount() > 0) {
      if (this.signal?.aborted) {
        throw new AbortedWaitError('aborted while waiting for same-account runs to finish')
      }
      if (deadline !== 0 && Date.now() > deadline) {
        throw new WaitTimeoutError(
          `timed out waiting for ${primaryFastRunCount()} same-account run(s) to finish before switching the credential slot`,
        )
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  private validateSecondary(
    primary: PrimaryCredential,
    accountRaw: string | null,
  ): { accountRaw: string; fingerprint: string } {
    if (!accountRaw) {
      this.done()
      throw new SlotUnavailableError(
        `Account ${this.account.alias || this.account.id} has no stored credential. Sign it in again before using it.`,
      )
    }
    const accountFingerprint = credentialFingerprint(accountRaw)
    if (!accountFingerprint) {
      this.done()
      throw new SlotUnavailableError(
        `Account ${this.account.alias || this.account.id} has an unreadable credential file. Sign it in again.`,
      )
    }
    // Guard against the historical corruption: a secondary whose file was
    // overwritten with the primary's credential would otherwise run as the
    // primary and quietly spend the primary's quota.
    if (sameCredentialGrant(accountRaw, primary.raw)) {
      this.done()
      throw new SlotUnavailableError(
        `Account ${this.account.alias || this.account.id} holds the SAME credential as the primary account — ` +
          'its login was overwritten. Sign this account in again to restore its own token.',
      )
    }
    return { accountRaw, fingerprint: accountFingerprint }
  }

  /** Secondary run: identity SWITCH, then a refcounted installed identity. */
  private secondaryLease(
    primary: PrimaryCredential,
    accountRaw: string,
    accountFile: string,
    accountFingerprint: string,
  ): SlotLease {
    installSlotOrThrow(this.io, accountRaw, this.log, this.account.alias || this.account.id)
    // Gate 1 after the write: prove agy will load THIS account. A rejected or
    // raced write leaves the previous account in place, and running anyway would
    // bill it for this account's turn.
    // Retry with a FRESH read: Windows Credential Manager occasionally reports
    // success while the previous value is still cached, so re-reading the same
    // buffer would only prove we wrote what we think we wrote.
    if (!this.slotEmailMatches(this.account.email)) {
      installSlotOrThrow(this.io, accountRaw, this.log, this.account.alias || this.account.id)
      if (!this.slotEmailMatches(this.account.email)) {
        this.done()
        throw new SlotUnavailableError(
          'The Windows credential slot still holds a different account after installing ' +
            (this.account.alias || this.account.id) +
            "'s credential — refusing to run, because agy would authenticate as the other account.",
        )
      }
    }
    this.releaseLockFileNow()
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
          const afterRaw = this.io.readSlot()
          const afterFingerprint = credentialFingerprint(afterRaw)
          if (sameCredentialGrant(afterRaw, accountRaw)) {
            // Slot still carries this account's GRANT — but a grant is not an
            // identity: another process can refresh the same grant while naming
            // a different account in the document. Copying that back would put
            // a foreign login into the account's own file, so the identity agy
            // recorded must agree before anything is written.
            if (afterRaw && afterRaw !== accountRaw && this.slotEmailMatches(this.account.email)) {
              if (readTokenFileRaw(accountFile) === accountRaw && writeFileAtomic(accountFile, afterRaw)) {
                saveCredentialBackup(accountFile, afterRaw)
              }
            }
          } else if (afterFingerprint !== null) {
            // The slot was taken over while this run was live. Writing it back
            // would copy a FOREIGN credential into this account's file — the
            // exact bug that destroyed this pool. Leave the file untouched.
            this.log(
              `[agy-link] credential slot was replaced during ${this.account.alias || this.account.id}'s run — ` +
                'refusing to write a foreign credential into the account file',
            )
          }
        } finally {
          try {
            installSlotBestEffort(this.io, primary.raw, this.log, 'primary')
          } finally {
            this.done()
          }
        }
      },
    }
    setInstalledIdentity(state)
    // Identity installed: peers on this grant may join now. A queued switcher
    // keeps its own claim, so this only releases THIS run's guard.
    this.releaseClaim()
    slotEvents.emit('installed', accountFingerprint)
    return {
      identity: this.account.email,
      release: (): void => leaveInstalledIdentity(state),
    }
  }
}