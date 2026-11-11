// Session account selection: sticky affinity, cross-family fallback, and the
// "why is nothing available" diagnostic. Extracted from AgyAdapter.streamAttempt;
// the adapter still owns the post-selection side effects
// (markAccountActive / agyOnAccount).
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Err, type PluginConfig } from '../common/types.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { SessionStore } from '../host/sessions.ts'

export interface AccountSelectionDeps {
  pool?: AccountPoolManager
  store: SessionStore
  syncSessionModel?: (sessionId: string, model: string, effort?: string) => void
}

export interface AccountSelectionInput {
  deps: AccountSelectionDeps
  cfg: PluginConfig
  model: string
  isAux: boolean
  sessionKey: string
  reasoningEffort?: string
}

export interface AccountSelectionResult {
  account: ManagedAccount | undefined
  family: ModelFamily
  activeModel: string
}

/** Session affinity: reuse the account this session last ran on, if eligible. */
function stickyAccount(
  deps: AccountSelectionDeps,
  family: ModelFamily,
  sessionKey: string,
): ManagedAccount | undefined {
  const pool = deps.pool
  if (pool === undefined || sessionKey === '') return undefined
  const prefix = `${sessionKey}:`
  let mostRecent: ManagedAccount | undefined
  let latestUpdated = -1
  for (const [k, b] of Object.entries(deps.store.all())) {
    if (!k.startsWith(prefix) || b.updatedAt <= latestUpdated) continue
    const boundAcc = pool.getAccount(k.slice(prefix.length))
    if (boundAcc !== undefined) {
      mostRecent = boundAcc
      latestUpdated = b.updatedAt
    } else {
      deps.store.delete(k)
    }
  }
  return mostRecent !== undefined && pool.isAccountEligible(mostRecent, family) ? mostRecent : undefined
}

/** Cross-family failover when the requested family has no account left. */
function crossFamilyFallback(
  deps: AccountSelectionDeps,
  family: ModelFamily,
): { account: ManagedAccount; family: ModelFamily; activeModel: string } | null {
  const pool = deps.pool
  if (pool === undefined) return null
  // Quota pools are per FAMILY; downgrading within one shares the exhausted
  // pool, so fail over across families and pin a model of the picked family.
  const familyModel: Partial<Record<ModelFamily, string>> = {
    google: 'gemini-3.8-flash',
    anthropic: 'claude-sonnet-5-5',
    openai: 'gpt-oss-120b-medium',
  }
  for (const fbFam of ['google', 'anthropic', 'openai'] as ModelFamily[]) {
    if (fbFam === family) continue
    const fbAcc = pool.selectAccount(fbFam)
    if (fbAcc !== null && fbAcc !== undefined) {
      return { account: fbAcc, family: fbFam, activeModel: familyModel[fbFam] ?? '' }
    }
  }
  return null
}

/** Wait out a reset that is only seconds away, then re-pick. */
async function waitForShortReset(pool: AccountPoolManager, family: ModelFamily): Promise<ManagedAccount | undefined> {
  const countdown = pool.getEarliestAvailableCountdown?.(family) ?? pool.getEarliestResetCountdown(family)
  if (countdown === null || countdown <= 0 || countdown > 20_000) return undefined
  await new Promise((r) => setTimeout(r, countdown + 250))
  return pool.selectAccount(family) ?? undefined
}

/** Build the "all accounts unavailable" error with the real reasons. */
function unavailableError(pool: AccountPoolManager, family: ModelFamily): LlmError {
  const allAccounts = pool.getAccounts()
  const accounts = allAccounts.filter((a) => a.enabled)
  const disabled = allAccounts.length - accounts.length
  const reasons = accounts.map((a) =>
    typeof pool.explainIneligibility === 'function'
      ? pool.explainIneligibility(a, family)
      : (pool.isAccountEligible(a, family) ? null : 'cooldown'),
  )
  const cooling = reasons.filter((r) => r === 'cooldown').length
  const quotaBlocked = reasons.filter((r) => r === 'quota').length
  const unsupported = reasons.filter((r) => r === 'unsupported').length
  const signedOut = accounts.filter((a) => a.authRequired === true).length
  const countdown = pool.getEarliestAvailableCountdown?.(family) ?? pool.getEarliestResetCountdown(family)
  let why: string
  if (accounts.length === 0 && allAccounts.length > 0) {
    why = 'all accounts are disabled (enable an account in the console or run /agy enable-account)'
  } else if (signedOut > 0 && signedOut === accounts.length) {
    why = 'every account needs a re-login (run /agy auth)'
  } else {
    const details: string[] = []
    if (cooling > 0) details.push(`${cooling} in cooldown`)
    if (quotaBlocked > 0) details.push(`${quotaBlocked} quota-exhausted`)
    if (unsupported > 0) details.push(`${unsupported} lack ${family} access`)
    if (signedOut > 0) details.push(`${signedOut} signed out`)
    if (disabled > 0) details.push(`${disabled} disabled`)
    why = `no account can serve ${family} right now${details.length > 0 ? ` (${details.join(', ')})` : ''}`
  }
  const waitStr = countdown !== null && countdown > 0 ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)` : ''
  const hint = unsupported > 0 && quotaBlocked === 0 && cooling === 0
    ? `No enabled account has access to ${family} (requires a plan with ${family} enabled).`
    : quotaBlocked > 0 && cooling === 0
      ? 'Add an account, wait for the quota reset, or run /agy clear-cooldown to override the current quota snapshot.'
      : 'Add an account, wait for reset, or run /agy clear-cooldown.'
  return new LlmError(`All Antigravity accounts are unavailable: ${why}${waitStr}. ${hint}`, Err.AGY_ERROR)
}

export async function selectSessionAccount(input: AccountSelectionInput): Promise<AccountSelectionResult> {
  const { deps, cfg, model, isAux, sessionKey, reasoningEffort } = input
  let activeModel = model === '' ? cfg.defaultModel : model
  let family = modelFamilyOf(activeModel)
  if (model === '' && activeModel !== '' && !isAux && sessionKey !== '') {
    deps.syncSessionModel?.(sessionKey, activeModel, reasoningEffort)
  }

  const pool = deps.pool
  let account: ManagedAccount | undefined
  // Windows has one global credential slot; align sessions to the pool's
  // active candidate so they share it lock-free (parallelSameAccount).
  if (pool !== undefined && !isAux && sessionKey !== '' && process.platform === 'win32' && cfg.parallelSameAccount) {
    account = pool.selectAccount(family) ?? undefined
  }
  if (account === undefined && pool !== undefined && !isAux && sessionKey !== '') {
    account = stickyAccount(deps, family, sessionKey)
  }
  if (account === undefined && pool !== undefined) {
    account = pool.selectAccount(family) ?? undefined
  }
  if (account !== undefined && pool !== undefined && pool.getPoolData().lastActiveAccountId !== account.id) {
    pool.setActiveAccount(account.id, family)
  }

  if (account === undefined && pool !== undefined && pool.getAccounts().length > 0) {
    if (cfg.autoFallbackModel) {
      const fb = crossFamilyFallback(deps, family)
      if (fb !== null) {
        account = fb.account
        family = fb.family
        if (fb.activeModel !== '') activeModel = fb.activeModel
        if (!isAux && sessionKey !== '') deps.syncSessionModel?.(sessionKey, activeModel)
      }
    }
    if (account === undefined) account = await waitForShortReset(pool, family)
    if (account === undefined) throw unavailableError(pool, family)
  }

  return { account, family, activeModel }
}
