// Failure classification: AUTH vs NETWORK vs server capacity, and the retry
// schedule / egress facts the adapter needs to decide whether rotating the
// account is meaningful.

/**
 * Authoritative OAuth/token states that genuinely prove a login is dead.
 * A bare 400 (captive portal, proxy error page) or a body without an OAuth
 * error code must NOT flag an account — that used to produce "needs
 * re-login" false positives which a manual quota refresh immediately
 * disproved.
 */
export function isAuthoritativeAuthError(message: string): boolean {
  return /invalid_grant|invalid_client|revoked|disabled|unauthorized_client/i.test(message)
}

/**
 * Transient transport failures — never proof that a login is dead.
 *
 * Deliberately broader than the classic dial/DNS set: agy reports "not signed
 * in" whenever it cannot VALIDATE the stored token, so a flaky proxy produces
 * `Post https://oauth2.googleapis.com/token: EOF`, `TLS handshake timeout` or
 * `token validation failed due to network error (token may still be valid)`
 * next to an auth-shaped banner. Treating that as a sign-out ends the turn on
 * a HEALTHY account and DSH renders the AUTH code as "API key is invalid"
 * (observed live: 2026-10-10 14:17, session-c65a826e turn 22).
 */
export function looksLikeNetworkError(message: string): boolean {
  return /dial tcp|fetch failed|econn(?:refused|reset|aborted)|enotfound|ehostunreach|enetunreach|socket hang up|getaddrinfo|bad gateway|service unavailable|unexpected eof|\beof\b|tls handshake timeout|i\/o timeout|network (?:error|is unreachable)|no route to host|connection reset|context deadline exceeded|temporary failure in name resolution|proxyconnect|token validation failed|validate (?:the )?token|silent auth failed/i.test(
    message,
  )
}

/**
 * Decide AUTH vs NETWORK for one failed agy run.
 *
 * Both the wide transport regex and the narrow keyring-jitter regex must see
 * the SAME evidence. The run log used to reach only the narrow one, so a proxy
 * blip that agy 1.4.12 logs as "keyringAuth: token validation failed due to
 * network error" was classified AUTH and quarantined a healthy account
 * (issue #71). Exported so the decision stays a pure, testable seam.
 */
export function isTransportFailure(input: {
  rawErrText: string
  authFailureText?: string
  stderrTail?: string
  stdoutHead?: string
  runLogText?: string
}): boolean {
  const runLogText = input.runLogText ?? ''
  if (looksLikeAuthVerificationJitter(runLogText)) return true
  const text = [
    input.rawErrText,
    input.authFailureText ?? '',
    input.stderrTail ?? '',
    (input.stdoutHead ?? '').slice(0, 4000),
    runLogText,
  ]
    .filter(Boolean)
    .join(' ')
  return looksLikeNetworkError(text)
}

/**
 * Backoff schedule for CONSECUTIVE transport (NETWORK) failures.
 *
 * DSH's generic backoff starts at 2s and doubles, which spends the whole retry
 * budget inside a few seconds. A real egress outage does not look like that:
 * on 2026-10-21 the machine's proxy answered CONNECT 200 and then killed TLS
 * for ~14 minutes, so every agy run failed its startup eligibility probe with
 * `Post "…/loadCodeAssist": EOF` and the turn died after two retries in 4s
 * while agy itself kept working whenever a gap appeared.
 *
 * These delays are stated per failure as `providerRetryAfterMs`, which the
 * retry plugin honours verbatim — but only up to the policy's maxDelayMs (a
 * longer request makes it drop the retry entirely), so the cap must stay above
 * the last entry. The schedule is capped, never unbounded: a dead egress still
 * ends the turn, just after minutes instead of seconds.
 */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000]

/** Delay to request after `consecutiveFailures` transport failures in a row. */
export function networkRetryDelayMs(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(Math.trunc(consecutiveFailures) - 1, 0),
    NETWORK_RETRY_DELAYS_MS.length - 1,
  )
  return NETWORK_RETRY_DELAYS_MS[index]!
}

/** The only account facts that decide whether a transport failure is account-scoped. */
export interface EgressAccount {
  /** Per-account proxy override; empty/undefined means the global/system proxy. */
  proxyUrl?: string
  enabled?: boolean
}

/**
 * Whether every ENABLED account leaves through the same proxy.
 *
 * When it does, a transport failure is a property of the machine's egress, not
 * of the account: rotating the pool repoints the session for nothing and burns
 * the rotation budget that a real quota/eligibility hop needs. Accounts with
 * their own `proxyUrl` (or one with an override next to the default) can fail
 * independently, so rotation stays meaningful there.
 *
 * `globalProxy` is the proxy an account without an override uses (config
 * `proxyUrl`, else the detected system proxy). It matters because a newly
 * created pool account is seeded with a COPY of the system proxy while the
 * primary/system account keeps an empty override — comparing raw overrides
 * would call that "two different egresses" and rotate on every blip.
 *
 * Disabled accounts are ignored: they are never selected, so their proxy cannot
 * make the reachable egress distinct.
 */
export function accountsShareSingleEgress(
  accounts: readonly EgressAccount[],
  globalProxy?: string,
): boolean {
  const fallback = (globalProxy ?? '').trim()
  const urls = new Set<string>()
  for (const account of accounts) {
    if (account.enabled === false) continue
    urls.add((account.proxyUrl ?? '').trim() || fallback)
    if (urls.size > 1) return false
  }
  return true
}

/**
 * Evidence from agy's OWN per-run log that a stored credential was present but
 * could not be VALIDATED over the network — i.e. jitter wearing an auth costume.
 *
 * The stderr banner agy prints when silent auth fails is byte-identical for a
 * genuine sign-out and for a keyring validation that missed its hard 10s
 * window, so the banner cannot decide AUTH vs NETWORK. The log can:
 *
 *   real sign-out   printmode.go:403 not authenticated, trying silent auth
 *                   printmode.go:409 silent auth failed        ← 29 ms later,
 *                   (NO keyringAuth: line — nothing to validate)  no keyring line
 *   network blip    printmode.go:403 not authenticated, trying silent auth
 *                   keyring.go:64   keyringAuth: loaded token … expired=false
 *                   keyring.go:111  keyringAuth: timed out after 10s
 *                   printmode.go:409 silent auth failed
 *                   keyring.go:93   keyringAuth: failed to fetch user info:
 *                                   userinfo request failed: … i/o timeout
 *
 * `keyringAuth:` lines only exist when agy actually HAD a credential to
 * validate, and the timeout / userinfo markers are transport failures inside
 * that validation. Verified against real logs (2026-10-16): the sign-out log
 * contains 0 occurrences of every marker below, the blip log contains all of
 * them.
 */
export function looksLikeAuthVerificationJitter(agyLogText: string): boolean {
  if (agyLogText === '') return false
  // An authoritative OAuth token error (revoked / invalid_grant …) is proof of
  // a dead login no matter what else the run logged — never downgrade it.
  if (isAuthoritativeAuthError(agyLogText)) return false
  return /keyringAuth: timed out after|failed to fetch user info|userinfo request failed/i.test(agyLogText)
}

/**
 * Decide whether a failed call may flag an account as "needs re-login".
 * Genuine AUTH classification wins (unless the failure was transport-shaped),
 * and the message must name an authoritative token state otherwise.
 */
export function shouldMarkAuthRequired(code: string | undefined, message: string): boolean {
  if (looksLikeNetworkError(message)) return false
  if (code === 'AUTH') return true
  return isAuthoritativeAuthError(message)
}
