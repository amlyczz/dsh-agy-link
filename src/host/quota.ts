// QuotaService: fetch and refresh live quota statistics and user profile
// directly from Google Antigravity backend (v1internal:fetchAvailableModels).
//
// Security note: NO OAuth client credentials are hard-coded here. agy 1.1.15
// stores credentials in the macOS Keychain (Antigravity Safe Storage) and we
// never attempt to re-exchange tokens with a guessed client id/secret — a
// wrong client pair makes Google return invalid_client and surfaces as
// "API key is invalid" in the UI. Quota refresh degrades silently to
// "unavailable" when credentials cannot be sourced.
//
// I/O bodies live in features/quota/http.ts + features/quota/token.ts; this
// class keeps the public methods and the overridable seams as thin delegates.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  needsAuthReverify,
  shouldPollAccount,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { readPrimaryCredential, parseCredentialDoc, credentialFingerprint, writePrimaryCredential, credentialSlotMutex } from './credential-slot.ts'
import { readAgyUsage, usageGroupsToFamilies } from './agy-usage.ts'
import { buildAgyEnvWithProxy, pickProxy } from '../runtime/net/account-env.ts'

import {
  sameCredentialGrant,
  staggerJitterMs,
  type StoredToken,
} from '../domain/quota/identity.ts'
import {
  type DiscoveredModelsResponse,
  type QuotaSummaryResponse,
  type UserQuotaResponse,
} from '../domain/quota/parse.ts'
import { refreshAccountQuotaPipeline, type QuotaRefreshDeps } from '../features/quota/refresh.ts'
import {
  fetchAvailableModels as fetchAvailableModelsImpl,
  fetchQuotaSummary as fetchQuotaSummaryImpl,
  fetchUserInfo as fetchUserInfoImpl,
  fetchUserQuota as fetchUserQuotaImpl,
  requestQuotaSummaryEndpoint,
  requestUserQuotaEndpoint,
  type QuotaHttpDeps,
} from '../features/quota/http.ts'
import {
  getStoredToken as getStoredTokenImpl,
  getValidAccessToken as getValidAccessTokenImpl,
  isCurrentAccountGrant as isCurrentAccountGrantImpl,
  persistRefreshedToken as persistRefreshedTokenImpl,
  quotaTokenFilePath,
  readSystemKeychainToken as readSystemKeychainTokenImpl,
  type QuotaTokenDeps,
  type RefreshedTokenInput,
} from '../features/quota/token.ts'

export {
  isStale5hBucket,
  mergeFallbackFamilyQuota,
  pickFamilyQuota,
  QUOTA_WINDOW_MATCH_TOLERANCE_MS,
  sameQuotaWindow,
  shouldReleaseOrphanedCooldown,
  summaryHasArgonGroup,
} from '../domain/quota/buckets.ts'
export type { QuotaGroupShape } from '../domain/quota/buckets.ts'
export {
  agyUserAgent,
  AGY_UA_MIN_VERSION,
  normalizeStoredToken,
  sameCredentialGrant,
  staggerJitterMs,
} from '../domain/quota/identity.ts'
export type { StoredToken } from '../domain/quota/identity.ts'
export { OAUTH_USERINFO_URL } from '../features/quota/http.ts'
export {
  readLinuxSecretToken,
  readMacKeychainToken,
  readWindowsCredentialToken,
} from '../features/quota/token.ts'
// Quota backend response shapes live in the pure parse module; keep the two
// historically public types re-exported from here.
export type { UserQuotaBucket, UserQuotaResponse } from '../domain/quota/parse.ts'

