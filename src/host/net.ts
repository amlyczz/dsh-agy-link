// Proxy-aware fetch for Google endpoints.
//
// Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY env vars, which
// silently broke every quota/OAuth call behind a proxy ("fetch failed"
// while curl worked). We use undici's OWN fetch with EnvHttpProxyAgent:
// mixing an external undici dispatcher into Node's built-in fetch throws
// UND_ERR_INVALID_ARG (bundled-undici version skew), so the dispatcher and
// the fetch must come from the same undici copy. An explicit per-account
// proxyUrl wins over the environment. Everything is per-request — the host
// process's global dispatcher stays untouched.
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'

const envAgent = new EnvHttpProxyAgent()
const perProxyAgents = new Map<string, ProxyAgent>()

function agentFor(proxyUrl?: string): EnvHttpProxyAgent | ProxyAgent {
  if (proxyUrl) {
    let agent = perProxyAgents.get(proxyUrl)
    if (!agent) {
      agent = new ProxyAgent(proxyUrl)
      perProxyAgents.set(proxyUrl, agent)
    }
    return agent
  }
  return envAgent
}

/** fetch() honoring env proxies, or an explicit per-account proxy URL. */
export function agyFetch(url: string, init: RequestInit = {}, proxyUrl?: string): Promise<Response> {
  return undiciFetch(url, {
    ...(init as object),
    dispatcher: agentFor(proxyUrl),
  }) as unknown as Promise<Response>
}
