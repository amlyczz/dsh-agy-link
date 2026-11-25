# agy 进程生命周期与无窗静默规范（唯一事实源）

> 维度：**一次 agy spawn 何时必须结束、凭什么结束，以及在桌面宿主下如何保持零弹窗闪烁**。

## 1. 三条独立的终止线

| 机制 | 触发 | 结果 |
| --- | --- | --- |
| 活动看门狗 `refreshWatchdog()` | stdout / 非噪声 stderr 数据重挂；超过 `idleBudgetMs` 无活动 | 杀进程树，`timedOut: true` |
| 轮次上限 `armTurnCap()` | `maxTurnMinutes > 0` 的墙钟上限 | 杀进程树，`capped: true` |
| 后台任务宽限 `IDLE_BACKGROUND_GRACE_MS`（5s） | stderr 出现 `root agent idle; waiting ... for background task(s)` | 5s 后杀进程树，`idleGraceTerminated: true` |

所有超时常量统一在 `src/common/timeouts.ts` 定义（`WATCHDOG_GRACE_MS`、`IDLE_BACKGROUND_GRACE_MS`、`ROUTE_TIMEOUT_MS` 等），`process.ts` 只引用不另立常量。

## 2. 终止与收敛不变式

- **stderr 噪声不算活动**：agy 内部守护进程每约 6 分钟打印 `fetchAvailableModels` / `token refreshed` / `loadCodeAssist` / `ListExperiments` 等例行日志，以及 429 重试退避行（`run.go:` 且含 `retrying in` / `RESOURCE_EXHAUSTED` / `code 429`）与斜杠重载提示（`Reloading system slash commands` / `Slash commands unchanged`）。`isBackgroundStderrNoise()` 过滤后再 `refreshWatchdog()`；stdout 始终算活动。
- **root agent idle 必须能收敛（issue #119）**：模型回复全部产出后，agy 在 print 模式下若等待遗留后台任务，5s 宽限后终止；`classifyFailure()` 对 `idleGraceTerminated` 返回 `null` 并合成 `ok: true` 的 result 事件，正常闭合输出块。
- **合成 result 必须带上真实答复（issue #127 / #128）**：回收发生在最终答复「已写入 agy transcript、尚未由 stdout 刷出」的时间窗内时，`synthResult.response` 不能用空串——`recoverFinalReply()` 从 `<brainDir>/.system_generated/logs/transcript.jsonl` 尾部（≤256 KiB，O(1)）恢复**最后一条 `USER_INPUT` 之后**、`content` 非空且**无 `tool_calls`** 的 `PLANNER_RESPONSE`。恢复不到时写入 `IDLE_GRACE_NO_REPLY_NOTICE`（中英双语「结果未确认、可能已执行」），而不是让 DSH 显示「完成」却零正文——空答复会被读成任务成功。
- **`hasResult` 只认 result 事件（issue #124）**：`init` 会写入 `resultConversationId`，若用它判断「已有结果」，合成 result 永远不执行，所有回收轮次都会以 `agy stream ended without a result event` 失败。
- **长会话默认不被缩短，后台辅助调用有界收敛**：`printTimeoutMinutes` 由 `longToolIdleMinutes`（缺省 240）与 `timeoutMs` 取大，并受 `maxTurnMinutes` 约束；但后台辅助调用（`compaction` / `session-title` / `review`）走 `createToolWatchdog(..., { isBackgroundAux: true })`，将 `printTimeoutMinutes` 封顶在 `<= 10` 分钟，并将 `maxTurnMs` 封顶在 `min(timeoutMs, 180_000)`（若配置了更小的 `maxTurnMinutes > 0` 则进一步取小），防止纯文本辅助调用挂死整条会话。
- **同步工具预算可释放**：工具步骤 `DONE`/`ERROR`/`RUNNING` 或模型恢复产出 text/thinking 时清理 `openToolKeys`，恢复 `generationIdleMs`。
- **Headless 权限拦截显式诊断（issue #121）**：当 `permissionMode: 'accept-edits'` 下无头 `agy -p` 因权限门禁无法弹窗而被拦截时，明确给出切换为 `skip` 或 `plan` 的可操作提示，不静默结束。

## 3. Windows 控制台闪窗消除与自更新抢占（issue #23 / #47 / #49）

