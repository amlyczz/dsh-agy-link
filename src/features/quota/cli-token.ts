// Is the token agy is about to load still alive enough to skip its own refresh?
//
// agy authenticates from the machine credential store at process start and
// gives that keyring read a FIXED 10s budget (printmode.go). When the stored
// access token is already expired or expires within that budget, the refresh
// runs as a separate goroutine, the budget can lose the race, and agy then
// falls back to INTERACTIVE OAuth — it opens the system browser and waits for
// a human. Observed on this machine: 9 of 375 hourly `agy -p /usage` polls
// (2.4%), every single one with <=60s of token life left, and zero of the 746
// polls that had >=1min left.
//
// So the hourly quota poll must never hand agy a token that is about to die.
// The poll runs on a one-hour cadence, which makes it pointless to be clever
// about a few seconds: refresh a comfortable margin ahead, and if the token
// cannot be brought into that window, skip the CLI for this round and let the
// REST path answer. A skipped round costs nothing (the next poll is an hour
// away and REST still reports authentic quotas); a browser window costs the
// user's attention and, if they close it, an auth state that looks broken.
//
// Pure decision helpers only — the refresh and the slot write-back live in the
// host, where the credential-slot mutex is.

/**
 * Token life a freshly spawned `agy` must still have.
 *
 * Two minutes is deliberately far from the observed failure band (<=60s) and
 * far above the refresh round-trip (1.5–5s measured), so a token that passes
 * this check cannot need a refresh during agy's startup window.
 */
export const CLI_TOKEN_SAFETY_MS = 120_000

/** Remaining life of a token, or -Infinity when the expiry is unknown. */
export function tokenRemainingMs(
  tok: { expiryMs?: number } | null | undefined,
  now = Date.now(),
): number {
  if (typeof tok?.expiryMs !== 'number') return Number.NEGATIVE_INFINITY
  return tok.expiryMs - now
}

/**
 * True when the stored credential lets a new `agy` process authenticate
 * without refreshing anything at startup.
 *
 * A missing expiry counts as NOT safe: agy would treat it as "no usable
 * token" and refresh (the very path that pops a browser). Missing is not
 * "valid forever" here either — that reading is what made issue #112 a
 * permanent 401 loop.
 */
export function isTokenSafeForCli(
  tok: { accessToken?: string; expiryMs?: number } | null | undefined,
  now = Date.now(),
): boolean {
  if (!tok?.accessToken) return false
  return tokenRemainingMs(tok, now) >= CLI_TOKEN_SAFETY_MS
}

/**
 * Everything the host must do before handing a stored credential to a new
 * `agy` process.
 *
 * The decision above only says whether the token is safe; bringing an unsafe
 * token into the safe window needs the credential slot, which lives in the
 * host (and must run under `credentialSlotMutex`). The steps are injected so
 * this module stays I/O-free and every branch is unit-testable.
 */
export interface CliTokenPrepDeps {
  /** Read the credential agy would load, WITHOUT the keychain fallback. */
  readStored(): Promise<{ accessToken?: string; expiryMs?: number } | null>
  /** Refresh the stored credential; resolves true when a usable token now exists. */
  refresh(): Promise<boolean>
  /**
   * Push the refreshed credential into the OS store agy actually reads
   * (Windows Credential Manager). Omitted on platforms where agy reads the
   * token file directly, and for isolated accounts that never own the slot.
   */
  syncSlot?(): boolean
  log?(msg: string): void
  now?(): number
}

/**
 * Make the stored credential safe for a fresh `agy` spawn, or refuse.
 *
 * Returns false when the CLI must be skipped this round (the caller then lets
 * the REST path answer). A skipped round costs one quota sample an hour; a
 * spawn with a dying token costs the user a browser window they did not ask
 * for, and an auth state that looks broken if they close it.
 */
export async function prepareCliToken(deps: CliTokenPrepDeps): Promise<boolean> {
  const now = deps.now?.() ?? Date.now()
  const before = await deps.readStored()
  if (isTokenSafeForCli(before, now)) return true

  const remaining = tokenRemainingMs(before, now)
  deps.log?.(
    '[agy-link] CLI quota read: the stored token ' +
    (Number.isFinite(remaining) ? 'has ' + Math.round(remaining / 1000) + 's left' : 'has no known expiry') +
    ' — refreshing before the spawn instead of letting agy open a browser',
  )

  const refreshed = await deps.refresh()
  if (!refreshed) {
    deps.log?.('[agy-link] CLI quota read skipped: the token could not be refreshed (REST will answer)')
    return false
  }

  // The slot write must come BEFORE the re-read: on Windows the slot is what
  // agy loads, and the refresh itself only rewrites the on-disk document.
  if (deps.syncSlot !== undefined && !deps.syncSlot()) {
    deps.log?.('[agy-link] CLI quota read skipped: the refreshed token could not be written to the credential slot')
    return false
  }

  const after = await deps.readStored()
  if (!isTokenSafeForCli(after, deps.now?.() ?? Date.now())) {
    deps.log?.('[agy-link] CLI quota read skipped: the credential agy would load is still outside the safety window')
    return false
  }
  return true
}
