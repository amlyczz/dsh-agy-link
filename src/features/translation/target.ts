// Model/effort resolution for translations (advisory catalog + fallback chain).
import type { PluginConfig } from '../../common/types.ts'
import { defaultEffortFor, findEntry, resolveModelSlug, type Catalog } from '../../host/models.ts'
import { PREFERRED_GEMINI_FLASH } from '../../common/model-lineup.ts'
import type { TranslateTarget } from './types.ts'

/**
 * Pick the model/effort for a translation.
 *
 * An explicit request (command flag) is honoured even when the advisory catalog
 * has never listed it — the adapter accepts unknown ids. The DEFAULT goes
 * through a fallback chain so a plan without Gemini 3.8 still translates:
 * `PREFERRED_GEMINI_FLASH` → newest `gemini-*-flash` → `defaultModel` → first model.
 */
export function resolveTranslateTarget(
  cfg: PluginConfig,
  catalog: Catalog,
  override?: { model?: string; effort?: string },
): TranslateTarget {
  const requested = (override?.model ?? cfg.translateModel ?? '').trim()
  const models = catalog.models
  let model = ''
  let entry = requested === '' ? undefined : findEntry(catalog, requested)

  if (requested !== '' && entry !== undefined) {
    model = entry.id
  } else if (requested !== '' && override?.model !== undefined) {
    // Explicit per-call override wins even when unlisted (advisory catalog).
    model = resolveModelSlug(requested)
    entry = findEntry(catalog, model)
  } else {
    const candidates: string[] = [PREFERRED_GEMINI_FLASH]
    if (cfg.defaultModel !== '') candidates.push(cfg.defaultModel)
    for (const cand of candidates) {
      const found = findEntry(catalog, cand)
      if (found !== undefined) {
        model = found.id
        entry = found
        break
      }
    }
    if (model === '') {
      const flashes = models
        .filter((m) => /gemini/i.test(m.id) && /flash/i.test(m.id))
        .sort((a, b) => compareNatural(b.id, a.id))
      const newest = flashes[0] ?? models[0]
      if (newest !== undefined) {
        model = newest.id
        entry = newest
      }
    }
  }

  const wanted = (override?.effort ?? cfg.translateEffort ?? '').trim()
  let effort = ''
  if (entry !== undefined && Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    effort =
      wanted !== '' && entry.efforts.includes(wanted)
        ? wanted
        : defaultEffortFor({ ...entry, efforts: entry.efforts }, cfg) ?? ''
  }
  return { model, effort }
}

function compareNatural(a: string, b: string): number {
  const na = a.split(/(\d+)/)
  const nb = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? ''
    const y = nb[i] ?? ''
    const xn = Number(x)
    const yn = Number(y)
    if (Number.isFinite(xn) && Number.isFinite(yn) && x !== '' && y !== '') {
      if (xn !== yn) return xn - yn
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
