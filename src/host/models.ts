// Model discovery and projection (spec ADR-10): agy models output ->
// DSH catalog entries. Gemini slugs fold into a base model plus selectable
// reasoning efforts; non-Gemini slugs (claude-*, gpt-oss-* size variants)
// stay verbatim with no effort toggle, matching observed agy behavior
// (agy rejects --effort for Claude/GPT-OSS). Discovery failure falls back to
// a bundled catalog so the /model picker is never empty.
import type { FallbackModelDef, PluginConfig } from '../common/types.ts'

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
    const t = line.trim();
    if (t === '' || t.startsWith('Fetching') || t.startsWith('Error')) continue
    // agy 1.1.15 prints a TAB-separated two-column table; older builds and
    // some locales use two-or-more spaces.
    const m = t.match(/^(\S+)(?:\t+|\s{2,})(.+)$/)
    if (m && m[1] !== undefined && m[2] !== undefined) out.push({ slug: m[1], label: m[2].trim() });
    else if (/^\S+$/.test(t)) out.push({ slug: t, label: t });
  }
  return dedupeBySlug(out);
}

/** First occurrence wins: duplicate raw slugs would become duplicate catalog ids. */
function dedupeBySlug(raw: readonly RawModel[]): RawModel[] {
  const seen = new Set<string>()
  const out: RawModel[] = []
  for (const r of raw) {
    if (seen.has(r.slug)) continue
    seen.add(r.slug)
    out.push(r)
  }
  return out
}

