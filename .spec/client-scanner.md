# 客户端 DOM 扫描与浮层隔离契约（唯一事实源）

> 维度：**流式聊天中 DOM 增强器如何既正确又不卡主线程，以及全屏控制台浮层打开时如何彻底消除背景重排与滚动闪屏**。

## 1. 扫描触发与单趟预算

`scanAndEnhanceImages()` 等会话增强器由 `MutationObserver` + 100ms debounce 驱动，并统一受 `scroll-guard`（`isInteractionLocked()`）约束：

| 子任务 | 幂等标记 | 快速路径 |
| --- | --- | --- |
| 链接增强（图片 / 视频 / 音频 / 本地文件） | `data-agy-link-scanned` + 各自的 `*-enhanced`（含 `data-agy-audio-enhanced`） | 选择器直接排除已访问链接；`/plugins/agy-link/embed` 链接显式跳过，交由 `embed.ts` 处理 |
| markdown 图片 alt span | `data-agy-alt-scanned` / `data-agy-enhanced` | 无未处理 span 时立即返回 |
| media origin 改写 | `data-agy-origin-rewritten` | 仅查询未改写的 `img[src*="/plugins/agy-link/media"]` |
| Generative UI 微件（`<agent-embed>`） | `data-agy-embed-scanned` | `embed.ts` 将 `/plugins/agy-link/embed` 链接升级为 `<iframe sandbox="allow-scripts">` 卡片，按 `id` + `ev.source === frame.contentWindow` 校验证 `agy-embed-resize` 自动高度（80–800px）并同步 DSH 深浅主题变量 |
| 扩展工具镜像卡片 | — | `extended-model.ts` / `extended-cards.ts` / `checklist-card.ts` 为 `swarm`、`run_workflow`、`schedule`、`manage_task`、子代理生命周期、`browser`/`chrome-devtools`、`update_steps`（步骤检查清单卡片，默认展开呈现 `N/M steps` 进度与逐项状态图标，并在宿主侧同步发射 DSH 原生 `todo/write` 会话事件以点亮 `TodoPanel`）与 `update_focus`（当前焦点卡片）提供结构化标签、图标与输出卡片；`invoke_subagent(image-generator)` 路由至图片卡片 |

## 2. 流式跳过可恢复不变式（PR #110 / v0.6.25）

流式输出按 token 分块增长。容器仅保存短指纹 `data-agy-alt-md = "<length>:<hash>"`；每趟扫描比对已跟踪容器指纹，仅当指纹变化时才重置未增强 span 的 `scanned` 标记，兼顾 O(1) 稳态开销与流式补全正确性。

## 3. 全屏控制台浮层隔离与防闪屏硬契约（issue #48 衍生）

全屏控制台（`AgyModalDialog`）打开期间必须同时满足以下可测硬约束：

1. **禁止合成层闪烁陷阱**：`.agy-modal-backdrop` 与 `.agy-lightbox-backdrop` 严禁使用全视口 `backdrop-filter` / `-webkit-backdrop-filter`；`.agy-modal-panel` 严禁使用 `contain: content` 或 `transform: translateZ(0)`；`.agy-shimmer-track::after` 严禁常驻 `will-change: transform`。
2. **壳层与会话双滚动锁**：`agyModalStore.setOpen(true/false)` 同步切换 `html.agy-modal-open`（锁定 `html, body` 与 `[data-conversation-scroll]` 的 `overflow: hidden !important`），`.agy-modal-backdrop` 与 `.agy-modal-body` 设置 `overscroll-behavior: contain` 及 `min-height: 0`。
3. **非 passive 滚轮隔离**：在 `document` 捕获阶段挂载非 passive `wheel` / `touchmove` 监听，拦截遮罩与非滚动区事件，仅放行 `.agy-modal-body` 内部原生滚动。
4. **全局扫描器停摆与补偿**：`isInteractionLocked = 滚动中 || 浮层打开`（含控制台弹层与图片 Lightbox）；浮层打开时挂起所有会话 DOM 扫描器，关闭时触发一次 `settle` 回调做补偿扫描；插件卸载（`dispose`）时强制复位 `agy-modal-open`、关闭活跃 Lightbox 并执行 `setOverlaySuspended(false)`。
5. **流式扫描复杂度与零 React 警告**：`compaction` 与 `mermaid` 扫描器对普通段落和非 Mermaid 代码块标记/快速跳过，避免流式输出期间每 100ms 全量提取 `textContent`；所有 React 组件子节点遵循 variadic 或显式稳定 `key`，确保零 missing-`key` 警告。

## 4. 测试锚点

- `test/client-dom.test.ts`：单趟幂等标记与流式文本增长后本地图片卡片恢复。
- `test/modal-overlay-isolation.test.ts` / `test/scroll-guard.test.ts`：禁用 `backdrop-filter`/`contain`/`will-change`、滚动锁、非 passive 滚轮拦截、扫描器门控与卸载清理。
- `test/issue153-client-locale.test.ts` / `test/extended-ui-and-embed.test.ts`：所有新增 DOM 增强器（`embed.ts`、`audio.ts`、`extended-cards.ts`、`image-card.ts`）通过 `i18n-bridge.ts` 遵循宿主语言且无硬编码中文，且 `installAgentEmbedRenderer()` 在缺省 `window.addEventListener` 环境下安全无操作退化。
