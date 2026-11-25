# test/ — 按领域分层的测试树

测试目录**镜像 `src/` 的分层架构**：一个领域目录只放该领域的行为测试。新增测试先找领域目录，再落文件；跨层回归用例才进 `integration/`。

## 目录职责

| 目录 | 覆盖对象 | 对应源码 |
| --- | --- | --- |
| `common/` | 纯规则与纯类型：错误分类、诊断文本、配置合并、原子写、模型 slug | `src/common/` |
| `domain/` | 业务领域：账号资格/轮换顺序、模型能力、配额桶、计划档位、模型列表 | `src/domain/` |
| `runtime/` | 本地运行时：agy 数据库、进程/平台差异、OAuth 与钥匙串、自更新抢占 | `src/runtime/` |
| `provider/` | DSH ↔ agy 适配层：attempt/finalize、失败分类、mapper、mirror、上下文移交、压缩 | `src/provider/` |
| `host/` | 宿主服务：账号池、配额轮询、模型目录、会话、MCP 桥、启动维护、外部租约 | `src/host/` |
| `transport/` | HTTP 表面：路由契约、请求体上限、route guard、媒体/租约路由 | `src/transport/` |
| `client/` | 浏览器端：DOM 增强器、React 分区、toolview 卡片、i18n、滚动守卫、浮层隔离 | `src/client/` |
| `features/acp/` | ACP 传输与进程池 | `src/features/acp/` |
| `features/translation/` | `/tsl` 翻译服务与命令 | `src/features/translation/` |
| `features/quota/` | 配额采集与额度门控 | `src/features/quota/` |
| `features/warmup/` | 预热策略与调度 | `src/features/warmup/` |
| `features/background/` | 后台任务与唤醒 | `src/features/background/` |
| `features/subagent/` | 子代理活动追踪 | `src/features/subagent/` |
| `features/image/` | 生图服务与 CLI | `src/features/image/` |
| `features/btw/` | `/atw` 旁路问答 | `src/features/btw/` |
| `features/ecosystem/` | 生态面板与同步 | `src/features/ecosystem/` |
| `integration/` | 跨层回归：issue 编号套件、阶段快照、端到端组合（`lifecycle`、`v02`、`phase2-*`、`orchestrator-settings`） | 多个层 |
| `helpers/` | 测试基建：`client-render.ts`（React SSR shim）、`sandbox-env.ts`（隔离 HOME/env）、`paths.ts`（目录常量，唯一的路径计算入口）、`adapter-fixtures.ts`（adapter 套件共享夹具） | — |
| `fixtures/` | 录制/回放数据 | — |

## 约定

1. **命名**：`<被测对象>.test.ts`，或 `<issue 编号>-<主题>.test.ts`。领域目录里不重复写领域名（`host/pool.test.ts`，不是 `host/host-pool.test.ts`）。
2. **导入深度**：`test/<domain>/<file>.test.ts` 用 `../../src/...`；`test/features/<sub>/<file>.test.ts` 用 `../../../src/...`。
3. **单文件预算**：超过 ~600 行就按行为切成多个文件（同一领域目录内），共享夹具提取到 `test/helpers/`。禁止为了省事把无关行为塞进同一个 `describe`。
4. **隔离**：任何写盘的测试必须用 `sandbox-env.ts`（隔离 HOME/池目录），不得触碰真实 `~/.dsh`。
5. **两级双环**：日常 `npm run test:fast`（内环，秒级）；提 PR / 发版跑 `npm test`（外环，全量）。

## 运行与门槛

命令、两级双环节奏与门禁见 [../.spec/testing.md](../.spec/testing.md)。单文件直跑：

```bash
node --experimental-transform-types --test test/host/pool.test.ts
```
