# Changelog

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
