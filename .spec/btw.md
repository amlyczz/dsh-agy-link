# 旁路提问（`/atw` — Ephemeral Side Questions）

> 维度：**旁路提问（`/atw` 命令 / 浮层卡片 / 流式只读问答）**。只回答一件事：用户如何在不打断当前主回合、不污染主会话历史的前提下，向 Antigravity 发起支持流式输出、只读工具调用与多轮追问的旁路提问。

## 1. 目标与边界

- **非阻塞主回合**：主回合正在运行（或空闲）时都能随时 `/atw <问题>`；命令提交后立即释放 DSH 输入框，不冻结 composer，也不往主对话历史写入 `user/message` / `assistant/message` 或改变 `sessions.json` 绑定。
- **只读与安全隔离**：
  - `BtwService`（`src/features/btw/service.ts`）强制使用 `--mode plan` + `--disable-slash-commands`，提示词明确禁止修改文件、禁止执行 shell 命令（`run_command`）、禁止接管主任务或继续任何活动 `/goal`。
  - 需要交互审批的工具调用在 headless `plan` 模式下会被自动拒绝，不会挂起阻塞；仅允许只读检查（如 `read_file`、`grep_search`、`list_dir` 等），并在卡片中实时展示工具步骤与 `Called N tools` 汇总。
  - 绝不复用主会话的 `agy conversationId`（避免与正在运行的主 `agy` 进程争抢同一会话锁）；首次提问携带 `<session_context>` + `<live_run_progress>`（来自 `slash-context.ts`），并将本次 `btw` 产出的 `conversationId` 仅用于同一旁路线程内的追问（`followUp`）。
- **不做**：不把旁路问答写入模型可见的主会话历史；不自动修改工作区文件；不替主会话做决策。

## 2. 统一入口与生命周期

`BtwService`（`src/features/btw/service.ts`）是唯一业务核心，四个消费入口：

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 顶级 `/atw` 命令 | `src/host/btw-command.ts` | 快捷命名（避开社区插件 `@michengai/dsh-btw` 的裸名 `/btw`）；声明 `description` 与 `input.hint` 以便 DSH `/` 菜单展示与选中提示；支持 `/atw <问题>`、`/atw`（GUI 切换/展开卡片）、`/atw copy`、`/atw clear\|dismiss`、`/atw --wait`（同步等待正文，无 web UI 或显式指定时使用）、`--new`、`--model`、`--effort` |
| `/agy btw <问题>` | `src/host/commands/slash-bridge.ts` | 保留既有同步接口向后兼容，复用同一旁路上下文与提示词构造 |
| HTTP 控制面与流 | `src/transport/http/routes/btw.ts` | `GET /plugins/agy-link/btw/state`、`GET /plugins/agy-link/btw/stream`（SSE）、`POST /plugins/agy-link/btw/ask`、`POST /plugins/agy-link/btw/cancel`、`POST /plugins/agy-link/btw/dismiss`、`POST /plugins/agy-link/btw/clear` |
| DSH 输入框上方 Dock 卡片 | `src/client/btw.ts` + `src/client/btw-card.ts` | 挂载于 `conversation.input.dock`（`order: 15`），同步注册 `conversation.chat.commandview`（key `atw`）抑制主聊天流冗余命令卡 |

### 非阻塞调度策略

1. 宿主挂载了 `webServer`（GUI 活跃）且未传 `--wait` / `--print` 时，`/atw <问题>` 启动后台 `BtwService.ask(...)` 后**立即返回** `{ kind: 'success' }`，让 DSH `SubmitMachine` 立刻解冻并清空输入框。
2. 客户端 `BtwDock` 监听 `ctx.commandUi` 的 `command/executed`（`name === 'atw'`）及 `/plugins/agy-link/btw/stream?session=<id>` SSE 推送（不支持 SSE 或异常时回退短轮询 `/plugins/agy-link/btw/state?session=<id>`），实时渲染流式文本、工具进度与耗时。
3. 无 `webServer`（headless / CLI / 测试）或传入 `--wait` / `--print` 时，`/atw <问题>` 等待 `BtwService.ask(...)` 结算后直接把正文返回在 `CommandResult.text` 中。

