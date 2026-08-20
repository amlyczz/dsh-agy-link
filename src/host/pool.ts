// AccountPoolManager: multi-profile credential isolation, family-scoped cooldown,
// and sticky sequential drain scheduling for Google Antigravity accounts.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  }

  private load(): AccountPoolData {
    try {
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, 'utf8')
        const parsed = JSON.parse(raw) as AccountPoolData
        if (parsed && Array.isArray(parsed.accounts)) {
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
   * If a system-level ~/.gemini/ credentials exists, auto-copies to acc_default
   * so existing users experience zero migration friction.
   */
  private bootstrapDefaultAccount(): void {
    if (this.data.accounts.length > 0) return

    const defaultId = 'acc_primary'
    const defaultDir = join(this.baseDir, defaultId)
    mkdirSync(defaultDir, { recursive: true })

    // Check if existing ~/.gemini/ token can be imported
    const sysGemini = join(homedir(), '.gemini')
    const sysToken = join(sysGemini, 'antigravity-cli', 'antigravity-oauth-token')
    const destTokenDir = join(defaultDir, '.gemini', 'antigravity-cli')

    if (existsSync(sysToken)) {
      try {
        mkdirSync(destTokenDir, { recursive: true })
        const tokenContent = readFileSync(sysToken, 'utf8')
        writeFileSync(join(destTokenDir, 'antigravity-oauth-token'), tokenContent, 'utf8')
        // Also copy standalone jetski token if present
        const sysJetski = join(sysGemini, 'jetski-standalone-oauth-token')
        if (existsSync(sysJetski)) {
          writeFileSync(join(defaultDir, '.gemini', 'jetski-standalone-oauth-token'), readFileSync(sysJetski), 'utf8')
        }
      } catch {
        // Ignore copy errors
      }
    }

    const primary: ManagedAccount = {
      id: defaultId,
      alias: '主账号 (Primary Account)',
      dir: defaultDir,
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    this.data.accounts.push(primary)
    this.data.primaryAccountId = defaultId
    this.persist()
  }

  getPoolData(): Readonly<AccountPoolData> {
    return this.data
  }

  getAccounts(): readonly ManagedAccount[] {
    return this.data.accounts
  }

  getAccount(id: string): ManagedAccount | undefined {
    return this.data.accounts.find((a) => a.id === id)
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
      alias: alias || `备用账号 ${count} (Account ${count})`,
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
      this.data.primaryAccountId = this.data.accounts[0]?.id
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
    this.persist()
    return true
  }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    acc.enabled = enabled
    this.persist()
    return true
  }

  setPrimaryAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    this.data.primaryAccountId = id
    // Move to front of accounts list
    const [acc] = this.data.accounts.splice(idx, 1)
    if (acc) this.data.accounts.unshift(acc)
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

  updateAccountQuotas(id: string, quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>, email?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotas = {
      ...acc.quotas,
      ...quotas,
    }
    if (email) acc.email = email
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
    if (serverResetTime) {
      const parsed = Date.parse(serverResetTime)
      if (!Number.isNaN(parsed) && parsed > Date.now()) {
        cooldownUntil = parsed
      } else {
        cooldownUntil = Date.now() + Math.min(this.data.defaultCooldownMs * failures, this.data.maxCooldownMs)
      }
    } else {
      cooldownUntil = Date.now() + Math.min(this.data.defaultCooldownMs * failures, this.data.maxCooldownMs)
    }

    acc.cooldowns[family] = {
      cooldownUntil,
      reason,
      consecutiveFailures: failures,
    }
    this.persist()
  }

  /**
   * Records a successful run, clearing failure counter for the family.
   */
  recordSuccess(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.lastUsedAt = Date.now()
    if (acc.cooldowns[family]) {
      delete acc.cooldowns[family]
      this.persist()
    }
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
   * Returns the first healthy, enabled account for the requested family.
   */
  selectAccount(family: ModelFamily): ManagedAccount | null {
    const now = Date.now()
    const candidates = this.data.accounts.filter((acc) => {
      if (!acc.enabled) return false
      const cd = acc.cooldowns[family]
      if (cd && cd.cooldownUntil > now) return false
      // If quota remaining is 0% and reset time is in future, treat as in cooldown
      const quota = acc.quotas[family]
      if (quota && typeof quota.remainingFraction === 'number' && quota.remainingFraction <= 0.02) {
        if (quota.resetTime) {
          const resetMs = Date.parse(quota.resetTime)
          if (!Number.isNaN(resetMs) && resetMs > now) return false
        }
      }
      return true
    })

    if (candidates.length === 0) return null

    if (this.data.mode === 'round-robin' && candidates.length > 1) {
      // Pick least recently used candidate
      const sorted = candidates.slice().sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
      return sorted[0] ?? null
    }

    // Default 'sequential': Pick the first candidate in priority order
    return candidates[0] ?? null
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
