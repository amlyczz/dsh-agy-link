// "Can this account serve this model right now?" — the pool-level question.
//
// Extracted from AccountPoolManager so one cohesive module owns the rule and the
// pool keeps a thin delegate (budget: pool.ts sits on the 600-line ceiling).
import { accountSupportsModel, baseModelSlug, type ManagedAccount } from '../common/pool-types.ts'

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
  /** Per-account ids learned to reject this model (agy said "not recognized"). */
  unsupportedModels: ReadonlyMap<string, ReadonlySet<string>>
  /** The account-scoped catalog, when discovery ran for that account. */
  catalogFor: (accountId: string) => CatalogView | undefined
  /** The active pool, forwarded to `accountHasArgon`'s dedicated-group probe. */
  pool: unknown
}

/**
 * Whether `acc` can serve `model`.
 *
 * A learned refusal is final for that account. Otherwise the per-model quota
 * snapshot and the discovered catalog decide. Deliberately ACCOUNT-scoped: this
 * is what `selectAccount` routes on, so a sibling account must never make an
 * account look capable of a model its own evidence denies (that would route an
 * unsupported model to the wrong account). Pool-wide "nobody serves this" is
 * handled by the self-heal refresh in account-selection instead (issue #125).
 */
export function accountCanServeModel(acc: ManagedAccount, model: string, ctx: ModelSupportContext): boolean {
  if (ctx.unsupportedModels.get(acc.id)?.has(baseModelSlug(model))) return false
  return accountSupportsModel(acc, model, ctx.pool as never, ctx.catalogFor(acc.id))
}