`agy.exe` 在距上次更新检查 ≥15 分钟时会派生 `--bg-updater` → `agy --version` 孙进程链，分配可见伪控制台产生 0.2~0.4s 闪窗（`AGY_CLI_DISABLE_AUTO_UPDATE=1` 对旧构建不完全生效）。

- `preemptAgyAutoUpdate(env, now)`（`src/runtime/agy/auto-updater.ts`）在每次 `startAgyProcess()` spawn 之前刷新 `<appData>/last_check.timestamp` 与 `<appData>/updater/last_check.timestamp` 的 `mtime`，命中 `agy` 内部的 15 分钟 `skipping update (fast path)`，从源头避免派生 `--bg-updater` 且不影响用户手动执行 `agy update`。
- `PluginConfig.suppressAgyAutoUpdate` 在 Windows 默认 `true`，其余平台默认 `false`。
- 启动探测延迟执行并串行化，不在插件加载瞬间阻塞或并发拉起多份 `agy` 进程。

## 4. 验证锚点

- `test/features/background/background-task-hang.test.ts`：idle 宽限终止、stderr 噪声不喂狗。
- `test/integration/issue124-125-regressions.test.ts`：init 不冒充 result、子代理豁免与解除、stdout 唤醒取消回收。
- `test/provider/issue128-idle-reply.test.ts`：transcript 答复恢复、带 `tool_calls` 与上一轮答复都不算、无答复时的提示文案。
- `test/runtime/updater-preempt.test.ts`：隔离 HOME 下 `last_check.timestamp` 创建与刷新、`suppressAgyAutoUpdate: false` 不触碰文件。
- `test/runtime/proxy-keychain.test.ts`：活动看门狗与事件循环阻塞宽限。

## agy 可执行文件探测与诊断（`src/runtime/agy/bin.ts`, PR #133）

spawn 之前必须先定位 `agy`。`resolveAgyBin()` 返回 `null` 时，**必须给出可操作信息**，否则「not found on PATH」会被误读成「没安装」。

- `agyBinCandidates(cfg)` 是唯一的候选列表来源（配置 `agyBin` → `PATH` 各目录 → 平台默认安装位置）；`resolveAgyBin()` 只做「真实可执行优先于 cmd shim」的排序与存在性检查，签名与行为不变。
- `agyBinDiagnostics(cfg)` 返回 `{ probed, configured, installHint }`；`agyNotInstalledMessage()` 据此生成错误文案，包含两种覆盖方式（`agyBin` 配置项、`DSH_AGY_BIN` 环境变量——后者在 `common/config.ts` 里映射进 `cfg.agyBin`）与 `/agy doctor` 指路。头部徽标与 doctor 报告复用同一信息。
- 测试必须**注入 PATH**（`process.env.PATH` 临时替换）而不是假设宿主 PATH 的形态，否则在不同机器/CI 上会假失败。
- 锚点：`test/common/agy-not-installed-diagnostics.test.ts`（候选顺序、PATH 探测、平台安装位置、`agyBin` 优先级、诊断载荷、错误文案、doctor 段落）。

## 后台等待收割器（`src/runtime/agy/process.ts`, `idle-line.ts`, issues #124/#144）

agy 在等待自己派发的工作时会打印 `root agent idle; waiting for N background task(s)`。收割器的唯一目的是回收**僵尸等待**，绝不能误伤健康轮次。

