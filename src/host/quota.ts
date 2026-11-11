// QuotaService: fetch and refresh live quota statistics and user profile
// directly from Google Antigravity backend (v1internal:fetchAvailableModels).
//
// Security note: NO OAuth client credentials are hard-coded here. agy 1.1.15
// stores credentials in the macOS Keychain (Antigravity Safe Storage) and we
// never attempt to re-exchange tokens with a guessed client id/secret — a
// wrong client pair makes Google return invalid_client and surfaces as
// "API key is invalid" in the UI. Quota refresh degrades silently to
// "unavailable" when credentials cannot be sourced.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  needsAuthReverify,
  shouldPollAccount,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import { shouldMarkAuthRequired } from '../common/types.ts'
import type { AccountPoolManager } from './pool.ts'
import { AGY_ENDPOINTS, refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'
import { readWindowsCredentialRaw } from './wincred.ts'
import { parseCredentialDoc, credentialFingerprint, readPrimaryCredential, writePrimaryCredential, credentialSlotMutex } from './credential-slot.ts'
import { readAgyUsage, usageGroupsToFamilies } from './agy-usage.ts'
import { buildAgyEnvWithProxy, pickProxy } from '../runtime/net/account-env.ts'

import {
  agyUserAgent,
  normalizeStoredToken,
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

export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

// Quota backend response shapes live in the pure parse module; keep the two
// historically public types re-exported from here.
export type { UserQuotaBucket, UserQuotaResponse } from '../domain/quota/parse.ts'

/**
 * Parse a go-keyring payload (optionally "go-keyring-base64:" prefixed) into
 * a normalized StoredToken. Shared by the macOS and Linux keyring readers.
 */
function parseGoKeyringPayload(raw: string): StoredToken | null {
  let jsonStr = raw
  if (raw.startsWith('go-keyring-base64:')) {
    const b64 = raw.slice('go-keyring-base64:'.length)
    jsonStr = Buffer.from(b64, 'base64').toString('utf8')
  }
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    const tok = normalizeStoredToken(parsed)
    return tok && (tok.accessToken || tok.refreshToken) ? tok : null
  } catch {
    return null
  }
}

/**
 * Promisified execFile with a hard timeout. The keyring readers used to run
 * execFileSync, so a locked Keychain prompt or a slow PowerShell cold start
 * (up to 8s) froze the WHOLE DSH event loop on every quota poll — the service
 * runs inside the host process. Async with a timeout keeps the host live.
 */
function execFileT(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err !== null && err !== undefined) reject(err)
      else resolve(typeof stdout === 'string' ? stdout : String(stdout))
    })
  })
}

/**
 * Reads the active primary Antigravity OAuth token from the Linux Secret
 * Service (GNOME Keyring / KDE Wallet via FreeDesktop secrets). agy 1.1.15+
 * on Linux stores primary credentials via go-keyring under service "gemini"
 * / username "antigravity" — the same JSON shape as the macOS Keychain.
 * GH #8: without this reader, Linux quota resolution always returned null.
 */
