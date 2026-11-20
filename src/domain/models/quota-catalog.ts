// Model availability derived from quota snapshots (issue #131).
//
// WHY this exists: `getModelsForAccount` can only answer from `agy models`
// output, so on a machine without the agy CLI the settings panel offered the 7
// static fallback rows and the picker looked broken even though the account
// pool already knew the real list. Every quota refresh stores the account's own
// `quotas.<family>.models[]` (modelId + displayName), which is exactly the
// per-account "what can I actually run" answer. This module folds those rows
// into catalog entries so the panel can show them and the picker can honour a
// selected subset.
//
// Pure by construction: no IO, no clock, no config reads — the callers pass
// everything in.
import type { ModelFamily, ModelQuotaInfo, ManagedAccount } from '../../common/pool-types.ts'
import { modelFamilyOf } from '../../common/pool-types.ts'
import { foldEfforts } from './parse.ts'
import type { CatalogEntry, RawModel } from './parse.ts'

/** Families whose quota rows describe models the picker may offer. */
const QUOTA_FAMILIES: readonly ModelFamily[] = ['google', 'argon', 'anthropic', 'openai']

/**
 * Models an account's quota snapshot says are available.
 *
 * `displayName` is preferred over the raw slug for the label (agy's quota rows
 * say "Gemini 4 Neon (Low)", the picker should not show `gemini-4-neon-low`).
 * Rows without a usable `modelId` are skipped rather than guessed at.
 */
export function quotaModelsForAccount(account: ManagedAccount | undefined | null): RawModel[] {
  const quotas = account?.quotas
  if (!quotas) return []
  const out: RawModel[] = []
  const seen = new Set<string>()
  for (const family of QUOTA_FAMILIES) {
    const rows: readonly ModelQuotaInfo[] | undefined = quotas[family]?.models
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!row || typeof row.modelId !== 'string') continue
      const slug = row.modelId.trim()
      if (slug === '' || seen.has(slug)) continue
      seen.add(slug)
      const label = typeof row.displayName === 'string' && row.displayName.trim() !== '' ? row.displayName.trim() : slug
      out.push({ slug, label })
    }
  }
  return out
}

/** Same as {@link quotaModelsForAccount}, folded into picker entries. */
export function quotaCatalogForAccount(account: ManagedAccount | undefined | null): CatalogEntry[] {
  return foldEfforts(quotaModelsForAccount(account))
}

/**
 * Merge the CLI-discovered catalog with quota-derived entries.
 *
 * Precedence: a discovered entry wins on IDENTITY and ORDER (agy is
 * authoritative about what it can run and in which order it lists models), but
 * a quota row may CONTRIBUTE a model the catalog never mentioned — that is the
 * whole point of the merge: on a CLI-less host the catalog is a 7-row fallback
 * and the account knows about 23+ real models.
 *
 * Effort sets are unioned so a folded catalog entry (`gemini-4-neon` with
 * low/medium/high) keeps any extra level only the quota rows knew about.
 */
export function mergeCatalogWithQuotaModels(
  discovered: readonly CatalogEntry[],
  quota: readonly CatalogEntry[],
): CatalogEntry[] {
  if (quota.length === 0) return [...discovered]
  const merged: CatalogEntry[] = []
  const byId = new Map<string, CatalogEntry>()
  const index = new Map<string, number>()

  const add = (entry: CatalogEntry, allowOverrideName: boolean): void => {
    const existingAt = index.get(entry.id)
    if (existingAt === undefined) {
      index.set(entry.id, merged.length)
      byId.set(entry.id, entry)
      merged.push(entry)
      return
    }
    const existing = byId.get(entry.id)
    if (!existing) return
    const efforts = unionEfforts(existing.efforts, entry.efforts)
    const name = allowOverrideName && existing.name === existing.id && entry.name !== entry.id ? entry.name : existing.name
    const next: CatalogEntry = { id: existing.id, name, efforts }
    byId.set(entry.id, next)
    merged[existingAt] = next
  }

  for (const entry of discovered) add(entry, false)
  for (const entry of quota) add(entry, true)
  return disambiguateLabels(merged)
}

/**
 * Make sure no two rows render under the same label.
 *
 * The quota snapshot is not above this. On a current pool `gemini-2.5-flash`,
 * `gemini-2.5-flash-lite`, `gemini-2.5-flash-thinking` and
 * `gemini-3.5-flash-lite` ALL report "Gemini 3.5 Flash Lite" (upstream keeps the
 * legacy slugs pointing at the current model), and effort-folding makes
 * `gemini-4-hydrogen-tiered` inherit "Gemini 4 Hydrogen" from its `(High)`
 * siblings. Identical chips are unusable — the user cannot tell which box ticks
 * what.
 *
 * Resolution is not "first wins", it is a stem test: a colliding row keeps its
 * label only when every other row in the group is an ID-DERIVED VARIANT of it
 * (`<id>-<something>`). That keeps "Gemini 4 Hydrogen" on the base model and
 * demotes `-tiered`/`-sonar`, while a group of genuinely different models (the
 * 2.5/3.5 legacy aliases) has no stem and every row falls back to its id — which
 * is unique by construction and is what the picker sends back anyway.
 */
function disambiguateLabels(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const groups = new Map<string, CatalogEntry[]>()
  for (const entry of entries) {
    const bucket = groups.get(entry.name)
    if (bucket) bucket.push(entry)
    else groups.set(entry.name, [entry])
  }
  const keep = new Set<string>()
  for (const rows of groups.values()) {
    if (rows.length === 1) continue
    const stem = rows.find((candidate) =>
      candidate.name !== candidate.id
      && rows.every((other) => other === candidate || other.id.startsWith(candidate.id + '-')),
    )
    if (stem) keep.add(stem.id)
  }
  return entries.map((entry) => {
    if (entry.name === entry.id) return entry
    const rows = groups.get(entry.name) ?? []
    if (rows.length <= 1) return entry
    return keep.has(entry.id) ? entry : { ...entry, name: entry.id }
  })
}

function unionEfforts(
  a: readonly string[] | null,
  b: readonly string[] | null,
): readonly string[] | null {
  const left = a ?? []
  const right = b ?? []
  if (right.length === 0) return a
  if (left.length === 0) return b
  const all = new Set([...left, ...right])
  return all.size === left.length ? a : [...left, ...right.filter((e) => !left.includes(e))]
}

/** True when one account's quota rows cover `modelId` (base id or effort variant). */
function accountQuotaOffers(account: ManagedAccount, wanted: string): boolean {
  const rows = account.quotas?.[modelFamilyOf(wanted)]?.models
  if (!Array.isArray(rows) || rows.length === 0) return false
  return rows.some((row) => {
    if (!row || typeof row.modelId !== 'string') return false
    const candidate = row.modelId.trim().toLowerCase()
    return candidate === wanted || candidate.startsWith(wanted + '-')
  })
}

/**
 * Accounts whose quota rows list `modelId`, for the panel's per-model tooltip
 * ("offered by 2 of 3 accounts").
 */
export function accountsOfferingModel(
  accounts: readonly ManagedAccount[],
  modelId: string,
): string[] {
  const wanted = modelId.trim().toLowerCase()
  if (wanted === '') return []
  return accounts
    .filter((acc): acc is ManagedAccount => Boolean(acc) && acc.enabled !== false)
    .filter((acc) => accountQuotaOffers(acc, wanted))
    .map((acc) => acc.id)
}
