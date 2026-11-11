// Account-pool administration and scheduling, extracted from AccountPoolManager.
//
// Everything here operates on the pool's `AccountPoolData` (the manager's
// in-memory cache) and persists through injected callbacks, so this module
// needs no host dependencies: the keychain hook, the scheduler and the
// persistence/store are supplied by the caller. AccountPoolManager keeps thin
// delegating methods with the original signatures, so callers are unchanged.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import {
  AUTH_CONFIRM_STRIKES,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import { parseResetDurationMs } from '../../common/types.ts'
import { isAccountEligible, orderByExpiry, type DedicatedGroupSource } from './selection.ts'

/** State and capabilities AccountPoolManager lends to PoolAdmin. */
export interface PoolAdminDeps {
  baseDir: string
  /** Per-account consecutive non-authoritative auth-failure streak (in-memory). */
  authStrikes: Map<string, number>
  /** The manager's current in-memory cache. */
  getData(): AccountPoolData
  /** Persist the manager's current cache (may merge accounts from other hosts). */
  persist(): void
  /** Record an account id the pool created, so persist won't treat it as foreign. */
  markKnown(id: string): void
  /** Host keychain hook (macOS isolated accounts), injected to stay host-free. */
  ensureIsolatedKeychain(dir: string): void
  /** Pool surface used by the Argon eligibility check. */
  pool: DedicatedGroupSource
  /** The class scheduler (sticky sequential drain) that stays in the manager. */
  selectAccount(family: ModelFamily): ManagedAccount | null
}

export class PoolAdmin {
  constructor(private readonly deps: PoolAdminDeps) {}

  private account(id: string): ManagedAccount | undefined {
    return this.deps.getData().accounts.find((a) => a.id === id)
  }

  /**
   * Create an isolated staging directory for an unverified account login attempt.
   */
  createStagingSlot(): { id: string; dir: string } {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const dir = join(this.deps.baseDir, `staging_${id}`)
    mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    return { id, dir }
  }

