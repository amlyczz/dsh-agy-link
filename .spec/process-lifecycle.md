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

- **stderr 噪声不算活动**：agy 内部守护进程每约 6 分钟打印 `fetchAvailableModels` / `token refreshed` / `loadCodeAssist` / `ListExperiments` 等例行日志。`isBackgroundStderrNoise()` 过滤后再 `refreshWatchdog()`；stdout 始终算活动。
- **root agent idle 必须能收敛（issue #119）**：模型回复全部产出后，agy 在 print 模式下若等待遗留后台任务，5s 宽限后终止；`classifyFailure()` 对 `idleGraceTerminated` 返回 `null` 并合成 `ok: true` 的 result 事件，正常闭合输出块。
- **合成 result 必须带上真实答复（issue #127 / #128）**：回收发生在最终答复「已写入 agy transcript、尚未由 stdout 刷出」的时间窗内时，`synthResult.response` 不能用空串——`recoverFinalReply()` 从 `<brainDir>/.system_generated/logs/transcript.jsonl` 尾部（≤256 KiB，O(1)）恢复**最后一条 `USER_INPUT` 之后**、`content` 非空且**无 `tool_calls`** 的 `PLANNER_RESPONSE`。恢复不到时写入 `IDLE_GRACE_NO_REPLY_NOTICE`（中英双语「结果未确认、可能已执行」），而不是让 DSH 显示「完成」却零正文——空答复会被读成任务成功。
- **`hasResult` 只认 result 事件（issue #124）**：`init` 会写入 `resultConversationId`，若用它判断「已有结果」，合成 result 永远不执行，所有回收轮次都会以 `agy stream ended without a result event` 失败。
- **长会话默认不被缩短**：`printTimeoutMinutes` 由 `longToolIdleMinutes`（缺省 240）与 `timeoutMs` 取大，并受 `maxTurnMinutes` 约束。
- **同步工具预算可释放**：工具步骤 `DONE`/`ERROR`/`RUNNING` 或模型恢复产出 text/thinking 时清理 `openToolKeys`，恢复 `generationIdleMs`。
- **Headless 权限拦截显式诊断（issue #121）**：当 `permissionMode: 'accept-edits'` 下无头 `agy -p` 因权限门禁无法弹窗而被拦截时，明确给出切换为 `skip` 或 `plan` 的可操作提示，不静默结束。

## 3. Windows 控制台闪窗消除与自更新抢占（issue #23 / #47 / #49）

`agy.exe` 在距上次更新检查 ≥15 分钟时会派生 `--bg-updater` → `agy --version` 孙进程链，分配可见伪控制台产生 0.2~0.4s 闪窗（`AGY_CLI_DISABLE_AUTO_UPDATE=1` 对旧构建不完全生效）。

- `preemptAgyAutoUpdate(env, now)`（`src/runtime/agy/auto-updater.ts`）在每次 `startAgyProcess()` spawn 之前刷新 `<appData>/last_check.timestamp` 与 `<appData>/updater/last_check.timestamp` 的 `mtime`，命中 `agy` 内部的 15 分钟 `skipping update (fast path)`，从源头避免派生 `--bg-updater` 且不影响用户手动执行 `agy update`。
- `PluginConfig.suppressAgyAutoUpdate` 在 Windows 默认 `true`，其余平台默认 `false`。
- 启动探测延迟执行并串行化，不在插件加载瞬间阻塞或并发拉起多份 `agy` 进程。

## 4. 验证锚点

- `test/background-task-hang.test.ts`：idle 宽限终止、stderr 噪声不喂狗。
- `test/issue124-125-regressions.test.ts`：init 不冒充 result、子代理豁免与解除、stdout 唤醒取消回收。
- `test/issue128-idle-reply.test.ts`：transcript 答复恢复、带 `tool_calls` 与上一轮答复都不算、无答复时的提示文案。
- `test/updater-preempt.test.ts`：隔离 HOME 下 `last_check.timestamp` 创建与刷新、`suppressAgyAutoUpdate: false` 不触碰文件。
- `test/proxy-keychain.test.ts`：活动看门狗与事件循环阻塞宽限。

## agy 可执行文件探测与诊断（`src/runtime/agy/bin.ts`, PR #133）

spawn 之前必须先定位 `agy`。`resolveAgyBin()` 返回 `null` 时，**必须给出可操作信息**，否则「not found on PATH」会被误读成「没安装」。

- `agyBinCandidates(cfg)` 是唯一的候选列表来源（配置 `agyBin` → `PATH` 各目录 → 平台默认安装位置）；`resolveAgyBin()` 只做「真实可执行优先于 cmd shim」的排序与存在性检查，签名与行为不变。
- `agyBinDiagnostics(cfg)` 返回 `{ probed, configured, installHint }`；`agyNotInstalledMessage()` 据此生成错误文案，包含两种覆盖方式（`agyBin` 配置项、`DSH_AGY_BIN` 环境变量——后者在 `common/config.ts` 里映射进 `cfg.agyBin`）与 `/agy doctor` 指路。头部徽标与 doctor 报告复用同一信息。
- 测试必须**注入 PATH**（`process.env.PATH` 临时替换）而不是假设宿主 PATH 的形态，否则在不同机器/CI 上会假失败。
- 锚点：`test/agy-not-installed-diagnostics.test.ts`（候选顺序、PATH 探测、平台安装位置、`agyBin` 优先级、诊断载荷、错误文案、doctor 段落）。
