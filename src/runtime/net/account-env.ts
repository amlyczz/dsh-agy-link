// One place for "which proxy/HOME does this agy process get".
//
// Before this module the precedence (account proxy > global config > detected
// system) and the env assembly existed in ~18 and ~20 places respectively:
// adapter, quota, oneshot, discovery, pool-auth, cli. They drifted.
import { homedir } from 'node:os'
import type { PluginConfig } from '../../common/types.ts'
import { isolatedHomeEnv, proxyEnvFor } from '../../host/runner.ts'
import { detectSystemProxy } from '../../host/wincred.ts'

export interface AccountEnvRef {
  id?: string
  /** Isolated HOME for a secondary account; empty/undefined = system HOME. */
  dir?: string
  proxyUrl?: string
}

/** Account proxy > global proxy > detected system proxy. */
export function pickProxy(accountProxy: string | undefined, globalProxy: string | undefined): string | undefined {
  const own = (accountProxy ?? '').trim()
  if (own !== '') return own
  const global = (globalProxy ?? '').trim()
  if (global !== '') return global
  return detectSystemProxy() ?? undefined
}

export function resolveProxy(account: AccountEnvRef | undefined, cfg: PluginConfig): string | undefined {
  return pickProxy(account?.proxyUrl, cfg.proxyUrl)
}

/** HOME agy will use: the isolated account dir, else the real user HOME. */
export function accountHome(account: AccountEnvRef | undefined): string {
  return account?.dir !== undefined && account.dir !== '' ? account.dir : (process.env.HOME ?? homedir())
}

export interface BuildAgyEnvInput {
  account?: AccountEnvRef
  cfg: PluginConfig
  base?: NodeJS.ProcessEnv
  /** Stamped into the child env so the MCP bridge can resolve the DSH session. */
  sessionId?: string
  /**
   * Add the telemetry opt-out flags. Callers that already set them keep this
   * true; the provider path keeps its historical env exactly (false).
   */
  telemetryFlags?: boolean
}

export interface BuildAgyEnvWithProxyInput {
  account?: AccountEnvRef
  proxy?: string
  base?: NodeJS.ProcessEnv
  sessionId?: string
}

/** Same assembly when the caller already resolved the proxy (quota/oneshot). */
export function buildAgyEnvWithProxy(input: BuildAgyEnvWithProxyInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(input.base ?? process.env) }
  if (input.sessionId !== undefined && input.sessionId !== '') env.DSH_MCP_SESSION = input.sessionId
  if (input.account?.dir !== undefined && input.account.dir !== '') {
    Object.assign(env, isolatedHomeEnv(input.account.dir))
  }
  Object.assign(env, proxyEnvFor(input.proxy))
  return env
}

export function buildAgyEnv(input: BuildAgyEnvInput): NodeJS.ProcessEnv {
  const env = buildAgyEnvWithProxy({
    ...(input.account === undefined ? {} : { account: input.account }),
    proxy: resolveProxy(input.account, input.cfg),
    ...(input.base === undefined ? {} : { base: input.base }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  })
  if (input.telemetryFlags === true && input.cfg.disableTelemetry) {
    env.DO_NOT_TRACK = '1'
    env.DISABLE_TELEMETRY = '1'
    env.GOOGLE_CLOUD_DISABLE_TELEMETRY = '1'
    env.ANTIGRAVITY_DISABLE_TELEMETRY = '1'
  } else {
    delete env.DO_NOT_TRACK
    delete env.DISABLE_TELEMETRY
    delete env.GOOGLE_CLOUD_DISABLE_TELEMETRY
    delete env.ANTIGRAVITY_DISABLE_TELEMETRY
  }
  return env
}
