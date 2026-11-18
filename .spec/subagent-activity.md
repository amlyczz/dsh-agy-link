# 子代理活动镜像（唯一事实源）

> 维度：**后台子代理进度如何进入 DSH 推理通道**。只回答这一件事：谁发现子代理、谁 tail 日志、事件怎样去重与续接不重放。

## 1. 数据流

```
createAttemptRecorder(deps, cfg, account, initialConversationId)   src/provider/attempt.ts
  └── new SubagentTracker({ conversationId, accountHome, onEvent, noteActivity })
        ├── start() 在 attachProcess 时建立初始历史基线并启动轮询；proc.outcome.finally(stop)
        ├── setConversationId() 由本轮 init / result / drain 的 envelope 驱动
        ├── findBrainDir(cid, accountHome)            src/runtime/agy/db/paths.ts
        ├── scanSubagentsForConv(cid)                 brain/<cid>/.system_generated/subagents/*.json
        ├── pollSubagentTranscript(sub)               brain/<sub>/.system_generated/logs/transcript.jsonl
        └── onEvent({kind:'step', stepKind:'subagent', stepKey, text, raw})
              → rec.append(ev) + watchdog.markEvent()（真实进度喂狗）
```

`EventMapper` 把 `stepKind:'subagent'` 收敛成一条 `[agy subagent]` 横幅 + 逐行进度，避免每个子代理各起一个 reasoning 块。

## 2. 不变式

- **增量 tail、UTF-8 跨块安全与续接历史隔离**：每个子代理记录 `offset` / `rest` 与 `StringDecoder('utf8')`，按实际 `bytesRead` 切片解码，防止多字节中文在 500ms 轮询边界被截断成乱码或混入未初始化内存。当续接已有会话（无论 `initialConversationId` 在 `start()` 时已就绪还是通过 `setConversationId()` 滞后到达）时，`baselineExisting()` 将既有子代理描述符与 `transcript.jsonl` 基线定在当前状态与末尾字节（EOF），**绝不把历史 `SUBAGENT_STATE_ALIVE` 残留误报为本轮新开子代理或重放旧事件**；本轮新产生的文件或追加的新行正常从新增处发出。
- **状态一致性**：仅当描述符 `state` 为空或 `SUBAGENT_STATE_ALIVE` 时才宣告「已启动协同专员」；若首次发现已是非活跃态（如 `SUBAGENT_STATE_KILLED`），改发「未保持运行」且不误报启动。运行中若描述符转为终止态或 `transcript.jsonl` 记录 `ERROR`/`CANCELED`/`FAILED`，立即发出对应「已停止」/「执行异常/中止」状态提示并停止继续轮询该子代理。`CANCELED` 工具状态在解析与 `EventMapper`/`ToolWatchdog` 中按失败收口，不悬空。
- **去重**：`seenStepKeys` 按 `subagent-<cid>-<stepIdx>-tc-<i>` 与状态键去重；`polling` 标志阻止 tick 重叠。
- **诚实失败**：`noteFailure()` 忽略「行写一半 / 文件轮转 / 权限」这类正常抖动，其余错误进 run logger，不允许空 `catch` 吞掉代码 bug。
- **生命周期**：`stop()` 清 timer 并置 `active=false`；`poll()` 在 `!active` 时立即返回。

## 3. 测试锚点

- `test/subagent-tracker.test.ts`：新子代理从头完整读取、续接已有会话（含 `setConversationId()` 延迟传入 `cid`）不重放旧 `SUBAGENT_STATE_ALIVE` 且追加新行实时产出、初始即终止不误报启动、状态由 ALIVE 转为 KILLED 及时停止通知、`transcript.jsonl` `status: ERROR` 显式上报、`stop()` 后不泄漏事件。
- `test/mapper.test.ts`：`CANCELED` 工具步骤转化为错误并正常切出卡片。
