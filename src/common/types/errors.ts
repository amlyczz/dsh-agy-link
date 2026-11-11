// Stable error codes surfaced by the adapter, plus the context-window and
// thought-signature sentinels shared with the parser.

/** Sentinel used to bypass Google Cloud 400 INVALID_ARGUMENT when function calls lack a thought signature. */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/**
 * Recognize context-overflow and token limit exceeded errors from Google Antigravity / agy CLI.
 * Aligns with DSH's CONTEXT_WINDOW_EXCEEDED_CODE contract so the agent loop triggers context
 * auto-compaction instead of terminating the turn with a fatal process exit.
 */
export function looksLikeContextWindowExceeded(message: string): boolean {
  if (!message) return false
  if (/prompt is too long:\s*\d+\s*tokens\s*>\s*\d+\s*maximum/i.test(message)) return true
  if (/context[\s_-]*(?:length|window)[\s_-]*(?:exceeded|overflow|limit[\s_-]*exceeded)/i.test(message)) return true
  if (/\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(message)) return true
  if (/\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?\b/i.test(message)) return true
  if (/\btoken[\s_-]*limit[\s_-]*exceeded\b/i.test(message)) return true
  if (/\bexceed(?:s|ed|ing)?\b.{0,40}\b(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b/i.test(message)) return true
  if (/\b(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b.{0,40}\bexceed(?:s|ed|ing)?\b/i.test(message)) return true
  return false
}

// Stable LlmError codes surfaced by the adapter (spec error table).
export const Err = {
  AUTH: 'AUTH',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  AGY_NOT_INSTALLED: 'AGY_NOT_INSTALLED',
  AGY_VERSION_UNSUPPORTED: 'AGY_VERSION_UNSUPPORTED',
  AGY_ERROR: 'AGY_ERROR',
  /**
   * Hard server-issued quota / rate-limit refusal. Distinct from AGY_ERROR so
   * the provider retry policy can retry it (the failed account is already in
   * cooldown, so the retry lands on the next account) without also retrying
   * deterministic AGY_ERRORs (bad region, empty request, dead pool).
   */
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  /**
   * Google-side region / account eligibility refusal ("User location is not
   * supported for the API use"). Account-level, so it is retryable: the
   * adapter rotates the sticky pointer first, which lets an account whose
   * proxy/egress region IS supported serve the retry.
   */
  ELIGIBILITY: 'ELIGIBILITY',
  TIMEOUT: 'TIMEOUT',
  PROCESS_EXIT: 'PROCESS_EXIT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  /**
   * Transport failure wrapped around an auth-looking refusal. agy cannot tell
   * "the token is gone" from "I could not validate the token because the
   * network died", and it reports both as "not logged into Antigravity".
   * Kept separate from AUTH so the turn is retried on ANOTHER account instead
   * of ending on a healthy one (and so no account is flagged for re-login).
   */
  NETWORK: 'NETWORK',
  /**
   * Soft Google-side capacity refusal ("model overloaded" / "experiencing high
   * traffic"). Account-scoped for retry purposes — the sticky pointer moves to
   * the next account — but it is NEVER a cooldown reason: nothing was spent, so
   * a 15-minute penalty would only shrink the pool.
   */
  OVERLOADED: 'OVERLOADED',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT',
  AUX_DISABLED: 'AUX_DISABLED',
  BUSY: 'BUSY',
  /**
   * The model finished cleanly but emitted no visible text at all. agy/Gemini
   * occasionally returns an empty candidate — observed as a normal `stop`
   * envelope with no text block after ~25s — so this is kept distinct from the
   * deterministic AGY_ERROR failures: it is transient, and the bounded retry
   * almost always gets text on the next attempt.
   */
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  /**
   * Canonical provider-neutral code for context window overflow.
   * Enables DSH agent loop to trigger context auto-compaction rather than aborting.
   */
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
} as const
