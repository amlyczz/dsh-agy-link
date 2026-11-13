// The model lineup — the ONE place that names concrete agy models.
//
// Two things live here and nowhere else:
//
//   1. `DEFAULT_FALLBACK_MODELS`: the offline/signed-out picker lineup. It is
//      a MIRROR of what `agy models` prints, never a wish list. It must be
//      refreshed when agy ships a new family, and it must not keep models agy
//      has retired — a stale entry here is exactly how DSH ends up offering
//      models the agy picker does not have (the reported inconsistency:
//      `gemini-4-carbon` and the Claude 4.6 line are gone from agy 1.5.7).
//
//   2. `PREFERRED_*`: the ids the plugin itself reaches for when the user has
//      expressed no preference (translation, image generation, warmup,
//      per-family account routing, `agy_ask` fallbacks). Each was previously
//      a string literal repeated across features, which drifted every time a
//      model was retired.
//
// Ground truth (verified against `agy models` / `agy --help`, agy 1.5.7):
//
//   gemini-4-argon-low|-medium|-high          Gemini 4 Argon
//   gemini-4-hydrogen-low|-medium|-high|-xhigh Gemini 4 Hydrogen
//   gemini-pro-orchestrator-g1-pro            Orchestrator (Argon)
//   gemini-3.8-flash-low|-medium|-high        Gemini 3.8 Flash
//   claude-opus-5-5-low|-medium|-high         Claude Opus 5.5
//   claude-sonnet-5-5-low|-medium|-high       Claude Sonnet 5.5
//   gpt-oss-120b-medium                       GPT-OSS 120B (Medium)
//
// Nothing else. Gemini 4 Carbon is `Unavailable` in agy's own picker and does
// not appear in `agy models`; the Claude 4.6 line is retired upstream.

/**
 * One entry of the offline lineup: a concrete agy model id, the label DSH's
 * picker shows, and the efforts that model accepts (omitted = fixed-thinking).
 */
export interface FallbackModelDef {
  id: string
  name: string
  /** Selectable reasoning efforts; omit for fixed-thinking models. */
  efforts?: readonly string[]
}

/** Gemini Flash — the cheap, always-available workhorse. */
export const PREFERRED_GEMINI_FLASH = 'gemini-3.8-flash'

/** Gemini Pro tier / Argon (Pro & Ultra plans only). */
export const PREFERRED_GEMINI_ARGON = 'gemini-4-argon'

/** Anthropic tier (Sonnet — the default Anthropic pick). */
export const PREFERRED_CLAUDE = 'claude-sonnet-5-5'

/** Anthropic top tier; reached through the bare `claude-opus` alias. */
export const PREFERRED_CLAUDE_OPUS = 'claude-opus-5-5'

/** OpenAI tier. */
export const PREFERRED_OPENAI = 'gpt-oss-120b-medium'

/**
 * Offline/signed-out lineup. Mirrors `agy models` (agy 1.5.7) exactly —
 * same ids, same effort sets, same order.
 */
export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

/** Models the plugin treats as the Gemini family for UI filtering. */
export function isGeminiFamilyModel(id: string): boolean {
  return /gemini/i.test(typeof id === 'string' ? id : '')
}
