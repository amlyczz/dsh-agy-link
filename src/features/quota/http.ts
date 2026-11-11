// Quota HTTP I/O: endpoint fan-out for the summary / user-quota / available
// models calls plus the OAuth userinfo lookup. URLs, headers, bodies and the
// 401/403/network fallbacks match the previous QuotaService bodies.
import { agyUserAgent } from '../../domain/quota/identity.ts'
import type {
  DiscoveredModelsResponse,
  QuotaSummaryResponse,
  UserQuotaResponse,
} from '../../domain/quota/parse.ts'
import { agyFetch } from '../../host/net.ts'
import { AGY_ENDPOINTS } from '../../host/oauth.ts'

export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

/**
 * I/O seams the endpoint loops need. `fetchSummaryEndpoint` /
 * `fetchUserQuotaEndpoint` are supplied by QuotaService so its protected
 * (test-overridable) methods stay the actual network boundary, and the
 * preferred-endpoint index stays on the instance rather than in this module.
 */
export interface QuotaHttpDeps {
  agyVersion(): string | null
  getPreferredEndpointIndex(): number
  setPreferredEndpointIndex(index: number): void
  fetchSummaryEndpoint(endpoint: string, accessToken: string, proxyUrl?: string): Promise<Response>
  fetchUserQuotaEndpoint(endpoint: string, accessToken: string, proxyUrl?: string): Promise<Response>
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

/**
 * Query live user info (email) from Google OAuth userinfo endpoint.
 */
export async function fetchUserInfo(accessToken: string, proxyUrl?: string): Promise<{ email?: string; name?: string } | null> {
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

/** POST /v1internal:retrieveUserQuotaSummary for one endpoint. */
export function requestQuotaSummaryEndpoint(
  endpoint: string,
  accessToken: string,
  proxyUrl: string | undefined,
  agyVersion: string | null,
): Promise<Response> {
  return agyFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agyUserAgent(agyVersion),
    },
    body: JSON.stringify({}),
  }, proxyUrl)
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
  const endpoints = orderedEndpoints(deps.getPreferredEndpointIndex())
  let partialSummary: QuotaSummaryResponse | null = null
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    try {
      const res = await deps.fetchSummaryEndpoint(endpoint, accessToken, proxyUrl)
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
            deps.setPreferredEndpointIndex(AGY_ENDPOINTS.indexOf(endpoint))
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

/** POST /v1internal:retrieveUserQuota for one endpoint. */
export function requestUserQuotaEndpoint(
  endpoint: string,
  accessToken: string,
  proxyUrl: string | undefined,
  agyVersion: string | null,
): Promise<Response> {
  return agyFetch(`${endpoint}/v1internal:retrieveUserQuota`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agyUserAgent(agyVersion),
    },
    body: JSON.stringify({}),
  }, proxyUrl)
}

/**
 * Fetch per-model live user quota via v1internal:retrieveUserQuota.
 */
export async function fetchUserQuota(
  deps: QuotaHttpDeps,
  accessToken: string,
  proxyUrl?: string,
): Promise<UserQuotaResponse | null> {
  const endpoints = orderedEndpoints(deps.getPreferredEndpointIndex())
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    try {
      const res = await deps.fetchUserQuotaEndpoint(endpoint, accessToken, proxyUrl)
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
export async function fetchAvailableModels(
  deps: QuotaHttpDeps,
  accessToken: string,
  proxyUrl?: string,
): Promise<DiscoveredModelsResponse | null> {
  const endpoints = orderedEndpoints(deps.getPreferredEndpointIndex())
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i]!
    try {
      const res = await agyFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': agyUserAgent(deps.agyVersion()),
        },
        body: JSON.stringify({}),
      }, proxyUrl)
      if (res.ok) {
        if (AGY_ENDPOINTS.indexOf(endpoint) === 0) {
          deps.setPreferredEndpointIndex(0)
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