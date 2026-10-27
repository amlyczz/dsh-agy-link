// Shared vocabulary for dsh-agy-link: plugin config, provider-route ids,
// stable error codes, and the normalized event stream produced by the
// stream-json parser and consumed by the StreamChunk mapper.

export const PROVIDER_ID = 'antigravity'
export const PLUGIN_ID = 'agy-link'
export const PKG_NAME = 'dsh-agy-link'

export type PermissionMode = 'skip' | 'plan' | 'accept-edits'

export interface FallbackModelDef {
  id: string
  name: string
  /** Selectable reasoning efforts; omit for fixed-thinking models. */
  efforts?: readonly string[]
}

export interface PluginConfig {
  enabled: boolean
  /** Absolute path to the agy binary; empty string = resolve from PATH. */
  agyBin: string
  /** Extra argv appended to every spawn (escape hatch). */
  extraArgs: readonly string[]
  permissionMode: PermissionMode
  defaultModel: string
  defaultEffort: string
  /** Watchdog for one full agy -p run. */
  timeoutMs: number
  /**
   * Idle budget while an agy tool step is still open (ACTIVE without
   * DONE/ERROR). A long build/compile is legitimately silent on stdout, so
   * the watchdog gets this larger budget instead of `timeoutMs`. Default 240
   * minutes (the print-mode ceiling). Set 0 to disable the raise: a tool step
   * that never completes then dies after `timeoutMs` and fails the turn
   * loudly instead of holding the session for hours.
   */
  longToolIdleMinutes: number
  /** Hard cap (minutes) on the credential-slot wait before release+retry; 0 = unlimited. */
  dispatchTimeoutMinutes: number
  /** Extra dispatch attempts after a credential-slot hard-cap timeout. */
  dispatchRetries: number
  /**
   * Same-account credential-slot fast path: parallel runs on one account,
  * exclusive only for account switches (Windows credential slot).
   */
  parallelSameAccount: boolean
  maxConcurrent: number
  contextWindowDefault: number
  maxTokensDefault: number
  /**
   * Prepend `options.system` to the agy prompt. Opt-in for ordinary turns,
   * because agy owns its own agent instructions and stacking DSH's rendered
   * prompt on top invites conflicts. Host authorization-review calls (those
   * carrying REVIEW_POLICY) always forward their system prompt regardless of
   * this flag: the output protocol lives there, and dropping it makes the
   * reviewer answer in prose instead of the required JSON object.
   */
  forwardSystemPrompt: boolean
  digestMaxChars: number
  /**
   * Character budget for the history digest used to seed a brand-new agy
   * conversation (first contact, account switch, model switch, compaction
   * re-seed). Generous on purpose: modern models are 1M-token class, and a
   * small budget silently dropped most of a long session on every account
   * switch. Default 660K, sized for 1M-token-class models.
   */
  contextTransferMaxChars: number
  modelsCacheTtlMs: number
  /** Allow compaction / session-title auxiliary calls to spawn agy. */
  allowAuxiliary: boolean
  /** Hard character cap for compaction prompts built from history. */
  compactionMaxChars: number
  /** Lock the working directory for agy spawns; empty string = process.cwd(). */
  workspaceRoot: string
  fallbackModels: readonly FallbackModelDef[]
  /**
   * Model ids hidden from the DSH model picker (deny-list: anything not
   * listed stays visible, so newly discovered models appear by default).
   * resolveModel still accepts hidden ids so in-flight sessions keep working.
   */
  hiddenModels: readonly string[]
  askTool: boolean
  /** Directory where inbound images are staged for agy (path-based multimodal). */
  mediaDir: string
  /** Images older than this are swept from mediaDir. */
  mediaTtlMs: number
  /** Per-image byte cap for staging; larger images are skipped with a note. */
  mediaMaxBytes: number
  /** Max images staged per model call. */
  mediaMaxImages: number
  /** Experimental: expose DSH tools to agy over a local MCP bridge. */
  mcpBridge: boolean
  /** Where the bridge publishes its MCP entry. `agy` 1.4+ only reads the global registry. */
  mcpConfigScope: 'global' | 'workspace' | 'both'
  /** Absolute override for the agy MCP registry file. Empty = <agy home>/.gemini/config/mcp_config.json */
  mcpConfigPath: string
  /** Comma-separated tool-name allowlist for the MCP bridge (empty = all non-internal). */
  mcpToolAllowlist: string
  /** Maximum requests allowed per minute across all sessions (0 = disabled). */
  rateLimitPerMinute: number
  /** Automatically fallback to available lower-tier model if active model is exhausted. */
  autoFallbackModel: boolean
  /** Days to retain historical agy CLI log files before automatic sweep (default: 7). */
  logRetentionDays: number
  /** Opt-out and suppress Google Cloud Code / Antigravity telemetry tracking. */
  disableTelemetry: boolean
  /** Background quota polling interval in ms (default 60 min; clamped >= 60s). Lower = more risk-control exposure. */
  quotaPollIntervalMs: number
  /**
   * Fetch quota statistics via official `agy -p /usage` CLI execution instead
   * of direct Node.js REST calls to Google internal endpoints (default: true).
   */
  quotaViaCli: boolean
  /**
   * Global proxy URL (http:// or socks5://) applied to every agy spawn and
   * Google API call. An account's dedicated proxyUrl wins over this; empty
   * string = direct connection. GUI apps don't inherit shell proxy env, so
   * desktop installs need this (or per-account proxies) to reach Google.
   */
  proxyUrl: string
  /**
   * Pre-empt agy's built-in auto-updater before every spawn (issue #49).
   *
   * agy >= 1.4.2 ignores AGY_CLI_DISABLE_AUTO_UPDATE for the `--bg-updater`
   * child it spawns itself, and that child's `agy --version` grandchild
   * allocates a visible console window on Windows. Refreshing
   * `<agy home>/last_check.timestamp` keeps agy on its 15-minute fast path, so
   * the child chain never starts. Default: true on Windows, false elsewhere.
   * Cost: the agy home used by this plugin stops doing automatic update checks
   * (`agy update` still works); set false to restore agy's own behaviour.
   */
  suppressAgyAutoUpdate: boolean
}

