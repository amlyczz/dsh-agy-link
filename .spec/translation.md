# 人话翻译（Gemini plain-language translation）

> 维度：**翻译 / `/tsl` 命令 / 自动后处理**。只回答这一件事：DSH 会话的输出如何被 Gemini 改写成大白话，以及它如何被持久化、渲染、切号与限额。

## 1. 目标与边界

- 目标：把 agent 的最终回复改写成"人话"，并**固定显示在该回复正下方**，带明确的 Gemini 标识；重载/重启后仍在。
- 不做：不改写模型可见历史（记录是 `ignorable` 的 plugin record，永不进入模型上下文）；不替用户发送/确认任何内容；不自动发布。

## 2. 统一入口

`TranslationService`（`src/features/translation/service.ts`）是唯一入口，三个消费者：

| 消费者 | 入口 | 是否落卡片 |
| --- | --- | --- |
| `/tsl` 命令 | `translateLastTurn` / `translateTurn` / `translate` | 是（`--no-persist` 可关） |
| 自动模式（`turn/end`） | `autoTranslateTurn` | 是 |
| 每条回复的「译成人话」按钮 | `translateMessage` | 是（**只翻被点的那一条消息**，不是该回合最后一条） |

HTTP（客户端与测试用）：

```
POST /plugins/agy-link/translate
  { text? , sessionId?, turn?, messageId?, model?, effort?, lang?, force?, full?, persist? }
GET  /plugins/agy-link/translate/pending?session=<id>   # 调试/状态
GET  /plugins/agy-link/translate/turn?session=<id>&turn=<n>      # 该回合是否已有译文
GET  /plugins/agy-link/translate/state?session=<id>&message=<id>  # 该条回复的状态（供按钮）
```

`/translate/state` 回答 `{state: 'ready'|'busy'|'idle'}`：`ready` = 该 `messageId`（或回退到它所属 turn）已有持久记录，`busy` = 本会话有翻译在跑。回复按钮每次挂载都问它一次，因此**译文完成后切窗口/切会话/整页刷新都仍显示 ✓**。挂载时回答 `busy`（例如自动翻译正在跑，不是本页发起的请求）时，按钮每 3 秒再问一次，直到 `ready`（✓）或 `idle`（回到可点）；否则没有任何本页请求会结束这个旋转圈，它会一直转到下次重新挂载。

状态码：`200` 成功；`400` 参数或空回合；`409` 当前回合仍在跑；`405` 方法；`502` 无可用账号等模型侧失败。

## 3. 模型与档位

- 默认 `translateModel = gemini-3.8-flash`、`translateEffort = low`。实机实测（`agy 1.5.11`）：**冷启动 low ≈ 12.4s，常驻热进程复用后仅需 ~4–9s**，而 medium ≈ 33s、high ≈ 45s；人话改写需要口语直观表达而非深度链式推理，因此默认采用 `low` 并在设置/提示中标注更慢选项。
- **常驻热进程池（`TranslationWorkerPool`，`src/features/translation/worker.ts`）**：
  - 非 Windows 下（Windows 仍走 `ctx.llm.stream` 遵循 `acquireCredentialSlot` 互斥锁）维护最多 1 个常驻 `agy -p --output-format stream-json --input-format stream-json --mode plan`（`cwd = tmpdir()`，**不传 `--add-dir`、不传 `--disable-slash-commands`**，以免破坏 `--mode plan` 与 `step_update` 流输出），按 `${account.id}|${model}|${effort}` 复用；空闲 `5m` 或累计 `8` 轮 / `32000` 字符后自动回收，收到 `result` 事件立即结算释放，免除 ~9s CLI 冷启动与退出等待。
  - 请求串行排队执行；遇到 `429` 冷却切号、`--effort` 拒绝时自动记住并无感重放、发生超时/中断/致命异常立即销毁进程组，插件卸载时 `dispose()` 清理。
  - 非生图辅助调用（`isAux && !isImage`）在回退路径上跳过 `SubagentTracker` 与 SQLite 思考/工具参数重试轮询，消除无意义睡眠延迟。
- 解析顺序（`resolveTranslateTarget`）：显式入参 → `cfg.translateModel` → `gemini-3.8-flash` → 目录中最新的 `gemini-*-flash` → `cfg.defaultModel` → 目录首个模型。显式覆盖允许未在目录中的 id（目录只是 advisory）。
- 档位：模型支持 `efforts` 时用请求值/默认值（high 优先），固定思考模型（Claude/GPT-OSS）不带 `--effort`。

