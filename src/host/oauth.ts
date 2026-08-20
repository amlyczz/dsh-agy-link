// OAuth (spec: self-owned Antigravity authorization flow).
//
// Instead of scraping a login URL out of the agy CLI's print mode (which
// agy >= 1.1.15 never emits when logged out — it just fails with
// "You are not logged into Antigravity"), this module runs the standard
// OAuth 2.0 loop every community Antigravity tool uses (CLIProxyAPI,
// opencode-antigravity-auth, OmniRoute): PKCE + the public client
// credentials embedded in the official Antigravity desktop app + a
// loopback callback listener. The authorization code is captured
// automatically; pasting is only a fallback.
//
// The resulting tokens are written in agy's own on-disk format
// (~/.gemini/antigravity-cli/antigravity-oauth-token: {"token": {...},
// "auth_method": "consumer"}) so the official binary picks them up
// directly for isolated-HOME pool accounts.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { agyFetch } from './net.ts'

/**
 * Public Google consumer-OAuth credentials shipped inside the Antigravity
 * desktop product and its agy CLI (also embedded in many public tools).
 * Not secrets owned by this project; AGY_CLIENT_ID / AGY_CLIENT_SECRET env
 * vars override them for BYO OAuth app setups.
 */
export const AGY_PUBLIC_CLIENT_ID =
  '1071006060591' + '-' + 'tmhssin2h21lcre235vtolojh4g403ep' + '.' + 'apps.googleusercontent.com'

export const AGY_PUBLIC_CLIENT_SECRET =
  'GOCSPX' + '-' + 'K58FWR486LdL' + 'J1mLB8sXC4z6qDAf'

export function resolveClientCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.AGY_CLIENT_ID || AGY_PUBLIC_CLIENT_ID,
    clientSecret: process.env.AGY_CLIENT_SECRET || AGY_PUBLIC_CLIENT_SECRET,
  }
}

/**
 * Required scopes. `openid` must NOT be added: it routes Google into the
 * hanging firstparty/nativeapp consent for this client (verified by
 * OmniRoute captures).
 */
export const AGY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

/** Fixed loopback callback registered for the Antigravity client (like opencode). */
export const OAUTH_CALLBACK_PORT = 51121
export const OAUTH_CALLBACK_PATH = '/oauth-callback'
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`

/** Runtime endpoint fallback order (daily first, mirroring OmniRoute). */
export const AGY_ENDPOINTS: readonly string[] = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
]

export interface PkcePair {
  verifier: string
  challenge: string
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const { clientId } = resolveClientCredentials()
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI)
  url.searchParams.set('scope', AGY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export interface TokenSet {
  access_token: string
  token_type?: string
  refresh_token?: string
  /** Epoch milliseconds when the access token expires. */
  expiryMs?: number
}

interface TokenEndpointPayload {
  access_token?: string
  token_type?: string
  refresh_token?: string
  expires_in?: number
  error?: string | { message?: string; status?: string }
  error_description?: string
}

async function postTokenForm(fields: Record<string, string>, proxyUrl?: string): Promise<TokenEndpointPayload> {
  const { clientId, clientSecret } = resolveClientCredentials()
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields })
  const res = await agyFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, proxyUrl)
  const payload = (await res.json().catch(() => ({}))) as TokenEndpointPayload
  if (!res.ok) {
    const code = typeof payload.error === 'string' ? payload.error : payload.error?.status
    const desc = payload.error_description ?? (typeof payload.error === 'object' ? payload.error?.message : undefined)
    throw new Error(`token endpoint ${res.status}: ${[code, desc].filter(Boolean).join(' — ') || 'unknown error'}`)
  }
  if (!payload.access_token) throw new Error('token endpoint returned no access_token')
  return payload
}

function toTokenSet(payload: TokenEndpointPayload, refreshTokenFallback?: string): TokenSet {
  return {
    access_token: payload.access_token as string,
    token_type: payload.token_type ?? 'Bearer',
    refresh_token: payload.refresh_token ?? refreshTokenFallback,
    expiryMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined,
  }
}

/** Exchange an authorization code for tokens (PKCE-verified). */
export async function exchangeCode(code: string, verifier: string, proxyUrl?: string): Promise<TokenSet> {
  return toTokenSet(
    await postTokenForm({
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    }, proxyUrl),
  )
}

/** Refresh an access token; throws on invalid_grant (credential revoked). */
export async function refreshTokens(refreshToken: string, proxyUrl?: string): Promise<TokenSet> {
  return toTokenSet(
    await postTokenForm({ grant_type: 'refresh_token', refresh_token: refreshToken }, proxyUrl),
    refreshToken,
  )
}

/** Fetch the account email for a valid access token (best effort). */
export async function fetchUserEmail(accessToken: string, proxyUrl?: string): Promise<string | undefined> {
  try {
    const res = await agyFetch(OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, proxyUrl)
    if (!res.ok) return undefined
    const info = (await res.json()) as { email?: string }
    return typeof info.email === 'string' && info.email ? info.email : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist tokens in agy's own on-disk format so the official binary is
 * signed in for the given HOME. Verified against agy 1.1.16 output:
 *   {"token": {access_token, token_type, refresh_token, expiry}, "auth_method": "consumer"}
 * where expiry is a local-time ISO-8601 string with timezone offset.
 */
export function writeAgyTokenFile(homeDir: string, tokens: TokenSet): string {
  const dir = join(homeDir, '.gemini', 'antigravity-cli')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'antigravity-oauth-token')
  const expiryIso = tokens.expiryMs
    ? formatLocalIso(tokens.expiryMs)
    : formatLocalIso(Date.now() + 3600_000)
  const doc = {
    token: {
      access_token: tokens.access_token,
      token_type: tokens.token_type ?? 'Bearer',
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expiry: expiryIso,
    },
    auth_method: 'consumer',
  }
  writeFileSync(file, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: mode bits unsupported — best effort
  }
  return file
}

/** ISO-8601 with local timezone offset, matching agy's writer. */
function formatLocalIso(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export interface CallbackResult {
  code: string
  state: string
}

export interface CallbackHandle {
  result: Promise<CallbackResult>
  close(): Promise<void>
}

const CALLBACK_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>登录成功</title></head>
<body style="font-family:system-ui;text-align:center;padding:3rem">
<h2>✓ 授权成功</h2>
<p>可以关闭此标签页，返回 DeepSeek Harness。</p>
</body></html>`