  /**
   * Commit a successfully authenticated staging account into the pool.
   */
  commitStagingAccount(id: string, dir: string, alias?: string, email?: string, proxyUrl?: string): ManagedAccount {
    const data = this.deps.getData()
    const finalDir = join(this.deps.baseDir, id)
    try {
      if (existsSync(dir)) {
        renameSync(dir, finalDir)
      }
    } catch {
      // If rename fails, keep dir
    }
    const count = data.accounts.length + 1
    const newAccount: ManagedAccount = {
      id,
      // Defaults are canonical server data, never client-localized text.
      alias: alias?.trim() || `Backup Google account ${count}`,
      defaultAlias: !alias?.trim(),
      dir: existsSync(finalDir) ? finalDir : dir,
      ...(email ? { email } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    if (process.platform === 'darwin' && newAccount.dir) {
      this.deps.ensureIsolatedKeychain(newAccount.dir)
    }

    data.accounts.push(newAccount)
    this.deps.markKnown(newAccount.id)
    this.deps.persist()
    return newAccount
  }

  cleanupStagingSlot(dir: string): void {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup error
    }
  }

  /**
   * Remove every staging_* directory left behind by interrupted add-account
   * attempts. Staging dirs are never referenced by committed accounts, so
   * sweeping them at boot is always safe. Returns the number removed.
   */
  sweepStaleStaging(): number {
    let removed = 0
    try {
      for (const entry of readdirSync(this.deps.baseDir)) {
        if (!entry.startsWith('staging_')) continue
        rmSync(join(this.deps.baseDir, entry), { recursive: true, force: true })
        removed++
      }
    } catch {
      // Ignore sweep errors
    }
    return removed
  }

  /**
   * Create a new isolated account slot and prepare its filesystem home.
   */
  createAccountSlot(alias?: string): ManagedAccount {
    const data = this.deps.getData()
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const dir = join(this.deps.baseDir, id)
    mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    if (process.platform === 'darwin') {
      this.deps.ensureIsolatedKeychain(dir)
    }

    const count = data.accounts.length + 1
    const newAccount: ManagedAccount = {
      id,
      alias: alias?.trim() || `Backup Google account ${count}`,
      defaultAlias: !alias?.trim(),
      dir,
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    data.accounts.push(newAccount)
    this.deps.markKnown(newAccount.id)
    this.deps.persist()
    return newAccount
  }

  deleteAccount(id: string): boolean {
    const data = this.deps.getData()
    const idx = data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [removed] = data.accounts.splice(idx, 1)
    if (removed) {
      // Only ever delete directories the pool itself created under baseDir.
      // pool.json is hand-editable by design, and a hostile or typo'd `dir`
      // ("~", "/", an unrelated project folder) used to be rmSync'd
      // recursively — a data-destruction foot-gun. Out-of-base or system-HOME
      // directories are left untouched.
      const rel = removed.dir !== '' ? relative(this.deps.baseDir, removed.dir) : ''
      const contained = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      if (removed.dir && contained && !removed.systemHome && existsSync(removed.dir)) {
        try {
          rmSync(removed.dir, { recursive: true, force: true })
        } catch {
          // Ignore deletion errors
        }
      }
    }
    if (data.primaryAccountId === id) {
      // Never promote an isolated account to "primary": the primary slot is
      // reserved for the system-HOME login and is re-bootstrapped on load.
      data.primaryAccountId = undefined
    }
    if (data.lastActiveAccountId === id) {
      data.lastActiveAccountId = undefined
    }
    if (data.activeAccountIds) {
      for (const [fam, accId] of Object.entries(data.activeAccountIds)) {
        if (accId === id) delete data.activeAccountIds[fam as ModelFamily]
      }
    }
    this.deps.persist()
    return true
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    const acc = this.account(id)
    if (!acc) return false
    acc.proxyUrl = proxyUrl?.trim() ? proxyUrl.trim() : undefined
    this.deps.persist()
    return true
  }

  setAccountAlias(id: string, alias: string): boolean {
    const acc = this.account(id)
    if (!acc) return false
    acc.alias = alias.trim()
    acc.defaultAlias = false
    this.deps.persist()
    return true
  }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    const data = this.deps.getData()
    const acc = this.account(id)
    if (!acc) return false
    acc.enabled = enabled
    if (!enabled) {
      if (data.lastActiveAccountId === id) {
        data.lastActiveAccountId = undefined
      }
      if (data.activeAccountIds) {
        for (const [fam, accId] of Object.entries(data.activeAccountIds)) {
          if (accId === id) delete data.activeAccountIds[fam as ModelFamily]
        }
      }
    }
    this.deps.persist()
    return true
  }

  /**
   * Record the account a run actually spawned with. The console derives its
   * single "in use" badge from this; exactly one account runs agy at a time.
   */
  markAccountActive(id: string): void {
    const data = this.deps.getData()
    if (data.lastActiveAccountId === id) return
    data.lastActiveAccountId = id
    this.deps.persist()
  }

  /**
   * Manually pin the active slot for one family (console "设为当前使用").
   * The pin survives until the scheduler legitimately rotates away (quota
   * exhaustion / cooldown / auth flag) — getActiveAccountId still enforces
   * eligibility, so pinning an ineligible slot simply does not stick.
   */
  setActiveAccount(id: string, family: ModelFamily = 'google'): boolean {
    const data = this.deps.getData()
    const acc = this.account(id)
    if (!acc || !acc.enabled || acc.authRequired) return false
    if (!data.activeAccountIds) data.activeAccountIds = {}
    data.activeAccountIds[family] = id
    data.lastActiveAccountId = id
    this.deps.persist()
    return true
  }

  markAuthRequired(id: string, reason?: string): void {
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
   * success in between. Authoritative OAuth paths keep calling
   * markAuthRequired directly and quarantine on first sight.
   *
   * Returns true when the account is now hard-quarantined.
   */
  noteAuthFailure(id: string, reason?: string): boolean {
    const strikes = (this.deps.authStrikes.get(id) ?? 0) + 1
    if (strikes < AUTH_CONFIRM_STRIKES) {
      this.deps.authStrikes.set(id, strikes)
      return false
    }
    this.markAuthRequired(id, reason)
    return true
  }

  /**
   * External re-login detected (agy logout + new login): identity-bound
   * state from the PREVIOUS account (cooldowns, quotas, auth quarantine)
   * must not leak onto the new one. Resets everything email-bound while
   * keeping slot config (alias, dir, proxy, enabled).
   */
  resetAccountIdentity(id: string, newEmail: string): void {
    const acc = this.account(id)
    if (!acc) return
    acc.email = newEmail
    acc.cooldowns = {}
    acc.quotas = {}
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    this.deps.persist()
  }

  clearAuthRequired(id: string): void {
    const acc = this.account(id)
    if (!acc) return
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    this.deps.authStrikes.delete(id)
    this.deps.persist()
  }

  /**
   * Drop an email label that is provably wrong — e.g. an isolated account
   * whose token file was overwritten by another account's credential. The row
   * then shows its user-chosen alias instead of a foreign address.
   */
  clearAccountEmail(id: string): void {
    const acc = this.account(id)
    if (!acc) return
    delete acc.email
    this.deps.persist()
  }

  setPrimaryAccount(id: string): boolean {
    const data = this.deps.getData()
    const idx = data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [acc] = data.accounts.splice(idx, 1)
    if (!acc) return false
    acc.enabled = true
    data.primaryAccountId = id
    // Move to front of accounts list
    data.accounts.unshift(acc)
    // Make primary immediately active for all families
    data.activeAccountIds = {
      google: id,
      anthropic: id,
      openai: id,
    }
    data.lastActiveAccountId = id
    this.deps.persist()
    return true
  }

  reorderAccounts(ids: string[]): boolean {
    const data = this.deps.getData()
    const map = new Map(data.accounts.map((a) => [a.id, a]))
    const reordered: ManagedAccount[] = []
    for (const id of ids) {
      const acc = map.get(id)
      if (acc) {
        reordered.push(acc)
        map.delete(id)
      }
    }
    // Append any unmentioned accounts
    for (const remaining of map.values()) {
      reordered.push(remaining)
    }
    data.accounts = reordered
    // Clear stale sticky pointers so the user-prioritized 1st account immediately takes primary effect
    data.activeAccountIds = {}
    data.lastActiveAccountId = undefined
    this.deps.persist()
    return true
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.deps.getData().mode = mode
    this.deps.persist()
  }

  /**
   * Records a rate-limit / 429 error and sets cooldown for the requested model family.
   */
  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    const data = this.deps.getData()
    const acc = this.account(id)
    if (!acc) return
    acc.cooldowns ??= {}

    const prev = acc.cooldowns[family]
    const failures = (prev?.consecutiveFailures ?? 0) + 1

    let cooldownUntil: number
    const parsedDuration = parseResetDurationMs(serverResetTime || reason)

    if (serverResetTime && !parsedDuration) {
      const parsed = Date.parse(serverResetTime)
      if (!Number.isNaN(parsed) && parsed > Date.now()) {
        cooldownUntil = parsed + 10_000 // 10s safety buffer
      } else {
        cooldownUntil = Date.now() + Math.min(data.defaultCooldownMs * failures, data.maxCooldownMs)
      }
    } else if (parsedDuration && parsedDuration > 0) {
      // Add a 10s safety buffer to avoid hitting Google at the exact millisecond of reset
      cooldownUntil = Date.now() + parsedDuration + 10_000
    } else {
      cooldownUntil = Date.now() + Math.min(data.defaultCooldownMs * failures, data.maxCooldownMs)
    }

    acc.cooldowns[family] = {
      cooldownUntil,
      reason,
      consecutiveFailures: failures,
    }
    // If the failed account was the active one, advance to the next candidate immediately
    if (data.activeAccountIds?.[family] === id || data.lastActiveAccountId === id) {
      this.advanceAccount(id, family)
    }
    this.deps.persist()
  }

  /**
   * Records a successful run, clearing failure counter and authRequired flag for the family.
   */
  recordSuccess(id: string, family: ModelFamily): void {
    const acc = this.account(id)
    if (!acc) return
    acc.lastUsedAt = Date.now()
    if (acc.authRequired) {
      delete acc.authRequired
      delete acc.authError
      delete acc.authMarkedAt
    }
    if (acc.cooldowns?.[family]) {
      delete acc.cooldowns[family]
    }
    // A successful run is positive proof the login is alive: drop any pending
    // auth-confirmation streak so an old blip cannot harden later.
    this.deps.authStrikes.delete(id)
    this.deps.persist()
  }

  /**
   * Move the active pointer past `fromId` for one family WITHOUT cooling the
   * account down, and return the account the next run should use. Used when a
   * run produced no output at all (silent timeout): the retry must try another
   * account, but a healthy account should not be punished with a cooldown
   * because the network blipped.
   */
  advanceAccount(fromId: string, family: ModelFamily): string | null {
    const data = this.deps.getData()
    const now = Date.now()
    const candidates = data.accounts.filter(
      (a) => a.id !== fromId && isAccountEligible(a, family, now, this.deps.pool),
    )
    if (candidates.length === 0) return null
    const next = orderByExpiry(data.accounts, candidates, family, fromId, Date.now())[0]!
    if (!data.activeAccountIds) data.activeAccountIds = {}
    data.activeAccountIds[family] = next.id
    data.lastActiveAccountId = next.id
    this.deps.persist()
    return next.id
  }

  /**
   * Returns the currently active and healthy account ID.
   * If the recorded lastActiveAccountId is healthy, returns it;
   * otherwise falls back to the scheduler (selectAccount) to advance to the next
   * healthy candidate, or primaryAccountId if all are exhausted.
   */
  getActiveAccountId(family: ModelFamily = 'google'): string | undefined {
    const data = this.deps.getData()
    const now = Date.now()
    if (data.lastActiveAccountId) {
      const active = data.accounts.find((a) => a.id === data.lastActiveAccountId)
      if (active && isAccountEligible(active, family, now, this.deps.pool)) {
        return active.id
      }
    }
    const next = this.deps.selectAccount(family)
    if (next) return next.id
    const latest = this.deps.getData()
    return latest.accounts.find((a) => a.id === latest.primaryAccountId && a.enabled)?.id
      ?? latest.accounts.find((a) => a.enabled)?.id
  }
}