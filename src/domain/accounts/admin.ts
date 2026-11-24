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
  argonSharesGoogleGroup,
  effectiveFamilyCooldown,
  isTerminalAuthError,
  sharedArgonPeerFamily,
  type AccountPlanTier,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import { normalizeModelFamily } from '../../common/quota-bench.ts'
import { applyModelFailure, clearModelCooldown, cooldownUntilFor, dropLegacyModelScopedFamilyCooldowns } from './model-cooldown.ts'
import { isModelScopedQuotaFailure, parseResetDurationMs } from '../../common/types.ts'
import { isAccountEligible, orderByExpiry, type DedicatedGroupSource } from './selection.ts'
import { AccountAuthFlags } from './auth-state.ts'

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
  selectAccount(family: ModelFamily, model?: string): ManagedAccount | null
}

export class PoolAdmin {
  /** 需重新登录 flag lifecycle (mark / confirm / clear / heal / back-off). */
  private readonly authFlags: AccountAuthFlags

  constructor(private readonly deps: PoolAdminDeps) {
    this.authFlags = new AccountAuthFlags(this.deps)
  }

  private account(id: string): ManagedAccount | undefined {
    return this.deps.getData().accounts.find((a) => a.id === id)
  }

  private canSyncSharedPeer(data: AccountPoolData, acc: ManagedAccount | undefined, fam: ModelFamily): ModelFamily | undefined {
    const peer = sharedArgonPeerFamily(acc, fam)
    if (!peer) return undefined
    return peer === 'argon' && data.activeAccountIds?.argon && this.account(data.activeAccountIds.argon)?.quotas?.argon ? undefined : peer
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

  setAccountPlanTier(id: string, tier: AccountPlanTier | undefined): boolean {
    const acc = this.account(id)
    if (!acc) return false
    if (acc.planTier === tier) return true
    if (tier === undefined || tier === 'unknown') delete acc.planTier
    else acc.planTier = tier
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
   * Record the account a run ACTUALLY used, scoped to its model family.
   *
   * Family-scoped on purpose: the console's per-family "当前使用" badge must
   * describe reality, and an Argon turn on account X must not rewrite the
   * Gemini pointer (or the global `lastActiveAccountId`). Before this, an
   * unpinned family showed a *predicted* account as "in use" while the live
   * session ran somewhere else (reported 2026-11-23: Argon row claimed the
   * primary while the header showed the account really serving the turn).
   * Deliberately does NOT stamp `manualPinAtByFamily` — runtime use is not a
   * user pin, so an explicit pin still wins the tie-break in stickyAccount().
   */
  markAccountActive(id: string, family: ModelFamily = 'google'): void {
    const data = this.deps.getData()
    if (!data.activeAccountIds) data.activeAccountIds = {}
    const peer = this.canSyncSharedPeer(data, this.account(id), family)
    const updatesGoogle = family === 'google' || peer === 'google'
    const familySame = data.activeAccountIds[family] === id
    const peerSame = !peer || data.activeAccountIds[peer] === id
    const lastSame = !updatesGoogle || data.lastActiveAccountId === id
    if (familySame && peerSame && lastSame) return
    data.activeAccountIds[family] = id
    if (peer) data.activeAccountIds[peer] = id
    if (updatesGoogle || !data.lastActiveAccountId) data.lastActiveAccountId = id
    this.deps.persist()
  }

  /**
   * Manually pin the active slot for one family (console per-family "设为当前").
   * Family-scoped except when Argon shares the Gemini Models bucket (links `google` <-> `argon`).
   */
  setActiveAccount(id: string, family: ModelFamily = 'google'): boolean {
    const data = this.deps.getData()
    const acc = this.account(id)
    const now = Date.now()
    if (!acc || !isAccountEligible(acc, family, now, this.deps.pool)) return false
    if (!data.activeAccountIds) data.activeAccountIds = {}
    data.activeAccountIds[family] = id
    if (!data.manualPinAtByFamily) data.manualPinAtByFamily = {}
    data.manualPinAtByFamily[family] = now
    const peer = this.canSyncSharedPeer(data, acc, family)
    if (peer && isAccountEligible(acc, peer, now, this.deps.pool)) {
      data.activeAccountIds[peer] = id
      data.manualPinAtByFamily[peer] = now
    }
    if (family === 'google' || peer === 'google' || !data.lastActiveAccountId) data.lastActiveAccountId = id
    this.deps.persist()
    return true
  }

  markAuthRequired(id: string, reason?: string): void {
    this.authFlags.mark(id, reason)
  }

  /** Confirmation-gated quarantine for a non-authoritative auth banner (2 strikes). */
  noteAuthFailure(id: string, reason?: string): boolean {
    return this.authFlags.noteFailure(id, reason)
  }

  /**
   * External re-login detected (agy logout + new login): identity-bound
   * state from the PREVIOUS account (cooldowns, quotas, auth quarantine)
   * must not leak onto the new one. Resets everything email-bound while
   * keeping slot config (alias, dir, proxy, enabled).
   */
  resetAccountIdentity(id: string, newEmail: string, resetAlias = false): void {
    const acc = this.account(id)
    if (!acc) return
    acc.email = newEmail
    acc.cooldowns = {}
    acc.quotas = {}
    delete acc.dedicatedGroups
    delete acc.planTier
    delete acc.quotaUnavailable
    delete acc.authRequired
    delete acc.authError
    delete acc.authMarkedAt
    delete acc.authReverifyAttempts
    if (resetAlias && acc.systemHome) {
      acc.alias = 'Primary account (system sign-in)'
      acc.defaultAlias = true
    }
    this.deps.persist()
  }

  /** Drop the flag (automatic paths never lift a terminal TOS ban; force = user action). */
  clearAuthRequired(id: string, force = false): void {
    this.authFlags.clear(id, force)
  }

  /** Count one failed background re-verification (drives the 2m→30m back-off). */
  noteAuthReverifyAttempt(id: string): void {
    this.authFlags.noteReverifyAttempt(id)
  }

  /** Clear flags that a NEWER quota snapshot already disproved (zero network). */
  healAuthFlagsFromQuota(): string[] {
    return this.authFlags.healFromQuota()
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
    // Make primary immediately active for all eligible families
    if (!acc.authRequired) {
      data.activeAccountIds = {
        google: id,
        anthropic: id,
        openai: id,
      }
      data.lastActiveAccountId = id
    }
    data.manualPinAt = Date.now()
    data.manualPinAtByFamily = {}
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
    data.manualPinAt = Date.now()
    data.manualPinAtByFamily = {}
    this.deps.persist()
    return true
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.deps.getData().mode = mode
    this.deps.persist()
  }

  /**
   * Drop cooldowns that were recorded from a MODEL-scoped refusal
   * (`... exhausted your capacity on this model ...`). Such a cooldown never
   * should have removed the account from rotation for the whole family: the
   * other models still have quota. Runs once at pool init so an account frozen
   * by the old classifier rejoins rotation immediately.
   */
  dropModelScopedCooldowns(): number {
    const dropped = dropLegacyModelScopedFamilyCooldowns(this.deps.getData().accounts)
    if (dropped > 0) this.deps.persist()
    return dropped
  }

  /** Clear cooldowns (family-level, and every model bucket of that account). */
  clearCooldown(id?: string, family?: ModelFamily, includeQuotaBench = false): void {
    const now = Date.now()
    const targetFamily = family ? (normalizeModelFamily(family) ?? family) : undefined
    const clearOne = (acc: ManagedAccount): void => {
      acc.cooldowns ??= {}
      const sharedArgon = argonSharesGoogleGroup(acc)
      if (targetFamily) {
        delete acc.cooldowns[targetFamily]
        if (targetFamily === 'google' && !acc.quotas?.argon) delete acc.cooldowns.argon
        if (targetFamily === 'argon' && includeQuotaBench && sharedArgon) delete acc.cooldowns.google
      } else {
        acc.cooldowns = {}
      }
      acc.modelCooldowns = {} // same user action: release paused model buckets too
      if (!includeQuotaBench) return
      const families: ModelFamily[] = targetFamily
        ? ((targetFamily === 'google' && !acc.quotas?.argon) || (targetFamily === 'argon' && sharedArgon) ? ['google', 'argon'] : [targetFamily])
        : [...new Set([...(Object.keys(acc.quotas ?? {}) as ModelFamily[]), ...(sharedArgon ? (['argon'] as ModelFamily[]) : [])])]
      if (families.length === 0) return
      acc.quotaGateClearedAt ??= {}
      for (const fam of families) {
        const updatedAt = acc.quotas?.[fam]?.updatedAt ?? (fam === 'argon' ? acc.quotas?.google?.updatedAt : undefined)
        acc.quotaGateClearedAt[fam] = Math.max(now, updatedAt ?? 0)
      }
    }
    if (id) {
      const acc = this.account(id)
      if (!acc) return
      clearOne(acc)
    } else {
      for (const acc of this.deps.getData().accounts) clearOne(acc)
    }
    this.deps.persist()
  }

  /** Record a 429 that belongs to ONE model's own bucket (never the family). */
  recordModelFailure(id: string, model: string, reason: string, serverResetTime?: string): void {
    const acc = this.account(id)
    const data = this.deps.getData()
    if (!acc) return
    applyModelFailure(acc, model, reason, serverResetTime, data)
    this.deps.persist()
  }

  /** Clear one model's cooldown after a successful call on it. */
  recordModelSuccess(id: string, model: string): void {
    const acc = this.account(id)
    if (acc && clearModelCooldown(acc, model)) this.deps.persist()
  }

  /**
   * Records a rate-limit / 429 error and sets cooldown for the requested model family.
   */
  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    const data = this.deps.getData()
    const acc = this.account(id)
    if (!acc) return
    acc.cooldowns ??= {}
    const prev = effectiveFamilyCooldown(acc, family)
    const failures = (prev?.consecutiveFailures ?? 0) + 1
    const entry = { cooldownUntil: cooldownUntilFor(data, failures, reason, serverResetTime), reason, consecutiveFailures: failures }
    acc.cooldowns[family] = entry
    const peer = sharedArgonPeerFamily(acc, family)
    if (peer) acc.cooldowns[peer] = { ...entry }
    // Only advance if this account currently owns the family pointer (or fallback lastActiveAccountId).
    const owns = (fam: ModelFamily): boolean => {
      const p = data.activeAccountIds?.[fam]
      return p === id || (p === undefined && (data.lastActiveAccountId === id || data.lastActiveAccountId === undefined))
    }
    if (owns(family)) this.advanceAccount(id, family)
    if (peer && owns(peer)) this.advanceAccount(id, peer)
    this.deps.persist()
  }

  /**
   * Records a successful run, clearing failure counter and authRequired flag for the family.
   */
  recordSuccess(id: string, family: ModelFamily): void {
    const acc = this.account(id)
    if (!acc) return
    acc.lastUsedAt = Date.now()
    if (acc.authRequired && !isTerminalAuthError(acc.authError)) {
      delete acc.authRequired
      delete acc.authError
      delete acc.authMarkedAt
      delete acc.authReverifyAttempts
    }
    if (acc.cooldowns?.[family]) delete acc.cooldowns[family]
    const peer = sharedArgonPeerFamily(acc, family)
    if (peer && acc.cooldowns?.[peer]) delete acc.cooldowns[peer]
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
  advanceAccount(fromId: string, family: ModelFamily, model?: string): string | null {
    const data = this.deps.getData()
    const now = Date.now()
    const candidates = data.accounts.filter((a) => a.id !== fromId && isAccountEligible(a, family, now, this.deps.pool, model))
    if (candidates.length === 0) return null
    const next = orderByExpiry(data.accounts, candidates, family, fromId, now)[0]!
    if (!data.activeAccountIds) data.activeAccountIds = {}
    data.activeAccountIds[family] = next.id
    const peer = this.canSyncSharedPeer(data, next, family)
    if (peer && (data.activeAccountIds[peer] === fromId || data.activeAccountIds[peer] === undefined) && isAccountEligible(next, peer, now, this.deps.pool)) {
      data.activeAccountIds[peer] = next.id
    }
    if (family === 'google' || (peer === 'google' && data.activeAccountIds.google === next.id) || !data.lastActiveAccountId) {
      data.lastActiveAccountId = next.id
    }
    this.deps.persist()
    return next.id
  }

  /**
   * Returns the currently active and healthy account ID for `family`.
   * Checks this family's active pointer first; only checks `lastActiveAccountId`
   * when this family has no pointer yet, otherwise selects the next eligible
   * candidate strictly within `family`.
   */
  getActiveAccountId(family: ModelFamily = 'google', model?: string): string | undefined {
    const data = this.deps.getData()
    const now = Date.now()
    const pinnedId = data.activeAccountIds?.[family]
    if (pinnedId) {
      const pinned = data.accounts.find((a) => a.id === pinnedId)
      if (pinned && isAccountEligible(pinned, family, now, this.deps.pool, model)) {
        return pinned.id
      }
    }
    if (pinnedId === undefined && data.lastActiveAccountId) {
      const active = data.accounts.find((a) => a.id === data.lastActiveAccountId)
      if (active && isAccountEligible(active, family, now, this.deps.pool, model)) {
        return active.id
      }
    }
    const next = this.deps.selectAccount(family, model)
    if (next) return next.id
    const latest = this.deps.getData()
    return latest.accounts.find((a) => a.id === latest.primaryAccountId && a.enabled)?.id
      ?? latest.accounts.find((a) => a.enabled)?.id
  }
}