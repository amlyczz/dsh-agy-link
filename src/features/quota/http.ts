// Quota HTTP I/O: endpoint fan-out for the summary / user-quota / available
// models calls plus the OAuth userinfo lookup. URLs, headers, bodies and the
// 401/403/network fallbacks match the previous QuotaService bodies.
import { looksLikeTosViolation, looksLikeValidationRequired } from '../../common/types.ts'
import { agyUserAgent } from '../../domain/quota/identity.ts'
import type {
  DiscoveredModelsResponse,
  QuotaSummaryResponse,
  UserQuotaResponse,
} from '../../domain/quota/parse.ts'
import { agyFetch } from '../../host/net.ts'
import { AGY_ENDPOINTS, fetchUserInfo as fetchOAuthUserInfo, OAUTH_USERINFO_URL } from '../../host/oauth.ts'
import {
  endpointHealthKey,
  orderEndpointsByHealth,
  type EndpointHealthLike,
} from './endpoint-health.ts'

export { OAUTH_USERINFO_URL }

/**
 * Why a quota summary fetch produced nothing. The console needs the difference:
 * a licence refusal is not something a retry can fix, while a network fault is.
 *
 * `detail` carries only an API enum (e.g. `PERMISSION_DENIED`) — never a
 * message body, which can contain account identifiers.
 */
export interface QuotaSummaryFailure {
  /**
   * `no_summary_access` — the backend refuses the SUMMARY endpoint for this
   * account (free tier: `403 PERMISSION_DENIED`). Terminal for the summary call
   * only; the account can still serve models, so it keeps polling (#137).
   * `validation_required` / `tos_violation` — Google `403 PERMISSION_DENIED`
   * carrying `VALIDATION_REQUIRED` or `TOS_VIOLATION`; must never be mislabeled
   * as a free-tier account.
   */
  kind: 'no_license' | 'no_summary_access' | 'validation_required' | 'tos_violation' | 'auth' | 'http' | 'network'
  status?: number
  detail?: string
  /** Optional HTTPS verification/appeal URL extracted from structured 403 details. */
  actionUrl?: string
}

/**
 * I/O seams the endpoint loops need. `fetchSummaryEndpoint` /
 * `fetchUserQuotaEndpoint` are supplied by QuotaService so its protected
 * (test-overridable) methods stay the actual network boundary, and the
 * preferred-endpoint index stays on the instance rather than in this module.
 *
 * `endpointHealth` and `onSummaryFailure` are optional so tests (and any other
 * caller) keep the historical first-endpoint ordering and silent failure.
 */
export interface QuotaHttpDeps {
  agyVersion(): string | null
  accountScope?: string
  getPreferredEndpointIndex(): number
  setPreferredEndpointIndex(index: number): void
  fetchSummaryEndpoint(endpoint: string, accessToken: string, proxyUrl?: string, accountScope?: string): Promise<Response>
  fetchUserQuotaEndpoint(endpoint: string, accessToken: string, proxyUrl?: string, accountScope?: string): Promise<Response>
  /** Recent-failure memory: failed endpoints are tried last, never skipped. */
  endpointHealth?: EndpointHealthLike
  /** Reports the refusal that left the summary empty (null = authoritative data). */
  onSummaryFailure?: (failure: QuotaSummaryFailure | null) => void
}

/** Re-order endpoints so the preferred/working endpoint is tried first. */
function orderedEndpoints(preferredIndex: number): string[] {
  const total = AGY_ENDPOINTS.length
  const ordered: string[] = []
  for (let i = 0; i < total; i++) {
    ordered.push(AGY_ENDPOINTS[(preferredIndex + i) % total]!)
  }
  return ordered
}

/** The API's own status enum, which is safe to surface (no message body). */
function apiErrorStatus(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { status?: unknown } }
    return typeof parsed.error?.status === 'string' ? parsed.error.status : undefined
  } catch {
    return undefined
  }
}

function networkFailureCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } })?.cause
  return typeof cause?.code === 'string' ? cause.code : undefined
}

