# Security hardening invariants

Threat model: the spawned `agy` child runs untrusted model output; a prompt-injected
child, a malicious webpage open in the user's browser, or any local client that can
reach a plugin route must not be able to escalate beyond what the operator exposed.
Each invariant below is enforced in code AND covered by a regression test.

## MCP reverse bridge (`src/host/mcp-bridge.ts`, `src/host/bridge.mjs`)

- `/call` receives `exec.signal: AbortSignal` (never omitted) and `agent` only when
  a real caller resolves from `x-dsh-session`; `agent` is omitted (undefined, never
  `null`) otherwise. (tests: `test/mcp-bridge-registry-and-agent.test.ts`)
- `mcpToolAllowlist` is enforced at EXECUTION time: a non-empty allowlist rejects
  any `/call` for a tool outside it with **403 `tool not allowed`**. (test: `test/v02.test.ts`)
- Internal-only tools `run_code`, `agy_ask`, `agy_tool` are excluded from BOTH
  `/tools` and `/call` via one `INTERNAL_TOOL_NAMES` set. (test: `test/v02.test.ts`)
- Distinct DSH names that normalize to the same MCP name are disambiguated with a
  stable `__<n>` suffix, never silently dropped; `bridge.mjs` calls back by exact
  `dshName`. (test: `test/v02.test.ts`)
- The bearer token is compared in constant time; request bodies are capped at
  **8 MiB** (`413`). (tests: `test/v02.test.ts`)
- `writeMcpConfig()` writes `mcp_config.json` (which embeds `DSH_MCP_TOKEN`) atomically
  with `0600` owner-only permissions and prunes stale `dsh-tools-<deadPort>` entries left
  behind by crashed processes; `syncMcpBridge()` serializes concurrent starts.

## One-shot `agy_ask` file inlining (`src/host/oneshot.ts`)

- `inlineFiles()` confines resolved real paths (`realpath`) to the effective workspace
  `cwd`, refusing arbitrary traversal (`../` or `/etc/...`) and sensitive credential files.

## Plugin HTTP routes (`src/transport/http/respond.ts` + `src/host/read-json-body.ts`)

- Every JSON body is read through `readJsonBody()`, capped at **1 MiB**; oversized
  bodies are discarded (`strict` callers get `__invalidJson`). (test: `test/http-body.test.ts`)

## `/agy doctor` report (`src/host/diagnostics.ts`)

- `redactLine()` masks: Google auth URLs, `4/` codes, `ya29.*`, `1//0…` refresh
  tokens, OIDC/JWT `id_token`, `AIza…`/`sk-…`/`GOCSPX-…` keys, credentialed proxy
  URLs, `Bearer`, and auth-carrying headers (`Authorization`/`Cookie`/`X-Api-Key`).
  (tests: `test/fix-review.test.ts`)
- The report is written owner-only: directory `0700`, file `0600`. (test: `test/doctor-perms.test.ts`)

## Image CLI (`dsh-agy-image`, `src/cli/image.ts` + `src/features/image/index.ts`)

- No HTTP surface: the image feature is a CLI only, so it adds no reachable
  plugin route.
- A result is `ok: true` only after the artifact passes the magic-byte sniff,
  dimension parsing, `imageMaxBytes` bound and (when requested) a 3% aspect-ratio
  check; a model reply alone can never claim success.
- `--out` is an explicit user path (the same privilege the user's own shell has);
  no output path is derived from model output.

## Media, Asset & Local-File Opener Routes (`src/host/media-route.ts`, `src/transport/http/routes/media.ts`)

- **Method & Cross-Origin Isolation on `/plugins/agy-link/open`**:
  - Must require **`POST`** (`405` on `GET`), so prompt-injected markdown images
    (`![x](/plugins/agy-link/open?path=...)`) can **never** trigger OS file/app execution.
  - Rejects cross-origin browser requests (`Origin` header present and not matching
    loopback `127.0.0.1` / `localhost` / `app://` / `file://`); never emits
    `Access-Control-Allow-Origin: *` on `/open` or `/media`.
- **Root Confinement**:
  - When `allowedRoots` (`workspaceRoots`) are configured on `/open` and `/media`,
    resolved real paths (`realpathSync`) must stay within the allowed workspace,
    staged `mediaDir`, or `agy` brain artifact directories; sensitive credential
    files (`.env`, `antigravity-oauth-token`, `primary-credential.json`, `.ssh`,
    `Keychains`) are unconditionally blocked (`403`).
- **Command-Injection-Free OS Launch (`executeOpenInSystem` & `openAccountTerminal`)**:
  - Windows PowerShell `Start-Process` passes the target path via an environment
    variable (`$env:AGY_OPEN_TARGET`), **never** interpolating user/model paths into
    double-quoted PowerShell strings where `$()` or `` ` `` execute arbitrary commands.
- **Media MIME Gate & Safe URI Decoding**:
  - `/plugins/agy-link/media` serves `image/*`, `video/*`, `audio/*`, and `.svg` only
    (with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`).
  - Malformed `file://` percent-escapes return `404` via `safeDecodeUri()`.
- **Client Toast XSS Safety (`src/client/images/lightbox.ts`)**:
  - `showToast()` writes dynamic filenames/error messages via `textContent`, never `innerHTML`.

## Stream parser (`src/host/parser.ts`)

- A single un-newline-terminated buffer is capped at `MAX_STREAM_LINE_BYTES` (8 MiB)
  and dropped as a `garbage` event, so a runaway stream cannot grow memory without
  bound. (test: `test/parser.test.ts`)

## Plan mode is read-only at the agy layer (issue #113)

- `effectivePermissionMode(configured, dshPlanMode, isAux)` forces `plan` (`--mode plan`)
  whenever `dshPlanMode && !isAux`, preventing `--dangerously-skip-permissions` from
  writing files during a read-only planning turn. (tests: `test/call-context.test.ts`, `test/adapter.test.ts`)

## agy protobuf step parser (`src/runtime/agy/db/extract.ts`, issue #116)

- `readVarint()` uses safe floating/integer arithmetic (`val += (byte & 0x7f) * 2 ** shift`)
  with `Number.isSafeInteger` and max-shift bounds (never 32-bit signed bitwise `<<`).
- Length-delimited walkers validate `len >= 0 && len <= remainingBytes`. (test: `test/agy-db-extract.test.ts`)
