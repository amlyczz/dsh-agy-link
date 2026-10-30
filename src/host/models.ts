// Model discovery and projection (spec ADR-10): agy models output ->
// DSH catalog entries. Gemini slugs fold into a base model plus selectable
// reasoning efforts; non-Gemini slugs (claude-*, gpt-oss-* size variants)
// stay verbatim with no effort toggle, matching observed agy behavior
// (agy rejects --effort for Claude/GPT-OSS). Discovery failure falls back to
// a bundled catalog so the /model picker is never empty.
import type { FallbackModelDef, PluginConfig } from '../common/types.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'

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

/** Check if a model identifier belongs to the Gemini 4 Argon family. */
export function isArgonModel(id: string): boolean {
  return id.trim().toLowerCase().includes('argon')
}

/**
 * Determine whether a managed account has confirmed access to the Gemini 4 Argon family.
 * Argon is exclusive to paid Pro/Ultra plans and returns a separate quota bucket
 * and/or dedicated model list from agy cli. Free/standard accounts do not have Argon.
 */
export function accountHasArgon(
  acc?: ManagedAccount | null,
  pool?: AccountPoolManager | null,
  catalog?: Catalog,
): boolean {
  if (!acc) return false

  // 1. Authoritative quota bucket explicitly exists
  if (acc.quotas?.argon !== undefined) return true

  // 2. Pool recorded dedicated Argon quota group (PR #54)
  if (pool && typeof pool.hasDedicatedGroup === 'function' && pool.hasDedicatedGroup(acc.id, 'argon')) return true

  // 3. Per-model quotas reported an argon model
  if (acc.quotas?.google?.models?.some((m) => isArgonModel(m.modelId))) return true

  // 4. Authoritative negative quota rule: if the account has polled Google quota
  // and none of the Argon indicators above matched, it is definitively a standard/free
  // account without Argon access. We must NOT fall back to catalog discovery in this case.
  if (acc.quotas?.google !== undefined) {
    return false
  }

  // 5. Account's discovered catalog contains argon (only when quota has not been polled yet)
  if (catalog && catalog.source === 'discovered') {
    return catalog.models.some((m) => isArgonModel(m.id))
  }

  return false
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
    // Skip agy banners / diagnostics case-insensitively; a lowercase
    // "error:  …" line otherwise parsed into a bogus model slug.
    if (t === '' || /^(fetching|error|failed|warning|please sign in|tip:)/i.test(t)) continue
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
    if (!r.slug || typeof r.slug !== 'string') continue
    const slug = r.slug.trim()
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, label: (typeof r.label === 'string' && r.label.trim() !== '') ? r.label.trim() : slug })
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
    if (!r.slug.startsWith('gemini') && !r.slug.startsWith('argon')) {
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
  return defs
    .filter((d) => Boolean(d && typeof d.id === 'string' && d.id.trim() !== ''))
    .map((d) => ({
      id: d.id.trim(),
      name: (typeof d.name === 'string' && d.name.trim() !== '') ? d.name.trim() : d.id.trim(),
      efforts: Array.isArray(d.efforts) && d.efforts.length > 0 ? d.efforts.filter((e) => typeof e === 'string' && e.trim() !== '') : null,
    }));
}

/**
 * Sanitized (id, name) projection of a catalog: trimmed non-empty ids with
 * first occurrence winning — exactly what listModels serves to DSH. Shared
 * with the settings UI's model-visibility list so the picker and the UI can
 * never disagree about which models exist.
 */
export function sanitizeCatalogEntries(models: readonly CatalogEntry[]): {
  entries: Array<{ id: string; name: string }>
  dropped: string[]
} {
  const seen = new Set<string>()
  const entries: Array<{ id: string; name: string }> = []
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
    entries.push({ id, name })
  }
  return { entries, dropped }
}

// ---------------------------------------------------------------------------
// Catalog cache with TTL + stale-while-revalidate (pi-bridge pattern).

export type DiscoverFn = (signal?: AbortSignal, accountId?: string) => Promise<{ stdout: string; stderr: string }>

