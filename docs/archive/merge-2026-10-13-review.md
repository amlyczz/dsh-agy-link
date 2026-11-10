# 2026-10-13 两线合并评审清单

本次会话把「上游 main 线」与「被舍弃的工作区快照」两条分叉合并为一个可构建、可测试的状态。
本文是一次性评审依据：逐项列出**做了什么取舍、为什么、怎么改回去**。

## 1. 背景与根因

1. 你记忆里「已经修好」的 Windows 凭据隔离 + 客户端增强，**从未提交、从未推送**——它只存在于
   `D:\proj\dsh-agy-link` 的未提交工作区里（v0.4.44 草案，2026-10-03 起草）。
2. `origin/main`（v0.4.46）**只包含那条警告横幅的披露逻辑**，没有任何真实隔离实现：
   - `src/client/locales.ts` 的 `pool.winIsolationWarn` 文案
   - `src/index.ts` 的 `credentialIsolationLimited` 状态字段
   - `src/host/adapter.ts` 的 `warnOnce` 日志
   - 全仓库没有 `src/host/wincred.ts` / `src/host/credential-slot.ts`
3. 运行中的 GUI 通过 **Junction** 直接吃本目录的 `dist/`：
   `C:\Users\zand\.dsh\profiles\desktop\node_modules\dsh-agy-link -> D:\proj\dsh-agy-link`。
   清理工作区 + `pnpm install` 触发 `prepare: npm run build` 后，`dist/` 由**上游源码**重建，
   于是界面从「你的版本」切成了「上游版本」：横幅出现、样式回退。**源码一份没丢**。

## 2. 三方对象

| 角色 | 引用 | 内容 |
| --- | --- | --- |
| 基线（第一父） | `main` = `b29e29b` | 上游 0.4.46（含 20 个提交） |
| 你的工作区快照（第二父） | `recovered/local-afternoon` = `b26271e` | 0.4.44 草案，+9452 / −80 |
| 合并结果 | `merge/restore-afternoon` | `140d257` 起的合并提交 |

相对 `main` 的净变更：**28 个文件、+3401 / −76**；新增 11 个文件：

```
.npmrc                              scripts/repair-pool.mts
scripts/verify-credential-store.mts src/client/decisions.ts
src/client/images.ts                src/host/credential-slot.ts
src/host/media-route.ts             src/host/wincred.ts
test/client-enhancers.test.ts       test/credential-slot.test.ts
test/media-route.test.ts
```

## 3. 十处冲突的落定

| # | 文件 | 处理 | 理由 | 想改回去 |
| --- | --- | --- | --- | --- |
| 1 | `CHANGELOG.md` | 两边全保留；你的 0.4.44 草案提为顶栏 **0.4.47** 并加合并说明 | 历史不丢、本次发布有说明 | 直接编辑 |
| 2 | `package.json` | 取 main（**不加 `mermaid` 依赖**），版本 bump `0.4.47` | 上游改为内置 `assets/mermaid.min.js`，不需要 npm 依赖 | 加回依赖 |
| 3 | `assets/mermaid.min.js` | 取 main（3.57 MB 官方构建） | 与 main 的 `/plugins/agy-link/mermaid.min.js` 路由匹配 | 换回你的 4.37 MB 版 |
| 4 | `src/client/mermaid.ts` | 取 main（337 行，无 CDN 回退 + 错误炸弹清理 + `ctx.effect` 生命周期） | 你的 598 行版本已被上游同类修复覆盖 | 恢复快照文件 |
| 5 | `src/client/toolview.ts` | main 的 i18n `tv.delete` + 你的 `question` / `image` 卡片类型 | 两边都是增量，可兼得 | 直接编辑 |
| 6 | `src/client/index.ts` | main 的 `ctx.effect` 安装器 + 你的图片/决策增强（**已补真实 disposer**） | 保留 main 的重载不叠加 observer 契约 | 直接编辑 |
| 7 | `src/host/quota.ts` | main 的**异步** Windows 凭据读取 + 你的「持久存储优先」主账号解析；刷新写盘保留你的保形 `doc` 并补 main 的 `0600` | 你那份 `execFileSync` 会让事件循环冻结（上游专门修过）；你的持久库逻辑是防串号关键 | 直接编辑 |
| 8 | `src/host/runner.ts` | 取 main（`nodeScriptEnv` / `ELECTRON_RUN_AS_NODE`） | 同上问题上游已有更完整修复 | 直接编辑 |
| 9 | `test/mapper.test.ts` | **两边用例全保留**（#43 思考横幅 + 你的图片重写） | 两者互不冲突 | 无需 |
| 10 | `test/proxy-keychain.test.ts` | 取 main | 与 main 的 kill 升级语义一致 | 恢复快照版 |

