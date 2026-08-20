# Changelog

## 0.4.10 (2026-08-21)

- **Fixed `Error: unknown tool "run_code"` loop (Root Cause).**
  - Standard DSH agents and WebUI run direct tool dispatch without Code Mode runner (`run_code`). Emitting span cuts addressed to `run_code` triggered `ToolNotFoundError: unknown tool "run_code"` and trapped agy in an infinite error loop.
  - Span cuts now directly emit `agy_tool` tool-call blocks, which execute instantly and render native tool cards (Terminal, Diff, Read, Search).
- **Emphasized System Proxy & TUN Mode Requirements in README.**
  - Added prominent warnings and configuration instructions for system proxy, TUN mode, and environment variables (`HTTPS_PROXY`) required for Google connectivity in restricted regions.

## 0.4.9 (2026-08-20)

- **Theme-Adaptive System & High-Contrast Typography.**
  - Dynamic adaptation to DSH light and dark themes (`body[data-ds-dark-theme]` / `[data-theme="dark"]` / system preferences) across all UI elements (Settings section, header status badge `AGY (n)`, and modal console dialog).
  - High-contrast text & palette tuning: replaced hardcoded dark backgrounds and pale/white text with responsive semantic tokens, ensuring crystal clear legibility in light mode without washed-out or invisible text.
  - Redesigned quota bars, status pills, submodel breakdown rows, buttons, segment toggles, OAuth dialogs, and alert banners with theme-adaptive contrast.

## 0.4.8 (2026-08-20)

- **Pure SVG UI icon system (zero emojis).** Replaced tacky unicode emojis across the UI (trash can, star, plus, refresh, globe, mail, zap, alert, chevrons, close buttons) with clean, crisp, Lucide-style vector SVG icons for a professional developer experience.
- **Accurate quota window display & weekly lockout aggregation.**
  - Quota bars and breakdown rows now display clear window badges (`5h 滚动` / `周限额`) and time countdowns (`↻ 15:46 (4h36m)`).
  - Fixed family quota aggregation: bottleneck model selection now correctly binds the family `resetTime` to the bottleneck model with the lowest `remainingFraction` (and picks the furthest reset on tie), ensuring 7-day weekly rate limits are faithfully preserved and displayed.


- **Mid-turn steer preemption.** DSH claims a steered ("插话") message at the next step boundary and opens a NEW stream() call; the previous run's agy process used to stay alive and keep appending to the SAME conversation concurrently. The adapter now tracks the in-flight run per session and aborts it before starting the steered run (auxiliary calls neither preempt nor get tracked).
- **UI simplification.** Sidebar bottom-left shortcut removed (the console modal now lives on the header `AGY (n)` badge); quota rows are percent-first — brand logo + bar + `85%` + `↻ 14:44 · 3h12m` — with language-neutral `5h`/`7d` window badges and all Chinese status words (`充足/紧张/适中/未知`) dropped.

## 0.4.6 (2026-08-20)

- **Fixed premature context compaction (root cause).** agy's `result` envelope reports CONVERSATION-CUMULATIVE usage (input 3.8M / cacheRead 72M in the wild), while `step_update` usage is per-call (true current context). DSH's token meter treats the last sample as context occupancy, so forwarding the cumulative envelope exploded pressure past the 80%-of-1M threshold within a few turns and fired constant compactions. The mapper now reports the last per-call step sample (tracked on the shared run recording, span-safe); falls back to the envelope only when no step carried usage.
- **Quota windows + model logos in the UI.** Per-family bars now carry official Gemini / Claude / OpenAI brand SVG marks, a 5小时额度/周额度 window badge (inferred from reset distance), and a live reset countdown; per-model breakdown rows stay available on expand. Removed the verbose mechanism-explainer block.
- **Unified browser login everywhere.** `/agy auth` now runs the same PKCE + loopback-callback flow as the pool's add-account (new `PoolAuthFlow.beginPrimary()` writing agy-format tokens into the real HOME); the QR/code-paste-first copy is gone from README and command help. Primary flows never touch staging cleanup.
- **README refresh.** Install/login instructions match the browser flow; new References section (CLIProxyAPI, opencode-antigravity-auth, OmniRoute, pi-mono).

## 0.4.5 (2026-08-20)

