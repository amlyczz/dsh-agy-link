# UI 可见性开关（会话头徽标 / 单条翻译按钮）

> issue #105：手机等窄屏下，会话头部工具栏与每条回复的「译成人话」按钮
> 挤压正常内容。本维度只回答：**哪些 UI 元素可以隐藏、开关怎么从宿主传到
> 渲染点、缺省语义是什么、窄屏如何降级。**

## 行为契约

| 开关 | 缺省 | 控制的元素 | 关闭后 |
| --- | --- | --- | --- |
| `showHeaderBadge` | `true` | `conversation.session.header.actions` 里的 AGY 状态徽标 | 徽标不渲染；控制台弹窗 portal 仍保留 |
| `showTranslateAction` | `true` | `conversation.chat.assistant-actions` 里的单条「译成人话」按钮 | 按钮不渲染；已生成的译文卡片不受影响 |
| `translateDisplay` | `card` | 已生成译文的呈现方式 | `replace`：界面上用译文代替被翻译的回复，脚注「查看原文 / 显示译文」可切回 |

`translateDisplay = replace` 只改显示：会话里的原文不动（模型上下文仍是原话）。DSH 把译文节点排在被翻译回复之后（`anchorSeq + 0.1`），
样式表用 `[data-chat-flow-kind="assistant-step"]:has(+ [data-chat-flow-kind="agy-translation"] .agy-tsl-card[data-display="replace"][data-show-original="false"])`
隐藏这条回复，不改 DOM；若两者之间被插入别的节点，规则不再匹配，原文与译文同时显示（降级而非丢内容）。「查看原文」切回 DSH 自己渲染的完整回复，而不是记录里截断到 8000 字的副本。

- **opt-out 语义**：只有显式 `false` 才隐藏。状态未到达、旧宿主不含该字段、
  `undefined`/`null` 都保持可见 —— 避免网络抖动时 UI 闪退。规则集中在
  `src/client/status.ts` 的 `isUiVisible()`，两个渲染点共用，不各自判断。
- **不改变功能**：隐藏的是入口，不是能力。自动翻译（`autoTranslate`）、
  `/tsl` 命令、译文卡片、设置面板本身全部照常工作。

## 数据流（单向，无第二份状态）

```
设置面板 setCfg(key, false)
  → POST /plugins/agy-link/config（白名单校验）
  → runtime-overrides.json / resolveConfig
  → GET /plugins/agy-link/status（每 3s 轮询，字段直出）
  → useAgyStatus() 共享快照（statusCache）
  → isUiVisible(status, key)
  → SessionStatus / TranslateAction 条件返回 null
```

- 配置定义：`src/common/types/config.ts`（类型 + 默认值），
  `src/common/config.ts`（各层读取 + `DSH_AGY_SHOW_*` 环境变量）。
- HTTP 面：`src/transport/http/routes/config.ts` 白名单 + `status.ts` 直出。
  不在客户端另建缓存或本地开关，避免与宿主状态分叉。
- 运行时切换无需刷新页面：状态轮询推送新快照，已挂载组件重渲染。

## 窄屏降级（不是开关，是渐进增强）

`src/client/global-css.ts` 在 `max-width: 680px` 下隐藏徽标的文字标签
（`.agy-session-status-label`）并收紧内边距，只留状态圆点；于是默认开启
也能缓解窄屏拥挤，需要完全去掉时再关 `showHeaderBadge`。

## 验证

- `test/client/ui-visibility.test.ts`：`isUiVisible` 的 opt-out 边界、SSR 渲染
  真实 `createSessionStatus` 在开/关/恢复三种状态下的输出。
- `test/client/client-dom.test.ts`：jsdom 挂载真实 `TranslateAction`，关闭时无按钮、
  重新开启后原地恢复。
- `test/common/config-precedence.test.ts`：默认值、overrides/entry/env 各层与非法值回退。
- `test/transport/http-contract-*.test.ts`：状态字段直出（含显式 `false`）、配置白名单放行。
- `test/client/client-plugin-meta.test.ts` + `test/client/client-i18n.test.ts`：四语言字典
  键与占位符对齐。

## 文件链接必须在右侧边栏预览而不是系统程序（issue #141）

`openInRightSidebar()` 只在「宿主确实注册了文档预览标签」时才走侧边栏，否则回退系统程序。这个判断必须按 DSH 的真实契约做：

