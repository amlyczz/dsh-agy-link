// External credential-lease API (/plugins/agy-link/lease*): lets a process that
// launches the official agy itself hold the Windows credential slot through this
// plugin's coordination. The registry lives in src/host/external-lease.ts; this
// module validates bodies, maps results to status codes and publishes the
// discovery file external callers use to find the port.
import type { HostServices } from '../../../host/services.ts'
import {
  ExternalLeaseRegistry,
  LEASE_MAX_HOLDER_LEN,
  LEASE_MAX_WAIT_MS,
  removeLinkEndpoint,
  writeLinkEndpoint,
  type LeaseFailure,
  type LinkEndpoint,
} from '../../../host/external-lease.ts'
import { isCrossOriginBlocked, type HttpRequestLike } from '../../../host/media-route.ts'
import { longRouteTimeout } from '../../../common/timeouts.ts'
import { methodOf, readBody, runRoute, sendJson, type RawRes, type RouteRegistrar } from '../respond.ts'

const BASE = '/plugins/agy-link/lease'
const MAX_ID_LEN = 200
const MAX_DIR_LEN = 4096
/** The error text is truncated to 8 KiB by the registry; this only rejects absurd bodies early. */
const MAX_ERROR_LEN = 64 * 1024

class BadRequest extends Error {}

function optString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new BadRequest(key + ' must be a string')
  if (v.length > max) throw new BadRequest(key + ' is longer than ' + max + ' characters')
  return v
}

function optNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest(key + ' must be a finite number')
  return v
}

function optBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new BadRequest(key + ' must be a boolean')
  return v
}

function requiredLeaseId(body: Record<string, unknown>): string {
  const id = optString(body, 'leaseId', MAX_ID_LEN)?.trim() ?? ''
  if (id === '') throw new BadRequest('leaseId is required')
  return id
}

function sendFailure(res: unknown, f: LeaseFailure): void {
  const { status, ...body } = f
  sendJson(res as RawRes, status, body)
}

/**
 * Method + origin gate shared by every lease route. Browsers attach `Origin` to
 * cross-site requests; a webpage must not be able to hold or settle the slot.
 */
function rejected(req: unknown, res: unknown, method: 'GET' | 'POST'): boolean {
  if (isCrossOriginBlocked(req as HttpRequestLike)) {
    sendJson(res as RawRes, 403, { ok: false, code: 'cross_origin', error: 'cross-origin requests are not allowed' })
    return true
  }
  if (methodOf(req) !== method) {
    sendJson(res as RawRes, 405, { ok: false, code: 'method_not_allowed', error: method + ' only' })
    return true
  }
  return false
}

/** Parse a strict JSON body and run `fn`; validation errors become 400. */
function withBody(req: unknown, res: unknown, fn: (body: Record<string, unknown>) => Promise<void> | void, timeoutMs?: number): void {
  runRoute(res, async () => {
    const body = await readBody(req, true)
    if (body.__invalidJson === true) {
      sendJson(res as RawRes, 400, { ok: false, code: 'invalid_json', error: 'body must be a JSON object (at most 1 MiB)' })
      return
    }
    try {
      await fn(body)
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e
      sendJson(res as RawRes, 400, { ok: false, code: 'invalid_request', error: e.message })
    }
  }, timeoutMs)
}

export function register(reg: RouteRegistrar, services: HostServices, port?: number): () => void {
  const { pool, getConfig, log } = services
  const registry = new ExternalLeaseRegistry({
    pool,
    getConfig,
    log,
    // Late-bound: only an acquire needs them.
    agyVersion: () => services.resolveVersion(),
    prepareIsolatedToken: (account) => services.quota.prepareIsolatedCliToken(account),
  })

  reg({
    kind: 'exact',
    path: BASE + '/acquire',
    handler: (req, res) => {
      if (rejected(req, res, 'POST')) return
      // The wait itself is bounded inside the registry; this is only the backstop.
      withBody(req, res, async (body) => {
        const holder = optString(body, 'holder', LEASE_MAX_HOLDER_LEN)?.trim() ?? ''
        if (holder === '') throw new BadRequest('holder is required')
        const model = optString(body, 'model', MAX_ID_LEN)
        const accountId = optString(body, 'accountId', MAX_ID_LEN)
        const accountDir = optString(body, 'accountDir', MAX_DIR_LEN)
        const ttlMs = optNumber(body, 'ttlMs')
        const waitMs = optNumber(body, 'waitMs')
        if (waitMs !== undefined && waitMs <= 0) throw new BadRequest('waitMs must be positive')
        const out = await registry.acquire({
          holder,
          ...(model !== undefined ? { model } : {}),
          ...(accountId !== undefined ? { accountId } : {}),
          ...(accountDir !== undefined ? { accountDir } : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(waitMs !== undefined ? { waitMs } : {}),
        })
        if (!out.ok) {
          sendFailure(res, out)
          return
        }
        // The route backstop already answered: nobody will ever learn this lease id.
        if ((res as { headersSent?: boolean }).headersSent === true) {
          registry.release(out.leaseId)
          return
        }
        sendJson(res as RawRes, 200, out)
      }, longRouteTimeout(LEASE_MAX_WAIT_MS))
    },
  })

  reg({
    kind: 'exact',
    path: BASE + '/renew',
    handler: (req, res) => {
      if (rejected(req, res, 'POST')) return
      withBody(req, res, (body) => {
        const leaseId = requiredLeaseId(body)
        const ttlMs = optNumber(body, 'ttlMs')
        const out = registry.renew(leaseId, ttlMs)
        if (!out.ok) sendFailure(res, out)
        else sendJson(res as RawRes, 200, out)
      })
    },
  })

  reg({
    kind: 'exact',
    path: BASE + '/release',
    handler: (req, res) => {
      if (rejected(req, res, 'POST')) return
      withBody(req, res, (body) => {
        const leaseId = requiredLeaseId(body)
        const ok = optBoolean(body, 'ok')
        const error = optString(body, 'error', MAX_ERROR_LEN)
        const model = optString(body, 'model', MAX_ID_LEN)
        const out = registry.release(leaseId, {
          ...(ok !== undefined ? { ok } : {}),
          ...(error !== undefined ? { error } : {}),
          ...(model !== undefined ? { model } : {}),
        })
        if (!out.ok) sendFailure(res, out)
        else sendJson(res as RawRes, 200, out)
      })
    },
  })

  reg({
    kind: 'exact',
    path: BASE,
    handler: (req, res) => {
      if (rejected(req, res, 'GET')) return
      sendJson(res as RawRes, 200, { leases: registry.list() })
    },
  })

  let endpoint: LinkEndpoint | undefined
  const poolDir = (pool as { dir?: unknown }).dir
  if (typeof port === 'number' && port > 0 && typeof poolDir === 'string' && poolDir !== '') {
    try {
      endpoint = writeLinkEndpoint(poolDir, port)
    } catch (e) {
      log('lease discovery file not written: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return () => {
    registry.dispose()
    if (endpoint && typeof poolDir === 'string') removeLinkEndpoint(poolDir, endpoint)
  }
}
