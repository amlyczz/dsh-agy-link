# 子代理活动镜像（唯一事实源）

> 维度：**后台子代理进度如何进入 DSH 推理通道**。只回答这一件事：谁发现子代理、谁 tail 日志、事件怎样去重与续接不重放。

## 1. 数据流

```
createAttemptRecorder(deps, cfg, account, initialConversationId)   src/provider/attempt.ts
  └── new SubagentTracker({ conversationId, accountHome, onEvent, onQuotaExhausted, noteActivity })
        ├── start() 在 attachProcess 时建立初始历史基线并启动轮询；proc.outcome.finally(stop)
        ├── setConversationId() 由本轮 init / result / drain 的 envelope 驱动（重置并同步父/子基线）
        ├── findBrainDir(cid, accountHome)            src/runtime/agy/db/paths.ts
        ├── pollParentTranscript()                    brain/<cid>/.system_generated/logs/transcript.jsonl（增量监听 SYSTEM 子代理报错通知）
        ├── scanSubagentsForConv(cid)                 brain/<cid>/.system_generated/subagents/*.json
        ├── pollSubagentTranscript(sub)               brain/<sub>/.system_generated/logs/transcript.jsonl
        ├── onQuotaExhausted(info)                    发现可信硬配额耗尽且非 ≤30s 突发时触发池冷却与切号
        └── onEvent({kind:'step', stepKind:'subagent', stepKey, text, raw})
              → rec.append(ev) + watchdog.markEvent()（真实进度喂狗）
```

- `EventMapper` 把 `stepKind:'subagent'` 收敛成一条 `[agy subagent]` 横幅 + 逐行进度，避免每个子代理各起一个 reasoning 块；来自 `TaskActivityTracker` 的 `[后台任务 · <taskId>]` / `[后台通知 · <sender>]` 事件走同一通道并喂活看门狗。
- `SubagentTracker` 现在同时委托 `TaskActivityTracker`（`src/features/subagent/task-activity.ts`）增量 tail 主会话 `.system_generated/tasks/*.log` 与 `.system_generated/messages/{,undelivered/}*.json`，并在 `runAcpAttempt` 与 `runAgyAttempt` 两条传输路径统一启用；`RUNNING` 工具卡片在 `presentMirrorResult` 与 `EventMapper` 保留可结束切卡语义的同时补充后台任务日志/定时器提示。

## 2. 不变式

- **增量 tail、UTF-8 跨块安全与续接历史隔离**：每个子代理（以及父对话自身日志 `pollParentTranscript()`）记录 `offset` / `rest` 与 `StringDecoder('utf8')`，按实际 `bytesRead` 切片解码，防止多字节中文在 500ms 轮询边界被截断成乱码或混入未初始化内存。当续接已有会话（无论 `initialConversationId` 在 `start()` 时已就绪还是通过 `setConversationId()` 滞后到达）时，`baselineExisting()` 将父对话日志、既有子代理描述符与 `transcript.jsonl` 基线定在当前状态与末尾字节（EOF），**绝不把历史 `SUBAGENT_STATE_ALIVE` 或历史 `SYSTEM_MESSAGE` 报错残留误报为本轮事件或重复触发切号**；本轮新产生的文件或追加的新行正常从新增处发出。
- **状态一致性与子代理配额信号来源校验**：仅当描述符 `state` 为空或 `SUBAGENT_STATE_ALIVE` 时才宣告「已启动协同专员」；若首次发现已是非活跃态（如 `SUBAGENT_STATE_KILLED`），改发「未保持运行」且不误报启动。运行中若描述符转为终止态或 `transcript.jsonl` 记录 `ERROR`/`CANCELED`/`FAILED`，立即发出对应「已停止」/「执行异常/中止」状态提示并停止继续轮询该子代理。识别子代理硬配额耗尽并回调 `onQuotaExhausted` 时**必须满足严格来源约束**（仅限父日志 `source === 'SYSTEM' && type === 'SYSTEM_MESSAGE'` 中的 `The subagent ... encountered an error`，或子代理 `ERROR`/`FAILED` 步中非 `Command exited with code` 的权威配额信号），且忽略 ≤30s `RATE_LIMIT_EXCEEDED` 突发与 `TOS_VIOLATION`；`CANCELED` 工具状态在解析与 `EventMapper`/`ToolWatchdog` 中按失败收口，不悬空。
- **去重**：`seenStepKeys` 按 `subagent-<cid>-<stepIdx>-tc-<i>` 与状态键去重；`polling` 标志阻止 tick 重叠。
- **诚实失败**：`noteFailure()` 忽略「行写一半 / 文件轮转 / 权限」这类正常抖动，其余错误进 run logger，不允许空 `catch` 吞掉代码 bug。
- **生命周期**：`stop()` 清 timer 并置 `active=false`；`poll()` 在 `!active` 时立即返回。

