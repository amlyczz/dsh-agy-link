// Model discovery cache & per-account projection (spec ADR-10).
// Pure parsing, effort folding, and slug resolution live in ../domain/models/parse.ts.
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../common/atomic-write.ts'
import type { FallbackModelDef } from '../common/types.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import { accountHasArgon, isArgonModel } from '../common/pool-types.ts'
import { staggerJitterMs } from '../domain/quota/identity.ts'
import type { AccountPoolManager } from './pool.ts'
import {
  buildFallbackCatalog,
  foldEfforts,
  isUnauthenticatedModelsFallback,
  parseModelsOutput,
  sameCatalogEntry,
  sanitizeCatalogEntries,
  type Catalog,
  type CatalogEntry,
} from '../domain/models/parse.ts'

export { accountHasArgon, isArgonModel }
export {
  buildFallbackCatalog,
  defaultEffortFor,
  findEntry,
  foldEfforts,
  isUnauthenticatedModelsFallback,
  parseModelsOutput,
  resolveModelSlug,
  sanitizeCatalogEntries,
  type Catalog,
  type CatalogEntry,
  type RawModel,
} from '../domain/models/parse.ts'

/** Check whether any enabled account in the pool has confirmed access to Argon. */
export function poolHasArgon(
  pool?: AccountPoolManager | null,
  catalog?: ModelCatalog,
): boolean {
  if (!pool) return false
  const accounts = pool.getAccounts().filter((a) => a.enabled)
  return accounts.some((acc) => accountHasArgon(acc, pool, catalog?.getAccountCatalog(acc.id)))
}

export type DiscoverFn = (signal?: AbortSignal, accountId?: string) => Promise<{ stdout: string; stderr: string }>

export interface ModelCatalogOptions {
  cacheFile?: string
  agyVersion?: () => string | null
  staggerMs?: () => number
}

interface PersistedCatalogDisk {
  version: 1
  agyVersion?: string | null
  current?: Catalog
  accounts?: Record<string, Catalog>
}

export class ModelCatalog {
  private current: Catalog
  private readonly accountCatalogs = new Map<string, Catalog>()
  private readonly refreshingByKey = new Map<string, Promise<void>>()
  private static readonly FALLBACK_RETRY_MS = 60_000
  private lastAttemptAt = 0
  private readonly accountAttemptAt = new Map<string, number>()
  private persistedAgyVersion: string | null = null

  constructor(
    private readonly discover: DiscoverFn,
    private readonly fallbackDefs: readonly FallbackModelDef[],
    private readonly ttlMs: number,
    private readonly onUpdate?: () => void,
    private readonly options: ModelCatalogOptions = {},
  ) {
    this.current = {
      source: 'fallback',
      models: buildFallbackCatalog(fallbackDefs),
      discoveredAt: 0,
    }
    this.hydrateFromDisk()
  }

  private sanitizePersisted(cat: Catalog | undefined): Catalog | null {
    if (!cat || cat.source !== 'discovered' || !Array.isArray(cat.models)) return null
    const rawEntries = sanitizeCatalogEntries(cat.models).entries
    if (rawEntries.length === 0) return null
    const entries: CatalogEntry[] = rawEntries.map((e) => ({
      id: e.id,
      name: e.name,
      efforts: e.efforts.length === 0 ? null : e.efforts,
    }))
    return {
      source: 'discovered',
      models: entries,
      discoveredAt: typeof cat.discoveredAt === 'number' && Number.isFinite(cat.discoveredAt) ? cat.discoveredAt : 0,
    }
  }

  private hydrateFromDisk(): void {
    const file = this.options.cacheFile
    if (!file || !existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedCatalogDisk
      if (!parsed || parsed.version !== 1) return
      const liveVer = this.options.agyVersion?.() ?? null
      if (liveVer && parsed.agyVersion && parsed.agyVersion !== liveVer) return
      this.persistedAgyVersion = parsed.agyVersion ?? null
      const cur = this.sanitizePersisted(parsed.current)
      if (cur) this.current = cur
      if (parsed.accounts && typeof parsed.accounts === 'object') {
        for (const [accId, rawCat] of Object.entries(parsed.accounts)) {
          const valid = this.sanitizePersisted(rawCat)
          if (valid) this.accountCatalogs.set(accId, valid)
        }
      }
    } catch {
      // ignore corrupt cache file
    }
  }

