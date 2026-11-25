# HTTP 请求与忙碌状态（唯一事实源）

> 维度：**请求生命周期**。只回答一件事：一次点击之后，HTTP 响应和 UI 忙碌状态凭什么一定会结束。

## 1. 核心不变式

1. **任何路由都必须恰好响应一次**（成功 / 4xx / 500 / 504），且响应有硬上限。
2. **任何客户端请求都必须携带超时信号（`timedSignal`）并 settle**，让 `finally` 必然释放 busy / inflight 状态（含 `client/api.ts` 与 `client/translate-state.ts`）。
3. **任何 UI busy 标记都不能超过超时上限 + 宽限**（`useBusyAction` watchdog 兜底，卸载时清理 timer）。
4. 超时常量**唯一定义处**：`src/common/timeouts.ts`（`STATUS_TIMEOUT_MS < WRITE_TIMEOUT_MS < ROUTE_TIMEOUT_MS`）。

| 常量 | 值 | 用途 |
| --- | --- | --- |
| `STATUS_TIMEOUT_MS` | 5s | 3s 轮询的 `/status` GET |
| `WRITE_TIMEOUT_MS` | 20s | 常规写操作 POST |
| `WARMUP_WRITE_TIMEOUT_MS` | 90s | 客户端手动预热请求超时（覆盖多模型/多账号 CLI 探针） |
| `ROUTE_TIMEOUT_MS` | 30s | 宿主常规路由硬 deadline |
| `ROUTE_DEADLINE_SLACK_MS` | 15s | 长任务路由宽限 `longRouteTimeout(jobMs) = max(30s, jobMs + 15s)` |
| `QUOTA_REFRESH_DEDUP_MS` | 90s | 手动额度刷新后台去重硬上限 |
| `QUOTA_ENDPOINT_DOWN_MS` | 10min | 配额端点失败记忆（置后，不丢弃） |
| `QUOTA_LICENSE_RETRY_MS` | 6h | `no_license` 账号的后台摘要静默期（手动不受限） |
| `QUOTA_FORCE_CONCURRENCY` | 2 | 手动全池刷新在**同一出口内**的并发上限（后台恒为 1） |

## 2. 长耗时操作策略

- **`/plugins/agy-link/status` 条件缓存与后台节流**：
  - 服务端生成弱 `ETag`；当请求携带匹配的 `If-None-Match` 时返回 `304 Not Modified`（零响应体开销），未携带时正常返回 `200 application/json; charset=utf-8`。
  - 客户端 `status.ts` 采用单飞请求合并与递增序号防旧包倒灌，页面隐藏（`document.hidden`）时暂停高频轮询，切回前台或收到 `llm/models-updated` / `llm/adapters-updated` 时立即触发同步。
- **`/pool/refresh-quota`（非阻塞立即确认 + 按账号去重 + 真实进度 + 目录解耦）**：立即返回 `{ ok: true, pending: true, alreadyRunning, pool }`，后台通过 `quotaRefreshInFlight` 去重执行并在数据或模型变化时广播选择器更新，控制台 3s 轮询自动带出最新额度；后续 `triggerCatalogWarm()` 以后台方式异步触发 `catalog.warmAccounts()`，不再阻塞 `quotaRefreshInFlight` 的锁释放。
  - `alreadyRunning: true` 表示**同 key 刷新仍在途**，本次点击不会新建管线；客户端据此提示「正在刷新中」而不是谎报「已开始刷新」（旧行为让用户在去重窗口内反复点击却毫无反馈）。
  - 刷新中的账号 id 由 `/status.quotaRefreshing`（`QuotaService.refreshingAccounts()`）透出，账号卡据此渲染真实的「同步中」；不再由客户端点击状态推导（关闭弹窗重开不丢态）。
- **`/lease/acquire`（有界等槽）**：等槽时长由注册表内部的 `waitMs` 截止时间约束（默认 `dispatchTimeoutMinutes × 60000`，上限 1 小时，到点 `504 slot_timeout`）；路由兜底 deadline 为 `longRouteTimeout(1h)`。若兜底先应答，之后才拿到的租约立即释放，不留孤儿槽持有者。
- **`/pool/warmup`（非阻塞后台作业 + 去重 + 宿主态进度）与 `/translate`（长任务 deadline）**：
  - `/translate` 宿主路由使用 `longRouteTimeout(cfg.translateTimeoutMs)`。
  - `/pool/warmup` 立即返回 `{ ok: true, pending: true, alreadyRunning, warmupState, pool }`，宿主通过 `warmupInFlight` 去重执行（`WARMUP_DEDUP_MS = 180_000`），成功唤醒的账号立即单号刷新配额；`/status.warmupState` 实时透出 `running`、`totalAccounts`、`completedAccounts`、`currentAccountId`、`currentAlias`、`lastRun` 等快照，使客户端关闭/重开管理弹窗仍可持续展示预热转圈与上次摘要，并彻底消除 `useBusyAction` 25s 提前报错与长 CLI 预热阻塞。

## 3. 测试锚点

- `test/transport/route-guard.test.ts`：`runRoute` 异常 → 500、挂起 → 504、单次响应写头保护、常量顺序与 `timedSignal` 触发。
- `test/transport/http-contract-*.test.ts`：`refresh-quota` 秒回、连点去重与 `catalog.warmAccounts` 非阻塞解耦；`/pool/warmup` 异步秒回、`warmupInFlight` 去重与 `/status.warmupState` 透出；长耗时 `/translate` 正常返回 200。
- `test/client/client-api.test.ts`：所有客户端请求均带 `AbortSignal`。
