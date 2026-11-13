// The reasoning-effort vocabulary — the ONE definition of "what thinking
// levels exist" in this plugin.
//
// Before this module the same list was written out four times
// (`host/models.ts` EFFORT_SUFFIXES, `client/config-options.ts`
// EFFORT_LEVELS, `client/sections/SettingsSection.ts`'s four hardcoded
// buttons, `host/ask-tool.ts`'s prose). They drifted: agy 1.5.7 added
// `xhigh`, the picker kept folding only low/medium/high, and
// `gemini-4-hydrogen-xhigh` leaked into DSH's model list as a bogus extra
// MODEL instead of being an effort on `gemini-4-hydrogen`.
//
// `agy --help` (1.5.7) is the authority:
//
//   --effort  Reasoning effort for the current CLI session
//             (low|medium|high|xhigh|max)
//
// agy's own picker renders the same ids as Low / Medium / High / Extra, so
// the display names here follow the picker, not the slug spelling.

/** Every effort id agy accepts, in ascending intensity order. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * Display names, matching agy's own model picker ("Extra" is `xhigh`, which is
 * how the GUI labels it while `agy --help` spells it `xhigh`).
 */
export const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
}

/** Display name for an effort id; unknown ids are shown verbatim. */
export function effortLabel(id: string): string {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : ''
  return EFFORT_LABELS[key] ?? (typeof id === 'string' ? id.trim() : '')
}

/** True when `value` is an effort id this plugin (and agy) understands. */
export function isEffortId(value: string): boolean {
  return (REASONING_EFFORTS as readonly string[]).includes(
    typeof value === 'string' ? value.trim().toLowerCase() : '',
  )
}

/**
 * Effort suffixes ordered so a LONGER suffix always wins: `gemini-4-hydrogen-xhigh`
 * must fold as `gemini-4-hydrogen` + `xhigh`, never as `gemini-4-hydrogen-x` + `high`.
 */
export const EFFORT_SUFFIXES: readonly string[] = [...REASONING_EFFORTS].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
)

/**
 * Split a discovered agy slug into (base, effort).
 *
 * Returns `effort: undefined` when the slug carries no effort suffix. The
 * caller still decides whether the base is real — a lone `gemini-x-medium`
 * with no siblings must stay verbatim rather than inventing a base.
 */
export function splitEffortSuffix(slug: string): { base: string; effort?: string } {
  const id = typeof slug === 'string' ? slug.trim() : ''
  for (const effort of EFFORT_SUFFIXES) {
    const suffix = '-' + effort
    if (id.length > suffix.length && id.endsWith(suffix)) {
      return { base: id.slice(0, -suffix.length), effort }
    }
  }
  return { base: id }
}

/**
 * Canonical ordering + de-duplication of an effort set.
 *
 * Order is always `REASONING_EFFORTS`, so the picker and the settings
 * dropdowns can never disagree about the order of Low/Medium/High/Extra.
 *
 * Ids this build does not know yet (a newer agy level, or a hand-written
 * `fallbackModels` entry) are kept AFTER the known ones in first-seen order —
 * dropping them would silently delete a user's configuration.
 */
export function normalizeEfforts(list: Iterable<string> | undefined | null): string[] {
  if (list === undefined || list === null) return []
  const present = new Set<string>()
  const order: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const id = raw.trim().toLowerCase()
    if (id === '' || present.has(id)) continue
    present.add(id)
    order.push(id)
  }
  const known = REASONING_EFFORTS.filter((e) => present.has(e))
  const unknown = order.filter((e) => !(REASONING_EFFORTS as readonly string[]).includes(e))
  return [...known, ...unknown]
}