## 4. 语义变更（你已确认）

1. **删除 `credentialIsolationLimited` 警告**：状态字段、adapter `warnOnce`、设置面板横幅、
   四语言文案全部移除。理由：凭据槽交接恢复后轮巡是真隔离，横幅已是假陈述。
   `docs/KNOWN-GAPS.md` 改写为「已实现交接 + 剩余边界」。
2. **`node:test` 下跳过真实凭据槽**（检测 `NODE_TEST_CONTEXT`）：你的严格拒绝语义与上游
   「额度耗尽自动转移账号」测试在 Windows 上互斥；若不跳过，`pnpm test` 会往**真实凭据管理器**
   写测试凭据。生产的严格语义（`SlotUnavailableError`：无法验证主账号 / 副账号无凭据 /
   同一授权）**完整保留**；`test/credential-slot.test.ts` 仍通过注入 IO 直测交接逻辑。

## 5. 被取代或删除的内容（知情项）

| 内容 | 去向 | 说明 |
| --- | --- | --- |
| `src/client/mermaid.ts`（你的 598 行） | 未进入合并 | 上游同类修复已覆盖（`MERMAID_CSS` 抑制 + `cleanupTempElements` 清扫） |
| `test/client-enhancers.test.ts` 内 5 个 mermaid 用例 | 已删除 | 随上一条；保留图片相关用例 |
| `quota.ts` 中经 `wincred` 的同步 CredRead | 改用 main 异步实现 | `wincred.ts` 仍用于槽交接与系统代理探测 |
| 4 条 `pool.winIsolationWarn` 文案 | 已删除 | 横幅移除后成为死数据 |

## 6. 保留清单

**来自 main（上游）**：适配器 spawn 窗口槽位归属 try/finally、异步钥匙串/凭据管理器读取、
桌面端思考可见性 #43、内置 mermaid 渲染器（无 CDN）、模型可见性开关、`prepare` 构建、
账号池/数据加固、`docs/KNOWN-GAPS.md` 框架。

**来自你的快照**：`credential-slot.ts`（持久主凭据库 + 身份校验 + 进程级 FIFO 互斥 +
`SlotUnavailableError`）、`wincred.ts`（CredRead/CredWrite/CredDelete + WinINet 代理探测）、
`media-route.ts` + `images.ts` + `decisions.ts`（本地图片路由 / 灯箱 / 决策芯片）、
`repair-pool.mts`、`verify-credential-store.mts`、`.npmrc`、`.gitignore` 的 `Microsoft/`、
以及 4 个测试文件（`credential-slot` / `media-route` / `client-enhancers` / `mapper` 图片用例）。

## 7. 验证

```
pnpm run check   -> exit 0（0 错误）
pnpm run build   -> exit 0（dist/client.js 187KB、dist/index.js 1.32MB、dist/assets/）
pnpm test        -> exit 0（31 个测试文件、328 用例通过、0 失败）
```

`dist/` 已由合并后的源码重建。

## 8. 生效方式与后续

- **客户端半**：刷新页面即生效——`dist/client.js` 中已无 `win-isolation` 渲染，横幅不会再出现。
- **宿主半**：需要**重启 DSH / 重载插件**。当前 `GET /plugins/agy-link/status` 仍返回
  `credentialIsolationLimited`，证明运行中的宿主进程还是旧代码；宿主半决定凭据交接是否真的生效。
- **未做**：没有 `push`、没有打 tag、没有发布（遵循 AGENTS.md：发布需你显式下令）。
- **已知边界**：凭据槽互斥锁是**进程级**的——web 与 headless 同时驱动 agy 仍有交叉写风险；
  Windows 上建议 `maxConcurrent=1`，并避免两个宿主同时跑。彻底解决需上游 agy 按 HOME 命名 keyring。