## 3. 测试锚点

- `test/subagent-tracker.test.ts`：新子代理从头完整读取、续接已有会话（含 `setConversationId()` 延迟传入 `cid`）不重放旧 `SUBAGENT_STATE_ALIVE` 且追加新行实时产出、初始即终止不误报启动、状态由 ALIVE 转为 KILLED 及时停止通知、`transcript.jsonl` `status: ERROR` 显式上报、`stop()` 后不泄漏事件。
- `test/quota-failover-alignment.test.ts`：子代理 `ERROR` 与父日志 `SYSTEM_MESSAGE` 硬配额回调 `onQuotaExhausted`、≤30s `RATE_LIMIT_EXCEEDED` 与普通命令退出不误触发、续接会话基线不重放历史 `SYSTEM_MESSAGE`、`AgyAdapter` 实时冷却切号并 `kill('quota')` 触发重放。
- `test/mapper.test.ts`：`CANCELED` 工具步骤转化为错误并正常切出卡片。

## 续接扫描与 DSH 上下文消息（`src/provider/continuation.ts`, issue #138）

DSH 会在工具结果之后追加**宿主生成**的上下文消息。各生产者的 `source.kind` 是它自己的名字（`time-context`、`agent-instructions`、`skill-catalog`、`runtime-context`、`model-selection`、`plugin:<name>` …），`form` 可为 `snapshot` / `instructions` / `notice` / `catalog` / `recall`——**dsh-llm 没有统一的 `plugin` kind**。

- `detectContinuation()` 的跳过条件必须复用 `isSyntheticHarnessMessage()`，不能只匹配 `plugin` + `snapshot`：否则 `time-context`（工具步骤间隔 >10 分钟）、`agent-instructions`（AGENTS.md 被改写）、`plugin:<name>`（记忆类插件）都会被当成用户插话，导致**中止正在运行的 agy run** 并注入「不要继续」。
- 边界仍必须严格：真实用户文本（无 `source` 或 `kind === 'user'`）、其他 provider 的工具结果、以及任何未知形态都会**终止**扫描——跨过它们去重放会为错误的请求续接旧 run。
- 既有约定保持不变：`kind: 'plugin'` 且 `form` 为 `instructions` / `notice` / `relay` / `recall` 的**带文本**消息仍视为携带新指令，不跳过。
- 锚点：`test/adapter.test.ts` 的 `detectContinuation permits only trailing plugin snapshots…`（旧约定）与 `issue #138: DSH context messages never make a tool continuation look like a user steer`（新增三类上下文）。

## 后台任务可见性与「中断」判定的真实性（PR #155）

- **实时可见**：转后台的 `run_command` 任务日志（`.system_generated/tasks/*.log`）与完成/取消通知（`.system_generated/messages/{,undelivered/}*.json`）必须被增量跟随，而不是等到回合结束；ACP 运行同样要启用 tracker（`runAcpAttempt` 曾漏配）。跟随实现需满足：UTF-8 多字节安全、单次读取有界、续跑时以 EOF 为基线（避免重放历史）、消息按 id 去重、`stop()` 做最终同步 flush。
- **中断横幅只对真正被中断的回合**：前一轮**已产出可消费结果**（`hasConsumableResult`）时，收尾超过 1.5 秒只是正常 shutdown，**不得**设置 `binding.interrupted` 或注入「上一轮被中断」文案——否则会对一个已经作答的回合说谎，并污染下一轮的上下文。
- 锚点：`test/background-task-visibility.test.ts`（371 行：跟随、去重、续跑基线、可消费结果不标中断）。