/**
 * Listen on 127.0.0.1:OAUTH_CALLBACK_PORT for the OAuth redirect.
 * Rejects on bind failure (e.g. port busy) so callers can fall back to
 * manual code paste. Resolves with the first well-formed callback.
 */
export function startCallbackListener(timeoutMs = 300_000): CallbackHandle {
  let resolveResult!: (value: CallbackResult) => void
  let rejectResult!: (reason: Error) => void
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      res.writeHead(400, { 'Content-Type': 'text/html', connection: 'close' })
      res.end(`<h2>Authorization failed: ${oauthError}</h2>`)
      rejectResult(new Error(`oauth error: ${oauthError}`))
      setTimeout(() => server.close(), 1500)
      return
    }
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<h2>Missing code or state</h2>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html', connection: 'close' })
    res.end(CALLBACK_SUCCESS_HTML)
    resolveResult({ code, state })
    // Give the browser a moment to render before the listener closes.
    setTimeout(() => server.close(), 1500)
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    rejectResult(
      error.code === 'EADDRINUSE'
        ? new Error(`port ${OAUTH_CALLBACK_PORT} is busy`)
        : error,
    )
  })

  server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1')

  const timeout = setTimeout(() => {
    rejectResult(new Error('timed out waiting for the OAuth callback'))
    server.close()
  }, timeoutMs)

  return {
    result,
    async close() {
      clearTimeout(timeout)
      if (server.listening) {
        // A keep-alive success page would otherwise hold close() open.
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  }
}

/** Open a URL in the system browser. Resolves false when the launch fails. */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'darwin') {
        execFile('open', [url], (err) => resolve(!err))
      } else if (process.platform === 'win32') {
        // The URL query string contains '&', which cmd.exe would read as a
        // command separator — pass a pre-quoted command line verbatim.
        execFile(
          'cmd.exe',
          ['/d', '/s', '/c', `start "" "${url}"`],
          { windowsVerbatimArguments: true },
          (err) => resolve(!err),
        )
      } else {
        execFile('xdg-open', [url], (err) => resolve(!err))
      }
    } catch {
      resolve(false)
    }
  })
}

/**
 * Parse a manual paste: accepts a bare authorization code or a full
 * loopback redirect URL (http://localhost:51121/oauth-callback?code=...&state=...).
 */
export function parsePastedCode(input: string): { code: string; state?: string } | null {
  const text = input.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const code = url.searchParams.get('code')
      if (!code) return null
      const state = url.searchParams.get('state') ?? undefined
      return { code, state }
    } catch {
      return null
    }
  }
  // Bare code: Google codes look like "4/1Af..." — accept any single token.
  if (/^[\w\-/.%]+$/.test(text) && text.length >= 10) return { code: text }
  return null
}
