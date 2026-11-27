# 缓存与用量（ACP 提示词缓存 / 上下文占用 / 冷启动归因）

> 维度：**每次调用的缓存命中与上下文占用到底是多少、为什么冷、怎么算**。只回答这一类问题；prompt 字节预算见 `context-budget.md`。

## 1. 两个数字，别混用

| 数字 | 定义 | 来源 | 用途 |
| --- | --- | --- | --- |
| 单轮上下文占用 `ctx` | 最后一次内部调用的 `input + cache_read + cache_write` | `transcript.jsonl` 里最后一条 `PLANNER_RESPONSE` | DSH 的「上下文 xx%」圆环、压缩判定 |
| 命中率 `hit` | `cache_read / (input + cache_read + cache_write)` | 同上 | 会话统计面板 |

DSH 的 `normalizeUsage()`（宿主 `dsh-token-meter`）要求：`totalTokens` 缺失时必须同时有 `cacheReadTokens` 和 `cacheWriteTokens`，否则**整轮丢弃**；有 `totalTokens` 时要求 `total - output >= input + cacheRead + cacheWrite`。展示侧公式是 `min(1, cacheRead/(input+cacheRead+cacheWrite))`。所以插件必须交出「单次调用」级别的完整计数，不能交会话累计值。

## 2. agy 1.5.x 的真实数据形状

- `session/prompt` 响应里的 `usage` 是**整个 ACP 会话的累计值**，不是最后一次调用。实测会话 `7920f449`（2 次内部调用）：第 1 次 `42216/0/760`，第 2 次 `14424/42217/7247`，响应却是 `56640/42217/8007` —— 三项都等于两次之和，精确吻合。把它当作一条消息的 usage 会得到 4.45M 的 prompt 侧，在 1,048,576 窗口上直接显示 100%。
- `transcript.jsonl` 的每条 `PLANNER_RESPONSE` 才是**单次调用**，且 agy 1.5.x 把计数写在**顶层**：

```json
{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":14424,"cache_read_tokens":42217,"output_tokens":7247}
```

历史实现只读 `usage` / `token_usage` / `metadata.usage` 三种嵌套形状，对 1.5.x 永远解析出 0 条样本 → 回退到累计响应 → 上下文爆表。**契约**：`AcpTranscriptUsageTailer` 必须同时接受顶层与嵌套形状，任何一条 `PLANNER_RESPONSE` 只要带任一计数就要产出样本。

## 3. 冷启动归因（实测）

对 1,678 个 agy 会话 / 52,992 个 PLANNER_RESPONSE 步统计（`cacheRead/(input+cacheRead)`）：

| 空闲间隔 | 步数 | 冷步率 |
| --- | --- | --- |
| <1 分钟 | 4,117 | 1.2% |
| 1–3 分钟 | 219 | 18.7% |
| 3–5 分钟 | 22 | 45.5% |
| 5–10 分钟 | 25 | 48.0% |
| 10–30 分钟 | 19 | 89.5% |
| >30 分钟 | 7 | 100% |

未缓存 token 的构成：会话中途冷步约 55–59%，新会话首步约 3%，一次性辅助调用（标题/压缩/翻译）约 1.4%（但每次 1.2–1.9 万全冷，轻量用户占主导）。因此：**回合内工具步几乎全命中；回合间的空闲（Gemini 隐式缓存 TTL）+ 换号/换模型/重建才是主因。**

## 4. 实现契约

- **单次调用优先**：`RunRecording.finalUsage()` 在有 `step` 样本时必须返回该样本；`consumeSpanUsage()` 在本轮已发过样本、但最终信封只有累计值时返回 `null`（宁可不发，也不把累计值当上下文）。
- **transcript 尾巴重试**：prompt 返回后若还没读到新样本，最多重试 4×40ms（agy 异步落盘），确保最后一跳的单次计数生效。
- **辅助调用中性工作区**：`session-title` / `compaction` / `translation` 在 `cfg.auxNeutralWorkspace`（默认 true）下跑在 `<state>/agy-link/aux-cwd`，不带 `--add-dir`，避免加载项目 GEMINI.md/AGENTS.md（每次省 1–2 万 token，且前缀稳定可命中）。显式 `workspaceRoot` 优先。
- **原子切模型**：会话响应带 `models.availableModels` 且存在 `${model}-${effort}` 时，用一次 `session/set_model` 完成切换；否则回退 `set_config_option(model) → thought_level` 两步。失败即回退。
- **每轮缓存日志**：`[cache] hit=..% ctx=.. in=.. cr=.. cw=.. out=.. reason=<none|new-session|resume|rebuild|account-switch|model-switch|idle|retry|aux>`，reason 由 `cache-stats.ts` 纯函数判定，优先级见 `classifyCacheReason`。
- **报表出口**：内存按本地日聚合（保留 14 天，`host/cache-metrics.ts`）。`GET /plugins/agy-link/status` 返回 `cacheStats`（today / days / last / lastBySession）；`/agy cache-stats`（别名 `/agy cache`）打印逐日命中率与原因占比；`/agy status` 附一行今日摘要。只在进程内，不落盘、不计费。
- **会话粘性**：`selectSessionAccount` 严格跟随同模型族当前的单一活跃账号（`activeAccountIds[family]`）：多轮会话在族指针未移动时自动复用原账号及其原生对话；一旦该族因 429、低配额让路或手动切号轮换，全族会话统一收敛到新活跃账号并通过上下文摘要交接（`account-switch`），绝不因旧会话绑定而复活旧号拆散并发账号。

## 5. 已知取舍（明确不做）

- **不做 token 级 keepalive**：agy 没有「只续缓存」的接口，任何保活都是一次真实推理，会把整段上下文重新过一遍模型、并污染会话历史。按实测 3–5 分钟冷率 45% 估算，30 分钟内保活 10 次约 2M cacheRead token，而后来的那一次冷 prefill 也只省 20 万；价格上不划算，行为上还有副作用。若要优化，应当减少冷 prefill 的**次数与体积**（中性辅助前缀、少换号、别过早压缩），而不是加热。
- **不改 DSH 侧的压缩阈值**：压缩由宿主决定；插件只保证压缩调用本身不拖项目上下文，并让压缩后的第一次请求如实上报单次占用。
