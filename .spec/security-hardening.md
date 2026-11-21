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
  behind by crashed processes; `syncMcpBridge()` serializes concurrent starts;
  `registerBridgeMcpConfig()` de-duplicates `(bridge, file)` registrations idempotently
  and `teardownBridgeState()` runs/clears all registered restores once. (test: `test/http-contract.test.ts`)

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

## Plan mode & Goal state-machine parity with DSH (issues #113, #136)

- `effectivePermissionMode(configured, dshPlanMode, isAux)` forces `plan` (`--mode plan`)
  whenever `dshPlanMode && !isAux`, preventing `--dangerously-skip-permissions` from
  writing files during a read-only planning turn. (tests: `test/call-context.test.ts`, `test/adapter.test.ts`)
- **Authoritative current-turn signals**: `isPlanMode(messages, systemPrompt?, livePlanMode?)`
  checks `livePlanMode` (from `ctx.planMode` / `plan/change` / `plan/enter|exit`), trailing
  approved/rejected `exit_plan_mode` tool results, `options.system` (`plan:policy`), and only
  then the trailing `user`/`system` message — never historical tool output. (tests: `test/dsh-goal.test.ts`, `test/phase2-client.test.ts`)
- **Explicit Plan Continuation Classification**: `classifyPlanToolContinuation(messages)`
  only short-circuits (`'dismissed'`) when the user dismissed `exit_plan_mode`. On approval or
  keep-planning feedback (`'continue'`), `buildChatPromptText()` preserves `agytc-bridge-*`
  tool-result text even on bound conversations so `agy` executes or revises the plan cleanly.
  `buildPlanExitToolCallBlock()` ensures a leading `# ` heading and uses monotonic
  `agytc-bridge-plan-<seq>` IDs excluded from `parseMirrorCallId()`. (tests: `test/dsh-goal.test.ts`, `test/adapter.test.ts`)
- **`/agy goal` 1:1 DSH GoalService parity**: `handleGoal` delegates to `ctx.goals`
  (`GoalService`: `set`, `edit`, `pause`, `resume`, `complete`, `clear`) so `activation`
  (`armed`/`disarmed`), `goal/changed` effects, and `roundsStarted` stay exact, makes
  repeated transitions idempotent no-ops, and enforces DSH `goalProjectionDefinition`
  fold invariants (including across `edit` events in `resolveSessionGoal()`). (tests: `test/commands.test.ts`, `test/phase2-client.test.ts`)
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

## MCP bridge 的两个端点必须用同一个调用者作用域（issue #150）

`/tools` 与 `/call` 都代表「某个 DSH 会话里的 agy 子进程」行事，因此两者都必须解析 `X-DSH-Session` → agent：

- 只给 `/call` 解析、`/tools` 不解析，会让**注册在 preset 内的工具**（`present`、`todo_write`、`job_*`、`schedule_*`、`office_*`）在列表里完全消失，即使已加入 `mcpToolAllowlist`——调用能成功、列表却看不见，属于最难排查的一类不一致。
- 解析规则只有一处（`resolveSessionAgent()`）：先按原值查（裸子会话 key 不得改写），查不到且未带 `session-` 前缀时再试一次前缀形式。
- 锚点：`test/mcp-bridge-registry-and-agent.test.ts`（session 作用域列表、裸 key 重试、未知 session 回落 root）。

## `--mode auto`、`--sandbox` 与斜杠命令写入边界

- `PermissionMode` 新增 `'auto'`（`--mode auto`，仅高危动作由 `agy` 安全检查询问），保留 `'skip' | 'auto' | 'accept-edits' | 'plan'`，在 `/config` 与 `/agy mode` 均做白名单校验；`sandbox`（`--sandbox` / `DSH_AGY_SANDBOX`）为进程隔离提供 OS 级终端沙箱，保护 `~/.ssh` 与凭据目录。
- `/agy learn --apply`（`src/host/commands/slash-bridge.ts`）强制 `--json-schema` 约束 `kind: 'skill' | 'rule'` 与严格正则 `^[a-z0-9][a-z0-9-]{0,63}$`，并通过 `resolve(workspaceRoot, '.agents', ...)` 前缀校验阻止任何目录穿越写入工作区 `.agents/` 之外。（测试：`test/slash-bridge-and-image-tool.test.ts`）

## Generative UI 沙箱化 HTML 微件投递（`/plugins/agy-link/embed`, `src/host/embed-route.ts`）

- 仅允许 `.html` / `.htm` 正规文件，大小上限 **2 MiB**（超限返回 `413`），跨站 `Origin` 拦截与工作区/staging 根目录限制（`isCrossOriginBlocked` / `isConfinementAllowed`）与 `/media` 完全对齐。
- 响应强制 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff` 及严格 CSP（`default-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'unsafe-inline' https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js`）。
- 注入的 `postMessage` 桥接脚本对 `id` 参数做 `[a-zA-Z0-9_-]{1,64}` 清洗，前端渲染于 `<iframe sandbox="allow-scripts">` 且校验证 `ev.source === frame.contentWindow`。（测试：`test/http-contract.test.ts`, `test/extended-ui-and-embed.test.ts`）

## 多账号定制生态白名单同步（`src/features/ecosystem/sync.ts`, `inventory.ts`）

- 只按显式白名单从主账号 `~/.gemini/config` 同步 `plugins/`、`skills/`、`rules/`、`agents/` 与允许配置文件；**永不触碰**凭据、日志、对话或 Keychain。
- 显式拒绝敏感文件名（`.env*`、`antigravity-oauth-token*`、`.primary-credential.json`、`id_rsa`、`id_ed25519`、`*.pem`、`*.key`），并拒绝指向 `primaryHome` 之外的符号链接。
- `mergeMcpConfig()` 同步主账号其余 MCP 服务器时**严格保留目标账号自身的 `dsh-tools` 反向桥接配置**；`EcosystemService.setPluginEnabled()` 校验 `pluginId` 拒绝路径穿越；`inspectEcosystem()` 对 HTTP MCP URL 中的用户名/密码做脱敏。（测试：`test/ecosystem.test.ts`）