## 3.5 每个 DSH 会话一条 agy 翻译会话（1:1）

- **绑定键**：`<dsSessionId>#tsl`（轮次会话用 `<dsSessionId>`，两者互不干扰）；带账号时写成 `<key>:<accountId>`，沿用 adapter 既有的账号隔离与"冷号后重新播种"机制。绑定落在 `~/.dsh/agy-link/sessions.json`（`SessionStore`）。
- **人格只发一次**（`buildTranslationSetup`）：身份（"人话翻译器"）、**DSH 会话 id**、该会话的工作目录、**原始日志绝对路径**（`sessionLogPath` 扫描 `~/.dsh/sessions/*/session-<id>/session.*.jsonl.zstd`）与读取示例（`zstd -dc … | jq`），以及一段有界摘要（`sessionDigest`：最近的提问与最终答复，按 `translateMaxChars/4` 截断）。
- **每次仍带一行短指令**（`buildTranslationPrompt`，约 110 字）：实机实测，在已绑定的会话里**只发原文**或只发 6 字的"把这段讲成人话"会得到**空回答**或跑偏的"我正在研究代码库…"；带上这一行则每次都立刻正确输出。所以人格/规则不重发，但请求行保留。
- 运行形态：`--conversation <绑定 id>`、`--mode plan`（只读，允许 agy 自己去读上面那些文件）、工作目录 = 会话的工作目录；`purpose:'translation'` 依旧不参与 DSH 的工具镜像。
- 关闭开关：`translateBindConversation=false` 时退回"每次自带完整指令、不绑定会话"的旧形态（`prompt` 那一支）。

## 4. 复用额度与自动切号（关键不变式）

模型调用走 `ctx.llm.stream({ provider:'antigravity', purpose:'translation', ... })`，即 adapter 的**辅助通道**：

- 不绑定 agy 会话（不写 `sessions.json`）、不参与会话并发/限速、不暴露工具、强制 `plan` 模式；
- 仍然经过 `pool.selectAccount('google')` 选号，成功后 `recordSuccess`，配额耗尽（`RATE_LIMIT`）时 `recordFailure`（冷却）+ `advanceAccount`（指针前移）；
- `TranslationService` 自带**有界重试**（`translateRetries`，默认 2）：第一次落在耗尽的账号上被冷却，第二次 `selectAccount` 自然拿到下一个账号。可重试代码：`RATE_LIMIT/QUOTA/NETWORK/OVERLOADED/ELIGIBILITY/AUTH/TIMEOUT/PROCESS_EXIT/EMPTY_RESPONSE`；不可重试：`AUX_DISABLED/AGY_NOT_INSTALLED/UNSUPPORTED_REASONING_EFFORT/ABORTED`。`EMPTY_RESPONSE` 是 2026-11-03 实机定位的偶发失败：agy 以**干净的 `stop` 收尾但零正文**（非错误信封、非 max-tokens 截断），旧实现报成 `AGY_ERROR` 因而永不重问；现在它是独立码，退避 0.9s×n（比账号排队的 0.15s 长），并把 finish 类型/model/effort/耗时写进 host 日志。
- **adapter 的两处例外**（`src/host/adapter.ts`）：`purpose:'translation'` 纳入 `isAux`，但 ① 保留调用方显式 `reasoningEffort`（aux 默认会把 Gemini 钉成 `low`）；② 不受 `allowAuxiliary` 开关限制（翻译是用户主动功能）。

## 5. 文本抽取

纯函数（`src/features/translation/extract.ts`），对会话事件只读：

- `turn` 边界 = `turn/start{turn}` → `turn/end{turn, reason}`，一个 turn 内含多 `step`；中途 steering / system-reminder 不开新 turn。
- `/tsl` 默认取该 turn **最后一条含非空 text 的 `assistant/message`**（跳过只有 tool-call 的中间步）；`--full` 取该 turn 全部非空 text 按序拼接。
- 「译成人话」按钮**按 `messageId` 精确定位被点的那一条消息**（`translateMessage` → `translateAnswer`），不再回退到该回合的最后一条：一个 turn 里可能先有一段说明、再是真正的答复，用 turn 级解析会翻错人。
- 附带 `messageId`、`anchorSeq`（该消息的 seq）、`sourceModel`（用于"同模型跳过"）。
- 超长文本按段落切块（`translateMaxChars`，默认 8000），逐块翻译、块间空行；仍是**串行**（多块并发会争用同一条 1:1 翻译会话）。

