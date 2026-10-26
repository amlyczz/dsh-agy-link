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
  modelFamilyOf,
  needsAuthReverify,
  shouldPollAccount,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
  type ModelQuotaInfo,
} from '../common/pool-types.ts'
import { shouldMarkAuthRequired } from '../common/types.ts'
import type { AccountPoolManager } from './pool.ts'
import { AGY_ENDPOINTS, refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'
import { detectSystemProxy } from './wincred.ts'
import { parseCredentialDoc, credentialFingerprint, readPrimaryCredential, writePrimaryCredential } from './credential-slot.ts'
import { readAgyUsage, usageGroupsToFamilies } from './agy-usage.ts'
import { isolatedHomeEnv, proxyEnvFor } from './runner.ts'

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

/** Minimal shape of the quota groups `retrieveUserQuotaSummary` returns. */
export interface QuotaGroupShape {
  displayName?: string
  description?: string
  buckets?: readonly { bucketId?: string; displayName?: string }[]
}

/**
 * True when any returned group is the dedicated Argon bucket.
 *
 * The backend stops emitting that group once the plan folds Argon into the
 * larger Gemini bucket (Ultra). From then on the family is governed by the
 * shared bucket, so a cooldown recorded against the retired pool — e.g. a 429
 * taken minutes before an upgrade — must not keep blocking the family for days.
 */
export function summaryHasArgonGroup(groups: readonly QuotaGroupShape[]): boolean {
  return groups.some((group) => {
    const fields: (string | undefined)[] = [group.displayName, group.description]
    for (const bucket of group.buckets ?? []) fields.push(bucket.bucketId, bucket.displayName)
    return fields.some((value) => typeof value === 'string' && value.toLowerCase().includes('argon'))
  })
}

/**
 * Decide whether a family's cooldown belongs to a quota bucket that no longer exists.
 *
 * A cooldown is recorded against the pool that produced the 429. A plan change can
 * retire that pool — a Pro → Ultra upgrade folds Argon into the larger Gemini bucket
 * and the backend stops emitting the `Gemini 4 Argon` group — leaving a cooldown that
 * blocks the family until a reset that no longer applies:
 *
 *   All Antigravity accounts are unavailable: no account can serve argon right now
 *   (1 in cooldown) (earliest reset in 345338s)
 *
 * `groupSeenBefore` is what keeps this from firing on accounts that never had the
 * group at all (free tier, or any plan without an Argon bucket): their argon
 * cooldowns come from genuine 429s and must survive.
 */
export function shouldReleaseOrphanedCooldown(state: {
  summaryAuthoritative: boolean
  groupPresent: boolean
  groupSeenBefore: boolean
  hasCooldown: boolean
}): boolean {
  return state.summaryAuthoritative
    && !state.groupPresent
    && state.groupSeenBefore
    && state.hasCooldown
}

/**
 * Pick the family fraction when this poll's summary carried no group for it.
 *
 * An *authoritative* summary (at least one group returned) means the absence is
 * real: the family lost its own bucket — a Pro → Ultra upgrade folds the
 * separate Argon pool into the larger Gemini bucket, and the backend then stops
 * reporting a `Gemini 4 Argon` group entirely while `fetchAvailableModels`
 * keeps listing the argon models with fresh per-model fractions. Keeping the
 * last-known-good row there would freeze a dead window on screen (0%, a reset
 * time from the previous tier).
 *
 * A failed or empty summary is the case `mergeFallbackFamilyQuota` protects:
 * nothing authoritative arrived, so the previous complete value stays.
 */
export function pickFamilyQuota(
  prev: FamilyQuotaInfo | undefined,
  fresh: FamilyQuotaInfo,
  summaryAuthoritative: boolean,
): FamilyQuotaInfo {
  return summaryAuthoritative ? fresh : mergeFallbackFamilyQuota(prev, fresh)
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

/**
 * The backend classifies the caller by its `User-Agent` and only returns the
 * separate `Gemini 4 Argon` quota group for the CLI product (`antigravity/cli/`)
 * at or above this version. Older/other product strings get the legacy two
 * groups, which is why Pro-plan users saw no Argon quota at all.
 */
export const AGY_UA_MIN_VERSION = '1.3.0'
/** Used when the installed agy version is unknown or older than AGY_UA_MIN_VERSION. */
const AGY_UA_FALLBACK_VERSION = '1.4.5'

function semverAtLeast(candidate: string | null | undefined, floor: string): boolean {
  if (!candidate) return false
  const a = candidate.match(/^(\d+)\.(\d+)\.(\d+)$/)
  const b = floor.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(a[i])
    const y = Number(b[i])
    if (x !== y) return x > y
  }
  return true
}

/** Platform-faithful agy User-Agent (hardcoding darwin/arm64 on Windows is a bad fingerprint). */
export function agyUserAgent(version?: string | null): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const v = semverAtLeast(version, AGY_UA_MIN_VERSION) ? version! : AGY_UA_FALLBACK_VERSION
  return `antigravity/cli/${v} (aidev_client; os_type=${os}; arch=${arch}; auth_method=consumer)`
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
  remainingAmount?: number
}