- **N 由 agy 报告，是权威信号**：`N > 0` → 不武装收割器（任何宽限期长度都不足以让终止变正确）；`N = 0` 或该行无数字 → 走宽限期路径。
- 宽限期由 `idleGraceMinutes`（`DSH_AGY_IDLE_GRACE_MINUTES`）决定，默认 10 分钟，必须低于普通生成的空闲预算；`0` 关闭收割器，此时由活动看门狗与 `maxTurnMinutes` 兜底。
- 收割器在**任意未完成工具步骤**期间挂起（不只是子代理类工具），最后一步完成后重新武装——`run_command` 启动的构建与子代理等待是同一类情形。
- 教训：初版把「5 秒」当作经验值硬编码，而 agy 早已在日志里给出更可靠的判据。**能从协议里读到的信息，不要用时间猜。**
- **两种措辞都要解析**：`waiting for N background task(s)` 与 `waiting up to <duration> for N background task(s)`（agy 两种都会输出）。只匹配前者会让后者返回 `null`、从而在正数计数下仍然武装收割器（PR #147）。
- **被收割的轮次必须留下可消费的收尾**：SIGTERM 时 agy 可能刷出 `{ ok: false, response: '' }` 空结果。判据是 `hasConsumableResult`（`ok` 或非空 `response`），不是裸 `hasResult`——否则恢复逻辑被跳过、而 `EventMapper` 又忽略空结果，最终仍是 `INVALID_OUTPUT`。
- **死续接不得被重放**：settled recording 在续接点之后既无可消费 result、也无可切割工具步骤时，每次重试都会重驱同一份 recording（毫秒级失败直到耗尽）。`hasFinishableEventFrom(from, cutOnTool)` 让适配器遗忘它并新起尝试；注意判据必须包含**工具步骤**维度，只看 result 会把「工具步骤中途被切断」误判为死 recording 并重跑已完成的工作。
- **进程级死亡必须复活，不能重放**：settled recording 若以 `PROCESS_EXIT` / `TIMEOUT` / `INVALID_OUTPUT` 收尾（`isRevivableFailure`），其 recording 已随进程一起失效——重驱它只会在 8~200ms 内原样抛回同一条错误，DSH 的重试预算被空转耗尽（实测 2026-11-23：5 次重试耗时 8/10/8/8/193ms）。适配器必须 `runs.forget()` 并重新组装一次尝试（新 `agy acp`），由外层 `dsh-llm-retry` 的有界重试兜底。账号级错误（`RATE_LIMIT`/`ELIGIBILITY`/`NETWORK`/`OVERLOADED`/`AUTH`）仍走 `claimFailover` 换号路径，不得并入这一类，否则单进程崩溃会误触发换号（锚点：`test/provider/idle-grace-empty-result-and-dead-continuation.test.ts`）。
- **豁免必须撑过「等待前的状态回复」**（#148）：agy 要求模型在转后台后先发一句 text/thinking，之后才打印 idle 行。因此 `text`/`thinking` 只能恢复正常空闲**预算**，不得取消「后台等待」豁免；`state === 'RUNNING'` 对 `schedule` 类确定性等待意味着「仍在等」，需登记到终态。
- **`run_command` 不得整体豁免**（#119/#124）：它同样用于守护进程（dev server、watcher），回收它们正是 #119 的目的。后台构建靠 agy 自报的 `N > 0` 保护即可——**用协议信号，而不是给工具开后门**。
- 锚点：`test/features/background/issue148-background-wait.test.ts`、`test/integration/issue124-125-regressions.test.ts`、`test/provider/issue144-idle-grace.test.ts`（默认值/配置/环境变量/0 语义/工具挂起/正数不收割/up-to 措辞）、`test/features/background/background-task-hang.test.ts`（0 计数仍收割）、`test/provider/idle-grace-empty-result-and-dead-continuation.test.ts`（空结果恢复 + 死续接遗忘）。

## 回合以「正在运行 … 完成后立即 …」收尾 = 未完成回合（`src/common/announcement.ts`, 2026-11-24）

实测 `session-e778203d`（2026-11-23 16:46Z）：agy 的最后一条正文是「正在运行 Windows Vulkan RTX 2080 Ti 实机多场景截帧…，完成后立即审图与精修。」，随后 `finish: stop`。**当时 agy 里没有任何东西在跑**（无未完成工具步骤、无后台任务、无 schedule），于是关掉了所有唤醒路径的资格，回合以 `completed` 结束、会话静默 16 小时，用户只能手动问「好了吗」。

- **承诺不是结果**：`isInProgressAnnouncement(text)` 判定「状态播报」形态（`正在运行/正在截/正在构建`、`完成后立即/随后`、`稍后汇报`、`waiting… once it finishes` 等），长度 ≤320 字符且不是 Markdown 报告形态（标题/列表/代码块）。
- **一次有界续接**：`BackgroundWakeWatcher.maybeNudgeAnnouncement()` 在该轮**已经执行过工具**、且**确实没有未完成的后台工具/schedule/ACP 调用**时（那些属于后台唤醒路径，重复驱动会双重执行），延迟 `announcementNudgeDelayMs`（默认 6s，等 `finish` 与 `turn/end` 落盘）后通过 `agent.followup()` 注入一条 `plugin:agy-link` notice，要求 agy 立刻执行它自己宣布的动作并给出结果。
- **不依赖 `backgroundWakeup`**：跨回合唤醒是 opt-in，但「把承诺当结果」在任何配置下都不该静默结束，因此这条修复**不受该开关控制**。
- **上限**：每轮次代（generation）最多 1 次、每会话最多 3 次（`MAX_ANNOUNCEMENT_NUDGES`）；新回合开始（`onAttemptStart`）、人工发言、失败/被取代的尝试都会取消或跳过。状态面板 `backgroundWakeState.announcementNudges` 计数。
- 锚点：`test/common/announcement-nudge.test.ts`。

