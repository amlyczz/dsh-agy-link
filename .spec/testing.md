# 测试策略与门槛（唯一事实源）

> 维度：**测试如何分层、按什么边界组织、什么算门禁**。目录职责表在 [../test/README.md](../test/README.md)，这里只写规则与命令。

## 1. 两级双环

| 环 | 何时 | 命令 | 目标耗时 |
| --- | --- | --- | --- |
| 内环（TDD 极速） | 每次改代码 | `npm run test:fast` / `npm run test:fast -- <关键字>` | 0.3–3s |
| 外环（回归门禁） | 提 PR / 发 tag / 大重构后 | `npm test` | 全量 |

`test:fast` 按 Git 变更映射到相关测试（`scripts/fast-test.mjs` 的 `COMPONENT_TEST_MAP` / `PREFIX_TEST_MAP`），并支持按关键字跨目录挑选、`--all` 跑全量文件。改动映射表时**必须**同时改源码路径与测试路径。

## 2. 领域划分（结构即契约）

测试目录**镜像 `src/` 的分层**：`common` / `domain` / `runtime` / `provider` / `host` / `transport` / `client` / `features/<子域>`，跨层回归进 `integration/`。

规则：

1. 新测试落**被测代码所属层**的目录；只有同时断言 ≥2 层协作的用例才进 `integration/`。
2. 单文件预算 ~600 行；超了就按行为切分，共享夹具抽到 `test/helpers/`。
3. 命名 `<被测对象>.test.ts` 或 `<issue>-<主题>.test.ts`；领域目录内不重复领域名前缀。
4. 任何写盘测试必须走 `test/helpers/sandbox-env.ts` 隔离 `HOME` / 账号池，禁止触碰真实 `~/.dsh`。
5. 新增目录要在 [../test/README.md](../test/README.md) 登记职责。

## 3. 门禁

| 门禁 | 命令 | 覆盖 |
| --- | --- | --- |
| 类型 | `npm run check` | `tsc --noEmit` |
| 架构方向 | `npm run lint:arch` | 分层依赖方向（`src/**`） |
| 单文件预算 | `npm run lint:budget` | 每文件 ≤600 行 |
| 构建 | `npm run build` | tsdown 产物 |
| 全量回归 | `npm test` | `test/**/*.test.ts` |
| 覆盖率 | `npm run test:coverage` | 行 85% / 分支 80% / 函数 80% |

`npm run verify` = check + arch + budget + build + test，是发版前的最小完整集合。

## 4. 反模式

- **禁止**在红绿循环里直接跑 `npm test`（1100+ 用例，反馈太慢）——用内环。
- **禁止**为通过测试而放宽断言或加 `skip`；失败先判断是回归还是用例过期，再改一边。
- **禁止**在 `client/` 里用源码字符串匹配代替真实渲染断言（已有 `helpers/client-render.ts` 的 SSR 渲染可用）。
- **禁止**在测试里复制实现逻辑（例如把状态机判据重写一遍）；断言行为与不变量，不对内部结构做镜像。
