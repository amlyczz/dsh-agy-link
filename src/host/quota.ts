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
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { readPrimaryCredential, parseCredentialDoc, credentialFingerprint, writePrimaryCredential, credentialSlotMutex } from './credential-slot.ts'
import { readAgyUsage, usageGroupsToFamilies, type AgyUsageGroup } from './agy-usage.ts'
import { supportsSshIsolation } from '../runtime/agy/env.ts'
import { buildAgyEnvWithProxy, pickProxy } from '../runtime/net/account-env.ts'
import { CLI_USAGE_TIMEOUT_RETRY_MS } from '../common/timeouts.ts'
import { CLI_TOKEN_SAFETY_MS, prepareCliToken as prepareCliTokenImpl } from '../features/quota/cli-token.ts'

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
  reverifyFlaggedAccounts,
  sweepPoolQuotas,
  type PoolSweepDeps,
} from '../features/quota/pool-sweep.ts'
import { EndpointHealth } from '../features/quota/endpoint-health.ts'
import {
  fetchAvailableModels as fetchAvailableModelsImpl,
  fetchQuotaSummary as fetchQuotaSummaryImpl,
  fetchUserInfo as fetchUserInfoImpl,
  fetchUserQuota as fetchUserQuotaImpl,
  requestQuotaSummaryEndpoint,
  requestUserQuotaEndpoint,
  type QuotaHttpDeps,
  type QuotaSummaryFailure,
} from '../features/quota/http.ts'
import {
  getStoredToken as getStoredTokenImpl,
  cliTokenSource,
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
   * Recent per-endpoint failures: a quota call that just reset is tried LAST
   * instead of first (see features/quota/endpoint-health.ts for the incident).
   */
  private readonly endpointHealth = new EndpointHealth()
  /** accountId -> refusal behind the last empty summary (drives quotaUnavailable). */
  private readonly summaryFailures = new Map<string, QuotaSummaryFailure | null>()
  /** accountIds with a refresh in flight, so the console can show real progress. */
  private readonly refreshingIds = new Set<string>()
  /** Last raw CLI `/usage` groups per accountId (used for planTier inference). */
  private readonly lastCliUsageGroups = new Map<string, readonly AgyUsageGroup[]>()
  /** accountId -> don't spawn `agy /usage` again before this time (it timed out). */
  private readonly cliUsageSkipUntil = new Map<string, number>()

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
      forceStaggerMs?: () => number
      /** Same-egress parallelism for a manual sweep (default 2; tests use 1). */
      forceConcurrency?: () => number
      /**
       * Push a refreshed credential into the OS store `agy` actually loads.
       * Wired by the host (it needs the credential-slot mutex, which this class
       * already holds here). Left undefined by tests so no unit test can ever
       * write the real machine slot.
       */
      syncSlot?: (account: ManagedAccount) => boolean
      /** Diagnostic sink for the decisions below (the class is otherwise silent). */
      log?: (msg: string) => void
    } = {},
  ) {}

  /** Endpoint preference + protected endpoint fetchers as injected seams. */
  private httpDeps(accountScope?: string): QuotaHttpDeps {
    return {
      agyVersion: () => this.agyVersion(),
      endpointHealth: this.endpointHealth,
      ...(accountScope
        ? {
            accountScope,
            onSummaryFailure: (failure: QuotaSummaryFailure | null) => {
              this.summaryFailures.set(accountScope, failure)
            },
          }
        : {}),
      getPreferredEndpointIndex: () => this.preferredEndpointIndex,
      setPreferredEndpointIndex: (index) => { this.preferredEndpointIndex = index },
      fetchSummaryEndpoint: (endpoint, accessToken, proxyUrl, scope) => this.fetchSummaryEndpoint(endpoint, accessToken, proxyUrl, scope),
      fetchUserQuotaEndpoint: (endpoint, accessToken, proxyUrl, scope) => this.fetchUserQuotaEndpoint(endpoint, accessToken, proxyUrl, scope),
    }
  }

  /** Credential/keyring seams; overridable methods stay the real boundary. */
  private tokenDeps(): QuotaTokenDeps {
    return {
      pool: this.pool,
      proxyFor: (a) => this.proxyFor(a),
      readSystemKeychainToken: () => this.readSystemKeychainToken(),
      getStoredToken: (a, allow) => this.getStoredToken(a, allow),
      persistRefreshedToken: (a, tokens, exp) => this.persistRefreshedToken(a, tokens, exp),
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
    // The CLI path is anti-ban-preferred, but a probe that keeps timing out
    // must not make every "同步" click pay 19s before the REST fallback runs.
    // Skip it for a while after a failure, per account.
    if (Date.now() < (this.cliUsageSkipUntil.get(account.id) ?? 0)) return null
    const isIsolated = Boolean(account.dir && !account.systemHome)
    if (isIsolated) {
      // agy >= 1.5 with SSH_CONNECTION (injected by isolatedHomeEnv) bypasses
      // the shared OS keyring / Windows Credential Manager and reads ONLY this
      // account's isolated token file (verified live on Windows agy 1.5.12).
      // Also safe on Linux/macOS where D-Bus / per-HOME isolation applies for
      // free accounts (`no_summary_access`, issue #143).
      const canIsolateCli =
        supportsSshIsolation(this.agyVersion()) ||
        (process.platform !== 'win32' && account.quotaUnavailable?.reason === 'no_summary_access')
      if (!canIsolateCli) return null
      if (!(await this.prepareCliToken(account, false))) return null
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
      if (groups === null) {
        this.cliUsageSkipUntil.set(account.id, Date.now() + CLI_USAGE_TIMEOUT_RETRY_MS)
        return null
      }
      this.cliUsageSkipUntil.delete(account.id)
      this.lastCliUsageGroups.set(account.id, groups)
      return usageGroupsToFamilies(groups)
    }

    let releaseMutex: (() => void) | null = null
    if (process.platform === 'win32') {
      try {
        releaseMutex = await credentialSlotMutex.acquire({
          timeoutMs: 4_000,
          pollMs: 500,
          shouldProceed: () => true,
        })
      } catch {
        return null
      }
    }

    try {
      if (!(await this.cliSlotHoldsAccount(account))) {
        return null
      }
      if (!(await this.prepareCliToken(account))) {
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
      if (groups === null) {
        this.cliUsageSkipUntil.set(account.id, Date.now() + CLI_USAGE_TIMEOUT_RETRY_MS)
        return null
      }
      this.cliUsageSkipUntil.delete(account.id)
      this.lastCliUsageGroups.set(account.id, groups)
      return usageGroupsToFamilies(groups)
    } finally {
      releaseMutex?.()
    }
  }

  /** Same safety-window prep for an SSH-isolated account run elsewhere (external lease): it reads only its own token file, so the slot is never written. */
  prepareIsolatedCliToken(account: ManagedAccount): Promise<boolean> {
    return this.prepareCliToken(account, false)
  }

  /**
   * Bring the credential `agy` would load into the safety window, or refuse.
   *
   * The CLI is only ever used for the slot owner, so a refresh here refreshes
   * the identity that is about to run — no cross-account risk. On Windows the
   * refreshed token also has to reach the Credential Manager slot, because that
   * is what agy loads (the on-disk document is only a mirror); `syncSlot` does
   * that and is wired by the host, which owns the mutex we are already holding.
   */
  /**
   * The credential agy will load for a CLI quota read. On Windows the
   * system-HOME primary loads the Credential Manager slot, not the on-disk
   * mirror; the safety gate must inspect that (issue #199).
   */
  private async readCliLoadedToken(account: ManagedAccount): Promise<StoredToken | null> {
    if (cliTokenSource(process.platform, account) === 'slot') {
      const slot = await this.readSystemKeychainToken()
      if (slot && (slot.accessToken || slot.refreshToken)) return slot
    }
    return this.getStoredToken(account, true)
  }

  private async prepareCliToken(account: ManagedAccount, withSlotSync = true): Promise<boolean> {
    const syncSlot = withSlotSync ? this.cliDeps.syncSlot : undefined;
    return prepareCliTokenImpl({
      // Inspect the credential agy will actually load, not the mirror (issue #199).
      readStored: () => this.readCliLoadedToken(account),
      // Ask for the SAME window the gate below enforces: the default 60s buffer
      // would hand back a token that the re-read then rejects, wasting a
      // refresh round-trip and skipping the CLI anyway.
      refresh: async () => (await this.getValidAccessToken(account, CLI_TOKEN_SAFETY_MS)) !== null,
      ...(syncSlot === undefined ? {} : { syncSlot: () => syncSlot(account) }),
      ...(this.cliDeps.log === undefined ? {} : { log: this.cliDeps.log }),
    })
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
    if (stored !== null) return sameCredentialGrant(slot, stored)
    // Native `agy` sign-in on Linux/macOS stores credentials ONLY in the OS
    // keyring with no `~/.gemini/antigravity-cli/antigravity-oauth-token` file
    // on disk (issue #143 `branch: "stored-null"`). For the systemHome primary
    // account on non-Windows (where secondaries never swap the global slot),
    // verify the slot does not belong to any sibling isolated account.
    if (account.systemHome && process.platform !== 'win32') {
      for (const other of this.pool.getAccounts()) {
        if (other.id === account.id || !other.dir || other.systemHome) continue
        const sibling = await this.getStoredToken(other, false)
        if (sibling !== null && sameCredentialGrant(slot, sibling)) return false
      }
      return true
    }
    return false
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
    expectedRefreshToken?: string,
  ): void {
    persistRefreshedTokenImpl(this.tokenDeps(), account, tokens, expectedRefreshToken)
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
  async getValidAccessToken(account: ManagedAccount, minValidityMs?: number): Promise<string | null> {
    return getValidAccessTokenImpl(this.tokenDeps(), account, this.tokenRefreshInFlight, minValidityMs)
  }

  private isCurrentAccountGrant(account: ManagedAccount, refreshToken: string): boolean {
    return isCurrentAccountGrantImpl(this.tokenDeps(), account, refreshToken)
  }

  /**
   * Query live user info (email) from Google OAuth userinfo endpoint.
   */
  async fetchUserInfo(accessToken: string, proxyUrl?: string, accountScope?: string): Promise<{ email?: string; name?: string } | null> {
    return fetchUserInfoImpl(accessToken, proxyUrl, accountScope)
  }

  protected async fetchSummaryEndpoint(endpoint: string, accessToken: string, proxyUrl?: string, accountScope?: string): Promise<Response> {
    return requestQuotaSummaryEndpoint(endpoint, accessToken, proxyUrl, this.agyVersion(), accountScope)
  }

  /**
   * Fetch official multi-bucket quota summary (both weekly and 5h limit windows)
   * via v1internal:retrieveUserQuotaSummary.
   */
  async fetchQuotaSummary(accessToken: string, proxyUrl?: string, accountScope?: string): Promise<QuotaSummaryResponse | null> {
    return fetchQuotaSummaryImpl(this.httpDeps(accountScope), accessToken, proxyUrl)
  }

  protected async fetchUserQuotaEndpoint(endpoint: string, accessToken: string, proxyUrl?: string, accountScope?: string): Promise<Response> {
    return requestUserQuotaEndpoint(endpoint, accessToken, proxyUrl, this.agyVersion(), accountScope)
  }

  /**
   * Fetch per-model live user quota via v1internal:retrieveUserQuota.
   */
  async fetchUserQuota(accessToken: string, proxyUrl?: string, accountScope?: string): Promise<UserQuotaResponse | null> {
    return fetchUserQuotaImpl(this.httpDeps(accountScope), accessToken, proxyUrl)
  }

  /**
   * Fetch available models and model-level quotas via v1internal:fetchAvailableModels.
   */
  async fetchAvailableModels(accessToken: string, proxyUrl?: string, accountScope?: string): Promise<DiscoveredModelsResponse | null> {
    return fetchAvailableModelsImpl(this.httpDeps(accountScope), accessToken, proxyUrl)
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
    if (force) this.refreshingIds.add(account.id)
    this.summaryFailures.delete(account.id)
    try {
      return await this.runQuotaPipeline(account, force)
    } finally {
      if (force) this.refreshingIds.delete(account.id)
    }
  }

  /** Account ids with a quota refresh in flight (the console renders "同步中" from this). */
  refreshingAccounts(): string[] {
    return [...this.refreshingIds]
  }

  private async runQuotaPipeline(account: ManagedAccount, force: boolean): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    const deps: QuotaRefreshDeps = {
      pool: this.pool,
      shouldUseCli: () => this.cliDeps.viaCli?.() !== false,
      readCliUsageFamilies: (a) => this.readCliUsageFamilies(a),
      getValidAccessToken: (a) => this.getValidAccessToken(a),
      proxyFor: (a) => this.proxyFor(a),
      fetchUserInfo: (token, proxyUrl) => this.fetchUserInfo(token, proxyUrl, account.id),
      fetchQuotaSummary: (token, proxyUrl) => this.fetchQuotaSummary(token, proxyUrl, account.id),
      fetchAvailableModels: (token, proxyUrl) => this.fetchAvailableModels(token, proxyUrl, account.id),
      fetchUserQuota: (token, proxyUrl) => this.fetchUserQuota(token, proxyUrl, account.id),
      getTokenFilePath: (a) => this.getTokenFilePath(a),
      detectEmailFromLogs: (home) => detectEmailFromAgyLogs(home),
      readPrimaryCredential: (baseDir) => readPrimaryCredential(baseDir),
      writePrimaryCredential: (cred, baseDir) => writePrimaryCredential(cred, baseDir),
      credentialFingerprint: (raw) => credentialFingerprint(raw),
      summaryFailure: () => this.summaryFailures.get(account.id) ?? null,
      lastCliUsageGroups: () => this.lastCliUsageGroups.get(account.id),
    }
    return refreshAccountQuotaPipeline(deps, account, force)
  }

  /**
   * Refresh quota statistics for all accounts in the pool (hourly background
   * poll, or a user-triggered sweep). Scheduling lives in features/quota/pool-sweep.ts;
   * this method only supplies the I/O seams.
   */
  async refreshAllQuotas(force = false): Promise<void> {
    await sweepPoolQuotas(this.sweepDeps(), force)
  }

  /**
   * Fast self-heal for 需重新登录 flags (2-minute timer, 2m → 30m back-off):
   * a false positive clears in one request, a dead login backs off.
   */
  async reverifyFlaggedAccounts(): Promise<void> {
    await reverifyFlaggedAccounts(this.sweepDeps())
  }

  /** I/O seams for the pool-wide passes. */
  private sweepDeps(): PoolSweepDeps {
    return {
      pool: this.pool,
      refreshAccountQuota: (account, force) => this.refreshAccountQuota(account, force),
      proxyOf: (account) => this.proxyFor(account),
      detectEmailFromLogs: (home) => detectEmailFromAgyLogs(home),
      readStoredPrimaryEmail: () => readPrimaryCredential(this.pool.dir)?.email,
      systemHome: () => homedir(),
      ...(this.cliDeps.forceStaggerMs === undefined ? {} : { forceStaggerMs: this.cliDeps.forceStaggerMs }),
      ...(this.cliDeps.forceConcurrency === undefined ? {} : { forceConcurrency: this.cliDeps.forceConcurrency }),
    }
  }
}