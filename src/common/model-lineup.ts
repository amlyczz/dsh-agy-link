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
// Ground truth (verified against `agy models`, agy 1.5.18, 2026-11-26; the
// ACP `models.availableModels` payload lists the same 33 ids):
//
//   gemini-4-carbon-low|-medium|-high          Gemini 4 Carbon (Pro/Ultra)
//   gemini-4-neon-low|-medium|-high|-xhigh     Gemini 4 Neon
//   gemini-4-hydrogen-low|-medium|-high        Gemini 4 Hydrogen (all plans; `xhigh` retired in 1.5.18)
//   gemini-4-argon-low|-medium|-high           Gemini 4 Argon
//   gemini-3.8-flash-low|-medium|-high         Gemini 3.8 Flash
//   gemini-3.7-flash-low|-medium|-high         Gemini 3.7 Flash (back on 1.5.18)
//   gemini-3.6-flash-low|-medium|-high         Gemini 3.6 Flash (back on 1.5.18)
//   gemini-3.1-pro-low|-high                   Gemini 3.1 Pro (back on 1.5.18)
//   claude-opus-5-5-low|-medium|-high|-max     Claude Opus 5.5 (`max` new in 1.5.18)
//   claude-sonnet-5-5-low|-medium|-high|-max   Claude Sonnet 5.5 (`max` new in 1.5.18)
//   gemini-pro-orchestrator                    Orchestrator
//
// Retired between 1.5.17 and 1.5.18: `gemini-pro-orchestrator-neon`,
// `gemini-pro-orchestrator-argon` and `gpt-oss-120b-medium`. `PREFERRED_OPENAI`
// still names the GPT-OSS id on purpose: it is what the plugin reaches for WHEN
// a catalog offers that family, and it is validated against the live catalog
// first, so it does not depend on being in this mirror.
//
// The Claude 4.6 line is retired upstream.
//
// The `gemini-pro-orchestrator*` entries are ROLE models: picking one makes
// the session run on Antigravity's orchestrator. Since agy 1.5.14, `--settings`
// (`orchestrator.planner` / `orchestrator.executor` with `<model>-<effort>`
// slugs) controls the planner and executor model + thinking effort (issue #174).

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

/** Gemini 4 Hydrogen — fast, balanced Gemini 4 workhorse (Pro & Ultra plans). */
export const PREFERRED_GEMINI_HYDROGEN = 'gemini-4-hydrogen'

/** Gemini Pro tier / Argon (Pro & Ultra plans only). */
export const PREFERRED_GEMINI_ARGON = 'gemini-4-argon'

/**
 * The image model whose OWN quota bucket `generate_image` consumes.
 *
 * It is NOT the model that drives the image turn (`imageModel` config = a chat
 * model). Google meters image generation against a separate per-model bucket
 * inside the same `google` family — the quota snapshot exposes it as
 * `quotas.google.models[].modelId = gemini-3.1-flash-image`. Scheduling must
 * therefore check that bucket explicitly, and must never cool the family for it.
 */
export const PREFERRED_IMAGE_QUOTA_MODEL = 'gemini-3.1-flash-image'

/** Anthropic tier (Sonnet — the default Anthropic pick). */
export const PREFERRED_CLAUDE = 'claude-sonnet-5-5'

/** Anthropic top tier; reached through the bare `claude-opus` alias. */
export const PREFERRED_CLAUDE_OPUS = 'claude-opus-5-5'

/** OpenAI tier. */
export const PREFERRED_OPENAI = 'gpt-oss-120b-medium'

/**
 * Offline/signed-out lineup. Mirrors `agy models` (agy 1.5.15) —
 * same ids, same effort sets, same order.
 */
export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'gemini-pro-orchestrator', name: 'Orchestrator' },
]

/** Models the plugin treats as the Gemini family for UI filtering. */
export function isGeminiFamilyModel(id: string): boolean {
  return /gemini/i.test(typeof id === 'string' ? id : '')
}
