// Text sniffing shared by the runner tail, parser output and the result
// envelope: auth banners, eligibility refusals, rate-limit / capacity signals
// and reset-duration parsing.

// Auth-failure sniffing shared by the runner tail, parser output and the
// result envelope (observed on agy 1.1.13: an authentication-required
// banner plus result.error text).
export function looksLikeAuthFailure(text: string): boolean {
  return /authentication required|authentication failed|please sign in|not signed in|timed out waiting for authentication/i.test(
    text,
  )
}

/**
 * Google-side account/region eligibility refusals (issue #32). agy exits 1
 * with "Eligibility check failed: … not currently available in your
 * location" — not an auth bug and not something the bridge can retry past.
 */
export function looksLikeEligibilityFailure(text: string): boolean {
  return /eligibility check failed|not eligible for antigravity|not currently available in your (?:location|country|region)|not available in your (?:location|country|region)|user location is not supported|location is not supported for the api|not supported in your (?:location|country|region)/i.test(
    text,
  )
}

/** One-line guidance for an eligibility refusal (shown in the turn error). */
export const ELIGIBILITY_ERROR_HINT =
  'Google Antigravity is not eligible for this account/region. Use an account and network location where Antigravity is available (see https://antigravity.google).'

// Google OAuth consent URL pattern; trailing punctuation is trimmed.
export function extractAuthUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/accounts\.google\.com\/\S+/)
  if (!m) return undefined
  return m[0].replace(/[)\]>.,;\x27\x22]+$/, '')
}

/**
 * HARD, server-issued rate-limit signatures — the ONLY patterns allowed to
 * put an account into cooldown. Deliberately narrow: bare `429` or
 * `rate limit` matched incidental substrings in the wild (hash/UUID
 * fragments, model prose mentioning quotas, unrelated tool/permission
 * errors quoting such words) and produced ghost cooldowns that froze
 * healthy accounts out of rotation.
 */
export function looksLikeHardRateLimit(text?: string): boolean {
  if (!text) return false
  return /RESOURCE_EXHAUSTED|code[ :]?429\b|status[ :]?429\b|HTTP[ :]?429\b|too many requests|individual quota reached|quota (?:exceeded|reached|exhausted|limit)|rate[ -]?limit(?:ed)? (?:exceeded|reached|hit)?|exceeded (?:your |the )?quota|has been exhausted|exhausted your (?:quota|capacity)|out of quota|check quota|insufficient quota|usage limit reached/i.test(
    text,
  )
}

/**
 * Failures that belong to the ACCOUNT (spent quota, refused region, broken
 * transport, capacity refusal, signed-out login) rather than to the request.
 * The retry policy retries these and the adapter rotates the sticky pointer,
 * so the retry is served by a different account instead of interrupting the
 * user's turn. Deterministic request-level failures (AGY_ERROR, a bare
 * PROCESS_EXIT from a crash) are deliberately excluded: re-running those
 * merely repeats the same work on another account.
 */
export function isAccountScopedFailure(code: string | undefined): boolean {
  return code === 'RATE_LIMIT' || code === 'ELIGIBILITY' || code === 'NETWORK' || code === 'OVERLOADED' || code === 'AUTH'
}

/**
 * Capacity exhaustion / server-side pressure signals (model overloaded / 503 / 529 / high traffic).
 * Distinct from account-level quota exhaustion (429): Google's backend capacity is shared across
 * accounts, so rotating accounts on a server capacity refusal burns every healthy account's turn
 * for nothing. The scheduler should STAY on the current account with backoff retry rather than rotating.
 */
export function looksLikeCapacityExhaustion(text?: string): boolean {
  if (!text) return false
  return /model (?:is )?overloaded|experiencing high traffic|is overloaded|capacity (?:exhausted|unavailable)|temporarily (?:overloaded|unavailable)|server (?:is )?busy|overloaded and unable to|503\s+Service\s+Unavailable|529\s+Overloaded/i.test(text)
}

/**
 * Soft heuristic adds capacity signals (model overloaded / high traffic).
 * Shapes the user-facing error message only — NEVER cools an account down.
 */
export function looksLikeRateLimit(text?: string): boolean {
  if (!text) return false
  return looksLikeHardRateLimit(text) || looksLikeCapacityExhaustion(text)
}

/**
 * Parse reset duration in milliseconds from rate-limit / quota-exhausted error strings.
 * Supports compact formats ("Resets in 21m25s", "Resets in 2h26m6s", "Resets in 45s"),
 * verbose formats ("Resets in 15 minutes", "retry after 30 seconds"), and ISO timestamps.
 */
export function parseResetDurationMs(text?: string): number | undefined {
  if (!text) return undefined

  // 1. Compact: "Resets in 2h26m6s", "resets in 21m25s", "resets in 45s"
  const compactMatch = text.match(/resets?\s+in\s+((?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?)/i)
  if (compactMatch && compactMatch[1]?.trim()) {
    const hours = parseInt(compactMatch[2] || '0', 10)
    const minutes = parseInt(compactMatch[3] || '0', 10)
    const seconds = parseInt(compactMatch[4] || '0', 10)
    const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000
    if (totalMs > 0) return totalMs
  }

  // 2. Word-based: "Resets in 15 minutes", "resets in 2 hours", "retry after 30 seconds"
  const wordMatch = text.match(/(?:resets?|retry)\s+(?:in|after)\s+(\d+)\s*(hour|hr|minute|min|second|sec)s?/i)
  if (wordMatch) {
    const num = parseInt(wordMatch[1]!, 10)
    const unit = wordMatch[2]!.toLowerCase()
    if (unit.startsWith('h')) return num * 3600 * 1000
    if (unit.startsWith('m')) return num * 60 * 1000
    if (unit.startsWith('s')) return num * 1000
  }

  // 3. ISO timestamp or future date string
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0])
    if (!Number.isNaN(parsed) && parsed > Date.now()) {
      return parsed - Date.now()
    }
  }

  return undefined
}
