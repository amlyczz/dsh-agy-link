// Pure model-catalog parsing, effort folding, fallback projection, and slug
// resolution (spec ADR-10). Extracted from host/models.ts so domain parsing
// stays pure, side-effect-free, and well within the file budget.
import type { FallbackModelDef, PluginConfig } from '../../common/types.ts'
import { normalizeEfforts, splitEffortSuffix } from '../../common/reasoning.ts'
import { PREFERRED_CLAUDE, PREFERRED_CLAUDE_OPUS, PREFERRED_OPENAI } from '../../common/model-lineup.ts'

export interface RawModel { slug: string; label: string }

export interface CatalogEntry {
  id: string
  name: string
  /** null = fixed-thinking model (no effort flag). */
  efforts: readonly string[] | null
}

export interface Catalog {
  source: 'discovered' | 'fallback'
  models: readonly CatalogEntry[]
  discoveredAt: number
  /** Last discovery error, surfaced by /agy models and doctor. */
  lastError?: string
}

/**
 * True when `agy models` exited 0 only because it printed an unauthenticated
 * static fallback list while warning on stderr/stdout (#122).
 */
export function isUnauthenticatedModelsFallback(stdout: string, stderr: string): boolean {
  return /please sign in|not signed in|not logged in|authentication required|silent auth failed|auth mode is unspecified/i.test(
    stderr + '\n' + stdout,
  )
}

export function sameCatalogEntry(a: CatalogEntry, b: CatalogEntry | undefined): boolean {
  if (!b || a.id !== b.id || a.name !== b.name) return false
  const ea = a.efforts ?? null
  const eb = b.efforts ?? null
  if (ea === eb) return true
  if (!ea || !eb || ea.length !== eb.length) return false
  return ea.every((v, idx) => v === eb[idx])
}

/** Parse `agy models` stdout: JSON shapes first, then two-column text. */
export function parseModelsOutput(stdout: string): RawModel[] {
  const text = stdout.trim()
  if (text === '') return []
  try {
    const parsed: unknown = JSON.parse(text)
    const list = extractModelList(parsed)
    if (list) return dedupeBySlug(list)
  } catch {
    // fall through to text parsing
  }
  const out: RawModel[] = []
  for (const line of text.split(/\n/)) {
    const t = line.trim()
    if (t === '' || /^(fetching|error|failed|warning|please sign in|tip:)/i.test(t)) continue
    const m = t.match(/^(\S+)(?:\t+|\s{2,})(.+)$/)
    if (m && m[1] !== undefined && m[2] !== undefined) out.push({ slug: m[1], label: m[2].trim() })
    else if (/^\S+$/.test(t)) out.push({ slug: t, label: t })
  }
  return dedupeBySlug(out)
}

function dedupeBySlug(raw: readonly RawModel[]): RawModel[] {
  const seen = new Set<string>()
  const out: RawModel[] = []
  for (const r of raw) {
    if (!r.slug || typeof r.slug !== 'string') continue
    const slug = r.slug.trim()
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, label: (typeof r.label === 'string' && r.label.trim() !== '') ? r.label.trim() : slug })
  }
  return out
}

function extractModelList(parsed: unknown): RawModel[] | null {
  let arr: unknown[] | null = null
  if (Array.isArray(parsed)) arr = parsed
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of ['models', 'items', 'data', 'result']) {
      if (Array.isArray(o[k])) {
        arr = o[k] as unknown[]
        break
      }
    }
  }
  if (!arr) return null
  const out: RawModel[] = []
  for (const item of arr) {
    if (typeof item === 'string') {
      out.push({ slug: item, label: item })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const slugV = o.slug ?? o.id ?? o.name ?? o.model
    const labelV = o.label ?? o.display_name ?? o.displayName ?? o.title ?? slugV
    if (typeof slugV === 'string' && slugV !== '') {
      out.push({ slug: slugV, label: typeof labelV === 'string' ? labelV : slugV })
    }
  }
  return out
}