- `sidebarRightTabs.get()` 以标签 **kind**（`'text'`）为键，**不是**类型 id；用 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 去 `get()` 永远是 `undefined`，于是所有点击都落到系统程序。
- 正确顺序：先在 `entries()` 里按 `id` 查；没有 `entries()` 时回退 `get('text')`，**并核对其返回的 `id`**，避免把别的 text 标签当成预览。
- `normalizeLocalPath()` 必须**先**拆掉 `?#` 后缀再 `decodeURIComponent`（否则名字里的 `%3F` 会被当作查询串），解码失败保留原值；随后统一 `\` → `/`。否则被编码的 href 与会话 cwd 对不上，地址还会被二次编码。
- 客户端测试的 mock 必须模拟真实契约（`get(kind)` + `entries()` 带 id）。用 id 键 mock `get()` 会让这段 bug 通过 CI。
- 锚点：`test/client/issue141-sidebar-preview.test.ts`、`test/client/client-dom.test.ts`。

## 客户端文案必须走 locale，注入文本尤其（issue #153）

插件的客户端模块（decision chips、toolview、mermaid、compaction、lightbox、账号面板…）面向用户的所有文案都必须来自 `locale` 服务，**不得硬编码**。

- 最严重的一类不是标题而是**写进用户输入框的文本**：决策芯片点击后会把选中项插入 composer，硬编码中文会让英文宿主把中文前缀当作**用户自己写的 prompt** 发给模型。
- 形态：模块级 `activeTranslate`（`install*` 时由 `ctx.locale.bind(NS)` 注入），并提供英文兜底，使无 locale 服务的宿主（SSR/测试）仍可用。
- 新增键必须四个语言齐全（`en`/`zh`/`es`/`ptBR`），英文值不得含中日韩字符。
- 测试要锁两件事：源码里不再出现该文案的字面量；四个 locale 都定义了对应键。
- **统一入口**：`src/client/i18n-bridge.ts` 的 `translateOr(key, englishFallback, params)`。客户端 DOM 增强器（图片 chip、灯箱、mermaid、压缩卡片、问题卡片、决策芯片）不是 React 组件，多数没有自己的 `ctx`，全部读 `index.ts` 里一次性 `bindTranslator(ctx)` 建立的绑定；没有绑定（SSR/测试）时输出英文兜底，**绝不输出裸 key**。
- **不要翻译用于「识别」的文本**：例如 mermaid 里 `代码块` 是 DSH 的占位 banner 文案，用来判断 banner 是否携带真实语言标签；翻译它等于破坏检测逻辑。
- **不要用 `document.documentElement.lang` 代替 locale 绑定**：那是 DSH 页面语言，与插件 locale 可能不一致。
- 锚点：`test/client/issue153-decision-locale.test.ts`、`test/client/issue153-client-locale.test.ts`（源码无中文字面量 + 四语言键齐全 + 兜底语义）、`test/client/client-dom.test.ts`（插入 payload 已本地化）。

## 子代理可见性：顶栏下拉，复用 job 面板的「外观」而非 job 账本（2026-11-23）

agy 的协同专员（`Builder N`、`Concept Artist` 等）此前只能作为滚动中的思考行出现。现在在会话顶栏提供一个紧凑计数控件，展开即见「运行中 / 已结束」分区：角色 · 类型、当前动作、走动耗时。

- **数据源**：`SubagentTracker.snapshot()`（读 agy 会话目录 `.system_generated/subagents/*.json`）→ `features/subagent/live.ts` 按 DSH session 注册 → `/status.subagents` → 顶栏按注入的 `sessionId` 只显示本会话。
- **为什么不注册成 DSH job**（虽然 `dsh-client-ui-jobs` 本来就是这么显示子代理的）：
  1. `dsh-jobs-local` 的 `maxConcurrentJobsPerOwner` 默认 **10**，且 **bash 后台任务与它共用**该额度；agy 一次可并发 10 个子代理（2026-11-23 实测），注册必然 `JOB_LIMIT_REACHED`。
  2. 每个 owned job 结算会向「该会话的 agent」发 `background job <id> (<kind>: <label>) finished …` —— 这里 agent 就是 agy，会给它注入一条它没发起过的通知，并按 `user/message` 记进会话。
  3. 换成 unowned 虽无通知，但所有会话共享可见、任何会话可停止，反而更糟。
- **结论**：复用 DSH 的**视觉与交互**（计数控件 + 分区 + 耗时），不复用 job 注册通道 → 零通知、零聊天气泡、无 10 个上限、按会话精确。
- 锚点：`test/client/subagent-panel.test.ts`（分组、耗时格式、分区/折叠/空态渲染）、`test/features/subagent/subagent-live.test.ts`（按会话注册与聚合）。
