// AccountPoolManager: multi-profile credential isolation, family-scoped cooldown,
// and sticky sequential drain scheduling for Google Antigravity accounts.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  defaultPoolData,
  modelFamilyOf,
  type AccountPoolData,
  type FamilyCooldownState,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import { parseResetDurationMs } from '../common/types.ts'

export function defaultPoolDir(): string {
  const dshState = process.env.DSH_STATE_DIR || join(homedir(), '.dsh')
  return join(dshState, 'agy-accounts')
}

export class AccountPoolManager {
  private data: AccountPoolData
  private readonly baseDir: string
  private readonly file: string

  constructor(baseDir = defaultPoolDir()) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'pool.json')
    this.data = this.load()
    this.bootstrapDefaultAccount()
    this.normalizeLegacyPrimary()
  }

  private load(): AccountPoolData {
    try {
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, 'utf8')
        const parsed = JSON.parse(raw) as AccountPoolData
        if (parsed && Array.isArray(parsed.accounts)) {
          for (const acc of parsed.accounts) {
            if (acc.cooldowns) {
              for (const [fam, cd] of Object.entries(acc.cooldowns)) {
                if (cd && cd.reason === 'agy run aborted by caller') {
                  delete acc.cooldowns[fam as ModelFamily]
                }
              }
            }
          }
          return {
            ...defaultPoolData(),
            ...parsed,
          }
        }
      }
    } catch {
      // Corrupt file recovery
    }
    return defaultPoolData()
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = join(dirname(this.file), '.pool.json.tmp')
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // Best-effort persistence
    }
  }

  /**
   * Bootstraps the primary account on first start.
   *
   * The primary account rides the REAL system HOME with no directory
   * isolation: agy 1.1.15+ persists credentials in the macOS Keychain
   * ("Antigravity Safe Storage"), not in a ~/.gemini token file, so copying
   * files cannot migrate sign-in state. Injecting HOME would log the
   * primary account out of agy entirely (observed: "Please sign in").
   * Only SECONDARY pool accounts get isolated HOME directories, created
   * and signed in via /agy add-account.
   */
  private bootstrapDefaultAccount(): void {
    // The primary slot represents whatever account is currently logged into
    // the REAL system HOME (`agy login` / `agy logout` outside DSH). It must
    // ALWAYS exist: it used to be created only for an empty pool, so deleting
    // it while other accounts remained made the system-HOME login invisible
    // forever — the UI fell back to an isolated account and looked "stale"
    // after every external re-login. Users who don't want it can disable it.
    const hasSystemHome = this.data.accounts.some((a) => a.systemHome)
    if (hasSystemHome) return

    const primary: ManagedAccount = {
      id: 'acc_primary',
      alias: 'Primary account (system sign-in)',
      defaultAlias: true,
      dir: '',
      systemHome: true,
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    this.data.accounts.unshift(primary)
    this.data.primaryAccountId = primary.id
    this.persist()
  }

  /**
   * Migrates pool files created before Keychain-aware primaries: an
   * acc_primary that carries an isolated dir (and likely a broken token
   * copy) is converted back to the system HOME so agy stays signed in.
   * The stale directory is left untouched (never deletes user data).
   */
  private normalizeLegacyPrimary(): void {
    const primary = this.data.accounts.find((a) => a.id === 'acc_primary')
    if (!primary) return
    // Locale changes must not rewrite existing account data.
    if (primary.systemHome) return
    primary.dir = ''
    primary.systemHome = true
    primary.alias = 'Primary account (system sign-in)'
    primary.defaultAlias = true
    this.data.primaryAccountId = primary.id
    this.persist()
  }

  getPoolData(): Readonly<AccountPoolData> {
    return {
      ...this.data,
      activeAccountId: this.getActiveAccountId('google'),
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

    this.data.accounts.push(newAccount)
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
    this.persist()
    return newAccount
  }

  deleteAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [removed] = this.data.accounts.splice(idx, 1)
    if (removed) {
      try {
        if (existsSync(removed.dir)) {
          rmSync(removed.dir, { recursive: true, force: true })
        }
      } catch {
        // Ignore deletion errors
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
    this.persist()
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
    this.persist()
  }

  setPrimaryAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    this.data.primaryAccountId = id
    // Move to front of accounts list
    const [acc] = this.data.accounts.splice(idx, 1)
    if (acc) this.data.accounts.unshift(acc)
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
    this.persist()
    return true
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.data.mode = mode
    this.persist()
  }

  /**
   * Check whether an account is eligible to serve requests for the given family.
   */
  isAccountEligible(acc: ManagedAccount, family: ModelFamily, now = Date.now()): boolean {
    if (!acc.enabled || acc.authRequired) return false
    const cd = acc.cooldowns[family]
    if (cd && cd.cooldownUntil > now) return false
    // If 5h quota remaining is <= 2% and reset time is in future, treat as in cooldown
    const quota = acc.quotas[family]
    if (quota && typeof quota.remainingFraction === 'number' && quota.remainingFraction <= 0.02) {
      if (quota.resetTime) {
        const resetMs = Date.parse(quota.resetTime)
        if (!Number.isNaN(resetMs) && resetMs > now) return false
      }
    }
    // If weekly quota remaining is <= 1% and weekly reset time is in future, treat as in cooldown
    if (quota && typeof quota.weeklyFraction === 'number' && quota.weeklyFraction <= 0.01) {
      if (quota.weeklyResetTime) {
        const resetMs = Date.parse(quota.weeklyResetTime)
        if (!Number.isNaN(resetMs) && resetMs > now) return false
      }
    }
    return true
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
    return this.data.primaryAccountId ?? this.data.accounts[0]?.id
  }

  /**
   * Next moment this account's quota state refreshes for one family: the
   * sooner of the 5h window reset and the weekly cap reset. NaN when unknown.
   */
  private nextQuotaResetAt(acc: ManagedAccount, family: ModelFamily): number {
    const q = acc.quotas[family]
    const stamps = [q?.resetTime, q?.weeklyResetTime]
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .map((v) => Date.parse(v))
      .filter((t) => !Number.isNaN(t))
    return stamps.length === 0 ? Number.NaN : Math.min(...stamps)
  }

  /** Cyclic distance from `fromId` (0 = itself), so ties keep pool order. */
  private cyclicDistance(fromId: string | undefined, id: string): number {
    const total = this.data.accounts.length
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return Number.MAX_SAFE_INTEGER
    if (fromId === undefined) return idx
    const start = this.data.accounts.findIndex((a) => a.id === fromId)
    if (start === -1) return idx
    return (idx - start + total) % total
  }

  /**
   * "Use it or lose it" rotation order. When the sticky account is drained we
   * prefer the eligible account whose quota window refreshes SOONEST: residual
   * quota disappears at that reset, so draining it first is free capacity the
   * pool would otherwise throw away. Accounts with no quota metadata yet keep
   * the legacy cyclic order (which also keeps a drained slot from bouncing
   * straight back to the primary).
   */
  private orderByExpiry(
    candidates: readonly ManagedAccount[],
    family: ModelFamily,
    fromId?: string,
  ): ManagedAccount[] {
    return candidates
      .map((acc, index) => ({ acc, index, at: this.nextQuotaResetAt(acc, family) }))
      .sort((a, b) => {
        const aKnown = !Number.isNaN(a.at)
        const bKnown = !Number.isNaN(b.at)
        if (aKnown !== bKnown) return aKnown ? -1 : 1
        if (aKnown && bKnown && a.at !== b.at) return a.at - b.at
        const da = this.cyclicDistance(fromId, a.acc.id)
        const db = this.cyclicDistance(fromId, b.acc.id)
        return da !== db ? da - db : a.index - b.index
      })
      .map((e) => e.acc)
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
      const isExhausted5h = typeof info.remainingFraction === 'number' && info.remainingFraction <= 0.02 &&
        (!info.resetTime || Date.parse(info.resetTime) > now)
      const isExhaustedWeekly = typeof info.weeklyFraction === 'number' && info.weeklyFraction <= 0.01 &&
        (!info.weeklyResetTime || Date.parse(info.weeklyResetTime) > now)
      if (isExhausted5h || isExhaustedWeekly) {
        if (this.data.activeAccountIds?.[famKey] === id || this.data.lastActiveAccountId === id) {
          this.selectAccount(famKey)
        }
      }
    }

    this.persist()
  }

  /**
   * Records a rate-limit / 429 error and sets cooldown for the requested model family.
   */
  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return

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
      this.selectAccount(family)
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
    if (acc.cooldowns[family]) {
      delete acc.cooldowns[family]
    }
    this.persist()
  }

  clearCooldown(id?: string, family?: ModelFamily): void {
    if (id) {
      const acc = this.getAccount(id)
      if (!acc) return
      if (family) delete acc.cooldowns[family]
      else acc.cooldowns = {}
    } else {
      for (const acc of this.data.accounts) {
        if (family) delete acc.cooldowns[family]
        else acc.cooldowns = {}
      }
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
    //    account whose quota expires SOONEST (use-it-or-lose-it: residual
    //    quota is discarded at the window reset). With no quota metadata yet
    //    this degrades to the previous cyclic order.
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
      const cd = acc.cooldowns[family]
      if (cd && cd.cooldownUntil > now) {
        if (earliest === null || cd.cooldownUntil < earliest) {
          earliest = cd.cooldownUntil
        }
      }
    }
    return earliest !== null ? Math.max(0, earliest - now) : null
  }
}
