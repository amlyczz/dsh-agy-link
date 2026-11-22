// Text sniffing shared by the runner tail, parser output and the result
// envelope: auth banners, eligibility refusals, rate-limit / capacity signals
// and reset-duration parsing.

// Auth-failure sniffing shared by the runner tail, parser output and the
// result envelope (observed on agy 1.1.13: an authentication-required
// banner plus result.error text). Lines attributed to third-party MCP
// servers are stripped first so a misconfigured MCP plugin never flags the
// user's Google account as signed out.
export function looksLikeAuthFailure(text: string): boolean {
  if (!text) return false
  const nonMcpLines = text
    .split(/\r?\n/)
    .filter((line) => !/\bmcp\b.*(?:authentication (?:required|failed)|not signed in|please sign in)/i.test(line))
    .join('\n')
  return /authentication required|authentication failed|please sign in|not signed in|timed out waiting for authentication/i.test(
    nonMcpLines,
  )
}

/** Terminal Google account suspension (TOS_VIOLATION). Must NEVER auto-rotate across sibling accounts. */
export function looksLikeTosViolation(text?: string): boolean {
  if (!text) return false
  return /\bTOS_VIOLATION\b|violation of Terms of Service|This service has been disabled in this account/i.test(text)
}

/** Temporary Google account challenge (VALIDATION_REQUIRED) — recoverable via verification URL. */
export function looksLikeValidationRequired(text?: string): boolean {
  if (!text) return false
  return /\bVALIDATION_REQUIRED\b|Verify your account to continue/i.test(text)
}

/**
 * Headless print-mode permission refusal (issue #121): agy refuses interactive
 * tool approval prompts when running under `-p` without `--dangerously-skip-permissions`.
 */
export function looksLikeHeadlessPermissionDenial(text?: string): boolean {
  if (!text) return false
  return /(?:approval|confirmation|review)\s+required\s+in\s+(?:non-interactive|print|headless)|cannot\s+(?:prompt|request)\s+(?:for\s+)?(?:permission|approval|review)\s+in\s+(?:print|non-interactive)|tool\s+execution\s+denied:\s*approval\s+required|headless mode cannot prompt for|a tool required [^\n]*permission that headless mode cannot prompt for|no output produced [—-]+ a tool required/i.test(
    text,
  )
}

export const HEADLESS_PERMISSION_ERROR_HINT =
  'Antigravity refused an interactive permission prompt in headless print mode. Set permissionMode to "skip" (or run `/agy mode skip`) so unattended tool runs can proceed.'

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
  return /RESOURCE_EXHAUSTED|\bQUOTA_EXHAUSTED\b|"?code"?\s*[:=]\s*429\b|"?status"?\s*[:=]\s*429\b|HTTP(?:\/[\d.]+)?[ :]?429\b|too many requests|individual quota reached|quota (?:exceeded|reached|exhausted|limit)|rate[ -]?limit(?:ed)? (?:exceeded|reached|hit)?|exceeded (?:your |the )?quota|has been exhausted|exhausted your (?:quota|capacity)|out of quota|check quota|insufficient quota|usage limit reached/i.test(
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
 * Supports compact formats ("Resets in 21m25s", "reset after 4h58m46s",
 * `"quotaResetDelay": "4h58m46.438s"`), verbose formats ("Resets in 15 minutes",
 * "retry after 30 seconds"), and ISO timestamps.
 */
export function parseResetDurationMs(text?: string): number | undefined {
  if (!text) return undefined

  // 1. Compact: "Resets in 2h26m6s", "reset after 4h58m46s", "quotaResetDelay": "4h58m46.438s"
  const compactMatch = text.match(
    /(?:resets?\s+(?:in|after)|"(?:quotaResetDelay|retryDelay)"\s*:\s*")\s*((?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?)/i,
  )
  if (compactMatch && (compactMatch[2] || compactMatch[3] || compactMatch[4])) {
    const hours = parseInt(compactMatch[2] || '0', 10)
    const minutes = parseInt(compactMatch[3] || '0', 10)
    const seconds = parseFloat(compactMatch[4] || '0')
    const totalMs = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000)
    if (Number.isFinite(totalMs) && totalMs > 0) return totalMs
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

const TRANSIENT_BURST_CAP_MS = 30_000

/**
 * True when a 429 error represents a short transient per-minute/per-second QPS burst
 * (`reason: RATE_LIMIT_EXCEEDED` with reset <= 30s) rather than window quota exhaustion.
 * Must NOT trigger long account cooldown or kill a running parent conversation.
 */
export function isTransientBurstRateLimit(text?: string): boolean {
  if (!text) return false
  if (!/\bRATE_LIMIT_EXCEEDED\b/i.test(text)) return false
  if (/\bQUOTA_EXHAUSTED\b|individual quota reached/i.test(text)) return false
  const resetMs = parseResetDurationMs(text)
  return resetMs !== undefined && resetMs > 0 && resetMs <= TRANSIENT_BURST_CAP_MS
}

/** Extract Google RPC error metadata model slug (e.g. "gemini-3.1-flash-image"), if present. */
export function extractQuotaErrorModel(text?: string): string | undefined {
  if (!text) return undefined
  const m = text.match(/"model"\s*:\s*"([A-Za-z0-9._:/-]+)"/i)
  return m?.[1]
}

/**
 * True when a failed result envelope carries a hard quota refusal (meaning the
 * attempt must rotate accounts rather than soft-finish on any partial text).
 */
export function isHardQuotaResultError(ok: boolean, error?: string, response?: string): boolean {
  if (ok) return false
  if (error && error.trim() !== '') {
    return looksLikeHardRateLimit(error) && !isTransientBurstRateLimit(error)
  }
  return Boolean(response && looksLikeHardRateLimit(response) && !isTransientBurstRateLimit(response))
}

/**
 * True when a failed result envelope represents a non-consumable account/policy
 * failure even when partial response text was already buffered before the error.
 */
export function isNonConsumableResultError(ok: boolean, error?: string, response?: string): boolean {
  if (ok) return false
  if (isHardQuotaResultError(ok, error, response)) return true
  if (looksLikeTosViolation(error) || looksLikeTosViolation(response)) return true
  if (looksLikeValidationRequired(error) || looksLikeValidationRequired(response)) return true
  if (error && (looksLikeEligibilityFailure(error) || looksLikeAuthFailure(error))) return true
  return false
}