  private persistToDisk(): void {
    const file = this.options.cacheFile
    if (!file) return
    try {
      const accounts: Record<string, Catalog> = {}
      for (const [accId, cat] of this.accountCatalogs.entries()) {
        if (cat.source === 'discovered' && cat.models.length > 0) {
          accounts[accId] = cat
        }
      }
      const liveVer = this.options.agyVersion?.() ?? this.persistedAgyVersion
      this.persistedAgyVersion = liveVer
      const doc: PersistedCatalogDisk = {
        version: 1,
        agyVersion: liveVer,
        ...(this.current.source === 'discovered' ? { current: this.current } : {}),
        accounts,
      }
      writeFileAtomicSync(file, JSON.stringify(doc, null, 2), 0o600)
    } catch {
      // best-effort disk cache
    }
  }

  /** Invalidate cached entries if `agy --version` reveals a binary upgrade after boot. */
  syncAgyVersion(liveVersion: string | null): void {
    if (!liveVersion) return
    if (this.persistedAgyVersion && this.persistedAgyVersion !== liveVersion) {
      this.accountCatalogs.clear()
      this.current = {
        source: 'fallback',
        models: buildFallbackCatalog(this.fallbackDefs),
        discoveredAt: 0,
      }
      this.persistedAgyVersion = liveVersion
      this.persistToDisk()
      return
    }
    if (this.persistedAgyVersion !== liveVersion) {
      this.persistedAgyVersion = liveVersion
      if (this.current.source === 'discovered' || this.accountCatalogs.size > 0) {
        this.persistToDisk()
      }
    }
  }

  getAllKnownModels(accounts: readonly ManagedAccount[] = []): readonly CatalogEntry[] {
    const list: CatalogEntry[] = []
    const seen = new Set<string>()
    const addEntries = (entries: readonly CatalogEntry[]) => {
      for (const m of entries) {
        if (!m || !m.id || seen.has(m.id)) continue
        seen.add(m.id)
        list.push(m)
      }
    }
    if (this.current.source === 'discovered') {
      addEntries(this.current.models)
    }
    for (const acc of accounts) {
      if (!acc.enabled) continue
      const cat = this.accountCatalogs.get(acc.id)
      if (cat && cat.source === 'discovered') {
        addEntries(cat.models)
      }
    }
    if (list.length === 0) {
      addEntries(buildFallbackCatalog(this.fallbackDefs))
    }
    return list
  }

  getUnion(accounts: readonly ManagedAccount[] = [], pool?: AccountPoolManager | null): readonly CatalogEntry[] {
    if (accounts.length === 0 && !pool) {
      return this.current.models
    }
    const all = this.getAllKnownModels(accounts)
    const hasAnyArgon = pool ? poolHasArgon(pool, this) : accounts.some((a) => accountHasArgon(a, pool, this.getAccountCatalog(a.id)))
    return all.filter((entry) => !(isArgonModel(entry.id) && !hasAnyArgon))
  }

  getModelsForAccount(acc: ManagedAccount, pool?: AccountPoolManager | null): readonly CatalogEntry[] {
    const accountCat = this.accountCatalogs.get(acc.id)
    if (accountCat && accountCat.source === 'discovered' && accountCat.models.length > 0) {
      return accountCat.models
    }

    const hasArgon = accountHasArgon(acc, pool, this.current)
    if (this.current.source === 'discovered' && this.current.models.length > 0) {
      const filtered = this.current.models.filter((m) => !(isArgonModel(m.id) && !hasArgon))
      if (hasArgon && !filtered.some((m) => isArgonModel(m.id))) {
        const argonCandidates = [
          ...[...this.accountCatalogs.values()]
            .filter((c) => c.source === 'discovered')
            .flatMap((c) => c.models),
          ...buildFallbackCatalog(this.fallbackDefs),
        ].filter((m) => isArgonModel(m.id))
        const seen = new Set(filtered.map((m) => m.id))
        const extra: CatalogEntry[] = []
        for (const m of argonCandidates) {
          if (!seen.has(m.id)) {
            seen.add(m.id)
            extra.push(m)
          }
        }
        if (extra.length > 0) return [...extra, ...filtered]
      }
      return filtered
    }

    return buildFallbackCatalog(this.fallbackDefs).filter((m) => !(isArgonModel(m.id) && !hasArgon))
  }

  get(accountId?: string): Catalog {
    if (accountId && this.accountCatalogs.has(accountId)) {
      return this.accountCatalogs.get(accountId)!
    }
    return this.current
  }

  /** Return ONLY this account's own discovered catalog (never `this.current`). */
  getAccountCatalog(accountId?: string): Catalog | undefined {
    return accountId ? this.accountCatalogs.get(accountId) : undefined
  }

  hasAccountCatalog(accountId: string): boolean {
    return this.accountCatalogs.has(accountId)
  }

  advertisedEfforts(modelId: string): readonly string[] {
    const out = new Set<string>()
    for (const cat of [this.current, ...this.accountCatalogs.values()]) {
      if (cat.source !== 'discovered') continue
      for (const m of cat.models) {
        if (m.id !== modelId || !Array.isArray(m.efforts)) continue
        for (const e of m.efforts) if (typeof e === 'string' && e !== '') out.add(e)
      }
    }
    return [...out]
  }