每次调用的请求行（`buildTranslationPrompt`）刻意极简，**只有一句话 + 三条必要约束**（人格与历史交接见 §3.5，只发一次）：

```
把下面这段「当前这一条 AI 回复」的原文，用<目标语言>讲成大白话，就像当面跟同事解释：
说人话、用短句，怎么顺口怎么来；别用行话、缩写和「首先 / 其次 / 综上 / 因此」这类书面词，
遇到术语先用日常说法讲清它大概是干什么的。
原文说了多少就讲多少，该长就长、该短就短，别压成几句结论，也别写成标题或分点报告。
只讲这一条回复（DSH 会话 <id>）本身，别把历史里别的回复混进来；别改原意，别加原文没有的内容。
[原文较长时] 原文比较长，按它自己的顺序一步步讲完，别漏掉关键条件。
只输出讲解本身，不要复述我发的内容，不要提问。

<content>
…原文…
</content>
```

用户明确要求**按实际内容量输出**（不要精简成要点），所以长文本提示是「一步步讲完」而不是早期的「挑重点」。`DSH 会话 <id>` 只在未绑定会话的自足提示里出现，作用是给模型一个"这是哪条线程"的锚，不携带历史正文。

历史教训：早期版本有六条编号规则（结论先行 / 去黑话 / 保留可执行信息 / 输出 Markdown / 字数上限），实测会让 Gemini 输出**标题 + 分点的工作报告**，与"人话"正好相反。因此删除格式指令，只保留防漂移的三条。长文本阈值 `> min(2000, maxChars/4)` 时才附加预算提示（8:2：挑重点，而不是规定结构）。

## 6. 持久化与渲染

