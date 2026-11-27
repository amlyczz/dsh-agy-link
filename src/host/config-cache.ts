// Short-TTL cache for `resolveConfig()`.
//
// `getConfig` sits on every hot path (status poll, session view, hook dispatch,
// per-event adapter checks). `resolveConfig` re-reads `runtime-overrides.json`
// (`existsSync` + `readFileSync` + `JSON.parse`) and walks ~65
// `process.env.DSH_AGY_*` lookups — on Windows each one is a
// `GetEnvironmentVariableW` call — so an uncached getter showed up in V8 CPU
// profiles of the DSH host as ~660 ms over a 22 s sample (issue #229).
//
// A 2 s TTL keeps external edits (a hand-edited overrides file, a changed env
// in a restarted shell) visible almost at once while bursts hit memory. The
// host invalidates the entry whenever IT writes the overrides file, so its own
// settings UI and `/agy config` take effect on the next read.

export const CONFIG_CACHE_TTL_MS = 2_000

export interface CachedConfigGetter<T> {
  (): T
  /** Drop the cached value; the next call re-resolves. */
  invalidate(): void
  /** Test-only: how many times the underlying resolver actually ran. */
  resolutions(): number
}

export function createCachedConfigResolver<T>(
  resolve: () => T,
  opts: { ttlMs?: number; now?: () => number } = {},
): CachedConfigGetter<T> {
  const ttlMs = opts.ttlMs ?? CONFIG_CACHE_TTL_MS
  const now = opts.now ?? (() => Date.now())
  let cached: T | undefined
  let cachedAt = Number.NEGATIVE_INFINITY
  let resolutions = 0
  const getConfig = (): T => {
    if (cached === undefined || now() - cachedAt >= ttlMs) {
      cached = resolve()
      cachedAt = now()
      resolutions += 1
    }
    return cached
  }
  return Object.assign(getConfig, {
    invalidate: (): void => {
      cached = undefined
      cachedAt = Number.NEGATIVE_INFINITY
    },
    resolutions: (): number => resolutions,
  })
}