function extractModelList(parsed: unknown): RawModel[] | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of ['models', 'items', 'data', 'result']) {
      if (Array.isArray(o[k])) {
        arr = o[k] as unknown[];
        break;
      }
    }
  }
  if (!arr) return null;
  const out: RawModel[] = []
  for (const item of arr) {
    if (typeof item === 'string') {
      out.push({ slug: item, label: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const slugV = o.slug ?? o.id ?? o.name ?? o.model;
    const labelV = o.label ?? o.display_name ?? o.displayName ?? o.title ?? slugV;
    if (typeof slugV === 'string' && slugV !== '') {
      out.push({ slug: slugV, label: typeof labelV === 'string' ? labelV : slugV });
    }
  }
  return out;
}

const EFFORT_SUFFIXES = ['low', 'medium', 'high']

/** Fold Gemini effort variants into base + effort set (spec ADR-10). */
export function foldEfforts(raw: readonly RawModel[]): CatalogEntry[] {
  const bases = new Map<string, { label: string; efforts: Set<string> }>()
  const verbatim: CatalogEntry[] = []
  const slugSet = new Set(raw.map((r) => r.slug))
  for (const r of raw) {
    if (!r.slug.startsWith('gemini')) {
      verbatim.push({ id: r.slug, name: r.label, efforts: null });
      continue;
    }
    let folded = false
    for (const eff of EFFORT_SUFFIXES) {
      const suffix = '-' + eff;
      if (r.slug.endsWith(suffix)) {
        const base = r.slug.slice(0, -suffix.length)
        // Only fold when the base is a real catalog member (either listed
        // bare or via another variant); gpt-oss-120b-medium never reaches here
        // (not gemini), but a lone gemini-x-medium with no siblings stays
        // verbatim rather than inventing a base.
        const hasBare = slugSet.has(base)
        const hasSibling = raw.some(
          (x) => x.slug.startsWith(base + '-') && EFFORT_SUFFIXES.some((e) => x.slug.endsWith('-' + e)) && x.slug !== r.slug,
        );
        if (hasBare || hasSibling) {
        const entry = bases.get(base) ?? { label: stripEffortLabel(r.label, eff), efforts: new Set<string>() };
          entry.efforts.add(eff)
          bases.set(base, entry)
          folded = true;
          break;
        }
      }
    }
    if (!folded) verbatim.push({ id: r.slug, name: r.label, efforts: null });
  }
  const folded: CatalogEntry[] = []
  for (const [id, v] of bases) {
    const efforts = EFFORT_SUFFIXES.filter((e) => v.efforts.has(e));
    folded.push({ id, name: v.label !== '' ? v.label : id, efforts: efforts.length > 0 ? efforts : null });
  }
  // Folded bases first, then verbatim, both stable by original order.
  const rawOrder = new Map(raw.map((r, i) => [r.slug, i] as const))
  const rank = (e: CatalogEntry): number => {
    let best = Infinity;
    for (const r of raw) if (r.slug === e.id || r.slug.startsWith(e.id + '-')) best = Math.min(best, rawOrder.get(r.slug) ?? Infinity)
    return best;
  };
  folded.sort((a, b) => rank(a) - rank(b));
  verbatim.sort((a, b) => rank(a) - rank(b));
  // A bare base listed alongside its variants (agy 1.1.13 shape) is already
  // represented by its folded entry; emitting it verbatim too would duplicate
  // the id and DSH's llm.listModels would reject the whole provider catalog
  // (INVALID_CATALOG), dropping every Antigravity model from the picker.
  return [...folded, ...verbatim.filter((e) => !bases.has(e.id))];
}

function stripEffortLabel(label: string, eff: string): string {
  const re = new RegExp('\\s*\\(?'+ eff +'\\)?\\s*$', 'i')
  return label.replace(re, '').trim()
}

export function buildFallbackCatalog(defs: readonly FallbackModelDef[]): CatalogEntry[] {
  return defs.map((d) => ({ id: d.id, name: d.name, efforts: d.efforts ?? null }));
}

// ---------------------------------------------------------------------------
// Catalog cache with TTL + stale-while-revalidate (pi-bridge pattern).

export type DiscoverFn = (signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>

export class ModelCatalog {
  private current: Catalog;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly discover: DiscoverFn,
    fallbackDefs: readonly FallbackModelDef[],
    private readonly ttlMs: number,
  ) {
    this.current = {
      source: 'fallback',
      models: buildFallbackCatalog(fallbackDefs),
      discoveredAt: 0,
    };
  }

  get(): Catalog {
    return this.current;
  }

  /** Refresh if stale; never throws — failures keep the previous catalog. */
  async refreshIfNeeded(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const age = Date.now() - this.current.discoveredAt;
    if (this.current.source === 'discovered' && age < this.ttlMs) return;
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async forceRefresh(): Promise<Catalog> {
    await this.refresh();
    return this.current;
  }

  private async refresh(): Promise<void> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        const { stdout } = await this.discover(ac.signal);
        const raw = parseModelsOutput(stdout);
        if (raw.length > 0) {
          this.current = { source: 'discovered', models: foldEfforts(raw), discoveredAt: Date.now() };
          return;
        }
        this.current = { ...this.current, lastError: 'agy models returned no entries' };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.current = { ...this.current, lastError: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function resolveModelSlug(id: string): string {
  const s = id.trim().toLowerCase()
  if (s === 'claude-opus-4-6' || s === 'claude-opus-4-8' || s === 'claude-opus' || s === 'claude-opus-4.6' || s === 'claude-opus-4-5') {
    return 'claude-opus-4-6-thinking'
  }
  if (s === 'claude-sonnet' || s === 'claude-sonnet-4.6' || s === 'claude-sonnet-4-5') {
    return 'claude-sonnet-4-6'
  }
  if (s === 'gpt-oss-120b' || s === 'gpt-oss-20b' || s === 'gpt-oss') {
    return 'gpt-oss-120b-medium'
  }
  return id.trim()
}

export function findEntry(catalog: Catalog, id: string): CatalogEntry | undefined {
  const direct = catalog.models.find((m) => m.id === id);
  if (direct) return direct;
  const resolved = resolveModelSlug(id);
  if (resolved !== id) {
    return catalog.models.find((m) => m.id === resolved);
  }
  return undefined;
}

export function defaultEffortFor(entry: CatalogEntry, cfg: PluginConfig): string | undefined {
  if (!entry.efforts) return undefined
  if (cfg.defaultEffort !== '' && entry.efforts.includes(cfg.defaultEffort)) return cfg.defaultEffort
  // Default to the highest reasoning effort (high), then fall back down.
  for (const pref of ['high', 'medium', 'low']) {
    if (entry.efforts.includes(pref)) return pref
  }
  return entry.efforts[entry.efforts.length - 1];
}

