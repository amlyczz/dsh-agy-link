# Changelog

## Unreleased

### English

- **Feat(mcpBridge): audit-log every bridged call.** Each `/call` now logs `mcp call <tool> [<outcome>] <ms>` through the plugin logger (journald), with the caller class (agent/none) and the failure message. Arguments are never logged. Previously the bridge logged only listener start/close, so a failed bridged run could only be reconstructed from transcripts.
- **Docs(mcpBridge): DSH `send_message` can be bridged.** Documented that the tool is not restricted (only `run_code` / `agy_ask` are), so adding it to `mcpToolAllowlist` exposes it on the `dsh-tools-<port>` MCP server; also documented why the DSH sub-agent footer's `send_message` call hits agy's native tool instead and fails with `recipient "..." not found`.

### 中文

- **新增(mcpBridge)：每次桥接调用记审计日志。** 每次 `/call` 通过插件日志（journald）输出 `mcp call <工具> [<结果>] <毫秒>`，含调用方类别（agent/none）与失败信息，**不记录参数**。此前只在监听启动/关闭时打日志，失败的桥接调用只能靠会话 transcript 反推。
- **文档(mcpBridge)：DSH 的 `send_message` 可被桥接。** 说明该工具不受限制（仅 `run_code` / `agy_ask` 被排除），把它加进 `mcpToolAllowlist` 即可在 `dsh-tools-<port>` 这个 MCP server 上暴露；同时记录了为什么 DSH sub-agent footer 里的 `send_message` 会命中 agy 原生工具并报 `recipient "..." not found`。
- **Fix(client): eliminate the recurring "open Antigravity console → scrolling flashes" by isolating the modal overlay (root cause, not another single-scanner patch).**
  - Root cause (a class, not a point): the console is a full-viewport overlay that neither froze the page behind it nor suspended the plugin's own global DOM scanners, and the backdrop carried a full-viewport `backdrop-filter: blur()`. Any motion/repaint behind the fixed overlay (wheel/inertia scrolling of the conversation, the modal's 3s status polling, scanner injection) was therefore re-sampled through the GPU filter and re-laid-out every frame → visible flashing. Every prior fix patched one publisher (scroll-guard, decision-chip idempotence, busy scoping, host claim) while leaving the overlay non-isolating.
  - Removed the full-viewport backdrop blur (stable `rgba` dim instead) — the single biggest flash source.
  - Added an explicit overlay-isolation contract: `agyModalStore.setOpen()` now toggles `agy-modal-open` on `<html>`, which locks `[data-conversation-scroll]` (`overflow:hidden`, `scrollbar-gutter:stable` keeps the width stable) so nothing moves behind the fixed overlay; `overscroll-behavior:contain` stops wheel/momentum chaining.
  - Added `setOverlaySuspended()/isInteractionLocked()` to the scroll guard and routed decisions/images/reasoning/mermaid scanners through it, so no DOM is injected into the conversation while the console is open (a resume pass catches up afterwards). Cleanup removes the lock class on plugin teardown.
  - Guarded against recurrence: new regression tests assert the backdrop never regains a full-viewport `backdrop-filter`, that the scroller is locked while the overlay is open, and that all four scanners gate on `isInteractionLocked()`.

### 中文

- **修复（client）：彻底消除「打开 Antigravity 控制台后滚动闪屏」——解决根因，而非再一次单点补丁。**
  - 根因（是一类问题，不是单点）：控制台是全屏浮层，但它既没有冻结背后的页面，也没有暂停插件自身的全局 DOM 扫描器，且遮罩带了全屏 `backdrop-filter: blur()`。于是浮层背后的一切移动/重绘（会话的滚轮/惯性滚动、控制台每 3s 的状态轮询、扫描器注入）都会每帧被 GPU 滤镜重新采样并重新布局 → 表现为闪屏。历次修复都只堵住一个"发布者"（scroll-guard、decision-chip 幂等、busy 作用域、宿主同步 claim），浮层始终没有被隔离。
  - 移除全屏遮罩模糊（改用稳定的 `rgba` 半透明遮罩），这是最大的闪屏来源。
  - 建立显式的"浮层隔离契约"：`agyModalStore.setOpen()` 现在会在 `<html>` 上切换 `agy-modal-open`，从而锁定 `[data-conversation-scroll]`（`overflow:hidden`，宿主自带 `scrollbar-gutter:stable` 避免宽度跳动），让浮层背后完全静止；`overscroll-behavior:contain` 阻止滚轮/惯性链式滚动。
  - scroll guard 新增 `setOverlaySuspended()/isInteractionLocked()`，decisions/images/reasoning/mermaid 四个扫描器统一改用它：控制台打开时不向会话注入任何 DOM（关闭后补扫一次）。插件卸载时清理锁类。
  - 防复发护栏：新增回归测试锁定契约（全屏遮罩不得再出现 `backdrop-filter`、浮层打开时滚动容器必须被锁定、四个扫描器必须走 `isInteractionLocked()`）。

## 0.4.73 (2026-10-27)

### English

- **Fix(digest): preserve chronological order in conversation digest and prevent latest task misplacement.**
  - `buildDigest()` previously placed the latest user task at the top of the digest array before appending older history (`kept.push(taskLine)` followed by `kept.push(...keptOther)`), completely inverting the digest timeline. Agy received the newest request at the beginning of the context and the previous turn's request/response at the bottom, leading the model to treat the previous turn as the freshest instruction and ignore the new request.
  - Corrected assembly order so historical messages precede the latest task (`[...keptOther, taskPart]`) while preserving priority budget reservation for the latest task.
- **Fix(sessions): prevent false-positive compaction detection from dropping healthy conversation bindings.**
  - `adapter.ts` previously invalidated the session binding whenever `messages.length < binding.lastMessageCount`. Minor fluctuations in message counts (e.g. 1-2 messages dropped by telemetry filtering or message store pruning after reconnection) falsely triggered compaction detection, deleting the valid agy session binding and forcing an unnecessary full-context digest re-seed.
  - Introduced threshold-based compaction detection: true compaction requires substantial history reduction (e.g. drop by >20% or down to <=4 messages), while minor fluctuations only adjust the message watermark without invalidating the agy conversation.

### 中文

- **修复（digest）：修复会话摘要时间线逆序导致的“最新任务被历史覆盖/失忆”缺陷。**
  - 此前 `buildDigest()` 为给最新用户任务预留空间，先将任务推入数组首位，再追加其余历史记录（`kept.push(taskLine)` 后跟 `kept.push(...keptOther)`），导致摘要内部时间线颠倒：最新任务被排在最开头，而上一轮的指令与回复出现在历史摘要最末尾。agy 接收后将末尾上一轮历史误判为最新要求，进而忽略了用户的最新输入。
  - 修正组装顺序，保证早期历史在前、最新任务在后（`[...keptOther, taskPart]`），同时保留优先为最新任务分配字符配额的设计。
- **修复（sessions）：消除 Compaction 压缩检测假阳性，防止健康会话绑定被误删。**
  - 此前一旦 `messages.length < binding.lastMessageCount` 即判定为历史压缩并清空绑定。当会话闲置重新激活时，遥测过滤或消息存储微调导致的消息数微小减少（如减少 1~2 条）会误触发该逻辑，彻底删除原有的 agy 会话绑定并退化为全量摘要重放。
  - 引入梯度阈值判定：仅在历史大幅度缩减（如减少超 20% 或缩减至 4 条以下）时才判定为 Context Compaction，微小消息变动仅校准水位标尺，避免误断开底层长会话。

## 0.4.72 (2026-10-27)

### English