- 记录类型：`plugin:agy-link/translation`（`ignorable: true`），字段：`version/turn/sourceTurn?/anchorSeq/text/original?/model/effort/accountId?/sourceModel?/provider/durationMs/createdAt`。**新写入记录必须保持 `turn: null`、`sourceTurn: <原回合号>`**，客户端投影（`src/client/translate-record.ts`）必须返回 `location: { kind: 'session' }` 与 `groupTree: 'turn'`——否则当用户中途翻译较早回合时，DSH 的 `ConversationLocationIndex` 会按 `data.turn` 劫持 `currentTurn` 并把卡片吞进可折叠的 0-tool `ProcessGroup`，导致译文消失与后续回复布局错乱。
- 落库顺序：优先动态 import 宿主提供的 `appendPluginRecord`（non-literal specifier，保持可选）；不可用时**回退到原生 `session.append(type, data)`**。两者都失败才返回 `null`（卡片不落地，其余功能不受影响）。
- 会话事件读取（`sessionEvents`）：依次尝试 `session.snapshotEvents()`、`session.ownEvents()`，再回退 `.log` / `.events` 数组。**DSH 真实 Session 没有 `.log`**——只读 `.log` 的旧实现会拿到空数组并报 `SESSION_UNAVAILABLE`，这是"点了没反应"的根因之一。
- **不得在 `session/event` 回调内同步 append**：`Session.append` 在 publication 边界内会拒绝重入；翻译是异步的，落库天然在后续栈。
- 客户端（`src/client/translate.ts`）：注册 Conversation 事件 Definition（`kind = agy-translation`）+ `conversation.chat.node` keyed `agy-translation` 渲染卡片。Definition **必须经 `ctx.inject(['uiConversation'], …)` 注册（`registerConversationDefinitions`）**：客户端 boot 条目只等 `slots`/`locale`，插件可能先于 dsh-client-ui-conversation 应用；一次性 `ctx.get('uiConversation')` 拿到 `undefined` 就整页静默不注册——记录照常落库，但一张卡片都不会出现（ACP 卡片同理）；卡片 `anchorSeq = 被翻译消息 seq + 0.1`，因此**即使翻译几十秒后才落库，也会显示在所属回复下方**（按钮路径用的是被点的那条消息的 seq）。
- 卡片外观**必须像 DSH 原生组件，而不是插件自造的横幅**（0.5.1 的品牌渐变版被人类验收否决：整宽高饱和色块在会话里像一块外来横幅）。配方与仓库内 `agy-tv-card` 同源：`0.5px` `--dsw-alias-border-l1` 描边、`--dsw-alias-markdown-code-block` 底、`--dsw-radius-md`（12px）圆角、`--dsw-alias-markdown-code-block-banner` 头部横幅；正文按 DSH Markdown 排版（`--dsw-font-markdown-base-font-size` / `--dsw-font-markdown-base-line-height`）。
- 身份区分只保留最小量：头部一枚**单色** Gemini 四角星（`--dsw-alias-state-business-primary`）+「Gemini 译文」标签。**禁止**品牌渐变底/渐变描边/渐变字标/右上柔光/整宽高饱和填充；也不再单独占一行「Translated by Gemini」署名（标签已承担）。
- 卡片头部：星标 + 标签、模型/档位/账号（caption 元信息）、复制、查看原文（有 `original` 时）、收起——全是 11.5px ghost 按钮（`--dsw-alias-interactive-bg-hover` 悬停）；原文区块以顶部虚分隔线接在正文之后。根元素 `data-agy-translation="gemini"`。
- 深浅主题：颜色**全部**取 DSH 令牌（含 `--dsw-alias-markdown-inline-code` / `--ds-font-family-code`），另用 `body[data-ds-dark-theme]` 提供本地兜底值，不写死任何一档主题的颜色；动作按钮状态色同样走 `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary`。
- 入口：`conversation.chat.assistant-actions` 里的**纯图标按钮**（Gemini 星形，与复制/点赞/链接同一行，无文字）。list 槽的 `id` 是行身份——缺 `id` 时该行不渲染（历史事故）；会话通过槽的 `inject(sessionId)` 注入。
- 按钮状态机：`idle`（星形）→ `working`（**SVG 旋转圆环**，`disabled` + 阻止冒泡）→ `done`（绿勾，**保持**，因为卡片已持久）/ `error`（红叹号，3s 后回到可重试的 idle）。状态放在**模块级 Map + 在途 Set**（聊天面板在窗口重获焦点时会被重建，组件内状态会丢），并在挂载时用 `/translate/state` 校正。
- 提示气泡：**一个 body 级 `position: fixed` 节点**（懒创建、单例、卸载时移除），像 DSH 自己的 tooltip portal 一样——因此在会话滚动容器之外，**既不会被滚容器裁切，也不会被输入区盖住**；位置在锚点**下方**（+6px、水平居中、视口内收边，只有视口底边才翻到上方），与动作栏其余提示保持一致。令牌逐项对齐基元：`--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00` / 13px-20px / `3px 7px` / `--dsw-radius-sm` / 无尖角。
- 该节点默认由**内联样式**隐藏（`position:fixed;display:none`），展示/隐藏全由 `showTip()` / `hideTip()` 控制：因此样式表缺失或过期都只会"没有提示"，不会把标签漏成行内文字（旧伪元素方案在样式表被旧标签压住时就是这样漏的）。文案由 `title` 经 `t()` 本地化后写入节点；`aria-label` 仍在按钮上。
- 样式表自愈：`injectStyles()` 发现同名标签**内容不一致时重写**，id 带版本号（`dsh-agy-link-tsl-css-v2`）。旧实现"已存在就 return"会让热重载后新增规则永不生效（提示曾因此退化成行内文字）。
- 已存在同 turn/同 `messageId`/同模型/同档位记录时直接复用，不重复调用、不重复建卡。**去重是消息级的**：同一回合里 A、B 两条回复各自可有译文，点 B 不会拿到 A 的卡片；没有 `messageId` 的旧记录只在该回合没有任何消息级记录时作为兼容兜底。

## 7. 自动模式

- 默认**关**（`autoTranslate=false`），设置区可开；`/tsl auto on|off|status` 做**本会话覆盖**。
- 触发：`session/event` 的 `turn/end && reason.kind==='completed'`；仅对新事件生效（不会追溯翻译历史）。
- 守卫：同 session 串行、最小间隔 `translateMinIntervalMs`（3s）、`translateSkipSameModel`（源模型即翻译模型时跳过）、空文本跳过。
- 失败绝不抛出到 agent loop（`autoTranslateTurn` 内部吞掉并记日志）。

## 8. 配置

| 键 | 默认 | env |
| --- | --- | --- |
| `autoTranslate` | `false` | `DSH_AGY_AUTO_TRANSLATE` |
| `translateModel` | `gemini-3.8-flash` | `DSH_AGY_TRANSLATE_MODEL` |
| `translateEffort` | `medium` | `DSH_AGY_TRANSLATE_EFFORT` |
| `translateTargetLanguage` | `中文（简体）` | `DSH_AGY_TRANSLATE_LANG` |
| `translateMaxChars` | `8000` | — |
| `translateMaxTokens` | `4096` | — |
| `translateTimeoutMs` | `120000` | — |
| `translateRetries` | `2` | — |
| `translateSkipSameModel` | `true` | — |
| `translateMinIntervalMs` | `3000` | — |
| `translateBindConversation` | `true` | — |