interface QuotaSummaryGroup {
  displayName?: string
  description?: string
  buckets?: QuotaSummaryBucket[]
}

interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[]
  buckets?: QuotaSummaryBucket[]
  description?: string
}

export interface UserQuotaBucket {
  modelId?: string
  tokenType?: string
  remainingFraction?: number
  remainingAmount?: number
  resetTime?: string
}

export interface UserQuotaResponse {
  buckets?: UserQuotaBucket[]
}

/**
 * Detects whether a 5-hour quota bucket from retrieveUserQuotaSummary is an
 * unmetered placeholder (remainingFraction = 1.0 and resetTime = now + ~5h).
 * In unmetered environments (e.g. Cloud Code PA prod for free tier), the window
 * never starts billing and stays frozen at 100% forever.
 */
export function isStale5hBucket(remainingFraction?: number, resetTime?: string, now = Date.now()): boolean {
  if (remainingFraction !== 1 || !resetTime) return false
  const resetMs = Date.parse(resetTime) - now
  return resetMs > 4.5 * 3600_000 && resetMs < 5.2 * 3600_000
}

/**
 * True only when two token snapshots belong to the SAME OAuth grant.
 *
 * Used to decide whether the machine credential slot really holds the account
 * we are about to poll through the `agy` CLI. A refresh token identifies a
 * grant; an access token rotates, so it is only consulted when neither side
 * carries a refresh token. Mismatched shapes count as "not proven" — the
 * caller then takes the safe path instead of misattributing a quota row.
 */
export function sameCredentialGrant(
  a: StoredToken | null | undefined,
  b: StoredToken | null | undefined,
): boolean {
  const fingerprint = (token: StoredToken | null | undefined): string | null => {
    if (token?.refreshToken) return 'r:' + token.refreshToken
    if (token?.accessToken) return 'a:' + token.accessToken
    return null
  }
  const fa = fingerprint(a)
  return fa !== null && fa === fingerprint(b)
}

/** How close two ISO reset stamps must be to name the SAME quota window. */
export const QUOTA_WINDOW_MATCH_TOLERANCE_MS = 5 * 60_000

/**
 * Organic stagger delay with randomized jitter for multi-account sequential polling.
 * Prevents rigid periodic cadence against Google Cloud Code endpoints (default: 2000~3500ms).
 */
export function staggerJitterMs(baseMs = 2000, maxJitterMs = 1500): number {
  return baseMs + Math.floor(Math.random() * maxJitterMs)
}

/**
 * True when two reset stamps point at the same quota window.
 *
 * `fetchAvailableModels` returns a per-model `quotaInfo` with NO window label:
 * for some accounts it carries the 5-hour bucket, for others the WEEKLY bucket
 * (live: daoxzeex@gmail.com reports the weekly fraction + weekly reset on every
 * Gemini model). The only reliable discriminator is the reset instant — it
 * matches exactly one of the `retrieveUserQuotaSummary` buckets.
 */
