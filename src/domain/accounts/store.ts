// Durable persistence for the multi-account pool: load (with JSON validation,
// legacy-record normalization and last-good recovery) and persist (atomic write
// plus a cross-process merge of accounts this process has never seen).
//
// AccountPoolManager keeps the in-memory `data` cache and its public methods;
// it delegates every read/write of `pool.json` to this store. The only state
// that must survive between calls — the set of account ids this process has
// seen and the last snapshot it wrote — lives here.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  defaultPoolData,
  type AccountPoolData,
  type ManagedAccount,
  type ModelFamily,
} from '../../common/pool-types.ts'
import { writeJsonAtomic } from './paths.ts'

export interface PoolStoreLoadResult {
  data: AccountPoolData
  /** True when load() had to fall back to pool.json.last-good. */
  recoveredFromLastGood: boolean
}

export class PoolStore {
  private readonly baseDir: string
  private readonly file: string
  /**
   * Account ids this process has seen (loaded from disk + created here). On
   * persist, disk ids OUTSIDE this set were added by another host process and
   * are preserved instead of being clobbered (same merge contract as
   * sessions.json: web + headless share this file).
   */
  private readonly knownIds = new Set<string>()
  /** Serialized snapshot of the last successful persist/load; skips no-op writes. */
  private persistedJson = ''

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'pool.json')
  }

  /** Record an account id this process created (or loaded) so persist won't treat it as foreign. */
  markKnown(id: string): void {
    this.knownIds.add(id)
  }

  /**
   * Remember the current snapshot as the last cleanly-persisted one. Called
   * once after construction so the first steady-state persist is a no-op.
   */
  snapshot(data: AccountPoolData): void {
    this.persistedJson = JSON.stringify(data)
  }

  load(): PoolStoreLoadResult {
    const primary = this.readPoolFile(this.file)
    if (primary) return { data: primary, recoveredFromLastGood: false }
    // Torn or corrupt file (concurrent hosts, truncated download, manual edit):
    // keep a forensic copy, then prefer the last snapshot this process wrote
    // cleanly instead of presenting the user with an empty pool.
    try {
      if (existsSync(this.file)) copyFileSync(this.file, this.file + '.corrupt-' + Date.now())
    } catch {
      // best effort
    }
    const lastGood = this.readPoolFile(this.file + '.last-good')
    if (lastGood) return { data: lastGood, recoveredFromLastGood: true }
    return { data: defaultPoolData(), recoveredFromLastGood: false }
  }

  private readPoolFile(file: string): AccountPoolData | null {
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw) as AccountPoolData
        if (parsed && Array.isArray(parsed.accounts)) {
          // Migration: the Gemini Web login feature was removed — drop any
          // legacy web-session accounts entirely (and purge dangling active
          // pointers to them) on next persist.
          parsed.accounts = parsed.accounts.filter((acc) => acc && typeof acc === 'object' && (acc as { type?: string }).type !== 'gemini-web')
          const liveIds = new Set(parsed.accounts.map((a) => a.id))
          if (parsed.lastActiveAccountId && !liveIds.has(parsed.lastActiveAccountId)) parsed.lastActiveAccountId = undefined
          if (parsed.primaryAccountId && !liveIds.has(parsed.primaryAccountId)) parsed.primaryAccountId = undefined
          if (parsed.activeAccountIds) {
            for (const [fam, id] of Object.entries(parsed.activeAccountIds)) {
              if (!id || !liveIds.has(id)) delete parsed.activeAccountIds[fam as ModelFamily]
            }
          }
          for (const acc of parsed.accounts) {
            // Normalize PARTIAL records: a hand-edited or older pool.json whose
            // account lacks cooldowns/quotas used to throw a TypeError inside
            // isAccountEligible -> selectAccount, so EVERY turn failed with an
            // opaque internal error and no failover at all.
            if (!acc || typeof acc !== 'object') continue
            if (acc.cooldowns === undefined || acc.cooldowns === null) acc.cooldowns = {}
            if (acc.quotas === undefined || acc.quotas === null) acc.quotas = {}
            if (acc.enabled === undefined) acc.enabled = true
            // A hand-edited record may have written a non-object here; the
            // eligibility checks index into it per family.
            if (
              acc.quotaGateClearedAt !== undefined
              && (typeof acc.quotaGateClearedAt !== 'object' || acc.quotaGateClearedAt === null)
            ) {
              acc.quotaGateClearedAt = undefined
            }
            for (const [fam, cd] of Object.entries(acc.cooldowns)) {
              if (cd && cd.reason === 'agy run aborted by caller') {
                delete acc.cooldowns[fam as ModelFamily]
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
      // Unparsable: the caller decides whether a last-good snapshot exists.
    }
    return null
  }

  /**
   * Write `data` to pool.json, merging in accounts another host process added
   * since our last look. Returns the data the manager should hold afterwards;
   * on a write failure it returns the ORIGINAL `data` (unchanged), matching the
   * old in-class persist.
   */
  persist(data: AccountPoolData): AccountPoolData {
    const serialized = JSON.stringify(data)
    // Merge with whatever another host process wrote since our last look so
    // web + headless stop erasing each other's accounts/cooldowns: disk
    // accounts this process has never seen are appended; everything else
    // (including deletions of ids we know) stays as this process wrote it.
    let merged: AccountPoolData = data
    try {
      if (existsSync(this.file)) {
        const onDisk = JSON.parse(readFileSync(this.file, 'utf8')) as AccountPoolData
        if (onDisk && Array.isArray(onDisk.accounts)) {
          const ours = new Set(data.accounts.map((a) => a.id))
          const foreign = onDisk.accounts.filter((a) => a && typeof a === 'object' && a.id !== undefined && !ours.has(a.id) && !this.knownIds.has(a.id))
          if (foreign.length > 0) {
            merged = { ...data, accounts: [...data.accounts, ...foreign] }
            for (const acc of foreign) this.knownIds.add(acc.id as string)
          }
        }
      }
    } catch {
      // unreadable/partial file: this process's view wins
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (serialized === this.persistedJson && merged === data) return merged
      const body = JSON.stringify(merged, null, 2)
      writeJsonAtomic(this.file, body)
      this.persistedJson = JSON.stringify(merged)
      // Keep a clean snapshot beside the pool so a torn write elsewhere can be
      // recovered on the next start (#90). Best effort: the primary write won.
      try {
        writeJsonAtomic(this.file + '.last-good', body)
      } catch {
        // recovery copy is optional
      }
      return merged
    } catch (e) {
      // Persistence failure used to be fully silent: cooldowns/quota state
      // quietly evaporated on restart. Surface it once per failure instead.
      try {
        // No logger reaches this class; stderr is the honest channel.
        console.error('[dsh-agy-link] pool persist failed: ' + String(e))
      } catch {
        // ignore
      }
      return data
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
   *
   * `getSysProxy` is called only when a primary actually has to be created
   * (the caller owns the host dependency), so the system-proxy probe keeps its
   * old lazy timing.
   */
  bootstrapDefaultAccount(data: AccountPoolData, getSysProxy?: () => string | undefined): AccountPoolData {
    // The primary slot represents whatever account is currently logged into
    // the REAL system HOME (`agy login` / `agy logout` outside DSH). It must
    // ALWAYS exist: it used to be created only for an empty pool, so deleting
    // it while other accounts remained made the system-HOME login invisible
    // forever — the UI fell back to an isolated account and looked "stale"
    // after every external re-login. Users who don't want it can disable it.
    const hasSystemHome = data.accounts.some((a) => a.systemHome)
    if (hasSystemHome) return data

    const sysProxy = getSysProxy?.()
    const primary: ManagedAccount = {
      id: 'acc_primary',
      alias: 'Primary account (system sign-in)',
      defaultAlias: true,
      dir: '',
      systemHome: true,
      ...(sysProxy ? { proxyUrl: sysProxy } : {}),
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    data.accounts.unshift(primary)
    data.primaryAccountId = primary.id
    return this.persist(data)
  }

  /**
   * Migrates pool files created before Keychain-aware primaries: an
   * acc_primary that carries an isolated dir (and likely a broken token
   * copy) is converted back to the system HOME so agy stays signed in.
   * The stale directory is left untouched (never deletes user data).
   */
  normalizeLegacyPrimary(data: AccountPoolData): AccountPoolData {
    const primary = data.accounts.find((a) => a.id === 'acc_primary' || a.systemHome)
    if (!primary) return data
    let changed = false
    // Locale changes must not rewrite existing account data.
    if (!primary.systemHome || primary.dir) {
      primary.dir = ''
      primary.systemHome = true
      primary.alias = 'Primary account (system sign-in)'
      primary.defaultAlias = true
      data.primaryAccountId = primary.id
      changed = true
    }
    // On Windows, self-heal primary email from durable .primary-credential.json if present
    if (process.platform === 'win32') {
      try {
        const credFile = join(this.baseDir, '.primary-credential.json')
        if (existsSync(credFile)) {
          const parsed = JSON.parse(readFileSync(credFile, 'utf8')) as { email?: string }
          if (parsed && typeof parsed.email === 'string' && parsed.email && primary.email !== parsed.email) {
            primary.email = parsed.email
            changed = true
          }
        }
      } catch {
        // best-effort
      }
    }
    if (changed) return this.persist(data)
    return data
  }
}
