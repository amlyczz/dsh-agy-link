// AccountPoolManager: multi-profile credential isolation, family-scoped cooldown,
// and sticky sequential drain scheduling for Google Antigravity accounts.
//
// Persistence lives in domain/accounts/store.ts, pure selection/ordering in
// domain/accounts/selection.ts, and CRUD/admin scheduling in
// domain/accounts/admin.ts. This class owns the in-memory cache and delegates,
// keeping every public method signature unchanged.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stateDir } from '../common/config.ts'
import {
  accountHasArgon,
  argonSharesGoogleGroup,
  baseModelSlug,
  sharedArgonPeerFamily,
  type AccountPlanTier,
  type AccountPoolData,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
  type QuotaUnavailableState,
} from '../common/pool-types.ts'
import { accountCanServeModel } from './model-support.ts'
import { defaultPoolDir } from '../domain/accounts/paths.ts'
import { PoolAdmin } from '../domain/accounts/admin.ts'
import { earliestAvailableCountdown, earliestResetCountdown, sweepOldAgyLogs } from '../domain/accounts/countdown.ts'
import { PoolStore } from '../domain/accounts/store.ts'
import {
  LOW_QUOTA_5H,
  LOW_QUOTA_WEEKLY,
  explainIneligibility,
  isAccountEligible,
  isModelQuotaClear,
  isInNarrowestTier,
  orderByExpiry,
  pickEligibleAccount,
  resolveEligibleActiveAccountId,
  type AccountIneligibilityReason,
} from '../domain/accounts/selection.ts'
import { QUOTA_FAMILIES, normalizeModelFamily } from '../common/quota-bench.ts'
import { resolveAccountPlanTier } from '../common/plan-tier.ts'
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
  private readonly unsupportedModels = new Map<string, Map<string, number>>()
  private catalog?: {
    get(accountId?: string): { models?: readonly { id: string }[]; source?: string }
    getAccountCatalog?(accountId?: string): { models?: readonly { id: string }[]; source?: string } | undefined
  }
  /** True when load() had to fall back to pool.json.last-good (observable for diagnostics). */
  recoveredFromLastGood = false
  /** Callback fired whenever the active/primary account changes. */
  onAccountSwitch?: (accountId: string, family?: ModelFamily) => void

  setCatalog(catalog: {
    get(accountId?: string): { models?: readonly { id: string }[]; source?: string }
    getAccountCatalog?(accountId?: string): { models?: readonly { id: string }[]; source?: string } | undefined
  }): void {
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
      pool: this,
      selectAccount: (family, model) => this.selectAccount(family, model),
    })
    this.admin.dropModelScopedCooldowns()
  }

  catalogForAccount(accountId: string): { models?: readonly { id: string }[]; source?: string } | undefined {
    if (!this.catalog) return undefined
    if (typeof this.catalog.getAccountCatalog === 'function') {
      return this.catalog.getAccountCatalog(accountId)
    }
    return this.catalog.get(accountId)
  }

  /** Determine whether a managed account supports a specific model. */
  isModelSupported(acc: ManagedAccount, model: string): boolean {
    return accountCanServeModel(acc, model, { unsupportedModels: this.unsupportedModels, catalogFor: (id) => this.catalogForAccount(id), pool: this })
  }

  markModelUnsupported(accountId: string, model: string): void {
    const learned = this.unsupportedModels.get(accountId) ?? new Map<string, number>()
    this.unsupportedModels.set(accountId, learned)
    learned.set(baseModelSlug(model), Date.now())
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
    const now = Date.now()
    const resolvedActiveAccountIds: Partial<Record<ModelFamily, string>> = {}
    for (const fam of QUOTA_FAMILIES) {
      const resolved = resolveEligibleActiveAccountId(this.data.accounts, this.data.activeAccountIds, fam, this, now)
      if (resolved) resolvedActiveAccountIds[fam] = resolved
    }
    return {
      ...this.data,
      resolvedActiveAccountIds,
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
    // The ACP transport passes --log-file and writes per-process logs into the
    // plugin state dir; they follow the same retention window as agy's own
    // cli-*.log files, otherwise a long-lived session accumulates them forever.
    return sweepOldAgyLogs(this.data.accounts, homedir(), maxDays, Date.now(), [join(stateDir(), 'logs')])
  }

  /** Create a new isolated account slot and prepare its filesystem home. */
  createAccountSlot(alias?: string): ManagedAccount {
    return this.admin.createAccountSlot(alias)
  }

  deleteAccount(id: string): boolean {
    const wasActive = this.data.activeAccountIds?.google === id || this.data.lastActiveAccountId === id
    const ok = this.admin.deleteAccount(id)
    if (ok && wasActive) {
      const next = this.data.accounts.find((a) => a.enabled && !a.authRequired)?.id
      if (next) this.onAccountSwitch?.(next)
    }
    return ok
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    return this.admin.setAccountProxy(id, proxyUrl)
  }

  setAccountAlias(id: string, alias: string): boolean {
    return this.admin.setAccountAlias(id, alias)
  }

  setAccountPlanTier(id: string, tier: AccountPlanTier | undefined): boolean { return this.admin.setAccountPlanTier(id, tier) }

  setPlanTierOverride(id: string, tier: AccountPlanTier | undefined): boolean { return this.admin.setPlanTierOverride(id, tier) }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    const wasActive = this.data.activeAccountIds?.google === id || this.data.lastActiveAccountId === id
    const ok = this.admin.setAccountEnabled(id, enabled)
    if (ok && (!enabled ? wasActive : !this.data.lastActiveAccountId)) {
      const next = this.data.accounts.find((a) => a.enabled && !a.authRequired)?.id
      if (next) this.onAccountSwitch?.(next)
    }
    return ok
  }

  /**
   * Record the account a run actually spawned with. The console derives its
   * single "in use" badge from this; exactly one account runs agy at a time.
   */
  markAccountActive(id: string, family: ModelFamily = 'google'): void {
    this.admin.markAccountActive(id, family)
  }

  /**
   * Manually pin the active slot for one family (console "设为当前使用").
   * The pin survives until the scheduler legitimately rotates away (quota
   * exhaustion / cooldown / auth flag) — getActiveAccountId still enforces
   * eligibility, so pinning an ineligible slot simply does not stick.
   */
  setActiveAccount(id: string, family: ModelFamily = 'google'): boolean {
    const prev = this.getActiveAccountId(family)
    const ok = this.admin.setActiveAccount(id, family)
    if (ok && id !== prev) {
      this.onAccountSwitch?.(id, family)
    }
    return ok
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
  resetAccountIdentity(id: string, newEmail: string, resetAlias = false): void {
    this.admin.resetAccountIdentity(id, newEmail, resetAlias)
  }

  clearAuthRequired(id: string, force = false): void {
    this.admin.clearAuthRequired(id, force)
  }
  noteAuthReverifyAttempt(id: string): void { this.admin.noteAuthReverifyAttempt(id) }
  healAuthFlagsFromQuota(): string[] { return this.admin.healAuthFlagsFromQuota() }

  /** Drop an email label that is provably wrong (e.g. a foreign token overwrote it). */
  clearAccountEmail(id: string): void {
    this.admin.clearAccountEmail(id)
  }

  setPrimaryAccount(id: string): boolean {
    const prev = this.data.primaryAccountId
    const ok = this.admin.setPrimaryAccount(id)
    if (ok && id !== prev) {
      this.onAccountSwitch?.(id)
    }
    return ok
  }

  reorderAccounts(ids: string[]): boolean {
    const prevActive = this.getActiveAccountId('google')
    const ok = this.admin.reorderAccounts(ids)
    if (ok) {
      const nextActive = this.getActiveAccountId('google')
      if (nextActive && nextActive !== prevActive) {
        this.onAccountSwitch?.(nextActive)
      }
    }
    return ok
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.admin.setMode(mode)
  }

  /** Determine whether a managed account has confirmed access to Gemini 4 Argon. */
  accountHasArgon(acc: ManagedAccount): boolean {
    return accountHasArgon(acc, this, this.catalogForAccount(acc.id))
  }

  /**
   * Why this account cannot serve `family` right now, or null when it can.
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

  /** Record a 429 scoped to ONE model's quota bucket (e.g. the image model). */
  recordModelFailure(id: string, model: string, reason: string, serverResetTime?: string): void {
    this.admin.recordModelFailure(id, model, reason, serverResetTime)
  }

  /** Clear one model's cooldown after a successful call on it. */
  recordModelSuccess(id: string, model: string): void {
    this.admin.recordModelSuccess(id, model)
  }

  /** Returns the currently active and healthy account ID (see PoolAdmin). */
  getActiveAccountId(family: ModelFamily = 'google', model?: string): string | undefined {
    return this.admin.getActiveAccountId(family, model)
  }

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
    const nextId = this.admin.advanceAccount(fromId, family, model)
    if (nextId && nextId !== fromId) {
      this.onAccountSwitch?.(nextId, family)
    }
    return nextId
  }

  updateAccountQuotas(id: string, quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>, email?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotas = {
      ...acc.quotas,
      ...quotas,
    }
    if (email) acc.email = email

    // Heal a PERSISTED tier that the fresh evidence contradicts: an account
    // whose quota now shows a 5-hour window is not Free, and one with no Argon
    // evidence at all is not Ultra. resolveAccountPlanTier() only overrides a
    // stored tier whose defining marker is missing, so a legit Ultra detected
    // from richer CLI groups is never downgraded here.
    const healed = resolveAccountPlanTier(acc)
    if (healed !== undefined && acc.planTier !== healed) acc.planTier = healed

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
        const famPinned = this.data.activeAccountIds?.[famKey]
        const ownsFamily = famPinned === id || (famPinned === undefined && this.data.lastActiveAccountId === id)
        if (!gateCleared && ownsFamily) {
          this.advanceAccount(id, famKey)
        }
        // Folded/shared Argon pool rides the Gemini bucket when no dedicated argon row exists.
        const argonPinned = this.data.activeAccountIds?.argon
        const ownsArgon = argonPinned === id || (argonPinned === undefined && this.data.lastActiveAccountId === id)
        if (!gateCleared && famKey === 'google' && argonSharesGoogleGroup(acc) && ownsArgon) {
          this.advanceAccount(id, 'argon')
        }
      }
    }

    this.persist()
  }

  /**
   * Record that the last refresh produced no authoritative snapshot.
   *
   * Kept on the account (not just in a log line) because the console has to be
   * able to say WHY a row is frozen: a failed summary keeps the previous
   * complete value by design, so the numbers alone can never show staleness.
   */
  noteQuotaUnavailable(id: string, state: QuotaUnavailableState): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotaUnavailable = state
    this.persist()
  }

  /** Clear the marker once an authoritative snapshot arrives. */
  clearQuotaUnavailable(id: string): void {
    const acc = this.getAccount(id)
    if (!acc?.quotaUnavailable) return
    delete acc.quotaUnavailable
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
    const prev = this.data.activeAccountIds?.[family] ?? this.data.lastActiveAccountId
    this.admin.recordFailure(id, family, reason, serverResetTime)
    const next = this.data.activeAccountIds?.[family] ?? this.data.lastActiveAccountId
    if (next && next !== prev) {
      this.onAccountSwitch?.(next, family)
    }
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
    this.admin.clearCooldown(id, family, includeQuotaBench)
  }

  private syncSharedSelect(acc: ManagedAccount, family: ModelFamily, prevId?: string): boolean {
    const peer = sharedArgonPeerFamily(acc, family)
    if (!peer) return false
    const curPeer = this.data.activeAccountIds?.[peer]
    if (peer === 'argon' && curPeer && this.getAccount(curPeer)?.quotas?.argon) return false
    let changed = false
    if ((curPeer === undefined || curPeer === prevId) && this.isAccountEligible(acc, peer)) {
      this.data.activeAccountIds![peer] = acc.id
      changed = curPeer !== acc.id
    }
    if (peer === 'google' && this.data.activeAccountIds?.google === acc.id && this.data.lastActiveAccountId !== acc.id) {
      this.data.lastActiveAccountId = acc.id
      changed = true
    }
    return changed
  }

  private commitSelectedAccount(picked: ManagedAccount, family: ModelFamily, prevId?: string): void {
    if (!this.data.activeAccountIds) this.data.activeAccountIds = {}
    this.data.activeAccountIds[family] = picked.id
    if (family === 'google' || !this.data.lastActiveAccountId) this.data.lastActiveAccountId = picked.id
    this.syncSharedSelect(picked, family, prevId)
    this.persist()
    if (prevId && prevId !== picked.id) this.onAccountSwitch?.(picked.id, family)
  }

  /** Sticky Sequential Drain: keep the active account until it is unusable. */
  selectAccount(family: ModelFamily, model?: string, quotaModel?: string): ManagedAccount | null {
    const now = Date.now()
    const candidates = this.data.accounts.filter(
      (acc) =>
        this.isAccountEligibleForModel(acc, family, model, now) &&
        (quotaModel === undefined || quotaModel === '' || isModelQuotaClear(acc, family, quotaModel, now)),
    )

    if (candidates.length === 0) return null

    if (this.data.mode === 'round-robin' && candidates.length > 1) {
      // Pick least recently used candidate
      const sorted = candidates.slice().sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
      const picked = sorted[0] ?? null
      if (picked) this.commitSelectedAccount(picked, family, this.data.activeAccountIds?.[family])
      return picked
    }

    // Default 'sequential' (Sticky Sequential Drain):
    // 1. If currently active account for this family is still healthy and has quota, STICK WITH IT!
    const activeId = this.data.activeAccountIds?.[family]
    if (activeId) {
      const activeCandidate = candidates.find((a) => a.id === activeId)
      // Stick only while no narrower account could serve this model instead.
      if (activeCandidate && isInNarrowestTier(activeCandidate, candidates, family)) {
        const peerMoved = this.syncSharedSelect(activeCandidate, family, activeId)
        const needLast = (family === 'google' || !this.data.lastActiveAccountId) && this.data.lastActiveAccountId !== activeCandidate.id
        if (needLast || peerMoved) {
          if (needLast) this.data.lastActiveAccountId = activeCandidate.id
          this.persist()
        }
        return activeCandidate
      }
    }

    // 2. Active account is drained or unavailable -> rotate to the eligible
    //    account whose quota expires SOONEST (Priority 1: weekly quota expiry,
    //    Priority 2: 5h quota expiry, Priority 3: pool order).
    const nextAccount: ManagedAccount = this.orderByExpiry(candidates, family, activeId)[0]!
    this.commitSelectedAccount(nextAccount, family, activeId)
    return nextAccount
  }

  /** Pick an eligible account WITHOUT mutating the active pointer (image rotation). */
  findAccount(family: ModelFamily, model?: string, quotaModel?: string, avoid?: readonly string[]): ManagedAccount | null {
    return pickEligibleAccount(this.data.accounts, this, {
      family,
      ...(model === undefined ? {} : { model }),
      ...(quotaModel === undefined ? {} : { quotaModel }),
      ...(avoid === undefined ? {} : { avoid }),
      ...(this.data.activeAccountIds?.[family] === undefined ? {} : { activeId: this.data.activeAccountIds[family] }),
      now: Date.now(),
    })
  }

  /** Get countdown in milliseconds until the earliest account in cooldown resets. */
  getEarliestResetCountdown(family: ModelFamily): number | null {
    return earliestResetCountdown(this.data.accounts, family)
  }

  /** Earliest moment ANY enabled account can serve `family` again. */
  getEarliestAvailableCountdown(family: ModelFamily): number | null {
    return earliestAvailableCountdown(this.data.accounts, family)
  }
}