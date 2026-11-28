# 重构待办（临界模块）

`npm run lint:budget` 的上限是 **每文件 600 行**。下面这些模块长期贴着上限：每次新增行为都要靠**删注释**腾出空间，这是职责过多的信号，而不是"还差几行"。

维护规则：
- 新增功能若让任一文件超过上限 → **不要加 ratchet 豁免**，先把一处**无状态职责**抽成独立模块。
- 抽取顺序按"纯函数 → 无状态分支 → 有状态协作"进行，避免一次动多个概念。
- 每次抽取后 `check`/`lint:budget`/`build`/`test` 必须全绿，行为不变（已有测试即回归网）。

## 2026-11-24 扫描（342 模块 / 67,894 行 / 0 环 / 0 方向违规）

| 模块 | 行数（抽取前） | 可抽出的职责 | 状态 |
| --- | --- | --- | --- |
| `src/provider/prompt-text.ts` | 599 | 纯文本预算工具族已稳定；新增职责应另起模块（#221 的 `protectTrailingRequest` 已另起 `live-last-request.ts`） | 待办（勿再往里加） |
| `src/provider/mapper/event-mapper.ts` | 599 | `formatRunningToolFallback`（纯函数） | **已抽出** → `running-tool-fallback.ts`（575 行） |
| `src/features/translation/service.ts` | 599 | 4 个纯 helper（错误映射 / 空结果 / 模型名比较） | **已抽出** → `translation/helpers.ts`（567 行） |
| `src/features/subagent/tracker.ts` | 599 | 日志尾部跟随与状态机可分离 | 待办 |
| `src/features/background/watcher.ts` | 599 | 定时器调度与唤醒判定可分离 | 待办 |
| `src/features/acp/pool.ts` | 599 | 驱逐策略（`shouldEvict` 一族）可独立 | 待办 |
| `src/features/acp/client.ts` | 599 | JSON-RPC 帧收发可独立 | 待办 |
| `src/client/sections/AccountsPanel.ts` | 599 | 配额条 / 模型子列表渲染可分离 | 待办 |
| `src/host/adapter.ts` | 598 | 绑定（binding）读写可独立 | 待办 |
| `src/domain/credentials/slot.ts` | 598 | 平台差异分支可独立 | 待办 |

**为什么记下来而不是一次全抽**：这几处分别属于 ACP、凭证、宿主调度三条高风险链路；一次性大改会让回归范围失控。按上表逐个推进，每次只动一个概念。

## 2026-11-28 扫描（402 模块 / 77,889 行 / 0 环 / 0 方向违规；测试 216 文件 / 57,778 行）

四天相对 11-24：+59 模块、+15% 源码；**贴上限（≥580 行）的文件从 9 个变成 18 个**，其中 4 个正好停在 599：`host/services.ts`、`host/recording.ts`、`features/background/watcher.ts`、`client/sections/AccountsPanel.ts`。增长本身是健康的（新职责基本都开了新模块：provider +13、host +8、acp +6、common +6），要盯的是"往同一批大文件里继续加"的趋势——这几天两侧各撞了三次预算。

**已抽出**：`provider/prompt.ts` 596 → 420（`prompt-binding.ts`、`live-last-request.ts`、`stale-model-bindings.ts`）；`mapper/event-mapper.ts` 599 → 582；`provider/prompt-text.ts` 650 → 583。

**结构性排查（本次新增的三类检查，结论供后续复用）**：

| 检查 | 结果 | 处置 |
| --- | --- | --- |
| 模块级 `Map` / `Set` 是否有上限（31 处） | 宿主侧全部有界（账本 8 会话 / 16 次运行 / 8 会话缓存等）；**客户端工具卡片席位缓存无上限**（按运行累加，宿主只留 16 次） | **已修**（`client/orchestration/seats.ts` 限 16，按需重取）。`client/reasoning.ts` 的 `handledTurns`、`client/btw.ts` 的 `sessionStore` 随回合 / 会话增长但条目很小，暂不动 |
| 空 `catch {}`（454 处）中"写路径静默失败" | 跟在写入后的空 catch 全部是副写入：凭据备份、目录缓存落盘、临时文件清理、`.last-good` 备份；主持久化路径不在其中 | 无需处理；保留此检查法 |
| 定时任务里的同步读盘 | `features/background/brain-poll.ts` 有 15 处 `*Sync` 读盘且被轮询调用；每次只读几个小文件，量级远小于 #229 修掉的 950ms 孤儿扫描 | 下次动该模块时改为异步 fs（`media-transcode.ts` 23 处同步读盘同理，先量再改） |