/** Fold Gemini/Argon/Claude effort variants into base + effort set (spec ADR-10). */
export function foldEfforts(raw: readonly RawModel[]): CatalogEntry[] {
  const bases = new Map<string, { label: string; efforts: Set<string> }>()
  const verbatim: CatalogEntry[] = []
  const slugSet = new Set(raw.map((r) => r.slug))
  for (const r of raw) {
    if (!r.slug.startsWith('gemini') && !r.slug.startsWith('argon') && !r.slug.startsWith('claude')) {
      verbatim.push({ id: r.slug, name: r.label, efforts: null })
      continue
    }
    const split = splitEffortSuffix(r.slug)
    if (split.effort !== undefined) {
      const base = split.base
      const eff = split.effort
      const hasBare = slugSet.has(base)
      const hasSibling = raw.some((x) => x.slug !== r.slug && splitEffortSuffix(x.slug).base === base)
      if (hasBare || hasSibling) {
        const entry = bases.get(base) ?? { label: stripEffortLabel(r.label, eff), efforts: new Set<string>() }
        entry.efforts.add(eff)
        bases.set(base, entry)
        continue
      }
    }
    verbatim.push({ id: r.slug, name: r.label, efforts: null })
  }
  const folded: CatalogEntry[] = []
  for (const [id, v] of bases) {
    const efforts = normalizeEfforts(v.efforts)
    folded.push({ id, name: v.label !== '' ? v.label : id, efforts: efforts.length > 0 ? efforts : null })
  }
  const rawOrder = new Map(raw.map((r, i) => [r.slug, i] as const))
  const rank = (e: CatalogEntry): number => {
    let best = Infinity
    for (const r of raw) {
      if (r.slug === e.id || r.slug.startsWith(e.id + '-')) best = Math.min(best, rawOrder.get(r.slug) ?? Infinity)
    }
    return best
  }
  return [...folded, ...verbatim.filter((e) => !bases.has(e.id))]
    .sort((a, b) => rank(a) - rank(b))
}

function stripEffortLabel(label: string, eff: string): string {
  const re = new RegExp('\\s*\\(?' + eff + '\\)?\\s*$', 'i')
  return label.replace(re, '').trim()
}

export function buildFallbackCatalog(defs: readonly FallbackModelDef[]): CatalogEntry[] {
  return defs
    .filter((d) => Boolean(d && typeof d.id === 'string' && d.id.trim() !== ''))
    .map((d) => ({
      id: d.id.trim(),
      name: (typeof d.name === 'string' && d.name.trim() !== '') ? d.name.trim() : d.id.trim(),
      efforts: Array.isArray(d.efforts) && d.efforts.length > 0 ? d.efforts.filter((e) => typeof e === 'string' && e.trim() !== '') : null,
    }))
}

export function sanitizeCatalogEntries(models: readonly CatalogEntry[]): {
  entries: Array<{ id: string; name: string; efforts: string[] }>
  dropped: string[]
} {
  const seen = new Set<string>()
  const entries: Array<{ id: string; name: string; efforts: string[] }> = []
  const dropped: string[] = []
  for (const m of models) {
    if (!m || typeof m.id !== 'string') continue
    const id = m.id.trim()
    if (id === '') continue
    if (seen.has(id)) {
      dropped.push(id)
      continue
    }
    seen.add(id)
    const name = typeof m.name === 'string' && m.name.trim() !== '' ? m.name.trim() : id
    entries.push({ id, name, efforts: normalizeEfforts(m.efforts) })
  }
  return { entries, dropped }
}

export function resolveModelSlug(id: string): string {
  const s = id.trim().toLowerCase()
  if (s === 'claude-opus') return PREFERRED_CLAUDE_OPUS
  if (s === 'claude-sonnet') return PREFERRED_CLAUDE
  if (s === 'claude-opus-4-6' || s === 'claude-opus-4-8' || s === 'claude-opus-4.6' || s === 'claude-opus-4-5') {
    return 'claude-opus-4-6-thinking'
  }
  if (s === 'claude-sonnet-4.6' || s === 'claude-sonnet-4-5') {
    return 'claude-sonnet-4-6'
  }
  if (s === 'gpt-oss-120b' || s === 'gpt-oss-20b' || s === 'gpt-oss') {
    return PREFERRED_OPENAI
  }
  const claude55 = s.match(/^(claude-(?:sonnet|opus)-5-5)-(?:low|medium|high)$/)
  if (claude55 !== null && claude55[1] !== undefined) return claude55[1]
  return id.trim()
}

export function findEntry(catalog: Catalog, id: string): CatalogEntry | undefined {
  const direct = catalog.models.find((m) => m.id === id)
  if (direct) return direct
  const resolved = resolveModelSlug(id)
  if (resolved !== id) {
    return catalog.models.find((m) => m.id === resolved)
  }
  return undefined
}

export function defaultEffortFor(entry: CatalogEntry, cfg: PluginConfig): string | undefined {
  if (!entry.efforts || entry.efforts.length === 0) return undefined
  if (cfg.defaultEffort !== '' && entry.efforts.includes(cfg.defaultEffort)) return cfg.defaultEffort
  for (const pref of ['high', 'medium', 'low']) {
    if (entry.efforts.includes(pref)) return pref
  }
  return entry.efforts[entry.efforts.length - 1]
}