## 5. 常驻 `agy acp` 传输通道与 CLI 参数透传

- **传输通道（`transport: 'cli' | 'acp'`，默认 `'acp'`）**：
  - `'cli'` 为每轮短生命周期 `agy -p` 子进程；`'acp'` 通过 `AcpSessionPool` + `AcpProcess`（`src/features/acp/`）复用常驻 `agy acp` stdio JSON-RPC 进程，保持会话并降低冷启动开销。
  - **惰性清扫定时器**：`AcpSessionPool` 在构造函数中**绝不创建**后台 `setInterval`，仅在首次 `acquireProcess()` 时启动，并在进程全部退出/驱逐或 `dispose()` 时立刻清理，防止空闲定时器泄漏。
  - **进程池空闲不是回合运行时长**：前台 `AcpProcess.prompt()` 未结束时，`evictIdle()` 不得回收该进程，与后台唤醒开关无关。最后一个前台 prompt 成功、失败或取消后，才重新开始计算进程池空闲时间；真正空闲进程仍按默认 15 分钟回收。正常的轮内超时不变，主动空闲回收记录 PID 和空闲时长。回归：`test/features/acp/acp-pool-idle.test.ts`。
- **前置失败自动回退与辅助路由**：当 `runAcpAttempt()` 在流式启动前失败（未配置、进程拉起失败或 `openSession` 失败）时返回 `null` 并保留并发/凭据槽位，由 `runAgyAttempt()` 无缝回退至 CLI `-p` 路径；若进入 `runAcpAttempt()` 成功路径，须先调用 `recorder.stop()` 释放未使用的 CLI 录制器资源；当存在 `--json-schema` 或 `--settings` 时自动走 CLI 通道；`isAux` 辅助调用（如 `session-title` / `compaction` / `translation` / `review`）在无上述 CLI 专属覆盖时复用 `agy acp`，且非持久化临时辅助会话（`isAux && !persistBinding`）在轮次 settle 后通过 `AcpProcess.closeSession()` 主动 `session/close` 回收，防止 `openSessions` 累积。
  - **ACP 命令清单捕获**：`AcpProcess`（`src/features/acp/protocol.ts` / `client.ts`）捕获 `session/update` 中的 `available_commands_update` 并经 `AcpSessionPool.status()` 暴露给 `/acmd list`，不产生冗余聊天事件。
  - **`a`-前缀全量斜杠命令适配（`src/host/agy-slash-commands.ts`、`src/provider/leading-slash.ts`）**：
    - **直入当前会话（无二次确认、`images: true`）**：`/aplan`（联动 `createForcedPlanGuard` 单次只读 `plan` 权限并尽量进入宿主 `planMode`）、`/agoal`（新建目标时联动 DSH `goals` 立项并自动 `followup` 启动首轮；支持 `status|pause|resume|complete|clear|edit`）、`/agrill`（`/grill-me`）、`/aboost`、`/aswarm`（`/swarm` 附单槽护栏提示）、`/ateamwork`（`/teamwork`）、`/aschedule`（`/schedule` 附 `backgroundWakeup` 提示）、`/abrowser`（`/browser`）、`/acmd`（万能原生斜杠直通 + `list` 查看 ACP 通告命令）。非 Antigravity 提供方会话调用 `agy` 专属直通命令时提前拒止，避免误投给其他模型。
    - **尾部摘要与系统提示保序**：`buildPromptPlan()` 通过 `extractLeadingAgySlash` / `formatWithLeadingAgySlash` 将首行单段 `/command` 固定在字符索引 0（`System instructions:` 与摘要置后），防止 `wrapLiveRequest` 或前置指令吞掉 `agy` 斜杠展开；历史摘要仍由 `defuseQuotedSlashCommands`（含 `/swarm`、`/btw`、`/fork`）中和引用命令。
    - **元操作与旁路隔离**：`/atw` 保持独立只读卡片；`/acompact`、`/afork`、`/alearn` 复用 `slash-bridge.ts` 保持轻量化执行与绑定/文件管理，不污染主聊天历史；客户端 `src/client/slash-commands.ts` 抑制空白直通结果卡片并保留正文与错误回显。
  - **活跃期后台配额刷新让路**：`AccountQuotaRefresher`（`src/features/quota/freshness.ts`）通过 `isBusy: () => adapter.activeRunCount() > 0` 感知前台会话忙闲；回合进行中触发 `onAccountUsed` 时延迟重试（默认 5s，使用 `.unref()` 定时器），避免与交互轮次争抢 `agy -p /usage` 子进程与凭据槽。
  - **Windows 凭据槽安全**：在 Windows 下切号时，`AcpSessionPool.acquireProcess()` 会主动 `evictOtherAccounts()` 关闭旧账号常驻进程，避免并发凭据槽冲突。
  - **ACP 轮内超时对齐**：`AcpProcess.prompt()` 同样遵循 `timeoutMs` 空闲看门狗、工具进行中切换至 `longToolIdleMs`、`maxTurnMs` 硬上限以及 `AbortSignal` 触发 `session/cancel`。
  - **正在跑的轮次绝不算空闲**：`AcpProcess.isBusy`（任一 `session/prompt` 仍在 `pending`）为真时，`evictIdle()` 与容量淘汰（`pickCapacityVictim()`）都必须跳过它，并把 `lastUsedAt` 重新盖成 now；同时 `handleLine()` 在**每一帧**入站消息上刷新 `lastUsedAt`。原因（第 4 节同源实况）：镜像工具模式下整轮只发 1 次 `session/prompt`，其后只有流式 `session/update`，旧的「只在实际发出 RPC 时更新」让一个跑了 15 分钟的活轮次看起来完全空闲，被 `closeGracefully` → `killTree` 杀掉（`agy acp exited (code=1, signal=null)`）。池在满容量且全部进程都在轮内时**宁可控额超配一个新进程，也不杀活轮次**。
  - 锚点：`test/features/acp/acp-busy-idle-guard.test.ts`（`isBusy` 生命周期、入站帧刷新、`evictIdle`/容量淘汰豁免）。
  - **关闭必须整组升级，单发 SIGTERM 不算终止**：`AcpProcess.close()` 复用 `killTree()`（POSIX：进程组 `SIGTERM` → 3s `SIGKILL`；Windows：`taskkill /T /F`），ACP 子进程在 POSIX 以 `detached` 启动以成为进程组组长。agy 会挂上优雅退出钩子并忽略 SIGTERM，旧实现「先 `procs.delete()` 再 `child.kill()`」会把它变成隐形孤儿——2026-11-23 实测 pid 75365 在池遗忘后存活 12+ 分钟，每 60s 刷 `You are not logged into Antigravity`，并带着 6 个 MCP 子进程。
  - **残留对账（strays）**：`AcpSessionPool` 的 60s sweep 调用 `sweepStrays(now, true)`——只匹配 `parentPid === process.pid` 且命令形态为 `agy[.exe] acp …` 的**直系**子进程，排除 live/draining 跟踪集合，先杀后代再杀根（避免 MCP 子进程被 reparent 后长存）。`status()` 以 15s 节流刷新：池内还有 live/draining 进程时只观察不杀（读徽标不得有副作用）；池内为空时同一次扫描可直接回收——此刻不存在任何合法属主，而空闲孤儿会拿着已失效的凭据继续轮询 Google，并同时回报 `strayProcesses` / `strayPids` / `reapedStrays`。第二个 DSH 实例或终端里的 `agy` 因 parentPid 不符永不被误杀。
  - **徽标必须描述机器，不是池内 map**：控制台「n 进程 · m 会话」的 n = `activeProcesses + drainingProcesses + strayProcesses`，draining/stray 非零时追加说明。只数池内 map 正是 2026-11-23「面板显示 1 进程、实际 2 个 agy acp」的根因。
