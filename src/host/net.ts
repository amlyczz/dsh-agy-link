// Proxy-aware & account-isolated fetch for Google endpoints.
//
// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY env vars, which
// silently broke every quota/OAuth call behind a proxy ("fetch failed"
// while curl worked). We use undici's OWN fetch with EnvHttpProxyAgent:
// mixing an external undici dispatcher into Node's built-in fetch throws
// UND_ERR_INVALID_ARG (bundled-undici version skew), so the dispatcher and
// the fetch must come from the same undici copy.
//
// Anti-correlation invariant: dispatchers are keyed by `accountScope@@proxy`
// so two Google accounts sharing one proxy never multiplex Bearer tokens over
// the same upstream TCP socket / TLS session.
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { detectSystemProxy } from './wincred.ts'

const defaultEnvAgent = new EnvHttpProxyAgent()
const perProxyAgents = new Map<string, ProxyAgent>()
const perScopeEnvAgents = new Map<string, EnvHttpProxyAgent>()

const MAX_CACHED_AGENTS = 32

export function dispatcherKeyFor(proxyUrl?: string, accountScope?: string): string {
  const scope = accountScope && accountScope.trim() !== '' ? accountScope.trim() : 'global'
  const effective = (proxyUrl ?? '').trim() || (detectSystemProxy() ?? '').trim() || 'env'
  return `${scope}@@${effective}`
}

export function agentForScope(proxyUrl?: string, accountScope?: string): EnvHttpProxyAgent | ProxyAgent {
  const effective = (proxyUrl ?? '').trim() || (detectSystemProxy() ?? '').trim()
  if (effective) {
    const key = dispatcherKeyFor(effective, accountScope)
    let agent = perProxyAgents.get(key)
    if (!agent) {
      if (perProxyAgents.size >= MAX_CACHED_AGENTS) {
        const oldestKey = perProxyAgents.keys().next().value
        if (oldestKey !== undefined) {
          const old = perProxyAgents.get(oldestKey)
          perProxyAgents.delete(oldestKey)
          void old?.close().catch(() => undefined)
        }
      }
      agent = new ProxyAgent(effective)
      perProxyAgents.set(key, agent)
    }
    return agent
  }
  if (accountScope && accountScope.trim() !== '') {
    const scopeKey = accountScope.trim()
    let envScoped = perScopeEnvAgents.get(scopeKey)
    if (!envScoped) {
      if (perScopeEnvAgents.size >= MAX_CACHED_AGENTS) {
        const oldestKey = perScopeEnvAgents.keys().next().value
        if (oldestKey !== undefined) {
          const old = perScopeEnvAgents.get(oldestKey)
          perScopeEnvAgents.delete(oldestKey)
          void old?.close().catch(() => undefined)
        }
      }
      envScoped = new EnvHttpProxyAgent()
      perScopeEnvAgents.set(scopeKey, envScoped)
    }
    return envScoped
  }
  return defaultEnvAgent
}

/** Close cached per-proxy and per-account dispatchers on plugin disposal. */
export async function closeProxyAgents(): Promise<void> {
  const agents: Array<{ close(): Promise<void> }> = [
    ...perProxyAgents.values(),
    ...perScopeEnvAgents.values(),
  ]
  perProxyAgents.clear()
  perScopeEnvAgents.clear()
  await Promise.allSettled(agents.map((a) => a.close()))
}

export const AGY_FETCH_TIMEOUT_MS = 10_000

/** fetch() honoring env/per-account proxies and per-account connection-pool isolation. */
export function agyFetch(
  url: string,
  init: RequestInit = {},
  proxyUrl?: string,
  accountScope?: string,
): Promise<Response> {
  const callerSignal = (init as { signal?: AbortSignal | null }).signal ?? undefined
  const signal = callerSignal !== undefined
    ? AbortSignal.any([AbortSignal.timeout(AGY_FETCH_TIMEOUT_MS), callerSignal])
    : AbortSignal.timeout(AGY_FETCH_TIMEOUT_MS)
  return undiciFetch(url, {
    ...(init as object),
    signal,
    dispatcher: agentForScope(proxyUrl, accountScope),
  }) as unknown as Promise<Response>
}
