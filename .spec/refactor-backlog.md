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
| `src/features/translation/service.ts` | 599 | 请求组装 / 结果归一 可分离 | 待办 |
| `src/features/subagent/tracker.ts` | 599 | 日志尾部跟随与状态机可分离 | 待办 |
| `src/features/background/watcher.ts` | 599 | 定时器调度与唤醒判定可分离 | 待办 |
| `src/features/acp/pool.ts` | 599 | 驱逐策略（`shouldEvict` 一族）可独立 | 待办 |
| `src/features/acp/client.ts` | 599 | JSON-RPC 帧收发可独立 | 待办 |
| `src/client/sections/AccountsPanel.ts` | 599 | 配额条 / 模型子列表渲染可分离 | 待办 |
| `src/host/adapter.ts` | 598 | 绑定（binding）读写可独立 | 待办 |
| `src/domain/credentials/slot.ts` | 598 | 平台差异分支可独立 | 待办 |

**为什么记下来而不是一次全抽**：这几处分别属于 ACP、凭证、宿主调度三条高风险链路；一次性大改会让回归范围失控。按上表逐个推进，每次只动一个概念。
