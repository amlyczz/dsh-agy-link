// AccountPoolManager: multi-profile credential isolation, family-scoped cooldown,
// and sticky sequential drain scheduling for Google Antigravity accounts.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { homedir } from 'node:os'
import {
  AUTH_CONFIRM_STRIKES,
  accountHasArgon,
  isArgonModel,
  modelFamilyOf,
  type AccountPoolData,
  type FamilyCooldownState,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import { parseResetDurationMs } from '../common/types.ts'
import { defaultPoolDir } from '../domain/accounts/paths.ts'
import { PoolStore } from '../domain/accounts/store.ts'
import {
  LOW_QUOTA_5H,
  LOW_QUOTA_WEEKLY,
  cyclicDistance,
  explainIneligibility,
  isAccountEligible,
  isQuotaBenched,
  nextQuotaResetAt,
  orderByExpiry,
  type AccountIneligibilityReason,
} from '../domain/accounts/selection.ts'
import { detectSystemProxy } from './wincred.ts'
import { ensureIsolatedKeychain } from './runner.ts'

export { defaultPoolDir } from '../domain/accounts/paths.ts'
// Re-exported so the public surface of this module is unchanged: these used to
// be defined here and are still reachable from `src/host/pool.ts`.
export { LOW_QUOTA_5H, LOW_QUOTA_WEEKLY }
export type { AccountIneligibilityReason }

export class AccountPoolManager {
  private data: AccountPoolData
  private readonly baseDir: string
  /** Durable pool.json persistence (load/merge/atomic-write); owns the file bookkeeping. */
  private readonly store: PoolStore

  /**
   * Consecutive non-authoritative auth failures per account id (noteAuthFailure).
   * Deliberately in-memory: losing the streak on restart only costs one extra
   * confirmation round, while persisting it could quarantine an account for a
   * blip that healed while the process was down.
   */
  private readonly authStrikes = new Map<string, number>()
  /** True when load() had to fall back to pool.json.last-good (observable for diagnostics). */
  recoveredFromLastGood = false

  constructor(baseDir = defaultPoolDir()) {
    this.baseDir = baseDir
    this.store = new PoolStore(baseDir)
    const loaded = this.store.load()
    this.data = loaded.data
    this.recoveredFromLastGood = loaded.recoveredFromLastGood
    this.data = this.store.bootstrapDefaultAccount(this.data, detectSystemProxy)
    this.data = this.store.normalizeLegacyPrimary(this.data)
    this.store.snapshot(this.data)
    for (const acc of this.data.accounts) this.store.markKnown(acc.id)
  }

  /**
   * Directory holding `pool.json` and the durable primary credential. Exposed
   * so credential handling is anchored on the pool actually in use instead of
   * a hidden process-global path (which made tests write to the real pool).
   */
  get dir(): string {
    return this.baseDir
  }

  private persist(): void {
    this.data = this.store.persist(this.data)
  }

  getPoolData(defaultProxy?: string): Readonly<AccountPoolData> {
    const sysProxy = defaultProxy || detectSystemProxy()
    return {
      ...this.data,
      activeAccountId: this.getActiveAccountId('google'),
      ...(sysProxy ? { systemProxy: sysProxy } : {}),
    }
  }

  getAccounts(): readonly ManagedAccount[] {
    return this.data.accounts
  }

  getAccount(id: string): ManagedAccount | undefined {
    return this.data.accounts.find((a) => a.id === id)
  }

  /**
   * Create an isolated staging directory for an unverified account login attempt.
   */
  createStagingSlot(): { id: string; dir: string } {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const dir = join(this.baseDir, `staging_${id}`)
    mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    return { id, dir }
  }

  /**
   * Commit a successfully authenticated staging account into the pool.
   */
  commitStagingAccount(id: string, dir: string, alias?: string, email?: string, proxyUrl?: string): ManagedAccount {
    const finalDir = join(this.baseDir, id)
    try {
      if (existsSync(dir)) {
        renameSync(dir, finalDir)
      }
    } catch {
      // If rename fails, keep dir
    }
    const count = this.data.accounts.length + 1
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
      ensureIsolatedKeychain(newAccount.dir)
    }

    this.data.accounts.push(newAccount)
    this.store.markKnown(newAccount.id)
    this.persist()
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
      for (const entry of readdirSync(this.baseDir)) {
        if (!entry.startsWith('staging_')) continue
        rmSync(join(this.baseDir, entry), { recursive: true, force: true })
        removed++
      }
    } catch {
      // Ignore sweep errors
    }
    return removed
  }

  /**
   * Sweep agy CLI log files older than maxDays (default: 7) across all managed account directories
   * as well as the primary system ~/.gemini/antigravity-cli/log directory.
   */
  sweepOldLogs(maxDays = 7): number {
    const maxAgeMs = Math.max(1, maxDays) * 86_400_000
    const now = Date.now()
    let removed = 0

    const targetLogDirs = [
      join(homedir(), '.gemini', 'antigravity-cli', 'log'),
    ]

    for (const acc of this.data.accounts) {
      if (acc.dir) {
        targetLogDirs.push(join(acc.dir, '.gemini', 'antigravity-cli', 'log'))
      }
    }

    for (const logDir of targetLogDirs) {
      if (!existsSync(logDir)) continue
      try {
        const files = readdirSync(logDir)
        for (const f of files) {
          if (!f.startsWith('cli-') || !f.endsWith('.log')) continue
          const fp = join(logDir, f)
          try {
            const st = statSync(fp)
            if (now - st.mtimeMs > maxAgeMs) {
              rmSync(fp, { force: true })
              removed++
            }
          } catch {
            // Ignore file error
          }
        }
      } catch {
        // Ignore dir error
      }
    }

    return removed
  }

  /**
   * Create a new isolated account slot and prepare its filesystem home.
   */
  createAccountSlot(alias?: string): ManagedAccount {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const dir = join(this.baseDir, id)
    mkdirSync(join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    if (process.platform === 'darwin') {
      ensureIsolatedKeychain(dir)
    }

    const count = this.data.accounts.length + 1
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

    this.data.accounts.push(newAccount)
    this.store.markKnown(newAccount.id)
    this.persist()
    return newAccount
  }

  deleteAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [removed] = this.data.accounts.splice(idx, 1)
    if (removed) {
      // Only ever delete directories the pool itself created under baseDir.
      // pool.json is hand-editable by design, and a hostile or typo'd `dir`
      // ("~", "/", an unrelated project folder) used to be rmSync'd
      // recursively — a data-destruction foot-gun. Out-of-base or system-HOME
      // directories are left untouched.
      const rel = removed.dir !== '' ? relative(this.baseDir, removed.dir) : ''
      const contained = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      if (removed.dir && contained && !removed.systemHome && existsSync(removed.dir)) {
        try {
          rmSync(removed.dir, { recursive: true, force: true })
        } catch {
          // Ignore deletion errors
        }
      }
    }
    if (this.data.primaryAccountId === id) {
      // Never promote an isolated account to "primary": the primary slot is
      // reserved for the system-HOME login and is re-bootstrapped on load.
      this.data.primaryAccountId = undefined
    }
    if (this.data.lastActiveAccountId === id) {
      this.data.lastActiveAccountId = undefined
    }
    if (this.data.activeAccountIds) {
      for (const [fam, accId] of Object.entries(this.data.activeAccountIds)) {
        if (accId === id) delete this.data.activeAccountIds[fam as ModelFamily]
      }
    }
    this.persist()
    return true
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    acc.proxyUrl = proxyUrl?.trim() ? proxyUrl.trim() : undefined
    this.persist()
    return true
  }

  setAccountAlias(id: string, alias: string): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    acc.alias = alias.trim()
    acc.defaultAlias = false
    this.persist()
    return true
  }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    acc.enabled = enabled
    if (!enabled) {
      if (this.data.lastActiveAccountId === id) {
        this.data.lastActiveAccountId = undefined
      }
      if (this.data.activeAccountIds) {
        for (const [fam, accId] of Object.entries(this.data.activeAccountIds)) {
          if (accId === id) delete this.data.activeAccountIds[fam as ModelFamily]
        }
      }
    }
    this.persist()
    return true
  }

  /**
   * Record the account a run actually spawned with. The console derives its
   * single "in use" badge from this; exactly one account runs agy at a time.
   */
  markAccountActive(id: string): void {
    if (this.data.lastActiveAccountId === id) return
    this.data.lastActiveAccountId = id
    this.persist()
  }

  /**
   * Manually pin the active slot for one family (console "设为当前使用").
   * The pin survives until the scheduler legitimately rotates away (quota
   * exhaustion / cooldown / auth flag) — getActiveAccountId still enforces
   * eligibility, so pinning an ineligible slot simply does not stick.
   */
  setActiveAccount(id: string, family: ModelFamily = 'google'): boolean {
    const acc = this.getAccount(id)
    if (!acc || !acc.enabled || acc.authRequired) return false
    if (!this.data.activeAccountIds) this.data.activeAccountIds = {}
    this.data.activeAccountIds[family] = id
    this.data.lastActiveAccountId = id
    this.persist()
    return true
  }

  markAuthRequired(id: string, reason?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.authRequired = true
    acc.authMarkedAt = Date.now()
    acc.authError = reason || 'Authentication expired or revoked (invalid_grant)'
    if (this.data.lastActiveAccountId === id) {
      this.data.lastActiveAccountId = undefined
    }
    if (this.data.activeAccountIds) {
      for (const [fam, accId] of Object.entries(this.data.activeAccountIds)) {
        if (accId === id) delete this.data.activeAccountIds[fam as ModelFamily]
      }
    }
    this.authStrikes.delete(id)
    this.persist()
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
    const strikes = (this.authStrikes.get(id) ?? 0) + 1
    if (strikes < AUTH_CONFIRM_STRIKES) {
      this.authStrikes.set(id, strikes)
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
    const acc = this.getAccount(id)
    if (!acc) return
    acc.email = newEmail
    acc.cooldowns = {}
    acc.quotas = {}
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    this.persist()
  }

  clearAuthRequired(id: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    this.authStrikes.delete(id)
    this.persist()
  }

  /**
   * Drop an email label that is provably wrong — e.g. an isolated account
   * whose token file was overwritten by another account's credential. The row
   * then shows its user-chosen alias instead of a foreign address.
   */
  clearAccountEmail(id: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    delete acc.email
    this.persist()
  }

  setPrimaryAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [acc] = this.data.accounts.splice(idx, 1)
    if (!acc) return false
    acc.enabled = true
    this.data.primaryAccountId = id
    // Move to front of accounts list
    this.data.accounts.unshift(acc)
    // Make primary immediately active for all families
    this.data.activeAccountIds = {
      google: id,
      anthropic: id,
      openai: id,
    }
    this.data.lastActiveAccountId = id
    this.persist()
    return true
  }

  reorderAccounts(ids: string[]): boolean {
    const map = new Map(this.data.accounts.map((a) => [a.id, a]))
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
    this.data.accounts = reordered
    // Clear stale sticky pointers so the user-prioritized 1st account immediately takes primary effect
    this.data.activeAccountIds = {}
    this.data.lastActiveAccountId = undefined
    this.persist()
    return true
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.data.mode = mode
    this.persist()
  }

  /**
   * True when a family's cached quota snapshot benches the account.
   *
   * A user-visible `clearCooldown(..., includeQuotaBench = true)` records the
   * `updatedAt` of the snapshot it overrode; the gate stays off only while the
   * cached row is no newer than that stamp, so a fresh poll always re-arms it.
   */
  private isQuotaBenched(acc: ManagedAccount, family: ModelFamily, now: number): boolean {
    return isQuotaBenched(acc, family, now)
  }

  /** Determine whether a managed account has confirmed access to Gemini 4 Argon. */
  accountHasArgon(acc: ManagedAccount): boolean {
    return accountHasArgon(acc, this)
  }

  /**
   * Why this account cannot serve `family` right now, or null when it can.
   *
   * Exists so callers can report the ACTUAL blocker: quota rotation used to be
   * folded into "in cooldown", which pointed users at `/agy clear-cooldown` for
   * a state that command did not touch.
   */
  explainIneligibility(
    acc: ManagedAccount,
    family: ModelFamily,
    now = Date.now(),
  ): AccountIneligibilityReason | null {
    return explainIneligibility(acc, family, now, this)
  }

  /**
   * Check whether an account is eligible to serve requests for the given family.
   */
  isAccountEligible(acc: ManagedAccount, family: ModelFamily, now = Date.now()): boolean {
    return isAccountEligible(acc, family, now, this)
  }

  /**
   * Returns the currently active and healthy account ID.
   * If the recorded lastActiveAccountId is healthy, returns it;
   * otherwise falls back to selectAccount(family) to advance to the next healthy candidate,
   * or primaryAccountId if all are exhausted.
   */
  getActiveAccountId(family: ModelFamily = 'google'): string | undefined {
    const now = Date.now()
    if (this.data.lastActiveAccountId) {
      const active = this.getAccount(this.data.lastActiveAccountId)
      if (active && this.isAccountEligible(active, family, now)) {
        return active.id
      }
    }
    const next = this.selectAccount(family)
    if (next) return next.id
    return this.data.accounts.find((a) => a.id === this.data.primaryAccountId && a.enabled)?.id
      ?? this.data.accounts.find((a) => a.enabled)?.id
  }

  /**
   * Next moment this account's quota state refreshes for one family: the
   * sooner of the 5h window reset and the weekly cap reset. NaN when unknown.
   */
  private nextQuotaResetAt(acc: ManagedAccount, family: ModelFamily): number {
    return nextQuotaResetAt(acc, family)
  }

  /** Cyclic distance from `fromId` (0 = itself), so ties keep pool order. */
  private cyclicDistance(fromId: string | undefined, id: string): number {
    return cyclicDistance(this.data.accounts, fromId, id)
  }

  /**
   * "Use it or lose it" rotation order.
   * Priority 1: Weekly quota expiring soonest (least remaining time until weeklyResetTime).
   * Priority 2: 5-hour quota expiring soonest (least remaining time until resetTime).
   * Priority 3: Cyclic distance from `fromId` (or pool order).
   */
  private orderByExpiry(
    candidates: readonly ManagedAccount[],
    family: ModelFamily,
    fromId?: string,
  ): ManagedAccount[] {
    return orderByExpiry(this.data.accounts, candidates, family, fromId, Date.now())
  }

  /**
   * Move the active pointer past `fromId` for one family WITHOUT cooling the
   * account down, and return the account the next run should use. Used when a
   * run produced no output at all (silent timeout): the retry must try another
   * account, but a healthy account should not be punished with a cooldown
   * because the network blipped.
   */
  advanceAccount(fromId: string, family: ModelFamily): string | null {
    const now = Date.now()
    const candidates = this.data.accounts.filter(
      (a) => a.id !== fromId && this.isAccountEligible(a, family, now),
    )
    if (candidates.length === 0) return null
    const next = this.orderByExpiry(candidates, family, fromId)[0]!
    if (!this.data.activeAccountIds) this.data.activeAccountIds = {}
    this.data.activeAccountIds[family] = next.id
    this.data.lastActiveAccountId = next.id
    this.persist()
    return next.id
  }

  updateAccountQuotas(id: string, quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>, email?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotas = {
      ...acc.quotas,
      ...quotas,
    }
    if (email) acc.email = email

    // If an updated family has exhausted its quota, proactively advance to the next account
    const now = Date.now()
    for (const [famKey, info] of Object.entries(quotas) as [ModelFamily, FamilyQuotaInfo][]) {
      if (!info) continue
      const isExhausted5h = typeof info.remainingFraction === 'number' && info.remainingFraction <= LOW_QUOTA_5H &&
        (!info.resetTime || Number.isNaN(Date.parse(info.resetTime)) || Date.parse(info.resetTime) > now)
      const isExhaustedWeekly = typeof info.weeklyFraction === 'number' && info.weeklyFraction <= LOW_QUOTA_WEEKLY &&
        (!info.weeklyResetTime || Number.isNaN(Date.parse(info.weeklyResetTime)) || Date.parse(info.weeklyResetTime) > now)
      if (isExhausted5h || isExhaustedWeekly) {
        // A snapshot the user already overrode must not rotate the pool: the
        // override is only meant to bridge the gap until fresher data arrives.
        const clearedAt = acc.quotaGateClearedAt?.[famKey]
        const gateCleared = clearedAt !== undefined && (info.updatedAt ?? 0) <= clearedAt
        if (!gateCleared && (this.data.activeAccountIds?.[famKey] === id || this.data.lastActiveAccountId === id)) {
          this.advanceAccount(id, famKey)
        }
      }
    }

    this.persist()
  }

  /**
   * Drop one family's quota row.
   *
   * Used when stored numbers provably cannot be attributed to this account —
   * `updateAccountQuotas` only merges, so an untrustworthy row would otherwise
   * survive every refresh.
   */
  clearQuotaFamily(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc?.quotas || acc.quotas[family] === undefined) return
    delete acc.quotas[family]
    this.persist()
  }

  /**
   * Records a rate-limit / 429 error and sets cooldown for the requested model family.
   */
  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    const acc = this.getAccount(id)
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
        cooldownUntil = Date.now() + Math.min(this.data.defaultCooldownMs * failures, this.data.maxCooldownMs)
      }
    } else if (parsedDuration && parsedDuration > 0) {
      // Add a 10s safety buffer to avoid hitting Google at the exact millisecond of reset
      cooldownUntil = Date.now() + parsedDuration + 10_000
    } else {
      cooldownUntil = Date.now() + Math.min(this.data.defaultCooldownMs * failures, this.data.maxCooldownMs)
    }

    acc.cooldowns[family] = {
      cooldownUntil,
      reason,
      consecutiveFailures: failures,
    }
    // If the failed account was the active one, advance to the next candidate immediately
    if (this.data.activeAccountIds?.[family] === id || this.data.lastActiveAccountId === id) {
      this.advanceAccount(id, family)
    }
    this.persist()
  }

  /**
   * Records a successful run, clearing failure counter and authRequired flag for the family.
   */
  recordSuccess(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
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
    this.authStrikes.delete(id)
    this.persist()
  }

  /** True when this account has reported a dedicated quota group for `family`. */
  hasDedicatedGroup(id: string, family: ModelFamily): boolean {
    return this.getAccount(id)?.dedicatedGroups?.includes(family) === true
  }

  /**
   * Remember that `family` has its own quota group on this account.
   * Persists only on an actual change so a steady-state poll stays write-free.
   */
  noteDedicatedGroup(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc) return
    if (acc.dedicatedGroups?.includes(family)) return
    acc.dedicatedGroups = [...(acc.dedicatedGroups ?? []), family]
    this.persist()
  }

  /** Forget a family's dedicated group after it stopped being reported. */
  forgetDedicatedGroup(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc?.dedicatedGroups?.includes(family)) return
    acc.dedicatedGroups = acc.dedicatedGroups.filter((f) => f !== family)
    this.persist()
  }

  /**
   * Reset cooldown timers.
   *
   * `includeQuotaBench` (set by the user-facing `/agy clear-cooldown` command
   * and its HTTP twin) ALSO lifts the proactive low-quota rotation for the
   * cached snapshot. The override records that snapshot's `updatedAt`, so the
   * safety gate re-arms as soon as a poll produces fresher data. Internal
   * callers (orphan release, CLI quota cleanup) leave it off: they only mean to
   * drop a 429 timer.
   */
  clearCooldown(id?: string, family?: ModelFamily, includeQuotaBench = false): void {
    const now = Date.now()
    const clearOne = (acc: ManagedAccount): void => {
      acc.cooldowns ??= {}
      if (family) delete acc.cooldowns[family]
      else acc.cooldowns = {}
      if (!includeQuotaBench) return
      const families = family ? [family] : (Object.keys(acc.quotas ?? {}) as ModelFamily[])
      if (families.length === 0) return
      acc.quotaGateClearedAt ??= {}
      for (const fam of families) {
        const updatedAt = acc.quotas?.[fam]?.updatedAt
        acc.quotaGateClearedAt[fam] = Math.max(now, updatedAt ?? 0)
      }
    }
    if (id) {
      const acc = this.getAccount(id)
      if (!acc) return
      clearOne(acc)
    } else {
      for (const acc of this.data.accounts) clearOne(acc)
    }
    this.persist()
  }

  /**
   * Core scheduling algorithm: Sticky Sequential Drain.
   * Sticks to the current active account until it runs out of quota/rate-limited,
   * then smoothly advances to the next available account in cyclic order.
   */
  selectAccount(family: ModelFamily): ManagedAccount | null {
    const now = Date.now()
    const candidates = this.data.accounts.filter((acc) => this.isAccountEligible(acc, family, now))

    if (candidates.length === 0) return null

    if (this.data.mode === 'round-robin' && candidates.length > 1) {
      // Pick least recently used candidate
      const sorted = candidates.slice().sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
      const picked = sorted[0] ?? null
      if (picked) {
        if (!this.data.activeAccountIds) this.data.activeAccountIds = {}
        this.data.activeAccountIds[family] = picked.id
        this.data.lastActiveAccountId = picked.id
        this.persist()
      }
      return picked
    }

    // Default 'sequential' (Sticky Sequential Drain):
    // 1. If currently active account for this family is still healthy and has quota, STICK WITH IT!
    const activeId = this.data.activeAccountIds?.[family]
    if (activeId) {
      const activeCandidate = candidates.find((a) => a.id === activeId)
      if (activeCandidate) {
        if (this.data.lastActiveAccountId !== activeCandidate.id) {
          this.data.lastActiveAccountId = activeCandidate.id
          this.persist()
        }
        return activeCandidate
      }
    }

    // 2. Active account is drained or unavailable -> rotate to the eligible
    //    account whose quota expires SOONEST (Priority 1: weekly quota expiry,
    //    Priority 2: 5h quota expiry, Priority 3: pool order).
    const nextAccount: ManagedAccount = this.orderByExpiry(candidates, family, activeId)[0]!

    if (!this.data.activeAccountIds) this.data.activeAccountIds = {}
    this.data.activeAccountIds[family] = nextAccount.id
    this.data.lastActiveAccountId = nextAccount.id
    this.persist()
    return nextAccount
  }

  /**
   * Get countdown in milliseconds until the earliest account in cooldown resets.
   */
  getEarliestResetCountdown(family: ModelFamily): number | null {
    const now = Date.now()
    let earliest: number | null = null
    for (const acc of this.data.accounts) {
      if (!acc.enabled) continue
      const cd = acc.cooldowns?.[family]
      if (cd && cd.cooldownUntil > now) {
        if (earliest === null || cd.cooldownUntil < earliest) {
          earliest = cd.cooldownUntil
        }
      }
    }
    return earliest !== null ? Math.max(0, earliest - now) : null
  }

  /**
   * Earliest moment ANY enabled account could serve `family` again: the sooner
   * of a cooldown expiry and a quota-window reset.
   *
   * `getEarliestResetCountdown` only inspects cooldowns, while an account can
   * be excluded by its remaining 5h/weekly fraction (isAccountEligible) — so a
   * fully quota-drained pool reported NO wait at all ("Add an account or wait
   * for reset") even though every account knew exactly when it resets. Signed
   * out and disabled accounts are skipped: no countdown can fix them.
   */
  getEarliestAvailableCountdown(family: ModelFamily): number | null {
    const now = Date.now()
    let earliest: number | null = null
    const bump = (at: number | null): void => {
      if (at === null || Number.isNaN(at) || at <= now) return
      if (earliest === null || at < earliest) earliest = at
    }
    for (const acc of this.data.accounts) {
      if (!acc.enabled || acc.authRequired) continue
      const cd = acc.cooldowns?.[family]
      if (cd && cd.cooldownUntil > now) bump(cd.cooldownUntil)
      const quota = acc.quotas?.[family]
      if (quota === undefined) continue
      // An overridden snapshot has no enforceable reset yet: the gate is off
      // until a poll writes fresher data.
      const clearedAt = acc.quotaGateClearedAt?.[family]
      if (clearedAt !== undefined && (quota.updatedAt ?? 0) <= clearedAt) continue
      const drained5h = typeof quota.remainingFraction === 'number' && quota.remainingFraction <= LOW_QUOTA_5H
        && typeof quota.resetTime === 'string' && Date.parse(quota.resetTime) > now
      const drainedWeekly = typeof quota.weeklyFraction === 'number' && quota.weeklyFraction <= LOW_QUOTA_WEEKLY
        && typeof quota.weeklyResetTime === 'string' && Date.parse(quota.weeklyResetTime) > now
      if (drained5h || drainedWeekly) bump(this.nextQuotaResetAt(acc, family))
    }
    return earliest !== null ? Math.max(0, (earliest as number) - now) : null
  }
}
