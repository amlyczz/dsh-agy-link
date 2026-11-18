# agy 上下文预算（发给 agy 的每一样东西）

> 维度：**上下文预算 / 提示词组装**。只回答这一件事：每一次 `agy` 调用到底发了什么、各自的上限是多少、按什么原则取舍。

## 1. 四条投递路径

| 路径 | 触发条件 | 发什么 | 上限 |
| --- | --- | --- | --- |
| 正常回合（已绑定会话） | `sessions.json` 命中当前目标 | 仅**这一轮的新输入** + 未发送过的图片引用 | 单条消息 agy 硬限 192,000 B，我们按 180,000 B 留余量 |
| 首次接触 / 换号 / 换模型 / 压缩后重播种 | `binding === undefined` 且有历史 | **整段历史摘要**（`buildDigest`），> `contextTransferFileAboveBytes` 时写成临时 `.md` 让 agy 分页读 | `contextTransferMaxChars` 660,000；`.md` 侧 `contextTransferFileMaxBytes` 2,000,000 |
| 中途与别的模型聊过（外来跨度） | 绑定存在，但水位之后有 foreign assistant 回合 | 仅**外来那段**摘要 | `digestMaxChars` 8,000；字节侧 `contextTransferMaxBytes` 150,000 |
| 翻译 / 压缩等辅助调用 | `purpose:'translation'` 等 | 一句指令 + 目标文本，逐块 | `translateMaxChars` 8,000/块 |

两条 agy 硬约束决定了装配顺序：单条 user 消息按 **192,000 B 从尾部截断**，所以 live request 必须放**最前面**（`wrapLiveRequest`），摘要排在其后；摘要超过阈值就落成文件引用，避免占用这条通道。

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

## 3. 图片

未发送过的图片引用按水位去重后随回合投递（`collectUnsentImageRefs` / `mergeSentImageIds`）；历史截图不会被重复附上，超量时按最新优先、`maxSentImageIds` 截断。

## 4. 测试锚点

`test/adapter.test.ts`：`buildDigest` 的字节上限与"最新回合优先"、live task 不被工具输出挤掉（issue #35）、`elideMiddle` 的字节上限与 CJK 不切断码点、工具行默认省略而散文不省略、`trimToUtf8Bytes` 不产生非法码点。

## 5. 已知取舍

- 只做**行内**压缩，不做语义摘要：不额外调用模型去概括历史（那会把成本和失败面翻倍）。要更省只能调 `contextTransferMaxChars`。
- `elideMiddle` 丢弃中段：当有用信息恰在中间（例如长 diff 里被改的那几行）时会丢；靠文件引用路径（agy 可自行读盘）而不是靠摘要来兜底。
- 数字随会话形态变化很大：工具密集的会话收益最大（−66% 以上），纯对话会话几乎无变化。