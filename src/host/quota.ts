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
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  modelFamilyOf,
  shouldPollAccount,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
  type ModelQuotaInfo,
} from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { AGY_ENDPOINTS, refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'

/**
 * When the quota-summary endpoint transiently fails, per-model fallback
 * data carries a SINGLE window (sometimes the weekly one) and no weekly
 * fields. Overwriting a previously COMPLETE family entry with that partial
 * shape dropped weeklyFraction to none and put wrong-window numbers into
 * the 5h row (observed: 5h=100% / reset a week out / weekly missing).
 * Rule: last-known-good complete data always wins over partial fallback.
 */
export function mergeFallbackFamilyQuota(
  prev: FamilyQuotaInfo | undefined,
  fallback: FamilyQuotaInfo,
): FamilyQuotaInfo {
  if (prev && typeof prev.remainingFraction === 'number') return prev
  return fallback
}

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

/** Platform-faithful agy User-Agent (hardcoding darwin/arm64 on Windows is a bad fingerprint). */
export function agyUserAgent(version = '1.1.15'): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  return `antigravity/${version} ${os}/${arch}`
}

/**
 * Raw on-disk token document. agy >= 1.1.15 writes a NESTED shape:
 *   {"token": {access_token, token_type, refresh_token, expiry}, "auth_method": "consumer"}
 * where expiry is a local ISO-8601 STRING ("2026-08-20T16:44:43.782+08:00").
 * Older and third-party writers use a flat shape with epoch millis.
 * Reading the nested `token` object as if it were the access token string
 * produced "Authorization: Bearer [object Object]" and silently broke every
 * quota fetch (UI permanently stuck at the 100% default) — hence the strict
 * type validation below.
 */
export interface StoredToken {
  accessToken?: string
  refreshToken?: string
  /** Epoch milliseconds, parsed from either ISO strings or numbers. */
  expiryMs?: number
}

/** Coerce an expiry value (ISO string, epoch millis, or epoch seconds) to ms. */
function parseExpiryMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds look like 1.7e9; millis like 1.7e12.
    return value < 1e11 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * Normalize the on-disk token document (nested agy shape or flat legacy
 * shape) to a flat StoredToken. Returns null when no usable string access
 * token is present.
 */
export function normalizeStoredToken(raw: Record<string, unknown>): StoredToken | null {
  const nested = raw.token
  const source: Record<string, unknown> =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : raw
  const accessToken = stringField(source, 'access_token', 'accessToken')
  const refreshToken =
    stringField(source, 'refresh_token', 'refreshToken') ??
    (source === raw ? undefined : stringField(raw, 'refresh_token', 'refreshToken'))
  const expiryMs =
    parseExpiryMs(source.expiry) ??
    parseExpiryMs(source.expiresAt) ??
    parseExpiryMs(source.expires_in ? Date.now() / 1000 + Number(source.expires_in) : undefined) ??
    parseExpiryMs(raw.expiry)
  if (!accessToken) return null
  return { accessToken, refreshToken, expiryMs }
}

interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

interface DiscoveredModelsResponse {
  models?: Record<string, DiscoveredModelEntry>
}

interface QuotaSummaryBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  description?: string
  remainingFraction?: number
}

interface QuotaSummaryGroup {
  displayName?: string
  description?: string
  buckets?: QuotaSummaryBucket[]
}

interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[]
  description?: string
}

/**
 * Reads the active primary Antigravity OAuth token from the macOS Keychain.
 * agy 1.1.15+ on macOS stores primary credentials via go-keyring in the Keychain
 * under service "gemini" / account "antigravity" (base64-encoded JSON).
 */
export function readMacKeychainToken(): StoredToken | null {
  if (process.platform !== 'darwin') return null
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!raw) return null
    let jsonStr = raw
    if (raw.startsWith('go-keyring-base64:')) {
      const b64 = raw.slice('go-keyring-base64:'.length)
      jsonStr = Buffer.from(b64, 'base64').toString('utf8')
    }
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    return normalizeStoredToken(parsed)
  } catch {
    return null
  }
}

export class QuotaService {
  private preferredEndpointIndex = 0

  constructor(private readonly pool: AccountPoolManager) {}

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
  protected readSystemKeychainToken(): StoredToken | null {
    return readMacKeychainToken()
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
  getStoredToken(account: ManagedAccount): StoredToken | null {
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
      const keychainToken = this.readSystemKeychainToken()
      if (keychainToken && (keychainToken.accessToken || keychainToken.refreshToken)) {
        return keychainToken
      }
    }

    return disk
  }

