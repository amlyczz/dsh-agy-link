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
- **`/pool/refresh-quota`（非阻塞立即确认 + 按账号去重 + 真实进度）**：立即返回 `{ ok: true, pending: true, alreadyRunning, pool }`，后台通过 `quotaRefreshInFlight` 去重执行并在数据或模型变化时广播选择器更新，控制台 3s 轮询自动带出最新额度。
  - `alreadyRunning: true` 表示**同 key 刷新仍在途**，本次点击不会新建管线；客户端据此提示「正在刷新中」而不是谎报「已开始刷新」（旧行为让用户在去重窗口内反复点击却毫无反馈）。
  - 刷新中的账号 id 由 `/status.quotaRefreshing`（`QuotaService.refreshingAccounts()`）透出，账号卡据此渲染真实的「同步中」；不再由客户端点击状态推导（POST 一返回就清空，长级联期间毫无进度）。
- **`/translate` 与 `/pool/warmup`（长任务 deadline 对齐）**：
  - `/translate` 宿主路由使用 `longRouteTimeout(cfg.translateTimeoutMs)`。
  - `/pool/warmup` 宿主路由使用 `longRouteTimeout(WARMUP_WRITE_TIMEOUT_MS)`，客户端 `postPool('warmup', ...)` 传入 `WARMUP_WRITE_TIMEOUT_MS`，彻底消除多账号 CLI 预热期间客户端提前 20s abort 或宿主 30s 误返 504。

## 3. 测试锚点

- `test/route-guard.test.ts`：`runRoute` 异常 → 500、挂起 → 504、单次响应写头保护、常量顺序与 `timedSignal` 触发。
- `test/http-contract.test.ts`：`refresh-quota` 秒回与连点去重、长耗时 `/translate` 与 `/pool/warmup` 跨 30s 正常返回 200。
- `test/client-api.test.ts`：所有客户端请求均带 `AbortSignal`。