- **Fixed Quota Display (Root Cause).**
  - agy ≥ 1.1.15 writes the token file in a NESTED shape (`{"token": {...}, "auth_method": "consumer"}` with ISO-8601 string expiry); the old flat parser read the nested `token` object as the access token string, producing `Authorization: Bearer [object Object]` → every quota fetch failed 401 → the UI permanently showed a fake `100% 充足`.
  - `normalizeStoredToken` now handles nested + flat shapes, ISO/epoch-second/epoch-ms expiries, and rejects non-string access tokens.
  - Token refresh now works out of the box via the public Antigravity client credentials (env-overridable with `AGY_CLIENT_ID`/`AGY_CLIENT_SECRET`), and quota fetch walks the verified 4-endpoint fallback order (daily → prod → daily-sandbox → autopush).
  - All Node-side Google calls now go through `src/host/net.ts` (undici's own fetch + EnvHttpProxyAgent): Node's built-in fetch ignores `HTTP(S)_PROXY`, and mixing an external undici dispatcher into it throws `UND_ERR_INVALID_ARG` — both silently failed every call behind a proxy. Per-account `proxyUrl` wins over env.
  - The client renders an explicit grey `— 未知` state when no quota data exists instead of a fake 100%.
  - Background quota refresh every 5 minutes (token-file reads only — no agy spawns, no Keychain prompts).
- **Rebuilt Add-Account OAuth (Root Cause).**
  - The old flow scraped a login URL out of `agy -p ping` print mode; agy ≥ 1.1.15 never prints one when logged out, so the probe timed out after 20s and the route STILL returned `ok:true` — the UI claimed "浏览器已调起" while no browser ever opened, leaving a stuck `auth.phase='ok'` and orphaned `staging_*` dirs.
  - New self-owned flow (`src/host/oauth.ts` + `src/host/pool-auth.ts`): PKCE + public Antigravity client credentials + loopback callback listener on `http://localhost:51121/oauth-callback` (the redirect registered for the Antigravity client), browser opened server-side. The authorization code is captured automatically — no manual pasting; paste of a bare code or the full callback URL remains as fallback.
  - Tokens are written in agy's own on-disk format into the account's isolated HOME, so the official agy binary is immediately signed in for that account; email is resolved via userinfo and quota refreshed on commit.
  - Failures now return `ok:false` with the real reason; staging dirs are cleaned on failure/cancel, and stale `staging_*` dirs are swept at boot.
- **Fixed "cannot add a second account".** The server holds the `done` auth status for 30s so pollers can observe it; reopening the add-account panel inside that window replayed the previous success toast and closed the panel instantly. The client now only reacts to `done`/`failed` for a flow actually started from the current panel session.
- **Cross-Platform Hardening.**
  - Windows account isolation actually works now: `isolatedHomeEnv()` sets `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` alongside `HOME` — Node (libuv) and Go ignore `$HOME` on Windows, so secondary accounts previously shared the real user profile there. Applied to the adapter, the auth probe, and the terminal-login routes.
  - Windows browser open no longer breaks on the OAuth URL's `&` query separators (pre-quoted `cmd /d /s /c start "" "url"` with verbatim arguments).
  - Quota `User-Agent` now reflects the real platform/arch instead of a hardcoded `darwin/arm64` fingerprint.
  - Token file writes are mode-0600 on POSIX and safely skipped on Windows.
- **Fixed Settings Flicker (Residual).**
  - v0.4.3 removed the per-poll re-render; the remaining flash came from the settings modal unmounting the section on close — every reopen rendered a misleading amber "待认证" empty state until the first poll landed. A module-level status cache now seeds the first render instantly.
  - Removed the 2s pulse animation on status dots (static dots; color still conveys state) and added a fixed-height skeleton for the first-ever load.

## 0.4.3 (2026-08-20)

- **Eliminated macOS Keychain Prompts ("Antigravity Safe Storage").**
  - Removed periodic `agy models` process spawns from the high-frequency `/plugins/agy-link/status` endpoint.
  - The status endpoint now serves instantaneous cached state in 0ms, preventing macOS Gatekeeper / Security daemon from triggering keychain dialogs or access errors in background sessions.
- **Fixed UI Flickering & Re-render Thrashing.**
  - Implemented payload hash/equality checks before setting state in the React hook, completely eliminating re-render flashing during polling.
  - Cleaned up duplicated definitions in the client bundle.
- **Fixed Quota Percentage Display.**
  - Properly unified remaining quota percentage rendering for Gemini, Claude, and GPT-OSS families across all active and primary accounts (showing `100% 充足` / live percentages or cooldown time).

## 0.4.2 (2026-08-20)

- **Remaining Quota Quantitative Display & Clean Progress Meters.**
  - Every account card now displays explicit, quantitative remaining quota meters (percentages and progress bars) for all three model families: Gemini (`✨`), Claude (`🧠`), and GPT-OSS (`⚡`).
  - Active and healthy accounts display 100% capacity (or live fractional quota returned from Google CloudCode backend) with emerald green progress bars; accounts in cooldown display 0% with real-time countdown badges (`Xs 冷却`).
- **Eliminated False Premature Account Additions & Browser OAuth.**
  - Staging account slot isolation: new accounts are created in temporary staging directories and only committed to `pool.json` when authorization code verification actually succeeds (`code === 0`). Cancelling or failing auth cleans up staging files with zero ghost accounts left behind.
  - Automatic system browser launch (`open <url>` on macOS, `start` on Windows, `xdg-open` on Linux) when initiating account addition, plus a direct one-click fallback link in the UI.
- **Drastic WebUI Simplification & Modern Redesign.**
  - Clean, high-contrast, linear-style UI: removed all noisy explanatory paragraphs, repetitive buttons, and cluttered text disclaimers.
  - Compact account cards with essential actions (`设为主用`, `⚙️ 代理`, `🗑️ 移除`).
  - Sleek segmented pill controls for pool scheduling mode (`顺次耗尽` / `轮询均衡`), permission mode (`plan` / `accept-edits` / `skip`), and reasoning effort (`auto` / `low` / `medium` / `high`).

## 0.4.1 (2026-08-20)

- **Context Optimization & Compaction Lifecycle Sync (ADR-013).**
  - **Uniform 1M Context Window**: `resolveModel` uniformly advertises 1,048,576 (1M) context window across all Antigravity models (Gemini, Claude via Antigravity, GPT-OSS). Prevents DSH from prematurely firing context compaction requests due to agy's cumulative tool token reporting.
  - **Compaction-Aware Session Rebinding**: When DSH compacts history or clears session messages (detected by `messages.length < binding.lastMessageCount`), the adapter automatically releases the stale `conversationId` binding and seeds a fresh, clean agy session with the compacted summary digest, eliminating infinite compaction loops.
  - **Pure Transparent Message Pass-Through**: Multi-turn continuations in active bound sessions pass only the trailing user prompt + `--conversation <id>`, leaving conversation state management and tool chaning to Antigravity's native engine.
  - **Multimodal Support Fix**: Declared `inputModalities: ['text', 'image']` across all Antigravity models in `listModels` and `resolveModel`, enabling native drag-and-drop / paste image support in DSH.
  - **Unified One-Click macOS Terminal Login**: Streamlined account addition to native macOS Terminal auth with real Gmail extraction and visual health indicators.

## 0.4.0 (2026-08-20)

- **Multi-Account Pool & Process-Level Profile Isolation.**
  - Account pool management under `~/.dsh/agy-accounts/` with physical process-level environment isolation (`HOME=~/.dsh/agy-accounts/<id>/`).
  - Primary account rides system `HOME` to reuse Mac OS Keychain credentials without duplicate login.
  - Multi-profile Google OAuth flow: dynamic state machine per account, drop hardcoded OAuth credentials, secure in-memory and isolated disk storage.
  - Per-account proxy configuration (`ALL_PROXY` / `HTTPS_PROXY`) preventing IP correlation across accounts.
- **Sticky Sequential Drain (按模型家族顺次耗尽).**
  - Fine-grained rate limit tracking scoped to model family (`google`, `anthropic`, `openai`). Exhausting Claude quota will not penalize Gemini requests.
  - Transparent in-flight failover: upon encountering `429` / `RESOURCE_EXHAUSTED`, the active turn immediately and seamlessly switches to the next healthy account.
  - Automatic cooldown calculation with tiered backoff and reset time detection.
- **Real-Time Quota Progress Bars & Silent Degradation.**
  - Real-time token consumption and quota percentage tracking for all pooled accounts.
  - Quota statistics surface directly to DSH WebUI with visual progress bars and bottleneck indicators.
  - Graceful silent degradation: token polling failures fall back smoothly without interrupting ongoing runs.
- **DSH In-GUI Management & Slash Commands.**
  - New slash commands: `/agy pool`, `/agy add-account`, `/agy switch`, and `/agy quota`.
  - Rich WebUI status card with account list, quota meters, proxy badges, and fast switcher.

## 0.3.6 (2026-08-20)

- **Comprehensive Google OAuth login state machine & reliable QR rendering.**
  - Fixed broken QR image rendering by generating inline base64 data URLs directly in the `/status` payload (`auth.qrDataUrl`).
  - Added direct one-click authorization link (`👉 点击在浏览器中打开 Google 授权页面`) so users can open the consent URL in their browser tab with proxy support.
  - Implemented explicit state machine lifecycle: `signed-out` -> `pending` (URL & QR active) -> `submitting` (exchanging authorization code) -> `ok` (connected & refreshed) / `failed` (actionable error & restart).
  - Added `/plugins/agy-link/auth-cancel` endpoint and in-GUI Cancel / Restart buttons.
- **Fixed non-Gemini model execution (Claude Sonnet / Claude Opus / GPT-OSS).**
  - The agy CLI rejects the `--effort` flag for Claude and GPT-OSS models (`--effort is not supported for model ...`). The adapter now automatically strips `--effort` when calling non-Gemini models.
  - Added automatic model slug alias resolution: `claude-opus-4-6` and `claude-opus` resolve to `claude-opus-4-6-thinking`; `gpt-oss-120b` resolves to `gpt-oss-120b-medium`.
  - Updated `DEFAULT_FALLBACK_MODELS` to match live agy 1.1.15 slugs.


- **Sliding activity watchdog for long-running tasks.** Replaced the static
  wall-clock timeout with an activity-based idle watchdog: the timer rearms
  on every chunk of stdout/stderr activity. Long-running tasks (e.g. multi-step
  refactors, extensive test suites, deep searches) can now run indefinitely as
  long as the process is actively working, while deadlocked/silent processes
  are still cleanly terminated after `timeoutMs` of complete inactivity.
  The agy CLI `--print-timeout` is given a generous ceiling (4h) to avoid
  premature termination of active print sessions.

## 0.3.4 (2026-08-19)

- **Tool activity moved out of the thinking panel into the reply body.**
  User feedback on 0.2.8: tool annotations hidden inside the DSH thinking
  fold were invisible and felt wrong. agy tools now render as visible
  `🔧 [agy tool: name] args -> output` lines in the message body (they
  cannot become native DSH tool cards: a finish:tool-calls would make the
  DSH agent try to execute tools it does not own — agy runs its own closed
  tool loop). The thinking panel keeps only what is genuinely thinking
  signal: `[agy thinking turn · N thinking tokens]` turn annotations
  (agy print mode never streams thinking text) and terminal error notes.

## 0.2.8 (2026-08-19)

- **Fix: real agy 1.1.15 stream-json parsing.** The parser only understood
  flat, hypothesized event shapes; the live CLI nests every step payload
  under a `step_update` envelope and uses a different vocabulary
  (`agent_response` + `text_delta` fragments, `tool` with `tool_name` /
  `tool_info` with `parameters` / `output` / `error`). As a result thinking
  and tool activity were silently dropped and only the final result text
  survived. Both shapes are now parsed (legacy aliases kept).
- **New: visible thinking turns + tool activity.** agy does not stream
  thinking text in print mode (only `thinking_tokens` usage), so each
  thinking-only `agent_response` turn surfaces as an annotated reasoning
  block (`[agy thinking turn · N thinking tokens]`), tool calls render as
  `[agy tool: name] args -> output` reasoning annotations, and failed tools
  render `[agy tool error: name] message`.
- **Fix: `result.status=ERROR` with a usable response** (e.g. a tool timed
  out mid-run) no longer discards the answer — the response streams, the
  error is annotated, the turn finishes normally. A bare envelope error
  now maps to a precise `AGY_ERROR` finish instead of INVALID_OUTPUT.
- **Fix: `agy models` deadlock — stdin pipe never closed.** agy reads stdin
  when it is a pipe and waits for EOF; every non-auth spawn kept the pipe
  open, so model discovery silently timed out and the catalog always fell
  back to the bundled list. Stdin now closes right after spawn (auth probes
  keep it open).
- **Fix: auth phase was always `idle`** until someone ran `/agy auth`, so
  the settings page claimed "needs Google login" for signed-in users.
  Status surfaces now lazily probe the real login state via `agy models`
  (60s cache) and report `ok` / `signed-out` truthfully.
- **Fix: `/plugins/agy-link/*` routes never registered on dsh web** (settings
  page stuck on `binary: not found / auth: unknown / models: 0`). Routes are
  now registered through a reactive `ctx.inject(['webServer'])` sub-fiber,
  so they attach whenever the service appears instead of racing it. The
  settings page also renders an honest "endpoint unreachable" state instead
  of misleading placeholders when the route is missing.
- **Removed: sidebar footer AGY button** (user request). Login (QR +
  authorization code) and mode/effort quick controls moved to Settings →
  Antigravity; the conversation header `AGY` pill stays.
- Tests: real-1.1.15 fixture modes (`real`, `real-error`, `real-fail`) and
  parser/mapper/adapter coverage for the nested format (73 tests).

## 0.2.7 (2026-08-19)

- Visible agy status in DSH: conversation header `AGY` pill, Settings → Antigravity status page, and sidebar footer label.
- Workspace auto-binding: agy now runs in the DSH session's `cwd` when `workspaceRoot` is not configured.
- New `/agy workspace [path]` command and `DSH_AGY_WORKSPACE_ROOT` env.
- README language switcher at the top (中文 / English).

## 0.2.2 (2026-08-19)

- README: dedicated Prerequisites section (DSH, Node >= 24, the agy CLI with Google's official install guide link, first-run login, subscription note), a "how it works" intro paragraph, and an honest "what it cannot do" list in both languages - onboarding now covers first-time users.
## 0.2.1 (2026-08-19)

- Cross-platform hardening (Linux / macOS / Windows):
  - binary discovery is platform-aware: agy / agy.exe / .cmd / .bat across
    PATH, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin,
    %LOCALAPPDATA%\Programs, and the npm shim dir; a real executable is
    always preferred over a cmd shim
  - Windows .cmd/.bat shims spawn through cmd.exe with cross-spawn-style
    argument quoting (unit-tested)
  - tree-kill uses taskkill /T /F on Windows (Unix process groups do not
    exist there); detached sessions are POSIX-only so no console window
    flashes on Windows
  - CRLF stdout is normalized (trailing \r stripped per line)
  - the MCP bridge script path resolves via fileURLToPath (URL.pathname
    would yield /C:/... on Windows and break the spawn)
- 5 new cross-platform tests (56 total).

## 0.2.0 (2026-08-19)

- Multimodal (path-based): DSH image attachments are staged to a local media
  directory (config `mediaDir`, TTL sweep `mediaTtlMs`, caps `mediaMaxBytes` /
  `mediaMaxImages`) and referenced by absolute path in the agy prompt with
  `--add-dir` - agy views them with its own tools. Env: `DSH_AGY_MEDIA_DIR`,
  `DSH_AGY_MEDIA_TTL_MS`.
- `agy_ask` gains `readPaths` (inline text files into the one-shot prompt;
  binaries skipped with a note) and `schema` (JSON Schema enforced via
  `--json-schema`).
- MCP reverse bridge (experimental, `mcpBridge: true` / `DSH_AGY_MCP_BRIDGE=1`):
  agy can call DSH-side tools through a loopback, token-guarded endpoint plus a
  zero-dep stdio MCP server merged into the workspace `.mcp.json`.
  `mcpToolAllowlist` restricts the exposed set; `run_code` / `agy_ask` are
  never bridged.
- Abort semantics locked by a regression test: everything the model produced
  before the caller hits stop is preserved (open block closed, then failure
  finish).
- 12 new tests (51 total).

## 0.1.5 (2026-08-19)

- README restructured into a single bilingual page: Chinese first, then
  English (README.zh.md removed; package files list updated).
- Releases now publish to npm automatically (NPM_TOKEN secret configured).
