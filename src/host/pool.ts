// AccountPoolManager: multi-profile credential isolation, family-scoped cooldown,
// and sticky sequential drain scheduling for Google Antigravity accounts.
//
// Persistence lives in domain/accounts/store.ts, pure selection/ordering in
// domain/accounts/selection.ts, and CRUD/admin scheduling in
// domain/accounts/admin.ts. This class owns the in-memory cache and delegates,
// keeping every public method signature unchanged.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  accountHasArgon,
  accountSupportsModel,
  baseModelSlug,
  type AccountPoolData,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import { defaultPoolDir } from '../domain/accounts/paths.ts'
import { PoolAdmin } from '../domain/accounts/admin.ts'
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
  /** CRUD/admin scheduling over the cache, persisted through `store`. */
  private readonly admin: PoolAdmin

  /**
   * Consecutive non-authoritative auth failures per account id (noteAuthFailure).
   * Deliberately in-memory: losing the streak on restart only costs one extra
   * confirmation round, while persisting it could quarantine an account for a
   * blip that healed while the process was down.
   */
  private readonly authStrikes = new Map<string, number>()
  private readonly unsupportedModels = new Map<string, Set<string>>()
  private catalog?: { get(accountId?: string): { models?: readonly { id: string }[]; source?: string } }
  /** True when load() had to fall back to pool.json.last-good (observable for diagnostics). */
  recoveredFromLastGood = false

  setCatalog(catalog: { get(accountId?: string): { models?: readonly { id: string }[]; source?: string } }): void {
    this.catalog = catalog
  }

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
    this.admin = new PoolAdmin({
      baseDir,
      authStrikes: this.authStrikes,
      getData: () => this.data,
      persist: () => this.persist(),
      markKnown: (id) => this.store.markKnown(id),
      ensureIsolatedKeychain,
      pool: {
        hasDedicatedGroup: (id, family) => this.hasDedicatedGroup(id, family),
        isModelSupported: (acc: ManagedAccount, model: string) => this.isModelSupported(acc, model),
      },
      selectAccount: (family, model) => this.selectAccount(family, model),
    })
  }

  /** Determine whether a managed account supports a specific model. */
  isModelSupported(acc: ManagedAccount, model: string): boolean {
    if (this.unsupportedModels.get(acc.id)?.has(baseModelSlug(model))) {
      return false
    }
    const cat = this.catalog?.get(acc.id)
    return accountSupportsModel(acc, model, this, cat)
  }

  markModelUnsupported(accountId: string, model: string): void {
    let set = this.unsupportedModels.get(accountId)
    if (!set) {
      set = new Set()
      this.unsupportedModels.set(accountId, set)
    }
    set.add(baseModelSlug(model))
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

  /** Create an isolated staging directory for an unverified account login attempt. */
  createStagingSlot(): { id: string; dir: string } {
    return this.admin.createStagingSlot()
  }

  /** Commit a successfully authenticated staging account into the pool. */
  commitStagingAccount(id: string, dir: string, alias?: string, email?: string, proxyUrl?: string): ManagedAccount {
    return this.admin.commitStagingAccount(id, dir, alias, email, proxyUrl)
  }

  cleanupStagingSlot(dir: string): void {
    this.admin.cleanupStagingSlot(dir)
  }

  /** Remove every staging_* directory left behind by interrupted add-account attempts. */
  sweepStaleStaging(): number {
    return this.admin.sweepStaleStaging()
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

  /** Create a new isolated account slot and prepare its filesystem home. */
  createAccountSlot(alias?: string): ManagedAccount {
    return this.admin.createAccountSlot(alias)
  }

  deleteAccount(id: string): boolean {
    return this.admin.deleteAccount(id)
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    return this.admin.setAccountProxy(id, proxyUrl)
  }

  setAccountAlias(id: string, alias: string): boolean {
    return this.admin.setAccountAlias(id, alias)
  }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    return this.admin.setAccountEnabled(id, enabled)
  }

  /**
   * Record the account a run actually spawned with. The console derives its
   * single "in use" badge from this; exactly one account runs agy at a time.
   */
  markAccountActive(id: string): void {
    this.admin.markAccountActive(id)
  }

  /**
   * Manually pin the active slot for one family (console "设为当前使用").
   * The pin survives until the scheduler legitimately rotates away (quota
   * exhaustion / cooldown / auth flag) — getActiveAccountId still enforces
   * eligibility, so pinning an ineligible slot simply does not stick.
   */
  setActiveAccount(id: string, family: ModelFamily = 'google'): boolean {
    return this.admin.setActiveAccount(id, family)
  }

  markAuthRequired(id: string, reason?: string): void {
    this.admin.markAuthRequired(id, reason)
  }

  /**
   * Confirmation-gated quarantine for auth-classified failures that carry NO
   * authoritative evidence (no invalid_grant / revoked / unauthorized_client).
   * Returns true when the account is now hard-quarantined.
   */
  noteAuthFailure(id: string, reason?: string): boolean {
    return this.admin.noteAuthFailure(id, reason)
  }

  /**
   * External re-login detected (agy logout + new login): identity-bound state
   * from the PREVIOUS account must not leak onto the new one.
   */
  resetAccountIdentity(id: string, newEmail: string): void {
    this.admin.resetAccountIdentity(id, newEmail)
  }

  clearAuthRequired(id: string): void {
    this.admin.clearAuthRequired(id)
  }

  /** Drop an email label that is provably wrong (e.g. a foreign token overwrote it). */
  clearAccountEmail(id: string): void {
    this.admin.clearAccountEmail(id)
  }

  setPrimaryAccount(id: string): boolean {
    return this.admin.setPrimaryAccount(id)
  }

  reorderAccounts(ids: string[]): boolean {
    return this.admin.reorderAccounts(ids)
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.admin.setMode(mode)
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
    model?: string,
  ): AccountIneligibilityReason | null {
    return explainIneligibility(acc, family, now, this, model)
  }

  /** Check whether an account is eligible to serve requests for the given family. */
  isAccountEligible(acc: ManagedAccount, family: ModelFamily, now = Date.now()): boolean {
    return isAccountEligible(acc, family, now, this)
  }

  /** Check whether an account is eligible to serve requests for the given family and model. */
  isAccountEligibleForModel(acc: ManagedAccount, family: ModelFamily, model?: string, now = Date.now()): boolean {
    return this.explainIneligibility(acc, family, now, model) === null
  }

  /** Returns the currently active and healthy account ID (see PoolAdmin). */
  getActiveAccountId(family: ModelFamily = 'google', model?: string): string | undefined {
    return this.admin.getActiveAccountId(family, model)
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
   * account down, and return the account the next run should use (see PoolAdmin).
   */
  advanceAccount(fromId: string, family: ModelFamily, model?: string): string | null {
    return this.admin.advanceAccount(fromId, family, model)
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

  /** Records a rate-limit / 429 error and sets cooldown for the requested model family. */
  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    this.admin.recordFailure(id, family, reason, serverResetTime)
  }

  /** Records a successful run, clearing failure counter and authRequired flag for the family. */
  recordSuccess(id: string, family: ModelFamily): void {
    this.admin.recordSuccess(id, family)
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
  selectAccount(family: ModelFamily, model?: string): ManagedAccount | null {
    const now = Date.now()
    const candidates = this.data.accounts.filter((acc) => this.isAccountEligibleForModel(acc, family, model, now))

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

  /** Get countdown in milliseconds until the earliest account in cooldown resets. */
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