**下一批抽取候选**（按"纯函数 → 无状态分支 → 有状态协作"）：

| 模块 | 行数 | 可抽出的职责 |
| --- | --- | --- |
| `src/host/recording.ts` | 599 | 镜像调用 ID 的编解码（纯函数，`parseMirrorCallId` 一族）→ `recording-ids.ts` |
| `src/host/services.ts` | 599 | 组合根只留装配；`isXxxAvailable` 一类的探测函数集中到 `host/service-probes.ts` |
| `src/features/background/watcher.ts` | 599 | 定时器调度与唤醒判定分离（与 #225 的 schedule release 相邻，等其稳定后再动） |
| `src/client/sections/AccountsPanel.ts` | 599 | 配额条渲染分离 |

## 2026-11-25 测试树与样式表

| 动作 | 结果 |
| --- | --- |
| 测试按领域分层 | 162 个平铺文件 → `test/<layer>/` + `test/features/<sub>/`（镜像 `src/` 分层），路径计算收敛到 `test/helpers/paths.ts`（此前 `../..` 手数层数，移动文件即炸 85 个用例） |
| 大测试文件切分 | `adapter` 2910→7 文件、`http-contract` 2060→10 文件、`quota` 1951→7 文件；共享夹具各自收敛到一个 helper，用例数与断言逐字节保留 |
| `global-css.ts` 拆出浮层样式 | 603 → 546 行：`.agy-modal-*` / `html.agy-modal-open` / `html.agy-scrolling` 迁到 `src/client/modal-css.ts`，以 `${MODAL_CSS}` 组合在 `GLOBAL_CSS` 开头（保证手机端 media 覆盖仍在后面生效） |

**仍在临界线上**：`src/client/sections/AccountsPanel.ts` 599 行（预算 600）。下次动它之前先抽 `dotColor` / 卡片头部渲染，不要再靠删注释腾空间。

## 2026-11-25 增量（区间修复顺带抽取）

- `adapter` 的一次性告警门 → `src/provider/warn-once.ts`；steer/lifecycle 判定（`promptIdentity` / `hasNewHumanTask`）→ `src/provider/prompt-identity.ts`（#205）。
- ACP 首事件门限与单行格式化 → `src/features/acp/turn-format.ts`；编排器设置落盘与空闲进程回收策略 → `src/features/acp/orchestrator-prep.ts`（#204）。
- `go-keyring` 信封 → `src/common/go-keyring.ts`（`domain/` 不再 import `runtime/`）；`settings.json` 原子合并 → `src/runtime/agy/settings-sync.ts`（#203/#204）。
- 结果：`adapter` 599、`run-attempt` 597、`prompt-text` 597、`pool` 598（均 < 600，无 ratchet）。


## 重复实现（比体积更该处理）

- **`delay(ms[, signal])` 在 13 个文件里各写一遍**（`host/models`、`host/services`、`quota/freshness`、`acp/pool`、`acp/run-attempt`、`warmup/schedule`、`provider/mapper/event-mapper`、`provider/retry-policy`、`provider/failover-budget`、`common/pool-types`、`domain/quota/identity`、`client/mermaid-render`、`translation/service`）。多数是 `new Promise(r => setTimeout(r, ms))`，但**并非全部等价**（部分带 `AbortSignal` 且 abort 后 resolve 而非 reject）。
  - 收敛到 `src/common/async.ts` 的正确做法：先逐个确认语义（是否接受 signal、abort 后 resolve/reject、`ms <= 0` 是否立即返回），再统一；**不要**一次性替换成"最像的那个"。
  - 优先级：中。属于一致性收益，不是缺陷。

## 2026-11-27 新增

- `src/provider/prompt.ts`（596 → 578 → **420**）：先抽出 `clearStaleFamilyModelBindings` → `stale-model-bindings.ts`，随后把绑定解析整体抽成 `prompt-binding.ts`（`resolvePromptBinding` / `ResolveBindingInput` / `ResolvedPromptBinding`，以及计划依赖契约 `PromptPlanDeps`、`ActiveRunView`——后者由 `prompt.ts` 再导出，依赖只朝一个方向，避免成环）。提示词组装与绑定生命周期自此是两个模块。
- 教训（本轮连踩两次）：`prompt.ts` 与 `prompt-text.ts` 都贴在 599/596 行，**往这两个文件里加任何逻辑之前先看行数**，新职责直接另起模块。