export class ModelCatalog {
  private current: Catalog;
  private readonly accountCatalogs = new Map<string, Catalog>();
  private refreshing: Promise<void> | null = null;
  /**
   * While the catalog is still on the fallback source, re-probe at most once
   * per this interval: `agy models` costs a 30s-capped spawn, and with the
   * user signed out EVERY listModels call (picker open, resolveModel, stream)
   * used to trigger one — a spawn storm that never converged.
   */
  private static readonly FALLBACK_RETRY_MS = 60_000;
  private lastAttemptAt = 0;

  constructor(
    private readonly discover: DiscoverFn,
    fallbackDefs: readonly FallbackModelDef[],
    private readonly ttlMs: number,
    private readonly onUpdate?: () => void,
  ) {
    this.current = {
      source: 'fallback',
      models: buildFallbackCatalog(fallbackDefs),
      discoveredAt: 0,
    };
  }

  get(accountId?: string): Catalog {
    if (accountId && this.accountCatalogs.has(accountId)) {
      return this.accountCatalogs.get(accountId)!;
    }
    return this.current;
  }

  hasAccountCatalog(accountId: string): boolean {
    return this.accountCatalogs.has(accountId);
  }

  /** Refresh if stale; never throws — failures keep the previous catalog. */
  async refreshIfNeeded(accountId?: string): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const now = Date.now();
    const accountCat = accountId ? this.accountCatalogs.get(accountId) : undefined;
    if (!accountId || accountCat) {
      const targetCat = accountCat ?? this.current;
      const age = now - targetCat.discoveredAt;
      if (targetCat.source === 'discovered' && age < this.ttlMs) return;
      if (targetCat.source === 'fallback' && now - this.lastAttemptAt < ModelCatalog.FALLBACK_RETRY_MS) return;
    }
    this.lastAttemptAt = now;
    this.refreshing = this.refresh(accountId).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async forceRefresh(accountId?: string): Promise<Catalog> {
    await this.refresh(accountId);
    return this.get(accountId);
  }

  /**
   * Refresh one account's catalog, then ALWAYS announce a picker update.
   *
   * `refresh()` only fires onUpdate when the catalog *contents* changed. But
   * switching the active account changes the picker's visible set even when
   * the catalog itself is identical — `listModels()` filters the Argon family
   * by the active account's plan, and it resolves `catalog.get(accountId)`,
   * which must be populated for the newly active account before the picker
   * re-reads. So an account switch must (a) discover that account's catalog and
   * (b) emit the update unconditionally, or the composer's cached model
   * snapshot keeps showing the previous account's models (e.g. no Argon after
   * switching to a Pro/Ultra account).
   */
  async forceRefreshAndNotify(accountId?: string): Promise<Catalog> {
    await this.refresh(accountId, false);
    this.onUpdate?.();
    return this.get(accountId);
  }

  private async refresh(accountId?: string, announce = true): Promise<void> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        const { stdout } = await this.discover(ac.signal, accountId);
        const raw = parseModelsOutput(stdout);
        if (raw.length > 0) {
          const newModels = foldEfforts(raw);
          const newCatalog: Catalog = { source: 'discovered', models: newModels, discoveredAt: Date.now() };
          const prev = this.get(accountId);
          const changed =
            prev.source !== 'discovered' ||
            prev.models.length !== newModels.length ||
            prev.models.some((m, i) => m.id !== newModels[i]?.id);
          if (accountId) {
            this.accountCatalogs.set(accountId, newCatalog);
          } else {
            this.current = newCatalog;
          }
          if (changed && announce) {
            this.onUpdate?.();
          }
          return;
        }
        if (accountId) {
          const cat = this.accountCatalogs.get(accountId);
          if (cat) cat.lastError = 'agy models returned no entries';
        } else {
          this.current = { ...this.current, lastError: 'agy models returned no entries' };
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (accountId) {
        const cat = this.accountCatalogs.get(accountId);
        if (cat) cat.lastError = errMsg;
      } else {
        this.current = { ...this.current, lastError: errMsg };
      }
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
  if (!entry.efforts || entry.efforts.length === 0) return undefined
  if (cfg.defaultEffort !== '' && entry.efforts.includes(cfg.defaultEffort)) return cfg.defaultEffort
  // Default to the highest reasoning effort (high), then fall back down.
  for (const pref of ['high', 'medium', 'low']) {
    if (entry.efforts.includes(pref)) return pref
  }
  return entry.efforts[entry.efforts.length - 1];
}

