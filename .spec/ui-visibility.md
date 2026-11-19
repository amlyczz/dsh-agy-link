# UI 可见性开关（会话头徽标 / 单条翻译按钮）

> issue #105：手机等窄屏下，会话头部工具栏与每条回复的「译成人话」按钮
> 挤压正常内容。本维度只回答：**哪些 UI 元素可以隐藏、开关怎么从宿主传到
> 渲染点、缺省语义是什么、窄屏如何降级。**

## 行为契约

| 开关 | 缺省 | 控制的元素 | 关闭后 |
| --- | --- | --- | --- |
| `showHeaderBadge` | `true` | `conversation.session.header.actions` 里的 AGY 状态徽标 | 徽标不渲染；控制台弹窗 portal 仍保留 |
| `showTranslateAction` | `true` | `conversation.chat.assistant-actions` 里的单条「译成人话」按钮 | 按钮不渲染；已生成的译文卡片不受影响 |

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

- `test/ui-visibility.test.ts`：`isUiVisible` 的 opt-out 边界、SSR 渲染
  真实 `createSessionStatus` 在开/关/恢复三种状态下的输出。
- `test/client-dom.test.ts`：jsdom 挂载真实 `TranslateAction`，关闭时无按钮、
  重新开启后原地恢复。
- `test/config-precedence.test.ts`：默认值、overrides/entry/env 各层与非法值回退。
- `test/http-contract.test.ts`：状态字段直出（含显式 `false`）、配置白名单放行。
- `test/client-plugin-meta.test.ts` + `test/client-i18n.test.ts`：四语言字典
  键与占位符对齐。

## 文件链接必须在右侧边栏预览而不是系统程序（issue #141）

`openInRightSidebar()` 只在「宿主确实注册了文档预览标签」时才走侧边栏，否则回退系统程序。这个判断必须按 DSH 的真实契约做：

- `sidebarRightTabs.get()` 以标签 **kind**（`'text'`）为键，**不是**类型 id；用 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 去 `get()` 永远是 `undefined`，于是所有点击都落到系统程序。
- 正确顺序：先在 `entries()` 里按 `id` 查；没有 `entries()` 时回退 `get('text')`，**并核对其返回的 `id`**，避免把别的 text 标签当成预览。
- `normalizeLocalPath()` 必须**先**拆掉 `?#` 后缀再 `decodeURIComponent`（否则名字里的 `%3F` 会被当作查询串），解码失败保留原值；随后统一 `\` → `/`。否则被编码的 href 与会话 cwd 对不上，地址还会被二次编码。
- 客户端测试的 mock 必须模拟真实契约（`get(kind)` + `entries()` 带 id）。用 id 键 mock `get()` 会让这段 bug 通过 CI。
- 锚点：`test/issue141-sidebar-preview.test.ts`、`test/client-dom.test.ts`。