export function detectEmailFromAgyLogs(homeDir: string): string | undefined {
  const logDir = join(homeDir, '.gemini', 'antigravity-cli', 'log')
  if (!existsSync(logDir)) return undefined
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.log'))
      .map((f) => ({ name: f, time: statSync(join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 5)

    for (const file of files) {
      try {
        const content = readFileSync(join(logDir, file.name), 'utf8')
        // Logs are append-ordered: the LAST email match is the most recent
        // login. Taking the first match returned a superseded account after
        // an external re-login (observed in the wild), mislabeling the slot.
        const re = /(?:authenticated successfully as|applyAuthResult:\s*email=|"email"\s*:\s*"|User:\s*)\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
        let last: string | undefined
        for (let m = re.exec(content); m !== null; m = re.exec(content)) {
          if (m[1]) last = m[1]
        }
        if (last) return last
      } catch {
        // ignore unreadable log
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

export class QuotaService {
  private preferredEndpointIndex = 0
  /** accountId -> in-flight getValidAccessToken attempt (dedup). */
  private readonly tokenRefreshInFlight = new Map<string, Promise<string | null>>()

  /**
   * @param globalProxy resolves the plugin-wide proxy URL; used when the
   * account has no dedicated proxyUrl. Injected so tests stay network-free.
   */
  constructor(
    private readonly pool: AccountPoolManager,
    private readonly globalProxy: () => string = () => '',
    /**
     * Resolves the installed agy version for the quota/model User-Agent.
     * Injected because the version probe lives in the plugin entry point.
     */
    private readonly agyVersion: () => string | null = () => null,
    /**
     * Optional CLI quota source (`agy -p /usage`). Primary quota source:
     * 100% official binary, real TLS fingerprint, native token refresh by agy Go runtime.
     * REST endpoints serve as secondary fallback when CLI is unavailable.
     */
    private readonly cliDeps: {
      bin?: () => string | null
      preemptAutoUpdate?: () => boolean
      viaCli?: () => boolean
    } = {},
  ) {}

  /** Endpoint preference + protected endpoint fetchers as injected seams. */
  private httpDeps(): QuotaHttpDeps {
    return {
      agyVersion: () => this.agyVersion(),
      getPreferredEndpointIndex: () => this.preferredEndpointIndex,
      setPreferredEndpointIndex: (index) => { this.preferredEndpointIndex = index },
      fetchSummaryEndpoint: (endpoint, accessToken, proxyUrl) => this.fetchSummaryEndpoint(endpoint, accessToken, proxyUrl),
      fetchUserQuotaEndpoint: (endpoint, accessToken, proxyUrl) => this.fetchUserQuotaEndpoint(endpoint, accessToken, proxyUrl),
    }
  }

  /** Credential/keyring seams; overridable methods stay the real boundary. */
  private tokenDeps(): QuotaTokenDeps {
    return {
      pool: this.pool,
      proxyFor: (a) => this.proxyFor(a),
      readSystemKeychainToken: () => this.readSystemKeychainToken(),
      getStoredToken: (a, allow) => this.getStoredToken(a, allow),
      persistRefreshedToken: (a, tokens) => this.persistRefreshedToken(a, tokens),
      readPrimaryCredential: (baseDir) => readPrimaryCredential(baseDir),
      writePrimaryCredential: (cred, baseDir) => writePrimaryCredential(cred, baseDir),
      parseCredentialDoc: (raw) => parseCredentialDoc(raw),
    }
  }

  /**
   * One `agy -p /usage` spawn, mapped onto pool families.
   *
   * SCOPE: only the account that owns the OS credential store. `agy` resolves
   * its credential from the platform keystore (Windows Credential Manager,
   * macOS Keychain, Linux Secret Service) BEFORE the per-HOME token file, and
   * that store is a single per-user entry — so the CLI can only ever answer for
   * one identity no matter which HOME we hand it. Isolated pool accounts never
   * own it, so polling them through the CLI filed the owner's numbers under
   * their rows (2026-10-26: four pool rows showing one account's quota with
   * identical reset instants).
   *
   * That single-owner rule keeps the CLI usage check strictly attributed to the
   * slot owner: isolated accounts fall back to the REST path, which signs with
   * each account's own token and reports authentic quotas (including the dedicated
   * Gemini 4 Argon group for Pro/Ultra plans via the agy User-Agent).
   */
  private async readCliUsageFamilies(
    account: ManagedAccount,
  ): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    const bin = this.cliDeps.bin?.()
    if (!bin) return null
    // Fast reject, no keystore read and no spawn: an isolated account's own
    // directory cannot be the store's owner. This keeps the poll cheap on a
    // multi-account pool and behaves identically on every platform.
    if (account.dir && !account.systemHome) {
      return null
    }

    // On Windows, the OS credential store (gemini:antigravity) is a single shared slot.
    // Secondary runs temporarily swap this slot under credentialSlotMutex. To prevent
    // reading a secondary's numbers or having the slot swapped mid-flight while
    // `agy -p /usage` is running, serialize under credentialSlotMutex.
    let releaseMutex: (() => void) | null = null
    if (process.platform === 'win32') {
      try {
        releaseMutex = await credentialSlotMutex.acquire({
          timeoutMs: 4_000,
          pollMs: 500,
          shouldProceed: () => true,
        })
      } catch {
        // Mutex contention (e.g. secondary account turn active) — fall back to safe REST path immediately
        return null
      }
    }

    try {
      // The owner itself still needs proof: while a secondary runs, the slot is
      // temporarily handed that account's credential, and a CLI read then would
      // return the secondary's numbers under the primary's row.
      if (!(await this.cliSlotHoldsAccount(account))) {
        return null
      }
      const env = buildAgyEnvWithProxy({
        account,
        proxy: pickProxy(account.proxyUrl, this.globalProxy()),
      })
      const groups = await readAgyUsage({
        bin,
        env,
        timeoutMs: 20_000,
        preemptAutoUpdate: this.cliDeps.preemptAutoUpdate?.(),
      })
      return groups === null ? null : usageGroupsToFamilies(groups)
    } finally {
      releaseMutex?.()
    }
  }

  /**
   * True when the machine credential slot provably holds this account's grant.
   *
   * This gates the CLI quota read, which can only ever see the slot owner.
   * Conservative by design: when the two snapshots cannot be shown to be the
   * same grant, the caller falls back to REST rather than risk attributing one
   * account's quota to another.
   */
  private async cliSlotHoldsAccount(account: ManagedAccount): Promise<boolean> {
    const slot = await this.readSystemKeychainToken()
    if (slot === null) return false
    const stored = await this.getStoredToken(account, false)
    if (stored === null) return false
    return sameCredentialGrant(slot, stored)
  }

  /** Dedicated account proxy wins, then the global config proxy, then detected system proxy. */
  private proxyFor(account: ManagedAccount): string | undefined {
    return pickProxy(account.proxyUrl, this.globalProxy())
  }

  private getTokenFilePath(account: ManagedAccount): string {
    return quotaTokenFilePath(account)
  }

  /**
   * Read the system-HOME Keychain credential. Protected so tests (and future
   * platforms) can substitute the reader without touching the real Keychain.
   */
  protected async readSystemKeychainToken(): Promise<StoredToken | null> {
    return readSystemKeychainTokenImpl()
  }

  /**
   * Read the active token document and normalize it to a flat StoredToken.
   *
   * Precedence for the primary / system-HOME account: the macOS Keychain
   * WINS over the on-disk token file. agy >= 1.1.15 keeps its CURRENT
   * credential in the Keychain; the on-disk token file can be a
   * stale leftover from a PREVIOUS account's login (verified live: disk
   * held an old account's token while agy itself was authenticated as
   * someone else — disk-first precedence made every quota refresh fetch the
   * WRONG account's numbers). Isolated pool accounts only ever read their
   * own directory's file; the Keychain is one shared slot they must not see.
   */
  async getStoredToken(account: ManagedAccount, allowKeychainFallback = true): Promise<StoredToken | null> {
    return getStoredTokenImpl(this.tokenDeps(), account, allowKeychainFallback)
  }

  /**
   * Persist a refreshed access token in agy's own on-disk shape.
   *
   * The SHAPE matters: agy >= 1.1.15 writes
   * `{"token":{access_token,token_type,refresh_token,expiry},"auth_method":"consumer"}`
   * and every identity guard keys on `refresh_token`. An earlier version wrote
   * a FLAT `{access_token,expiry}` document when the file did not exist yet,
   * silently DROPPING the refresh token; the credential then had no stable
   * identity, so two snapshots of one account compared as different grants and
   * the corruption guards could not fire.
   */
  private persistRefreshedToken(
    account: ManagedAccount,
    tokens: RefreshedTokenInput,
  ): void {
    persistRefreshedTokenImpl(this.tokenDeps(), account, tokens)
  }

  /**
   * Get a valid access token, refreshing via refresh_token when expired.
   * Uses the public Antigravity client credentials (env-overridable), so
   * refresh works out of the box.
   *
   * Concurrent calls for the SAME account share one in-flight attempt: the
   * poll timer, three manual HTTP entry points and per-account allSettled
   * used to race into duplicate refreshTokens for one account (double
   * risk-control exposure for the same outcome).
   */
  async getValidAccessToken(account: ManagedAccount): Promise<string | null> {
    return getValidAccessTokenImpl(this.tokenDeps(), account, this.tokenRefreshInFlight)
  }

  private isCurrentAccountGrant(account: ManagedAccount, refreshToken: string): boolean {
    return isCurrentAccountGrantImpl(this.tokenDeps(), account, refreshToken)
  }

  /**
   * Query live user info (email) from Google OAuth userinfo endpoint.
   */
  async fetchUserInfo(accessToken: string, proxyUrl?: string): Promise<{ email?: string; name?: string } | null> {
    return fetchUserInfoImpl(accessToken, proxyUrl)
  }

  protected async fetchSummaryEndpoint(endpoint: string, accessToken: string, proxyUrl?: string): Promise<Response> {
    return requestQuotaSummaryEndpoint(endpoint, accessToken, proxyUrl, this.agyVersion())
  }

  /**
   * Fetch official multi-bucket quota summary (both weekly and 5h limit windows)
   * via v1internal:retrieveUserQuotaSummary.
   */
  async fetchQuotaSummary(accessToken: string, proxyUrl?: string): Promise<QuotaSummaryResponse | null> {
    return fetchQuotaSummaryImpl(this.httpDeps(), accessToken, proxyUrl)
  }

  protected async fetchUserQuotaEndpoint(endpoint: string, accessToken: string, proxyUrl?: string): Promise<Response> {
    return requestUserQuotaEndpoint(endpoint, accessToken, proxyUrl, this.agyVersion())
  }

  /**
   * Fetch per-model live user quota via v1internal:retrieveUserQuota.
   */
  async fetchUserQuota(accessToken: string, proxyUrl?: string): Promise<UserQuotaResponse | null> {
    return fetchUserQuotaImpl(this.httpDeps(), accessToken, proxyUrl)
  }

  /**
   * Fetch available models and model-level quotas via v1internal:fetchAvailableModels.
   */
  async fetchAvailableModels(accessToken: string, proxyUrl?: string): Promise<DiscoveredModelsResponse | null> {
    return fetchAvailableModelsImpl(this.httpDeps(), accessToken, proxyUrl)
  }

  /**
   * Fetch and aggregate live quota statistics (both 5-hour limit and weekly
   * limit) for a single account across model families.
   *
   * The pipeline itself lives in features/quota/refresh.ts; this method only
   * wires QuotaService's I/O seams (which tests may override) into it, so the
   * public signature and every override point stay unchanged.
   */
  async refreshAccountQuota(account: ManagedAccount, force = false): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    const deps: QuotaRefreshDeps = {
      pool: this.pool,
      shouldUseCli: () => this.cliDeps.viaCli?.() !== false,
      readCliUsageFamilies: (a) => this.readCliUsageFamilies(a),
      getValidAccessToken: (a) => this.getValidAccessToken(a),
      proxyFor: (a) => this.proxyFor(a),
      fetchUserInfo: (token, proxyUrl) => this.fetchUserInfo(token, proxyUrl),
      fetchQuotaSummary: (token, proxyUrl) => this.fetchQuotaSummary(token, proxyUrl),
      fetchAvailableModels: (token, proxyUrl) => this.fetchAvailableModels(token, proxyUrl),
      fetchUserQuota: (token, proxyUrl) => this.fetchUserQuota(token, proxyUrl),
      getTokenFilePath: (a) => this.getTokenFilePath(a),
      detectEmailFromLogs: (home) => detectEmailFromAgyLogs(home),
      readPrimaryCredential: (baseDir) => readPrimaryCredential(baseDir),
      writePrimaryCredential: (cred, baseDir) => writePrimaryCredential(cred, baseDir),
      credentialFingerprint: (raw) => credentialFingerprint(raw),
    }
    return refreshAccountQuotaPipeline(deps, account, force)
  }

  /**
   * Refresh quota statistics for all accounts in the pool.
   * Automatic polling (force=false) skips restricted accounts (disabled /
   * auth-quarantined / in cooldown) so the poller never keeps knocking on
   * Google endpoints for accounts already known to be limited. Manual force
   * refresh from the UI refreshes everything.
   *
   * Before gating, a ZERO-NETWORK identity reconciliation runs for flagged
   * slots: an external `agy logout` + re-login writes the new email into the
   * newest CLI logs, and detecting that locally lets us reset the stale
   * quarantine/cooldowns so the slot rejoins polling — no extra request to
   * Google is made for this check (risk-control neutral).
   */
  async refreshAllQuotas(force = false): Promise<void> {
    let accounts = this.pool.getAccounts()
    if (!force) {
      const now = Date.now()
      for (const acc of accounts) {
        const flagged = acc.authRequired || Object.values(acc.cooldowns ?? {}).some((cd) => cd && cd.cooldownUntil > now)
        if (!acc.systemHome || !flagged) continue
        const home = acc.systemHome || !acc.dir ? homedir() : acc.dir
        let detected: string | undefined
        if (process.platform === 'win32') {
          const stored = readPrimaryCredential(this.pool.dir)
          if (stored?.email) detected = stored.email
        }
        if (!detected) {
          const fromLogs = detectEmailFromAgyLogs(home)
          const siblingEmails = new Set(
            this.pool
              .getAccounts()
              .filter((a) => a.id !== acc.id && a.email)
              .map((a) => a.email!),
          )
          if (fromLogs && !siblingEmails.has(fromLogs)) {
            detected = fromLogs
          }
        }
        if (detected && detected !== acc.email) {
          this.pool.resetAccountIdentity(acc.id, detected)
        }
      }
      // Auth-flagged accounts re-enter the poll once their flag is stale
      // enough: one token-endpoint verification either clears the flag (the
      // common transient false positive) or re-stamps it. This is what makes
      // "needs re-login" self-heal without a manual quota refresh.
      accounts = accounts.filter((acc) => shouldPollAccount(acc) || needsAuthReverify(acc))
      // Background sweeps stay sequential with a 2-second gap. Only the
      // credential-store owner can spawn a CLI now (see readCliUsageFamilies),
      // so this is no longer about CLI contention — it keeps the unattended,
      // hourly REST burst gentle instead. An hourly sweep has no latency budget
      // worth trading that safety margin for; explicit user refreshes below run
      // fully concurrently.
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i]!
        await this.refreshAccountQuota(acc, false).catch(() => null)
        if (i < accounts.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, staggerJitterMs()))
        }
      }
      return
    }
    if (process.platform === 'win32') {
      for (const acc of accounts) {
        await this.refreshAccountQuota(acc, force).catch(() => null)
      }
      return
    }
    await Promise.allSettled(accounts.map((acc) => this.refreshAccountQuota(acc, force)))
  }
}