function extractHttpsActionUrl(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { details?: Array<Record<string, unknown>> } }
    const details = parsed?.error?.details
    if (Array.isArray(details)) {
      for (const d of details) {
        const meta = d?.metadata as Record<string, unknown> | undefined
        const direct = meta?.validation_url ?? meta?.appeal_url ?? d?.url
        if (typeof direct === 'string' && direct.startsWith('https://')) return direct
        const links = d?.links
        if (Array.isArray(links)) {
          for (const l of links) {
            const u = (l as Record<string, unknown> | undefined)?.url
            if (typeof u === 'string' && u.startsWith('https://')) return u
          }
        }
      }
    }
  } catch {
    // fall through to regex scan
  }
  const m = bodyText.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+|https:\/\/support\.google\.com\/[^\s"'<>]+/)
  return m ? m[0] : undefined
}

/**
 * Classify a refusal. Structured `VALIDATION_REQUIRED` and `TOS_VIOLATION`
 * share `403 PERMISSION_DENIED` with free-tier refusals, so they MUST be
 * checked first — otherwise a Pro/Ultra account needing Google verification is
 * mislabeled as a free-tier account.
 */
export function classifySummaryRefusal(status: number, bodyText = ''): QuotaSummaryFailure {
  const detail = apiErrorStatus(bodyText)
  if (status === 401) return { kind: 'auth', status, ...(detail === undefined ? {} : { detail }) }
  if (status === 403 && looksLikeTosViolation(bodyText)) {
    const actionUrl = extractHttpsActionUrl(bodyText)
    return {
      kind: 'tos_violation',
      status,
      ...(detail === undefined ? {} : { detail }),
      ...(actionUrl === undefined ? {} : { actionUrl }),
    }
  }
  if (status === 403 && looksLikeValidationRequired(bodyText)) {
    const actionUrl = extractHttpsActionUrl(bodyText)
    return {
      kind: 'validation_required',
      status,
      ...(detail === undefined ? {} : { detail }),
      ...(actionUrl === undefined ? {} : { actionUrl }),
    }
  }
  // A free-tier account has no 5h summary window, so the endpoint refuses it.
  // `status` (the API-level detail) is the more specific signal, so it is
  // checked before the licence regex (#142).
  if (status === 403 && detail === 'PERMISSION_DENIED') {
    return { kind: 'no_summary_access', status, detail }
  }
  if (status === 403 && /licen[cs]e/i.test(bodyText)) {
    return { kind: 'no_license', status, ...(detail === undefined ? {} : { detail }) }
  }
  return { kind: 'http', status, ...(detail === undefined ? {} : { detail }) }
}


/**
 * Query live user info (email) from Google OAuth userinfo endpoint.
 */
export async function fetchUserInfo(
  accessToken: string,
  proxyUrl?: string,
  accountScope?: string,
): Promise<{ email?: string; name?: string } | null> {
  return fetchOAuthUserInfo(accessToken, proxyUrl, accountScope)
}

/** POST /v1internal:retrieveUserQuotaSummary for one endpoint. */
export function requestQuotaSummaryEndpoint(
  endpoint: string,
  accessToken: string,
  proxyUrl: string | undefined,
  agyVersion: string | null,
  accountScope?: string,
): Promise<Response> {
  return agyFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agyUserAgent(agyVersion),
    },
    body: JSON.stringify({}),
  }, proxyUrl, accountScope)
}

/**
 * Fetch official multi-bucket quota summary (both weekly and 5h limit windows)
 * via v1internal:retrieveUserQuotaSummary.
 */
