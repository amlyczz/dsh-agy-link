// HTTP auth, RFC 9110 Range, HEAD, ETag/304, and download helpers for local media routes.
import { createReadStream, type Stats } from 'node:fs'
import { basename } from 'node:path'

export interface HttpResponseLike {
  writeHead(status: number, headers: Record<string, string | number>): unknown
  end(body?: unknown): unknown
  on?(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface HttpRequestLike {
  url?: string
  method?: string
  headers?: Record<string, string | string[] | undefined>
}

/**
 * Minimal slice of DSH's `HostConnectionService` (`ctx.get('connection')`).
 * Returns `undefined` when the request satisfies DSH's Host/Origin/trustedHosts
 * fence AND browser cookie/API authentication, or `401` / `403` when rejected.
 */
export interface ConnectionTrustLike {
  requestRejection(request: {
    readonly headers: Record<string, string | string[] | undefined>
  }): 401 | 403 | undefined
}

export function headerFirst(req: HttpRequestLike, name: string): string {
  const headers = req.headers
  if (!headers) return ''
  const target = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== target || v === undefined) continue
    const raw = Array.isArray(v) ? v[0] : v
    return typeof raw === 'string' ? raw.trim() : ''
  }
  return ''
}

function stripPort(hostHeader: string): string {
  const first = hostHeader.split(',')[0]?.trim().toLowerCase() ?? ''
  if (first === '') return ''
  if (first.startsWith('[')) {
    const end = first.indexOf(']')
    return end >= 0 ? first.slice(0, end + 1) : first
  }
  const colon = first.lastIndexOf(':')
  return colon > 0 ? first.slice(0, colon) : first
}

function normalizeHostWithPort(hostHeader: string): string {
  return (hostHeader.split(',')[0] ?? '').trim().toLowerCase()
}

export function isDesktopOrigin(origin: string): boolean {
  return /^(?:dsh-app|app|vscode-webview):\/\//i.test(origin)
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

/**
 * Authorize a plugin HTTP request.
 *
 * When DSH's `connection` service is present, delegate directly to its
 * `requestRejection(req)` fence so requests arriving over configured
 * `trustedHosts` (Cloudflare Tunnel / reverse proxy) with valid browser auth
 * cookies succeed while untrusted origins and unauthenticated callers are
 * rejected with 403/401.
 *
 * When `connection` is absent (unit tests / older hosts), allow loopback and
 * desktop origins plus same-origin requests whose `Origin` host matches
 * `Host`/`X-Forwarded-Host` (and `Sec-Fetch-Site !== 'cross-site'`).
 */
export function authorizePluginRequest(
  req: HttpRequestLike,
  connection?: ConnectionTrustLike,
): 401 | 403 | undefined {
  if (connection && typeof connection.requestRejection === 'function') {
    return connection.requestRejection({ headers: req.headers ?? {} })
  }
  const secFetchSite = headerFirst(req, 'sec-fetch-site').toLowerCase()
  if (secFetchSite === 'cross-site') return 403

  const origin = headerFirst(req, 'origin')
  if (!origin) return undefined
  if (origin === 'null') return 403
  if (isDesktopOrigin(origin)) return undefined
  try {
    const u = new URL(origin)
    if (isLoopbackHostname(u.hostname)) return undefined
    const reqHost = normalizeHostWithPort(headerFirst(req, 'x-forwarded-host') || headerFirst(req, 'host'))
    if (reqHost !== '') {
      const originHost = u.host.toLowerCase()
      const originHostNoPort = u.hostname.toLowerCase()
      if (originHost === reqHost || originHostNoPort === stripPort(reqHost)) {
        return undefined
      }
    }
    return 403
  } catch {
    return 403
  }
}

/**
 * Strict loopback/desktop gate for `POST /plugins/agy-link/open`.
 *
 * Even an authenticated remote browser behind Cloudflare Tunnel or a LAN proxy
 * must NEVER launch Finder/Explorer/media players on the host desktop.
 */
export function isRemoteOpenBlocked(req: HttpRequestLike): boolean {
  if (headerFirst(req, 'cf-connecting-ip') !== '' || headerFirst(req, 'cf-ray') !== '') {
    return true
  }
  const origin = headerFirst(req, 'origin')
  if (origin !== '') {
    if (origin === 'null') return true
    if (isDesktopOrigin(origin)) return false
    try {
      return !isLoopbackHostname(new URL(origin).hostname)
    } catch {
      return true
    }
  }
  const forwardedHost = stripPort(headerFirst(req, 'x-forwarded-host'))
  if (forwardedHost !== '' && !isLoopbackHostname(forwardedHost)) return true
  const host = stripPort(headerFirst(req, 'host'))
  if (host !== '' && !isLoopbackHostname(host)) return true
  const referer = headerFirst(req, 'referer')
  if (referer !== '' && !isDesktopOrigin(referer)) {
    try {
      if (!isLoopbackHostname(new URL(referer).hostname)) return true
    } catch {
      return true
    }
  }
  return false
}

export type ParsedByteRange = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parse an HTTP `Range: bytes=...` header per RFC 9110 §14.1.2.
 * Supports `bytes=start-end`, `bytes=start-`, and suffix ranges `bytes=-N`
 * (used by browsers to fetch the `moov` atom at the tail of non-faststart MP4s).
 */
export function parseByteRange(rangeHeader: string, totalSize: number): ParsedByteRange {
  const trimmed = rangeHeader.trim()
  if (!/^bytes=/i.test(trimmed)) return null
  if (totalSize <= 0) return 'unsatisfiable'
  const firstSpec = (trimmed.slice(6).split(',')[0] ?? '').trim()
  const dash = firstSpec.indexOf('-')
  if (dash < 0) return null
  const startRaw = firstSpec.slice(0, dash).trim()
  const endRaw = firstSpec.slice(dash + 1).trim()

  if (startRaw === '') {
    // Suffix byte range: bytes=-N
    if (!/^\d+$/.test(endRaw)) return 'unsatisfiable'
    const suffix = Number.parseInt(endRaw, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    const start = Math.max(0, totalSize - suffix)
    return { start, end: totalSize - 1 }
  }

  if (!/^\d+$/.test(startRaw)) return 'unsatisfiable'
  const start = Number.parseInt(startRaw, 10)
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) return 'unsatisfiable'

  if (endRaw === '') {
    return { start, end: totalSize - 1 }
  }
  if (!/^\d+$/.test(endRaw)) return 'unsatisfiable'
  const parsedEnd = Number.parseInt(endRaw, 10)
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) return 'unsatisfiable'
  return { start, end: Math.min(parsedEnd, totalSize - 1) }
}

