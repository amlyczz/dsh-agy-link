// "Can this account serve this model right now?" — the pool-level question.
//
// Extracted from AccountPoolManager so one cohesive module owns the rule and the
// pool keeps a thin delegate (budget: pool.ts sits on the 600-line ceiling).
import { accountSupportsModel, baseModelSlug, modelFamilyOf, modelMatches, type ManagedAccount } from '../common/pool-types.ts'

/**
 * The minimal catalog shape this rule needs. Deliberately structural rather
 * than importing the ModelCatalog type: pool.ts owns the catalog handle and
 * models.ts imports the pool, so a real type import would close a cycle.
 */
export interface CatalogView {
  models?: readonly { id: string }[]
  source?: string
}

export interface ModelSupportContext {
  /** Per account: the model slugs agy said "not recognized" for, and when that was learned. */
  unsupportedModels: ReadonlyMap<string, ReadonlyMap<string, number> | ReadonlySet<string>>
  /** The account-scoped catalog, when discovery ran for that account. */
  catalogFor: (accountId: string) => CatalogView | undefined
  /** The active pool, forwarded to `accountHasArgon`'s dedicated-group probe. */
  pool: unknown
}

export const LISTED_REFUSAL_RETRY_MS = 2 * 60_000

function refusalHealed(acc: ManagedAccount, model: string, learnedAt: number): boolean {
  const quota = acc.quotas?.[modelFamilyOf(model)]
  if (!(quota?.models ?? []).some((m) => modelMatches(model, m.modelId))) return false
  return (quota?.updatedAt ?? 0) > learnedAt || Date.now() - learnedAt >= LISTED_REFUSAL_RETRY_MS
}

/**
 * Whether `acc` can serve `model`.
 *
 * A learned refusal is final while the account's own quota snapshot does not
 * list the model. When it does, agy's "not recognized" may just mean it could
 * not load its model list (a TLS timeout once shut a model out of the whole
 * pool until the host restarted), so the refusal ends with a quota refresh
 * after it, or after LISTED_REFUSAL_RETRY_MS (the poll runs hourly and goes
 * through the same network). Otherwise the per-model quota
 * snapshot and the discovered catalog decide. Deliberately ACCOUNT-scoped: this
 * is what `selectAccount` routes on, so a sibling account must never make an
 * account look capable of a model its own evidence denies (that would route an
 * unsupported model to the wrong account). Pool-wide "nobody serves this" is
 * handled by the self-heal refresh in account-selection instead (issue #125).
 */
export function accountCanServeModel(acc: ManagedAccount, model: string, ctx: ModelSupportContext): boolean {
  const entry = ctx.unsupportedModels.get(acc.id)
  if (entry) {
    const slug = baseModelSlug(model)
    if (entry instanceof Map) {
      const learnedAt = entry.get(slug)
      if (learnedAt !== undefined && !refusalHealed(acc, model, learnedAt)) return false
    } else if (entry.has(slug)) {
      return false
    }
  }
  return accountSupportsModel(acc, model, ctx.pool as never, ctx.catalogFor(acc.id))
}