  async refreshIfNeeded(accountId?: string): Promise<void> {
    const key = accountId ?? '__default__'
    const inFlight = this.refreshingByKey.get(key)
    if (inFlight) return inFlight
    const now = Date.now()
    const accountCat = accountId ? this.accountCatalogs.get(accountId) : undefined
    if (!accountId || accountCat) {
      const targetCat = accountCat ?? this.current
      const age = now - targetCat.discoveredAt
      if (targetCat.source === 'discovered' && age < this.ttlMs) return
      const last = accountId ? (this.accountAttemptAt.get(accountId) ?? 0) : this.lastAttemptAt
      if (targetCat.source === 'fallback' && now - last < ModelCatalog.FALLBACK_RETRY_MS) return
      if (accountId) this.accountAttemptAt.set(accountId, now)
      else this.lastAttemptAt = now
    } else {
      const last = this.accountAttemptAt.get(accountId) ?? 0
      if (now - last < ModelCatalog.FALLBACK_RETRY_MS) return
      this.accountAttemptAt.set(accountId, now)
    }
    if (!accountId) this.lastAttemptAt = now
    const job = this.refresh(accountId).finally(() => {
      if (this.refreshingByKey.get(key) === job) {
        this.refreshingByKey.delete(key)
      }
    })
    this.refreshingByKey.set(key, job)
    return job
  }

  async ensureAccountCatalog(accountId: string): Promise<Catalog> {
    if (!accountId || this.accountCatalogs.has(accountId)) return this.get(accountId)
    await this.refreshIfNeeded(accountId)
    return this.get(accountId)
  }

  async forceRefresh(accountId?: string): Promise<Catalog> {
    await this.refresh(accountId)
    return this.get(accountId)
  }

  async forceRefreshAndNotify(accountId?: string): Promise<Catalog> {
    const hadCatalog = accountId ? this.hasAccountCatalog(accountId) : true
    await this.refresh(accountId, false)
    const hasCatalog = accountId ? this.hasAccountCatalog(accountId) : true
    if (hadCatalog || hasCatalog) this.onUpdate?.()
    return this.get(accountId)
  }

  async warmAccounts(accounts: readonly ManagedAccount[]): Promise<void> {
    const now = Date.now()
    const due = accounts.filter((acc) => {
      if (!acc.enabled || acc.authRequired) return false
      const cached = this.accountCatalogs.get(acc.id)
      return !(cached && cached.source === 'discovered' && now - cached.discoveredAt < this.ttlMs)
    })
    for (let i = 0; i < due.length; i++) {
      await this.refresh(due[i]!.id, false).catch(() => undefined)
      if (i < due.length - 1) {
        const delay = this.options.staggerMs?.() ?? (process.env.NODE_TEST_CONTEXT !== undefined ? 0 : staggerJitterMs())
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private async refresh(accountId?: string, announce = true): Promise<void> {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 30_000)
      try {
        const { stdout, stderr } = await this.discover(ac.signal, accountId)
        if (isUnauthenticatedModelsFallback(stdout, stderr)) {
          const msg = 'agy models returned unauthenticated fallback output'
          if (accountId) {
            const cat = this.accountCatalogs.get(accountId)
            if (cat) cat.lastError = msg
          } else {
            this.current = { ...this.current, lastError: msg }
          }
          return
        }
        const raw = parseModelsOutput(stdout)
        if (raw.length > 0) {
          const newModels = foldEfforts(raw)
          const newCatalog: Catalog = { source: 'discovered', models: newModels, discoveredAt: Date.now() }
          const prev = accountId ? (this.accountCatalogs.get(accountId) ?? { source: 'fallback' as const, models: [], discoveredAt: 0 }) : this.current
          const changed =
            prev.source !== 'discovered' ||
            prev.models.length !== newModels.length ||
            prev.models.some((m, i) => !sameCatalogEntry(m, newModels[i]))
          if (accountId) {
            this.accountCatalogs.set(accountId, newCatalog)
            if (this.current.source !== 'discovered') {
              this.current = newCatalog
            }
          } else {
            this.current = newCatalog
          }
          this.persistToDisk()
          if (changed && announce) {
            this.onUpdate?.()
          }
          return
        }
        if (accountId) {
          const cat = this.accountCatalogs.get(accountId)
          if (cat) cat.lastError = 'agy models returned no entries'
        } else {
          this.current = { ...this.current, lastError: 'agy models returned no entries' }
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (accountId) {
        const cat = this.accountCatalogs.get(accountId)
        if (cat) cat.lastError = errMsg
      } else {
        this.current = { ...this.current, lastError: errMsg }
      }
    }
  }
}