export function buildContentDisposition(filePath: string, download: boolean): string {
  if (!download) return 'inline'
  const rawName = basename(filePath) || 'download'
  const asciiFallback = rawName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(rawName).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

export function sendMediaStream(
  req: HttpRequestLike,
  res: HttpResponseLike,
  filePath: string,
  contentType: string,
  st: Pick<Stats, 'size' | 'mtimeMs'>,
  opts: { download?: boolean; cacheTag?: string; extraHeaders?: Record<string, string | number> } = {},
): void {
  const totalSize = st.size
  const isHead = (req.method ?? 'GET').toUpperCase() === 'HEAD'
  const etag = `"${totalSize.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${opts.cacheTag ? '-' + opts.cacheTag : ''}"`
  const lastModified = new Date(st.mtimeMs).toUTCString()
  const disposition = buildContentDisposition(filePath, opts.download === true)
  const commonHeaders: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': disposition,
    'ETag': etag,
    'Last-Modified': lastModified,
    'X-Content-Type-Options': 'nosniff',
    ...(opts.extraHeaders ?? {}),
  }

  const rangeHeader = headerFirst(req, 'range')
  const inm = headerFirst(req, 'if-none-match')
  if (rangeHeader === '' && inm !== '' && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
    res.writeHead(304, {
      'ETag': etag,
      'Last-Modified': lastModified,
      'Cache-Control': 'private, max-age=3600',
    })
    res.end()
    return
  }

  if (rangeHeader !== '') {
    const parsed = parseByteRange(rangeHeader, totalSize)
    if (parsed === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${totalSize}`, 'Content-Type': 'text/plain' })
      res.end(isHead ? undefined : 'requested range not satisfiable')
      return
    }
    if (parsed !== null) {
      const { start, end } = parsed
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': end - start + 1,
        ...commonHeaders,
      })
      if (isHead) {
        res.end()
        return
      }
      const stream = createReadStream(filePath, { start, end })
      stream.on('error', () => { try { res.end() } catch { /* ignore */ } })
      res.on?.('close', () => { try { stream.destroy() } catch { /* ignore */ } })
      // @ts-ignore HttpResponseLike wraps Node ServerResponse
      stream.pipe(res)
      return
    }
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': totalSize,
    ...commonHeaders,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  })

  if (isHead || totalSize === 0) {
    res.end()
    return
  }

  const stream = createReadStream(filePath)
  stream.on('error', () => { try { res.end() } catch { /* ignore */ } })
  res.on?.('close', () => { try { stream.destroy() } catch { /* ignore */ } })
  // @ts-ignore HttpResponseLike wraps Node ServerResponse
  stream.pipe(res)
}
