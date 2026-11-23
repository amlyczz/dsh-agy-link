# agy 上下文预算（发给 agy 的每一样东西）

> 维度：**上下文预算 / 提示词组装**。只回答这一件事：每一次 `agy` 调用到底发了什么、各自的上限是多少、按什么原则取舍。

## 1. 四条投递路径

| 路径 | 触发条件 | 发什么 | 上限 |
| --- | --- | --- | --- |
| 正常回合（已绑定会话） | `sessions.json` 命中当前目标 | 仅**这一轮的新输入** + 未发送过的图片引用 | 单条消息 agy 硬限 192,000 B，我们按 180,000 B 留余量 |
| 首次接触 / 换号 / 换模型 / 压缩后重播种 | `binding === undefined` 且有历史 | **整段历史摘要**（`buildDigest`），> `contextTransferFileAboveBytes` 时写成临时 `.md` 让 agy 分页读 | `contextTransferMaxChars` 660,000；`.md` 侧 `contextTransferFileMaxBytes` 2,000,000 |
| 中途与别的模型聊过（外来跨度） | 绑定存在，但水位之后有 foreign assistant 回合 | 仅**外来那段**摘要 | `digestMaxChars` 8,000；字节侧 `contextTransferMaxBytes` 150,000 |
| 翻译 / 压缩等辅助调用 | `purpose:'translation'` 等 | 一句指令 + 目标文本，逐块 | `translateMaxChars` 8,000/块；`compaction` 经 `buildCompactionPrompt` 先扣除收尾预算、过滤 `system`/合成消息、工具输出走 8:2 `elideMiddle`、锚定首条人类需求 + 最新回合，严格保证总字节 ≤ `AGY_PROMPT_SAFE_BYTES`（180,000 B）不截尾 |

两条 agy 硬约束决定了装配顺序：单条 user 消息按 **192,000 B 从尾部截断**，所以 live request 必须放**最前面**（`wrapLiveRequest`），摘要排在其后；摘要超过阈值就落成文件引用，避免占用这条通道。压缩提示词（`buildCompactionPrompt`）同样先把固定的 `<conversation_history>` 闭合标签与「严禁调用工具」尾注从 `AGY_PROMPT_SAFE_BYTES` 中扣出，再填充锚点与最新回合，确保闭合指令永不被 `buildSpawnArgs` 截尾丢弃。

纯文本辅助调用（`session-title` / `compaction` / `translation`）默认在 `<state>/agy-link/aux-cwd` 这个稳定的空目录里运行（`auxNeutralWorkspace`，默认 true），且不追加 `--add-dir`：这些调用不读文件，却会因落在会话工作区而被迫加载 GEMINI.md/AGENTS.md（每次 1–2 万 token、0% 缓存）。显式配置 `workspaceRoot` 时仍以配置为准。

### 引用斜杠指令去活化（`defuseQuotedSlashCommands`）

`agy` print 模式会扫描整条 user 消息并展开独立出现的系统斜杠指令（例如历史或技能目录文本里的 `/goal`、`/plan`）；且 `--mode plan` 依赖 `/plan` 展开，不能全局传 `--disable-slash-commands`。因此在构造 `<conversation_history>` 与 `[conversation so far]` 历史摘要时，必须通过 `defuseQuotedSlashCommands()` 把独立的 `agy` 系统斜杠指令（`/goal`、`/plan`、`/compact`、`/schedule`、`/browser`、`/grill-me`、`/teamwork`、`/learn`、`/boost`）改写为 `/ <name>`，同时完整保留文件路径（`/plan/doc.md`、`src/goal.ts`）、URL（`https://example.com/goal`）与带连字符标识符（`/goal-123`），且不触碰 `[CURRENT REQUEST]` 里的实时人类请求。

## 2. 取舍原则（8:2）

**预算不是被"决策"吃掉的，是被"载荷"吃掉的。** 2026-11-03 实测本会话真实产物 `~/.dsh/agy-link/context-transfer/session-*.md`（691,113 B）：

| 组成 | 条数 | 字节 | 占比 |
| --- | --- | --- | --- |
| `Tool result:` | 376 | 629,839 | **91.1%** |
| `Assistant:` | 22 | 58,983 | 8.5% |
| `User:` | 10 | 1,862 | 0.3% |

工具行 p90 ≈ 3,991 B、max 40,001 B（受 `maxLineBytes` 约束）；提问与回答加起来不到 9%。因此规则是：

- **工具结果行默认掐头去尾**（`elideMiddle`，`toolLineBytes` 默认 `min(800, maxLineBytes)`）：保留开头（命令/调用上下文）+ `…[elided NB]…` + 结尾（退出码、结论、报错）。同一份文件按此规则测算 **691 KB → ~236 KB（−66%）**；`toolLineBytes: 400` 则 ~163 KB（−76%）。
- **散文永不省略**：`Assistant:` / `User:` 行只受 `maxLineBytes`（调用点传 40,000）与整体 `maxChars` 约束——线索靠它们延续。
- **最新任务行保留**（`includeTaskLine`，自动模式默认 true）：任何截断都从**最旧**的行开始丢。

## 3. 多模态附件（图片 / PDF / 音频 / 视频）

未发送过的媒体引用按水位去重后随回合投递（`collectUnsentMediaRefs` / `mergeSentImageIds`）；历史附件不会被重复附上，超量时按最新优先、`maxSentImageIds` 截断：

- 支持 `image/*`（走 `view_file`）、`application/pdf`、`audio/*`（自动剥离 `; codecs=...` 参数与常见别名）、`video/*`（三者均走 `read_file`）。
- 体积上限隔离：图片受 `mediaMaxBytes`（默认 10 MiB）约束；PDF / 音频 / 视频受 `mediaMaxFileBytes`（`DSH_AGY_MEDIA_MAX_FILE_BYTES`，默认 20 MiB，对齐 `agy` 原生附件上限）约束。
- 仅含图片附件时保留精确提示 `[Please inspect the attached image(s) using view_file and assist the user.]`；含 PDF/音频/视频时使用 `[Please inspect the attached file(s) using view_file / read_file and assist the user.]`。

## 4. 测试锚点

`test/adapter.test.ts` / `test/extended-ui-and-embed.test.ts`：`buildDigest` 的字节上限与"最新回合优先"、live task 不被工具输出挤掉（issue #35）、`elideMiddle` 的字节上限与 CJK 不切断码点、工具行默认省略而散文不省略、`trimToUtf8Bytes` 不产生非法码点、PDF/音频/视频落盘与 `mediaMaxFileBytes` 截断。

## 5. 已知取舍

- 只做**行内**压缩，不做语义摘要：不额外调用模型去概括历史（那会把成本和失败面翻倍）。要更省只能调 `contextTransferMaxChars`。
- `elideMiddle` 丢弃中段：当有用信息恰在中间（例如长 diff 里被改的那几行）时会丢；靠文件引用路径（agy 可自行读盘）而不是靠摘要来兜底。
- 数字随会话形态变化很大：工具密集的会话收益最大（−66% 以上），纯对话会话几乎无变化。