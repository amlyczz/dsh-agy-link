// Auth-quarantine state machine: the 需重新登录 flag's whole lifecycle.
//
// Extracted from PoolAdmin (file budget + one definition of "this login is
// dead"). Every path in the plugin funnels here:
//   mark()            — authoritative evidence, quarantine now
//   noteFailure()     — non-authoritative banner, needs a second confirmation
//   clear()           — proven alive (token refresh / quota / successful run)
//   healFromQuota()   — a quota snapshot newer than the flag disproves it
//   noteReverifyAttempt() — one failed background re-check → exponential back-off
import {
  AUTH_CONFIRM_STRIKES,
  isTerminalAuthError,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'

/** What the flag lifecycle needs from the pool it lives in. */
export interface AuthFlagDeps {
  getData(): AccountPoolData
  persist(): void
  /** Per-account consecutive non-authoritative auth-failure streak (in-memory). */
  authStrikes: Map<string, number>
}

export class AccountAuthFlags {
  constructor(private readonly deps: AuthFlagDeps) {}

  private account(id: string): ManagedAccount | undefined {
    return this.deps.getData().accounts.find((a) => a.id === id)
  }

  /** Quarantine now: the account leaves rotation until it is proven alive again. */
  mark(id: string, reason?: string): void {
    const data = this.deps.getData()
    const acc = this.account(id)
    if (!acc) return
    acc.authRequired = true
    acc.authMarkedAt = Date.now()
    acc.authError = reason || 'Authentication expired or revoked (invalid_grant)'
    if (data.lastActiveAccountId === id) {
      data.lastActiveAccountId = undefined
    }
    if (data.activeAccountIds) {
      for (const [fam, accId] of Object.entries(data.activeAccountIds)) {
        if (accId === id) delete data.activeAccountIds[fam as ModelFamily]
      }
    }
    this.deps.authStrikes.delete(id)
    this.deps.persist()
  }

  /**
   * Confirmation-gated quarantine for auth-classified failures that carry NO
   * authoritative evidence (no invalid_grant / revoked / unauthorized_client).
   *
   * agy prints the same "not signed in" banner whether the login is really
   * dead or its keyring validation merely missed a 10s window on a flaky
   * network, so one banner used to sticky-quarantine healthy accounts — the
   * user then saw a red 需重新登录 and could not even 设为当前使用. A single
   * strike now only rotates the account away for the current retry; the flag
   * hardens into a real quarantine only when the failure repeats with no
   * success in between. Authoritative OAuth paths keep calling mark()
   * directly and quarantine on first sight.
   *
   * Returns true when the account is now hard-quarantined.
   */
  noteFailure(id: string, reason?: string): boolean {
    const strikes = (this.deps.authStrikes.get(id) ?? 0) + 1
    if (strikes < AUTH_CONFIRM_STRIKES) {
      this.deps.authStrikes.set(id, strikes)
      return false
    }
    this.mark(id, reason)
    return true
  }

  /**
   * Drop the "needs re-login" flag.
   *
   * Automatic paths (a successful quota/token refresh, boot-time credential
   * recovery) must NOT lift a TERMINAL TOS ban: those accounts still have a
   * valid refresh token, so every refresh would succeed and clear the ban
   * (issue #114). `force` is reserved for explicit user actions — a completed
   * re-login or a fresh credential import.
   */
  clear(id: string, force = false): void {
    const acc = this.account(id)
    if (!acc) return
    if (!force && isTerminalAuthError(acc.authError)) return
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    delete acc.authReverifyAttempts
    this.deps.authStrikes.delete(id)
    this.deps.persist()
  }

  /**
   * Count one failed background re-verification so the next attempt backs off
   * (2m → 4m → 8m → 16m → 30m). A dead login must not be re-probed every two
   * minutes; a false positive heals on the first attempt and never gets here.
   */
  noteReverifyAttempt(id: string): void {
    const acc = this.account(id)
    if (!acc?.authRequired) return
    acc.authReverifyAttempts = (acc.authReverifyAttempts ?? 0) + 1
    this.deps.persist()
  }

  /**
   * Clear "needs re-login" flags that later evidence has already disproved.
   *
   * A quota row whose `updatedAt` is NEWER than `authMarkedAt` can only exist if
   * an authenticated upstream call succeeded after the flag was written — which
   * is exactly what the badge claims is impossible. The writer may be another
   * process (web + CLI share pool.json) or a background sweep that was already
   * in flight when the flag landed, so this is a zero-network reconciliation
   * rather than a "re-read the snapshot" fix.
   *
   * Terminal TOS bans and Google verification challenges are exempt: their
   * quota endpoints still answer for a valid token (issue #114).
   */
  healFromQuota(): string[] {
    const data = this.deps.getData()
    const healed: string[] = []
    for (const acc of data.accounts) {
      if (!acc.authRequired) continue
      if (isTerminalAuthError(acc.authError)) continue
      const reason = acc.quotaUnavailable?.reason
      if (reason === 'validation_required' || reason === 'tos_violation') continue
      const markedAt = typeof acc.authMarkedAt === 'number' ? acc.authMarkedAt : 0
      let newest = 0
      for (const q of Object.values(acc.quotas ?? {})) {
        const at = q?.updatedAt ?? 0
        if (at > newest) newest = at
      }
      if (newest <= markedAt) continue
      delete acc.authRequired
      delete acc.authError
      delete acc.authMarkedAt
      delete acc.authReverifyAttempts
      this.deps.authStrikes.delete(acc.id)
      healed.push(acc.id)
    }
    if (healed.length > 0) this.deps.persist()
    return healed
  }
}
