// Plugin identity, the user-facing config shape, and its defaults.

import { DEFAULT_FALLBACK_MODELS, PREFERRED_CLAUDE, PREFERRED_GEMINI_FLASH, type FallbackModelDef } from '../model-lineup.ts'

export const PROVIDER_ID = 'antigravity'
export const PLUGIN_ID = 'agy-link'
export const PKG_NAME = 'dsh-agy-link'

export type PermissionMode = 'skip' | 'plan' | 'accept-edits'


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
  /**
   * Hard wall-clock cap for a single turn, in minutes (0 = unlimited). The idle
   * watchdog re-arms on every output line, so without this a self-driving agy
   * loop that keeps printing can run unbounded (issue #92).
   */
  maxTurnMinutes: number
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
  /**
   * Byte budget for INLINING the context-transfer digest into one prompt.
   * agy 1.4.x truncates a single user message at 192,000 UTF-8 bytes and the
   * cut lands on the TAIL, so a huge inline digest used to swallow the live
   * request that followed it. Keep this well below that ceiling.
   */
  contextTransferMaxBytes: number
  /**
   * Above this many UTF-8 bytes the digest is written to a temp .md file and
   * referenced by path instead of inlined: agy then reads it in pages, which is
   * the only way a long history can use the model's real (1M-token) window.
   */
  contextTransferFileAboveBytes: number
  /** Byte cap for the file-backed digest (not bounded by agy's message cap). */
  contextTransferFileMaxBytes: number
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
  /**
   * 7-day weekly quota auto-warmup (smart reset activation): automatically
   * sends a minimal probe when an account reaches its weekly reset window or
   * cold start, activating the 7-day upstream timer.
   */
  autoWarmup: boolean
  /** Models monitored/used for auto-warmup. Defaults to the Gemini Flash + Claude lineup picks. */
  warmupModels: readonly string[]
  /**
   * Auto "plain language" translation after every completed agent turn
   * (default OFF). The finished turn's final answer is sent to the translate
   * model and the result is persisted as a `plugin:agy-link/translation`
   * session record, rendered as a labelled Gemini card under that reply.
   */
  autoTranslate: boolean
  /** Model used for translation (default: the preferred Gemini Flash; falls back through the live catalog). */
  translateModel: string
  /**
   * Reasoning effort for effort-capable translate models (default `medium`).
   * Measured on real agy for one 964-char reply: low ≈ 12s, medium ≈ 33s,
   * high ≈ 45s — and the high-effort output also reads more like a formal report.
   */
  translateEffort: string
  /** Target language wording passed to the translator prompt. */
  translateTargetLanguage: string
  /** Per-request source text cap; longer answers are chunked by paragraph. */
  translateMaxChars: number
  /** Output token cap for one translation call. */
  translateMaxTokens: number
  /** Watchdog for one translation call. */
  translateTimeoutMs: number
  /** Extra attempts after the first failed translation (each retry re-picks an account). */
  translateRetries: number
  /** Skip translating turns already produced by the translate model itself. */
  /**
   * Run translations inside ONE agy conversation per DSH session (1:1), so the
   * persona — including that session's id, its workspace and where its history
   * lives — is sent once and every later translation sends only the source text.
   */
  translateBindConversation: boolean
  translateSkipSameModel: boolean
  /** Minimum spacing between automatic translations inside one session (0 = no throttle). */
  translateMinIntervalMs: number
  /**
   * Show Antigravity status badge in the conversation header toolbar (default: true).
   * Set false to hide it (especially on mobile / narrow viewports).
   */
  showHeaderBadge: boolean
  /**
   * Show per-message plain-language translate action button in chat assistant actions (default: true).
   * Set false to hide the "译成人话" Gemini button.
   */
  showTranslateAction: boolean
  // ---- image generation (`dsh-agy-image` CLI, purpose:'image' adapter route) ----
  /** Chat model that drives the `generate_image` call ('' = defaultModel → the preferred Gemini Flash). */
  imageModel: string
  /** Reasoning effort for that hop (default `low`: the image model does the real work). */
  imageEffort: string
  /** Wall-clock cap for one image generation, including the image model (default 240s). */
  imageTimeoutMs: number
  /** Largest artifact the plugin will accept (default 20 MiB). */
  imageMaxBytes: number
  /** Copy finished images here by default ('' = leave them in agy's artifact dir). */
  imageOutputDir: string
  /** Extra attempts after a retryable image failure (default 1). */
  imageRetries: number
}

// The offline/signed-out lineup lives in `common/model-lineup.ts` — the single
// place that names concrete agy models. Re-exported here so the historical
// `common/types` import surface keeps working.
export { DEFAULT_FALLBACK_MODELS }
export type { FallbackModelDef }

export function defaultConfig(): PluginConfig {
  return {
    enabled: true,
    agyBin: '',
    extraArgs: [],
    permissionMode: 'skip',
    defaultModel: '',
    // Explicit 'high' (not ''): effort-capable models default to the highest
    // agy offers, and the per-model choice now lives in DSH's model menu.
    defaultEffort: 'high',
    timeoutMs: 600_000,
    longToolIdleMinutes: 240,
    maxTurnMinutes: 0,
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
    contextTransferMaxBytes: 150_000,
    contextTransferFileAboveBytes: 55_000,
    contextTransferFileMaxBytes: 2_000_000,
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
    // Opt-in: this path sends direct REST probes to Google's internal
    // endpoints, so it must never start probing on upgrade. Users enable it
    // explicitly with `autoWarmup: true` / DSH_AGY_AUTO_WARMUP=1.
    autoWarmup: false,
    warmupModels: [PREFERRED_GEMINI_FLASH, PREFERRED_CLAUDE],
    // Translation is strictly opt-in: it spends quota on every completed
    // turn, so the default must never silently start billing a user.
    autoTranslate: false,
    translateModel: PREFERRED_GEMINI_FLASH,
    // Medium is the speed/quality compromise measured on real agy: low ≈ 12s,
    // medium ≈ 33s, high ≈ 45s for the same 964-char reply (most of the low
    // figure is agy's own ~9s startup). high made a frequent action feel broken.
    translateEffort: 'medium',
    translateTargetLanguage: '中文（简体）',
    translateMaxChars: 8_000,
    translateMaxTokens: 4_096,
    translateTimeoutMs: 120_000,
    translateRetries: 2,
    translateBindConversation: true,
    translateSkipSameModel: true,
    translateMinIntervalMs: 3_000,
    showHeaderBadge: true,
    showTranslateAction: true,
    imageModel: '',
    imageEffort: 'low',
    imageTimeoutMs: 240_000,
    imageMaxBytes: 20 * 1024 * 1024,
    imageOutputDir: '',
    imageRetries: 1,
  }
}