// Full fallback line-up, mined from the agy 1.1.13 binary. Serves the
// picker when agy models cannot run (signed out / offline); the live list
// always comes from `agy models` once signed in.
export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

export function defaultConfig(): PluginConfig {
  return {
    enabled: true,
    agyBin: '',
    extraArgs: [],
    permissionMode: 'skip',
    defaultModel: '',
    defaultEffort: '',
    timeoutMs: 600_000,
    longToolIdleMinutes: 240,
    /**
     * Hard cap (minutes) on waiting for the Windows credential slot before the
     * dispatch releases, backs off and retries (dispatchRetries). Each attempt
     * waits up to this long, so persistence ≈ (1 + dispatchRetries) × N
     * minutes before the turn fails visibly. 0 = wait indefinitely (the wait
     * stays abort-aware, poll-healed and heartbeat-logged).
     */
    dispatchTimeoutMinutes: 15,
    /** Extra dispatch attempts after a credential-slot hard-cap timeout. */
    dispatchRetries: 1,
    /**
     * Same-account credential-slot fast path (default true): sessions running
     * on the account whose credential already sits in the Windows slot start
     * immediately WITHOUT exclusivity — agy is a stateless CLI and handles
     * concurrent processes natively. Only account SWITCHES serialize.
     * false restores full-run slot exclusivity (one agy process at a time).
     */
    parallelSameAccount: true,
    /**
     * Cross-session cap on concurrent agy request streams. 0 = UNLIMITED
     * (default): native agy concurrency — agy is a stateless CLI and runs
     * concurrent processes natively; Google rate limits and the account
     * pool's cooldowns are the natural regulators. Set a positive number to
     * re-introduce an admission bound.
     */
    maxConcurrent: 0,
    contextWindowDefault: 1_048_576,
    maxTokensDefault: 65_536,
    forwardSystemPrompt: false,
    digestMaxChars: 8_000,
    contextTransferMaxChars: 660_000,
    modelsCacheTtlMs: 300_000,
    allowAuxiliary: true,
    compactionMaxChars: 800_000,
    workspaceRoot: '',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    hiddenModels: [],
    askTool: false,
    mediaDir: '',
    mediaTtlMs: 86_400_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxImages: 8,
    mcpBridge: false,
    mcpConfigScope: 'global',
    mcpConfigPath: '',
    mcpToolAllowlist: '',
    rateLimitPerMinute: 0,
    autoFallbackModel: false,
    logRetentionDays: 7,
    disableTelemetry: true,
    quotaPollIntervalMs: 60 * 60_000,
    quotaViaCli: true,
    proxyUrl: '',
    // Windows is where agy's `--bg-updater` grandchild flashes a console
    // window; other platforms keep agy's own update behaviour by default.
    suppressAgyAutoUpdate: process.platform === 'win32',
  }
}

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
   * Canonical provider-neutral code for context window overflow.
   * Enables DSH agent loop to trigger context auto-compaction rather than aborting.
   */
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
} as const

// Raw usage object as emitted by agy stream-json (snake_case).
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  total_tokens?: number
}

export type AgyStepKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'title'
  | 'subagent'
  | 'user-input'
  | 'unknown'

export interface AgyToolInfo {
  name: string
  /** Raw arguments: JSON string when agy serializes them, else object. */
  args?: unknown
  output?: unknown
  /** Tool-side failure text (agy 1.1.15: tool_info.error.message on state=ERROR). */
  error?: string
}

export type AgyEvent =
  | { kind: 'init'; conversationId?: string; model?: string; raw: unknown }
  | {
      kind: 'step'
      stepKey: string
      stepKind: AgyStepKind
      text: string
      /** text is a sequential fragment to append, not a cumulative snapshot (agy ≥1.1.15 text_delta). */
      fragment?: boolean
      tool?: AgyToolInfo
      /** Step lifecycle as reported by agy: ACTIVE / DONE / ERROR. */
      state?: string
      /** Per-step usage (agy ≥1.1.15 reports usage on agent_response steps). */
      usage?: RawUsage
      raw: unknown
    }
  | {
      kind: 'result'
      conversationId: string
      ok: boolean
      response: string
      error?: string
      usage: RawUsage
      raw: unknown
    }
  | { kind: 'garbage'; line: string }

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