export async function readLinuxSecretToken(): Promise<StoredToken | null> {
  if (process.platform !== 'linux') return null

  // 1. secret-tool (standard libsecret CLI) when available.
  try {
    const raw = (await execFileT('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], 3000)).trim()
    if (raw) {
      const tok = parseGoKeyringPayload(raw)
      if (tok) return tok
    }
  } catch {
    // fall through to the DBus fallback
  }

  // 2. Direct Secret Service query via python3 + dbus (preinstalled on most
  //    desktop distros). Matches go-keyring's attribute pair exactly.
  const pyScript = [
    'import dbus, sys',
    'try:',
    '    bus = dbus.SessionBus()',
    '    svc = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")',
    '    iface = dbus.Interface(svc, "org.freedesktop.Secret.Service")',
    '    sp = iface.OpenSession("plain", "")[1]',
    '    res = iface.SearchItems({"service": "gemini", "username": "antigravity"})',
    '    if res and res[0]:',
    '        item = bus.get_object("org.freedesktop.secrets", res[0][0])',
    '        sec = dbus.Interface(item, "org.freedesktop.Secret.Item").GetSecret(sp)',
    '        sys.stdout.write(bytes(sec[2]).decode("utf-8"))',
    'except Exception:',
    '    pass',
  ].join('\n')
  for (const pyBin of ['python3', 'python']) {
    try {
      const raw = (await execFileT(pyBin, ['-c', pyScript], 4000)).trim()
      if (raw) {
        const tok = parseGoKeyringPayload(raw)
        if (tok) return tok
      }
    } catch {
      // try next interpreter
    }
  }
  return null
}

/**
 * Reads the active primary Antigravity OAuth token from the macOS Keychain.
 * agy 1.1.15+ on macOS stores primary credentials via go-keyring in the Keychain
 * under service "gemini" / account "antigravity" (base64-encoded JSON).
 */
export async function readMacKeychainToken(): Promise<StoredToken | null> {
  if (process.platform !== 'darwin') return null
  try {
    const home = homedir()
    const candidates = [
      join(home, 'Library', 'Keychains', 'login.keychain-db'),
      join(home, 'Library', 'Keychains', 'login.keychain'),
    ]
    const targetKc = candidates.find((p) => existsSync(p))
    const args = ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w']
    if (targetKc) args.push(targetKc)
    const raw = (await execFileT('security', args, 3000)).trim()
    if (!raw) return null
    return parseGoKeyringPayload(raw)
  } catch {
    return null
  }
}

/**
 * Read the primary Antigravity OAuth token from Windows Credential Manager.
 * agy on Windows stores it via go-keyring under target `gemini:antigravity`
 * (user `antigravity`) as a UTF-8 JSON blob with the same shape as macOS
 * Keychain / Linux Secret Service. Without this reader the quota panel stays
 * empty on Windows: the on-disk `antigravity-oauth-token` file is often
 * absent while agy itself still authenticates via CredRead (issue #30).
 */
export async function readWindowsCredentialToken(): Promise<StoredToken | null> {
  if (process.platform !== 'win32') return null
  try {
    const raw = readWindowsCredentialRaw('gemini:antigravity')
    if (!raw) return null
    return parseGoKeyringPayload(raw)
  } catch {
    return null
  }
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
    // The primary account rides the real system HOME (Keychain-backed);
    // only secondary accounts have an isolated dir.
    const home = account.systemHome || !account.dir ? homedir() : account.dir
    return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  }

  /**
   * Read the system-HOME Keychain credential. Protected so tests (and future
   * platforms) can substitute the reader without touching the real Keychain.
   */
  protected async readSystemKeychainToken(): Promise<StoredToken | null> {
    if (process.platform === 'darwin') return readMacKeychainToken()
    if (process.platform === 'linux') return readLinuxSecretToken()
    if (process.platform === 'win32') return readWindowsCredentialToken()
    return null
  }

  /**
   * Read the active token document and normalize it to a flat StoredToken.
   *
   * Precedence for the primary / system-HOME account: the macOS Keychain
   * WINS over the on-disk token file. agy >= 1.1.15 keeps its CURRENT
   * credential in the Keychain; the on-disk antigravity-oauth-token can be a
   * stale leftover from a PREVIOUS account's login (verified live: disk
   * held an old account's token while agy itself was authenticated as
   * someone else — disk-first precedence made every quota refresh fetch the
   * WRONG account's numbers). Isolated pool accounts only ever read their
   * own directory's file; the Keychain is one shared slot they must not see.
   */
  async getStoredToken(account: ManagedAccount, allowKeychainFallback = true): Promise<StoredToken | null> {
    const disk = (() => {
      const file = this.getTokenFilePath(account)
      if (!existsSync(file)) return null
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const tok = normalizeStoredToken(raw)
        if (tok && (tok.accessToken || tok.refreshToken)) return tok
      } catch {
        // corrupted disk file — treat as absent
      }
      return null
    })()

    if (account.systemHome || !account.dir) {
      // Windows has no per-account Keychain: the primary rides ONE global
      // credential slot that is temporarily handed to a secondary during its
      // run. Reading that slot while it is handed over would report whichever
      // account currently owns it — the cause of the primary row displaying a
      // secondary's quota and of manual refresh "replacing" the main account.
      // The durable store is only ever written from an identity-verified
      // primary source, so it wins; the slot is the fallback for a pool that
      // has not been verified yet.
      if (process.platform === 'win32') {
        const stored = readPrimaryCredential(this.pool.dir)
        const storedToken = stored ? parseCredentialDoc(stored.raw) : null
        if (storedToken && (storedToken.accessToken || storedToken.refreshToken)) {
          return storedToken
        }
      }
      // main keeps this read async (execFileSync used to freeze the event loop
      // on every poll) — the durable-store check above stays synchronous.
      if (allowKeychainFallback) {
        const keychainToken = await this.readSystemKeychainToken()
        if (keychainToken && (keychainToken.accessToken || keychainToken.refreshToken)) {
          return keychainToken
        }
      }
    }

    return disk
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
    tokens: { access_token: string; expiryMs?: number; refresh_token?: string },
  ): void {
    const file = this.getTokenFilePath(account)
    try {
      mkdirSync(dirname(file), { recursive: true })
      let existing: Record<string, unknown> = {}
      if (existsSync(file)) {
        try {
          existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        } catch {
          existing = {}
        }
      }
      // Accept either shape on input, always emit agy's nested shape.
      const source =
        typeof existing.token === 'object' && existing.token !== null
          ? (existing.token as Record<string, unknown>)
          : existing
      const refreshToken =
        tokens.refresh_token ??
        (typeof source.refresh_token === 'string' ? source.refresh_token : undefined) ??
        (typeof source.refreshToken === 'string' ? source.refreshToken : undefined)
      const expiryIso = tokens.expiryMs ? new Date(tokens.expiryMs).toISOString() : undefined
      const doc = {
        token: {
          access_token: tokens.access_token,
          token_type: typeof source.token_type === 'string' ? source.token_type : 'Bearer',
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
          ...(expiryIso ? { expiry: expiryIso } : { expiry: source.expiry }),
        },
        auth_method: typeof existing.auth_method === 'string' ? existing.auth_method : 'consumer',
      }
      // Keep their shape-preserving write, but hold main's 0600 hardening.
      writeFileSync(file, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Best-effort
    }

    // On Windows the primary's authoritative copy is the durable slot store:
    // agy authenticates from Credential Manager, not from this file. Re-adopt
    // the canonical file we just wrote, but only when it still carries a
    // refresh token — the store must never be degraded back to an
    // unidentifiable document.
    if (process.platform === 'win32' && (account.systemHome || !account.dir)) {
      try {
        const fresh = readFileSync(file, 'utf8')
        if (parseCredentialDoc(fresh)?.refreshToken) {
          const stored = readPrimaryCredential(this.pool.dir)
          writePrimaryCredential(
            { raw: fresh, email: stored?.email, savedAt: Date.now() },
            this.pool.dir,
          )
        }
      } catch {
        // best-effort
      }
    }
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
    const existing = this.tokenRefreshInFlight.get(account.id)
    if (existing !== undefined) return existing
    const attempt = this.getValidAccessTokenUncached(account).finally(() => {
      this.tokenRefreshInFlight.delete(account.id)
    })
    this.tokenRefreshInFlight.set(account.id, attempt)
    return attempt
  }

  private async getValidAccessTokenUncached(account: ManagedAccount): Promise<string | null> {
    const tok = await this.getStoredToken(account)
    if (!tok) return null

    // Still fresh (with 60s buffer)? Use it directly.
    if (tok.accessToken && (!tok.expiryMs || tok.expiryMs > Date.now() + 60_000)) {
      return tok.accessToken
    }

    // Expired or missing access token — refresh if we have a refresh_token
    if (tok.refreshToken) {
      try {
        const refreshed = await refreshTokens(tok.refreshToken, this.proxyFor(account))
        if (!this.isCurrentAccountGrant(account, tok.refreshToken)) return null
        if (refreshed?.access_token) {
          this.persistRefreshedToken(account, {
            access_token: refreshed.access_token,
            expiryMs: refreshed.expiryMs,
            // Carry the grant identity forward — losing it made the credential
            // unidentifiable and disabled every corruption guard.
            refresh_token: refreshed.refresh_token ?? tok.refreshToken,
          })
          if (account.authRequired) {
            this.pool.clearAuthRequired(account.id)
          }
          return refreshed.access_token
        }
      } catch (err: unknown) {
        if (!this.isCurrentAccountGrant(account, tok.refreshToken)) return null
        const errMsg = String(err)
        // Only authoritative OAuth states flag the account; a bare 400
        // (captive portal / proxy error page) or a transport failure must not.
        if (shouldMarkAuthRequired(undefined, errMsg)) {
          this.pool.markAuthRequired(account.id, errMsg)
        }
      }
    }

    return tok.accessToken || null
  }

  private isCurrentAccountGrant(account: ManagedAccount, refreshToken: string): boolean {
    if (account.systemHome || !account.dir) return true
    try {
      return parseCredentialDoc(readFileSync(this.getTokenFilePath(account), 'utf8'))?.refreshToken === refreshToken
    } catch {
      return false
    }
  }

  /**
   * Query live user info (email) from Google OAuth userinfo endpoint.
   */
  async fetchUserInfo(accessToken: string, proxyUrl?: string): Promise<{ email?: string; name?: string } | null> {
    try {
      const res = await agyFetch(OAUTH_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, proxyUrl)
      if (res.ok) {
        return (await res.json()) as { email?: string; name?: string }
      }
    } catch {
      // Ignore userinfo fetch errors
    }
    return null
  }

  /**
   * Re-order endpoints so the preferred/working endpoint is tried first.
   */
  private getOrderedEndpoints(): string[] {
    const total = AGY_ENDPOINTS.length
    const ordered: string[] = []
    for (let i = 0; i < total; i++) {
      ordered.push(AGY_ENDPOINTS[(this.preferredEndpointIndex + i) % total]!)
    }
    return ordered
  }

  protected async fetchSummaryEndpoint(endpoint: string, accessToken: string, proxyUrl?: string): Promise<Response> {
    return agyFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': agyUserAgent(this.agyVersion()),
      },
      body: JSON.stringify({}),
    }, proxyUrl)
  }

  /**
   * Fetch official multi-bucket quota summary (both weekly and 5h limit windows)
   * via v1internal:retrieveUserQuotaSummary.
   */
  async fetchQuotaSummary(accessToken: string, proxyUrl?: string): Promise<QuotaSummaryResponse | null> {
    const endpoints = this.getOrderedEndpoints()
    let partialSummary: QuotaSummaryResponse | null = null
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!
      try {
        const res = await this.fetchSummaryEndpoint(endpoint, accessToken, proxyUrl)
        if (res.ok) {
          const summary = (await res.json()) as QuotaSummaryResponse
          // Validate whether the summary contains the primary Gemini models group.
          // Older clients or endpoints omitting Gemini models fall through to the next endpoint.
          const hasGemini = summary?.groups?.some((g) => {
            const name = (g.displayName || '').toLowerCase()
            const desc = (g.description || '').toLowerCase()
            return name.includes('gemini') || desc.includes('gemini')
          })
          if (hasGemini) {
            if (partialSummary && Array.isArray(partialSummary.groups)) {
              // Merge groups: keep 3P groups from daily endpoint, add Gemini models from fallback
              const existingNames = new Set(partialSummary.groups.map((g) => (g.displayName || '').toLowerCase()))
              for (const g of summary.groups || []) {
                const name = (g.displayName || '').toLowerCase()
                if (!existingNames.has(name)) {
                  partialSummary.groups.push(g)
                  existingNames.add(name)
                }
              }
              return partialSummary
            }
            if (i > 0 && !partialSummary) {
              this.preferredEndpointIndex = AGY_ENDPOINTS.indexOf(endpoint)
            }
            return summary
          }
          if (!partialSummary && summary && Array.isArray(summary.groups) && summary.groups.length > 0) {
            partialSummary = summary
          }
        }
        // If auth fails (401/403), the token itself is invalid/expired — no need to flood other endpoints
        if (res.status === 401 || res.status === 403) {
          break
        }
      } catch {
        // Try next endpoint on network connection errors
      }
    }
    return partialSummary
  }

  protected async fetchUserQuotaEndpoint(endpoint: string, accessToken: string, proxyUrl?: string): Promise<Response> {
    return agyFetch(`${endpoint}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': agyUserAgent(this.agyVersion()),
      },
      body: JSON.stringify({}),
    }, proxyUrl)
  }

  /**
   * Fetch per-model live user quota via v1internal:retrieveUserQuota.
   */
  async fetchUserQuota(accessToken: string, proxyUrl?: string): Promise<UserQuotaResponse | null> {
    const endpoints = this.getOrderedEndpoints()
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!
      try {
        const res = await this.fetchUserQuotaEndpoint(endpoint, accessToken, proxyUrl)
        if (res.ok) {
          return (await res.json()) as UserQuotaResponse
        }
        if (res.status === 401 || res.status === 403) {
          break
        }
      } catch {
        // Try next endpoint
      }
    }
    return null
  }

  /**
   * Fetch available models and model-level quotas via v1internal:fetchAvailableModels.
   */
  async fetchAvailableModels(accessToken: string, proxyUrl?: string): Promise<DiscoveredModelsResponse | null> {
    const endpoints = this.getOrderedEndpoints()
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!
      try {
        const res = await agyFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': agyUserAgent(this.agyVersion()),
          },
          body: JSON.stringify({}),
        }, proxyUrl)
        if (res.ok) {
          if (AGY_ENDPOINTS.indexOf(endpoint) === 0) {
            this.preferredEndpointIndex = 0
          }
          return (await res.json()) as DiscoveredModelsResponse
        }
        if (res.status === 401 || res.status === 403) {
          break
        }
      } catch {
        // Try next endpoint
      }
    }
    return null
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

