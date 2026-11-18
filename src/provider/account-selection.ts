// Session account selection: sticky affinity, cross-family fallback, and the
// "why is nothing available" diagnostic. Extracted from AgyAdapter.streamAttempt;
// the adapter still owns the post-selection side effects
// (markAccountActive / agyOnAccount).
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Err, type PluginConfig } from '../common/types.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { SessionStore } from '../host/sessions.ts'
import { PREFERRED_CLAUDE, PREFERRED_GEMINI_FLASH, PREFERRED_OPENAI } from '../common/model-lineup.ts'

export interface AccountSelectionDeps {
  pool?: AccountPoolManager
  store: SessionStore
  syncSessionModel?: (sessionId: string, model: string, effort?: string) => void
  /**
   * Re-poll quotas (and the model catalog) for the whole pool. Used only as a
   * self-heal: when EVERY enabled account is denied purely because the model is
   * missing from its snapshot, that snapshot is far more likely truncated than
   * the pool is genuinely incapable (issue #125).
   */
  refreshQuota?: () => Promise<void>
}

/** Upper bound on the self-heal refresh so a slow network cannot stall a turn. */
const MODEL_HEAL_TIMEOUT_MS = 20_000

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
  model?: string,
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
  return mostRecent !== undefined
    && (typeof pool.isAccountEligibleForModel === 'function'
      ? pool.isAccountEligibleForModel(mostRecent, family, model)
      : pool.isAccountEligible(mostRecent, family))
    ? mostRecent
    : undefined
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
    google: PREFERRED_GEMINI_FLASH,
    anthropic: PREFERRED_CLAUDE,
    openai: PREFERRED_OPENAI,
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
async function waitForShortReset(pool: AccountPoolManager, family: ModelFamily, model?: string): Promise<ManagedAccount | undefined> {
  const countdown = pool.getEarliestAvailableCountdown?.(family) ?? pool.getEarliestResetCountdown(family)
  if (countdown === null || countdown <= 0 || countdown > 20_000) return undefined
  await new Promise((r) => setTimeout(r, countdown + 250))
  return pool.selectAccount(family, model) ?? undefined
}

/**
 * One self-heal attempt for issue #125: if EVERY enabled account was denied
 * solely because the requested model is absent from its per-model snapshot,
 * refresh quotas and retry selection once. A truncated snapshot is the common
 * cause (the pool demonstrably served the model minutes earlier); a genuinely
 * unsupported model simply fails the retry and reports as before.
 */
async function healStaleModelSnapshot(
  deps: AccountSelectionDeps,
  pool: AccountPoolManager,
  family: ModelFamily,
  model: string,
): Promise<ManagedAccount | undefined> {
  const refresh = deps.refreshQuota
  if (refresh === undefined || model === '') return undefined
  const enabled = pool.getAccounts().filter((a) => a.enabled)
  if (enabled.length === 0) return undefined
  const reasons = enabled.map((a) => pool.explainIneligibility?.(a, family, Date.now(), model) ?? null)
  // Only the model-mismatch reason qualifies: quota/auth/cooldown have their own
  // remedies and must not trigger a network round-trip here.
  if (!reasons.every((r) => r === 'model-unsupported')) return undefined
  try {
    await Promise.race([
      refresh(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, MODEL_HEAL_TIMEOUT_MS)
        t.unref?.()
      }),
    ])
  } catch {
    return undefined
  }
  return pool.selectAccount(family, model) ?? undefined
}

/** Build the "all accounts unavailable" error with the real reasons. */
function unavailableError(pool: AccountPoolManager, family: ModelFamily, model?: string): LlmError {
  const allAccounts = pool.getAccounts()
  const accounts = allAccounts.filter((a) => a.enabled)
  const disabled = allAccounts.length - accounts.length
  const reasons = accounts.map((a) =>
    typeof pool.explainIneligibility === 'function'
      ? pool.explainIneligibility(a, family, Date.now(), model)
      : (pool.isAccountEligible(a, family) ? null : 'cooldown'),
  )
  const cooling = reasons.filter((r) => r === 'cooldown').length
  const quotaBlocked = reasons.filter((r) => r === 'quota').length
  const unsupported = reasons.filter((r) => r === 'unsupported').length
  const modelUnsupported = reasons.filter((r) => r === 'model-unsupported').length
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
    if (modelUnsupported > 0) details.push(`${modelUnsupported} lack model "${model ?? ''}" in their catalog`)
    if (signedOut > 0) details.push(`${signedOut} signed out`)
    if (disabled > 0) details.push(`${disabled} disabled`)
    why = `no account can serve ${family} right now${details.length > 0 ? ` (${details.join(', ')})` : ''}`
  }
  const waitStr = countdown !== null && countdown > 0 ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)` : ''
  const hint = modelUnsupported > 0 && unsupported === 0 && quotaBlocked === 0 && cooling === 0
    ? `Requested model "${model ?? ''}" is not in any enabled account's catalog — refresh the model list (POST /plugins/agy-link/pool/refresh-quota) or pick a listed model. It is NOT a missing ${family} plan.`
    : unsupported > 0 && quotaBlocked === 0 && cooling === 0
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
    account = pool.selectAccount(family, activeModel) ?? undefined
  }
  if (account === undefined && pool !== undefined && !isAux && sessionKey !== '') {
    account = stickyAccount(deps, family, sessionKey, activeModel)
  }
  if (account === undefined && pool !== undefined) {
    account = pool.selectAccount(family, activeModel) ?? undefined
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
    if (account === undefined) account = await waitForShortReset(pool, family, activeModel)
    if (account === undefined) account = await healStaleModelSnapshot(deps, pool, family, activeModel)
    if (account === undefined) throw unavailableError(pool, family, activeModel)
  }

  return { account, family, activeModel }
}
