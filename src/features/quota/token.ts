// Quota token I/O: on-disk token normalization, keyring readers, token refresh
// and the agy-shape persistence. Network behaviour and the platform keyring
// commands are unchanged; the pool/credential seams are injected so
// QuotaService's overridable methods remain the real boundary.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ManagedAccount } from '../../common/pool-types.ts'
import { shouldMarkAuthRequired } from '../../common/types.ts'
import { normalizeStoredToken, type StoredToken } from '../../domain/quota/identity.ts'
import { refreshTokens } from '../../host/oauth.ts'
import { readWindowsCredentialRaw } from '../../host/wincred.ts'
import { readAccountCredential, saveCredentialBackup } from '../../domain/credentials/backup.ts'

/** Durable primary credential record (mirrors credential-slot.PrimaryCredential). */
export interface PrimaryCredentialLike {
  raw: string
  email?: string
  savedAt: number
}

/** Parsed credential document (mirrors credential-slot.CredentialDoc). */
export interface CredentialDocLike {
  accessToken?: string
  refreshToken?: string
  expiryMs?: number
}

/** A refreshed access token, as handed to persistRefreshedToken. */
export interface RefreshedTokenInput {
  access_token: string
  expiryMs?: number
  refresh_token?: string
}

/** The subset of AccountPoolManager touched by token refresh. */
export interface QuotaTokenPool {
  readonly dir: string
  clearAuthRequired(id: string): void
  markAuthRequired(id: string, reason?: string): void
}

/**
 * I/O seams for token handling. QuotaService supplies these by closing over
 * its own (subclass-overridable) methods and the credential-slot helpers.
 */
