// Host side of the session-scoped header readout.
//
// Resolves the model actually selected for one DSH session (the same
// `model/selection` event the provider honours when it dispatches), then the
// account + quota book the scheduler would use for that model's family. The
// resolution itself is pure (`common/session-view.ts`); this module only reads
// services.
import type { HostServices } from './services.ts'
import { latestAgyModelOf } from './service-helpers.ts'
import { buildSessionView, type SessionView } from '../common/session-view.ts'
import { modelFamilyOf, sharedArgonPeerFamily, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import { stickyAccount } from '../provider/account-selection.ts'
import { resolveEligibleActiveAccountId } from '../domain/accounts/selection.ts'

/**
 * The model that governs THIS session:
 *  1. its latest `model/selection` event (what the composer shows),
 *  2. the configured `defaultModel` — exactly the value account selection uses
 *     when DSH passes an empty model,
 *  3. the model of the most recent run (older hosts, or a session whose
 *     selection predates the event).
 */
export function resolveSessionModel(services: HostServices, sessionId: string): string {
  let model = ''
  if (sessionId !== '') {
    try {
      const session = services.sessionsSvc()?.get(sessionId)
      model = (latestAgyModelOf(session) ?? '').trim()
    } catch {
      model = ''
    }
  }
  if (model === '') model = (services.getConfig().defaultModel ?? '').trim()
  if (model === '') model = (services.lastRun?.model ?? '').trim()
  return model
}

function liveSessionAccountId(
  services: HostServices,
  accounts: readonly ManagedAccount[],
  sessionId: string,
  family: ModelFamily,
): string | undefined {
  const fromTracker = services.adapter?.activeAccountForSession?.(sessionId)
  const raw = fromTracker ?? (() => {
    const rec = services.adapter?.getActiveRun?.(sessionId)
    return rec && !rec.isSettled && rec.accountId && rec.family
      ? { accountId: rec.accountId, family: rec.family }
      : undefined
  })()
  if (raw === undefined) return undefined
  const acc = accounts.find((a) => a.id === raw.accountId)
  if (acc === undefined) return undefined
  if (raw.family === family || sharedArgonPeerFamily(acc, family) === raw.family) {
    return acc.id
  }
  return undefined
}

export function resolveSessionView(services: HostServices, sessionId: string): SessionView {
  const cfg = services.getConfig()
  const model = resolveSessionModel(services, sessionId)
  const pool = services.pool
  let poolData = typeof pool?.getPoolData === 'function'
    ? pool.getPoolData(cfg.proxyUrl?.trim() || undefined)
    : undefined
  const accounts = typeof pool?.getAccounts === 'function'
    ? pool.getAccounts()
    : (poolData?.accounts ?? [])
  let stickyId: string | undefined
  if (model !== '' && sessionId !== '' && pool !== undefined) {
    const family: ModelFamily = modelFamilyOf(model)
    if (family !== 'unknown') {
      stickyId = liveSessionAccountId(services, accounts, sessionId, family)
      if (stickyId === undefined) {
        try {
          const bound = stickyAccount({ pool, store: services.store }, family, sessionId, model)
          stickyId = bound?.id
        } catch {
          stickyId = undefined
        }
      }
    }
  }
  // The pool's `resolvedActiveAccountIds` is family-level (no model), so it
  // may name an account that cannot serve this session's model. Refine an
  // existing prediction with the model, matching what dispatch would pick;
  // never invent one for a family the pool has no prediction for.
  const fam = model === '' ? 'unknown' : modelFamilyOf(model)
  if (poolData !== undefined && fam !== 'unknown' && pool !== undefined &&
      poolData.resolvedActiveAccountIds?.[fam] !== undefined) {
    let predicted: string | undefined
    try {
      predicted = resolveEligibleActiveAccountId(accounts, poolData.activeAccountIds, fam, pool, Date.now(), model)
    } catch {
      predicted = undefined
    }
    const resolved = { ...(poolData.resolvedActiveAccountIds ?? {}) }
    if (predicted !== undefined) resolved[fam] = predicted
    else delete resolved[fam]
    poolData = { ...poolData, resolvedActiveAccountIds: resolved }
  }
  return buildSessionView({ poolData, accounts, model, stickyAccountId: stickyId })
}