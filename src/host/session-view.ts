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
import { modelFamilyOf, type ModelFamily } from '../common/pool-types.ts'
import { stickyAccount } from '../provider/account-selection.ts'

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

export function resolveSessionView(services: HostServices, sessionId: string): SessionView {
  const cfg = services.getConfig()
  const model = resolveSessionModel(services, sessionId)
  const pool = services.pool
  const poolData = typeof pool?.getPoolData === 'function'
    ? pool.getPoolData(cfg.proxyUrl?.trim() || undefined)
    : undefined
  const accounts = typeof pool?.getAccounts === 'function'
    ? pool.getAccounts()
    : (poolData?.accounts ?? [])
  let stickyId: string | undefined
  if (model !== '' && sessionId !== '' && pool !== undefined) {
    const family: ModelFamily = modelFamilyOf(model)
    if (family !== 'unknown') {
      try {
        const bound = stickyAccount({ pool, store: services.store }, family, sessionId, model)
        stickyId = bound?.id
      } catch {
        stickyId = undefined
      }
    }
  }
  return buildSessionView({ poolData, accounts, model, stickyAccountId: stickyId })
}