- **Fix(mcpBridge): publish MCP config to the agy 1.4+ registry and carry caller identity (Issue #55, PR #56).**
  - `writeMcpConfig()` previously wrote `<workspace>/.mcp.json`, but `agy` 1.4+ loads MCP servers exclusively from `~/.gemini/config/mcp_config.json` (and per-account `.gemini` sandboxes), causing bridged tool calls to fail with `No MCP servers configured`.
  - Added multi-target publishing supporting the global registry, isolated account homes, and workspace scopes (`mcpConfigScope: 'global' | 'workspace' | 'both'`, plus `mcpConfigPath` override).
  - Port-keyed entries (`dsh-tools-<port>`) prevent collisions between multiple DSH hosts sharing the registry, with clean atomic LIFO restoration on disposal.
  - Exported `DSH_MCP_SESSION` to the agy child process and forwarded it as `X-DSH-Session` to resolve the calling agent, fixing `agent_teams tools require a calling agent (exec.agent was undefined)`.
- **Fix(credential-slot): eliminate line-barging and concurrent holder race condition in `AsyncMutex`.**
  - Identified and resolved a critical race condition where releasing the mutex dropped `holders` to 0 before the scheduled microtask ran, allowing synchronous callers to barge ahead and grant multiple concurrent holders simultaneously.
  - Implemented direct ownership handoff without dropping holder count when waiters are queued, guaranteeing strict mutual exclusion and FIFO queueing under high concurrency.
- **Fix(client): eliminate session console first-open flicker.**
  - Session status badge now claims primary modal host synchronously on mount, preventing asynchronous portal remount flicker.
  - Status polling now gracefully relaxes to a 15s interval when idle to keep the cache warm, with complete timer cleanup upon client context disposal.
- **Fix(mermaid): prevent Dagre 0x0 / 16x16 collapsed SVG artifacts.**
  - Render Mermaid diagrams without an unattached mount container so viewport metrics measure accurately, and detect/heal empty or collapsed SVGs.
- **Fix(keychain): provision isolated macOS Keychain on account creation.**
  - Automatically provisions isolated login keychains when adding account slots or committing staging accounts on macOS, avoiding SecurityAgent system prompts.

### 中文

- **修复（mcpBridge）：发布 MCP 配置至 agy 1.4+ 实际读取的注册表并携带调用者身份（Issue #55，PR #56）。**
  - 此前 `writeMcpConfig()` 仅写入工作区 `.mcp.json`，而 `agy` 1.4+ 仅从 `~/.gemini/config/mcp_config.json`（及子账号 `.gemini` 沙箱）加载 MCP 服务，导致会话提示 `No MCP servers configured`。
  - 支持多目标发布（全局注册表、多账号隔离主目录及工作区范围，提供 `mcpConfigScope: 'global' | 'workspace' | 'both'` 及 `mcpConfigPath` 覆盖配置）。
  - 每个桥接实例按端口隔离服务键名（`dsh-tools-<port>`），防止多实例覆盖，并在退出时原子化恢复原有内容。
  - 会话生成时将 `DSH_MCP_SESSION` 注入子进程环境，经由桥接脚本转发为 `X-DSH-Session` 请求头，在宿主端通过 `agents` 服务解析调用者身份，彻底解决 `agent_teams tools require a calling agent (exec.agent was undefined)`。
- **修复（credential-slot）：消除 `AsyncMutex` 的插队竞争与并发持有者缺陷。**
  - 对抗性审计发现：旧实现中 `releaseOne()` 先将 `holders` 归零后通过 `queueMicrotask` 唤醒等待者，在此微任务微小窗口内同步调用的 `acquire()` 会发生插队并导致两个调用者同时进入临界区。
  - 改造为排队时直接所有权移交机制（Direct Handoff），保证严格互斥与 FIFO 先入先出顺序，消除测试套件偶发的 flake。
- **修复（client）：消除控制台首次打开时的宿主交接闪烁。**
  - 会话状态角标在挂载时同步声明主宿主身份，消除异步交接导致的状态闪烁与 Portal 重新渲染。
  - 状态轮询在无激活视窗时平滑降频至 15 秒保活缓存，并在客户端插件卸载时完整清理定时器。
- **修复（mermaid）：修复离屏/虚拟容器中 Dagre 测绘产生的 16x16 / 0x0 折叠 SVG。**
  - 避免将尚未有几何尺寸的容器传递给 Mermaid 渲染，结合 `isInvalidOrCollapsedSvg` 智能识别并修复空图或折叠伪影。
- **修复（keychain）：在 macOS 账号槽位创建与提交时即时初始化独立 Keychain。**
  - 避免 macOS SecurityAgent 在后续刷新凭据或打开终端时弹出系统钥匙串确认弹窗。

## 0.4.71 (2026-10-27)

### English

- **Fix: restore Argon quota reporting for isolated Pro-tier accounts (PR #54 regression).**
  - PR #54 established that retrieveUserQuotaSummary with the agy User-Agent returns the separate Gemini 4 Argon quota group for accounts on paid Pro/Ultra plans.
  - Removed premature clearQuotaFamily(account.id, 'argon') in readCliUsageFamilies fast-reject branches, allowing isolated accounts to receive authentic Argon quota from Google's REST API.
  - Stale/orphaned Argon entries on free-tier accounts are now cleared cleanly when an authoritative summary (CLI or REST) succeeds without an Argon quota group.
- **Feat(quota): organic randomized jitter on sequential multi-account polling.**
  - Replaced the fixed 2000ms sleep between account checks with an organic 2000ms~3500ms randomized jitter delay (staggerJitterMs), avoiding rigid clock-tick request signatures against upstream endpoints.
- **Fix: every pool row displayed the same account's quota (2026-10-26 report).**
  - Root cause: agy resolves its credential from the platform keystore (Windows Credential Manager, macOS Keychain, Linux Secret Service) BEFORE the per-HOME token file, and that store is a single per-user entry. Handing an isolated HOME to agy -p /usage therefore does not isolate the identity — the CLI always answers for the store's owner, so CLI-first polling filed the owner's numbers under every secondary row (all four rows showed 97% / 55% / 56% with identical reset instants).
  - The CLI is now scoped to the account that can actually own that store, and everything else takes the REST path, which signs with each account's own token file and runs concurrently on every platform.
  - Isolated accounts are rejected BEFORE any keystore read, so a poll no longer pays a PowerShell cold start per account; the owner itself is still proven by sameCredentialGrant, because a running secondary temporarily holds the slot and a CLI read would then return that secondary's numbers.

### 中文

- **修复：恢复子账号（如 Pro 订阅账号）的 Argon 额度显示（PR #54 回归）。**
  - PR #54 证明了发送 agy User-Agent 时，Google REST API retrieveUserQuotaSummary 会正常返回 Pro/Ultra 账号独立的 Gemini 4 Argon 额度组。
  - 移除了 readCliUsageFamilies 快速拒绝分支中对 argon 的误清理，子账号回落走 REST 时可完整展示其真实的 Argon 额度。
  - 免费账号或降级账号上残留的伪 Argon 额度，现在由权威汇总（CLI 或 REST 成功返回且不含 Argon 组）统一精准清理。
- **功能（quota）：多账号顺序轮询增加有机随机抖动。**
  - 账号间的固定 2000ms 错峰间隔升级为 2000ms~3500ms 随机抖动（staggerJitterMs），避免向 Google Cloud Code 发送过于机械刻板的定频网络请求。
- **修复：号池每一行都显示了同一个账号的额度（2026-10-26 反馈）。**
  - 根因：agy 解析凭据时**优先读系统钥匙串**（Windows 凭据管理器 / macOS Keychain / Linux Secret Service），且该存储是「每个 OS 用户只有一条」。因此给 agy -p /usage 一个隔离 HOME 并不能隔离身份——CLI 永远回答存储主人的额度，CLI 优先轮询就把主人的数字写进了每个子账号行（四行全部 97% / 55% / 56%，重置时刻完全相同）。
  - 现在 CLI 只用于「真正能拥有该存储」的那个账号，其余账号全部走 REST —— 用各自的 token 文件签名，全平台并发执行。
  - 隔离账号在**读取钥匙串之前**就被快速拒绝，轮询不再为每个账号付一次 PowerShell 冷启动；持有者本身仍要过 sameCredentialGrant 校验，因为子账号运行期间会临时占用该槽，此时 CLI 会返回子账号的数字。

## 0.4.70 (2026-10-25)

### English

- **Fix: the 5-hour quota row showed the weekly numbers (2026-10-22 report).**
  - `fetchAvailableModels` returns a per-model `quotaInfo` with NO window label. For some accounts it carries the 5-hour bucket, for others the WEEKLY bucket: live `daoxzeex@gmail.com` reported `0.1736 / reset 2026-10-24T18:19:18Z` on every Gemini model, which is exactly the weekly bucket of `retrieveUserQuotaSummary`.
  - The merge took "the lowest remaining across all sources" and filed it into the family 5-hour slot, so the GUI painted `5-hour quota 19% / Weekly 19%` with the SAME weekly reset on both rows (the filed screenshot) while the account actually had 82% of its 5-hour quota left.
  - The reset instant now decides the window (`sameQuotaWindow`, 5-minute tolerance): a reading that matches the summary weekly reset tightens ONLY the weekly row; one that matches the 5-hour reset tightens the 5-hour row; an unmatchable reading keeps the old conservative behaviour. Eligibility is unchanged — the weekly row still drives the 5% drain check.
- **Fix: a queued turn no longer looks frozen for 15 minutes.**
  - Windows has ONE machine-global agy credential slot, so sessions serialize: a healthy long run in one workspace made two other sessions sit with a completely empty transcript for `dispatchTimeoutMinutes` (15m) and then silently re-queue for another cap — indistinguishable from a hang (2026-10-22: the promo-tcn sessions, while a 15-minute run in another project held the slot).
  - The wait now streams a session-visible `[agy] waiting for the agy credential slot …` line into the transcript, with an escalating cadence (20s → 60s → 3m → 9m) so even a 15-minute queue leaves a handful of lines. Re-queues after a cap are announced too.
  - A generator abandoned while waiting (Stop / stream closed) now hands a late grant back instead of leaking a concurrency slot.
- **Fix: the machine-wide credential slot is held only until agy has READ it — different accounts now run concurrently.**
  - Measured on agy 1.4.3 with a live 14-minute run: print mode resolves its credential ONCE at startup (`printmode.go:403 "not authenticated, trying silent auth"` → `:405 "silent auth succeeded"` at +3.2s) and performs zero further token/auth work for the rest of the run. Holding the Windows slot for the whole run was pure serialization, and it is what parked the 2026-10-22 promo-tcn sessions for 15 minutes behind another project's run.
  - `armSlotHandoff` releases the lease on the child's FIRST output line (45s ceiling for a slow startup, run-end fallback, idempotent), while the identity is still installed under the mutex immediately before each spawn — so a later switcher cannot change what an already-started run read.
  - `JETSKI_OAUTH_TOKEN` (the only env-based credential route in the binary) was probed with a bogus token: the run still authenticated from the keyring, so true per-process injection remains unavailable upstream. Recorded in KNOWN-GAPS with the measurement.
- **Fix: a rejected credential-slot write now refuses the run instead of billing the account that happens to be installed.**
  - The Windows write is a PowerShell cold start that compiles a C# P/Invoke shim; its old 8-second ceiling made it time out and return `false` **without touching the slot** on a loaded machine (reproduced 2026-10-23: delete then write reported false and left the slot empty). All four install sites ignored that boolean, so the next spawn authenticated as the PREVIOUS account — silent cross-account quota spend, the exact corruption class the module exists to prevent.
  - Install sites now verify the write (one retry, then `SlotUnavailableError` → the turn fails visibly); teardown/restore paths log loudly instead of failing a finished turn. Writes get a 30s ceiling; reads stay at 8s because they sit on the poll path.
  - New test: a write that always reports false refuses the run, leaves the slot untouched and does not leak the mutex.

### 中文

- **修复：5 小时额度行显示成了周额度（2026-10-22 反馈）。**
  - `fetchAvailableModels` 的 per-model `quotaInfo` 不带窗口标签：有的账号返回 5 小时桶，有的账号返回**周**桶（实测 `daoxzeex@gmail.com` 每个 Gemini 模型都返回 `0.1736 / reset 2026-10-24T18:19:18Z`，正是 `retrieveUserQuotaSummary` 里的周桶）。
  - 旧合并逻辑「取所有来源里最低的余量」把它塞进了 5 小时行，界面于是显示 `5 小时额度 19% · 周额度 19%`、两行 reset 完全相同（反馈截图），而该账号 5 小时其实还剩 82%。
  - 现在由 reset 时刻判定窗口归属（`sameQuotaWindow`，5 分钟容差）：命中周 reset 的读数只收紧周行；命中 5 小时 reset 的收紧 5 小时行；无法判定的读数保持原有保守行为。可用性判定不变——周行依旧参与 5% 耗尽检查。
- **修复：排队中的回合不再看起来卡死 15 分钟。**
  - Windows 只有一个全局 agy 凭据槽，会话之间必须串行：另一个工作区一次正常的长任务就能让其它会话的转录区**整整 15 分钟一片空白**（`dispatchTimeoutMinutes`），随后再静默重排一轮——和卡死无法区分（2026-10-22 的 promo-tcn 两个会话就是被另一个项目 15 分钟的运行挡住）。
  - 等待期间现在会向会话流里写入可见的 `[agy] 正在等待 agy 凭据槽 …` 提示，节奏递增（20s → 60s → 3m → 9m），15 分钟排队也只留几行；超时重排同样会写明。
  - 等待中被 Stop / 关流放弃的请求，现在会把迟到的许可归还，而不是漏掉一个并发槽。
- **修复：全局凭据槽只占用到 agy 读完凭据为止——不同账号现在可以真正并发。**
  - 实测 agy 1.4.3 一次 14 分钟的运行：print 模式只在启动瞬间解析一次凭据（`printmode.go:403` 未认证 → `:405` silent auth 成功，+3.2 秒），之后 14 分钟**再无任何 token/auth 操作**。把 Windows 全局槽占满整个 run 纯属多余串行——2026-10-22 的 promo-tcn 两个会话正是被另一个项目那 14 分钟的运行堵了 15 分钟。
  - 新增 `armSlotHandoff`：在子进程输出**第一行**时立刻交还租约（启动慢则 45 秒上限、run 结束兜底、幂等），而身份安装依旧在每次 spawn 前、在互斥锁内完成，因此后来的切换不可能改变已启动 run 读到的凭据。
  - 二进制里唯一的进程级凭据入口 `JETSKI_OAUTH_TOKEN` 已用假 token 实测：仍然从系统 keyring 认证成功，说明上游还不支持真正的进程级注入；该结论连同测法已写入 KNOWN-GAPS。
  - 补充实测：**把全局凭据条目删掉后，agy 确实会改读家目录凭据文件**（假 token → `UNAUTHENTICATED 401`）。但 keyring 在写入侧同样优先（`Failed to save token to keyring, falling back to file`），任何一次成功运行都会把全局条目写回来，所以"永久空槽 + 纯文件隔离"仍不成立；凭据隔离目前只是读取侧能力。
- **修复：凭据槽写入被拒绝时，拒绝启动，而不是用"当前碰巧装着"的账号去计费。**
  - Windows 侧写入是一次 PowerShell 冷启动（Add-Type 编译 C# P/Invoke），旧实现的 8 秒上限在机器繁忙时会**超时并返回 false，而槽位根本没被改动**（2026-10-23 实测：删除后再写入返回 false，槽位保持空）。四个安装点都没检查这个布尔值，于是紧接着的 spawn 会以**上一个账号**的身份认证 —— 静默跨账号扣额度，正是本模块要防的那类污染。
  - 现在安装点会校验写入（失败重试一次，仍失败则抛 `SlotUnavailableError`，让这一轮可见地失败）；收尾/恢复路径改为大声告警而不毁掉已完成的轮次。写入超时提到 30 秒，读取保持 8 秒（在轮询路径上）。
  - 新增测试：写入恒返回 false 时必须拒绝运行、槽位保持原状、互斥锁不泄漏。

## 0.4.69 (2026-10-23)

### English

- **Feat: Google risk-control hardening and CLI-first quota architecture.**
  - Implemented CLI-first quota detection via official `agy -p /usage`: 100% genuine Go TLS fingerprint and client handshake, eliminating Node.js-level direct REST calls (`v1internal:retrieveUserQuotaSummary`) that trigger JA3/JA4 fingerprint mismatch warnings.
  - Purged internal test endpoints (`daily-cloudcode-pa.sandbox.googleapis.com` and `autopush-cloudcode-pa.sandbox.googleapis.com`) from `AGY_ENDPOINTS` to prevent sandbox probe alarms on consumer accounts.
  - Token refresh is fully delegated to the native `agy` CLI Go runtime; Node.js host process no longer issues direct refresh requests to `oauth2.googleapis.com/token`.
  - Background quota polling interval widened from 15m to 60m (`quotaPollIntervalMs: 60m`), and account polling incorporates a 2-second stagger sleep to avoid simultaneous process bursts.
- **Feat: Full concurrency on Windows credential slot via global primary account alignment (Scheme A).**
  - Resolved Windows single-slot mutex serialization: concurrent sessions align to the current primary healthy candidate, hitting the `parallelSameAccount: true` fast path for 100% lock-free concurrency across sessions.
  - Single-direction migration to the next candidate only occurs when the active account encounters a 429 quota exhaustion.
- **Feat: Two-tier dual-loop test framework aligned with academic-agent & test suite speedup.**
  - Introduced `pnpm run test:fast` (powered by `scripts/fast-test.mjs`) for inner TDD vibe loops (0.5s~5s), running only Git-affected test files or specified module keywords (`pnpm run test:fast <keyword>`).
  - Tuned simulated asynchronous delay timers in `test/adapter.test.ts` and `fake-agy.mjs` from 5000ms/8000ms down to 300ms/400ms, speeding up adapter unit test execution by ~4x.
- **Feat: Scroll guard & tool view expansion state persistence.**
  - Added `scroll-guard.ts` to suspend DOM mutations and heavy scans (decisions, images, reasoning, mermaid) during active scrolling and smooth momentum settling.
  - Preserved user expanded/collapsed tool card states across TanStack Virtualizer dynamic remount cycles.

### 中文

- **新功能：针对 Google 敏感风控强化防护与 CLI 优先配额体系。**
  - 配额查询全面转向官方 `agy -p /usage` 解析：100% 走官方原生 Go 二进制握手与正规 TLS 指纹，消除 Node.js 层使用 `undici` 直接裸调 Google 内部 `v1internal` 接口带来的 JA3/JA4 客户端指纹断层风险。
  - 从 `AGY_ENDPOINTS` 中彻底移除 `daily-cloudcode-pa.sandbox.googleapis.com` 与 `autopush-cloudcode-pa.sandbox.googleapis.com` 内部测试端点，杜绝异常沙箱端点探测对正式 Google 账号的风控隐患。
  - OAuth 令牌刷新完全交由 `agy` 官方 Go 运行时在日常使用中原生完成，Node.js 宿主停止主动向 `oauth2.googleapis.com/token` 发送换票请求。
  - 默认后台巡检周期放宽至 60 分钟（`quotaPollIntervalMs: 60m`），多账号后台轮询增加 2 秒错峰休眠，避免瞬时并发拉起 CLI 进程造成的系统负载颠簸。
- **新功能：Windows 凭证槽位并发性能全面解锁（方案 A：全局主导账号收敛）。**
  - 解决 Windows 系统下因全局唯一定制凭证槽位 `gemini:antigravity` 导致的跨 Session 串行卡顿问题：所有会话默认对齐到号池主导活跃健康账号，命中 `parallelSameAccount: true` 快速通道，实现跨会话 100% 无锁全并发执行。仅当主导账号 429 配额耗尽时，全局指针单向整体迁移至下一账号。
- **新功能：对齐 academic-agent 的两级双环极速测试架构与用例调优。**
  - 新增 `pnpm run test:fast` 极速内环测试工具（`scripts/fast-test.mjs`），实现基于 Git 变动的秒级精准回归（0.5s~5s）以及按模块关键字直跑（`pnpm run test:fast <keyword>`）。
  - 优化 `adapter.test.ts` 与 `fake-agy.mjs` 中的异步等待延迟（由 5000ms/8000ms 降至 300ms/400ms），单测执行速度提升近 4 倍，保障日常开发极速反馈心流。
- **新功能：页面平滑滚动守卫与工具卡片展开状态持久化。**
  - 增加 `scroll-guard.ts` 滚动守卫机制，在用户主动滚屏及平滑滑动期间挂起 DOM 探测（decisions/images/reasoning/mermaid），彻底杜绝滚屏时内容突变抖动与闪烁。
  - 工具卡片折叠/展开状态跨 TanStack-Virtual 虚拟列表重新挂载自动持久化保留（`expandedToolBlockKeys`）。

## 0.4.68 (2026-10-23)

### English

- **Feat: Dynamic model picker reflects active account eligibility (Gemini 4 Argon isolation).**
  - Accounts in the pool now discover and cache models independently (`ModelCatalog` keyed by `accountId`).
  - When switching the active account in the UI or pool, the DSH composer model picker automatically refreshes (`llm/adapters-updated`).
  - If the active account lacks Argon access (free/standard tier), `gemini-4-argon` is dynamically excluded from the picker to prevent generation errors. When an account with Pro/Ultra subscription is active, Argon models are immediately restored.
- **Fix: Eliminate page scrolling and violent screen flickering in Antigravity client.**
  - Root cause: In `src/client/decisions.ts`, decision chip toolbar was repeatedly injected into TanStack-Virtual dynamic measurement containers because container-level marker `data-agy-decisions-scanned` was checked but never set, and re-rendering reconstructed heading nodes. The item height expansion triggered scroll position adjustments, which caused a re-render and re-injection flywheel.
  - In addition, settings nav row `MutationObserver` watched the entire subtree including `characterData` and re-triggered on its own marker writes without an attribute filter, and account button busy states repainted the entire account list instead of scoping to the target account.
  - Resolved with container-level idempotence guards (`data-agy-decisions-scanned` written before mutation), pre-checking existing toolbar containers, filtering nav mutation observer strictly to marker attribute changes, and scoping button busy states and shimmer animations to target accounts.
- **Fix: Send agy CLI User-Agent in quota requests so Argon quota group is returned (PR #54, Fixes #53).**
  - Google's Cloud Code backend requires a genuine `agy` CLI User-Agent header (format `Antigravity/<version> (darwin; arm64)`) to return the `Gemini 4 Argon` quota bucket in `retrieveUserQuotaSummary`. Without this header, only generic Gemini and 3P groups were returned.
  - Quota service now detects the installed `agy` CLI version and passes the proper User-Agent header in HTTP requests. When an account transitions or drops dedicated groups, obsolete cooldowns and stale last-known-good entries are cleanly evicted.
- **Fix: DSH Host 100% CPU busy loop on macOS caused by copying active SQLite WAL files (Fixes #52).**
  - Root cause: `loadAgyDbData()` previously copied `conversation.db`, `-wal`, and `-shm` to a temporary directory before querying tool step parameters and model thoughts. On macOS (and other BSD-derived libuv platforms), when an active SQLite WAL file is checkpointed or truncated to 0 during `copyFile`, libuv's `uv_fs_copyfile` enters an infinite busy loop in a worker thread, causing the Host process to permanently consume 100% of a CPU core.
  - Solution: Replaced file copying with direct SQLite reads (`node:sqlite` DatabaseSync with `readOnly: true`, falling back to `sqlite3` CLI with `-cmd ".timeout 2000" -cmd "PRAGMA query_only = ON;"`). SQLite's native WAL architecture provides atomic, consistent MVCC read snapshots concurrently with active writers without blocking or file-copying races.
  - Added regression test covering active WAL querying, WAL truncation/checkpointing during active use, sqlite3 CLI fallback, and zero-byte database handling.
- **Fix: Transport failures outlast a real egress outage, and no longer rotate a shared-egress pool.**
  - Live case (2026-10-21 16:34–16:48): the machine's proxy answered `CONNECT 200` and then killed TLS for ~14 minutes. Every `agy` run on every account died in its startup probe with `Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF`, which agy wraps as `Eligibility check failed: …`. DSH retried twice inside ~4 seconds and gave up — while the Antigravity desktop's own language server simply kept retrying and recovered.
  - Transport (`NETWORK`) failures now state their own backoff via `providerRetryAfterMs`: **5s → 15s → 30s** for consecutive failures in one session, reset on success or any non-transport failure, and treated as fresh after 10 minutes of quiet. `providerRetryPolicy` grew to 3 retries with `maxDelayMs: 45s` (the retry plugin *drops* a retry whose requested delay exceeds that cap, so it must sit above the longest transport delay).
  - A transport failure is only account-scoped when accounts leave through **different** proxies. With a single shared egress (every account on the config/system proxy, including pool accounts seeded with a copy of the system proxy) the retry stays on the current account: the sticky pointer is not advanced, the conversation binding is kept, and the account-rotation budget stays available for real quota/eligibility hops. The in-step failover of a settled recording also skips the budget without changing accounts.
  - Non-transport retries keep their 2s/4s starting schedule; nothing else about classification (AUTH vs NETWORK vs ELIGIBILITY) changed.

### 中文

- **新功能：模型选择框按当前活动账号资格动态隔离（Gemini 4 Argon 自动感知）。**
  - 号池内账号支持按账号独立发现并缓存模型目录（`ModelCatalog` 按 `accountId` 隔离）。
  - 在前端或号池切换当前活动账号后，DSH 输入框模型选择列表即时联动刷新（`llm/adapters-updated`）。
  - 若当前活动账号无 Argon 权限（标准/免费层），输入框模型列表中自动剔除 `gemini-4-argon`，防止误选调用报错；当切回 Pro/Ultra 订阅账号时，Argon 模型自动呈现。
- **修复：解决 Antigravity 插件设置及历史页面来回滚动疯狂闪屏问题。**
  - 根因定位：在 `src/client/decisions.ts` 中，决策按钮增强器容器级标记 `data-agy-decisions-scanned` 此前只读未写，且在 TanStack-Virtual 动态虚拟列表中，重新挂载渲染会重建 heading 节点。工具条反复注入导致项高度变化，进而触发虚拟列表重算 scrollTop 并再次触发重渲染注入飞轮。
  - 此外，设置导航图标的 `MutationObserver` 监听范围过广且在修改属性时自身被反复触发，且操作账号按钮的全局 busy 状态导致 40+ 个元素属性全量刷新并引发重排重绘。
  - 修复方案：在变更 DOM 前对容器写入 `data-agy-decisions-scanned` 并严格预检容器已有工具条；导航 Observer 限制仅监听对应属性变更（`attributeFilter`）并剥离 `characterData`；按钮 loading 状态与额度进度条 shimmer 动画改为账号级别作用域隔离。
- **修复：配额请求中上报 agy CLI 原生 User-Agent 以获取 Argon 额度分组（合并 PR #54，修复 #53）。**
  - Google Cloud Code 后端要求在 `retrieveUserQuotaSummary` 请求中携带真实的 `agy` CLI User-Agent（格式如 `Antigravity/<version> (darwin; arm64)`）才会返回 `Gemini 4 Argon` 独立额度桶。缺少该头时后端仅下发普通 Gemini 与 3P 组。
  - 配额探测服务现在自动探测本地 `agy` 版本并携带该头发送请求；当账号升级或移出专用桶时，旧版冷却记录与失效缓存自动淘汰。
- **修复：macOS 下复制活跃 SQLite WAL 时触发 libuv `copyFile` 忙循环导致 DSH Host 持续 100% CPU（修复 #52）。**
  - 原因分析：`loadAgyDbData()` 此前在读取工具参数和思考内容时，顺序将 `conversation.db`、`-wal` 和 `-shm` 复制到临时目录。在 macOS（以及其他基于 BSD 的 libuv 平台）上，当活跃 WAL 文件在复制过程中被 SQLite checkpoint 截短为 0 字节时，libuv 的 `uv_fs_copyfile` 工作线程会陷入无限忙循环，导致 DSH Host 进程持续耗尽单核 100% CPU。
  - 修复方案：完全移除临时目录与文件复制逻辑，改为直接通过 SQLite 引擎一致性读取（优先使用 `node:sqlite` 的 `DatabaseSync` 只读模式并开启 `PRAGMA query_only = ON;` 与 `busy_timeout`，后备使用 `sqlite3` CLI）。SQLite WAL 模式天然支持多读一写并发 MVCC 快照，既消除了文件截短忙循环与临时文件 I/O 争用，又保证了读取一致性。
  - 补充回归测试：覆盖活跃 WAL 读取、WAL 截短/检查点处理、sqlite3 CLI 后备路径及 0 字节文件防御。
- **修复：网络抖动时重试不再 4 秒内放弃，共用出口的号池不再被无意义轮换。**
  - 实测案例（2026-10-21 16:34–16:48）：本机代理对 `CONNECT` 返回 200 后直接掐断 TLS 长达约 14 分钟。每个账号上每次 `agy` 运行都在启动探测阶段死于 `Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF`，被 agy 包成 `Eligibility check failed: …`。DSH 约 4 秒内重试两次即宣告失败，而 Antigravity 桌面端自己的 language server 只是一直重试，网络恢复后照常工作。
  - 传输类（`NETWORK`）失败现在通过 `providerRetryAfterMs` 自带退避：同一会话连续失败按 **5s → 15s → 30s** 递增；成功或出现非传输类失败即归零，静默超过 10 分钟后重新从 5s 起算。`providerRetryPolicy` 提升为 3 次重试、`maxDelayMs: 45s`（重试插件对**超过上限**的请求延迟会直接放弃该次重试，因此上限必须高于最长退避）。
  - 只有当各账号走**不同代理**时，传输失败才算账号级问题。共用同一出口时（所有账号都走配置/系统代理，含新建号池账号被写入系统代理副本的情况）重试留在当前账号：不推进粘性指针、保留会话绑定、也不消耗本该留给配额/资格跳转的轮换预算；已结算记录的步内失败切换同样不再计数、不再换号。
  - 非传输类重试仍从 2s/4s 起步；AUTH / NETWORK / ELIGIBILITY 的判定逻辑未做任何改动。

## 0.4.67 (2026-10-20)

### English

- **Fix: Host authorization-review calls lost their output protocol (Fixes #50).**
  - When DSH's `@deepseek-ai/dsh-experimental-auto-review` plugin reviews a tool call it sends the entire rubric in `options.system` (`REVIEW_POLICY`, which demands "Return exactly one JSON object and no other text"). The adapter only forwarded `options.system` when `forwardSystemPrompt` was on — and that flag defaults to `false` — so the model received the data sections alone.
  - The model then answered the way a coding agent does ("Based on a…", preceded by a plan and a self-written test script), and the caller's `JSON.parse` threw `Unexpected token 'B', "Based on a"... is not valid JSON`. Every reviewed tool call was denied with "its body was not executed" instead of being reviewed.
  - The adapter already detects these calls (`isReview`, used to exempt reviews from the auxiliary-call gate). System-prompt forwarding now also fires on that probe, so the policy always reaches the model regardless of the global opt-in. Ordinary turns are untouched: `forwardSystemPrompt` remains `false` by default and non-review calls still drop the system prompt.
  - New tests pin both directions: a review call forwards the policy without the opt-in, and an ordinary turn still sends a bare prompt.

### 中文

- **修复：宿主授权复核调用丢失了输出协议（修复 #50）。**
  - DSH 的 `@deepseek-ai/dsh-experimental-auto-review` 插件复核工具调用时，把整份规则放在 `options.system` 里（`REVIEW_POLICY`，要求「只返回一个 JSON 对象，不得有其他文本」）。该适配器仅在 `forwardSystemPrompt` 开启时才转发 `options.system`，而此配置默认 `false`，于是模型只拿到了数据段。
  - 模型随后按编码代理的方式作答（「Based on a…」开头，前面还有计划和自写的测试脚本），调用方的 `JSON.parse` 抛出 `Unexpected token 'B', "Based on a"... is not valid JSON`。结果是每一次被复核的工具调用都以「its body was not executed」被拒绝，而不是被复核。
  - 适配器本来就能识别这类调用（`isReview`，用于把复核豁免出辅助调用闸门）。现在该判定同时触发系统提示转发，策略无论全局开关如何都会送到模型。普通轮次不受影响：`forwardSystemPrompt` 默认仍为 `false`，非复核调用照旧丢弃系统提示。
  - 新增测试固定两个方向：复核调用在未开启开关时也转发策略；普通轮次仍只发送裸提示。

## 0.4.66 (2026-10-19)

### English

- **Fix: Residual Windows console flash from agy's own auto-updater (Fixes #49).**
  - Root cause confirmed on agy 1.4.2: `--bg-updater` is spawned *inside* agy, and its `agy --version` grandchild allocates a fresh visible console. The parent's `windowsHide` and `AGY_CLI_DISABLE_AUTO_UPDATE=1` therefore apply too late — the window is already on screen (this invalidates the #23 assumption).
  - New `src/host/auto-updater.ts` pre-empts the check instead of the child: agy's 15-minute fast path (`auto_updater.go:281 Last check was less than 15 minutes ago, skipping update (fast path)`) only stats `<agy home>/last_check.timestamp`, so the plugin refreshes that mtime immediately before every spawn. The `--bg-updater` chain is then never created.
  - Covers every spawn path: turns, boot `--version`/`models` probes, model-picker `listModels` refresh, login probes and auxiliary oneshot calls. Verified end-to-end against agy 1.4.2: the run logs `skipping update (fast path)` and spawns no child.
  - Isolated accounts are respected — the timestamp is resolved through the same `ANTIGRAVITY_APP_DATA_DIR` / `GEMINI_CLI_HOME` / `HOME` / `USERPROFILE` chain the plugin spawns with, so pooled homes are never mixed and the real profile is only touched for the system account.
  - New config `suppressAgyAutoUpdate` (env `DSH_AGY_SUPPRESS_AUTOUPDATE`), default `true` on Windows and `false` elsewhere; `false` restores agy's own auto-update behaviour. Pre-emption is best-effort and never fails a run.
  - `/agy doctor` now reports the auto-updater suppression state, and the FAQ documents both this fix and the read-only `update.lock` workaround for older versions.

### 中文

- **修复：agy 自身自动更新链导致的 Windows 残留闪窗（修复 #49）。**
  - 在 agy 1.4.2 上实锤根因：`--bg-updater` 是 **agy 内部** spawn 的，它再拉起的 `agy --version` 孙进程会自行分配可见控制台，因此父进程的 `windowsHide` 与 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 都来不及生效（#23 的假设在此版本不成立）。
  - 新增 `src/host/auto-updater.ts`，改从「阻止检查」下手：agy 的 15 分钟 fast path（`auto_updater.go:281 Last check was less than 15 minutes ago, skipping update (fast path)`）只 stat `<agy home>/last_check.timestamp`，插件在每次 spawn 前刷新该文件 mtime，`--bg-updater` 链便完全不产生。
  - 覆盖全部 spawn 路径：对话轮次、启动 `--version` / `models` 探测、模型选择器的 `listModels` 刷新、登录探测与 oneshot 辅助调用。已用真实 agy 1.4.2 端到端验证：日志为 `skipping update (fast path)`，无任何子进程。
  - 隔离账号同样生效——时间戳按插件 spawn 时使用的 `ANTIGRAVITY_APP_DATA_DIR` / `GEMINI_CLI_HOME` / `HOME` / `USERPROFILE` 链路解析，号池目录互不串扰，只有系统主账号才会碰到真实 profile。
  - 新增配置 `suppressAgyAutoUpdate`（环境变量 `DSH_AGY_SUPPRESS_AUTOUPDATE`），Windows 默认 `true`、其他平台默认 `false`；设为 `false` 即恢复 agy 原本的自动更新行为。拦截为 best-effort，失败绝不影响对话。
  - `/agy doctor` 增加自动更新拦截状态行；FAQ 同时补充本修复说明与旧版本可用的只读 `update.lock` workaround。

## 0.4.65 (2026-10-19)

### English

- **Fix: Paid Pro Argon Quota Pool Recognition & Metric Display (Fixes #46).**
  - Added support for top-level `summary.buckets` parsing and model-level quota metrics via `/v1internal:retrieveUserQuota`.
  - Automatically backfills `weeklyFraction` and `weeklyResetTime` when Argon models are detected in model catalog, resolving empty quota pills and dashes in `/agy pool`.
  - Updated `/agy pool` display formatting to seamlessly fallback to `remainingFraction` when `weeklyFraction` is unset.
- **Fix: Eliminate 15-Minute Flashing Black Terminal Window on Windows (Fixes #47).**
  - Removed redundant `catalog.refreshIfNeeded()` background spawn from the 15-minute periodic watchdog timer, ensuring background heartbeats strictly execute HTTPS network queries without launching `agy` CLI sub-processes.
  - Models now refresh cleanly on startup and on-demand upon model picker access.
  - Fixed `ModelCatalog` cache TTL initialization to accurately honor `getConfig().modelsCacheTtlMs`.
- **Fix: Quota Parity with `agy` CLI, Stale 5h Bucket Detection & Session Cleanup (Fixes #48).**
  - Integrated official `/v1internal:retrieveUserQuota` model-level quota metrics into `refreshAccountQuota`, matching the exact figures reported by the `agy` CLI.
  - Added `isStale5hBucket` heuristic to detect unmetered production endpoint placeholders (`remainingFraction === 1.0` with `resetTime ≈ now + 5h`) and overwrite them with active window model-level quota data.
  - Fixed endpoint fallback behavior in `fetchQuotaSummary` so `preferredEndpointIndex` is not locked to the production endpoint when endpoint 0 (`daily-cloudcode-pa.googleapis.com`) responds normally with partial groups.
  - Added unrounded quota percentage preview in frontend pill tooltips (`title="... (raw: 0.9711094)"`) for precise verification against raw API responses.
  - Added automatic cleanup of stale account bindings in `sessions.json` upon engine startup and session selection.

### 中文

- **修复：付费 Pro 账号 Argon 额度池识别与展示（修复 #46）。**
  - 增强额度解析，支持后端顶层 `summary.buckets` 以及通过 `/v1internal:retrieveUserQuota` 获取模型级别额度数据。
  - 模型探测阶段发现 Argon 模型时自动补充 `weeklyFraction` 与 `weeklyResetTime`，彻底解决客户端胶囊与 `/agy pool` 中显示空白破折号（`—`）的问题。
  - `/agy pool` 命令兼容展示 `weeklyFraction ?? remainingFraction`。
- **修复：彻底解决 Windows 环境下每 15 分钟闪烁黑终端窗口问题（修复 #47）。**
  - 从 15 分钟周期的后台刷新任务中移除了 `catalog.refreshIfNeeded()` 调用，使后台心跳严格保持在无外部进程的纯 HTTPS 网络请求，杜绝 Windows 终端弹窗。
  - 模型目录在启动和模型选择器打开时按需刷新，并修复了 `ModelCatalog` 构造时硬编码 TTL 的问题（接入 `getConfig().modelsCacheTtlMs`）。
- **修复：面板额度与 agy CLI 保持严格一致、识别 5h 虚假占位符并清理残留失效账号（修复 #48）。**
  - 对接官方 agy CLI 相同的 `/v1internal:retrieveUserQuota` 接口，将模型级实际 WTUS 额度纳入账户额度刷新体系。
  - 实现 `isStale5hBucket` 智能检测机制，识别生产域未记账的 5 小时虚假占位符（`remainingFraction === 1.0` 且 `resetTime ≈ now + 5h`），并由真实生效窗口数据覆盖替换。
  - 修复 `fetchQuotaSummary` 端点降级逻辑，在 daily 域仅返回部分组别时进行多组结果合并，不再将全局端点锁死到不记账的生产域。
  - 客户端胶囊悬浮气泡增加原始未舍入比例（例如 `97.1% (raw: 0.9711094)`）与 ISO 重置时间，方便与 agy 命令行及 API 返回对比。
  - 启动及选择账号时自动清理 `sessions.json` 中已不存在的失效废弃账号引用。

## 0.4.64 (2026-10-18)

### English

- **Feat: DSH Standard Error Code Alignment & Context Window Overflow Auto-Compaction.**
  - Added `Err.CONTEXT_WINDOW_EXCEEDED` (`CONTEXT_WINDOW_EXCEEDED`), `Err.QUOTA`, and `Err.INVALID_CREDENTIAL` aligned with `@deepseek-ai/dsh-llm` standard contracts.
  - Implemented `looksLikeContextWindowExceeded` classifier detecting Gemini/Antigravity token limit overflow signatures (`prompt is too long: \d+ tokens > \d+ maximum`, `context window exceeded`, `token limit exceeded`, etc.).
  - Mapped context overflow to `CONTEXT_WINDOW_EXCEEDED`, allowing DSH's native agent loop to trigger context auto-compaction and summarization automatically rather than failing the turn with a fatal `PROCESS_EXIT`.
- **Perf & Concurrency: Windows High-Concurrency & Zero-Blocking Credential Slots.**
  - Added in-memory cached reads for Windows Credential Manager (`readWindowsCredentialRaw`, `invalidateWindowsCredentialCache`), slashing read latency from ~516ms (synchronous PowerShell process invocation) to <0.01ms (50,000x faster).
  - Refactored `acquireCredentialSlot` cross-process locking to release `.credential-slot.lock` immediately after writing the slot identity, eliminating thread/process blocking across concurrent sessions during long LLM runs.
  - Replaced slot join polling with an event-driven `slotEvents: EventEmitter`, providing 0ms instant wakeup for concurrent turns sharing the active identity.
- **Feat: Multi-Turn Tool Call Disambiguation & Collision Self-Healing.**
  - Implemented `ToolCallState`, `rememberToolCallId`, `consumeToolBinding`, and `expirePendingToolCalls` in `src/host/mapper.ts`.
  - Disambiguates duplicate call IDs across tools (`${id}#${name}`) with FIFO ordering and assistant-turn expiration, eliminating `INVALID_ARGS` crashes in long agentic conversations.
  - Updated `parseMirrorCallId` in `src/host/recording.ts` to seamlessly parse both canonical and hash-suffixed call IDs.
- **Hardening: Headless Browser & Process Isolation Hardening.**
  - Injected `AGY_CLI_NONINTERACTIVE_HEADLESS: '1'`, `BROWSER: 'none'`, and `CI: '1'` into `withAgyQuietEnv` to strictly prevent accidental browser popups during background checks.
  - Redirected `ANTIGRAVITY_GEMINI_DIR` and `ANTIGRAVITY_APP_DATA_DIR` into isolated account directories in `isolatedHomeEnv` to eliminate credential bleed.
- **Clean: Removed redundant native `generate_image` tool.**
  - Fully removed `generate_image` registration, config schema, and related test fixtures.

### 中文

- **特性：对齐 DSH 标准错误码规范与上下文超限自动压缩触发。**
  - 新增 `Err.CONTEXT_WINDOW_EXCEEDED` (`CONTEXT_WINDOW_EXCEEDED`)、`Err.QUOTA` 与 `Err.INVALID_CREDENTIAL`，深度对齐 `@deepseek-ai/dsh-llm` 标准协议契约。
  - 实现 `looksLikeContextWindowExceeded` 分类器，精准识别 Gemini/Antigravity 上下文溢出特征（`prompt is too long: \d+ tokens > \d+ maximum`、`context window exceeded`、`token limit exceeded` 等）。
  - 上下文溢出时抛出标准 `CONTEXT_WINDOW_EXCEEDED` 错误码，使 DSH 原生 Agent 循环自动触发上下文压缩（Context Compaction / Summarization），彻底告别直接进程崩溃断连（`PROCESS_EXIT`）。
- **性能与并发：Windows 极致高并发与凭据槽位零阻塞优化。**
  - 为 Windows Credential Manager 实现高频读内存缓存（`readWindowsCredentialRaw` / `invalidateWindowsCredentialCache`），将每次查询耗时从 516ms（同步拉起 powershell.exe）降至 <0.01ms（提速超 50,000 倍），彻底杜绝事件循环被卡死。
  - 重构 `acquireCredentialSlot` 跨进程锁机制，在凭据写入槽位完成后立即释放 `.credential-slot.lock`，不再跨越整个 LLM 流式输出生命周期持锁，彻底解决多会话并发竞争卡死。
  - 将轮询等待重构为基于事件的 `slotEvents: EventEmitter` 唤醒机制，同身份并发会话实现 0ms 零延迟极速放行。
- **特性：多轮工具调用标识去重与碰撞自愈机制。**
  - 在 `src/host/mapper.ts` 中实现 `ToolCallState`、`rememberToolCallId`、`consumeToolBinding` 与 `expirePendingToolCalls` 状态机。
  - 对跨工具复用的相同 `callId` 自动添加后缀（`${id}#${name}`）并按 FIFO 队列匹配，在新 Assistant 消息到达时自动过期队列，杜绝 DSH `INVALID_ARGS` 报错。
  - 同步更新 `parseMirrorCallId`，完美支持带 `#` 后缀的工具调用解析与回溯。
- **加固：无头环境与进程隔离全面加固（防弹窗机制）。**
  - 在 `withAgyQuietEnv` 中注入 `AGY_CLI_NONINTERACTIVE_HEADLESS: '1'`、`BROWSER: 'none'` 与 `CI: '1'`，从底层彻底阻止任何意外触发的浏览器登录弹窗。
  - 在 `isolatedHomeEnv` 中重定向 `ANTIGRAVITY_GEMINI_DIR` 与 `ANTIGRAVITY_APP_DATA_DIR` 至账号隔离目录，杜绝环境变量遗漏导致的全局配置污染与凭据泄露。
- **精简：移除冗余原生图像生成工具（`generate_image`）。**
  - 彻底下线 `generate_image` 工具定义、配置项声明及对应测试文件。

## 0.4.63 (2026-10-18)

### English

- **Fix: Prevent Mermaid post-render cleanup from deleting active diagram SVGs.**
  - Resolved an issue where rendered flowchart SVGs were immediately removed by `cleanupTempElements` in the `finally` block due to an indiscriminate `document.getElementById(id)` query matching the newly inserted diagram SVG.
  - Added ancestor check (`closest('[data-agy-mermaid-svg]')`) to ensure only leaked standalone temporary DOM elements outside the diagram container are purged.
- **Fix: Enhanced Argon quota pool detection (Issue #46) and model effort support.**
  - Added bucket-level Argon detection in quota summary parsing (`hasArgonBucket`), resolving cases where Paid Pro accounts had their Argon quota pools omitted due to varied group naming.
  - Enabled reasoning effort folding and `--effort` parameter support for `argon`-prefixed models, and added `gemini-4-argon` to `DEFAULT_FALLBACK_MODELS`.
- **Docs: Correct feature descriptions & refresh visual documentation.**
  - Corrected inaccurate and exaggerated phrasing in the README feature table regarding settings consolidation, secondary parallel leases, and native context caching.
  - Replaced dashboard screenshot with pixel-perfect mosaic redactions on all user email addresses, and enriched the documentation with real-world Token usage and 1M context metering figures.

### 中文

- **修复：Mermaid 流程图渲染后被清理机制误删导致内容空白消失的问题。**
  - 修复 `cleanupTempElements` 在清理泄漏的临时 DOM 元素时，因直接通过 `document.getElementById(id)` 查找而误删了刚刚挂载到页面容器中的正式 `<svg>` 节点，导致流程图渲染后瞬间空白的问题。
  - 增加最近祖先判断（`closest('[data-agy-mermaid-svg]')`），确保仅清理逃逸至容器外部的游离临时节点，正式图表永久保留。
- **修复：付费 Pro 账号 Argon 额度池识别增强（Issue #46）与模型调用支持。**
  - 在配额解析中增加 bucket 层级的 Argon 标识检测（`hasArgonBucket`），彻底解决因分组名称变体导致的付费 Pro 账号未识别 Argon 额度池的问题。
  - 支持 `argon` 模型前缀的思维强度折叠与 `--effort` 参数传递，并在 `DEFAULT_FALLBACK_MODELS` 中补齐 `gemini-4-argon`。
- **文档：纠正功能说明表述并升级图文文档（邮箱全面脱敏）。**
  - 纠正 README 特性表中关于“插件页详情零冗余复用”、“同账号二次并发租赁”与“97% 缓存命中”的不准确表述，还原本质功能（设置控制台内嵌、副账号同身份并发租约、原生上下文缓存真实计量）。
  - 全新更新控制台仪表盘截图，对所有账号邮箱实施严格的像素级马赛克脱敏，并新增真实会话 Token 用量与 1M 上下文负载的图文展示。

## 0.4.62 (2026-10-17)

### English

- **Feat: Capacity vs. Account exhaustion separation & stay-on-capacity backoff.**
  - **Decoupled Capacity vs. Account**: Added `looksLikeCapacityExhaustion` to distinguish upstream datacenter/cluster overload (503/529, "high demand", "capacity exceeded", "resource temporarily exhausted") from per-account rate limits (429 per-token/per-request exhaustion).
  - **Stay Strategy**: Capacity overloads now surface as retryable `Err.OVERLOADED` (preserving `rate limit (server capacity overloaded)` for downstream compatibility). `rotateAway` skips account rotation when capacity is overloaded, avoiding rapid, fruitless churn through the entire account pool during regional Google outages.
- **Feat: Windows cross-process slot lock with `process.kill(pid, 0)` liveness detection & instant self-healing.**
  - **Liveness Detection**: Implemented `isProcessAlive(pid)` leveraging `process.kill(pid, 0)` with proper platform-level `ESRCH` and `EPERM` error code handling.
  - **Instant Stale Lock Reclamation**: In `acquireCrossProcessSlotLock` for Windows multi-process slot arbitration, stale locks from abruptly killed or crashed processes are detected immediately upon PID verification and cleanly removed, eliminating unneeded blocking waits.
- **Feat: Zero-flicker optimistic account switching & shimmer loading animation.**
  - **Optimistic Account Switch**: Switching accounts in `AgySettingsSection` triggers an immediate 0ms UI update (`optimisticActiveId`) with graceful rollback on error, eliminating UI redraw jitter and perception latency.
  - **Quota Shimmer Effect**: Integrated CSS shimmer animation (`@keyframes agy-shimmer` & `.agy-shimmer-track`) into quota progress bars during refresh and pending states, delivering a polished, modern look.
- **Fix: Unified proxy indicator badge & system proxy inheritance for primary account.**
  - **Inherited Proxy Visibility**: The proxy tag (`[globe] Proxy`) now resolves effective proxy configuration (`acc.proxyUrl || pool.systemProxy`). When accounts rely on global/system proxy settings, the proxy badge is reliably shown on the primary account alongside other accounts instead of silently omitting it.
  - **Proxy Tooltip & Placeholder**: Hovering on the proxy tag now shows the effective proxy URL (`title: effectiveProxy`), and modal/input placeholders dynamically reflect the inherited system/global proxy URL.

### 中文

- **新功能：容量过载与账号配额耗尽精准解耦，机房压力下实行原地退避（Stay）。**
  - **过载类型分离**：引入 `looksLikeCapacityExhaustion`，精准区分 Google 机房级/区域级容量瓶颈（503/529、"high demand"、"capacity exceeded"、"resource temporarily exhausted"）与单个账号的 429 频率超限。
  - **原地退避调度（Stay）**：容量压力统一抛出可重试的 `Err.OVERLOADED`（错误信息保留 `rate limit (server capacity overloaded)` 以向下兼容）。`rotateAway` 遇到容量过载时跳过轮换、留在当前账号，彻底杜绝在机房整体拥堵时盲目将全号池快速轮换耗尽的恶性循环。
- **新功能：Windows 跨进程凭证锁与 `process.kill(pid, 0)` 进程存活探测秒级自愈。**
  - **进程存活性探测**：实现高可靠的 `isProcessAlive(pid)`，基于 `process.kill(pid, 0)` 准确识别 `ESRCH`（进程不存在）与 `EPERM`（跨权限存活进程）。
  - **崩溃孤儿锁秒级清理**：在 Windows 多进程凭证槽互斥锁（`acquireCrossProcessSlotLock`）中，当持锁 PID 意外崩溃或被强杀时，竞争进程通过存活探测瞬间判定孤儿锁并自愈重置，无需冗长的超时等待。
- **新功能：前端账号切换 0ms 乐观响应防闪烁与配额微光（Shimmer）动效。**
  - **0ms 乐观切换**：在 `AgySettingsSection` 控制台切换账号时立即通过 `optimisticActiveId` 刷新界面状态并带有错误自动回滚保护，彻底消除切换等待过程中的白屏闪烁与延迟感。
  - **配额微光流光动效**：配额条（`renderFamilyQuotaBar`）在刷新或等待就绪时接入平滑流光动效（`@keyframes agy-shimmer` 与 `.agy-shimmer-track`），交互反馈更具质感。
- **修复：统一代理标识展示与主账号系统/全局代理继承识别。**
  - **继承代理完整透出**：代理徽标（`[globe] 代理`）统一解析账号生效代理（`acc.proxyUrl || pool.systemProxy`）。当主账号继承使用系统/全局代理设置时，与号池副账号一样稳定展示代理徽标，消除“主账号缺少代理标识”的疑惑。
  - **代理悬浮提示与输入框占位符**：鼠标悬停在“代理”徽标上可直接查看完整生效代理 URL；代理编辑框与新建账号对话框动态展示当前继承的系统代理地址。

## 0.4.61 (2026-10-17)

### English

- **Feat: Official vector logo redesign & zero-redundancy console reuse across DSH.**
  - **Redesigned Vector Logo** (`assets/icon.svg` & `./icon.svg` + `package.json` `icon`): Clean, transparent-background 36x36 retina vector icon featuring a vibrant antigravity orb gradient (`#38BDF8` → `#6366F1` → `#9333EA` → `#C026D3`), front/back occluded orbital rings, specular crescent highlight, and dual satellite bridge nodes (cyan & magenta). Pinned by `test/client-plugin-meta.test.ts`.
  - **Settings & Navigation Brand Icons**:
    - Upgraded `agyIcon` in Settings section header and Modal Console dialog to render the full official vector logo geometry.
    - Added `installSettingsNavIcon` dynamically targeting the Settings dialog navigation sidebar (`[role="dialog"] nav button`), replacing DSH's fallback gear icon with the official Antigravity logo.
  - **Zero-Redundancy Plugin Page Console**: Directly reuses the identical `AgySettingsSection` console in the plugins bundle/row view (`plugins.bundle.config` & `plugins.row.config`), eliminating duplicate dashboard code while keeping list card summaries clean.
  - **Display Metadata**: Localized title and description in `locale/{en,zh,es,pt-BR}.json` ("Antigravity 桥接").

### 中文

- **新功能：官方矢量 Logo 视觉重构与 DSH 全场景控制台零冗余复用。**
  - **矢量 Logo 全新设计**（`assets/icon.svg` 与 `./icon.svg` + `package.json` `icon` 字段）：采用纯透明背景、36x36 视网膜矢量微标，包含反重力渐变球体（`#38BDF8` → `#6366F1` → `#9333EA` → `#C026D3`）、前后立体穿插引力环、月牙镜面液态高光与双子引力光节点（天青与洋红）；通过 `test/client-plugin-meta.test.ts` 强校验。
  - **设置界面与左侧导航图标全面接入 Logo**：
    - 设置面板顶部与控制台弹窗标题的 `agyIcon` 升级为官方矢量微标几何体。
    - 新增 `installSettingsNavIcon`，动态匹配设置对话框左侧导航菜单（`[role="dialog"] nav button`），将系统默认齿轮图标替换为专属 Antigravity Logo。
  - **插件详情页零冗余复用**：侧边栏插件页（`plugins.bundle.config` 与 `plugins.row.config`）在详情页面中直接复用原版 `AgySettingsSection` 控制台，列表摘要卡片保持纯粹轻量，彻底避免界面冗余与代码重复。
  - **展示元数据**：`locale/{en,zh,es,pt-BR}.json` 注入本地化展示元数据（"Antigravity 桥接"）。

## 0.4.60 (2026-10-17)

### English

- **Fix: same-grant runs on a SECONDARY pool account now run in parallel — only identity SWITCHES serialize (cardboard-empire starvation, 2026-10-17).**
  - **Incident**: the active pool account was a secondary (`elegantmanco@…`); only the primary account had a fast path, so every secondary run held the machine-global Windows credential slot EXCLUSIVELY for its whole run. One long agy run (the quota-investigation session, 12:34:30–12:44:18, 79 mirrored steps) starved all other sessions: three cardboard-empire turns sat at `request/context` for 8m50s+ with zero tokens even though their `request/header` had already been logged. When the long run exited the queue drained 16s later (first token 12:44:34) — the slot, not agy, was the bottleneck.
  - **Change** (`credential-slot.ts`): the installed SECONDARY identity is now reference-counted. The first run performs the exclusive handoff and keeps the mutex; later runs on the SAME grant join as fast leases after proving the slot still carries that grant (`sameCredentialGrant` on every join, so an external slot takeover is never joined). **Runs already queued for the slot also join**: while waiting they poll every 100ms and take a lease the moment their own grant is installed, so a backlog of turns drains in parallel instead of one whole run at a time (the exact incident shape). The LAST holder persists a rotated access token and restores the primary. `fastPathRunCount()` now reports primary fast runs + live same-identity secondary holders, and `/agy status` shows the combined number.
  - **Anti-starvation invariant preserved**: a run that needs a DIFFERENT identity (or the primary) registers a switch claim BEFORE queueing on the mutex; new same-identity joins are refused while any claim is outstanding (the single `slotSwitchPending` boolean became a `pendingSwitchClaims` counter), so a switcher can no longer be postponed indefinitely. Same-grant refreshes remain safe: refresh tokens are not single-use, and every joiner verifies the grant before running.
  - **Tests** (`credential-slot.test.ts`): same-identity secondary runs share one installed identity and run in parallel (the mutex stays held by the owner until the last peer exits); an identity switch waits for EVERY peer; a pending switch refuses new peers (no starvation); a peer does not join an installed identity the slot no longer carries; last-holder rotated-token write-back; `parallel: false` still restores full exclusivity; existing corruption guards unchanged (26/26 pass).
- **Fix: live Gemini quota synchronization & accurate 5h / weekly limit display.**
  - **Root Cause**:
    1. `AGY_ENDPOINTS` placed `https://cloudcode-pa.googleapis.com` ahead of `https://daily-cloudcode-pa.googleapis.com`. `cloudcode-pa` is the Cloud Code for VS Code legacy PA endpoint, returning a separate quota pool (which showed 4% @ 15:07).
    2. `src/host/quota.ts` hardcoded `agyUserAgent` default to `1.1.15`. Google's Antigravity backend (`daily-cloudcode-pa.googleapis.com`) checks client versions and omits the entire `Gemini Models` group when receiving `1.1.15`, returning only third-party models. With `2.24.0` (matching Antigravity IDE 2.24.0), it immediately returns both Gemini Models and Claude/GPT groups with live 5-hour and weekly buckets.
    3. Reordered `AGY_ENDPOINTS` to prioritize Antigravity's native `https://daily-cloudcode-pa.googleapis.com` endpoint, and updated `agyUserAgent` default version to `2.24.0`.
  - **Result**: "刷新额度" and "同步" immediately display accurate Gemini 5-hour and weekly limits matching Antigravity IDE (e.g. 99% / 99% with correct reset countdowns) instead of getting stuck at 4%.
- **Fix: primary account on Windows self-heals from durable verified store and prevents sibling account log pollution.**
  - **Issue**: On Windows, the primary account (`systemHome`) could display a secondary account's email (e.g. `elegantmanco@…` instead of `g98…`) after background quota polls. The background quota poller read `detectEmailFromAgyLogs` from `~/.gemini/antigravity-cli/log`, where secondary accounts executing in the shared CLI home wrote auth success log lines.
  - **Fix**: The primary account on Windows now binds directly to the durable verified store (`.primary-credential.json`, written only from live Google token verification). `normalizeLegacyPrimary` self-heals on startup/reload, and `detectEmailFromAgyLogs` rejects any email belonging to sibling accounts in the pool.

### 中文

- **修复：同一授权下的次级账号运行现在可以真正并行——只有「身份切换」才串行（cardboard-empire 饿死事件，2026-10-17）。**
  - **事件**：当时生效的是号池里的次级账号（`elegantmanco@…`），而快路径只给系统主账号，于是每个次级运行都要独占机器级 Windows 凭据槽直到整个 run 结束。一个长 agy 运行（额度排查会话，12:34:30–12:44:18，79 个镜像步骤）把其它会话全部饿死：三个 cardboard-empire 回合停在 `request/context` 8 分 50 秒以上、零 token，而它们的 `request/header` 早已记录。长运行退出后 16 秒内队列就动了起来（12:44:34 首个 token）——证明瓶颈是凭据槽而不是 agy。
  - **改动**（`credential-slot.ts`）：次级账号装入槽位的身份改为**引用计数**。第一个 run 完成独占交接并持有互斥锁；之后**同一授权**的 run 通过 `sameCredentialGrant` 校验槽位仍携带该凭据后直接加入（外部改写槽位时不会误加入）。**已经排队等槽的 run 也会加入**：排队期间每 100ms 轮询一次，一旦自己的授权被装入就立刻转成并行租约——这样一整批积压回合会并行排空，而不是一个 run 接一个 run 地串（正是本次事件形态）。**最后一个 holder** 才回写轮换后的 access token 并还原主账号。`fastPathRunCount()` = 主账号快路径 + 次级同身份在跑数，`/agy status` 展示合并值。
  - **防饿死不变量保留**：需要切换身份（或切回主账号）的运行会在排队**之前**登记切换声明；只要有声明未完成，新的同身份 run 一律拒绝加入（原来的单个 `slotSwitchPending` 布尔改为 `pendingSwitchClaims` 计数），切换者不会再被无限推迟。同授权并发刷新是安全的（refresh token 非一次性），且每个加入者都会先校验授权。
  - **测试**：同身份次级并行（互斥锁由所有者持有直到最后一个 peer 退出）、身份切换等待全部 peer、切换待定时拒绝新 peer（防饿死）、槽位被外部改写时不加入、最后持有者回写轮换 token、`parallel: false` 仍完全串行、原有防损坏守卫不变（26/26 通过）。
- **修复：Gemini 额度显示 4% 卡死及刷新/同步无效问题，还原真实的 5 小时与周额度。**
  - **根本原因**：
    1. `AGY_ENDPOINTS` 此前误将 `https://cloudcode-pa.googleapis.com`（Cloud Code PA 遗留端点）置于首位，导致请求命中了非 Antigravity 的老配额周期（显示为 4.06% ↺ 15:07）。
    2. `src/host/quota.ts` 中的 `agyUserAgent` 默认写死了版本号 `1.1.15`。Google Antigravity 后端（`daily-cloudcode-pa.googleapis.com`）对客户端版本有特性拦截：当 UA 为 1.x 时，响应中直接剔除 `Gemini Models` 额度组，导致此前测试误以为该端点缺失 Gemini 数据。更新为 `2.24.0`（与 Antigravity IDE 2.24.0 官方客户端一致）后，后端即刻完整返回 Gemini Models 的 5 小时与周额度。
    3. 将 `AGY_ENDPOINTS` 调整为优先请求 Antigravity 原生端点 `https://daily-cloudcode-pa.googleapis.com`，并将 `agyUserAgent` 默认版本升级为 `2.24.0`。
  - **效果**：点击「刷新」或「同步」后，插件面板即刻正确呈现与 Antigravity IDE 一致的真实额度（如 99% 5 小时额度与 99% 周额度及各自正确的重置倒计时），不再卡死在 4%。
- **修复：Windows 主账号身份自愈并防御副账号日志污染（主账号显示为副账号邮箱问题）。**
  - **问题**：在 Windows 单槽位多账号环境下，后台每 15 分钟的额度轮询通过 `detectEmailFromAgyLogs` 扫描全局 CLI 日志目录；当副账号（如 `elegantmanco@…`）在本地运行留下认证日志后，主账号邮箱被误覆盖为副账号，导致控制面板主账号显示错误。
  - **修复**：主账号在 Windows 下权威绑定持久化验证凭据（`.primary-credential.json`），启动与重新载入时通过 `normalizeLegacyPrimary` 自动自愈；日志探测增加兄弟账号守卫（Sibling Account Guard），坚决忽略已在号池中的副账号邮箱，杜绝反向污染。

## 0.4.59 (2026-10-16)

### English

- **Fix: turns queued for the Windows credential slot could pend forever as invisible zombies, immune to Stop (cardboard-empire incident, 2026-10-16 22:44).**
  - **Incident**: a turn dispatched while another session's 32-minute run held the process-global credential slot never received the release wake-up. The turn sat at `request/context` with no agy process spawned for 30+ minutes; the idle watchdog never armed (it only arms after spawn); Stop did nothing because no wait in the dispatch phase observed the abort signal; and the leaked dispatch held one of the 3 `maxConcurrent` slots, starving later turns of other sessions into the same wedge.
  - **Changes**:
    1. **`AsyncMutex` rewrite** (`credential-slot.ts`): the promise-chain FIFO could never remove a waiter — an abandoned/aborted one would wedge the whole chain behind it. Now an explicit queue: a cancelled or timed-out waiter is REMOVED and the holder's release wakes the head directly. Cancelling a waiter deliberately does NOT grant the mutex (it is still held).
    2. **Abort + bounded wait for the slot** (`acquireCredentialSlot`): new `signal` / `dispatchTimeoutMs` resolve-options. Stop now ends a queued dispatch immediately (`AbortedWaitError`); a bounded wait fails visibly (`WaitTimeoutError`) instead of parking silently.
    3. **Lost-wake-up self-heal**: while queued, a liveness poll (5s) re-checks and takes the mutex directly if it is actually free — the exact failure shape from the incident now self-corrects within seconds even if a wake-up is ever lost again.
    4. **Dispatch observability**: a 2-minute heartbeat logs the queue state ("dispatch still waiting Nm — X waiter(s), Y holder(s) … press Stop to cancel") so a stuck dispatch is visible in the console instead of a silent spinner.
    5. **Dispatch retry** (`adapter.ts`): on a hard-cap slot timeout the dispatch releases the concurrency slot, backs off abort-aware (2s→4s→…→15s), and retries (`dispatchRetries`, default 1); exhaustion fails the turn VISIBLY with guidance — never an infinite pending state. Retry is confined to the pre-spawn dispatch phase; a turn that already emitted output is never re-driven.
    6. **Rate-limit spacing sleep** is now abort-aware (Stop during the 60s window no longer spawns a turn nobody is reading).
  - **Config**: new `dispatchTimeoutMinutes` (default **15** — each attempt waits up to 15 minutes for the slot, so persistence ≈ (1+retries)×15 min before a visible failure; 0 = wait indefinitely, still abort-aware / poll-healed / heartbeat-logged) and `dispatchRetries` (default 1). User-facing entry: `/agy dispatch` (inspect live queue + effective caps), `/agy dispatch <minutes|off>` and `/agy dispatch-retries <n>` — persisted via runtime overrides, effective next turn.
  - **Fix: artificial concurrency limits removed — native agy parallelism restored.**
    - agy is a stateless CLI and handles concurrent processes natively; the only machine-global constraint on Windows is the single credential store, and only when its IDENTITY changes.
    - **Same-account fast path** (`parallelSameAccount`, default **on**): a run whose credential already sits in the slot starts immediately WITHOUT the mutex, so N sessions on one account run truly in parallel (concurrent refreshes on one grant are safe — refresh tokens are not single-use). `/agy parallel <on|off>` toggles it.
    - **Account switches still serialize** (correctness): a secondary waits for same-account runs to drain before swapping the slot, new fast paths are refused while a switch pends, and the switch restores the primary afterwards — the anti-corruption invariants are unchanged and covered by new tests.
    - **`maxConcurrent` default 3 → 0 (unlimited)**: no artificial admission bound; Google rate limits and the pool's cooldowns are the natural regulators. `/agy max-concurrent <n|off>`.
  - **Fix: quota merge — the real remaining was blocked by the 6h window gate.** When the 5h bucket is exhausted, Google reports the NEXT reset at the weekly boundary (14+ hours out); the `is5hWindow` gate (reset must land within 6h) skipped the per-model merge, so the UI kept showing the coarse summary's meaningless "100%, resets in now+5h" placeholder while the account was actually down to **4.06%** (observed live 2026-10-17 00:37: reported reset 05:37:49 == refresh+5h exactly, while every model row carried 4.06% @ 15:07). The merge now tightens to the LOWEST reported remaining regardless of which window it owns; the weekly row stays visible separately. Regression test reproduces the exact incident numbers.
  - **Fix: goal completion short-circuit swallowed genuine user messages.** `isGoalToolContinuation` scanned a fixed trailing window for goal markers "anywhere": a message sent right after a goal completed (the goal tool-result was still in that window) was finished as an EMPTY turn without spawning agy — twice in a row, "把相关的经验整理到agents.md" never reached the agent (2026-10-17, turns completed in 7s/16s with zero output). The scan now walks backwards and STOPS at a genuine user instruction (harness-injected texts — time samples, system-reminder wrappers, runtime context — stay transparent), so markers only short-circuit while they are actually the trailing content.
  - **Tests**: mutex cancel-removes-and-wakes-next; timeout keeps the queue flowing; lost-wake-up poll grant; `acquireCredentialSlot` rejects when already aborted, honors Stop while queued, and fails visibly on the bounded wait; same-account fast path / drain / starvation; quota weekly-boundary tightening; goal-continuation genuine-message cases.

### 中文 (Chinese)

- **修复：排队等 Windows 凭据槽位的回合可能永远挂起成隐形僵尸，且 Stop 无法取消（cardboard-empire 事件，2026-10-16 22:44）。**
  - **事件**：一个回合在另一会话 32 分钟长任务持有进程级凭据槽位期间派发，之后永远没有收到释放唤醒。该回合停在 `request/context`，30 多分钟没有拉起任何 agy 进程；空闲看门狗从未武装（只在 spawn 后才武装）；按 Stop 无效，因为派发阶段的所有等待都没有观察中止信号；泄漏的派发还占着 3 个 `maxConcurrent` 槽位之一，把其他会话的新回合也拖进同样的卡死。
  - **修改**：
    1. **重写 `AsyncMutex`**（credential-slot.ts）：原来的 promise 链式 FIFO 无法移除等待者——一个被放弃/中止的等待者会把整条链卡死。现在改为显式队列：被取消/超时的等待者会被移除，持有者释放时直接唤醒队头。取消等待者刻意不发放互斥锁（锁仍被持有）。
    2. **槽位等待支持中止与限时**（`acquireCredentialSlot`）：新增 `signal` / `dispatchTimeoutMs` 选项。Stop 现在立即结束排队中的派发（`AbortedWaitError`）；限时等待可见地失败（`WaitTimeoutError`），不再静默挂起。
    3. **丢失唤醒自愈**：排队期间每 5 秒自检一次，发现锁实际空闲就直接取锁——即使唤醒再次丢失，本事件形态也会在数秒内自愈。
    4. **派发可观测性**：每 2 分钟心跳记录队列状态（"dispatch still waiting Nm — X waiter(s), Y holder(s) … press Stop to cancel"），卡死的派发在控制台可见，而不是无声转圈。
    5. **派发重试**（adapter.ts）：槽位硬超时后释放并发槽位、可中止退避（2s→4s→…→15s）并重试（`dispatchRetries`，默认 1）；重试耗尽则让回合可见地失败并给出处理指引——绝不无限 pending。重试仅限 spawn 前的派发阶段；已经产出内容的回合绝不重跑。
    6. **限流退避 sleep** 支持中止（60 秒窗口内的 Stop 不再照常 spawn 一个没人读的回合）。
  - **配置**：新增 `dispatchTimeoutMinutes`（默认 **15** —— 每轮最多等 15 分钟，含重试总坚持 ≈ (1+重试)×15 分钟后可见失败；0 = 无限等待，仍可中止/轮询自愈/心跳可见）与 `dispatchRetries`（默认 1）。用户入口：`/agy dispatch`（查看实时队列与当前配置）、`/agy dispatch <分钟|off>` 与 `/agy dispatch-retries <次数>` —— 经 runtime overrides 持久化，下一回合生效。
  - **修复：移除人为并发限制，恢复 agy 原生并行能力。**
    - agy 是无状态 CLI，天然支持多进程并发；Windows 上唯一的机器级约束是单一凭据库，且仅在**账号身份切换**时才需要互斥。
    - **同账号快路径**（`parallelSameAccount`，默认**开**）：凭据已在槽位中的账号立即启动、完全不取互斥锁 —— N 个会话在同一账号上真并行（同一授权的并发 token 刷新是安全的，refresh token 非一次性）。`/agy parallel <on|off>` 开关。
    - **账号切换仍然串行**（正确性）：副账号先等同账号 run 全部退出再换槽位；切换等待期间拒绝新的快路径；切换完成后恢复主账号 —— 防腐蚀不变量原样保留，新增测试覆盖。
    - **`maxConcurrent` 默认 3 → 0（不限制）**：移除人为准入上限；Google 速率限制与账号池冷却是天然调节器。`/agy max-concurrent <n|off>`。
  - **修复：配额合并 —— 真实剩余被 6 小时窗口门槛挡掉。** 5 小时桶耗尽时，Google 把下一次重置报在周边界（14+ 小时后）；`is5hWindow` 门槛（重置必须落在 6 小时内）跳过了逐模型合并，于是界面持续显示粗粒度汇总端点那个无意义的"100%，now+5h 重置"占位值，而账号实际只剩 **4.06%**（2026-10-17 00:37 实测：上报重置 05:37:49 恰好等于刷新时刻+5h，而所有模型行都是 4.06% @ 15:07）。合并现在无条件取各来源中**最低**的剩余值；周额度行照常单独显示。回归测试复现了本次事故的精确数字。
  - **修复：目标完成短路吞掉了真实用户消息。** `isGoalToolContinuation` 在固定尾部窗口里"任意位置"找目标标记：目标完成后立刻发送的消息（目标工具结果还在窗口里）被当成完成跳直接空转结束——连续两次，"把相关的经验整理到agents.md" 根本没到达 agent（2026-10-17，7 秒/16 秒"已完成"但零输出）。扫描改为从末尾回溯，遇到**真实用户指令即停止**（宿主注入的文本——时间采样、system-reminder 包裹、运行时上下文——保持透明），目标标记只有在真正处于末尾时才短路。
  - **测试**：互斥锁取消后移除并唤醒下一个；超时不阻塞队列；丢失唤醒的轮询补偿；`acquireCredentialSlot` 已中止即拒绝、排队中响应 Stop、限时等待可见失败；同账号快路径 / 排空 / 防饿死；配额周边界收紧；目标延续真实消息场景。

## 0.4.58 (2026-10-16)

- **Fix: DSH `/goal` loop restart bug (autonomous runs continuing indefinitely instead of marking complete).**
  - **Root Cause**:
    1. In `src/host/mapper.ts`, whenever an agy run finished with `!ev.ok` (e.g. background EOF/network timeout right as generation finishes), it yielded `{ type: 'finish', reason: { kind: 'stop' } }` and returned early, bypassing the `supportsGoalUpdate` synthetic `update_goal` completion call even when agy generated a full, successful text response. DSH interpreted this as an uncompleted round and scheduled subsequent rounds indefinitely.
    2. In `src/index.ts`, `sessionGoal` attempted to read `session.events`, but DSH `Session` instances store events in `session.log` / `session.snapshotEvents()`, causing session goal resolution to always return `null`.
    3. In `src/host/dsh-goal.ts`, `isGoalToolContinuation` only inspected `messages[messages.length - 1]`. When DSH executes `update_goal`, it defers a `<goal_complete>` user notice (`source.kind: 'tool-goal'`), placing the tool result at `messages.length - 2` and causing agy to respawn on the completion notice.
  - **Fix**:
    1. `EventMapper.map` now unifies the finish path so `update_goal` and `exit_plan_mode` are always dispatched upon successful response generation regardless of trailing transport EOF flags.
    2. `sessionGoal` queries DSH's live `ctx.goals.get(agent)` in O(1) and falls back to `session.log` / `session.snapshotEvents()`.
    3. `isGoalToolContinuation` checks the trailing span for `agytc-bridge-goal-`, `source.kind === 'tool-goal'`, and `<goal_complete>`, finishing cleanly without respawning agy.
    4. Marked `tool-goal` and `<goal_complete>` as synthetic harness messages so they never get treated as human user instructions.

- **Fix: real-time 5-hour quota consumption and rolling countdown now accurately display instead of staying frozen at 100% / blank.**
  - **Root Cause**:
    1. Google's `retrieveUserQuotaSummary` endpoint returns coarse group-level numbers (`gemini-5h: 1.0`), while `fetchAvailableModels` reports the actual per-model 5-hour consumption and active rolling reset time (e.g. `0.70`, reset in 12 minutes). `QuotaService.refreshAccountQuota` gated the per-model tightening behind `else if (familyQuotas[fam]!.remainingFraction === undefined)`, so whenever the coarse summary returned `1.0`, active model usage was completely ignored and the family quota was locked at `100%`.
    2. In `fetchAvailableModels`, hitting any staging endpoint (`daily-cloudcode-pa`) set `this.preferredEndpointIndex`, causing subsequent `retrieveUserQuotaSummary` calls to target the staging endpoint (which omits Gemini entirely).
    3. `mergeFallbackFamilyQuota` returned stale `prev` data whenever `prev.remainingFraction` existed, freezing accounts at their 10:04 AM state (`resetTime` in the past), which caused `formatQuotaWindow` to drop the expired timestamp as empty and render no duration at all.
  - **Fix**:
    1. `fetchAvailableModels` now only sets `preferredEndpointIndex` if the endpoint is the official production endpoint (index 0).
    2. Active 5-hour model consumption (window <= 6h) now tightens `familyQuotas[fam].remainingFraction` and its `resetTime` even when summary returned a coarse `1.0`.
    3. Full-quota rows where `resetTime` has expired safely fall back to "已重置 · 可用" instead of a blank row, while active windows display the real rolling countdown (e.g. `↻ 02:50 (4小时 55分钟)`).

## 0.4.57 (2026-10-16)

### English

- **Fix: transient network jitter no longer sticky-quarantines healthy accounts as "需重新登录".**
  - **Background**: agy prints the same 939-byte "Authentication required" stderr banner whether the login is really dead OR its keyring auth merely missed its hard 10s window on a flaky network. One afternoon of proxy jitter (2026-10-16) quarantined three healthy accounts on first sight; `setActiveAccount` then refused the quarantined slot with 该账号当前不可用（冷却或需重新登录）.
  - **Changes**:
    1. **Log-evidence classification** (`src/host/agy-log.ts` + `looksLikeAuthVerificationJitter`): the adapter now snapshots agy's per-run `cli-*.log` set before spawning and reads this run's log on an auth-shaped failure. `keyringAuth: timed out after 10s` / `failed to fetch user info` / `userinfo request failed` prove a STORED credential existed and only the network was down — the failure is reclassified NETWORK (retryable, rotates, no quarantine). An authoritative token error (`invalid_grant`…) always wins over jitter. Verified against real logs: the genuine sign-out log contains zero occurrences of every jitter marker.
    2. **Confirmation-gated quarantine** (`pool.noteAuthFailure`): a bare, non-authoritative "not signed in" banner no longer sets the sticky `authRequired` flag on the first occurrence — it only rotates the account away for the current retry. The flag hardens into a real quarantine on a second consecutive failure with no success in between; a successful run resets the streak. Authoritative OAuth paths (`invalid_grant` from the token endpoint) and the explicit re-login paths still quarantine immediately.
  - **Tests**: classifier fixtures from the real jitter and sign-out logs; log-reader run attribution; single-strike / streak-reset pool semantics; end-to-end `auth-jitter` fake mode ⇒ NETWORK with no flag, bare `auth` banner ⇒ AUTH with no flag on first sight.

### 中文 (Chinese)

- **修复：瞬时网络抖动不再把健康账号错误地隔离为"需重新登录"。**
  - **背景**：无论登录是真的失效，还是 keyring 鉴权在抖动网络上没赶上 10 秒硬超时，agy 都会打印同一段 939 字节的 "Authentication required" stderr 横幅。2026-10-16 一个下午的代理抖动就让三个健康账号被一次性隔离；随后 `setActiveAccount` 对被隔离账号直接返回 该账号当前不可用（冷却或需重新登录）。
  - **变更**：
    1. **基于日志证据的分类**（`src/host/agy-log.ts` + `looksLikeAuthVerificationJitter`）：适配器在 spawn 前对 agy 的本次运行日志（`cli-*.log`）做快照，出现鉴权形态失败时读取本次日志。`keyringAuth: timed out after 10s` / `failed to fetch user info` / `userinfo request failed` 证明本地确实存有凭据、只是网络不通 —— 此时失败改判为 NETWORK（可重试、轮转、不隔离）。权威的 token 错误（`invalid_grant` 等）永远优先于抖动证据。已用真实日志验证：真正登出的日志中所有抖动标记出现次数为 0。
    2. **隔离需二次确认**（`pool.noteAuthFailure`）：不带权威证据的裸"未登录"横幅，第一次出现不再直接置粘性 `authRequired` 标记，仅为本次重试轮转走；只有连续两次失败且中间没有成功才升级为真正隔离；一次成功运行即清零计数。权威 OAuth 路径（token 端点返回 `invalid_grant`）与显式重新登录路径仍在首次即隔离。
  - **测试**：取自真实抖动/登出日志的分类器用例；日志读取器的"仅本次运行"归属；单次不隔离/成功清零的池语义；端到端 `auth-jitter` 假模式 ⇒ NETWORK 且无标记，裸 `auth` 横幅 ⇒ AUTH 且首次不隔离。

## 0.4.56 (2026-10-16)

### English

- **Feature: Gemini 4 Argon (Pro/Ultra) now shows as its own quota family with its separate weekly limit.**
  - **Background**: Antigravity now grants paid Google AI Pro / Ultra accounts access to **Gemini 4 Argon**, which bills against its OWN weekly quota pool (it does not consume the plain Gemini pool). The backend surfaces this as a dedicated quota group in `retrieveUserQuotaSummary` (display name like "Gemini 4 Argon") and as `gemini-4-argon-low/-medium/-high` model ids in `fetchAvailableModels`.
  - **Changes**:
    1. Added a new `'argon'` entry to `ModelFamily`; `modelFamilyOf` now classifies any id containing `argon` into it BEFORE the generic `gemini-` gate — previously argon ids folded into the `google` family and their usage silently drained/reported the plain Gemini counter.
    2. `QuotaService.refreshAccountQuota` detects the Argon quota group (its display name still contains "gemini", so the argon gate must win) and ingests its weekly bucket into `quotas.argon`; argon model-level breakdown follows the same family.
    3. GUI quota panel: an **Argon** row renders directly under Gemini ONLY when the backend actually returned argon quota data for that account — free plans and accounts without the Argon permission never see an empty Argon panel. Since Argon is a weekly-only counter today, the ghost "5-hour / —" line is suppressed unless the backend reports one.
    4. `/agy pool` status appends `| Argon N% (weekly)` to the Quota line only for accounts that carry argon data.
    5. Cross-family auto-failover (`autoFallbackModel`) intentionally does NOT target the argon family: it is a paid-plan-only pool and must not become a silent fallback for exhausted Gemini quota.
  - **Tests**: argon model-id classification; argon summary group lands in `quotas.argon` without clobbering `quotas.google`; accounts without argon access carry no argon entry (row hidden).

### 中文 (Chinese)

- **功能：Gemini 4 Argon（Pro/Ultra 专属）现在作为独立的额度家族展示，并显示其单独的周额度。**
  - **背景**：Antigravity 已向付费 Google AI Pro / Ultra 账号开放 **Gemini 4 Argon**，它消耗独立的周额度池（不占用普通 Gemini 额度）。后端在 `retrieveUserQuotaSummary` 中以独立的额度组返回（显示名形如 "Gemini 4 Argon"），并在 `fetchAvailableModels` 中返回 `gemini-4-argon-low/-medium/-high` 模型 ID。
  - **改动**：
    1. `ModelFamily` 新增 `'argon'`；`modelFamilyOf` 在通用 `gemini-` 前缀判定**之前**优先识别包含 `argon` 的 ID —— 此前 argon 模型会被归入 `google` 家族，其用量会错误地挤占/上报普通 Gemini 计数。
    2. `QuotaService.refreshAccountQuota` 识别 Argon 额度组（其显示名仍包含 "gemini"，因此 argon 判定必须优先）并把周额度桶写入 `quotas.argon`；模型级明细同样按该家族归类。
    3. GUI 额度面板：仅当后端确实返回了该账号的 argon 额度数据时，才在 Gemini 下方渲染 **Argon** 面板 —— 免费套餐及无 Argon 权限的账号绝不会看到空的 Argon 栏。由于 Argon 目前只有周额度，后端未上报 5 小时窗口时不再显示幽灵的「5 小时额度 —」行。
    4. `/agy pool` 状态输出仅为携带 argon 数据的账号在 Quota 行尾追加 `| Argon N% (weekly)`。
    5. 跨家族自动故障转移（`autoFallbackModel`）刻意不指向 argon 家族：它是付费专属额度池，不应在 Gemini 额度耗尽时被静默兜底。
  - **测试**：argon 模型 ID 分类；argon 额度组写入 `quotas.argon` 且不覆盖 `quotas.google`；无 argon 权限的账号不产生 argon 条目（面板隐藏）。

---

## 0.4.55 (2026-10-16)

### English

- **Fix: Gemini weekly quota displaying as empty/dash (`—`) after sync.**
  - **Root Cause**: `AGY_ENDPOINTS` placed Google's internal staging endpoint (`https://daily-cloudcode-pa.googleapis.com`) ahead of the official production endpoint (`https://cloudcode-pa.googleapis.com`). While the staging endpoint responds HTTP 200, its `retrieveUserQuotaSummary` output completely omits the `Gemini Models` group (returning only `Claude and GPT models`). Consequently, `QuotaService.fetchQuotaSummary` took the 200 response and locked onto the staging endpoint; `familyQuotas['google']` never received the server's weekly bucket and fell back to model-level 5-hour discovery data (`weeklyFraction: undefined`), resulting in the UI rendering Gemini's weekly quota as `—`.
  - **Resolution**:
    1. Reordered `AGY_ENDPOINTS` to prioritize the official production endpoint `https://cloudcode-pa.googleapis.com`, matching the official `agy` CLI binary.
    2. Added a completeness gate in `fetchQuotaSummary`: if an endpoint returns a partial summary that omits the primary `Gemini Models` group, `QuotaService` continues falling through to the remaining endpoints until a complete summary is obtained, rather than locking onto the partial staging response.
- **Feature/Fix: auto-repair common LLM Mermaid syntax flaws and graceful fallback.**
  - **Auto-repair (`repairMermaidSource`)**: When models produce flowchart/graph diagrams with common pseudo-code syntax flaws (e.g. using `+` to join nodes `A + B --> C + D` instead of `A & B --> C & D`, unquoted subgraph titles with colons/spaces like `subgraph 链条1: 工具打制`, or node labels containing unquoted special characters like `T[人口 > 12]`, `S[私有制: 守罐人]`), the client-side renderer now automatically heals these patterns before passing to Mermaid, enabling diagrams to render successfully without errors.
  - **Graceful fallback for auto-sniffed blocks**: If an unrecognized code block (`代码块`) sniffed as Mermaid fails parsing even after auto-repair, the plugin now silently falls back to displaying it as a normal clean code block without rendering an intrusive `Mermaid render failed:` error banner under it.

- **Fix: DSH "Stop generating" (停止生成) button failing in multi-turn tool continuation spans and queues.**
  - **Root Cause**: While single-turn initial spans wired `options.signal` to process termination, tool continuation spans (`detectContinuation(messages) !== null`) and live run debounce rescue invoked `driveSpan` without forwarding `options.signal`. Furthermore, `driveSpanBody` lacked an `abort` event listener, causing the generator to wait indefinitely on `rec.eventsFrom(from)` even when DSH signaled an abort. Similarly, queued requests blocked on `Semaphore.acquire()` did not observe `signal` cancellations.
  - **Resolution**:
    1. Forwarded `options.signal` across all `driveSpan` callsites (continuation, debounce rescue, and initial span).
    2. Attached an `abort` listener in `driveSpanBody` that immediately calls `rec.requestAbort?.()`, terminates the underlying `agy` process, pushes `{ type: 'finish', reason: { kind: 'aborted' } }` into the chunk queue, and closes the stream iterator cleanly.
    3. Added `signal` cancellation support to `Semaphore.acquire(signal)` and burst throttle backoff to release queued requests immediately upon abort.
- **Fix/Feature: Mermaid rendering swallowing source code, wide layout collapse, and interactive view toggle.**
  - **Root Cause**:
    1. Language detection in `fenceLang` matched DSH's generic banner text `"代码块"`, erroneously treating explicitly tagged ````mermaid```` blocks as untagged generic blocks.
    2. Large multi-subgraph flowcharts using Chromium's default `<foreignObject>` HTML labels collapsed into invisible blank boxes when constrained by `max-width: 100%`.
    3. When Mermaid rendering threw or produced an error SVG, the CSS rule hiding code blocks paired with the suppression of error text resulted in swallowing all content—leaving a completely blank white container.
  - **Resolution**:
    1. Corrected `fenceLang` to inspect code block classes and attributes before falling back to banner labels.
    2. Configured Mermaid with `flowchart: { htmlLabels: false }` to render reliable native SVG `<text>` elements, eliminating the Chromium `<foreignObject>` blank-paint bug.
    3. Added an interactive `查看源码 / 查看图表` toggle button allowing users to switch between the visual diagram and raw Mermaid source code at any time.
    4. Guarded against swallowed content: when rendering fails, the original code remains 100% visible alongside a subtle warning banner, ensuring source content is never lost.

### 中文 (Chinese)

- **修复：DSH 界面中点击「停止生成」在多轮工具调用延续期失效的问题。**
  - **根本原因**：在首轮对话中 `options.signal` 正确绑定了进程终止，但在原生工具镜像调用的后续延续轮次（`detectContinuation` 分支）以及防抖拯救调用中，`driveSpan` 均未向下传递 `options.signal`。此外，`driveSpanBody` 内部没有监听 `signal.abort` 事件，导致用户在 DSH 点击停止时，生成器依旧停在 `eventsFrom` 等待事件流，后台进程未被杀死，界面停止按钮卡住无效。同时跨会话并发信号量 `Semaphore.acquire()` 在排队等待时也未响应取消信号。
  - **解决方案**：
    1. 在所有 `driveSpan` 调用处（工具延续、防抖拯救、首轮启动）完整传递 `options.signal`。
    2. 在 `driveSpanBody` 挂载 `abort` 监听器：一旦收到取消信号，立即触发 `rec.requestAbort?.()` 杀死底层 `agy` 进程，向输出队列推送 `{ type: 'finish', reason: { kind: 'aborted' } }` 并安全关闭队列，使 DSH 的流式迭代器瞬间退出。
    3. 升级 `Semaphore.acquire(signal)` 及并发节流延时，支持在排队中收到 abort 信号时立即退出并清理队列，杜绝无意义挂起。
- **修复/功能：Mermaid 图表内容被吞、超宽图表缩放空白及源码交互式切换。**
  - **根本原因**：
    1. `fenceLang` 语言嗅探提取到了 DSH 顶部横幅文本 `"代码块"`，导致显式声明为 ````mermaid```` 的图表被误当成未指定语言的通用块。
    2. Mermaid 默认使用 HTML `<foreignObject>` 标签渲染文本，在 Chromium / Electron 宿主中遇到多子图超宽流程图（如 >3000px）并应用 `max-width: 100%` 缩放时，极易发生文本排版崩溃或整体空白不渲染的 bug。
    3. 当 Mermaid 渲染报错或生成空图时，由于隐藏原生代码块的 CSS 规则生效且错误提示被隐藏，导致原始代码和图表全部消失，形成一片空白区域（内容被吞）。
  - **解决方案**：
    1. 修正 `fenceLang`：优先读取 `code` 标签 class 及属性，忽略无意义的横幅标签 `"代码块"`。
    2. 优化渲染配置：初始化 Mermaid 时启用 `flowchart: { htmlLabels: false }`，使用原生 SVG `<text>` 渲染节点，彻底规避 Chromium `<foreignObject>` 缩放渲染空白的底层缺陷。
    3. 增加交互式切换工具栏：在渲染图表右上角提供「查看源码 / 查看图表」按钮，用户可随时一键切换查看 Mermaid 原始 Markdown 代码与可视化图表。
    4. 兜底保护机制：若渲染异常，确保原始代码块 100% 完整保留可见，并在上方以友好提示条展示，绝不吞没用户和模型的内容。

- **修复：点击「同步」后 Gemini 周额度显示为空/短横杠（`—`）的问题。**
  - **根本原因**：`AGY_ENDPOINTS` 此前将 Google 内部预演端点（`https://daily-cloudcode-pa.googleapis.com`）排在官方生产端点（`https://cloudcode-pa.googleapis.com`）之前。虽然预演端点返回 HTTP 200，但其 `retrieveUserQuotaSummary` 响应中完全缺失了 `Gemini Models` 额度组（仅返回了 `Claude and GPT models`）。这导致 `QuotaService.fetchQuotaSummary` 命中 200 后锁定该端点，`familyQuotas['google']` 无法获取到官方周配额桶，只能回退使用单模型 5 小时数据（`weeklyFraction` 始终为 `undefined`），前端进而将 Gemini 的周额度渲染为 `—`。
  - **解决方案**：
    1. 调整 `AGY_ENDPOINTS` 顺序：优先请求与官方 `agy` CLI 保持一致的官方生产端点 `https://cloudcode-pa.googleapis.com`。
    2. 增强 `fetchQuotaSummary` 完整性校验门禁：若端点返回的配额摘要缺失了核心的 `Gemini Models` 组，自动顺次下穿到后续端点获取完整摘要，不再过早锁定仅包含第三方模型的残缺响应。
- **功能/修复：Mermaid 常见大模型语法自动自愈修复与优雅降级。**
  - **语法自动自愈（`repairMermaidSource`）**：针对大模型输出流程图时高频出现的伪代码语法瑕疵（例如材料合成中用加号连接 `A + B --> C + D`、包含冒号的子图未加引号 `subgraph 链条1: 工具打制`、节点文本包含特殊字符未加引号 `T[人口 > 12]`、`S[私有制: 守罐人]` 等），客户端在解析前自动自愈修正，直接成功渲染图表。
  - **自动嗅探代码块优雅降级**：对于未显式标注为 ````mermaid```` 的通用代码块（语言标签为 `代码块` 或未指定），若自愈后仍无法解析，安静降级为普通代码块展示，不再在代码下方直接打印刺眼的 `Mermaid render failed:` 错误文本。

## 0.4.54 (2026-10-16)

### English

- **Fix (macOS): complete resolution for recurring modal keychain password prompts.** Older versions (v0.4.41-v0.4.48) accidentally ran `security default-keychain -s <isolated-kc>`, permanently redirecting the user's desktop session `default-keychain`, `login-keychain`, and user search list (`list-keychains -d user`) to a locked per-account keychain under `~/.dsh/agy-accounts/` created with an un-unlockable random passphrase. On modern macOS, `Library/Keychains/login.keychain-db` is also a special-cased filename that SecurityServer associates with the user's OS login password, rejecting empty-passphrase unlocks. The plugin now:
  1. Automatically detects and repairs hijacked `default-keychain`, `login-keychain`, and `list-keychains` on boot (`repairMacSystemKeychain`), restoring the real user login keychain (`~/Library/Keychains/login.keychain-db`) safely and idempotently.
  2. Automatically purges legacy un-unlockable isolated keychains (`purgeStaleIsolatedKeychain`), unregistering them from `securityd` and deleting conflicting files so SecurityAgent never raises unanswerable password dialogs.
- **Feature (Multi-platform): comprehensive cross-platform logic unification.**
  1. **Unified Terminal Launcher (`openAccountTerminal`)**: Fully unified interactive terminal launching across macOS (AppleScript Terminal.app), Windows (`cmd.exe /c start` with `USERPROFILE` + `HOME` environment and `windowsHide: true`), and Linux (adaptive detection across `xdg-terminal-exec`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `alacritty`, `xterm`).
  2. **Unified System Proxy Detection (`detectSystemProxy`)**: Automatically discovers system-wide proxy settings for GUI environments where shell env vars are missing—supporting macOS (`scutil --proxy`), Windows Registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`), Linux desktop (`gsettings` GNOME proxy mode), and fallback environment variables (`ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`).
  3. **Cross-Platform Credential Isolation**: Standardized credential boundaries across platforms—Windows Credential Manager targeted isolation, macOS isolated throwaway keychains with auto-repair, and standard Unix file-based isolation.

### 中文 (Chinese)

- **修复（macOS）：彻底解决钥匙串密码弹窗反复弹出问题。** v0.4.41-v0.4.48 曾调用 `security default-keychain -s <isolated-kc>`，导致用户的桌面会话全局 `default-keychain`、`login-keychain` 以及用户搜索列表被持久化重定向到了 `~/.dsh/agy-accounts/` 下由旧版本生成的随机密码隔离钥匙串中。此外 macOS 的 SecurityServer 会对名为 `login.keychain-db` 的路径做特殊绑定，强制要求系统用户登录密码，导致空密码解锁失败并引发系统 SecurityAgent 弹窗提示输入密码。本次修复：
  1. 插件启动时自动执行 `repairMacSystemKeychain`：检测并修复被篡改的 `default-keychain`、`login-keychain` 与用户搜索列表，自动恢复为用户真实的登录钥匙串（`~/Library/Keychains/login.keychain-db`），幂等且安全。
  2. 自动检测并清理历史遗留的无法解锁的废弃钥匙串（`purgeStaleIsolatedKeychain`），从 `securityd` 会话中彻底注销并删除文件，阻断 SecurityAgent 弹出任何死循环密码框。
- **功能（多平台）：全面梳理并实现 Windows、macOS、Linux 跨平台逻辑统一。**
  1. **多平台统一终端唤醒器（`openAccountTerminal`）**：彻底统一账号登录终端的唤醒逻辑，原生支持 macOS（AppleScript 激活 Terminal.app）、Windows（`cmd.exe /c start` 注入 `USERPROFILE` + `HOME` 隔离目录并设置 `windowsHide: true` 避免控制台闪烁）以及 Linux（自适应探测 `xdg-terminal-exec`、`x-terminal-emulator`、`gnome-terminal`、`konsole`、`xfce4-terminal`、`alacritty`、`xterm` 等各种桌面环境）。
  2. **多平台系统代理自动感知（`detectSystemProxy`）**：针对 GUI 宿主未继承终端 Shell 代理环境变量的场景，全面支持三端系统级代理自动检测——macOS（`scutil --proxy` 解析 HTTP/HTTPS/SOCKS）、Windows（读取注册表 WinINet Internet Settings 代理设置）、Linux（通过 `gsettings` 读取 GNOME 桌面代理配置）以及标准环境变量兜底。
  3. **多平台凭据与隔离统一**：规范各端凭据存储边界——Windows 使用 Credential Manager 目标隔离、macOS 使用独立钥匙串配给加自愈防篡改机制、Linux 使用标准 Unix 用户目录隔离。

## 0.4.53 (2026-10-15)

### English

- **Fix: a NUL byte in a tool result can no longer kill the turn before agy starts.** Tool output that quoted binary content (an agent listing or reading a `.git` directory, a packed object, an image) carried U+0000 into the assembled prompt; because the prompt travels as an `-p` argv element, `spawn()` rejected it with `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[16]' must be a string without null bytes` and the turn failed as "failed to spawn agy" before agy was ever launched — the retry re-sent the same history and failed identically, so the session could not make progress. `stripNulBytes()` now removes U+0000 from the rolling digest (per message text), from the final prompt on its single path into `buildArgs` — covering both the argv transport and the `--input-format stream-json` stdin transport — and from the one-shot/compaction prompt after file inlining. Every other control character is legal in argv and is left untouched.

### 中文 (Chinese)

- **修复：工具结果里的 NUL 字节不再让整个轮次在 agy 启动前就崩溃。** 当工具输出引用了二进制内容（agent 列出或读取 `.git` 目录、packed object、图片等）时，U+0000 会被带进拼装好的提示词；提示词以 `-p` 参数进入 argv，`spawn()` 因此抛 `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[16]' must be a string without null bytes`，整轮以「failed to spawn agy」失败——重试会重发同一段历史，于是同样失败，会话彻底卡死。现在 `stripNulBytes()` 会从三处移除 U+0000：滚动摘要中每条消息的文本、进入 `buildArgs` 前的最终提示词（同时覆盖 argv 与 `--input-format stream-json` 的 stdin 两种传输）、以及一次性/压缩任务内联文件后的提示词。其余控制字符在 argv 中合法，保持原样。

## 0.4.52 (2026-10-15)

### English

- **Fix: DSH `/goal` infinite continuation loop resolved.** In DSH, `/goal` runs a multi-round state machine (up to 256 rounds) that keeps injecting `<goal_round>` until the agent explicitly invokes `update_goal(action='complete')`. Because `agy` CLI uses its own native tools and terminates after finishing, DSH treated the goal as perpetually active (running up to 93+ rounds). The bridge now intercepts the completion event in goal mode and emits a synthetic `update_goal(complete)` tool-call, properly closing the goal state machine.
- **Feature: DSH `/plan` mode support.** When running in plan mode (prompt containing "You are in plan mode"), the bridge automatically emits the `exit_plan_mode` tool-call carrying the generated plan markdown for user interactive review and approval.
- **Feature: /agy goal command family.** Added `/agy goal [status|complete|pause|resume|clear]` allowing users to inspect the current goal state (ID, revision, objective, round count) or manually control/complete/clear the active goal.
- **Feature: /agy session command family.** Added `/agy session [info|clear]` for inspecting session workspace CWD, bound agy conversation ID, event counts, and safely dropping session bindings without guessing. `/agy clear` is also upgraded to prioritize the current session.
- **Feature: Intelligent quota-expiry-first rotation (Weekly & 5h).** Refactored pool candidate selection: when switching accounts, the pool prioritizes accounts whose weekly quota is expiring soonest (Priority 1: preventing irreversible weekly quota loss), followed by accounts whose 5-hour quota is expiring soonest (Priority 2). Execution maintains seamless sticky sequential drain, continuing on the current account until its quota is exhausted before cleanly advancing to the next optimal candidate.
- **UI: Simplified thinking turn banner.** Replaced verbose `[agy thinking turn · N thinking tokens]` chip with concise `[agy · N tokens]` (or `[agy]` when no count is present), avoiding long headers crowding out the collapsed reasoning summary in DSH.
- **UI: Removed redundant "Set as primary" action.** Dropped the confusing "Set as primary" button from the account cards across all locales. Manual account activation is cleanly handled via the existing "Set as in use" action.

### 中文 (Chinese)

- **修复：彻底解决 DSH `/goal` 目标空转死循环问题。** DSH 的 `/goal` 状态机在模型未调用宿主原生 `update_goal(action='complete')` 前，会在每轮结束后自动注入 `<goal_round>` 启动下一轮（最多 256 轮，曾导致 93+ 轮空转）。由于 agy 是自闭环 Agent 引擎，完成任务后正常退出但不会直接调用 DSH 宿主工具。桥接层新增 `dsh-goal` 协议转换模块，在检测到目标轮次执行完毕后，自动向 DSH 发射 `update_goal(complete)` 工具调用块，使 DSH 目标状态机正常流转至完成态并停止重试。
- **功能：支持 DSH `/plan` 规划模式适配。** 当检测到会话处于规划模式（上下文携带 "You are in plan mode"）时，桥接层在模型生成规划后自动发射 `exit_plan_mode` 工具调用块，将规划 Markdown 提交给 DSH 宿主渲染审核弹窗供用户审批。
- **功能：新增 `/agy goal` 目标管理命令。** 支持 `/agy goal [status|complete|pause|resume|clear]`，可实时查看当前会话的目标状态（目标 ID、版本号、目标描述、已执行轮次/上限），或手动完成、暂停、恢复、清除卡住的目标。
- **功能：新增 `/agy session` 会话管理命令。** 支持 `/agy session [info|clear]`，可精确查看当前 DSH 会话绑定的工作区 CWD、agy 会话 ID、事件总数等信息，或一键清除当前会话的 agy 绑定；同时增强 `/agy clear` 优先清理当前活动会话的绑定。
- **功能：按配额临期优先度智能轮换账号（周额度优先，5小时次优）。** 重构账号轮换调度算法：在切号时，第一优先级优先选取周额度剩余时间最少（最先到期）的账号（避免周硬额度清零浪费），第二优先级选取 5 小时窗口最先到期的账号；同时严格遵循无感黏性消耗原则（只要当前账号的 5 小时或周额度未耗尽绝不切号，耗尽后自动无缝切换下一个最优账号），最大化利用全部账号配额。
- **体验：精简思考过程标签（thinking banner）。** 将冗长的 `[agy thinking turn · N thinking tokens]` 简化为精炼的 `[agy · N tokens]`（无计数时为 `[agy]`），大幅缩减括号内字符宽度，让 DSH 折叠思考栏能够更完整展现具体的思维链与工具摘要。
- **体验：移除冗余的“设为主用”按钮。** 从前端控制台卡片操作栏和各语言包中彻底移除“设为主用”按钮，手动切换账号统一由“设为当前使用”负责，简化界面操作。

## 0.4.51 (2026-10-15)

### English

- **Feature: Per-account Enable / Disable toggles.** Added dedicated Enable / Disable buttons and status badges to each account card in the WebUI console and CLI (`/agy enable-account <id>`, `/agy disable-account <id>`). Disabled accounts are dimmed with a gray "Disabled" badge.
- **Fix: Account rotation and selection strictly skips disabled accounts.** Rotation algorithms (`selectAccount`, `advanceAccount`, sticky sequential drain, round-robin, and fallback model degradation) skip disabled accounts completely.
- **Fix: Cooldown & quota reset fallback never returns a disabled account.** `getActiveAccountId` previously fell back to `primaryAccountId` or the first account without checking `enabled`, which could surface a disabled slot as active; it now only falls back to eligible enabled accounts (or `undefined` if all accounts are disabled).
- **Fix: Background auth reverification skips disabled accounts.** `needsAuthReverify` now checks `account.enabled`, preventing the background quota poller from probing disabled slots.
- **Fix: Detailed error diagnostics when accounts are disabled.** When all or remaining accounts cannot serve a model family, the error message explicitly enumerates disabled slots and informs the user to re-enable them in the console or CLI rather than reporting misleading 0 cooldown/auth counts.

### 中文 (Chinese)

- **功能：每个账号增加启用 / 停用按钮。** 在 WebUI 控制台的每个账号卡片上以及 CLI 命令中增加了启用/停用按钮与操作（`/agy enable-account <id>`、`/agy disable-account <id>`）。停用账号卡片以半透明呈现并标记灰色“已停用”徽章。
- **修复：切号与调度严格跳过停用账号。** 顺次耗尽（sequential）、轮询（round-robin）、主动切号（advanceAccount）、跨家族自动降级（autoFallbackModel）等调度算法在选号时全部严格跳过已停用账号。
- **修复：号池活动指针降级不再回退到已停用账号。** 修复了 `getActiveAccountId` 在全部账号限流时无条件 fallback 到主账号或首个账号导致停用账号被当作当前在用账号的缺陷；现在严格仅回退到已启用的账号（若全部账号均被停用则返回 `undefined`）。
- **修复：后台静默身份复验跳过已停用账号。** `needsAuthReverify` 增加了 `account.enabled` 检查，彻底杜绝后台轮询向 Google 请求复验已停用账号。
- **修复：账号不可用时清晰提示停用状态。** 当全部或部分账号不可用时，错误提示中会明确指出有几个账号处于“已停用”状态，并提示用户在控制台或通过 CLI 重新启用，不再报出误导性的 0 冷却/0 登录错误。

## 0.4.50 (2026-10-14)

### English

- **Fix: the header badge now names the same account as the console.** The session header applied an eligibility fallback chain (any enabled account, else `accounts[0]`) when the server-scheduled slot was cooling down or auth-flagged, so it displayed a DIFFERENT account than the console modal's "in use" badge. The header is a readout, not a picker: it now displays exactly `pool.activeAccountId`, with the dot turning red/amber for auth-required/cooldown states.

### 中文 (Chinese)

- **修复：顶栏徽章与控制台显示同一个账号。** 当服务端调度的账号处于冷却或被标记时，会话顶栏会走降级链（任选其他合格账号，再不行取第 1 个），导致与控制台弹窗的"当前使用"徽章显示不同的账号。顶栏是状态显示器而不是选择器：现在严格显示 `pool.activeAccountId`，账号需重新登录/冷却中时圆点相应变红/变黄。

## 0.4.49 (2026-10-14)

### English

- **Removal: Gemini Web (chat.gemini.google.com) account support is gone.** The whole web-login feature was removed per user request: the reverse-engineered web client, isolated-profile browser capture, the five `/plugins/agy-link/pool/*` web routes, the web execution branch in the adapter, web quota handling, all `web.*` UI (type switcher, browser picker, capture progress, test/re-login buttons, Web badge) and locale strings. Legacy `gemini-web` entries in `pool.json` are dropped automatically on load, with dangling active/primary pointers cleaned up. Existing AGY accounts are untouched.
- **Fix (macOS): keychain password popups are gone for good.** `ensureIsolatedKeychain` never touches the user's global `default-keychain` / search list anymore (the per-account isolated keychain under the account HOME is enough), and `readMacKeychainToken` now targets the real `~/Library/Keychains/login.keychain-db` explicitly instead of whatever the hijacked default pointed at. Stale locked keychains from the pre-0.4.45 random-password era should be deleted once — they are unanswerable prompts by construction.
- **Fix: a dead agy child can no longer crash the whole DSH host.** EPIPE on child stdin arrives asynchronously as an `error` event (the old `try/catch` only guarded sync throws); `startAgyProcess` now attaches a no-op error handler so a `WriteWrap.onWriteComplete write EPIPE` uncaughtException — and the crash dialog — cannot happen from our spawns.
- **Fix: "needs re-login" no longer shows for healthy accounts.** The Gemini-Web error path flagged accounts on bare `401`/`403`/`unauthorized` substrings, quarantining healthy slots whenever transport noise happened to contain those digits; flagged accounts skip background polling, so only a manual sync could disprove the flag. The web branch is gone entirely, and the auth-flag classifier keeps its transport-noise exemptions.
- **Fix: the header badge no longer flashes "AGY (0)" with a grey dot.** The status snapshot is now persisted in `localStorage` and preloaded on mount (stale-while-revalidate), so session switches render the last known account immediately; the truly-cold first render shows a neutral `AGY` placeholder instead of a misleading zero count.

### 中文 (Chinese)

- **移除：Gemini 网页端（chat.gemini.google.com）账号支持。** 应用户要求整体移除网页登录功能：逆向网页客户端、独立 Profile 浏览器捕获、5 个 `/plugins/agy-link/pool/*` 网页路由、adapter 中的网页执行分支、网页配额处理、全部 `web.*` 界面（类型切换、浏览器选择、捕获进度、测试连接/重新登录按钮、Web 徽章）与语言串。`pool.json` 中遗留的 `gemini-web` 账号会在加载时自动剔除，悬空的 active/primary 指针同步清理；现有 AGY 账号不受影响。
- **修复（macOS）：钥匙串密码弹窗彻底消失。** `ensureIsolatedKeychain` 不再触碰用户全局的 `default-keychain` / 搜索列表（账号 HOME 下的隔离钥匙串已足够）；`readMacKeychainToken` 显式指向真实的 `~/Library/Keychains/login.keychain-db`，不再受被篡改默认值影响。0.4.45 之前随机密码时代遗留的锁定钥匙串需手动删除一次——它们天然是无法回答的弹窗。
- **修复：agy 子进程死亡不再拖垮整个 DSH 宿主。** 子进程 stdin 上的 EPIPE 以异步 `error` 事件到达（旧的 `try/catch` 只能挡同步异常）；`startAgyProcess` 现在挂载 no-op 错误监听，`WriteWrap.onWriteComplete write EPIPE` 不可捕获异常与崩溃弹窗不会再由我们的拉起触发。
- **修复：健康账号不再显示"需重新登录"。** 网页版错误路径曾用裸 `401`/`403`/`unauthorized` 子串拉黑账号，传输噪音消息里碰巧带这些数字就隔离健康槽位；被标记账号会被后台轮询跳过，只有手动同步能翻案。该分支已整体移除，拉黑分类器保留传输噪音豁免。
- **修复：顶部徽章不再闪烁灰色 `AGY (0)`。** 状态快照现在持久化到 `localStorage` 并在挂载时预加载（stale-while-revalidate），切换会话立即显示上次的账号；真正冷启动的首帧显示中性 `AGY` 占位，而不是误导性的 0 计数。

## 0.4.48 (2026-10-13)

### English

- **Feature: Google Account email retrieval & verification.** Enhanced browser login CDP extraction and `extractSnlm0e` regex across multi-language Google interfaces (including Chinese `Google 账号 / 帐号`, `WIZ_global_data`, and custom workspace domains). Verified emails are automatically saved and displayed as an email badge on account cards upon addition and connection testing.
- **Feature: Isolated per-account browser profiles.** Each Gemini Web account now runs in a dedicated, isolated browser profile directory (`~/.dsh/agy-accounts/<accountId>/browser-profile`). Multiple accounts maintain independent cookie jars, session stores, and locks, eliminating session cross-contamination and allowing seamless multi-account management.
- **Feature: Dynamic Gemini Web build (`bl`) & update sniffing.** Live sniffing of Google's frontend build label (`bl`, e.g. `boq_assistant-bard-web-server_...`) directly from HTML during login, connection tests, and periodic probes, dynamically passed to `StreamGenerate` RPC. Stale sessions, cookie expirations, and token rotations are automatically detected, with immediate UI alerts and a dedicated re-login button.
- **Feature: Dedicated proxy URL for Antigravity OAuth login.** Added a per-account proxy URL configuration input to the Google Antigravity OAuth tab, consistent with Gemini Web accounts, ensuring reliable authentication in domestic network environments.
- **Feature: Direct model mapping & removed `gemini-3.1-pro` fallback.** Removed the fictional `gemini-3.1-pro` fallback and purged it from `DEFAULT_FALLBACK_MODELS`. Requests directly preserve and map to the exact model selected by the user.
- **Feature: Real-time dynamic model catalog.** Wired `ModelCatalog` updates to notify DSH via `notifyPicker()` (`llm/adapters-updated`), and integrated automatic background refreshes so newly discovered `agy` models immediately appear in the DSH model picker without restarting DSH.
- **Feature: Active model synchronization with DSH composer picker.** When model auto-failover, default resolution, or Gemini Web mapping switches the active model, the new model is synchronized back to the active DSH session (`model/selection`), updating the model chip in the bottom-right corner of the composer.
- **Fix: Eliminated modal screen flickering and refresh loop.** Implemented singleton portal mounting (`registerModalInstance` / `unregisterModalInstance`), moved global modal styles out of the React render tree into a one-time `<head>` injection, and added payload equality guards (`isStatusEqual`) on polling intervals to eliminate duplicate renders and flickering.

### 中文 (Chinese)

- **新增特性：Google 账号邮箱回显与连通性验证。** 全面强化 CDP 浏览器捕获与 `extractSnlm0e` 正则解析，支持中文界面（`Google 账号 / 帐号`）、`WIZ_global_data` 及任意域名 Google 邮箱；添加与测试连接时均自动保存并回显邮箱徽章于卡片上。
- **新增特性：每个账号完全独立的浏览器隔离 Profile。** 每个 Gemini 网页端账号分配并持久化独占的 profile 目录（`~/.dsh/agy-accounts/<accountId>/browser-profile`）；多账号各自拥有独立 Cookie、会话与锁文件，多账号并行登录或切换互不干扰、互不污染。
- **新增特性：动态嗅探 Gemini 官方最新构建版本（`bl`）与状态。** 实时从页面嗅探 Google 最新前端构建版本号（`bl`，如 `boq_assistant-bard-web-server_...`）并动态传递至 `StreamGenerate` RPC；自动捕获 Session 状态变化与凭据失效，卡片提供一键「重新登录」按钮。
- **新增特性：Google Antigravity（OAuth 授权）独立代理配置。** 在 Google Antigravity 添加弹窗中新增独立代理 URL 输入框，与网页端账号保持一致，国内网络环境下直连或代理灵活切换。
- **新增特性：模型精准直接映射与彻底移除 `gemini-3.1-pro`。** 彻底移除虚构的 `gemini-3.1-pro` 强制降级逻辑，并从系统默认候选模型中删除；用户选择什么模型就直接映射到什么模型，原汁原味。
- **新增特性：模型列表无需重启 DSH 实时刷新。** 将 `ModelCatalog` 更新与 `notifyPicker()` (`llm/adapters-updated`) 连通，并引入定期检测与触发式刷新；agy 本地更新模型后，DSH 输入框模型选择器即时自动呈现最新列表，无需重启应用。
- **新增特性：自动切模型实时回显到 DSH 输入框右下角。** 当额度耗尽自动切模型、默认模型解析或网页端模型映射发生时，自动向当前会话广播同步 `model/selection`，使 DSH 右下角模型选框即时同步回显当前真实运行的模型。
- **优化与修复：彻底解决控制台频繁刷新与闪屏问题。** 引入弹窗单例守卫（`registerModalInstance` / `unregisterModalInstance`）防止多头部重复挂载，将全局样式抽离至 `<head>` 单次注入避免全页重排，并在轮询时加入状态深比较（`isStatusEqual`）杜绝无效渲染。

## 0.4.47 (2026-10-13)

### English

- **Merge (2026-10-13): the recovered working tree is back on top of 0.4.46, and Windows pool-credential isolation is real again.** Upstream's line stays the baseline (adapter spawn-window slot ownership, async keychain/Credential-Manager reads, desktop thinking visibility #43, the vendored mermaid renderer with no CDN fallback plus its error-bomb sweep, model visibility, pool/data hardening). Restored on top of it: the Windows Credential Manager handoff described below, the local `/plugins/agy-link/media` route with the image lightbox and decision chips, Windows system-proxy auto-detection (WinINet registry), the pool corruption diagnostics/repair scripts, and the `src/host/wincred.ts` primitives. Merge calls worth knowing: `runner.ts`, `assets/mermaid.min.js`, `src/client/mermaid.ts` and the proxy/keychain test take upstream (equivalent fixes, already hardened — the duplicate mermaid renderer and its tests were dropped); `quota.ts` keeps upstream's async read *and* the durable-store-first primary resolution; the `credentialIsolationLimited` warning (status field, adapter log, settings banner, four locale strings) is gone now that rotation isolates credentials; and the real Credential Manager slot is never touched under `node:test`.
- **Fix (critical): multi-account pools no longer cross-contaminate credentials on Windows, and quota failover works again.** On Windows, `agy.exe` resolves its Google credential from ONE process-global store (Credential Manager target `gemini:antigravity`); `HOME`/`USERPROFILE` are ignored, so a per-account directory does not isolate credentials the way a per-account Keychain does on macOS. The previous handoff logic corrupted a real pool: all four accounts ended up holding the primary's refresh token, every quota row reported the same identity, and clicking "refresh/sync" appeared to replace the main account. Three defects were fixed:
  - The handoff snapshotted "whatever is currently in the slot" as the primary backup. A secondary run could therefore overwrite the backup with a secondary credential, and the next restore installed that secondary as the system-wide login. The primary credential is now resolved from a durable, identity-VERIFIED store (`agy-accounts/.primary-credential.json`) and is never inferred from the live slot.
  - The restore step wrote the slot's content back into the account's token file whenever it differed. While another account owned the slot this copied a FOREIGN credential into the account file. Write-back now requires that the slot still carries THAT account's refresh token; otherwise nothing is written and a warning is logged.
  - Nothing serialized slot ownership, so interactive runs, background quota polls and manual refreshes raced. A process-wide FIFO mutex (`AsyncMutex`) now spans the entire run.
- **Add: a run is refused instead of silently using the wrong account.** `acquireCredentialSlot` throws `SlotUnavailableError` (surfaced as `AGY_ERROR`) when the slot cannot be handed back safely: the primary credential cannot be verified, the secondary has no credential, or the secondary holds the SAME grant as the primary. This stops a corrupted slot from quietly spending the primary's quota.
- **Fix: quota refresh can no longer relabel or overwrite an account.** An isolated account resolved to another slot's email is now quarantined (`authRequired`) instead of being relabeled; an isolated account whose stored credential equals the primary's is quarantined offline before any network call. The durable store is consulted before the volatile slot for the primary, so a mid-handoff slot can no longer make the primary row display a secondary's numbers.
- **Fix: refreshed tokens keep their refresh token and agy's nested on-disk shape.** The writer used to emit a flat `{access_token,expiry}` document when the file did not exist yet, silently DROPPING `refresh_token`. A credential without a refresh token has no stable identity across access-token rotations, which disabled every identity guard. The writer now always emits `{"token":{…},"auth_method":"consumer"}` and preserves the refresh token.
- **Add: identity comparison anchored on the OAuth grant.** `sameCredentialGrant()` requires a refresh token on both sides ("cannot prove it" means "not the same"); adoption of a primary credential now skips candidates without a refresh token so the durable store can never be degraded.
- **Add: corruption diagnostics and repair tooling.** `findDuplicateCredentialIdentities()` reports accounts sharing one login, and the boot log now warns loudly. `scripts/repair-pool.mts` (dry-run by default, `--apply` to write) restores the primary slot and quarantines overwritten accounts; `scripts/verify-credential-store.mts` verifies the store's live identity. Running `pnpm test` no longer touches the real pool directory — credential handling is anchored on `AccountPoolManager.dir` instead of a process-global path.
- **Fix: a malformed `mermaid` block no longer paints Mermaid's own "Syntax error in text" bomb into the page.** Mermaid's standalone renderer appends a temporary `<div id="d<id>">` to `document.body` and, when a diagram fails to parse, draws its built-in error diagram into that div *instead of throwing* — so the failure never reached our `catch`, and the bomb escaped the message card and floated detached at the end of the page. The runtime is now initialized with `suppressErrorRendering: true`, every block is pre-validated with `mermaid.parse(text, { suppressErrors: true })` before `render()` runs, and a sweep removes body-level error diagrams left behind by older client builds. Invalid or still-streaming diagrams simply keep their original code block, and an unchanged failing block is no longer re-parsed on every DOM mutation.

### 中文

- **合并（2026-10-13）：被舍弃的工作区内容重新叠加回 0.4.46，Windows 账号池凭据隔离真正恢复。** 以上游为主线（适配器 spawn 窗口槽位归属、异步钥匙串/凭据管理器读取、桌面端思考可见性 #43、无 CDN 的本地 mermaid 渲染器与其错误炸弹清理、模型可见性、账号池与数据加固），在其之上恢复：下述 Windows 凭据管理器交接、本地 `/plugins/agy-link/media` 路由与图片灯箱/决策芯片、Windows 系统代理自动探测（WinINet 注册表）、账号池串号诊断与修复脚本、以及 `src/host/wincred.ts` 原语。几处取舍：`runner.ts`、`assets/mermaid.min.js`、`src/client/mermaid.ts` 与 proxy/keychain 测试取上游（同类问题已被上游加固，重复的 mermaid 实现与其测试被删除）；`quota.ts` 同时保留上游的异步读取与你的「持久化存储优先」主账号解析；轮巡已能真正隔离凭据，因此 `credentialIsolationLimited` 警告（状态字段、适配器日志、设置面板横幅、四语言文案）全部移除；`node:test` 下绝不触碰真实凭据管理器槽位。
- **修复（严重）：Windows 下多账号池不再串号，额度耗尽切换恢复正常。** Windows 上 `agy.exe` 只从**一个全局凭据槽**（凭据管理器 `gemini:antigravity`）读取 Google 凭据，`HOME`/`USERPROFILE` 被忽略，因此「每账号独立目录」并不像 macOS 的独立钥匙串那样隔离凭据。旧的手递逻辑破坏了一个真实账号池：四个账号全部持有主账号的 refresh token、每一行额度都显示同一个身份、点击「刷新/同步」看起来会把主账号替换掉。本次修复三个缺陷：
  - 旧逻辑把「当前槽里的内容」当作主账号备份快照，于是副账号运行会用自己的凭据覆盖备份，下次恢复就把副账号装成了系统级登录。现在主账号凭据来自**经过身份校验的持久化存储**（`agy-accounts/.primary-credential.json`），绝不从活动槽推断。
  - 恢复阶段只要发现槽内容与账号文件不同就写回账号文件；当槽被别的账号占用时，这会把**别人的凭据**写进该账号文件。现在写回前必须确认槽仍持有**该账号自己的 refresh token**，否则不写并记录警告。
  - 槽的归属完全没有串行化，交互运行、后台额度轮询、手动刷新互相竞争。现在由一个进程级 FIFO 互斥锁（`AsyncMutex`）覆盖整个运行周期。
- **新增：无法安全交接时直接拒绝运行，而不是悄悄用错账号。** `acquireCredentialSlot` 在以下情况抛出 `SlotUnavailableError`（表现为 `AGY_ERROR`）：无法验证主账号凭据、副账号没有凭据、或副账号持有与主账号**相同的授权**。这阻止了被污染的槽偷偷消耗主账号额度。
- **修复：额度刷新不再改名或覆盖账号。** 独立账号解析出的邮箱若属于另一个槽，改为**隔离**（`authRequired`）而不是改名；独立账号的凭据与主账号相同的，在任何网络请求之前就离线隔离。主账号优先读取持久化存储而非易变的槽，中途被交接的槽再也无法让主账号行显示副账号的数字。
- **修复：刷新后的 token 保留 refresh token 与 agy 的嵌套磁盘格式。** 旧写入器在文件不存在时会写成扁平 `{access_token,expiry}`，**静默丢弃 `refresh_token`**。没有 refresh token 的凭据在 access token 轮换后就没有稳定身份，导致所有身份守卫失效。现在固定写入 `{"token":{…},"auth_method":"consumer"}` 并保留 refresh token。
- **新增：以 OAuth 授权为锚的身份比较。** `sameCredentialGrant()` 要求双方都有 refresh token（「无法证明」即视为「不同」）；主账号凭据的采纳会跳过没有 refresh token 的候选，持久化存储因此不会再被降级。
- **新增：串号诊断与修复工具。** `findDuplicateCredentialIdentities()` 报告共享同一登录的账号，启动日志会明确告警。`scripts/repair-pool.mts`（默认 dry-run，加 `--apply` 才写入）恢复主账号槽并隔离被覆盖的账号；`scripts/verify-credential-store.mts` 校验存储的真实身份。`pnpm test` 不再触碰真实账号池——凭据处理改为锚定 `AccountPoolManager.dir` 而非进程级全局路径。
- **修复：语法错误的 `mermaid` 代码块不再把 Mermaid 自带的「Syntax error in text」炸弹图渲染到页面上。** Mermaid 独立版渲染器会向 `document.body` 追加一个临时 `<div id="d<id>">`，图表解析失败时它把内置错误图**画进这个容器而不是抛异常**——失败因此永远到不了我们的 `catch`，炸弹图逃出消息卡片、孤立地漂在页面末尾。现在运行时以 `suppressErrorRendering: true` 初始化，每个代码块在 `render()` 之前先用 `mermaid.parse(text, { suppressErrors: true })` 预校验，并会清理旧客户端版本遗留在 body 层的错误图。语法错误或仍在流式输出的图表只保留原始代码块，同一份失败代码也不再因每次 DOM 变更而反复解析。

## 0.4.46 (2026-10-12)

### English

- **Fix (review cycle 2026-10-12): concurrency-slot leak in the adapter spawn window.** `stream()` acquired a `maxConcurrent` slot and only released it from the process-outcome closure — a caller that abandoned the generator while it was suspended on the burst-spacing throttle (steer abort, DSH closing the stream) dropped the release closure, and each incident permanently leaked one slot until every future run dead-locked in the queue. The spawn window now owns the slot through try/finally, an already-aborted signal short-circuits before spawn, and an abort that lands during the window kills the process immediately instead of running a full turn nobody reads.
- **Fix (review cycle): a stale pool-auth flow could kill the new login or commit a ghost account.** `finishWithCode` resolved against `this.flow` without checking WHICH flow the callback belonged to: flow A's late `exchangeCode` resolution during flow B either failed B with `invalid_state` (deleting B's staging dir) or, worse, wrote A's token file into A's freshly cleaned dir and committed a one-file ghost account. Settlement is now flow-identity-checked.
- **Fix (review cycle): long agy tools no longer look like a frozen session.** ACTIVE tool envelopes now emit a one-time `[agy tool running: …]` note into the reasoning block, so a ten-minute maven build shows live progress instead of silence (the 5-minute heartbeat only ever reached the logs). Subagent reasoning snapshots also stop duplicating the whole transcript (suffix-delta like the thinking branch), and a tool-cut span forwards the last per-call usage sample instead of a hard 0/0 that reset DSH's token meter on every tool hop.
- **Fix (review cycle): synthetic-message filtering can no longer eat the user's real message.** When the sniffed synthetic-looking text is the ONLY user content of the trailing span (a pasted `<system-reminder>` block being the actual question), the bridge now forwards it instead of failing with "request carries no user text" — while an image-only turn still never digs up an older question.
- **Fix (review cycle): pool/data hardening.** `deleteAccount` only ever `rmSync`s directories under the pool base dir (a hand-edited `dir: "~"` used to be deleted recursively); `pool.json` persists through a known-ids merge so web + headless stop erasing each other's accounts (corrupt files are backed up before defaults overwrite them, and persist failures are surfaced on stderr); `/agy add-account` and `POST /pool/add` quarantine the new slot with `authRequired` until the terminal login is verified, so the scheduler can no longer route real runs to an account nobody signed into; a drained quota window with an UNPARSEABLE reset now counts as exhausted in eligibility and rotation instead of "already reset".
- **Fix (review cycle): quota/OAuth robustness.** All Google endpoint calls carry a 10s default timeout (a hung refresh-token/quota endpoint used to park `/agy refresh-quota` for minutes); keychain/Secret Service/Credential-Manager reads are async (`execFileSync` up to 8s used to freeze the whole DSH event loop on every poll); concurrent `getValidAccessToken` calls for one account share one in-flight refresh; quota fractions are clamped to [0,1] with NaN rejected; refreshed token files are written 0600.
- **Fix (review cycle): auth flow lifecycle.** Cancelling during the URL wait now resolves the pending `begin()` (the `/plugins/agy-link/auth` HTTP route used to hang forever), a superseded `begin()` can no longer overwrite the newer flow's state, and the probe/settle timers are cleaned up.
- **Fix (review cycle): agy conversation DB reads.** A missing `sqlite3` binary or oversized/locked DB used to re-spawn sqlite3 on EVERY step event with the failure silently swallowed (cache still marked loaded, so the storm never converged); failures now back off (ENOENT for the full window, transient for 300ms), log once, and concurrent readers share one in-flight load. The DB copy is taken into a private `mkdtemp` dir with 0600 instead of a predictable /tmp path.
- **Fix (review cycle): misc.** The OAuth callback page HTML-escapes the reflected `error` parameter; Windows `openBrowser` refuses URLs containing quotes/newlines before the cmd string build; doctor redaction covers `1//0…` refresh tokens, `AIza…` keys and credentialed proxy URLs, and the config dump scrubs `proxyUrl` credentials; `/agy pool` prints proxy URLs redacted; fallback-source model discovery re-probes at most once per minute instead of spawning `agy models` on every list; fallback conversation-id discovery watches the pool account's isolated HOME; mermaid's CDN fallback is removed entirely (floating-version unsigned script in the app origin) and the mermaid/reasoning overlay observers are disposed through `ctx.effect`.
- **Add: token-speed statistics.** Every recorded event now carries its arrival time; per-step generation windows (≥500 ms) yield `lastTps`/output-weighted `avgTps`/output-token totals on the recording, surfaced through `/agy status` ("last run tokens: N output tokens — avg X tok/s (last generation step: Y tok/s)") and the `lastRun` status payload.
- **Fix (issue #43): thinking and tool activity are no longer invisible on desktop hosts.** Two compounding causes: (1) thought prose comes from the agy conversation SQLite DB, and the reader required the external `sqlite3` CLI — which GUI/desktop hosts often lack on PATH (macOS GUI apps do not inherit the shell PATH; Windows never ships one). The reader now prefers Node's built-in `node:sqlite` (no external binary) and keeps the CLI as fallback, so reasoning text resolves on desktop hosts. (2) When prose is unavailable, high-effort turns rendered nothing at all; a banner-only `[agy thinking turn · N thinking tokens]` chip now streams before the first visible text (and on thinking-only turns), with the real prose appended seamlessly when the DB resolves later — no duplicate banner, no dropped text, and no clutter on tool-heavy steps after text already streamed.
- **Fix (issue #45): Windows pool-credential isolation is now an explicit, visible limitation.** agy on Windows stores its login in the system-wide Credential Manager slot `gemini:antigravity` (go-keyring); HOME isolation moves files only, so every isolated pool account still authenticates — and bills — as the system login. The plugin now (1) exposes `credentialIsolationLimited` in `/plugins/agy-link/status`, rendered as a warning banner in the settings panel, (2) logs once per isolated account when it is selected on Windows, and (3) documents the boundary (and why per-run `CredWrite` slot-swapping is not safe with `maxConcurrent > 1`) in KNOWN-GAPS.md. Full isolation needs an upstream agy change (per-HOME keyring namespace or file fallback when the keyring slot is empty).


- **Fix: the stuck-run heartbeat no longer lies about how long the run has been silent.** With no tool step open the silence clock was seeded from `Date.now()` over an empty map, so the every-5-minutes log permanently claimed "no new output for 1m" while the run had actually been quiet for hours. It now reports the time since the last stdout line (`lastOutputAt`), which is the number a human needs when deciding whether to press Stop.
- **Fix: `agy_tool` no longer blames a "recycled" output for a cursor that never pointed at one.** An out-of-range step index (or a non-tool event) and a genuinely evicted recording both used to return the "recorded output is no longer resident" notice — telling the model that output was lost when it was never recorded at all. The degraded message now states the actual reason ("outside this recording — not recorded yet / not a completed tool step" vs. "the in-memory recording was recycled").
- **Fix: account failover now actually continues the session — including after a completed tool step (the "quota exhausted, turn lost" bug).** DSH re-issues the failed step, and a step that failed inside a tool continuation carried a trailing tool result, so it was resumed from the SETTLED recording and re-emitted the identical failure: a quota/region/auth refusal after any tool call ended the turn while a healthy account was sitting idle (reproduced offline against `test/fake-agy.mjs`). The continuation branch now refuses to re-drive a settled recording whose failure is account-scoped, forgets it, and re-assembles on the next account — inside the same step, with no visible interruption. The failover is bounded (at most `enabled accounts - 1` re-spawns per session per 2 minutes) and never applies to request-level failures, so a deterministic error cannot loop through the pool re-running the user's tools.
- **Fix: transport-shaped "not logged in" is no longer reported as AUTH (the "API 密钥无效 / API key is invalid" hunt).** agy reports "not logged into Antigravity" both for a real sign-out and for a healthy login whose token it could not VALIDATE (live 2026-10-10 14:17: the retry account's token had expired 9 minutes earlier and its refresh died on `Post https://oauth2.googleapis.com/token: EOF`, next to TLS handshake timeouts). The adapter classified that as `AUTH`, which (a) ended the turn on a healthy account, (b) flagged the account for re-login, and (c) made DSH render its `message.failure.auth` label — "API key is invalid" — for a credential that was never the problem. Transport evidence in the auth-shaped stdout banner, stderr or the result envelope now yields a retryable `NETWORK` failure that rotates to the next account and never quarantines a login.
- **Fix: the retry budget follows the pool, and a sign-out can continue on another account.** `maxRetries` was a flat 1, so a 3-account pool could never reach the third account — and the live incident needed exactly that (primary ELIGIBILITY → second account "not signed in" → turn lost, though the third was healthy). The budget is now `min(enabled accounts - 1, 2)`, and `AUTH` is retryable when at least one other account exists (the failed one is flagged `authRequired` and leaves rotation).
- **Fix: soft capacity refusals rotate instead of dead-ending the turn.** "model overloaded" / "experiencing high traffic" used to be a deterministic `AGY_ERROR` — terminal, no rotation, no retry — so a turn died while another account could serve it. They are now `OVERLOADED`: retryable, pointer rotated, and deliberately WITHOUT a cooldown (nothing was spent). The hard-quota matcher also recognises real phrasings it used to miss (`Resource has been exhausted (e.g. check quota).`, `You have exhausted your quota`, `out of quota`, `check quota`), which previously fell through to a bare "agy exited with code 1" on the SAME account.
- **Fix: the idle watchdog no longer kills a run that is demonstrably working.** 12 of the 37 failures in one week of real logs were exactly `agy run was idle for 600000ms without output`, each costing a turn and a resend. stderr now counts as liveness (agy prints progress there), and once a run has produced ANY output the long budget applies (`longToolIdleMinutes`, default 240m) — before the first event the strict `timeoutMs` stays, which is the genuinely wedged / Google-unreachable shape. The 5-minute heartbeat now also covers a silent-but-alive run instead of only open tool steps, so the user can see it is waiting and press Stop.
- **Fix: prompts no longer re-send tool output the live agy conversation already owns, and synthetic harness telemetry is filtered.** A bound conversation was piping prior tool results back into `-p` (a live command line was captured carrying a 6.4 KB Godot simulation dump) — stale output ahead of the actual question, which is one of the ways the model ends up answering the previous work. Tool payloads are now dropped when the conversation already has them (they still ride the prompt on a fresh conversation, where agy has never seen them). Separately, DSH runtime telemetry messages injected with `role: 'user'` (`time-context`, `runtime-context`, `<system-reminder>`) are filtered so timestamps never overwrite the human prompt, and an image-only (text-less) newest message no longer falls back to older questions.
- **Fix: an interrupted turn can no longer make agy answer the message you interrupted.** DSH persists the partial reply of a Stop/steer as a normal assistant message, so the plugin treated the interrupted user turn as answered agy-native history while agy's server-side turn had no finalized reply — the next prompt was just the new message, and the model answered the interrupted one (live: `session-c65a826e` turns 17→19, the user re-asked verbatim with "这个咋不回答呢"). The binding is now flagged `interrupted` when a run is aborted or times out, the next prompt carries an explicit "do not continue that unfinished work" boundary, and a successful turn clears the flag. Images staged by an interrupted run are no longer marked delivered either (re-sending the same screenshot after a Stop was silently deduped away and an image-only follow-up failed with "request carries no user text or images").
- **Fix: a run that already produced its result is no longer killed by the next call.** Steer preemption aborted a process that had already streamed its answer (recording a false `ABORTED` and cutting agy mid-finalize); it now waits briefly for a natural exit and only preempts a still-running turn. The bounded settle wait reports when it expires, and a superseded run's late write-back can no longer regress `lastMessageCount` / `sentImageIds`.
- **Fix: pool and binding robustness.** A partial `pool.json` (account missing `cooldowns`/`quotas`) threw a `TypeError` inside `selectAccount`, so every turn failed with an opaque internal error and no failover — records are normalized on load. Rate limits no longer delete the `(session, account)` binding, so a resumable native conversation is not thrown away for a 15-minute cooldown (only a real sign-out or an agy-side "conversation not found" invalidates it). Conversation adoption from a live run is scoped to the SAME account (adopting account A's id under account B produced a wasted "conversation not found" turn). `sessions.json` now performs the dirty-key merge its own docs promised, so the web and headless hosts stop clobbering each other's bindings. A failed turn reports the last per-call context sample instead of a hard-coded 0/0. ADR-012 no longer claims a flat "zero interruption" fallback with a 10-minute cooldown.

### 中文 (Chinese)

- **修复（2026-10-12 审查周期）：适配器 spawn 窗口的并发槽位泄漏。** `stream()` 取得 `maxConcurrent` 槽位后只由进程结算闭包释放——调用方在突发节流 sleep 处放弃生成器（插话中止 / DSH 关闭流）会直接丢掉 release 闭包，每次事故永久泄漏一个槽位，累积后所有后续请求在队列里死锁。现在 spawn 窗口用 try/finally 持有槽位；已中止的 signal 会在 spawn 前短路；窗口内到达的中止会立刻杀进程，而不是跑完一轮没人读的 turn。
- **修复（审查周期）：滞后的 pool-auth 流程可能杀死新登录或提交幽灵账号。** `finishWithCode` 直接对 `this.flow` 结算、不校验回调属于哪个 flow：用户取消 A 并开始 B 后，A 的 `exchangeCode` 迟到返回，要么以 `invalid_state` 杀掉 B（连带删掉 B 的 staging 目录），要么把 A 的 token 文件写进刚清理的 A 目录并提交一个只剩 token 文件的幽灵账号。现在结算带 flow 身份校验。
- **修复（审查周期）：长时间 agy 工具不再让会话看起来卡死。** ACTIVE 工具信封现在会在推理块输出一次性 `[agy tool running: …]` 进行中注解——十分钟的 maven 构建期间界面有实时进展，而不是只有日志里的 5 分钟心跳。subagent 推理快照改用与 thinking 分支相同的 suffix-delta，不再整段重复；工具切割 span 转发最后一次 per-call 用量样本，不再用硬编码 0/0 在每个工具 hop 重置 DSH 的 token 计量。
- **修复（审查周期）：合成消息过滤不再吞掉用户的真实消息。** 当被嗅探命中的文本是尾随 span 里唯一的用户内容（用户粘贴 `<system-reminder>` 块本身就是要问的问题），桥接现在会转发它，而不是报「request carries no user text」；纯图片轮次依旧不会回捞更早的问题。
- **修复（审查周期）：账号池与数据加固。** `deleteAccount` 只会删除池 baseDir 下的目录（手改 `dir: "~"` 曾会被递归删除）；`pool.json` 持久化改为 known-ids 合并，web 与 headless 不再互相清掉对方账号（损坏文件先备份再被默认值覆盖，写盘失败打到 stderr）；`/agy add-account` 与 `POST /pool/add` 在登录验证通过前用 `authRequired` 隔离新槽位，调度器无法再把真实 run 路由到没人登录过的账号；额度耗尽但 reset 时间不可解析时按「已耗尽」参与资格判定与轮换，而不是「已重置」。
- **修复（审查周期）：配额 / OAuth 健壮性。** 所有 Google 端点调用默认 10s 超时（挂死的 refresh-token / 配额端点曾让 `/agy refresh-quota` 卡死数分钟）；钥匙串 / Secret Service / Windows 凭据管理器读取全部异步化（`execFileSync` 最长 8s 曾在每个轮询周期冻结整个 DSH 事件循环）；同账号并发 `getValidAccessToken` 共享一次 in-flight 刷新；配额比例钳制到 [0,1] 并拒绝 NaN；刷新后的 token 文件以 0600 落盘。
- **修复（审查周期）：登录流程生命周期。** URL 等待期间取消会 resolve 挂起的 `begin()`（`/plugins/agy-link/auth` HTTP 路由曾永久挂起）；被取代的 `begin()` 不会再覆盖新流程状态；probe/settle 计时器均已清理。
- **修复（审查周期）：agy 会话数据库读取。** 缺 `sqlite3` 或库超大/被锁时，之前每个 step 事件都会重新 spawn 一次 sqlite3 且失败被静默吞掉（缓存仍标记 loaded，风暴永不收敛）；现在失败退避（ENOENT 按整个缓存窗口、瞬时失败 300ms）、告警一次、并发读者共享一次 in-flight 加载；DB 拷贝改为私有 `mkdtemp` 目录 + 0600，不再落在可预测的 /tmp 路径。
- **修复（审查周期）：其他。** OAuth 回调页对反射的 `error` 参数做 HTML 转义；Windows `openBrowser` 在拼 cmd 字符串前拒绝含引号/换行的 URL；doctor 脱敏覆盖 `1//0…` refresh token、`AIza…` key 与带凭据的代理 URL，config dump 会抹掉 `proxyUrl` 凭据；`/agy pool` 打印脱敏后的代理；fallback 模型目录每分钟最多重探一次（未登录时不再每次列表调用都 spawn `agy models`）；会话 id 兜底发现改为监视池账号隔离 HOME；彻底移除 mermaid 的公网 CDN 回退（应用 origin 内的浮动版本无签名脚本），mermaid/reasoning 的 overlay observer 通过 `ctx.effect` 释放。
- **新增：token 速度统计。** 每条录制事件现在带到达时间；≥500ms 的分步生成窗口给出 `lastTps` / 按输出加权的 `avgTps` / 输出 token 总量，通过 `/agy status`（「last run tokens: N output tokens — avg X tok/s」）与 `lastRun` 状态载荷暴露。
- **修复（issue #43）：桌面端不再看不到思考过程与工具活动。** 两个叠加原因：(1) 思维正文来自 agy 会话 SQLite 库，而读取器依赖外部 `sqlite3` CLI——桌面/GUI 宿主的 PATH 经常没有它（macOS GUI 应用不继承 shell PATH，Windows 从不自带）。读取器现在优先用 Node 内置的 `node:sqlite`（无需外部二进制），CLI 退居兜底，桌面端也能解析出推理文本。(2) 拿不到正文时高强度轮次此前什么都不渲染；现在首段可见文本之前（以及纯思考轮次）会先流出 `[agy thinking turn · N thinking tokens]` 横幅，DB 正文稍后解析出来时无缝追加——不重复横幅、不丢文本，正文已开始后也不在工具密集步骤上刷屏。
- **修复（issue #45）：Windows 号池凭据无法隔离现在是明确、可见的已知限制。** Windows 上 agy 把登录存进系统级 Credential Manager 的单一槽位 `gemini:antigravity`（go-keyring）；HOME 隔离只隔离文件，所有池账号实际仍以系统登录认证与扣额度。插件现在 (1) 在 `/plugins/agy-link/status` 暴露 `credentialIsolationLimited` 并在设置面板渲染警告横幅，(2) Windows 下选中隔离账号时告警一次，(3) 在 KNOWN-GAPS.md 记录边界（以及为何 `maxConcurrent > 1` 时逐 run 的 `CredWrite` 槽位互换不安全）。彻底解决需要上游 agy 改动（按 HOME 命名空间的 keyring，或 keyring 槽位为空时回落文件）。


- **修复：卡死 run 的心跳日志不再谎报静默时长。** 当没有未完成的工具步骤时，静默时钟从一个空 map 上的 `Date.now()` 起算，于是每 5 分钟一次的日志永远显示「无新输出 1m」，而 run 实际已经安静了数小时。现在报告的是距最后一条 stdout 行的真实时长（`lastOutputAt`）——这正是用户决定是否按 Stop 时需要的数字。
- **修复：`agy_tool` 不再把「从未指向过任何步骤的游标」归因为「输出被回收」。** 越界的 step 索引（或非工具事件）与真正被淘汰的录像此前返回同一句「录制输出已不在内存中」——告诉模型输出丢了，而它其实从未被录制过。降级消息现在说明真实原因（「索引在此录像范围之外——尚未录制 / 不是已完成的工具步骤」vs「内存中的录像已被回收」）。
- **修复：账号故障转移现在真的能续上会话——包括在工具步骤之后（「额度用完、整轮作废」问题）。** DSH 重发失败步骤时，如果失败发生在工具续跑 span 内，消息尾部带着工具结果，于是适配器从**已 settle** 的录像里恢复、把同一个失败原样重放一遍：任何在工具调用之后出现的额度/地区/认证拒绝都会让整轮失败，而旁边还有健康账号闲着（已用 `test/fake-agy.mjs` 离线复现）。现在续跑分支拒绝重放「账号级失败的已 settle 录像」，改为丢弃它并在下一个账号上重新组装——仍在同一步内完成，用户看不到中断。故障转移有界（每会话每 2 分钟最多 `启用账号数 - 1` 次重发），且绝不适用于请求级失败，因此确定性错误不会在账号池里反复重跑用户的工具。
- **修复：传输形态的「未登录」不再被报成 AUTH（「API 密钥无效」误导）。** agy 对于真正的登出、以及**无法校验** token 的健康登录，都会说「not logged into Antigravity」（线上 2026-10-10 14:17：重试账号的 token 早 9 分钟就过期，刷新死在 `Post https://oauth2.googleapis.com/token: EOF`，同时伴随 TLS 握手超时）。适配器把它归类为 `AUTH`，后果有三：(a) 在健康账号上终止本轮；(b) 把该账号标记为「需重新登录」；(c) 让 DSH 渲染 `message.failure.auth` 文案——「API 密钥无效」——而凭据从来不是问题。现在，只要认证形态的 stdout banner、stderr 或结果信封里出现传输层证据，就会得到可重试的 `NETWORK` 失败：轮换到下一个账号，且绝不隔离任何登录状态。
- **修复：重试预算跟随账号池，登出也能在另一个账号上继续。** `maxRetries` 原先固定为 1，3 账号池永远到不了第三个账号——而线上事故恰好需要它（主账号 ELIGIBILITY → 第二账号「未登录」→ 整轮丢失，尽管第三个账号健康）。现在预算是 `min(启用账号数 - 1, 2)`；当至少还有一个账号时 `AUTH` 可重试（失败账号被标记 `authRequired` 并退出轮换）。
- **修复：软容量拒绝改为轮换，而不是直接终止本轮。** 「model overloaded」/「experiencing high traffic」原先归类为确定性 `AGY_ERROR`——终止、不轮换、不重试——于是明明还有别的账号可用，本轮却失败了。现在它们是 `OVERLOADED`：可重试、指针已轮换、且**故意不加冷却**（没有消耗任何额度）。硬额度识别也补上了过去漏掉的真实措辞（`Resource has been exhausted (e.g. check quota).`、`You have exhausted your quota`、`out of quota`、`check quota`）——这些以前会退化成一句「agy exited with code 1」，并且重试仍打在同一个已耗尽账号上。
- **修复：空闲看门狗不再杀掉「明显还在干活」的 run。** 真实日志一周内 37 次失败里有 12 次正是 `agy run was idle for 600000ms without output`，每次都赔上一轮和一次重发。现在 stderr 也算活跃（agy 会把进度写在 stderr），并且只要 run 产出过任何输出就适用长预算（`longToolIdleMinutes`，默认 240 分钟）——首个事件之前仍用严格的 `timeoutMs`，那才是真正卡死/连不上 Google 的形态。5 分钟心跳也从「仅有未完成工具步骤」扩展为覆盖「安静但存活」的 run，用户能看到它在等，并可以按 Stop。
- **修复：提示词不再重发当前 agy 会话已有的工具输出，并严格过滤 DSH 合成遥测消息。** 已绑定的会话会把历史工具结果重新塞回 `-p`（线上抓到一条命令行里带着 6.4 KB 的 Godot 模拟输出）——陈旧输出排在真正的问题前面，这正是模型转去回答「上一件事」的原因之一。现在会话已拥有工具输出时不再重发（全新会话仍会带上，因为那时 agy 从未见过）。此外，DSH 在运行时高频注入的 `role: 'user'` 合成遥测消息（如 `time-context` 时间戳、`runtime-context` 上下文快照、`<system-reminder>` 等）现在会被严格过滤，彻底解决时间戳冲掉真实用户任务导致 agy 忽略最新输入的问题；纯图片（无文本）的最新消息也不再回溯拾取旧问题。
- **修复：被中断的轮次不会再让 agy 回答你打断的那条消息。** DSH 会把 Stop / 插话时的半截回复当作普通 assistant 消息持久化，于是插件把「被打断的用户轮次」当成 agy 原生历史（而 agy 服务端那一轮并没有最终回复）——下一条提示词只有新消息，模型却去回答被打断的那条（线上 `session-c65a826e` 第 17→19 轮，用户原样重问并追问「这个咋不回答呢」）。现在 run 被中断或超时时会在 binding 上标记 `interrupted`，下一条提示词带上明确的「不要继续那件未完成的事」边界，成功一轮后清除该标记。被中断的 run 暂存的图片也不再被记为「已投递」（Stop 之后重发同一张截图会被静默去重，纯图片追问则直接报「request carries no user text or images」）。
- **修复：已经产出结果的 run 不会再被下一次调用杀掉。** 插话抢占原先会中止一个已经流完答案的进程（记为假的 `ABORTED`，并把 agy 的收尾切断）；现在会短暂等待它自然退出，只抢占仍在运行的轮次。有界的 settle 等待在超时时会记录日志，被取代的 run 的迟到回写也无法再回退 `lastMessageCount` / `sentImageIds`。
- **修复：账号池与会话绑定的健壮性。** 残缺的 `pool.json`（账号缺 `cooldowns`/`quotas`）会让 `selectAccount` 抛 `TypeError`，导致每一轮都以不透明的内部错误失败、且完全没有故障转移——现在加载时会规范化记录。限流不再删除 `(会话, 账号)` 绑定，因此不会为了 15 分钟冷却丢掉一个可续跑的原生会话（只有真正的登出或 agy 侧「conversation not found」才会作废它）。从存活 run 采纳会话 id 时限定为**同一账号**（把账号 A 的 id 用到账号 B 上会产生一次白跑的「conversation not found」）。`sessions.json` 现在真正实现其文档承诺的 dirty-key 合并，web 与 headless 宿主不再互相覆盖绑定。失败的轮次会报告最后一次 per-call 上下文用量，而不是硬编码的 0/0。ADR-012 不再声称「零中断」的平铺回退与 10 分钟冷却。

### English (continued)

- **Fix: a long-running span can no longer lose its recording to the shared run registry (`no recorded agy run`).** `RunRegistry` kept only the 8 most recently **created** runs (global FIFO across every DSH session). A run whose span waited hours on a wedged agy tool step (e.g. a headless test scene that hit a script error and never quit) was evicted while it was still in flight, and the `agy_tool` mirror call the span had already emitted — `agy_tool({run, step})` — failed with "no recorded agy run", which sent the model off to debug the bridge instead of finishing the user's task (flash-blast incident, 2026-10-10; the same shape recurred on 2026-10-09). The registry now (1) pins a run for the whole lifetime of the span driving it, (2) exempts pinned and unsettled runs from eviction, (3) never evicts the most recent entry, and (4) `remember()` now refreshes recency (delete-then-set) instead of silently keeping the old slot. Spans re-register their recording when they start and when they finish, so the run an `agy_tool` dispatch addresses is always resident, while memory stays bounded by evicting the oldest settled, unpinned run.
- **Fix: a missing recording now degrades instead of throwing a harness-internal error at the model.** `agy_tool` returning `no recorded agy run` was unrecoverable for the agent: it read the error as an environment fault and spent a whole turn reverse-engineering the plugin bundle (including a stale published copy from the pnpm store). When a run's recording is gone the mirror now returns an explicit, task-facing notice stating that the step did run, that its replay is unavailable, that there is nothing to debug, and that the operation can simply be re-run — then the agent continues its real work.
- **Add: configurable long-tool idle budget + stuck-tool heartbeat.** The watchdog raise for open tool steps (previously hard-coded to the ≥ 4 h print-mode ceiling) is now `longToolIdleMinutes` / `DSH_AGY_LONG_TOOL_IDLE_MINUTES` (default 240; `0` disables the raise so a wedged tool fails the turn after `timeoutMs` instead of holding the session for hours). While any tool step is open the adapter now logs a heartbeat every 5 minutes (open count + age + budget), so a stalled turn is visible instead of looking like a dead session.
- **Fix: `toolStepBrief` reads `CommandLine`.** The code-mode/step preview for `run_command` steps showed "run command" whenever agy sent the modern `CommandLine` key; it now shows `$ <command>` like the native card does.
- **Fix: cross-conversation & cross-account assistant replies are now digested when returning.** In multi-account pool scenarios where turns alternated between accounts, an assistant message emitted under another agy conversation id was previously ignored by `isForeignAssistant` (because `provider` was identically `antigravity`). The returning conversation never saw that intervening answer in its context digest. `isForeignAssistant` now verifies `source.replayState` conversation IDs against the current binding, guaranteeing complete cross-conversation context.
- **Fix: `forwardSystemPrompt` falls back to `role: 'system'` messages.** When `options.system` is omitted on `GenerateOptions` but system instructions are provided as an explicit system message in the chat history, the prompt now correctly includes the system instructions.
- **Add: native card presentations for web search, URL fetching, task management, scheduling, and subagents.** Mirrored cards and step previews now cleanly project `search_web`, `read_url_content` / `web_fetch`, `manage_task`, `schedule`, and `invoke_subagent` / `send_message`, avoiding generic raw JSON fallbacks. `TerminalResultView` also extracts process exit codes (`The command exited with code X`) from `run_command` output to render native status pills in DSH terminal cards.

### 中文（续）

- **修复：长时间运行的 span 不会再因为共享 run 注册表而丢失录像（`no recorded agy run`）。** `RunRegistry` 原先只按**创建顺序**保留最近 8 条 run（跨全部 DSH 会话的全局 FIFO）。当某条 run 的 span 因为 agy 工具步骤卡死（例如无头测试场景脚本报错后不退出）等待数小时，它会在仍在飞行时被淘汰，而该 span 已经排好队的 `agy_tool({run, step})` 镜像调用随即报 "no recorded agy run"——模型据此掉头去调试桥接插件，而不是继续用户的任务（flash-blast 事故，2026-10-10；2026-10-09 出现过同样形态）。现在注册表：(1) 在 span 驱动期间**钉住**该 run；(2) 被钉住与未 settle 的 run 免于淘汰；(3) 永不淘汰最近使用的那一条；(4) `remember()` 改为真正的 `delete` 再 `set`，刷新最近使用顺序而不是原地保留旧位置。span 在启动与结束时都会重新登记自己的录像，因此 `agy_tool` 派发时寻址的 run 必定仍在内存中，同时内存仍通过淘汰「最老的、已 settle 且未钉住」的 run 保持有界。
- **修复：录像缺失时改为优雅降级，而不是向模型抛桥接内部错误。** `agy_tool` 返回 `no recorded agy run` 对 agent 来说不可恢复：它把该错误理解为环境故障，整轮都在逆向插件产物（还是一份 pnpm store 里的旧发布副本）。现在录像不存在时，镜像工具返回一条明确面向任务的提示：该步骤确实执行过、只是回放不可用、这里没有可调试的东西、需要输出就重跑一次同样的操作——随后 agent 继续原本的工作。
- **新增：可配置的长工具空闲预算 + 卡死工具心跳。** 未完成工具步骤期间的空闲预算（原先硬编码为 ≥ 4 小时的 print-mode 上限）现在是 `longToolIdleMinutes` / `DSH_AGY_LONG_TOOL_IDLE_MINUTES`（默认 240；设为 `0` 表示不抬高预算，卡死的工具会在 `timeoutMs` 后让本轮失败，而不是把会话挂住数小时）。只要存在未完成的工具步骤，适配器每 5 分钟记录一条心跳（未完成数量 + 最久时长 + 当前预算），让卡住的轮次可见，而不是看起来像会话已死。
- **修复：`toolStepBrief` 会读取 `CommandLine`。** 当 agy 发送新式 `CommandLine` 键时，`run_command` 步骤的 Code Mode / 预览标题只会显示 "run command"；现在与原生卡片一致，显示 `$ <命令>`。
- **修复：跨会话 / 跨账号的助理回复在切回时现在会被完整消化（跨会话上下文丢失漏洞）。** 在多账号池轮换场景下，当某轮切到备用账号并在新 agy 会话中回答后，切回原账号会话时，由于原先 `isForeignAssistant` 仅比对 `provider !== 'antigravity'`，导致另一会话产出的 assistant 回复被误认为“本机历史”而从补充摘要中剔除，使原会话完全缺失该轮的回答上下文。现在通过对比 `source.replayState` 中的会话 ID，跨会话回复会准确作为外部上下文消化到提示词中。
- **修复：`forwardSystemPrompt` 在 `options.system` 缺省时自动回退读取 `role: 'system'` 消息。** 当宿主未在选项顶层传入 `options.system`、但在消息历史中携带了系统指示时，提示词现在仍能准确拼接系统指示。
- **新增：全面支持网页搜索、网页抓取、后台任务管理、定时任务及子 Agent 的原生工具卡片渲染。** 镜像卡片与步骤摘要现已原生支持 `search_web`、`read_url_content` / `web_fetch`、`manage_task`、`schedule` 以及 `invoke_subagent` / `send_message`，避免退化为生硬的 raw JSON；终端卡片 `TerminalResultView` 现在会从 `run_command` 输出中提取真实退出码（`The command exited with code X`），以便 DSH 渲染原生状态药丸。

## 0.4.45 (2026-10-10)

### English

- **Fix (macOS): `ensureIsolatedKeychain` no longer causes modal SecurityAgent password popups on startup (issue #42).** On macOS, `ensureIsolatedKeychain` applied `security set-keychain-settings` on existing isolated keychains on every boot and spawn. When the keychain was locked across app restarts, macOS's SecurityAgent raised blocking GUI dialogs demanding the password for each account — an unanswerable prompt because the isolated keychain was created with an ephemeral random passphrase. The settings (never auto-lock, no timeout) are already persisted on creation, so `ensureIsolatedKeychain` now returns `false` immediately when the keychain file exists on disk, never poking the security CLI again. New keychains are also provisioned with an empty passphrase (`-p ""`) and unlocked upon creation.
- **Fix: reasoning thinking thoughts arriving asynchronously are no longer dropped (issue #43).** In `EventMapper`, the thinking announcement gate prematurely consumed `thinkingAnnounced` when `thoughtTokens > 0` even before thought prose had finished resolving from the SQLite database. Later fragments or DONE tails carrying the resolved thought prose were subsequently dropped as "already announced". The announcement gate now only marks thoughts as announced when thought text is actually present. In addition, `readStepThoughts` in the adapter now adds a retry interval to accommodate SQLite WAL flush latencies during active model generation.
- **Fix (Mermaid): prevent "Syntax error in text" bomb SVG from leaking into the document body.** When a code block containing invalid diagram syntax was processed, Mermaid's fallback error-renderer appended a 2412px-wide SVG with a bomb icon directly into `document.body`. Due to an internal throw before cleanup in Mermaid v11, the leaked elements remained permanently attached to the window footer. `mermaid.initialize` now sets `suppressErrorRendering: true`, pre-validates syntax using `api.parse()`, passes a scoped mount container to `api.render()`, unconditionally sweeps temporary and stray elements (`#dagy-mmd*`, `#iagy-mmd*`) in a `finally` block, and injects protective CSS preventing body-level leaked nodes from rendering.

### 中文 (Chinese)

- **修复 (macOS)：`ensureIsolatedKeychain` 不再在每次启动时触发 SecurityAgent 钥匙串密码弹窗（issue #42）。** 在 macOS 上，`ensureIsolatedKeychain` 原先在每次 DSH 启动和进程拉起时都会对已存在的隔离钥匙串执行 `security set-keychain-settings`。当钥匙串在应用重启后处于锁定状态时，macOS 的 SecurityAgent 会对每个隔离账号弹出阻塞式系统密码框——由于此前钥匙串是使用未持久化的随机密码创建的，用户输入任何密码都无法通过。钥匙串的“永不自动锁”设置在首次创建时已持久化落盘，因此当钥匙串文件已存在时，`ensureIsolatedKeychain` 现在直接返回 `false`，绝不再调用 security CLI；新建钥匙串时也改用空密码（`-p ""`）创建并立即静默解锁。
- **修复：异步从数据库解析的思考过程正文不再被静默丢弃（issue #43）。** 在 `EventMapper` 中，思考公布逻辑原先只要检测到 `thoughtTokens > 0`，即使 SQLite 中的思考正文尚未完成异步提取，也会过早消耗 `thinkingAnnounced` 标记，导致后续分片或 DONE 尾包即使成功提取到了思考正文也被判定为“已公布”而直接丢弃。现在公布标记仅在实际存在思考正文时才消耗；同时适配器中的 `readStepThoughts` 增加了重试等待，以包容模型生成期间 SQLite WAL 写入的延迟。
- **修复 (Mermaid)：彻底解决 Mermaid 语法错误导致巨大的“Syntax error in text”炸弹图标残留在窗口底部的问题。** 当代码块包含不合法的图表语法时，Mermaid 内部的兜底错误渲染逻辑会向 `document.body` 追加一个 2412px 宽的巨大炸弹图标（💣）SVG；由于 Mermaid v11 在内部抛错前未执行清理，该临时元素会永久留在窗口底部污染界面。现在初始化时开启了 `suppressErrorRendering: true`，在渲染前通过 `api.parse()` 预校验语法，向 `api.render()` 传入局部挂载容器，在 `finally` 块中无条件清理临时节点（`#dagy-mmd*`、`#iagy-mmd*`），并通过安全 CSS 全面隐藏逃逸到 body 层级的任何错误元素。

## 0.4.44 (2026-10-09)

### English

- **Fix: a conversation stalled on a tool step no longer dead-ends after a host restart.** Continuation spans resolve their run from an **in-memory** `RunRegistry`; after DSH restarts (or the run is evicted) the recording is gone, and `stream()` used to fail that turn — and every retry of it — with "agy run … is no longer available (server restarted?) — please resend your message", an advice that could never succeed because the stale tool result stays at the end of the message list. The adapter now logs a warning and falls back to fresh-turn prompt assembly instead: the history digest carries the recorded tool result, and the session's `sessions.json` binding still points at the same agy conversation, so the next turn heals the conversation with no user action. Related hardening in the same change: (1) the `agy_tool` mirror now bypasses DSH's auto-review / permission gates via a `tools/pre-execute` hook (it only replays output agy already executed — routing it through the reviewer caused redundant review LLM calls, timeouts, and crashes on reviewer tool-call endings); (2) review-mode calls (`REVIEW_POLICY` system prompt) and calls with explicit `tools: []` are treated as auxiliary and never cut spans on tools; (3) on Windows, `.mjs`/`.js`/`.cjs` bins are spawned via `process.execPath` instead of failing with `EFTYPE` (this also makes the full test suite pass natively on Windows — the 33 pre-existing platform failures are gone). (PR #40)
- **Add: hide models from the DSH model picker (`hiddenModels`).** The Antigravity settings section (below account-pool scheduling) now renders a "Model visibility" row with one toggle per known model: hidden models disappear from the `/model` picker, everything else stays visible (deny-list semantics, so newly discovered models appear by default). Hiding is picker-only by design — `resolveModel` still accepts hidden ids, so in-flight sessions and direct model references keep working, and no catalog-cache invalidation is needed. The list is served from `/status` (`catalogModels` + `hiddenModels`) through the same sanitizer that feeds `listModels`, so the UI and the picker can never disagree; writes go through the existing `POST /config` allowlist (validated as an array of model ids) and persist to the runtime-overrides file immediately. `DSH_AGY_HIDDEN_MODELS` (comma-separated) also works as an env fallback. The plugin now also emits the payload-free `llm/adapters-updated` event whenever picker output can change (`hiddenModels` writes, boot-probe discovery, re-login, manual quota refresh) — the webview picker caches its catalog snapshot and only re-reads after that event, so without it toggles would not show up until the next app restart. (PR #39)
- **Fix: the Windows node-shim spawn merged from #40 now really runs the script instead of booting a second app instance.** `process.execPath` is the Electron binary in the packaged desktop host, so the `isNode` branch now sets `ELECTRON_RUN_AS_NODE=1`; plain node ignores the variable, so POSIX and the test suite are unaffected.

### 中文 (Chinese)

- **修复：停在工具步骤上的会话在宿主重启后不再进入死胡同。** 续接 span 依赖的 run 录像存放在**纯内存**的 `RunRegistry` 里;DSH 重启(或录像被淘汰)后录像即消失，`stream()` 会让该轮失败——而且每次重试都失败，报 "agy run … is no longer available (server restarted?) — please resend your message"。这个"请重发消息"的建议永远不可能成功：失效的工具结果始终钉在消息列表末尾，续接检测每轮都命中同一个 runId。现在适配器会记录一条警告并**回退到全新轮次的 prompt 组装**：历史 digest 携带已记录的工具结果，会话在 `sessions.json` 里的 conversation 绑定仍指向同一个 agy 会话，下一轮即自动自愈，无需用户做任何事。同一批提交中的相关加固:(1) `agy_tool` 镜像现在通过 `tools/pre-execute` 钩子绕过 DSH 的 auto-review / 权限门(它只是重放 agy 已经执行过的输出——送审会导致重复审查 LLM 调用、审查超时，以及审查员以 tool-calls 结尾时的崩溃);(2) 审查模式调用(`REVIEW_POLICY` 系统提示)与显式 `tools: []` 的调用按辅助调用对待，不再在工具步骤上切分 span;(3) Windows 下 `.mjs`/`.js`/`.cjs` 形式的 bin 改为经 `process.execPath` 启动，不再触发 `EFTYPE`(这也让整个测试套件在 Windows 上原生全绿——33 个既有平台失败清零)。（PR #40）
- **新增：在 DSH 模型选择器中隐藏指定模型（`hiddenModels`）。** Antigravity 设置区（号池调度下方）新增"模型显示"一行，每个已知模型一个开关：关闭的模型从 `/model` 选择器中消失，其余照常显示（黑名单语义——新发现的模型默认可见）。隐藏只作用于选择器：`resolveModel` 仍接受被隐藏的模型 id，进行中的会话与直接引用不受影响，也无需清空模型目录缓存。模型列表由 `/status`（`catalogModels` + `hiddenModels`）提供，与 `listModels` 共用同一清洗逻辑，UI 与选择器永远不会不一致；写入走现有 `POST /config` 白名单（校验必须是模型 id 数组），立即持久化到 runtime-overrides 文件。环境变量 `DSH_AGY_HIDDEN_MODELS`（逗号分隔）亦可作为回退。插件现在会在所有会影响选择器输出的时机发出无负载的 `llm/adapters-updated` 事件（`hiddenModels` 写入、启动探测发现模型、重新登录、手动刷新额度）——webview 的模型选择器缓存目录快照、只在该事件后重读，缺少它时开关要到下次重启应用才会生效。（PR #39）
- **修复：合入自 #40 的 Windows node 脚本启动现在真正执行脚本，而不是再启动一个 App 实例。** 打包桌面端里 `process.execPath` 是 Electron 二进制，因此 `isNode` 分支现在会设置 `ELECTRON_RUN_AS_NODE=1`；纯 node 会忽略该变量，POSIX 与测试不受影响。

## 0.4.43 (2026-10-06)

### English


- **Fix (Windows): Chinese tool output is no longer mangled (issue #37).** Windows pipes carry bytes in the child's console code page: on a zh-CN system agy captures pwsh output as CP936 (GBK), and the plugin decoded every stream as UTF-8 — so the Chinese refusal text arrived as mojibake, and because that text is what agy stores in its conversation database the damage was permanent. stdout/stderr are now read as raw bytes and decoded **per line** through the console code page (`chcp` probe → GBK/Big5/Shift_JIS/EUC-KR/Windows-125x), falling back to UTF-8 whenever a line is valid UTF-8; POSIX behaviour is bit-for-bit unchanged (the probe returns `utf-8`). Lines — not chunks — are the decoding unit because a multi-byte character can straddle a chunk boundary but never a newline.
- **Fix: `dsh plugin add git+https://…` installs now build the plugin (issue #38).** `dist/` is not committed and only `prepack` existed, which never runs for git dependencies — so a hub/git install produced a package without `dist/` and failed to load. A `prepare` script now builds on git installs (npm/pnpm install devDependencies for git deps first); npm consumers are unaffected because `prepare` does not run for published tarballs. The install also aborted **earlier** than that: `@deepseek-ai/dsh-client-locale` was declared as a **non-optional** peer, so npm's automatic peer installation tried to fetch the unpublished `@deepseek-ai/dsh-paths@^0.0.1-rc.1` chain from the public registry and failed with a 404 — every `@deepseek-ai/*` peer is now optional (the host provides them at runtime and the bundle keeps them external), matching how third-party DSH plugins declare theirs.
- **Fix: the live "User location is not supported for the API use" refusal is now recognized, explained and routed around.** agy exits 3 with a `FAILED_PRECONDITION (code 400)` result envelope for this refusal, but the classifier only knew the older issue-#32 wording — so it surfaced as a bare `PROCESS_EXIT`, the sticky account never moved, and every retry hit the same unsupported location (hence the recurring failure). The signature is now matched, the failure carries a dedicated, retryable `ELIGIBILITY` code plus the actionable hint, and the refused account is rotated off the sticky pointer before the error surfaces (no cooldown penalty) — the automatic retry is then served by an account whose own proxy/egress region is supported.
- **Add: rotation now drains the account whose quota expires soonest (use-it-or-lose-it).** Sequential fallback used to advance in pool order, which could leave an account sitting on 60 % of a 5-hour window that resets in 20 minutes — that residual is discarded at the reset, so it was wasted. When the sticky account is drained (hard quota, cooldown, silent timeout) the next account is now the eligible one whose quota window refreshes **soonest** (5-hour window or weekly cap, whichever comes first); ties and accounts with no quota metadata yet keep the previous cyclic order, so a drained slot never bounces back to the primary, and rotation still never cools an account down on its own.
- **Fix: quota exhaustion and silent timeouts now retry onto the next account instead of dead-ending.** A hard server-issued quota / rate-limit refusal was classified as the generic `AGY_ERROR`, which the provider retry policy never retried — the account cooled down and the sticky pointer advanced, but the turn still surfaced a user-visible error while a healthy account sat idle. It now carries a dedicated, retryable `RATE_LIMIT` code, so the automatic retry is served by the next account in the pool. Deterministic `AGY_ERROR`s (bad region, empty request, pool fully cooled) deliberately stay single-shot. A **silent** timeout (no stdout event at all — unreachable Google or a wedged credential) now rotates the sticky pointer to the next account for the retry *without* a cooldown, so one account's black hole cannot masquerade as "all accounts in cooldown". Finally, `autoFallbackModel` is no longer useless: the hardcoded `gemini-3.5/3.6-flash` list downgraded *within* the exhausted family (all Gemini models share one quota pool), so a drained Google family could never be rescued — it now fails over across families (Gemini ⇄ Claude ⇄ GPT-OSS), which have separate quotas.
- **Fix: Antigravity console and chat toolbar now immediately display the active account when switching or after quota exhaustion.** When an account exhausted its 5h or weekly quota or hit rate limits, the scheduler advanced to the next backup account, but `lastActiveAccountId` was not proactively updated, leaving the console showing an outdated badge or no badge at all. `recordFailure` and `updateAccountQuotas` now proactively advance the active pointer immediately, self-heal client badges away from cooldown/quarantined accounts, clean up pointers when accounts are deleted/disabled/quarantined, and the chat toolbar button now visibly displays the active account alias (`AGY · <alias>`) in real-time. Furthermore, caller-aborted runs (`outcome.aborted`) are exempt from recording rate-limit failures, preventing ghost cooldowns (`"agy run aborted by caller"`) from poisoning pool rotation, and any historical abort cooldowns are automatically purged on startup.
- **Fix & Add: Mermaid diagram rendering with bundled local assets and universal block sniffing.** DSH renders fences with unknown grammar (like `mermaid`) as localized code blocks (labeled "代码块" in Chinese or "Code block" in English) with stripped or non-standard language attributes. Diagram detection now universally scans `.md-code-block` elements, filters known programming languages, and sniffs Mermaid diagrams from the content. Furthermore, `mermaid.min.js` (v11.17.2) is now served directly from the local plugin endpoint (`/plugins/agy-link/mermaid.min.js`), completely eliminating external CDN timeouts, failures, or blocking.
- **Fix: code cards referenced a non-existent font token, so the code font silently fell back to the hardcoded stack.** `ROW_CSS` spelled the DSH code-font token as `--dsw-font-family-code`, but the real token is `--ds-font-family-code` (no `w`). The mistyped name has zero definitions anywhere in DSH, so every `var(--dsw-font-family-code, <fallback>)` resolved to its hardcoded fallback (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), which carries no CJK coverage — Chinese text inside agy tool cards rendered in the OS default (SimSun / Microsoft YaHei) instead of the host's configured code font. The three affected selectors are `.agy-tv-card` (whose `font-family` is inherited by the header, copy button and body), `.agy-tv-preview` and `.agy-tv-diff-stat`.
- **Fix: tool-hop continuations no longer re-attach every historical screenshot.** When a continuation carried no new image, the prompt builder fell back to collecting attachments from *all* earlier user turns, so the same 4–5 UI screenshots were re-staged and re-referenced on every step (observed: 61 staged files for 5 unique images in one session). Image forwarding is now watermark-aware (`SessionBinding.sentImageIds`): only attachments the current agy conversation has not seen are staged. Staged files are also keyed by attachment id instead of call index, so a legitimate re-reuse overwrites rather than accumulates.
- **Fix: account / model switches now transfer the prior conversation properly.** A brand-new agy conversation (account switch, model switch, post-compaction re-seed) used to be seeded with only `digestMaxChars` (8K), silently dropping most of a long session. First contact now uses the new `contextTransferMaxChars` budget (default 660K, sized for 1M-token-class models), and the attachments that carry the visual context ride along once via the same image watermark.

### 中文 (Chinese)


- **修复（Windows）：中文工具输出不再乱码（issue #37）。** Windows 管道里的字节使用**子进程的控制台代码页**：中文系统上 agy 捕获到的 pwsh 输出是 CP936（GBK），而插件把整条流按 UTF-8 解码——中文报错于是变成乱码；又因为这段文本正是 agy 写入会话库的内容，损坏不可追回。现在 stdout/stderr 以**原始字节**读取并按**行**用控制台代码页解码（`chcp` 探测 → GBK/Big5/Shift_JIS/EUC-KR/Windows-125x），凡是合法的 UTF-8 行仍按 UTF-8 处理；POSIX 行为逐字节不变（探测直接返回 `utf-8`）。以「行」而非「块」为解码单位，是因为多字节字符可能跨块但绝不会跨换行。
- **修复：`dsh plugin add git+https://…` 安装现在会构建插件（issue #38）。** 仓库里没有提交 `dist/`，而只有 `prepack`——它**不会**在 git 依赖安装时执行，所以市场/git 安装得到的包没有 `dist/`，加载失败。现在新增 `prepare` 脚本，git 安装时会构建（npm/pnpm 会先为 git 依赖安装 devDependencies）；从 npm 安装的用户不受影响，因为 `prepare` 不会对已发布的 tarball 执行。安装其实在更早一步就已经失败：`@deepseek-ai/dsh-client-locale` 曾被声明为**非可选** peer，npm 的自动 peer 安装因此去公共 registry 拉取未发布的 `@deepseek-ai/dsh-paths@^0.0.1-rc.1` 依赖链并报 404 —— 现在所有 `@deepseek-ai/*` peer 都标为 optional（运行时由宿主提供，打包时保持 external），与第三方 DSH 插件的声明方式一致。
- **修复：线上「User location is not supported for the API use」区域拒绝现在被正确识别、解释并绕开。** 该拒绝报文是 agy 以退出码 3 + `FAILED_PRECONDITION (code 400)` 结果信封抛出的，而分类器只认得 issue #32 时期的旧措辞——于是它被当成裸 `PROCESS_EXIT`，粘性账号也不会移动，每次重试都撞同一个不支持的地区，所以你会觉得"总是出现这个问题"。现在该签名已被匹配，失败会带专用且**可重试**的 `ELIGIBILITY` 错误码与可操作提示，同时在错误抛出前把被拒账号从粘性指针上换掉（**不扣冷却**），自动重试就会落到代理/出口地区受支持的账号上。
- **新增：轮换优先使用「快过期」的账号（不用就浪费）。** 顺次兜底此前按号池顺序推进，可能让某账号 5 小时窗口里还剩 60%、20 分钟后就要刷新——这部分余量在刷新时会被直接丢弃，等于白扔。现在当粘性账号耗尽（硬限流 / 冷却 / 静默超时）时，轮换目标改为**额度窗口刷新最近**的可用账号（5 小时窗口与周额度取更早者）；时间相同或尚无额度信息时沿用原有循环顺序，既避免耗尽后回弹到主账号，也保证轮换本身不会给账号扣冷却。
- **修复：额度耗尽与静默超时不再「直接失败」，而是自动重试到下一个账号。** 服务器硬性限流/额度拒绝此前被归为通用 `AGY_ERROR`，而重试策略从不重试该错误码——账号确实进了冷却、粘性指针也确实推进了，但这一轮仍然把错误抛给用户，明明还有健康账号闲着。现在它使用独立的可重试错误码 `RATE_LIMIT`，自动重试即由池中下一个账号接管。确定性的 `AGY_ERROR`（区域不可用、空请求、全池冷却）刻意保持不重试。**静默超时**（全程零 stdout 事件——连不上 Google 或凭证卡死）现在会推进粘性指针到下一个账号供重试，且**不给账号扣冷却**，避免单个账号的黑洞被误报成「所有账号都在冷却」。另外 `autoFallbackModel` 不再是废功能：原先硬编码的 `gemini-3.5/3.6-flash` 是**同族内**降级（所有 Gemini 模型共用一个额度池），Google 族耗尽时永远救不回来；现在改为**跨族兜底**（Gemini ⇄ Claude ⇄ GPT-OSS，各自独立额度）。
- **修复：账号额度用尽或切号后，Antigravity 控制台与会话工具栏即时准确展示当前使用账号。** 当首选账号 5 小时/周额度用尽或触发限流冷却时，调度器虽能在内部切到次选账号，但此前 `lastActiveAccountId` 未被主动更新，导致管理控制台的绿色「当前使用」徽标停留在旧账号上或未点亮。现在 `recordFailure` 与 `updateAccountQuotas` 在耗尽时主动推进激活指针，前端直接信赖后端权威计算的当前账号；会话顶栏按钮直接常驻显示当前账号（如 `AGY · g98`），一目了然；同时修复了用户主动中断（Stop / 插话抢占）被误判为限流并给账号扣上“幽灵冷却”（`"agy run aborted by caller"`）的严重缺陷，启动时自动清理历史幽灵冷却。
- **修复与新增：Mermaid 图表离线本地直出与通用代码块识别。** DSH 的 Markdown 渲染管线没有 Mermaid 语法高亮，未识别的围栏会被渲染为“代码块”（英文 "Code block"）且语言标识可能丢失或非标准。探测机制现升级为全覆盖扫描 `.md-code-block`，排除常见编程语言后智能探测图表语法；并将 `mermaid.min.js` (v11.17.2) 随插件本地内置并由插件端口直出（`/plugins/agy-link/mermaid.min.js`），彻底告别外网 CDN 超时、连接挂起或被阻断导致的图表无法渲染问题。
- **修复：代码卡片引用了一个不存在的字体 token，导致代码字体静默回落到硬编码兜底栈。** `ROW_CSS` 里把 DSH 的代码字体 token 写成了 `--dsw-font-family-code`，而真实 token 是 `--ds-font-family-code`（无 `w`）。这个拼错的名称在整个 DSH 代码库里零定义，因此每一处 `var(--dsw-font-family-code, <兜底>)` 都取到硬编码兜底值 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`——该栈不含中文字形，导致 agy 工具卡片里的中文以系统默认字体（宋体 / 微软雅黑）渲染，而非宿主配置的代码字体。受影响的三个选择器是 `.agy-tv-card`（其 `font-family` 会向下继承到标题栏、复制按钮与正文）、`.agy-tv-preview` 与 `.agy-tv-diff-stat`。
- **修复：工具往返续跑不再重复附加全部历史截图。** 当续跑请求里没有新图片时，提示词组装会回退成收集**全部**历史 user 轮次的附件，于是同样的 4～5 张 UI 截图在每一步都被重新落盘、重新引用（实测一个会话 61 个暂存文件只有 5 份唯一内容）。图片转发现在按水位去重（`SessionBinding.sentImageIds`）：只暂存当前 agy 会话还没见过的附件。暂存文件名也改为按 attachment id 而不是调用序号，合法重用会覆盖而不是堆积。
- **修复：切换账号 / 切换模型后能正确带上此前的对话上下文。** 新建 agy 会话（切账号、切模型、压缩后重播种）此前只用 `digestMaxChars`（8K）做种子摘要，长会话的历史被大量丢掉。首次接入现在使用新的 `contextTransferMaxChars` 预算（默认 660K，面向 1M token 级模型），承载视觉上下文的图片也会通过同一水位机制补发一次。

## 0.4.43 (2026-10-03)

### English

- **Add: native Mermaid diagram rendering in DSH Desktop and Web.** Antigravity models (especially Gemini / Claude) frequently emit ````mermaid```` code blocks to visualize workflows, timelines, and architectures. Because DSH renders code blocks as plain text, diagrams previously showed as raw source text. `dsh-agy-link` now bundles an offline standalone Mermaid.js runtime (served from `/plugins/agy-link/assets/mermaid.min.js`) and mounts an interactive diagram viewer over `.md-code-block` elements:
  - Non-destructive DOM rendering preserving React's original `<pre>` structure to avoid re-render conflicts.
  - Tab switching between "Diagram" and "Code".
  - Interactive SVG zoom controls (Zoom In, Zoom Out, Reset, Fit).
  - Copy SVG source button with visual feedback.
  - Automatic dark/light theme synchronization with DSH's CSS color variables.
- **Add: local image & media display (`file:///`, absolute Windows & WSL paths) with fullscreen Lightbox.** Models generating or referencing local visual assets (e.g. concept art, mockups, artifacts) emit `file:///` URLs or local filesystem paths. Because DSH's markdown renderer rejects non-HTTP URLs (`remoteImageUrl`), images previously rendered as inert text (`<span class="imageAlt">`).
  - Added host endpoint `/plugins/agy-link/media` with security validation, MIME type sniffing, stream piping, and client cache headers, supporting Windows drive paths (`D:/...`), UNC paths, and WSL paths (`/mnt/...`, `/home/...`).
  - Integrated live streaming markdown image rewrite (`![alt](file:///...)` -> `![alt](http://127.0.0.1:${port}/plugins/agy-link/media?path=...)`).
  - Retrospective DOM enhancer inspecting React Fiber props on `<span class="imageAlt">` in historical session turns to recover original file paths and restore image previews retroactively.
  - Enhanced local file links (`a[href^="file://"]`) to image files with thumbnail previews.
  - Fullscreen interactive Lightbox modal with zoom, pan, and "Copy Path" button.
- **Add: interactive user decision & choice adaptation (`ask_question` and Markdown Choices).** Antigravity models actively solicit user decisions and guidance through the `ask_question` tool or structured markdown decision templates (`### 💬 请您拍板` / `请选择`).
  - Extended tool card mirroring for `ask_question` with structured question text, selectable answer badges, and a "Fill into Chat" action button.
  - Extended tool card mirroring for image tools (`generate_image`, `view_file` on images) with inline visual thumbnails and Lightbox triggers.
  - Added markdown choice scanner detecting decision headers and list options, mounting interactive quick-action selection chips that directly fill the selected option text into DSH's chat composer (`[data-composer-input]`).
- **Fix: code cards referenced a non-existent font token, so the code font silently fell back to the hardcoded stack.** `ROW_CSS` spelled the DSH code-font token as `--dsw-font-family-code`, but the real token is `--ds-font-family-code` (no `w`). The mistyped name has zero definitions anywhere in DSH, so every `var(--dsw-font-family-code, <fallback>)` resolved to its hardcoded fallback (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), which carries no CJK coverage — Chinese text inside agy tool cards rendered in the OS default (SimSun / Microsoft YaHei) instead of the host's configured code font. The three affected selectors are `.agy-tv-card` (whose `font-family` is inherited by the header, copy button and body), `.agy-tv-preview` and `.agy-tv-diff-stat`.
- **Fix (Windows): auto-detect system proxy from Windows Internet Settings (WinINet) to fix quota refresh and sync timeouts.** On Windows GUI hosts (DSH Desktop / Electron), `process.env` does not inherit terminal `HTTP_PROXY`/`HTTPS_PROXY` variables. Direct requests to Google endpoints (`daily-cloudcode-pa.googleapis.com` / `googleapis.com`) timed out behind GFW, silently dropping quota updates while the frontend showed "额度已刷新". The host now automatically detects system proxy settings from the Windows Registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` `ProxyServer`) and routes all undici fetch calls and child process environments through the proxy.
- **Fix (Windows): Windows Credential Manager multi-account collision / quota draining across pool accounts.** On macOS, each account has an isolated Keychain file (`login.keychain-db`) via `$HOME`. On Windows, `agy.exe` reads credentials via `zalando/go-keyring` (`advapi32!CredRead("gemini:antigravity")`), which accesses Windows Credential Manager globally per logon session and ignores `HOME` / `USERPROFILE`. When secondary pool accounts were spawned, `agy.exe` read the primary account's token from Credential Manager, running secondary turns under the primary account and draining its quota (e.g. `g98` dropping to ~17% while secondary accounts appeared unused). The host now actively synchronizes Windows Credential Manager before each turn with the target account's token, persists any refreshed tokens back to that account's directory upon completion, and restores the primary account upon release.

### 中文 (Chinese)

- **新增：DSH 客户端 / Web 端原生 Mermaid 流程图与图表渲染。** Antigravity 上的 Gemini 与 Claude 模型在梳理架构与方案时经常输出 ````mermaid```` 代码块。DSH 原本仅将其作为普通文本代码块展示，导致图表无法直观查看。`dsh-agy-link` 现内置离线 Mermaid.js 运行时（通过 `/plugins/agy-link/assets/mermaid.min.js` 托管），为所有包含 `mermaid` 代码块的区域挂载交互式图表卡片：
  - 无破坏性 DOM 操作，安全保留 React `<pre>` 节点结构以防重渲染崩溃。
  - "图表" 与 "代码" 标签页一键无缝切换。
  - 交互式缩放控制（放大、缩小、重置比例）。
  - 一键复制 SVG 源码到剪贴板。
  - 自动跟随 DSH 主题色（暗色 / 亮色）切换渲染配色。
- **新增：本地图片与媒体展示（支持 `file:///`、Windows 绝对路径与 WSL 路径）及全屏灯箱。** 模型在生成或引用本地视觉资源（如设计图、原画预览、制品图）时，通常会输出 `file:///` 协议或本地文件系统路径。DSH 内置的 Markdown 渲染器出于安全只接收 HTTP(S) 地址，导致图片回退为静态文本 `<span class="imageAlt">`。
  - 插件后端新增 `/plugins/agy-link/media` 路由，具备安全边界校验、MIME 类型自动推断、流式传输与客户端缓存支持，全面兼容 Windows 盘符路径（`D:/...`）、UNC 路径以及 WSL 环境路径（`/mnt/...`、`/home/...`）。
  - 流式响应实时重写：在模型输出流中即时将 `![alt](file:///...)` 转换为通过本地服务代理的安全可访问 URL。
  - 历史会话无损追溯：前端增强器通过 React Fiber 属性提取历史消息中已失效 `<span class="imageAlt">` 的原始路径，自动补全渲染出真实缩略图，重开历史对话亦可完整查看图片。
  - 本地超链接图片识别：自动识别指向图片的 `file://` 链接并在下方挂载缩略图。
  - 全屏交互式灯箱（Lightbox）：支持双击/按钮放大缩小、拖拽平移以及「复制路径」到剪贴板。
- **新增：用户选择与拍板决策交互适配（`ask_question` 工具卡片与 Markdown 决策选项快捷填入）。** Antigravity 体系下的模型经常调用 `ask_question` 或输出结构化的拍板询问（如 `### 💬 请您拍板：1. 路线 A... 2. 路线 B...`）。
  - 深度适配 `ask_question` 工具卡片：以结构化卡片渲染问题与候选选项，提供候选气泡及「填入输入框」一键操作。
  - 扩展图片类工具卡片预览：`generate_image` 以及针对图片路径调用的 `view_file` 均以大图卡片配合直接查看与灯箱展示。
  - 自动扫描 Markdown 拍板决策区：自动识别「请您拍板 / 请您指示 / 请选择」等段落选项，挂载交互式快捷选项芯片（Chips），点击即可自动填入 DSH 底部聊天输入框，极大提升人机协作效率。
- **修复：代码卡片引用了一个不存在的字体 token，导致代码字体静默回落到硬编码兜底栈。** `ROW_CSS` 里把 DSH 的代码字体 token 写成了 `--dsw-font-family-code`，而真实 token 是 `--ds-font-family-code`（无 `w`）。这个拼错的名称在整个 DSH 代码库里零定义，因此每一处 `var(--dsw-font-family-code, <兜底>)` 都取到硬编码兜底值 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`——该栈不含中文字形，导致 agy 工具卡片里的中文以系统默认字体（宋体 / 微软雅黑）渲染，而非宿主配置的代码字体。受影响的三个选择器是 `.agy-tv-card`（其 `font-family` 会向下继承到标题栏、复制按钮与正文）、`.agy-tv-preview` 与 `.agy-tv-diff-stat`。
- **修复 (Windows)：自动识别 Windows 系统代理（WinINet），修复点击「刷新/同步」额度静默超时失效。** Windows 桌面版客户端（Electron GUI）启动时，`process.env` 默认不包含终端环境下的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。当未在设置里显式填入代理时，直连 Google 额度接口（`daily-cloudcode-pa.googleapis.com` 及 `googleapis.com`）会触发连接超时，后端异常捕获后静默退出，前端虽提示「额度已刷新」但数值永远保持原样。插件现增加自动注册表探针（读取 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`），自适应识别系统代理（如 `127.0.0.1:17891`），并自动注入到 undici 请求与子进程环境变量中。
- **修复 (Windows)：Windows 凭据管理器跨账号撞车，导致池中副账号偷偷消耗主账号（g98）额度。** macOS 下每个账号拥有独立的钥匙串文件（`login.keychain-db`），通过重定向 `$HOME` 即可实现天然隔离；而 Windows 下 `agy.exe` 使用 `zalando/go-keyring`，直接调用 Win32 API `advapi32!CredRead("gemini:antigravity")`。Windows 凭据管理器是全局绑定到当前登录会话的，完全忽略 `HOME` 与 `USERPROFILE`！这导致无论池中调度哪个副账号，`agy.exe` 启动时始终读取系统凭据管理器中残留的主账号 token 执行，造成「用着副账号，消耗的全是主账号额度」（导致用户发现 g98 额度无故跌至十几个点而副账号几乎不动）。插件现针对 Windows 实现动态凭据同步：每次调用前将目标账号 token 瞬时写入 `gemini:antigravity`，调用结束后将最新刷新后的 token 存回该账号目录，并自动恢复主账号原始凭据。


## 0.4.42 (2026-09-30)

### English

- **Fix: provisioned pool keychains are now set to never auto-lock.** A created keychain can lock later (system sleep / lock policy); a locked keychain turns every agy keyring save into an unanswerable password dialog — the keychain password is random and only the plugin knows it, so the user's login password is always rejected. `ensureIsolatedKeychain` now applies never-auto-lock settings on every boot/spawn/login (idempotent), not just at creation.

### 中文 (Chinese)

- **修复：预置的池账号钥匙串现在设置为永不自动锁。** 新建的钥匙串之后可能被系统上锁（系统睡眠/锁定策略）；一旦上锁，agy 的每次 keyring 保存都会弹一个**无法回答**的密码框——钥匙串密码是随机的、只有插件自己知道，用户输登录密码永远不对。`ensureIsolatedKeychain` 现在在每次启动/拉起/登录时都会幂等地套用"永不自动锁"设置，而不仅仅在创建时。

## 0.4.41 (2026-09-30)

### English

- **Fix: the UI Stop button could not kill an offline wedged run.** `killTree` sent a single SIGTERM to the process group; agy's graceful-shutdown path ignores it while the process is wedged in offline dial retries (verified live: the run survived `kill <pid>` and only died on `kill -9`). The runner now escalates to SIGKILL for the whole group 3s after SIGTERM, so Stop always wins.
- **Fix: offline runs spun on "thinking" forever.** The idle watchdog treated stderr chatter as activity — agy logs a dial-retry line to stderr every ~35s when it cannot reach Google, so a run that never emitted one stdout event stayed "active" until the 240m print-timeout. The watchdog is now **stdout-only**; login flows opt back in via the new `stderrKeepalive` run option (a browser login is legitimately stdout-silent for minutes). A timeout with zero stdout events now reports the likely cause: the run cannot reach Google (check proxy/network).
- **Add: global `proxyUrl` config (`DSH_AGY_PROXY_URL` env works too).** GUI hosts don't inherit shell proxy env — the #1 reason plugin runs time out while the same command in a terminal works. An account's dedicated `proxyUrl` wins, then the global config; the effective proxy is injected into every agy spawn (`ALL_PROXY`/`HTTP(S)_PROXY`) and used by the quota / OAuth fetches. `/agy pool` now shows the effective proxy per account.
- **Fix (macOS): recurring "create login keychain" password popup.** Pool accounts run with an isolated HOME, and macOS has **no login keychain inside it** (`security default-keychain` → "A default keychain could not be found"), so agy's keyring save triggered the `system.keychain.create.loginkc` password dialog on every ~hourly token refresh; denying it fell back to the on-disk token (auth kept working — exit status 45/154 in agy logs). The plugin now provisions a throwaway per-account keychain and sets it as the default under that HOME — idempotently at boot, before every spawn and before every login — so keyring writes are silent and truly per-account.
- **Fix: transient network errors no longer flag accounts as "needs re-login".** Both flagging paths were too eager: the run-failure path matched any message containing `/auth/i` (e.g. `oauth2.googleapis.com … i/o timeout` transport noise) and the token-refresh path flagged **any** `token endpoint 400` — including captive-portal / proxy error pages. Both now require an authoritative OAuth state (`invalid_grant` / `invalid_client` / `revoked` / `disabled` / `unauthorized_client`) and transport-shaped failures are exempt — even a genuine AUTH classification is not trusted when the message is transport-shaped. A false flag also **removed the account from pool rotation** (`selectAccount` skips authRequired), so this was silent capacity loss plus a scary badge that the next manual quota refresh would immediately disprove.
- **Add: flagged accounts self-heal in the background.** `markAuthRequired` now stamps `authMarkedAt`; after 10 minutes the background poll includes the flagged account for one token verification — if the stored refresh token still works the flag clears itself (previously this required a manual 刷新额度 click); if it is truly dead the flag is re-stamped. Risk-control exposure: at most one token-endpoint call per 10 minutes per flagged account.
- **Add: "In use" badge in the Antigravity console.** Exactly **one** account card shows the green zap badge: the account of the most recent agy spawn (`lastActiveAccountId`), localized (zh/en/pt-BR/es). The per-family scheduler pointers (`activeAccountIds`) are an internal scheduling detail and can legitimately sit on families that are not running anything — deriving the badge from them lit up two cards at once, which reads as "two accounts in use".
- **Fix: a steer replacement now waits for the run it killed to exit.** A new prompt arriving while a run is live preempts that run and resumes the same agy conversation (`--conversation <id>`); the replacement spawn previously raced the abort, so two agy processes could briefly append to one conversation. The spawn now waits (bounded, 3.5 s) for the aborted run to settle.
## 0.4.40 (2026-09-28)

### English

- **Fix (issue #34): post-tool hops dropped the task text and images.** dsh-llm 0.1.7 promotes tool results to `role: 'tool'` (0.1.x used `role: 'user'` + `source.callId`). `detectContinuation` and the trailing-span extractor only accepted the 0.1.x shape, so every hop after the first tool round-trip lost the mirror continuation, assembled an empty/digest-only prompt (`request carries no user text` or "what should I do next?"), and silently dropped image attachments. Both schemas are now accepted (`message.toolCallId`, `source.callId`, nested `tool-result` blocks); nested tool-result text and images are forwarded.
- **Fix (issue #35): continuation prompts must keep the live task.** `buildDigest` used to let a wall of tool-result text consume the 8K budget and truncate the user's question away. The latest real user turn is now reserved at the head of the digest; the assembled prompt always re-states it whenever the trailing span is tool-results only. A dead loop of "read my own agy logs" with no task can no longer start.
- **Fix (issue #35): aborted runs now persist the agy conversation id.** Binding was only written when `failure === null`, but a tool-cut / caller abort / timeout is exactly the path that used to drop it — so the next hop always started a brand-new agy conversation (`conversationID=""`) with digest-only prompt. The id is now harvested from a live run before steer-preemption and persisted on abort/timeout/process-exit (auth / rate-limit / conversation-rejected still drop the binding).
- **Fix (issue #32): region eligibility refusals get a clear cause.** agy exits 1 with `Eligibility check failed: … not currently available in your location` (e.g. Seoul). This is a Google-side account/region restriction, not a proxy or quota bug. The bridge now classifies it and surfaces an explicit `AGY_ERROR` with guidance instead of a bare `PROCESS_EXIT`.

### 中文 (Chinese)

- **修复：UI 的 Stop 按钮杀不掉离线卡死的 run。** `killTree` 只对进程组发一次 SIGTERM；而 agy 困在离线拨号重试里时会无视 SIGTERM（实测 `kill <pid>` 无效、只有 `kill -9` 能杀掉）。现在 runner 在 SIGTERM 3 秒后对整组升级 SIGKILL，Stop 按钮必定生效。
- **修复：连不上 Google 时 run 永远转圈。** 旧看门狗把 stderr 输出当作活动——agy 连不上 Google 时每 ~35 秒往 stderr 写一条拨号重试日志，于是一个连一条 stdout 事件都没有的 run 一直“活着”，直到 240 分钟的 print-timeout。看门狗现在**只认 stdout**；登录流程通过新的 `stderrKeepalive` 选项继续保活（浏览器登录本来就会长时间没有 stdout）。零 stdout 事件的超时现在会直接说明原因：无法连接 Google（检查代理/网络）。
- **新增：全局 `proxyUrl` 配置（也支持 `DSH_AGY_PROXY_URL` 环境变量）。** GUI 应用不继承 shell 的代理环境变量——这是“终端里没问题、插件里必超时”的头号原因。账号专属 `proxyUrl` 优先，其次全局配置；生效代理会注入每个 agy 进程（`ALL_PROXY`/`HTTP(S)_PROXY`），额度 / OAuth 请求同样走代理。`/agy pool` 现在会显示每个账号的生效代理。
- **修复（macOS）：反复弹出“创建登录钥匙串”密码框。** 池账号使用隔离 HOME，而隔离 HOME 里**没有登录钥匙串**（`security default-keychain` → "A default keychain could not be found"），agy 每次约每小时的 token 续期写入都会触发 `system.keychain.create.loginkc` 密码弹窗；取消后回退磁盘 token（认证不受影响——agy 日志里的 exit status 45/154 即此）。插件现在会为每个池账号预置一个专属的一次性钥匙串并设为该 HOME 的默认——在启动时、每次拉起前、每次登录前幂等执行——钥匙串写入从此静默，且真正做到按账号隔离。
- **修复：瞬时网络错误不再把账号标记为「需重新登录」（误判修复）。** 两条标记路径都过于激进：run 失败路径会匹配任何包含 `/auth/i` 的报错（比如 `oauth2.googleapis.com … i/o timeout` 这种纯传输噪音）；token 刷新路径会把**任何** `token endpoint 400` 都当成认证死亡——包括代理/门户返回的错误页。现在两条路径都要求出现权威的 OAuth 状态（`invalid_grant` / `invalid_client` / `revoked` / `disabled` / `unauthorized_client`），传输型失败一律豁免——即使带 AUTH 分类，只要报错文本是传输形态也不标记。误判的代价不只是吓人的徽标：被标记的账号会被调度器**排除出轮换**，等于静默损失一个账号，直到手动「刷新额度」把它证伪。
- **新增：被标记的账号后台自动复验。** `markAuthRequired` 现在会记录 `authMarkedAt`；10 分钟后后台轮询会把该账号放进来做一次 token 验证——刷新令牌若仍可用，标记自动清除（以前必须手动点「刷新额度」）；若真的失效则重新盖章。风控代价：每个被标记账号至多每 10 分钟一次 token endpoint 调用。
- **新增：控制台「当前使用」标识。** 现在**只会有一张**账号卡片显示绿色 ⚡「当前使用」徽标：最近一次真正拉起 agy 的账号（`lastActiveAccountId`），四种语言（zh/en/pt-BR/es）均已本地化。按模型族的调度指针（`activeAccountIds`）只是内部调度细节，可能停在当前并没有跑任何东西的模型族上——用它做徽标会一次点亮两张卡，看起来像"两个账号在用"。
- **修复：插话（steer）替换进程现在会等被抢占的 run 真正退出。** run 还在跑时来一条新提示词会抢占该 run 并续用同一个 agy 会话（`--conversation <id>`）；此前替换进程与 abort 存在竞争，极端情况下会有两个 agy 进程短暂同时往同一个会话追加。现在拉起前会有界等待（3.5 秒）被抢占的 run 收尾。
## 0.4.40 (2026-09-28)

### 中文 (Chinese)

- **修复 #34：工具往返之后任务文本和图片丢失。** dsh-llm 0.1.7 把工具结果提升为 `role: 'tool'`（0.1.x 是 `role: 'user'` + `source.callId`）。`detectContinuation` 与尾部消息提取只认 0.1.x 形态，于是第一次工具往返之后的每一跳都丢掉镜像续跑，拼出空 prompt 或纯 digest（`request carries no user text`，或 agy 反问「接下来做什么」），图片附件也一并丢失。现在两种 schema 都识别（`message.toolCallId` / `source.callId` / 嵌套 `tool-result`），嵌套工具结果文本与图片会一并转发。
- **修复 #35：续跑提示词必须保住任务。** 旧 `buildDigest` 允许大段工具结果吃掉 8K 预算，把用户的问题截掉。现在最新一条真实用户消息固定保留在 digest 开头；只要尾部只有工具结果，组装出的 prompt 也会重申该任务。「反复读自己日志、没有题目」的死循环不会再出现。
- **修复 #35：aborted 路径也会落库 conversationId。** 旧逻辑只在 `failure === null` 时写 binding，而工具切断 / 调用方中止 / 超时恰恰是最容易丢 id 的路径——下一跳于是每次都开全新 agy 会话（`conversationID=""`）+ 纯 digest。现在会在 steer 抢占前从 live run 收割 id，并在 abort/timeout/process-exit 时落库（auth / 限流 / 会话失效仍会删除 binding）。
- **修复 #32：地区资格拒绝给出明确原因。** agy 以 `Eligibility check failed: … not currently available in your location` 退出（例如首尔）。这是 Google 账号/地区限制，不是代理或额度问题。桥接层现在会识别并给出明确的 `AGY_ERROR` 与指引，而不是裸的 `PROCESS_EXIT`。

## 0.4.39 (2026-09-21)

### English

- **Fix (issue #33): DSH session interrupt during long tools (maven / compile).** An ACTIVE agy tool is silent on stdout for many minutes while it builds. The idle watchdog used the normal `timeoutMs` (default 10 min) and killed the healthy run mid-compile. While any tool step is outstanding the idle budget now rises to the print-mode ceiling (≥ 4 h) and restores to `timeoutMs` when the last tool completes (`RunningProcess.noteActivity`).
- **Fix (issue #33): identical retries no longer preempt a live long tool.** Session ownership is decided after prompt assembly: same prompt + live run → `BUSY` (leave the maven/compile alone); different prompt + live run → steer-preempt; settled run → retry allowed (still honors issue #32).

### 中文 (Chinese)

- **修复 #33：耗时工具（Maven/编译）期间会话被中断。** 工具 ACTIVE 后 agy 在 stdout 上长时间静默是正常的；旧空闲看门狗按 `timeoutMs`（默认 10 分钟）把还在编译的进程杀掉。现在只要存在未完成的工具步骤，空闲预算就抬到 print-mode 上限（≥ 4 小时），工具全部结束后恢复 `timeoutMs`。
- **修复 #33：同 prompt 重试不再抢占正在跑的长任务。** 会话所有权在 prompt 组装之后判定：同 prompt + live run → `BUSY`（不杀 Maven/编译）；不同 prompt + live run → 作为 steer 抢占；已 settle 的请求仍放行重试（兼容 #32）。

## 0.4.38 (2026-09-21)

### English

- **Fix (issue #32): "Duplicate request ignored" dead-end after a failed turn.** The in-flight debounce used a 10-second time wall keyed only on identical prompt text, and never cleared when a run settled. DSH auto-retries after a fast agy failure; that retry was rejected as `BUSY`, so every subsequent turn looked like "model unreachable" even with quota at 100% and a healthy proxy. Debounce now rejects only while a live (unsettled) run owns the session, or during a tight pre-spawn double-submit race. Settled runs (success / error / abort) never block a retry. A stream that itself preempts a live run always proceeds.

### 中文 (Chinese)

- **修复 #32：失败后重试被「Duplicate request ignored」卡死。** 旧的防抖只按「同 prompt + 10 秒」拦截，且请求结束后不清理。agy 快速失败后 DSH 会自动重试，结果被当成 BUSY 拒掉，后续每一轮都看起来像「模型不可访问」（额度 100%、代理正常也会中招）。现在只有会话上仍存在未结束的 live run，或 spawn 前极短窗口内的真双击，才会拒绝；已 settle 的请求（成功/失败/中止）一律放行重试；由本请求抢占 live run 的新回合一定放行。

## 0.4.37 (2026-09-18)

### English

- **Fix: ordinary `run_code` calls lost the code card.** The keyed `tool.call.toolview` registration for `run_code` **replaces** the host's built-in code row (a keyed slot is a takeover, not an addition), so every non-mirror Code Mode program was rendered by the plugin's fallback wrapper instead of DSH's code card. That wrapper used three classes — `agy-tv-header`, `agy-tv-badge`, `agy-tv-pre` — that carry **no CSS rule at all** in this package or in the host, so the icon, title and copy affordance disappeared and the body rendered as unstyled block text; the program was also silently truncated to 400 characters.
  - Non-mirror programs now render through a new `AgyCodeToolView` that reuses the mirror card's own styled vocabulary (`agy-tv-row`, `agy-tv-leading`, `agy-tv-title`, `agy-tv-sep`, `agy-tv-summary`, `agy-tv-card`, `agy-tv-card-content`, `agy-tv-copy-btn`): tool icon, localized title, `description` (or first program line) as the summary, click-to-expand full program, and a copy button.
  - Mirror wrappers are unaffected: they still delegate to `AgyMirrorToolView`, and the classification is byte-for-byte unchanged.
  - Added `code.title` / `code.inspect` / `code.copy` / `code.copied` to all four locale dictionaries, and declared `locale: NS` on the `run_code` registration so the standard `t` seat resolves them.

### 中文 (Chinese)

- **修复：普通 `run_code` 调用丢失代码卡片。** `run_code` 的 keyed `tool.call.toolview` 注册是**接管**而非叠加，因此每一次非镜像的 Code Mode 程序都落到插件的兜底包装上，而该包装用的 `agy-tv-header` / `agy-tv-badge` / `agy-tv-pre` 三个类在本包与宿主中**都没有任何 CSS 规则**——图标、标题与复制入口消失，正文变成无样式块级文本，程序还被静默截断到 400 字。
  - 非镜像程序改由新的 `AgyCodeToolView` 渲染，复用镜像卡片自身的样式词汇：工具图标、本地化标题、`description`（或程序首行）摘要、点击展开全文、复制按钮。
  - 镜像包装不受影响：仍委托 `AgyMirrorToolView`，分类结果逐字节不变。
  - 四份词典补齐 `code.title` / `code.inspect` / `code.copy` / `code.copied`，并在 `run_code` 注册上声明 `locale: NS`，让标准 `t` 座位解析这些键。

## 0.4.36 (2026-09-18)

### English

- **Fix (issue #30): Windows quota panel empty.** `readSystemKeychainToken()` had no win32 branch; primary credentials live in Windows Credential Manager (`gemini:antigravity`), not a disk token file. Added a PowerShell `CredRead` reader (same zero-dep pattern as macOS `security` / Linux `secret-tool`).
- **Fix: thinking blank after a reply finishes.** The client no longer rewrites React-managed `thinkBody` DOM (that wiped thought text on post-turn re-render). Styling is CSS-only; auto-expand uses the host disclosure control when prose is present.

### 中文 (Chinese)

- **修复 #30：** Windows 额度读取 — 从 Credential Manager 读 `gemini:antigravity`。
- **修复：思考结束后变空** — 不再改写宿主 React 的 thinkBody；仅 CSS + 非破坏性展开。

## 0.4.35 (2026-09-18)

### English

- **Reasoning UI: only show thinking when there is real content.** Empty `[agy thinking turn · N thinking tokens]` chips no longer spam tool-heavy turns. When agy stores only `toolAction`/`toolSummary` (common), those become the visible thought line (e.g. `Searching the web — Search Wo Tianyu profile`). Full CoT prose still renders when present in the conversation DB.

### 中文 (Chinese)

- **思考 UI：** 无正文时不再刷 token 横幅；工具步骤优先展示 `toolAction`/`toolSummary` 作为意图说明；完整思维链仍按 DB 正文展示。

## 0.4.34 (2026-09-18)

### English

- **UI: cleaner tool cards in Code Mode.** When DSH registers `agy_tool`, the bridge now emits native tool-call blocks instead of `run_code` wrappers. Code Mode titles use a human preview (`$ ls · run_command`) instead of `replay agy tool step N`. A `run_code` toolview renders Antigravity cards when the program is still a mirror wrapper.
- **UI: less thinking spam.** Banner-only `[agy thinking turn · N tokens]` chips (no prose) emit at most once per run; turns that extract thought prose still show full reasoning.

### 中文 (Chinese)

- **界面：** Code Mode 下工具卡片更干净；有 prose 的思考仍完整展示，无正文的 token 横幅每轮最多一条。

## 0.4.33 (2026-09-18)

### English

- **Fix: thinking / tool-args invisible for pool accounts.** agy conversation SQLite DBs for isolated accounts live under `~/.dsh/agy-accounts/<id>/.gemini/antigravity-cli/conversations`, not system `~/.gemini`. The reader now searches the run's account home, `GEMINI_CLI_HOME`, system home, and pool account dirs.
- **Fix: `/agy status` could hang the command UI.** Auth probe is now bounded (8s) so command results always return (issue #29 symptom).

### 中文 (Chinese)

- **修复：号池隔离账号看不到思维链/工具参数** — 会话库在账号自己的 HOME 下，读取时会搜索账号目录。
- **修复：`/agy status` 可能挂起导致命令无输出** — 探测加 8s 超时。

## 0.4.32 (2026-09-17)

### English

- **Fix: agy Active Workspace falls back to C-drive scratch (issue #26).**
  - agy ignores process `cwd` for workspace activation; the resolved DSH/session workspace root is now always passed via `--add-dir` (in addition to media staging dirs).
- **Fix: `/agy <subcommand>` treated as plain chat (issue #27).**
  - Registered `input.hint` on the `/agy` command so DSH's composer intercepts `/agy workspace`, `/agy status`, etc. instead of silently falling back to a prompt.
- **Feature (via PR #25): stream full model thoughts** from agy SQLite (protobuf field 20.3) as native reasoning blocks.

### 中文 (Chinese)

- **修复：agy 无 Active Workspace、落到 C 盘 scratch（#26）** — 工作区根目录现在会通过 `--add-dir` 传入。
- **修复：`/agy` 子命令被当普通对话（#27）** — 补上 `input.hint` 声明。
- **特性（PR #25）：** 从 agy SQLite 提取并流式展示完整思维链。

## 0.4.31 (2026-09-17)

### English

- **UI & UX: Align thinking process and tool invocation view with native DeepSeek Harness (DSH) styling.**
  - **Native SVG Icons & Hover Transition (`src/client/toolview.ts` & `src/client/reasoning.ts`)**: Integrated native DSH icons (`IconChevronDownOutline14`, `IconApiOutline14`, `IconCodeOutline16`, `IconEditOutline16`, `IconBrowseOutline16`, `IconSearchOutline16`, `IconCopyOutline16`, `IconCheckOutline14`). Hovering over a row smoothly transitions the leading icon into a downward chevron (`chevronHover`, opacity 0 -> 1), reproducing official DSH micro-interactions.
  - **Tool Row & Card Restyling (`src/client/toolview.ts`)**: Replaced custom boxed badges with native 24px borderless inline rows featuring official running sweep animation (`data-state="run"`). Expanded card includes an interactive header with Cwd, command/path, and a one-click copy button with temporary checkmark feedback.
  - **Scrollable Long Content (`src/client/toolview.ts`)**: Added scrollable bounds (`max-height: 260px` / `280px` with thin scrollbars) for terminal stdout, file edits/diffs, and file viewing, preventing long output from overwhelming the chat stream.
  - **Reasoning Process Presentation (`src/client/reasoning.ts`)**: Adheres to official DSH default collapsed state. Implemented scrollable container (`max-height: 360px`) with slim scrollbars for expanded reasoning thoughts and styled turn metadata into clean tags (`.agy-thought-banner`).

### 中文 (Chinese)

- **界面与交互：深度对齐官方 DeepSeek Harness (DSH) 默认思维链与工具调用展示样式。**
  - **原生 SVG 图标与鼠标悬停动效（`src/client/toolview.ts` 与 `src/client/reasoning.ts`）**：集成官方原生工具图标（`IconChevronDownOutline14`、`IconApiOutline14`、`IconCodeOutline16`、`IconEditOutline16`、`IconBrowseOutline16`、`IconSearchOutline16`、`IconCopyOutline16`、`IconCheckOutline14`）。鼠标悬浮整行时，小图标平滑过渡显示为下拉箭头图标（`chevronHover`，opacity 0 → 1），高度还原官方原生微动效。
  - **工具行与卡片设计还原（`src/client/toolview.ts`）**：移除冗余徽章药丸，还原原生 24px 无边框轻量内联行与运行态扫光动画（`data-state="run"`）；展开卡片包含 Cwd、命令/路径头部与交互式「复制」按钮（带「已复制」反馈与自动复原）。
  - **超长内容滚动浏览（`src/client/toolview.ts`）**：针对终端输出、文件查看与 Diff 代码块增加最大高度限制（`max-height: 260px` / `280px`）与微型细滚动条，避免超长内容撑乱对话流。
  - **思维链正文呈现（`src/client/reasoning.ts`）**：遵循官方默认折叠规范；为展开后的思考过程增加独立滚动浏览区域（`max-height: 360px`）与细滚动条，并将轮次思考元数据美化为轻量圆角标签（`.agy-thought-banner`）。

## 0.4.30 (2026-09-15)

### English

- **Feature: Extract and stream model thoughts/reasoning from agy database.**
  - **Protobuf Field 20.3 Extraction (`src/host/agy-db.ts`)**: Decodes full model Chain-of-Thought (thoughts) from agy SQLite conversation databases (`steps` table, step_type `14`/`15` agent_response) via a deterministic varint protobuf scanner with sub-millisecond execution and zero external dependencies.
  - **Live Streaming Reasoning Card (`src/host/mapper.ts` & `src/host/adapter.ts`)**: Injects resolved thoughts into native DSH reasoning blocks (`reasoning: true`), presenting the structured template `[agy thinking turn · {N} thinking tokens]\n\n{thoughtBody}` for model thinking turns. Supports both eager leading reasoning blocks and deferred trailing blocks without breaking tool spans or text fragments.
  - **Client-Side Auto-Expansion (`src/client/reasoning.ts`)**: Auto-expands reasoning blocks when thoughts prose is present, while strictly respecting manual user collapse actions via DOM attribute tracking.
  - **Run Traceability (`src/host/recording.ts`)**: Persists extracted thought text in `AgyRunRecording` for full lifecycle traceability and replay.

### 中文 (Chinese)

- **特性：从 agy 数据库提取并流式展示完整思维链（Reasoning/Thinking）。**
  - **Protobuf Field 20.3 确定性解码（`src/host/agy-db.ts`）**：针对 agy 会话 SQLite 库（`steps` 表，step_type `14`/`15` agent_response），通过原生 Varint Protobuf 扫描器高性能提取模型完整思考正文（Field 20 -> Sub-field 3），亚毫秒级解析且无额外依赖。
  - **原生 Reasoning 卡片流式呈现（`src/host/mapper.ts` 与 `src/host/adapter.ts`）**：将提取到的思考内容流式推送至 DSH 原生推理卡片（`reasoning: true`），格式化呈现 `[agy thinking turn · *** thinking tokens]\n\n{思维链正文}`；支持前置流式输出与延迟解析补发，与工具步骤及正文片段无缝衔接。
  - **客户端智能展开（`src/client/reasoning.ts`）**：检测到思维链正文时自动展开 Reasoning 卡片，并通过 DOM 属性标记保证用户手动折叠行为不被覆盖。
  - **会话持久化与回放（`src/host/recording.ts`）**：在 `AgyRunRecording` 中记录思维链内容，保障全生命周期可追溯与回放。

## 0.4.29 (2026-09-15)

### English

- **Hotfix: client blank page / `cannot get property "locale" without inject` (issue #24).**
  - 0.4.28 removed `locale` from the client `export inject` list while still reading `ctx.locale`. Cordis treats every inject entry as a hard dependency and throws on undeclared service access, so the web client failed to load.
  - Restored `inject = ['slots', 'locale']`, use `ctx.locale` directly, and mark `@deepseek-ai/dsh-client-locale` as a required peer (shipped with `dsh-web-app`).

### 中文 (Chinese)

- **热修：0.4.28 客户端白屏 / `cannot get property "locale" without inject`（#24）。**
  - 0.4.28 把 `locale` 从 client `inject` 里拿掉却仍访问 `ctx.locale`；Cordis 对未声明服务的属性访问会直接抛错。
  - 恢复 `inject = ['slots', 'locale']`，直接使用 `ctx.locale`，并将 `@deepseek-ai/dsh-client-locale` 标回必选 peer。

## 0.4.28 (2026-09-15)

### English

- **Fix: Long prompts no longer hit Windows `spawn ENAMETOOLONG` (issues #14 / #11).**
  - When assembled argv would exceed a 24KB budget, the bridge drops `-p <prompt>` and feeds the prompt via `--input-format stream-json` on stdin (`{"event":"user","message":{"role":"user","content":...}}`), verified against live agy 1.2.x.
- **Fix: No flashing CMD consoles on Windows GUI hosts (issue #13).**
  - `openBrowser` and pool `open-terminal` / `add` `execFile('cmd.exe', …)` now pass `windowsHide: true`.
- **Fix: Dropped keyword-driven Recovery-boundary prompt injection** (from PR #20). Missing-file guidance stays in `/agy status` only.
- **Fix: Harden agy conversation DB reads.** Conversation ids are whitelist-validated before path join (path-traversal guard).
- **i18n: `@deepseek-ai/dsh-client-locale` is an optional peer.** Older DSH hosts install cleanly; the client falls back to Chinese strings when `ctx.locale` is absent.
- **CI: fork PR workflow approval documented** in `AGENTS.md` (maintainers approve `action_required` runs).
- **Fix: Windows conhost flash from agy itself (issue #23).**
  - Every agy spawn now defaults `AGY_CLI_DISABLE_AUTO_UPDATE=1` and `AGY_CLI_INTERACTIVE_HEADLESS=1` (present in the official binary; breaks the `--bg-updater` child chain that creates visible conhost even under `windowsHide`). Operator-set values win.
  - Boot-time `agy --version` + catalog probe is deferred 4s (unref'd); catalog still refreshes lazily on first model list / turn.

### 中文 (Chinese)

- **修复：长 prompt 在 Windows 上触发 `spawn ENAMETOOLONG`（#14 / #11）。**
  - argv 预算超过 24KB 时改为 `--input-format stream-json` 经 stdin 传入 prompt，协议已在本机 agy 1.2.x 验证。
- **修复：Windows GUI 下 CMD 窗口闪烁（#13）** — 相关 `execFile` 增加 `windowsHide: true`。
- **修复：移除关键词驱动的 Recovery boundary prompt 注入**；missing_file 指引仅保留在 `/agy status`。
- **加固：** agy 会话库 conversation id 白名单校验，防路径穿越。
- **i18n：** locale peer 改为可选，旧宿主可安装；无 `ctx.locale` 时回退中文。
- **CI：** 在 `AGENTS.md` 记录 fork PR 需维护者批准 workflow。
- **修复：Windows 上 agy 自身拉起可见 conhost（#23）。** 所有 agy spawn 默认注入 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 与 `AGY_CLI_INTERACTIVE_HEADLESS=1`（阻断 `--bg-updater`）；启动探测延迟 4s。

### English

- **Feature: Native `agy_tool` Tool Card UI for DSH >= 0.1.5.**
  - **Root cause (verified against DSH 0.1.5-rc.2)**: The browser conversation UI (`@deepseek-ai/dsh-client-ui-tool`) hardcodes card rendering by wire tool name through a lookup table (`TOOL_VARIANTS`: `bash`/`pwsh`→terminal, `write`/`edit`→diff, `read`/`grep`/`glob`→read/search, etc.), and never consults `presentCall`/`presentResult`. The bridge's internal `agy_tool` had no entry, causing every mirrored tool step (`run_command`, `write_to_file`, `replace_file_content`, `view_file`, `grep_search`, ...) to regress to a generic "agy_tool" raw JSON text row.
  - **Fix**: Registered a keyed `tool.call.toolview` extension slot for `agy_tool`, rendering native cards (`terminal`, `diff`, `read`, `search`, `list`, `delete`, `generic`) directly from mirror arguments in pure React with DSH theme CSS variables.
- **Fix: Restore Full Tool Arguments & Real Line Diffs via Agy DB (`replace_file_content` / `write_to_file`).**
  - **Root cause**: agy CLI's `filterToolParameters` strips large arguments (`CodeContent`, `TargetContent`, `ReplacementContent`) from `stream-json`, leaving only metadata like `TargetFile`. Diff cards could not show old vs new line contents.
  - **Fix**:
    - `src/host/agy-db.ts`: Sub-millisecond deterministic protobuf parser directly extracts `tool_name` and full arguments JSON from the agy SQLite conversation database (`~/.gemini/antigravity-cli/conversations/<id>.db`), copying `-wal` and `-shm` sidecars to guarantee WAL commit visibility.
    - `src/host/adapter.ts`: Dynamically resolves `activeConvId` and step index (`parseInt(ev.stepKey, 10)`), pre-resolving full tool args. Incorporates `getGitHeadContent` for `write_to_file` to diff against committed git HEAD on full-file writes.
    - Fixed `readFullToolArgs` cache to reload SQLite DB when newly generated steps are queried, plus added 50ms WAL flush retry.
- **Fix: Tool Span Cutting on Completion When Output Is Omitted in Stream-JSON.**
  - **Root cause**: In `agy stream-json`, file modification tools (`replace_file_content`, `write_to_file`) emit `state: "DONE"` without an `output` field in `tool_info`. `mapper.ts` previously checked `ev.tool.output !== undefined || ev.tool.error !== undefined`, dropping the completion event and causing the tool card to be skipped entirely (falling through to assistant text).
  - **Fix**: Updated `EventMapper` to recognize `ev.state === 'DONE' || ev.state === 'ERROR'`, cutting the span and emitting native `agy_tool` cards even when `output` is omitted. Ensured `toolInfo.error` is populated on `state: 'ERROR'`.
- **UI: Default Collapsed State, Content Previews, Badges, and Semantic Diff Styling.**
  - **Default Collapsed**: Tool cards now default to collapsed state (`useToggle(false)`), keeping the conversation stream neat and compact.
  - **Content Preview**: Collapsed cards display a concise one-line preview in the header (e.g. `± demo/old.txt` for edits, `+ demo/old.txt` for writes, first line of terminal output, search queries).
  - **Header Badges**: Added card kind badge (`[diff]`, `[terminal]`, etc.) and wire tool name badge (`[replace_file_content]`, `[run_command]`, etc.) beside the title.
  - **Body Output Caption**: Added an uppercase **输出** (OUTPUT) label caption above the output content in the expanded card body.
  - **Line Diff Styling**: Line diffs format relative paths (`Edit demo/old.txt`), bold red deletion markers (`-`) on red background, and bold green addition markers (`+`) on green background.
  - **Reliable Toggle**: Replaced raw `useState` setter with `makeToggle(setValue)` to ensure infinite multi-click collapse/expand reliability.
- **Test Suite**: 22 new unit tests across `test/toolview.test.ts`, `test/agy-db.test.ts`, and `test/mapper.test.ts`. 173/173 tests passing.

---

### 中文 (Chinese)

- **新特性：适配 DSH >= 0.1.5 的 `agy_tool` 原生工具卡片 UI**
  - **根因分析（针对 DSH 0.1.5-rc.2 前端验证）**：DSH 浏览器对话界面（`@deepseek-ai/dsh-client-ui-tool`）通过硬编码变体表（`TOOL_VARIANTS`）按 wire tool name 渲染卡片，且未消费 `presentCall`/`presentResult`。桥接内部镜像工具 `agy_tool` 未在表中，导致所有工具调用（`run_command`、`write_to_file`、`replace_file_content`、`view_file`、`grep_search` 等）均退化为带有原始 JSON 参数的通用文本行。
  - **修复方案**：为 `agy_tool` 注册专有的 keyed `tool.call.toolview` 扩展槽，直接基于镜像参数渲染高仿生的原生卡片（终端 `terminal`、代码对比 `diff`、阅读 `read`、搜索 `search`、列出目录 `list`、删除 `delete`、通用 `generic`），完全使用原生 React 与 DSH 主题 CSS 变量实现。
- **修复：通过 Agy 会话数据库恢复完整工具参数与真实代码 Diff（`replace_file_content` / `write_to_file`）**
  - **根因分析**：`agy` CLI 在输出 `stream-json` 时通过 `filterToolParameters` 过滤掉了大参数字段（`CodeContent`、`TargetContent`、`ReplacementContent` 等），导致前端 Diff 卡片仅能拿到 `TargetFile`，无法展示旧行与新行的代码变更。
  - **修复方案**：
    - `src/host/agy-db.ts`：实现确定性亚毫秒级 Protobuf 解析器，直接从本地 SQLite 会话库（`~/.gemini/antigravity-cli/conversations/<id>.db`）精准提取完整 JSON 参数，并拷贝 `-wal` 和 `-shm` 侧车文件以保证 WAL 提交完全可见。
    - `src/host/adapter.ts`：动态获取 `activeConvId` 与真实的步骤索引（`parseInt(ev.stepKey, 10)`），提前异步解析全量参数；并在 `write_to_file` 时结合 `getGitHeadContent` 读取已提交的 Git HEAD 内容进行整文件 Diff 比对。
    - 修复 `readFullToolArgs` 缓存：当查询会话后续新增的步骤时重新读取数据库，并加入 50ms WAL 刷盘重试容错。
- **修复：解决 stream-json 中工具完成无 output 时卡片截断丢失问题**
  - **根因分析**：在 `agy stream-json` 中，文件修改与写入工具（`replace_file_content`、`write_to_file`）在 `state: "DONE"` 时 `tool_info` 不输出 `output` 字段。原 `mapper.ts` 检查 `output !== undefined` 导致该完成事件被丢弃，卡片从未触发截断派发，直接滑入了后续助手正文。
  - **修复方案**：更新 `EventMapper` 完成判断，支持 `state === 'DONE' || state === 'ERROR'`，确保无输出工具亦能正常截断并生成原生工具卡片。
- **界面优化：默认折叠状态、单行内容预览、卡片双徽章与高亮 Diff 呈现**
  - **默认折叠**：工具卡片默认初始为折叠状态（`useToggle(false)`），保持对话流整洁紧凑，点击卡片头部即可展开查看输出。
  - **单行内容预览**：折叠状态下在头部展示单行内容摘要（如 Diff 显示 `± demo/old.txt` 或 `+ demo/old.txt`，终端显示首行输出，只读显示文件路径等）。
  - **双标签徽章**：卡片头部展示卡片类型徽章（如 `[diff]`、`[terminal]`）与工具原始名（如 `[replace_file_content]`、`[run_command]`）。
  - **正文输出标题**：卡片正文区域增设大写 **输出**（OUTPUT）标签标题。
  - **Diff 高亮呈现**：标题展示相对工作区路径（`Edit demo/old.txt`），删除行带有加粗红底 `-`，新增行带有加粗绿底 `+`。
  - **展开/折叠防死锁**：修复 `useToggle` 在无参调用时触发 `setState(undefined)` 导致折叠后无法再次展开的缺陷，封装为纯函数 `makeToggle` 保证多轮点击稳定翻转。
- **测试套件**：新增 22 个单元测试用例，涵盖 `test/toolview.test.ts`、`test/agy-db.test.ts` 与 `test/mapper.test.ts`，173 个测试全部通过。

---

## 0.4.27 (2026-09-11)

- **Fixed: Windows binary discovery misses the official Google installer path (Issue #7).**
  - `resolveAgyBin()` now probes `%LOCALAPPDATA%\agy\bin\agy.exe` (plus `.cmd`/`.bat` siblings and the WinGet Links shim), so installs via `irm https://antigravity.google/cli/install.ps1 | iex` no longer raise `AGY_NOT_INSTALLED` when PATH has not propagated to the GUI process.
- **Fixed: Quota unavailable on Linux (Issue #8).**
  - Added `readLinuxSecretToken()`: the primary account's OAuth credential is now read from the FreeDesktop Secret Service (GNOME Keyring / KDE Wallet) via `secret-tool`, with a python3-dbus fallback — the same `service="gemini" / username="antigravity"` go-keyring slot agy writes on Linux.
  - `QuotaService.readSystemKeychainToken()` now dispatches per platform (darwin → Keychain, linux → Secret Service), restoring quota refresh on Linux where no on-disk token file exists.
  - Shared go-keyring payload parsing (raw or `go-keyring-base64:` prefixed JSON) extracted into `parseGoKeyringPayload`.

## 0.4.26 (2026-09-07)

- **Added: Support for `gemini-3.8-flash` in Fallback Models Catalog (Issue #6).**
  - **Root cause**: `DEFAULT_FALLBACK_MODELS` defined in `src/common/types.ts` had not been synced with Google's latest model line-up, stopping at `gemini-3.7-flash`. When DSH booted or ran offline prior to dynamic `agy models` discovery, `gemini-3.8-flash` was missing from the model picker.
  - **Fix**: Added `{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }` to `DEFAULT_FALLBACK_MODELS`.
- **Fixed: Client Bundle `process is not defined` (PR #5 / realguan).**
  - In `tsdown.config.ts`, marked `react-dom` and `react/jsx-runtime` as external dependencies for client bundling (`platform: "browser"`), preventing development React runtime from being inlined into `dist/client.js` and eliminating browser `ReferenceError: process is not defined`.
- **Hardened: Test Suite Stability & Debounce Timing on macOS.**
  - Relaxed duplicate submission debounce window in `AgyAdapter` to 10,000ms with automatic size-capped map pruning, and adjusted test thresholds to account for cold Node subprocess spawning latency on macOS. All 151 unit tests passing.

## 0.4.25 (2026-09-04)

- **Fixed: Plugin Startup Blocker on DSH >= 0.1.1-rc.x / 0.1.2-rc.1 (`missing export 'CallId'`, issue #4).**
  - **Root cause**: Newer `@deepseek-ai/dsh-llm` versions (e.g. `0.1.2-alpha.1` ~ `0.1.2-rc.1`) renamed `CallId` to `ToolCallId`. A named import `import { CallId } from '@deepseek-ai/dsh-llm'` caused Node ESM static resolution to fail at startup with `The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'CallId'`, surfacing as a plugin load failure on DSH Desktop 2.0.5 and CLI.
  - **Fix**: Replaced named import with a namespace fallback resolution `toToolCallId = dshLlm.ToolCallId ?? dshLlm.CallId ?? identity`. This avoids missing named export evaluation errors and ensures seamless backwards and forwards compatibility across all DSH host versions.
  - **Ecosystem & Test Hardening**: Upgraded development dependencies to `@deepseek-ai/dsh-*@0.1.2-rc.1`. Configured `--test-concurrency=1` in test runner to prevent mock environment variable collisions across concurrent subprocess tests, achieving 100% pass rate across all 151 unit tests. Verified live startup with DSH 0.1.2-rc.1 and `dsh-lark-link`.

## 0.4.24 (2026-08-28)

- **Fixed: Antigravity Models Missing From Picker When Logged In (已登录/显示余量但模型列表不显示 — issue #1).**
  - **Decoupled Adapter Registration from Synchronous Binary Discovery**: `registerAdapter` now executes regardless of initial `bin()` probe results (using resilient fallback model catalog), ensuring the Antigravity provider is never dropped during startup even if CLI path resolution is deferred.
  - **Expanded macOS / Linux GUI App Path Discovery**: extended `resolveAgyBin` search candidates to include `~/.bun/bin`, `~/.cargo/bin`, `~/.local/share/pnpm`, `~/Library/pnpm`, `~/.yarn/bin`, `~/.npm-global/bin`, NVM (`~/.nvm/versions/node/*/bin`), FNM, Volta, ASDF shims, Linuxbrew, etc., fixing GUI desktop apps starting with minimal default system PATH.
  - **Account-Aware Model Discovery & Environment Isolation**: model discovery now inherits current active/primary account isolated environment and proxy settings, falling back across ready pool accounts if default system HOME is unauthenticated.
  - **Defensive Model & Effort Sanitization**: defensive catalog cleaning against empty IDs, blank names, empty reasoning effort arrays, and out-of-bounds `defaultEffort` to strictly satisfy DSH host validation and prevent fail-all provider group drops (`INVALID_CATALOG` / `INVALID_MODEL_*`).
  - **Cross-Platform & Unit Tests**: added defensive catalog normalization and explicit binary path resolution tests across test suites.

## 0.4.23 (2026-08-27)

- **Enhanced: Antigravity Tool Mirroring with Native Git +/- Diff Cards & Full Tool Vocabulary.**
  - **Tool Vocabulary & Parameter Mapping**: mapped agy's official editing tool `replace_file_content` (`TargetFile`, `TargetContent`, `ReplacementContent`, `Description`, `Instruction`) and write tool `write_to_file` (`TargetFile`, `CodeContent`, `Overwrite`, `Description`) to DSH native `DiffCallView` / `DiffResultView` cards.
  - **Git Head Base Line Diffing**: added cross-platform `getGitHeadContent` to retrieve committed file content for full-file writes (`write_to_file`), allowing DSH to render line-by-line git `+`/`-` additions and deletions rather than treating existing modified files as blank new files.
  - **Expanded Tool Support**: mapped `view_file` (with `AbsolutePath`/`StartLine` line location navigation), `grep_search`, `find_by_name`, `ask_question`, `read_url_content`, and `generate_image` onto their respective native/generic tool cards with descriptive titles.
  - **Cross-Platform Hardened**: path normalization with forward-slash compatibility across Windows/macOS/Linux, `windowsHide: true`, strict subprocess timeout, and safe error fallback.

## 0.4.22 (2026-08-27)

- **Fixed: `registration.adapter.prepareCall is not a function` on new DSH hosts (本轮运行失败 UNKNOWN).**
  - **Field report**: after upgrading the DSH host (manjh's source checkout), every turn failed immediately with `registration.adapter.prepareCall is not a function` — category UNKNOWN in the GUI, no reply at all.
  - **Root cause (interface drift)**: dsh-llm >= 0.1.1-rc.2 added `LlmAdapter.prepareCall(provider, model, signal)` and `LlmRuntime.prepareCall()` now calls `registration.adapter.prepareCall(...)` **unconditionally** (both the prepared-call path and the direct `adapterStream` path). The plugin's devDependency pinned `@deepseek-ai/dsh-llm ^0.1.0-rc.6` (base class without `prepareCall`); when the plugin's adapter class resolved an older dsh-llm copy than the host runtime, `registration.adapter.prepareCall` was `undefined` and every turn threw a bare TypeError.
  - **Fix**: `AgyAdapter` now implements `prepareCall` explicitly, returning `{ model: await this.resolveModel(...), stream: options => this.stream(options) }` — the exact one-generation capability-bound handle the new runtime expects (same shape as the base default, but present regardless of which dsh-llm copy the plugin resolves). Backward compatible: runtimes < 0.1.1-rc.2 never call it. The method is declared structurally (no `override` / new-type import) so the plugin keeps typechecking against dsh-llm `^0.1.0-rc.6` and the repo's `npm ci` peer resolution stays intact; the runtime contract matches the 0.1.1-rc.2 `PreparedAdapterCall` shape.
  - Regression test pins the contract end-to-end: `prepareCall` returns resolved model metadata (id/provider/defaultMaxTokens) plus a stream that runs a full fake turn.

## 0.4.21 (2026-08-27)

- **Fixed: Silent `agy exited with code 1` Hid the Real Cause (发送消息无回复、只见 exit 1).**
  - **Field report**: a user session log showed every turn failing with the bare message `agy exited with code 1` (code PROCESS_EXIT, empty stderr, zero tokens) — each attempt ran ~7–10s, failed once, retried once, failed again, and the UI never surfaced WHY (no reply text at all).
  - **Root cause of the blindness (verified live against agy 1.1.22)**: agy reports its failure as a `result` envelope on **stdout** (`{"event":"result",...,"status":"ERROR","error":"<human-readable reason>"}`) and exits 1 with EMPTY stderr — e.g. an invalid model/effort pairing fails instantly with `--model gemini-3.7-flash requires --effort (available: low, medium, high)`. The adapter's non-zero-exit branch dropped that envelope entirely: rate-limit-shaped errors were still classified (the classifier already read `lastResultError`), but any OTHER failure degraded to the bare exit-code line with no cause.
  - **Fix**: the PROCESS_EXIT failure message now prefers the stdout envelope's error text (falling back to the stderr tail). Same error code and retry policy; users finally see agy's own reason, e.g. `agy exited with code 1: upstream request failed while generating` or `…: --model gemini-3.7-flash requires --effort (available: low, medium, high)`.
  - **Diagnostics unaffected**: `/agy doctor` (`~/.dsh/agy-link/diagnostics/doctor-*.md`) still carries the full redacted raw stdout tail for deeper incidents.
  - Regression test pins the exact silent-failure shape (stdout envelope + exit 1 + empty stderr) via a new `exit-error` fake-agy mode.

## 0.4.20 (2026-08-27)

- **Fixed: Primary Account Quota Fetched With a STALE Token (主账号刷新/同步拿的值不对).**
  - **Root cause (verified live)**: on macOS, agy >= 1.1.15 keeps its CURRENT credential in the Keychain; the on-disk `antigravity-oauth-token` was a stale leftover from a PREVIOUS account's login. `getStoredToken` read the disk file FIRST and only fell back to the Keychain — so every 刷新/同步 used the old account's (still-valid) token and displayed ITS quota under the current login's name (observed: agy authenticated as q98… while the disk file still held elegantmanco's token; UI showed the wrong account's 5h/weekly numbers).
  - **Keychain-first token resolution**: for the primary / system-HOME account the Keychain credential now WINS over the on-disk file (disk remains the fallback for older agy builds and non-mac systems). Isolated pool accounts are pinned by test to never touch the shared Keychain. Verified end-to-end against live Google endpoints: the primary's token identity and quota now match the actual agy login (5h 91% / weekly 31% instead of the stale account's numbers).
  - **Token-anchored identity on manual refresh**: `refreshAccountQuota(force=true)` additionally calls the OAuth userinfo endpoint once per explicit user click and re-labels the slot to the token's TRUE owner (`resetAccountIdentity`), so an external `agy logout` + re-login self-heals in one click even when logs disagree.
  - **Log detection hardened**: `detectEmailFromAgyLogs` returns the LAST match per file (append-ordered logs → newest login wins), fixing first-match returning a superseded account.
  - **Risk posture preserved**: background polls (force=false) still NEVER call userinfo — zero extra network on the automatic path (pinned by a regression test).

## 0.4.19 (2026-08-26)

- **Fixed: Antigravity Models Missing From the Model Picker (登录成功、额度正常但模型列表为空 — issue #1).**
  - **Root cause**: when `agy models` lists a bare Gemini base alongside its effort variants (the agy 1.1.13 output shape, e.g. `gemini-3.7-flash` + `gemini-3.7-flash-medium`), `foldEfforts` emitted the base id TWICE — once as the folded base entry and once as a verbatim row. DSH's `llm.listModels` contract throws `INVALID_CATALOG` on any duplicate model id, and the host's model-catalog builder then drops the ENTIRE Antigravity provider group from the picker — so login and quota panels looked perfectly healthy while no Antigravity model could be selected.
  - **Fix (three layers)**: (1) `foldEfforts` now absorbs the bare base into its folded entry instead of duplicating it; (2) `parseModelsOutput` dedupes repeated raw slugs (first occurrence wins); (3) `AgyAdapter.listModels` dedupes ids as a final guard, so even a user-configured `fallbackModels` list containing repeats can never nuke the whole group.
  - Regression tests pin both bare-base-plus-variants shapes and the duplicate-slug parse, plus an adapter-level uniqueness guard test.
  - **Observability**: when the adapter-level guard drops duplicate ids it now logs which ids were removed (`model catalog contained duplicate ids [...]`) so field instances surface in DSH server logs instead of being silently masked. When reporting picker issues, attach the `/agy doctor` report (`~/.dsh/agy-link/diagnostics/doctor-*.md`) and the raw `agy models` output.

## 0.4.18 (2026-08-25)

- **Quota Fallback Never Clobbers Good Data (5h=100%/weekly-missing 根因).**
  - **What happened**: `retrieveUserQuotaSummary` transiently failed (proxy blip) while `fetchAvailableModels` still answered; the per-model fallback then OVERWROTE the stored family entry with a single-window partial shape — weeklyFraction vanished and the 5h row received wrong-window numbers (observed 5h=100%, reset a week out, weekly `—`, while the live API actually reported 5h 84% / weekly 47%).
  - **`mergeFallbackFamilyQuota`**: last-known-good complete family data now always wins over partial fallback; the fallback only fills families with no usable previous entry (first-ever refresh). Verified live: both endpoints answer correctly and a successful summary refresh fully restores the display.
  - Added `scripts/diag-quota.mts` one-shot endpoint probe for future incidents.

## 0.4.17 (2026-08-25)

- **Ghost-Cooldown & Quota-Display Fix (额度显示 0% 根因).**
  - **What happened**: the UI showed 5h quota as 0% while `agy` reported 98% — the parsed quota data was CORRECT all along, but (a) any active local cooldown forced the 5h bar to render 0%, and (b) the loose rate-limit classifier kept creating ghost cooldowns: it scanned the ENTIRE stdout (model prose mentioning "rate limit"/"quota", hash fragments containing "429") and matched bare keywords, so an unrelated tool/permission error froze a healthy account out of rotation with a 15-minute+ cooldown (captured real reason: `rate limit reached: declaring permissions: cortex tool write_to_file … invalid tool call error`).
  - **Hard vs soft classification**: new `looksLikeHardRateLimit` (RESOURCE_EXHAUSTED / code·status·HTTP 429 / too many requests / individual quota reached / quota exceeded·reached·exhausted / rate limit exceeded·reached·hit) is the ONLY pattern allowed to put an account into cooldown; soft signals (model overloaded / high traffic) still shape the error message but never cool accounts.
  - **Scan scope narrowed**: error classification reads stderr + the result envelope's error field only — stdout (event JSON + model prose) no longer participates.
  - **Honest quota bars**: a local cooldown no longer overwrites the server-reported fraction with 0%; it now appends a `· 本地冷却中` note next to the reset time instead.
  - Regression tests pin the exact incident text (cortex tool permission error) as a non-rate-limit fixture.

## 0.4.16 (2026-08-24)

- **External Re-Login Sync (换号自动/手动同步).**
  - **Root cause fixed**: after `agy logout` + re-login as a DIFFERENT account, the pool slot kept the old account's email, cooldowns, quotas and `auth_required` quarantine — and poll gating (0.4.15) then skipped the flagged slot forever, freezing the UI on the stale account.
  - **`resetAccountIdentity`**: detecting a changed email (from local CLI logs, zero network) now resets all identity-bound state (cooldowns / quotas / auth quarantine) while keeping slot config — the new account starts clean instead of inheriting the old one's restrictions.
  - **Zero-network reconciliation before poll gating**: the background poller pre-checks flagged slots via local log scan, so an external re-login self-heals within one poll cycle (≤15 min) without any extra request to Google. Manual click is instant.
  - **Auth self-heal on success**: a successful authenticated quota fetch clears a stale `auth_required` flag (the old token's invalid_grant no longer condemns the new login).
  - **Manual refresh upgrades**: the 刷新 button now also re-reads the model catalog (one `agy models` spawn per explicit click only — new subscription tier may expose different models), and every account card gains a 同步 button for single-account refresh.
  - **Primary slot always re-bootstrapped (real root cause of "UI stuck on old account")**: the primary slot was only created for an EMPTY pool, so once deleted it never came back while other accounts remained — the system-HOME login (e.g. after `agy logout` + re-login) had no slot to attach to and the UI kept showing an isolated account as 主账号. The slot is now recreated at the front on every load; deleting it no longer promotes an isolated account to primary. Disable the slot instead of deleting if unwanted.

## 0.4.15 (2026-08-24)

- **Quota Polling Risk-Exposure Minimization (root-cause follow-up).**
  - **Poll Interval 5min → 15min (configurable)**: New `quotaPollIntervalMs` config (env `DSH_AGY_QUOTA_POLL_INTERVAL_MS`, clamped to >= 60s) cuts background `v1internal` polling volume by 3x — the poller was the last remaining high-frequency network surface after the CLI-level hardening.
  - **Restricted-Account Poll Gating**: Automatic polling now skips disabled, auth-quarantined (`invalid_grant`) and 429-cooldown accounts (`shouldPollAccount`), so the poller never keeps probing Google endpoints for accounts already known to be limited. Manual UI force-refresh still refreshes everything.
  - **Userinfo Endpoint Called Only When Email Unknown**: The primary account previously hit the OAuth userinfo endpoint on every poll cycle just to detect account switching; that detection now rides the local log scan (`detectEmailFromAgyLogs`, zero network), eliminating one network call per cycle.

## 0.4.14 (2026-08-24)

- **Hardened 429 Rate Limit Cooldown & Circuit Breaker (Anti-Risk Control).**
  - **Accurate Reset Duration Parsing**: Added `parseResetDurationMs` to accurately extract server reset countdowns from strings like `"Resets in 21m25s"`, `"Resets in 2h26m6s"`, `"Resets in 45s"`, or verbose duration phrases.
  - **Safety Cooldown Buffer**: Account failures on 429 now automatically apply the parsed reset duration + a 10s safety buffer (or a 15-minute minimum backoff), preventing accounts from re-triggering rate limiters at the exact millisecond of reset.
  - **Non-Retryable 429 Classification**: Identified 429 / quota exhaustion errors from stderr / stdout and classified them as non-retryable `Err.AGY_ERROR` instead of `Err.PROCESS_EXIT`, stopping DSH from executing automatic rapid retries on exhausted accounts.
- **Organic Spacing Jitter, In-Flight Debounce & Burst Protection.**
  - **Human-like Timing Jitter**: Added randomized timing jitter (`+100ms ~ 400ms`) on top of the 500ms single-account throttle to produce natural non-periodic traffic distributions that evade automated queue detection.
  - **In-Flight Session Debounce**: Rejects identical prompt submissions within a 3-second window while an existing request is active (`Err.BUSY`), preventing frontend repeat loops and double-clicks from hammering the backend.
  - **Sliding-Window Rate Limiter**: Added configurable `rateLimitPerMinute` protection across all sessions to prevent runaway `/goal` autonomous loops from draining daily quotas.
- **Account Health Quarantine & Self-Healing.**
  - **Invalid Grant Quarantine**: Automatically detects `invalid_grant` / revoked OAuth tokens during refresh and flags the account as `auth_required`, immediately taking it out of pool selection and alerting the user in UI.
  - **Visual Health Dashboard**: Added red alert badges (`需重新登录`) and health indicators on account cards.
  - **Automatic Fallback Model**: Supports `autoFallbackModel` to smoothly route requests to available lower-tier models when high-tier models are exhausted.
- **System Hygiene & Telemetry Minimization.**
  - **Telemetry Opt-out**: Injected telemetry suppression flags (`DO_NOT_TRACK`, `DISABLE_TELEMETRY`) into child process environments to reduce unnecessary background event tracking to Google `cclog`.
  - **Automated Old Log Purge**: Added `sweepOldLogs` on plugin boot to automatically sweep CLI log files older than 7 days across system and isolated account directories.

## 0.4.13 (2026-08-21)

- **Fixed Multimodal Image Attachment Staging & Direct Disk Fallback.**
  - **Dynamic Attachment Service Lookup**: Fixed Cordis proxy boundary issue where `(ctx as any).attachments` evaluated to `undefined` when not statically declared in `inject`; now resolves via `ctx.get('attachments')`.
  - **Local Storage Direct Disk Fallback**: Added direct fallback to read from DSH's local content-addressed storage (`~/.dsh/attachments/v1/objects/<prefix>/<id>`), guaranteeing 100% reliable image byte extraction even if service bindings are uninitialized.
  - **Explicit Vision Tool Directives**: Enhanced prompt staging lines to explicitly reference the `view_file` tool and absolute file path (`[image attached: "..." staged at ... Inspect it using the view_file tool with AbsolutePath: "..."]`), ensuring `agy` proactively inspects attached images even when the user sends an image without accompanying text.

## 0.4.12 (2026-08-21)

- **Adaptive Tool Dispatch for Both Standard / Native Mode and Code Mode.**
  - Dynamically inspects `options.tools` on each model stream call.
  - In **Code Mode** (`run_code` present in tools list): emits `run_code` program wrapping `tools['agy_tool'](...)` to conform to code-mode dispatch rules.
  - In **Standard / Native Mode** (`agy_tool` / normal tools present): emits `agy_tool` directly with structured cursor arguments, eliminating `unknown tool "run_code"` and `unknown tool "agy_tool"` errors across all preset modes.
- **Fixed Primary Account Stale Token & Quota Sync on macOS Keychain.**
  - `agy` 1.1.15+ on macOS persists active login credentials via `go-keyring` in the macOS Keychain (`service: "gemini"`, `account: "antigravity"`), leaving stale files in `~/.gemini/antigravity-cli/antigravity-oauth-token` when users switch accounts outside DSH.
  - Added `readMacKeychainToken` to decode active `go-keyring-base64` credentials directly from macOS Keychain for the primary/system account.
  - Live quota & user profile (`fetchUserInfo`) now always read the active Keychain token, immediately detecting account switches and syncing the correct email and quotas.
- **Auto-Invalidate Conversation Binding on Model Switch.**
  - Switching models in the same DSH session now automatically drops the old agy `conversationId` binding, ensuring the prompt immediately executes with the new model without being locked to old agy conversation state.

## 0.4.11 (2026-08-21)

- **Fixed `Error: unknown tool "agy_tool": only run_code is callable directly` in DSH Code Mode.**
  - Restored the `run_code` wrapper dispatch (`WRAPPER_TOOL_NAME` + `buildMirrorRunCode`) for span cuts.
  - Under DSH's default Code Mode (`agent-presets: default: code`), model-direct tool calls are collapsed unless addressed to `run_code`. Wrapping the mirror invocation in `run_code` allows internal sub-dispatch to `agy_tool` to replay recorded events without being blocked by DSH's dispatch guard.

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