export function sameQuotaWindow(a?: string, b?: string, toleranceMs = QUOTA_WINDOW_MATCH_TOLERANCE_MS): boolean {
  if (!a || !b) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false
  return Math.abs(ta - tb) <= toleranceMs
}

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
    const script = [
      "$sig = @'",
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class AgyCred {',
      '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
      '  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);',
      '  [DllImport("advapi32.dll", SetLastError=true)]',
      '  public static extern void CredFree(IntPtr cred);',
      '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      '  public struct CREDENTIAL {',
      '    public int Flags; public int Type; public IntPtr TargetName;',
      '    public IntPtr Comment; public long LastWritten; public int CredentialBlobSize;',
      '    public IntPtr CredentialBlob; public int Persist; public int AttributeCount;',
      '    public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;',
      '  }',
      '  public static byte[] Read(string target) {',
      '    IntPtr p;',
      '    if (!CredRead(target, 1, 0, out p)) return null;',
      '    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));',
      '    byte[] b = new byte[c.CredentialBlobSize];',
      '    Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);',
      '    CredFree(p);',
      '    return b;',
      '  }',
      '}',
      "'@",
      'Add-Type -TypeDefinition $sig -ErrorAction Stop',
      "$b = [AgyCred]::Read('gemini:antigravity')",
      'if ($b -eq $null) { exit 1 }',
      '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))',
    ].join('\n')
    const raw = (await execFileT(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      8000,
    )).trim()
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
    // The owner itself still needs proof: while a secondary runs, the slot is
    // temporarily handed that account's credential, and a CLI read then would
    // return the secondary's numbers under the primary's row.
    if (!(await this.cliSlotHoldsAccount(account))) {
      return null
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(account.dir ? isolatedHomeEnv(account.dir) : {}),
      ...proxyEnvFor(this.proxyFor(account)),
    }
    const groups = await readAgyUsage({
      bin,
      env,
      timeoutMs: 20_000,
      preemptAutoUpdate: this.cliDeps.preemptAutoUpdate?.(),
    })
    return groups === null ? null : usageGroupsToFamilies(groups)
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
    return sameCredentialGrant(slot, await this.getStoredToken(account))
  }

  /** Dedicated account proxy wins, then the global config proxy, then detected system proxy. */
  private proxyFor(account: ManagedAccount): string | undefined {
    return account.proxyUrl || this.globalProxy() || detectSystemProxy() || undefined
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
  async getStoredToken(account: ManagedAccount): Promise<StoredToken | null> {
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
      const keychainToken = await this.readSystemKeychainToken()
      if (keychainToken && (keychainToken.accessToken || keychainToken.refreshToken)) {
        return keychainToken
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

    // An isolated pool account must never carry the SAME OAuth grant as the
    // primary. When it does, its login was overwritten by the shared Windows
    // credential slot, and every number fetched under this row would actually
    // belong to the primary. Quarantine the slot instead of displaying — and
    // failing over onto — someone else's quota. Deterministic and offline.
    if (account.dir && process.platform === 'win32') {
      const stored = readPrimaryCredential(this.pool.dir)
      const file = this.getTokenFilePath(account)
      const own = existsSync(file) ? readFileSync(file, 'utf8') : null
      const ownFingerprint = own ? credentialFingerprint(own) : null
      if (
        stored &&
        ownFingerprint !== null &&
        ownFingerprint === credentialFingerprint(stored.raw)
      ) {
        this.pool.markAuthRequired(
          account.id,
          "stored credential is the primary account's — this login was overwritten, sign in again",
        )
        return null
      }
    }

    let email = account.email
    // On Windows, the primary account rides the durable store (.primary-credential.json)
    // whose identity is verified directly against Google. That verified identity
    // wins over stale account labels and never relies on ambiguous log scraping.
    if ((account.systemHome || !account.dir) && process.platform === 'win32') {
      const stored = readPrimaryCredential(this.pool.dir)
      if (stored?.email) {
        email = stored.email
      }
    }

    // Only inspect logs when the email is completely missing. Never adopt a
    // sibling account's email: log scraping can pick up secondary account runs
    // that temporarily executed under the same profile.
    if (!email) {
      const detected = detectEmailFromAgyLogs(home)
      const siblingEmails = new Set(
        this.pool
          .getAccounts()
          .filter((a) => a.id !== account.id && a.email)
          .map((a) => a.email!),
      )
      if (detected && !siblingEmails.has(detected)) {
        email = detected
      }
    }

    // 1. CLI-FIRST PATH (Anti-Risk Control):
    // When CLI is available and enabled (default), run official `agy -p /usage`.
    // 100% official Google binary, real Go TLS fingerprint, native token refresh by agy Go runtime.
    // Zero Node.js REST calls to Google's internal APIs.
    if (this.cliDeps.viaCli?.() !== false) {
      const cliFamilies = await this.readCliUsageFamilies(account)
      if (cliFamilies !== null && Object.keys(cliFamilies).length > 0) {
        if (account.authRequired) {
          this.pool.clearAuthRequired(account.id)
        }
        if (cliFamilies.argon) {
          this.pool.noteDedicatedGroup(account.id, 'argon')
        } else {
          this.pool.clearQuotaFamily(account.id, 'argon')
          this.pool.forgetDedicatedGroup(account.id, 'argon')
          this.pool.clearCooldown(account.id, 'argon')
        }
        this.pool.updateAccountQuotas(account.id, cliFamilies, email)
        return cliFamilies
      }
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
      const info = await this.fetchUserInfo(accessToken, this.proxyFor(account))
      if (info?.email) {
        email = info.email
        if ((account.systemHome || !account.dir) && process.platform === 'win32') {
          const stored = readPrimaryCredential(this.pool.dir)
          if (stored && stored.email !== info.email) {
            writePrimaryCredential({ ...stored, email: info.email, savedAt: Date.now() }, this.pool.dir)
          }
        }
      }
    }

    // External re-login: the slot now hosts a DIFFERENT Google account.
    // Identity-bound state (cooldowns / quotas / auth quarantine) belongs to
    // the previous email and must be reset before anything else — otherwise
    // the new account inherits the old one's restrictions (and poll gating
    // would keep the slot quarantined forever after an invalid_grant).
    if (email && email !== account.email) {
      // An ISOLATED pool account's identity is fixed by the credential the user
      // signed in with. If the resolved email matches ANOTHER slot's email,
      // this account's token file was overwritten by that account (the
      // documented Windows slot-corruption failure) — quarantine it instead of
      // relabeling, which is how one corrupted token made every row report the
      // same identity and spend the same quota.
      const collisionsWithSibling =
        Boolean(account.dir) &&
        this.pool.getAccounts().some(
          (other) =>
            other.id !== account.id &&
            other.email !== undefined &&
            other.email === email &&
            other.dir !== account.dir,
        )
      if (collisionsWithSibling) {
        this.pool.markAuthRequired(
          account.id,
          `stored credential belongs to ${email} (another account's login) — sign in again`,
        )
        return null
      }
      this.pool.resetAccountIdentity(account.id, email)
    }

    const [summary, discovered, userQuota] = await Promise.all([
      this.fetchQuotaSummary(accessToken, this.proxyFor(account)),
      this.fetchAvailableModels(accessToken, this.proxyFor(account)),
      this.fetchUserQuota(accessToken, this.proxyFor(account)).catch(() => null),
    ])

    // Query the userinfo endpoint ONLY when the email is still unknown.
    // Account switching on systemHome accounts is already caught locally by
    // detectEmailFromAgyLogs (no network); calling userinfo every poll cycle
    // was pure risk-control exposure for a value that never changes.
    if (!email) {
      const info = await this.fetchUserInfo(accessToken, this.proxyFor(account))
      if (info?.email) email = info.email
    }

    const modelsCatalog: Record<string, DiscoveredModelEntry> = {
      ...(discovered?.models || {}),
    }
    if (userQuota && Array.isArray(userQuota.buckets)) {
      for (const b of userQuota.buckets) {
        if (!b.modelId) continue
        const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
          ? Math.min(1, Math.max(0, b.remainingFraction))
          : undefined
        if (frac !== undefined) {
          const existing = modelsCatalog[b.modelId]
          modelsCatalog[b.modelId] = {
            ...existing,
            quotaInfo: {
              remainingFraction: frac,
              resetTime: b.resetTime || existing?.quotaInfo?.resetTime,
            },
          }
        }
      }
    }

    if (!summary && Object.keys(modelsCatalog).length === 0) {
      return null
    }

    // Authenticated backend calls just succeeded with this token: any stale
    // authRequired flag (e.g. set while the OLD account was logging out) is
    // disproven — clear it so the slot rejoins selection and polling.
    if (account.authRequired) {
      this.pool.clearAuthRequired(account.id)
    }

    const familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {}
    const stale5hFamilies = new Set<ModelFamily>()

    // 1. Ingest official weekly & 5h limits from retrieveUserQuotaSummary
    const summaryGroups: QuotaSummaryGroup[] = []
    if (summary) {
      if (Array.isArray(summary.groups)) summaryGroups.push(...summary.groups)
      if (Array.isArray(summary.buckets) && summary.buckets.length > 0) {
        summaryGroups.push({
          displayName: summary.description || 'Quota',
          buckets: summary.buckets,
        })
      }
    }

    if (summaryGroups.length > 0) {
      for (const group of summaryGroups) {
        const dName = (group.displayName || '').toLowerCase()
        const desc = (group.description || '').toLowerCase()
        // Gemini 4 Argon (Pro/Ultra-only) ships as its OWN quota group with a
        // separate weekly bucket, but its display name still contains "gemini"
        // ("Gemini 4 Argon"). Detect argon BEFORE the generic gemini gate or
        // the group folds into — and overwrites — the plain Gemini family.
        const hasArgonBucket = Array.isArray(group.buckets) && group.buckets.some((b) => (b.bucketId || '').toLowerCase().includes('argon') || (b.displayName || '').toLowerCase().includes('argon'))
        const isArgon = dName.includes('argon') || desc.includes('argon') || hasArgonBucket
        const isGoogle = !isArgon && (dName.includes('gemini') || desc.includes('gemini'))
        const is3P = dName.includes('claude') || dName.includes('gpt') || desc.includes('claude') || desc.includes('gpt')

        const targetFamilies: ModelFamily[] = isArgon
          ? ['argon']
          : isGoogle
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
          // Server fractions are clamped to [0,1] and NaN rejected: a bogus
          // remainingFraction (NaN/negative/>1) used to flow straight into
          // isAccountEligible and the UI ("NaN%" rows, permanently ineligible).
          const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
            ? Math.min(1, Math.max(0, b.remainingFraction))
            : undefined
          if (w.includes('5h') || w.includes('five_hour') || w.includes('5-hour')) {
            fiveHourFrac = frac
            fiveHourReset = b.resetTime
          } else if (w.includes('weekly') || w.includes('week')) {
            weeklyFrac = frac
            weeklyReset = b.resetTime
          }
        }

        for (const fam of targetFamilies) {
          if (isStale5hBucket(fiveHourFrac, fiveHourReset, now)) {
            stale5hFamilies.add(fam)
          }
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

    // 2. Ingest detailed model list from fetchAvailableModels / retrieveUserQuota
    const familyModels: Partial<Record<ModelFamily, ModelQuotaInfo[]>> = {}
    if (Object.keys(modelsCatalog).length > 0) {
      for (const [modelId, entry] of Object.entries(modelsCatalog)) {
        const fam = modelFamilyOf(modelId)
        if (fam === 'unknown') continue
        const rawRemaining = entry.quotaInfo?.remainingFraction
        // Clamp to [0,1]; non-numeric entries are skipped (same contract as
        // the summary path above).
        const remaining = typeof rawRemaining === 'number' && Number.isFinite(rawRemaining)
          ? Math.min(1, Math.max(0, rawRemaining))
          : undefined
        const resetTime = entry.quotaInfo?.resetTime

        if (remaining === undefined) continue

        if (!familyModels[fam]) familyModels[fam] = []
        familyModels[fam]!.push({
          modelId,
          displayName: entry.displayName || modelId,
          remainingFraction: remaining,
          resetTime,
        })

        const isStale = stale5hFamilies.has(fam)
        // Fallback for family fraction if summary was unavailable.
        if (!familyQuotas[fam]) {
          familyQuotas[fam] = pickFamilyQuota(
            account.quotas[fam],
            { remainingFraction: remaining, resetTime, updatedAt: now },
            summaryGroups.length > 0,
          )
          if (fam === 'argon' && familyQuotas[fam]!.weeklyFraction === undefined) {
            familyQuotas[fam]!.weeklyFraction = remaining
            familyQuotas[fam]!.weeklyResetTime = resetTime
          }
        } else {
          // Window-aware merge. `quotaInfo` carries no window label, so the
          // reset instant decides where the number belongs:
          //   • reset == summary 5h reset  → a 5h reading: tighten the 5h row.
          //   • reset == summary WEEKLY reset → a weekly reading: tighten the
          //     weekly row ONLY. Filing it under the 5h row painted "5h 19% ·
          //     weekly 19%" with the weekly reset on both lines (2026-10-22).
          //   • neither / no summary resets → unmatchable: keep the old
          //     conservative "lowest binding constraint" tighten on the 5h row.
          const familyQuota = familyQuotas[fam]!
          const modelIsWeekly =
            sameQuotaWindow(resetTime, familyQuota.weeklyResetTime) &&
            !sameQuotaWindow(resetTime, familyQuota.resetTime)
          if (modelIsWeekly) {
            const curWeekly = familyQuota.weeklyFraction ?? 1
            if (remaining < curWeekly) {
              familyQuota.weeklyFraction = remaining
              familyQuota.weeklyResetTime = resetTime
            }
            continue
          }
          // The binding constraint is the LOWEST reported remaining across all
          // sources. A lower remaining is by definition more consumed —
          // tighten to it and adopt its reset. If the coarse summary returned an
          // unmetered 5h placeholder (stale 100% with now+5h), the live model
          // window overrides it so the UI displays authentic numbers.
          const curRemaining = familyQuota.remainingFraction ?? 1
          if (remaining < curRemaining || isStale) {
            familyQuota.remainingFraction = remaining
            familyQuota.resetTime = resetTime
            stale5hFamilies.delete(fam)
          }
          if (fam === 'argon' && familyQuota.weeklyFraction === undefined) {
            familyQuota.weeklyFraction = remaining
            familyQuota.weeklyResetTime = resetTime
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

    // Track whether this account reports a dedicated Argon bucket, so a retired one
    // can be told apart from one that never existed (see shouldReleaseOrphanedCooldown).
    if (summaryGroups.length > 0) {
      if (summaryHasArgonGroup(summaryGroups) || familyQuotas.argon) {
        this.pool.noteDedicatedGroup(account.id, 'argon')
      } else {
        this.pool.clearQuotaFamily(account.id, 'argon')
        if (shouldReleaseOrphanedCooldown({
          summaryAuthoritative: true,
          groupPresent: false,
          groupSeenBefore: this.pool.hasDedicatedGroup(account.id, 'argon'),
          hasCooldown: account.cooldowns?.argon !== undefined,
        })) {
          this.pool.forgetDedicatedGroup(account.id, 'argon')
          this.pool.clearCooldown(account.id, 'argon')
        }
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
    await Promise.allSettled(accounts.map((acc) => this.refreshAccountQuota(acc, force)))
  }
}

