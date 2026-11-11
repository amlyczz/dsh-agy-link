// Effort capability policy for agy models (issue #67).
//
// agy refuses the WHOLE invocation when `--effort` is passed to a model that
// does not accept one, and that refusal arrives before any output. Effort
// support is a MODEL property, but our catalog only knows it as advisory (the
// fallback list is a guess and agy builds differ). The refusal names the exact
// model, which is what makes learning it possible: we remember refusals in
// memory and ask the host to persist them so the picker row disappears.
//
// Moved out of src/host/adapter.ts unchanged; the adapter keeps its public
// effort methods as one-line delegates.

/** Same-model comparison that ignores a provider prefix and case. */
export function sameModelId(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/^.*\//, '')
  return norm(a) === norm(b) && norm(a) !== ''
}

/**
 * agy refuses the WHOLE invocation when `--effort` is passed to a model that
 * does not accept one (issue #67, agy 1.4.6 / Windows):
 *
 *   invalid model selection (--model "gemini-3.8-flash" --effort "medium"):
 *   --effort is not supported for model "gemini-3.8-flash"
 *
 * @param text - stdout envelope error, stderr tail, or a mapped failure message.
 * @returns the refused model id, or null when this is not an effort refusal.
 */
export function parseEffortUnsupported(text: string): string | null {
  if (text === '' || !/--effort/i.test(text)) return null
  const named = text.match(/--effort(?:\s+"?[A-Za-z0-9._-]+"?)?\s+is not supported for model\s+"?([A-Za-z0-9._:\/-]+)"?/i)
  if (named !== null && named[1] !== undefined && named[1] !== '') return named[1]
  if (/invalid model selection/i.test(text) && /--effort[^\n:]*(?:is not supported|not supported|unsupported)/i.test(text)) {
    const model = text.match(/--model\s+"?([A-Za-z0-9._:\/-]+)"?/i)
    if (model !== null && model[1] !== undefined && model[1] !== '') return model[1]
  }
  return null
}

/**
 * In-memory effort-refusal cache, seeded once from the host's persisted list
 * and grown by each learned refusal.
 */
export class EffortPolicy {
  private cache: Set<string> | null = null

  constructor(
    private readonly seed: () => readonly string[] | undefined,
    private readonly log?: (msg: string) => void,
    private readonly onLearned?: (model: string) => void,
  ) {}

  /** Models currently known to reject `--effort` (persisted seed + learned). */
  unsupportedModels(): string[] {
    return [...this.models()]
  }

  /** True when `--effort` must not be passed to this model. */
  isUnsupported(model: string): boolean {
    if (model === '') return false
    for (const known of this.models()) {
      if (sameModelId(known, model)) return true
    }
    return false
  }

  /** Learn a refusal: remember it, tell the host to persist + refresh the picker. */
  learn(model: string): void {
    if (model === '') return
    const set = this.models()
    if (this.isUnsupported(model)) return
    set.add(model)
    this.log?.(
      'agy refused --effort for model "' + model + '" — it is now run without an effort flag'
        + ' (effort support is advisory in the catalog; see issue #67)',
    )
    try {
      this.onLearned?.(model)
    } catch {
      // Persistence is best-effort: the in-process learning already unblocks it.
    }
  }

  private models(): Set<string> {
    if (this.cache === null) {
      const seeded = this.seed() ?? []
      this.cache = new Set((Array.isArray(seeded) ? seeded : []).filter((m) => typeof m === 'string' && m.trim() !== ''))
    }
    return this.cache
  }
}