export async function fetchQuotaSummary(
  deps: QuotaHttpDeps,
  accessToken: string,
  proxyUrl?: string,
): Promise<QuotaSummaryResponse | null> {
  const endpoints = orderEndpointsByHealth(
    orderedEndpoints(deps.getPreferredEndpointIndex()),
    'summary',
    deps.endpointHealth,
  )
  let partialSummary: QuotaSummaryResponse | null = null
  let refusal: QuotaSummaryFailure | null = null
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    const healthKey = endpointHealthKey('summary', endpoint)
    try {
      const res = await deps.fetchSummaryEndpoint(endpoint, accessToken, proxyUrl, deps.accountScope)
      if (res.ok) {
        deps.endpointHealth?.noteSuccess(healthKey)
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
            deps.onSummaryFailure?.(null)
            return partialSummary
          }
          if (i > 0 && !partialSummary) {
            deps.setPreferredEndpointIndex(AGY_ENDPOINTS.indexOf(endpoint))
          }
          deps.onSummaryFailure?.(null)
          return summary
        }
        if (!partialSummary && summary && Array.isArray(summary.groups) && summary.groups.length > 0) {
          partialSummary = summary
        }
      }
      // If auth fails (401/403), the token itself is invalid/expired — no need to flood other endpoints
      if (res.status === 401 || res.status === 403) {
        // The endpoint answered; the ACCOUNT was refused. Keep using it.
        deps.endpointHealth?.noteSuccess(healthKey)
        refusal = classifySummaryRefusal(res.status, await res.text().catch(() => ''))
        break
      }
      if (res.status >= 500) deps.endpointHealth?.noteFailure(healthKey)
      else deps.endpointHealth?.noteSuccess(healthKey)
      refusal = classifySummaryRefusal(res.status)
    } catch (error) {
      // Try next endpoint on network connection errors
      deps.endpointHealth?.noteFailure(healthKey)
      const code = networkFailureCode(error)
      refusal = { kind: 'network', ...(code === undefined ? {} : { detail: code }) }
    }
  }
  deps.onSummaryFailure?.(partialSummary === null ? refusal : null)
  return partialSummary
}

/** POST /v1internal:retrieveUserQuota for one endpoint. */
export function requestUserQuotaEndpoint(
  endpoint: string,
  accessToken: string,
  proxyUrl: string | undefined,
  agyVersion: string | null,
  accountScope?: string,
): Promise<Response> {
  return agyFetch(`${endpoint}/v1internal:retrieveUserQuota`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agyUserAgent(agyVersion),
    },
    body: JSON.stringify({}),
  }, proxyUrl, accountScope)
}

/**
 * Fetch per-model live user quota via v1internal:retrieveUserQuota.
 */
export async function fetchUserQuota(
  deps: QuotaHttpDeps,
  accessToken: string,
  proxyUrl?: string,
): Promise<UserQuotaResponse | null> {
  const endpoints = orderEndpointsByHealth(
    orderedEndpoints(deps.getPreferredEndpointIndex()),
    'userQuota',
    deps.endpointHealth,
  )
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    const healthKey = endpointHealthKey('userQuota', endpoint)
    try {
      const res = await deps.fetchUserQuotaEndpoint(endpoint, accessToken, proxyUrl, deps.accountScope)
      if (res.ok) {
        deps.endpointHealth?.noteSuccess(healthKey)
        return (await res.json()) as UserQuotaResponse
      }
      // A 401/403 is the ACCOUNT being refused, not a dead endpoint.
      if (res.status === 401 || res.status === 403) {
        deps.endpointHealth?.noteSuccess(healthKey)
        break
      }
      if (res.status >= 500) deps.endpointHealth?.noteFailure(healthKey)
      else deps.endpointHealth?.noteSuccess(healthKey)
    } catch {
      // Try next endpoint
      deps.endpointHealth?.noteFailure(healthKey)
    }
  }
  return null
}

/**
 * Fetch available models and model-level quotas via v1internal:fetchAvailableModels.
 */
export async function fetchAvailableModels(
  deps: QuotaHttpDeps,
  accessToken: string,
  proxyUrl?: string,
): Promise<DiscoveredModelsResponse | null> {
  const endpoints = orderEndpointsByHealth(
    orderedEndpoints(deps.getPreferredEndpointIndex()),
    'models',
    deps.endpointHealth,
  )
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    const healthKey = endpointHealthKey('models', endpoint)
    try {
      const res = await agyFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': agyUserAgent(deps.agyVersion()),
        },
        body: JSON.stringify({}),
      }, proxyUrl, deps.accountScope)
      if (res.ok) {
        deps.endpointHealth?.noteSuccess(healthKey)
        if (AGY_ENDPOINTS.indexOf(endpoint) === 0) {
          deps.setPreferredEndpointIndex(0)
        }
        return (await res.json()) as DiscoveredModelsResponse
      }
      // A 401/403 is the ACCOUNT being refused, not a dead endpoint.
      if (res.status === 401 || res.status === 403) {
        deps.endpointHealth?.noteSuccess(healthKey)
        break
      }
      if (res.status >= 500) deps.endpointHealth?.noteFailure(healthKey)
      else deps.endpointHealth?.noteSuccess(healthKey)
    } catch {
      // Try next endpoint
      deps.endpointHealth?.noteFailure(healthKey)
    }
  }
  return null
}