- **CLI 参数透传（`src/provider/attempt.ts`, `src/host/oneshot.ts`）**：
  - 支持结构化透传 `--agent`（`agent` / `agyAgent`）、`--settings`（`agySettings`）、`--json-schema`（`agyJsonSchema` / `schemaArgs()` 自动写临时 schema 并清理）与 `--sandbox`。
- **跨回合后台唤醒（`src/features/background/watcher.ts`, `BackgroundWakeWatcher`）**：
  - **opt-in**：`backgroundWakeup` 默认 `false`；未显式开启（设置页「跨回合后台自动唤醒」/ `/agy config wakeup on` / `DSH_AGY_BACKGROUND_WAKEUP=1`）时下列保留与唤醒逻辑一律不启动。ACP 常驻进程的回合后保留（`retainSession` / `attachAcpWatch`）同样受这一个开关控制，`transport` 只决定走哪条通道，两者不互相隐式启用。
  - 当回合结束前触发过一次性 `schedule`（`DurationSeconds > 0` 且未在同回合内完成）、存在 `RUNNING` 后台工具/`SUBAGENT_STATE_ALIVE` 子代理或 ACP 后台会话时，宿主按 `backgroundWakeupTtlMinutes` / `backgroundWakeupMaxPerSession` 保留计时器与 `.system_generated/` + ACP 会话监听，并在不归档、无活跃 `liveRun`、`agent.status !== 'running'` 且无重复入队 notice 时通过 `sessionController.resolveAgent` + `agent.followup(createUserMessage({ source: { kind: 'plugin:agy-link', form: 'notice', summary } }))` 唤醒 DSH 会话；`AcpSessionPool.evictIdle()` 对受保留的后台 ACP 会话豁免空闲超时驱逐。唤醒通知的来源必须使用生产者自有 kind（`src/common/agy-link-source.ts` 的 `plugin:agy-link`）；会话格式 v4 会拒绝已退役的 `{ kind: 'plugin', plugin: 'agy-link' }` 包装并在落盘前丢弃整批消息。
