// One translator, registered once, shared by every client module.
//
// The client is a set of independently installed DOM enhancers (image scanner,
// lightbox, decision chips, mermaid, compaction, toolview cards). Most of them
// render user-facing copy but none of them is a React component, so they cannot
// call `useAgyTranslation()` and several have no `ctx` at all (the lightbox is
// opened from the scanner, for instance). Rather than sprinkle a
// `translatorFor(ctx)` copy of the same fallback logic through each module, they
// all read the one binding established at plugin apply time.
//
// A module that renders before the binding exists (SSR/tests) still gets usable
// English from `translateOr()`'s explicit fallback, so nothing renders a raw key.
import { NS } from './locales.ts';

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Fill `{name}` placeholders in a template. */
export function fillTemplate(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
}

let active: Translate | null = null;

/**
 * Bind the plugin's locale service. Safe to call more than once (a plugin
 * reload replaces the binding), and tolerant of a host without `locale`.
 */
export function bindTranslator(ctx: unknown): void {
  try {
    const locale = (ctx as { locale?: { bind?: (ns: string) => Translate } } | undefined)?.locale;
    const bound = locale?.bind?.(NS);
    active = typeof bound === 'function' ? bound : null;
  } catch {
    active = null;
  }
}

/**
 * Translate a key, falling back to `fallback` (English) when no locale service is
 * bound or the key is missing. The fallback is the source of truth for copy that
 * must never render as a bare key.
 */
export function translateOr(key: string, fallback: string, params?: Record<string, unknown>): string {
  if (active !== null) {
    try {
      const value = active(key, params);
      if (typeof value === 'string' && value !== '' && value !== key) return value;
    } catch {
      // fall through to the default copy
    }
  }
  return fillTemplate(fallback, params);
}

/** Test/reset seam: drop the binding. */
export function resetTranslatorForTest(): void {
  active = null;
}
