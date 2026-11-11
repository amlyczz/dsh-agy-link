// Pure credential-identity helpers: on-disk token normalization, OAuth-grant
// comparison, organic stagger jitter and the platform-faithful agy User-Agent.
// No I/O, no service state.

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

/**
 * Organic stagger delay with randomized jitter for multi-account sequential polling.
 * Prevents rigid periodic cadence against Google Cloud Code endpoints (default: 2000~3500ms).
 */
export function staggerJitterMs(baseMs = 2000, maxJitterMs = 1500): number {
  return baseMs + Math.floor(Math.random() * maxJitterMs)
}

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
