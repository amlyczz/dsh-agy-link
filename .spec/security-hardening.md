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

## Plan mode is read-only at the agy layer (issues #113, #136)

- `effectivePermissionMode(configured, dshPlanMode, isAux)` forces `plan` (`--mode plan`)
  whenever `dshPlanMode && !isAux`, preventing `--dangerously-skip-permissions` from
  writing files during a read-only planning turn. (tests: `test/call-context.test.ts`, `test/adapter.test.ts`)
- **Plan mode is a CURRENT-TURN fact, never history.** `isPlanMode(messages)` may only
  read the last message, and only when its role is `user`/`system`; scanning history
  matched tool output and previously-finished planning turns that merely mention the
  phrase, which forced `--mode plan` on ordinary turns (with `permissionMode: skip`
  every tool was denied and the turn broke — issue #136).
- **The presence of `exit_plan_mode` in `options.tools` is NOT evidence of plan mode**:
  current DSH ships that tool in standard mode too. It only gates the synthetic-exit
  path, never the permission downgrade on its own.
- **A rejected exit_plan_mode is decisive**: if the trailing message contains
  `exit_plan_mode is only available in plan mode`, the session is not planning — this
  is the self-correction that stops a false positive from locking a session forever.

## agy protobuf step parser (`src/runtime/agy/db/extract.ts`, issue #116)

- `readVarint()` uses safe floating/integer arithmetic (`val += (byte & 0x7f) * 2 ** shift`)
  with `Number.isSafeInteger` and max-shift bounds (never 32-bit signed bitwise `<<`).
- Length-delimited walkers validate `len >= 0 && len <= remainingBytes`. (test: `test/agy-db-extract.test.ts`)

## 系统打开器不得终止宿主（`src/host/media-route.ts`, issue #129）

`POST /plugins/agy-link/open` 只是便利功能，**任何失败都不得杀死 DSH 进程**。

- `spawn()` 对缺失（ENOENT）/不可执行（EACCES）是**异步** `error` 事件上报，外层 `try/catch` 抓不到；没有监听就会变成 `uncaughtException`，宿主退出（headless Linux 无 `xdg-open` 时每点一次「打开」就崩一次）。
- 所有平台分支统一走 `spawnDetachedOpener()`：在第一个 tick 之前挂上 `error` 监听再 `unref()`；同步抛错返回 `false`。
- 已知取舍：异步启动失败在 headless 主机上表现为**静默无操作**（路由没有 logger 可回报）。若要给用户明确提示，需先让路由拿到 logger；届时补测试。
- 测试：`test/media-route.test.ts` 注入假 `spawn`（emit ENOENT 不外泄、同步 throw 返回 false）。

## 工作区白名单必须真的读到会话 cwd（issue #139）

`/open` 与 `/media` 的路径白名单来自 `collectWorkspaceRoots()`，其中「活跃会话 cwd」这一项由 `activeCwds()` 提供。

- DSH 的 session store 暴露 `list()` / `get(id)`，**没有 `values()`**。用 `typeof svc?.values === 'function'` 守卫一个不存在的 API，会让白名单永远为空——会话工作区内的文件全部 403（"path outside allowed workspace roots"）。
- 现在 `activeCwds()` 优先 `list()`，回退 `values()`（兼容只提供后者的宿主），按出现顺序去重 cwd；服务缺失或抛错时降级为空数组，绝不抛给请求路径。
- 新增会话服务方法时必须同步 `SessionsServiceLike` 的类型声明，不要用内联 `as { … }` 强转——类型检查是唯一能发现「调用了不存在的 API」的防线。
- 锚点：`test/services.test.ts`（`list()` 路径、`values()` 回退、抛错降级）。

## MCP bridge 启动命令在 Electron 宿主下必须是 Node 模式（issue #140）

`writeMcpConfig()` 生成的 `mcpServers` 条目用 `process.execPath` 作为 `command`。桌面构建里那是 **Electron 二进制**：Antigravity 每次拉起 stdio bridge 都会新开一个 Electron 实例（窗口），把焦点从 Antigravity 抢回 DSH。

- `mcpServerEntry(bridge, execPath, isElectron)` 是唯一条目构造点；`isElectron` 取自 `process.versions.electron !== undefined`。
- Electron 宿主注入 `ELECTRON_RUN_AS_NODE=1`（同一二进制以纯 Node 运行，不建窗口）；普通 Node 宿主不加该变量（`node` 会忽略它，但少一个无意义的环境项更干净）。
- 既有契约不变：`DSH_MCP_URL` / `DSH_MCP_TOKEN` / `DSH_MCP_PID` 仍在 `env` 里，`type: 'stdio'` 与 `args: [bridgeScript]` 不变。
- 锚点：`test/issue140-mcp-electron-env.test.ts`（Electron / 普通 Node 两种宿主）。