## 3. 状态模型与交互能力

`BtwService` 按 `sessionId` 维护会话隔离状态（最多保留 `MAX_BTW_SESSIONS = 100` 个会话、每会话最多 `MAX_ENTRIES_PER_SESSION = 20` 条记录）：

- **`BtwEntry`**：`id`、`question`、`answer`、`tools`（`stepKey` / `name` / `target` / `state: 'running' | 'done' | 'error'` / `error`）、`status`（`'running' | 'done' | 'error' | 'aborted'`）、`error`、`model`、`effort`、`accountId`、`conversationId`、`startedAt`、`finishedAt`、`durationMs`。
- **`BtwSessionView`**：`sessionId`、`open`、`activeIndex`、`entries`、`revision`（单调递增，供 SSE / 条件更新）。
- **并发与取消**：同会话同一时刻最多一个运行中的 `/atw`；发起新提问时若上一条仍在运行，自动中止上一条的 `AbortController` 后启动新提问；用户按 `Esc`（仅在卡片打开且无弹窗/斜杠菜单劫持时）或点「停止」立即中止当前提问；已结算状态下按 `Esc` 或点「关闭」将卡片收起（`open: false`，历史仍在，可再次 `/atw` 唤回）。
- **追问与翻页**：卡片底部提供紧凑单行追问输入（`followUp: true`，沿用当前条目所属的 `conversationId`）；多条记录时头部提供 `< 1 / N >` 历史切换，以及 `+ 新问题`、复制、工具列表折叠/展开、正文折叠/展开。
- **高度钳制**：展开后的正文区域限制在 `max-height: min(38vh, 320px)` 内局部滚动，确保长回答绝不把 DSH 主输入框或底部提示顶出视口。

## 4. 共享执行与流式转发

- `src/host/oneshot.ts` 为 `runAgyOnce` 增加可选 `onEvent?: (ev: AgyEvent) => void` 与 `onAttemptStart?: () => void` 回调：
  - `BtwService` 直接复用 `runAgyOnce` 的账号池选择、429/配额/认证换号重试、`--effort` 不支持自愈降级、Windows 凭据槽互斥与 `StreamJsonParser` 解析，不重复造轮子。
  - 每次账号重试前 `onAttemptStart` 清空当前尝试的局部流状态；每个 `init` / `step`（`text`、`tool`）/ `result` 实时喂给 `BtwService`，驱动 SSE 推送给 `BtwDock`。
- **模型与思考档配置**：
  - 统一由 Antigravity (`agy`) 模型执行，模型选择优先级：`--model` 命令参数 > 控制台配置的 `btwModel`（`DSH_AGY_BTW_MODEL`）> `defaultModel` > 目录优先 Gemini 4 Hydrogen / Gemini Flash；思考档优先级：`--effort` > `btwEffort`（`DSH_AGY_BTW_EFFORT`，默认 `medium`）。
  - 控制台「设置 → 插件 → Antigravity → 功能与界面」标签页中的 `/atw 旁路提问` 卡片提供下拉选择并持久化到 `runtime-overrides.json`。

## 5. 测试锚点

- `test/features/btw/btw.test.ts`：`BtwService` 生命周期（流式文本拼接、工具步骤追踪、追问复用 `conversationId`、新线程重置 `conversationId`、中止取消、历史翻页/上限裁剪、账号重试清状态）、`/atw` 顶级命令解析与 GUI 非阻塞 / `--wait` 同步双路径、`/plugins/agy-link/btw/*` HTTP 路由契约（含 SSE 流与 400/405/404 校验）。
- `test/client/btw-client.test.ts`：`BtwDock` 组件渲染（流式状态、工具折叠/计数、长文滚动容器、历史翻页、追问提交、停止/关闭/复制、Locale 翻译键与英文兜底）、`conversation.chat.commandview` 的 `atw` 抑制、`installBtwUi` 注册与卸载清理。
- `test/client/client-i18n.test.ts`：四语言（`zh`/`en`/`es`/`ptBR`）新增 `btw.*` 键对齐。
