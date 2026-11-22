// Point every location the plugin derives from the environment at a throwaway
// directory: HOME and USERPROFILE (what `os.homedir()` reads on POSIX and
// Windows), DSH_HOME (state, overrides) and DSH_STATE_DIR (the account pool).
// A test that builds the real host services (`createHostServices`, `apply`)
// without this reads and rewrites the developer's own
// ~/.dsh/agy-accounts/pool.json and resolves the primary from the real home.
const KEYS = ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_STATE_DIR'] as const

/** Sandbox the environment into `dir`; returns the restore function. */
export function sandboxEnv(dir: string): () => void {
  const prev = KEYS.map((k) => process.env[k])
  for (const k of KEYS) process.env[k] = dir
  return () => {
    KEYS.forEach((k, i) => {
      const v = prev[i]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    })
  }
}
