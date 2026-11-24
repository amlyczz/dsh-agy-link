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
  unsupportedModels: ReadonlyMap<string, ReadonlyMap<string, number>>
  /** The account-scoped catalog, when discovery ran for that account. */
  catalogFor: (accountId: string) => CatalogView | undefined
  /** The active pool, forwarded to `accountHasArgon`'s dedicated-group probe. */
  pool: unknown
}

/**
 * Whether `acc` can serve `model`.
 *
 * A learned refusal holds until the account's own quota snapshot, refreshed
 * after it, lists the model again: agy also says "not recognized" when it could
 * not load its model list (a TLS timeout once shut a model out of the whole
 * pool until the host restarted). Otherwise the per-model quota
 * snapshot and the discovered catalog decide. Deliberately ACCOUNT-scoped: this
 * is what `selectAccount` routes on, so a sibling account must never make an
 * account look capable of a model its own evidence denies (that would route an
 * unsupported model to the wrong account). Pool-wide "nobody serves this" is
 * handled by the self-heal refresh in account-selection instead (issue #125).
 */
export function accountCanServeModel(acc: ManagedAccount, model: string, ctx: ModelSupportContext): boolean {
  const learnedAt = ctx.unsupportedModels.get(acc.id)?.get(baseModelSlug(model))
  if (learnedAt !== undefined && !quotaListsModelSince(acc, model, learnedAt)) return false
  return accountSupportsModel(acc, model, ctx.pool as never, ctx.catalogFor(acc.id))
}

function quotaListsModelSince(acc: ManagedAccount, model: string, since: number): boolean {
  const quota = acc.quotas?.[modelFamilyOf(model)]
  return (quota?.updatedAt ?? 0) > since && (quota?.models ?? []).some((m) => modelMatches(model, m.modelId))
}