  /** Persist refreshed tokens back in the SAME on-disk shape agy wrote. */
  private persistRefreshedToken(account: ManagedAccount, tokens: { access_token: string; expiryMs?: number }): void {
    const file = this.getTokenFilePath(account)
    try {
      mkdirSync(dirname(file), { recursive: true })
      let raw: Record<string, unknown> = {}
      if (existsSync(file)) {
        try {
          raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        } catch {
          raw = {}
        }
      }
      const expiryIso = tokens.expiryMs ? new Date(tokens.expiryMs).toISOString() : undefined
      if (raw && typeof raw.token === 'object' && raw.token !== null) {
        const nested = raw.token as Record<string, unknown>
        nested.access_token = tokens.access_token
        if (expiryIso) nested.expiry = expiryIso
      } else {
        raw.access_token = tokens.access_token
        if (tokens.expiryMs) raw.expiry = tokens.expiryMs
      }
      writeFileSync(file, JSON.stringify(raw), 'utf8')
    } catch {
      // Best-effort
    }
  }

  /**
   * Get a valid access token, refreshing via refresh_token when expired.
   * Uses the public Antigravity client credentials (env-overridable), so
   * refresh works out of the box.
   */
  async getValidAccessToken(account: ManagedAccount): Promise<string | null> {
    const tok = this.getStoredToken(account)
    if (!tok) return null

    // Still fresh (with 60s buffer)? Use it directly.
    if (tok.accessToken && (!tok.expiryMs || tok.expiryMs > Date.now() + 60_000)) {
      return tok.accessToken
    }

    // Expired or missing access token — refresh if we have a refresh_token
    if (tok.refreshToken) {
      try {
        const refreshed = await refreshTokens(tok.refreshToken, account.proxyUrl)
        if (refreshed?.access_token) {
          this.persistRefreshedToken(account, {
            access_token: refreshed.access_token,
            expiryMs: refreshed.expiryMs,
          })
          if (account.authRequired) {
            this.pool.clearAuthRequired(account.id)
          }
          return refreshed.access_token
        }
      } catch (err: unknown) {
        const errMsg = String(err)
        if (/invalid_grant|revoked|disabled|unauthorized_client|token endpoint 400/i.test(errMsg)) {
          this.pool.markAuthRequired(account.id, errMsg)
        }
      }
    }

    return tok.accessToken || null
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

  /**
   * Fetch official multi-bucket quota summary (both weekly and 5h limit windows)
   * via v1internal:retrieveUserQuotaSummary.
   */
  async fetchQuotaSummary(accessToken: string, proxyUrl?: string): Promise<QuotaSummaryResponse | null> {
    const endpoints = this.getOrderedEndpoints()
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!
      try {
        const res = await agyFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': agyUserAgent(),
          },
          body: JSON.stringify({}),
        }, proxyUrl)
        if (res.ok) {
          this.preferredEndpointIndex = AGY_ENDPOINTS.indexOf(endpoint)
          return (await res.json()) as QuotaSummaryResponse
        }
        // If auth fails (401/403), the token itself is invalid/expired — no need to flood other endpoints
        if (res.status === 401 || res.status === 403) {
          break
        }
      } catch {
        // Try next endpoint on network connection errors
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
            'User-Agent': agyUserAgent(),
          },
          body: JSON.stringify({}),
        }, proxyUrl)
        if (res.ok) {
          this.preferredEndpointIndex = AGY_ENDPOINTS.indexOf(endpoint)
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
   * Fetch and aggregate live quota statistics (both 5-hour limit and weekly limit)
   * for a single account across model families.
   * Includes 10s cache throttle to avoid spamming Google APIs on fast clicks.
   */
  async refreshAccountQuota(account: ManagedAccount, force = false): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    const now = Date.now()
    if (!force && account.quotas) {
      const latestUpdate = Math.max(
        ...Object.values(account.quotas).map((q) => q?.updatedAt ?? 0),
      )
      if (latestUpdate > 0 && now - latestUpdate < 10_000) {
        return account.quotas
      }
    }
    const home = account.systemHome || !account.dir ? homedir() : account.dir
    let email = account.email
    // For primary/systemHome account or when email is missing, always detect
    // the latest email from logs to immediately catch account switching outside DSH.
    if (account.systemHome || !email) {
      const detected = detectEmailFromAgyLogs(home)
      if (detected) email = detected
    }

    const accessToken = await this.getValidAccessToken(account)
    if (!accessToken) {
      return null
    }

    // Manual refresh (刷新/同步): the TOKEN is the only authoritative identity
    // anchor. Log scraping lies — observed live: the slot was labeled
    // q98…@gmail.com while the stored token actually belonged to
    // elegantmanco@…, so every manual click fetched and displayed the WRONG
    // account's quota under the primary's name. One userinfo call per
    // explicit user click re-anchors the identity; background polls keep
    // the zero-network log-scan path below.
    if (force) {
      const info = await this.fetchUserInfo(accessToken, account.proxyUrl)
      if (info?.email) email = info.email
    }

    // External re-login: the slot now hosts a DIFFERENT Google account.
    // Identity-bound state (cooldowns / quotas / auth quarantine) belongs to
    // the previous email and must be reset before anything else — otherwise
    // the new account inherits the old one's restrictions (and poll gating
    // would keep the slot quarantined forever after an invalid_grant).
    if (email && email !== account.email) {
      this.pool.resetAccountIdentity(account.id, email)
    }

    const [summary, discovered] = await Promise.all([
      this.fetchQuotaSummary(accessToken, account.proxyUrl),
      this.fetchAvailableModels(accessToken, account.proxyUrl),
    ])

    // Query the userinfo endpoint ONLY when the email is still unknown.
    // Account switching on systemHome accounts is already caught locally by
    // detectEmailFromAgyLogs (no network); calling userinfo every poll cycle
    // was pure risk-control exposure for a value that never changes.
    if (!email) {
      const info = await this.fetchUserInfo(accessToken, account.proxyUrl)
      if (info?.email) email = info.email
    }

    if (!summary && (!discovered || !discovered.models)) {
      return null
    }

    // Authenticated backend calls just succeeded with this token: any stale
    // authRequired flag (e.g. set while the OLD account was logging out) is
    // disproven — clear it so the slot rejoins selection and polling.
    if (account.authRequired) {
      this.pool.clearAuthRequired(account.id)
    }

    const familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {}

    // 1. Ingest official weekly & 5h limits from retrieveUserQuotaSummary
    if (summary && Array.isArray(summary.groups)) {
      for (const group of summary.groups) {
        const dName = (group.displayName || '').toLowerCase()
        const desc = (group.description || '').toLowerCase()
        const isGoogle = dName.includes('gemini') || desc.includes('gemini')
        const is3P = dName.includes('claude') || dName.includes('gpt') || desc.includes('claude') || desc.includes('gpt')

        const targetFamilies: ModelFamily[] = isGoogle
          ? ['google']
          : is3P
          ? ['anthropic', 'openai']
          : []

        let fiveHourFrac: number | undefined
        let fiveHourReset: string | undefined
        let weeklyFrac: number | undefined
        let weeklyReset: string | undefined

        for (const b of group.buckets || []) {
          const w = (b.window || b.bucketId || '').toLowerCase()
          if (w.includes('5h')) {
            fiveHourFrac = b.remainingFraction
            fiveHourReset = b.resetTime
          } else if (w.includes('weekly')) {
            weeklyFrac = b.remainingFraction
            weeklyReset = b.resetTime
          }
        }

        for (const fam of targetFamilies) {
          familyQuotas[fam] = {
            remainingFraction: fiveHourFrac,
            resetTime: fiveHourReset,
            weeklyFraction: weeklyFrac,
            weeklyResetTime: weeklyReset,
            description: group.description,
            updatedAt: now,
          }
        }
      }
    }

    // 2. Ingest detailed model list from fetchAvailableModels
    const familyModels: Partial<Record<ModelFamily, ModelQuotaInfo[]>> = {}
    if (discovered && discovered.models) {
      for (const [modelId, entry] of Object.entries(discovered.models)) {
        const fam = modelFamilyOf(modelId)
        if (fam === 'unknown') continue
        const remaining = entry.quotaInfo?.remainingFraction
        const resetTime = entry.quotaInfo?.resetTime

        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue

        if (!familyModels[fam]) familyModels[fam] = []
        familyModels[fam]!.push({
          modelId,
          displayName: entry.displayName || modelId,
          remainingFraction: remaining,
          resetTime,
        })

        // Fallback for family fraction if summary was unavailable.
        if (!familyQuotas[fam]) {
          familyQuotas[fam] = mergeFallbackFamilyQuota(account.quotas[fam], {
            remainingFraction: remaining,
            resetTime,
            updatedAt: now,
          })
        } else if (familyQuotas[fam]!.remainingFraction === undefined) {
          const curRemaining = familyQuotas[fam]!.remainingFraction ?? 1
          if (remaining < curRemaining) {
            familyQuotas[fam]!.remainingFraction = remaining
            familyQuotas[fam]!.resetTime = resetTime
          } else if (remaining === curRemaining) {
            if (resetTime && (!familyQuotas[fam]!.resetTime || Date.parse(resetTime) > Date.parse(familyQuotas[fam]!.resetTime!))) {
              familyQuotas[fam]!.resetTime = resetTime
            }
          }
        }
      }
    }

    for (const [famKey, list] of Object.entries(familyModels)) {
      const fam = famKey as ModelFamily
      if (familyQuotas[fam]) {
        familyQuotas[fam]!.models = list
      }
    }

    this.pool.updateAccountQuotas(account.id, familyQuotas, email)
    return familyQuotas
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
        const flagged = acc.authRequired || Object.values(acc.cooldowns).some((cd) => cd && cd.cooldownUntil > now)
        if (!acc.systemHome || !flagged) continue
        const home = acc.systemHome || !acc.dir ? homedir() : acc.dir
        const detected = detectEmailFromAgyLogs(home)
        if (detected && detected !== acc.email) {
          this.pool.resetAccountIdentity(acc.id, detected)
        }
      }
      accounts = accounts.filter(shouldPollAccount)
    }
    await Promise.allSettled(accounts.map((acc) => this.refreshAccountQuota(acc, force)))
  }
}

