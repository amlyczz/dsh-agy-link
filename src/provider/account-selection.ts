// Session account selection: sticky affinity, cross-family fallback, and the
// "why is nothing available" diagnostic. Extracted verbatim from
// AgyAdapter.streamAttempt; the adapter still owns the post-selection side
// effects (markAccountActive / agyOnAccount).
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

export async function selectSessionAccount(input: AccountSelectionInput): Promise<AccountSelectionResult> {
  const { deps, cfg, model, isAux, sessionKey, reasoningEffort } = input
  let activeModel = model === '' ? cfg.defaultModel : model
  let family = modelFamilyOf(activeModel)
  if (model === '' && activeModel !== '' && !isAux && sessionKey !== '') {
    deps.syncSessionModel?.(sessionKey, activeModel, reasoningEffort)
  }

  // Sticky session account affinity:
  // If this session is already communicating on an account and that account's quota
  // has NOT run out (still eligible for this model family), stick to it!
  // Only switch accounts when the current account's quota is exhausted.
  // Switching accounts mid-session throws away native agy conversation history
  // and forces re-sending the entire multi-turn context (buildDigest),
  // which wastes huge amounts of token quota.
  let account: ManagedAccount | undefined
  if (deps.pool && !isAux && sessionKey !== '') {
    // Scheme A: On Windows (shared global Credential Manager slot), cross-account
    // session affinity forces different sessions to ping-pong on the single
    // slot and completely serializes them. Align all concurrent sessions to the
    // pool's current active healthy candidate so they share the slot under
    // `parallelSameAccount: true` and run with 100% lock-free concurrency.
    if (process.platform === 'win32' && cfg.parallelSameAccount) {
      const poolActive = deps.pool.selectAccount(family)
      if (poolActive) {
        account = poolActive
      }
    }

    if (!account) {
      const prefix = `${sessionKey}:`
      let mostRecentAccount: ManagedAccount | undefined
      let latestUpdated = -1

      for (const [k, b] of Object.entries(deps.store.all())) {
        if (k.startsWith(prefix) && b.updatedAt > latestUpdated) {
          const boundId = k.slice(prefix.length)
          const boundAcc = deps.pool.getAccount(boundId)
          if (boundAcc) {
            mostRecentAccount = boundAcc
            latestUpdated = b.updatedAt
          } else {
            deps.store.delete(k)
          }
        }
      }

      if (mostRecentAccount && deps.pool.isAccountEligible(mostRecentAccount, family)) {
        account = mostRecentAccount
      }
    }
  }

  if (!account && deps.pool) {
    account = deps.pool.selectAccount(family) ?? undefined
  }

  if (account && deps.pool) {
    if (deps.pool.getPoolData().lastActiveAccountId !== account.id) {
      deps.pool.setActiveAccount(account.id, family)
    }
  }
  if (deps.pool && deps.pool.getAccounts().length > 0 && !account) {
    if (cfg.autoFallbackModel) {
      // Quota pools are per FAMILY (Gemini / Claude / GPT-OSS). Downgrading
      // within the requested family shares the exhausted pool, so the old
      // hardcoded gemini-3.5/3.6 list could never rescue a drained Google
      // family. Fail over across families instead, then pin a model id of the
      // family the scheduler just picked.
      const familyModel: Partial<Record<ModelFamily, string>> = {
        google: 'gemini-3.8-flash',
        anthropic: 'claude-sonnet-5-5',
        openai: 'gpt-oss-120b-medium',
      }
      for (const fbFam of ['google', 'anthropic', 'openai'] as ModelFamily[]) {
        if (fbFam === family) continue
        const fbAcc = deps.pool.selectAccount(fbFam)
        if (fbAcc) {
          account = fbAcc
          family = fbFam
          activeModel = familyModel[fbFam] ?? activeModel
          if (!isAux && sessionKey !== '') {
            deps.syncSessionModel?.(sessionKey, activeModel)
          }
          break
        }
      }
    }
    if (!account) {
      // Distinguish WHY nothing is available. "in cooldown" used to absorb
      // every ineligible account, including the ones benched by the proactive
      // low-quota rotation — which `/agy clear-cooldown` could not touch, so
      // the reported remedy never worked. Ask the pool for the real reason.
      const pool = deps.pool
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
      // A reset that is seconds away is not worth failing a turn over: wait
      // it out (bounded) and let the scheduler re-pick instead of making the
      // user resend. Longer waits still fail fast with an accurate ETA.
      if (countdown !== null && countdown > 0 && countdown <= 20_000) {
        await new Promise((r) => setTimeout(r, countdown + 250))
        account = pool.selectAccount(family) ?? undefined
      }
      if (!account) {
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
          const detailStr = details.length > 0 ? ` (${details.join(', ')})` : ''
          why = `no account can serve ${family} right now${detailStr}`
        }
        const waitStr = countdown !== null && countdown > 0
          ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)`
          : ''
        const hint = unsupported > 0 && quotaBlocked === 0 && cooling === 0
          ? `No enabled account has access to ${family} (requires a plan with ${family} enabled).`
          : quotaBlocked > 0 && cooling === 0
          ? 'Add an account, wait for the quota reset, or run /agy clear-cooldown to override the current quota snapshot.'
          : 'Add an account, wait for reset, or run /agy clear-cooldown.'
        throw new LlmError(`All Antigravity accounts are unavailable: ${why}${waitStr}. ${hint}`, Err.AGY_ERROR)
      }
    }
  }


  return { account, family, activeModel }
}