export interface QuotaTokenDeps {
  pool: QuotaTokenPool
  proxyFor(account: ManagedAccount): string | undefined
  readSystemKeychainToken(): Promise<StoredToken | null>
  getStoredToken(account: ManagedAccount, allowKeychainFallback?: boolean): Promise<StoredToken | null>
  persistRefreshedToken(account: ManagedAccount, tokens: RefreshedTokenInput, expectedRefreshToken?: string): void
  readPrimaryCredential(baseDir: string): PrimaryCredentialLike | null
  writePrimaryCredential(cred: PrimaryCredentialLike, baseDir: string): boolean
  parseCredentialDoc(raw: string | null | undefined): CredentialDocLike | null
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
 * empty on Windows: the on-disk token file is often absent while agy itself
 * still authenticates via CredRead (issue #30).
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

/** Dispatch to the platform keyring reader (no-op on unsupported platforms). */
export function readSystemKeychainToken(): Promise<StoredToken | null> {
  if (process.platform === 'darwin') return readMacKeychainToken()
  if (process.platform === 'linux') return readLinuxSecretToken()
  if (process.platform === 'win32') return readWindowsCredentialToken()
  return Promise.resolve(null)
}

/**
 * Path of agy's on-disk token document for one account. The primary account
 * rides the real system HOME (Keychain-backed); only secondary accounts have
 * an isolated dir.
 */
export function quotaTokenFilePath(account: ManagedAccount): string {
  const home = account.systemHome || !account.dir ? homedir() : account.dir
  return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
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
export async function getStoredToken(
  deps: QuotaTokenDeps,
  account: ManagedAccount,
  allowKeychainFallback = true,
): Promise<StoredToken | null> {
  const disk = (() => {
    const file = quotaTokenFilePath(account)
    try {
      const content = account.systemHome || !account.dir
        ? (existsSync(file) ? readFileSync(file, 'utf8') : null)
        : readAccountCredential(file)
      if (content === null) return null
      const raw = JSON.parse(content) as Record<string, unknown>
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
      const stored = deps.readPrimaryCredential(deps.pool.dir)
      const storedToken = stored ? deps.parseCredentialDoc(stored.raw) : null
      if (storedToken && (storedToken.accessToken || storedToken.refreshToken)) {
        return storedToken
      }
    }
    // main keeps this read async (execFileSync used to freeze the event loop
    // on every poll) — the durable-store check above stays synchronous.
    if (allowKeychainFallback) {
      const keychainToken = await deps.readSystemKeychainToken()
      if (keychainToken && (keychainToken.accessToken || keychainToken.refreshToken)) {
        return keychainToken
      }
    }
  }

  if (disk) return disk

  if (account.dir && !account.systemHome && process.platform === 'darwin' && allowKeychainFallback) {
    const candidates = [
      join(account.dir, 'Library', 'Keychains', 'login.keychain-db'),
      join(account.dir, 'Library', 'Keychains', 'login.keychain'),
    ]
    const targetKc = candidates.find((p) => existsSync(p))
    if (targetKc) {
      try {
        const raw = (await execFileT('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w', targetKc], 3000)).trim()
        if (raw) {
          const tok = parseGoKeyringPayload(raw)
          if (tok && (tok.accessToken || tok.refreshToken)) return tok
        }
      } catch {
        // ignore
      }
    }
  }

  return null
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
export function persistRefreshedToken(
  deps: QuotaTokenDeps,
  account: ManagedAccount,
  tokens: RefreshedTokenInput,
  expectedRefreshToken?: string,
): void {
  const file = quotaTokenFilePath(account)
  try {
    if (
      expectedRefreshToken &&
      account.dir &&
      !account.systemHome &&
      existsSync(file) &&
      deps.parseCredentialDoc(readFileSync(file, 'utf8'))?.refreshToken !== expectedRefreshToken
    ) {
      return
    }
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
    const raw = JSON.stringify(doc)
    writeFileSync(file, raw, { encoding: 'utf8', mode: 0o600 })
    if (account.dir && !account.systemHome) {
      saveCredentialBackup(file, raw)
    }
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
      if (deps.parseCredentialDoc(fresh)?.refreshToken) {
        const stored = deps.readPrimaryCredential(deps.pool.dir)
        deps.writePrimaryCredential(
          { raw: fresh, email: stored?.email, savedAt: Date.now() },
          deps.pool.dir,
        )
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * True when the on-disk credential of an ISOLATED account still carries the
 * grant an in-flight refresh started with. Primary/system-HOME accounts are
 * always "current" (their grant is the shared slot).
 */
export function isCurrentAccountGrant(
  deps: QuotaTokenDeps,
  account: ManagedAccount,
  refreshToken: string,
): boolean {
  if (account.systemHome || !account.dir) return true
  try {
    return deps.parseCredentialDoc(readFileSync(quotaTokenFilePath(account), 'utf8'))?.refreshToken === refreshToken
  } catch {
    return false
  }
}

/**
 * Get a valid access token, refreshing via refresh_token when expired.
 *
 * Concurrent calls for the SAME account share one in-flight attempt: the
 * poll timer, three manual HTTP entry points and per-account allSettled
 * used to race into duplicate refreshTokens for one account (double
 * risk-control exposure for the same outcome). The in-flight map itself is
 * owned by QuotaService so cached state is unchanged.
 */
export async function getValidAccessToken(
  deps: QuotaTokenDeps,
  account: ManagedAccount,
  tokenRefreshInFlight: Map<string, Promise<string | null>>,
): Promise<string | null> {
  const existing = tokenRefreshInFlight.get(account.id)
  if (existing !== undefined) return existing
  const attempt = getValidAccessTokenUncached(deps, account).finally(() => {
    tokenRefreshInFlight.delete(account.id)
  })
  tokenRefreshInFlight.set(account.id, attempt)
  return attempt
}

async function getValidAccessTokenUncached(deps: QuotaTokenDeps, account: ManagedAccount): Promise<string | null> {
  const tok = await deps.getStoredToken(account)
  if (!tok) return null

  // Still fresh (with 60s buffer)? Use it directly.
  if (tok.accessToken && (!tok.expiryMs || tok.expiryMs > Date.now() + 60_000)) {
    return tok.accessToken
  }

  // Expired or missing access token — refresh if we have a refresh_token
  if (tok.refreshToken) {
    try {
      const refreshed = await refreshTokens(tok.refreshToken, deps.proxyFor(account))
      if (!isCurrentAccountGrant(deps, account, tok.refreshToken)) return null
      if (refreshed?.access_token) {
        deps.persistRefreshedToken(
          account,
          {
            access_token: refreshed.access_token,
            expiryMs: refreshed.expiryMs,
            // Carry the grant identity forward — losing it made the credential
            // unidentifiable and disabled every corruption guard.
            refresh_token: refreshed.refresh_token ?? tok.refreshToken,
          },
          tok.refreshToken,
        )
        if (account.authRequired) {
          deps.pool.clearAuthRequired(account.id)
        }
        return refreshed.access_token
      }
    } catch (err: unknown) {
      if (!isCurrentAccountGrant(deps, account, tok.refreshToken)) return null
      const errMsg = String(err)
      // Only authoritative OAuth states flag the account; a bare 400
      // (captive portal / proxy error page) or a transport failure must not.
      if (shouldMarkAuthRequired(undefined, errMsg)) {
        deps.pool.markAuthRequired(account.id, errMsg)
      }
    }
  }

  return tok.accessToken || null
}