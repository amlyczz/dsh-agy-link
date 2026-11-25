# agy 上下文预算（发给 agy 的每一样东西）

> 维度：**上下文预算 / 提示词组装**。只回答这一件事：每一次 `agy` 调用到底发了什么、各自的上限是多少、按什么原则取舍。

## 1. 四条投递路径

| 路径 | 触发条件 | 发什么 | 上限 |
| --- | --- | --- | --- |
| 正常回合（已绑定会话） | `sessions.json` 命中当前目标 | 仅**这一轮的新输入** + 未发送过的图片引用 | 单条消息 agy 硬限 192,000 B，我们按 180,000 B 留余量 |
| 首次接触 / 换号 / 换模型 / 压缩后重播种 | `binding === undefined` 且有历史 | **整段历史摘要**（`buildDigest` + 历史附件按时间线原位附路径）；≤ `contextTransferFileAboveBytes`（默认 150,000 B，且留足 live request 余量）时**全量内联**，超限时走**尾内联 + 头落盘 `.md`**（近期对话直接内联，仅更早溢出段落落盘） | `contextTransferMaxChars` 660,000；内联阈值 `contextTransferFileAboveBytes` 150,000；`.md` 侧 `contextTransferFileMaxBytes` 2,000,000 |
| 中途与别的模型聊过 / A→B→A 切回旧号（外来跨度） | 绑定存在，但水位之后有 foreign assistant 回合 | 仅**外来那段**增量摘要 + 该跨度内历史附件原位路径，与首次接触共用同一套内联优先 / 尾内联+头落盘通道 | `contextTransferMaxChars` 660,000；内联阈值 150,000；`.md` 侧 `contextTransferFileMaxBytes` 2,000,000 |
| 翻译 / 压缩等辅助调用 | `purpose:'translation'` 等 | 一句指令 + 目标文本，逐块 | `translateMaxChars` 8,000/块；`compaction` 经 `buildCompactionPrompt` 先扣除收尾预算、过滤 `system`/合成消息、工具输出走 8:2 `elideMiddle`、锚定首条人类需求 + 最新回合，严格保证总字节 ≤ `AGY_PROMPT_SAFE_BYTES`（180,000 B）不截尾 |

两条 agy 硬约束决定了装配顺序与内联/落盘边界：
- 单条 `USER_INPUT` 消息按 **192,000 B 从尾部截断**（2026-11-25 实测 agy 1.5.15：连 ACP `embeddedContext` 的 `resource` 块同样在 192 KB 处截断，无法绕过此上限），所以 live request 必须放**最前面**（`wrapLiveRequest`），摘要排在其后，且总内联预算严格扣除 `liveRequestBytes` 以守住 `AGY_PROMPT_SAFE_BYTES`（180,000 B）。
- `agy` 的 `read_file` 单次硬限 **46,080 B**：过早将 55 KB–150 KB 的历史全量甩进 `.md` 文件会导致新会话首轮零上下文、读盘被截断后漏读后半段。因此默认内联阈值提升至 **150,000 B**；超限时采用**尾内联（`[RECENT CONVERSATION]`）+ 头落盘（`[conversation so far]` `.md`）**的零重复切分，确保最新对话始终直接在上下文中。
- ACP 常驻进程启动时同步通过 `--add-dir` 挂载 `<state>/context-transfer` 与 `<state>/media`，与 CLI 每轮 `--add-dir` 授权对齐，保证 `session/resume` / `session/load` 续跑旧会话时在非 `skip` 模式下也可正常读盘。
- 压缩提示词（`buildCompactionPrompt`）同样先把固定的 `<conversation_history>` 闭合标签与「严禁调用工具」尾注从 `AGY_PROMPT_SAFE_BYTES` 中扣出，再填充锚点与最新回合，确保闭合指令永不被 `buildSpawnArgs` 截尾丢弃。

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

## 3. 多模态附件（图片 / PDF / 音频 / 视频）与水位纪律

未发送过的媒体引用按水位去重后随回合投递（`collectUnsentMediaRefs` / `mergeSentImageIds`）；历史附件不会被重复附上，超量时按最新优先、`maxSentImageIds` 截断：

- **时间线保真（历史附件 vs 本轮附件）**：触发首次换号（`first`）或外来增量（`foreign`）摘要时，摘要跨度内的历史用户附件同样落盘到 `media/` 并记入 `sentImageIds`，但以客观路径注释（`[earlier <kind> attachment: ...]`）**原位写回对应历史 `User:` 行**，不作为当前轮 `inlineImages` 塞入 ACP，避免新账号把早期参考图误判为本轮新指令；只有本轮 `trailingUser` 新发附件才附于当前请求与 ACP `inlineImages`。
- **失败水位不误前移**：`persistFailureBinding` 在已绑定会话失败且未实质消费本轮 prompt（非中途 Stop/超时中断，如 `PROCESS_EXIT` / `RATE_LIMIT` / `NETWORK`）时，必须保持原 `binding.lastMessageCount` 不前移，避免重试或切回时漏发 `foreign` 增量；若 `writeSuccessBinding` / `persistBindingOnResult` 观测到绑定水位从 `>= 5` 突降至 `<= 2`，记录 `[watermark-drop]` 诊断日志以供根因追踪。
- 支持 `image/*`（走 `view_file`）、`application/pdf`、`audio/*`（自动剥离 `; codecs=...` 参数与常见别名）、`video/*`（三者均走 `read_file`）。
- 体积上限隔离：图片受 `mediaMaxBytes`（默认 10 MiB）约束；PDF / 音频 / 视频受 `mediaMaxFileBytes`（`DSH_AGY_MEDIA_MAX_FILE_BYTES`，默认 20 MiB，对齐 `agy` 原生附件上限）约束。
- 仅含图片附件时保留精确提示 `[Please inspect the attached image(s) using view_file and assist the user.]`；含 PDF/音频/视频时使用 `[Please inspect the attached file(s) using view_file / read_file and assist the user.]`。

## 4. 测试锚点

`test/provider/adapter-*.test.ts` / `test/client/extended-ui-and-embed.test.ts` / `test/provider/context-transfer-handover.test.ts`：`buildDigest` 的字节上限与"最新回合优先"、live task 不被工具输出挤掉（issue #35）、`elideMiddle` 的字节上限与 CJK 不切断码点、工具行默认省略而散文不省略、`trimToUtf8Bytes` 不产生非法码点、PDF/音频/视频落盘与 `mediaMaxFileBytes` 截断、150 KB 全量内联 / 尾内联+头落盘零重复切分、`A→B→A` 外来增量统一通道、历史附件原位还原与本轮附件隔离、ACP `--add-dir` 预挂载、失败水位保护与 `[watermark-drop]` 诊断日志。

## 5. 已知取舍

- 只做**行内**压缩，不做语义摘要：不额外调用模型去概括历史（那会把成本和失败面翻倍）。要更省只能调 `contextTransferMaxChars`。
- `elideMiddle` 丢弃中段：当有用信息恰在中间（例如长 diff 里被改的那几行）时会丢；靠文件引用路径（agy 可自行读盘）而不是靠摘要来兜底。
- 数字随会话形态变化很大：工具密集的会话收益最大（−66% 以上），纯对话会话几乎无变化。