- **锚点**：`test/features/acp/acp.test.ts`、`test/features/acp/acp-kill-tree.test.ts`（忽略 SIGTERM 的子进程+孙进程必须真死）、`test/features/acp/acp-strays.test.ts`（命令形态/直系筛选/杀序）、`test/features/acp/acp-pool-strays.test.ts`（status 只观察、evictIdle 才杀、draining 不误杀）、`test/host/mcp-ready-disposal.test.ts`、`test/transport/http-contract-*.test.ts`、`test/features/background/background-followup-wakeup.test.ts`。

## 6. `agy_tool` 镜像工具活性守卫与 `UNKNOWN_TOOL` 误报消除

在插件热重载 / Cordis 重新装配 / `tools` 服务重启 / Agent 作用域 `tools.restrict({ allow })`（含 PTC 模式仅暴露 `run_code` 时）场景下，`agy` 本身的工具步骤已完成，但若 `EventMapper` 仍向未注册或不可见的 `agy_tool` 切分 `finish: tool-calls`，DSH 会抛出 `ToolNotFoundError: Error: unknown tool "agy_tool"` 误报卡片并污染后续上下文。

- **动态活性守卫**：`AgyAdapterDeps.isMirrorToolAvailable(sessionId?)` 在宿主中实时校验 `!pluginDisposing && toolsSvcRef.current !== null && mirrorToolDispose.current !== null`，若 `tools.get(name, scope)` 可用则同时校验当前 `sessionId` 对应 agent 作用域对 `agy_tool` 可见。`EventMapper` 在每次切割工具步骤前动态调用 `canCutOnTool()`，而非仅在 span 启动时快照。
- **卸载序不变式**：插件卸载回调（`src/index.ts`）必须先置位 `pluginDisposing = true`，再调用 `acpPool.dispose()` 与 `mirrorToolDispose.current()`，防止进程关闭冲刷出的尾部工具事件仍切割出 doomed `agy_tool` 调用。
- **边界竞态与历史误报降级**：`src/common/mirror-error.ts` 提供统一判定 `isMirrorToolNotFoundText()`：
  - `buildDigest()`（`src/provider/prompt-text.ts`）将历史中的 `Error: unknown tool "agy_tool"` 工具结果改写为中性提示，避免下一轮 `agy` 被误导去排查 `"agy_tool"`；
  - 客户端 `AgyMirrorToolView`（`src/client/toolview/`）与服务端 `presentMirrorResult()`（`src/provider/mirror/present.ts`）将该错误识别为非工具失败（`data-state="ok"` / 不置 `exitCode: 1`），展示「插件重载期间跳过结果回放」提示，真实工具报错保持原样标红。
- **锚点**：`test/provider/mirror-tool-unavailable.test.ts`、`test/integration/inject-race.test.ts`。