- 控制台入口：`translateModel` / `translateEffort` 在设置页**「自动翻译」这一行**右侧用两个原生下拉框改写（`src/client/config-options.ts` 生成选项，写入走既有 `POST /plugins/agy-link/config`）。空值 = 交给宿主：模型走 `resolveTranslateTarget` 的回退链，思考档跟随下面的「默认思考强度」；目录里查不到但已配置的模型/档位仍作为额外选项显示，避免下拉框把真实状态谎报成「默认」。
- 模型下拉框**只列 Gemini 家族**（`geminiCatalogModels`）：卡片标着「Gemini 译文」，允许选 Claude/GPT 会让标签变成谎话；手工配置的非 Gemini 模型仍通过「未列出的当前值」显示。

## 9. 测试锚点

- `test/features/translation/translate.test.ts`：提示词（**无格式指令、要求按实际内容量讲全**）、人格块（会话 id/工作目录/日志路径/摘要）、`sessionDigest`、分块、turn 抽取、模型回退、缓存/去重、**按被点消息翻译**、**消息级去重（同回合 A/B 各自独立）**、**旧记录兼容**、**配额失败→换号重试**、**空回答重试**、`existingMessage`（按钮状态来源）、record 字段。
- `test/features/translation/tsl-command.test.ts`：参数解析、`/tsl auto`、错误文案、`--text` / `--print`。
- 客户端：`test/client/client-i18n.test.ts` 覆盖四语言键（含 `config.defaultEffort`）；`test/client/translation-client.test.ts` 覆盖 Definition 投影/锚点、卡片渲染、图标按钮、body 级 `position: fixed` 单例提示气泡（卸载时清理）、样式表自愈、状态跨重挂载；`test/client/client-plugin-meta.test.ts` 覆盖设置面板必须保留默认思考强度行。
- 翻译会话 1:1：`test/provider/adapter-*.test.ts` 断言首次 = 人格+请求行且无 `--conversation`、第二次复用同一 `conversationId` 且**只发请求行**（不含人格）、plan 模式；轮次会话的绑定不受影响。
- 上下文预算：`test/provider/adapter-*.test.ts` 覆盖 `elideMiddle` 的字节上限与 CJK 不切断、`buildDigest` 工具行默认掐头去尾且**永不省略散文**、以及 live task 不被工具输出挤掉。
- 真机联调（人工、会花少量额度）：`node --experimental-transform-types scripts/smoke-translate.ts [文本 | --file <path>]` 用真实 `agy` + 真实账号池跑一次 `purpose:'translation'`（验证模型/档位/plan 模式与提示词；`--file` 可直接喂一条真实回复）。

## 10. 已知取舍

- 不把 `@deepseek-ai/dsh-session` 声明为 peer dependency（宿主注册表里没有它，声明会让 `pnpm install` 失败）：改为运行时动态 import，并用 `session.append` 兜底。
- 译文与原文同存于会话日志（`original` 截断到 8000 字），用于"查看原文"对照，换取可读性。记录是 `ignorable` 的 plugin record：**不进模型可见历史**，未来会话格式迁移只做尽力保留。
- 提示词极简是**取舍而非疏忽**：牺牲"必须保留文件名/命令清单"这类结构化保证，换取真正的口语化输出；需要结构化细节时看卡片里的"查看原文"。
- 自动模式暂无"翻译中"占位卡片（可选增强）：卡片在完成后直接出现。medium 档实测首字约 30s，等待偏长；要更快就切 low。
- 多块长文本仍然串行：单块共用同一条 1:1 翻译会话，并发会让两个 agy 进程抢同一个 conversation id。真正的提速路径是减少分块（把 `translateMaxChars` 调大）或并行服务端会话，后者未实现。
- **0.5.1 的 Gemini 品牌外观是一次失败尝试，不回滚也不兼容**：品牌渐变在独立页面上好看，塞进 DSH 会话却像外来横幅（用户原话「也太丑了」）。结论是插件产物必须服从宿主设计系统——品牌身份压缩到「一枚星标 + 一个标签」，其余交给 DSH 令牌；后续任何卡片改动都以此为准。
