# 重构待办（临界模块）

`npm run lint:budget` 的上限是 **每文件 600 行**。下面这些模块长期贴着上限：每次新增行为都要靠**删注释**腾出空间，这是职责过多的信号，而不是"还差几行"。

维护规则：
- 新增功能若让任一文件超过上限 → **不要加 ratchet 豁免**，先把一处**无状态职责**抽成独立模块。
- 抽取顺序按"纯函数 → 无状态分支 → 有状态协作"进行，避免一次动多个概念。
- 每次抽取后 `check`/`lint:budget`/`build`/`test` 必须全绿，行为不变（已有测试即回归网）。

## 2026-11-24 扫描（342 模块 / 67,894 行 / 0 环 / 0 方向违规）

| 模块 | 行数（抽取前） | 可抽出的职责 | 状态 |
| --- | --- | --- | --- |
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
