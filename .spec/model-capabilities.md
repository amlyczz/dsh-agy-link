# 模型能力、目录发现与切号实时同步（唯一事实源）

> 维度：**插件如何发现模型与推理档位、如何在切换账号时让 DSH 会话框模型选择器毫秒级准确更新，以及当 agy 拒绝时如何自愈**。

## 1. 能力与阵容唯一定义处（0 冗余）

| 关心的事 | 唯一定义 | 派生方 |
| --- | --- | --- |
| 档位词表（level、显示名、后缀切分） | `src/common/reasoning.ts` | `models.ts` 折叠、`model-resolution.ts` 菜单、`config-options.ts` 下拉、`ask-tool.ts` |
| 具体模型 id（默认选谁、离线阵容） | `src/common/model-lineup.ts` | `config.ts` 默认值、翻译/生图/预热/跨族兜底、`resolveModelSlug` |
| 模型列表与真实档位 | `agy models`（及配额 `agentModelSorts` 辅助） | `listModels`、`/plugins/agy-link/status.catalogModels`、`/plugins/agy-link/status.accountModels`、`/agy models` |
| 单账号模型展示收敛（0 冗余） | `buildAccountModelRows()`（`src/common/account-models.ts`） | 账号卡片展开列表（优先该账号真实发现目录 `accountModels[acc.id]`，回退折叠 `-tiered`/档位后缀、过滤 `-sonar`/`-image`、按名称去重；未知余量不伪造 `100%`） |

当前基准阵容（`agy >= 1.5.15`）：`gemini-4-neon`（low/medium/high/xhigh[Extra]）、`gemini-4-carbon`（low/medium/high，Pro/Ultra）、`gemini-4-argon`（low/medium/high）、`gemini-4-hydrogen`（low/medium/high/xhigh[Extra]，全用户开放）、`gemini-pro-orchestrator-neon`、`gemini-pro-orchestrator`（Orchestrator (Carbon)）、`gemini-pro-orchestrator-argon`、`gemini-3.8-flash`（low/medium/high）、`claude-opus-5-5`（low/medium/high）、`claude-sonnet-5-5`（low/medium/high）、`gpt-oss-120b-medium`。已下线型号（`claude-*-4-6*`）不进入默认兜底目录。

## 2. `agy models` 静默未登录兜底识别（issue #122 根治）

`agy models` 在未登录或 `loadCodeAssist` 网络失败时，仍以 `exit 0` 输出内置旧版静态列表（含已下线的 `claude-sonnet-4-6` 与 `claude-opus-4-6-thinking`，且缺少 Gemini 4 系列），并在 stderr/log 打印 `Auth mode is unspecified` 或 `failed to get model config`。

- `isUnauthenticatedModelsFallback(stdout, stderr)`（`src/domain/models/parse.ts`）识别此类伪发现结果，**严禁将其标为 `source: 'discovered'`**，而是记入 `lastError` 并保持 `'fallback'`，避免用假目录否决 Pro/Ultra 账号真实的 Gemini 4 Hydrogen / Argon 权限。
- 当显式传入 `accountId` 探测单账号目录而该账号缺失、已停用或处于 `authRequired` 时，必须直接失败返回，**严禁回退借用主账号或当前活跃账号代探并将结果写入 `accountId`**；`POST /plugins/agy-link/pool/refresh-quota` 单账号同步时显式传 `catalog.forceRefresh(id)`，全量同步与选号自愈（`refreshQuota`）同步触发 `catalog.warmAccounts()`；全局 `forceRefresh()` 发现成功时同步将结果归属写入实际被探测的 `probedAccount.id` 账号目录，防止全局目录已列出模型而该账号 `accountCatalogs` 仍为空。
- **CLI 虚拟编排模型（`gemini-pro-orchestrator-neon` / `gemini-pro-orchestrator` / `gemini-pro-orchestrator-argon` / `gemini-pro-orchestrator-g1-pro`）与 `-xhigh`/`-tiered-*` 后缀兼容**：Google REST 配额接口（`fetchAvailableModels`）只返回底层模型（`gemini-4-neon-*`、`gemini-4-carbon-*`、`gemini-4-argon-*`）而不包含 CLI 编排 slug；`accountSupportsModel()` 在单账号目录尚未预热或陈旧时，允许分别凭 `gemini-4-neon`、`gemini-4-carbon` 配额证据与 `accountHasArgon` 判定可用性，避免 Pro/Ultra 账号误报 `lack model "gemini-pro-orchestrator*"`。
- **持久化磁盘缓存（`<stateDir>/model-catalog.json`）**：`ModelCatalog` 将已发现的全局与分账号目录连同 `agyVersion` 与 `discoveredAt` 原子落盘；宿主冷启动时 0ms 同步水合真实模型列表（若 `agy --version` 升级则自动失效重探），`warmAccounts()` 自动跳过仍在 `ttlMs` 有效期内的已缓存账号并在剩余未缓存探测间保持随机错峰抖动。
- Windows 下对隔离辅账号执行 `agy models` 时必须受 `acquireCredentialSlot` 保护，防止读取到系统槽内主账号的模型清单张冠李戴（issue #108/#109）。

## 3. Argon 与套餐权限判定优先级（`accountHasArgon` 与 `getAccountCatalog`）

1. 当单账号自身已完成 `agy models` 真实探测（`getAccountCatalog(acc.id)?.source === 'discovered'`）时，`getModelsForAccount` 直接返回该账号自身目录（0 串染）；未探测账号通过 `getAccountCatalog` 严格返回 `undefined`，绝不借用其他账号的 `this.current`。
2. 当单账号尚未完成 `agy models` 探测时，`accountHasArgon(acc, pool, catalog)` 按优先级判定：
   - `acc.quotas?.argon !== undefined` → `true`
   - `pool?.hasDedicatedGroup(acc.id, 'argon')` → `true`
   - `acc.quotas?.google?.models?.some(isArgonModel)` 或 `isArgonModel(acc.quotas?.google?.description)` → `true`
   - 若 `acc.quotas?.google?.models` 已枚举单模型列表且不含 Argon（免费层特征）→ `false`（防止共享 `this.current` 污染免费号）
   - 否则若 `catalog?.source === 'discovered'`（如无单模型明细的共享池，issue #68）→ 以 `catalog.models` 是否含 Argon 决定；`DedicatedGroupSource.catalogForAccount` 通过 `explainIneligibility`、`PoolAdmin` 与 `getPoolData` 透传给选号与可用账号解析。
3. **`t=0ms` 切号即时 Argon 投影**：当 `this.current` 来自免费号（不含 Argon），而用户刚切到具备 Argon 额度的 Pro/Ultra 账号且后台 `agy models` 尚未返回时，`getModelsForAccount` 在 `t=0ms` 即刻合并已知 Argon 条目。

## 4. 切换账号 → DSH 会话框模型选择器实时同步闭环

### 4.1 DSH 客户端缓存机制与双事件广播
DSH 前端 `ModelCatalogDirectory.load()` 在首次加载（`status === 'ready'`）后**永久返回内存快照**，打开会话底栏模型下拉框不会主动请求宿主；唯有宿主通过 Cordis 事件经 WebSocket 推送，才会触发 `ModelCatalogDirectory.refresh() -> session.modelCatalog() -> adapter.listModels() + resolveModelInfo()`。

因此 `notifyPicker()`（`src/host/services.ts`）同时发出：
- `ctx.emit('llm/models-updated', PROVIDER_ID)`（DSH 0.2.2+ 轻量级模型目录刷新事件）
- `ctx.emit('llm/adapters-updated')`（兼容旧版宿主与适配器拓扑刷新）

### 4.2 单一事件源与全路径覆盖（0 遗漏、0 重复 spawn）
1. **按账号独立 single-flight 刷新**：`ModelCatalog` 使用 `Map<accountKey, Promise<void>>` 替代全局单一 `refreshing` 锁，确保账号 A 的慢探测绝不吞掉切到账号 B 时的目录刷新；变更检测同时比对 `id`、`name` 与 `efforts`。
2. **收口于 `pool.onAccountSwitch`**：
   - `setActiveAccount`、`setPrimaryAccount`、`reorderAccounts`、`advanceAccount`、`PoolAdmin.recordFailure`（429 自动切号）、`selectAccount`（含首次从 `undefined` 选定活跃号）、`deleteAccount`、`setAccountEnabled`、`clearCooldown` 凡引起有效活跃账号变化，统一触发一次 `onAccountSwitch`（立即 `notifyPicker()` 切换已有缓存视图 + 异步 `forceRefreshAndNotify(newId)` 补齐最新目录），HTTP 路由层不再重复调用第二次 `forceRefreshAndNotify`。
   - **OAuth 登录 / 重登 / 导入必刷新**：`PoolAuthFlow.finishWithCode`（全部三个分支：新账号、重认证、主账号）与 `importRefreshToken` 完成后均触发目录刷新与 `notifyPicker()`。
   - **配置与 CLI 命令同步**：`/config` 修改影响可见模型集合的键（`hiddenModels`、`poolWideCatalog`、`enabled`，其中 `enabled` 通过 `AdapterRegistrationHandle.replace()` 动态挂载/卸载路由）以及 `/agy` 账号管理子命令（含 `/agy use <id>`、`/agy effort`）均同步调用 `notifyPicker()`；不影响 `listModels()` 列表集合的键（如 `defaultEffort`、`translateModel`）保持静默（遵循 `test/transport/http-contract-*.test.ts` 与 `test/integration/lifecycle.test.ts` 契约）。

### 4.3 按模型族作用域与手动切号优先于同族旧会话粘性（`manualPinAtByFamily`）
- 账号池活跃指针、冷却与预热严格按**模型族**（`google` Gemini / `argon` Argon / `anthropic` Claude / `openai` GPT-OSS）隔离：
  - `setActiveAccount(id, family)`、`markAccountActive(id, family)`、`advanceAccount`、`selectAccount` 与 `/pool/set-active` 默认严格按模型族作用域隔离，不越界覆写其他模型族的当前账号；`/agy use <id> [family]` 支持指定模型族（默认 `google`）。
  - **共享组双向联动例外（`argonSharesGoogleGroup(acc)`）**：当 `acc.quotas?.argon` 缺省且 `acc.quotas?.google?.description` 显式列名 Argon（`agy 1.5.15+` 折叠进 `Gemini Models` 组）时，该账号上的 `google` ↔ `argon` 活跃指针、`manualPinAtByFamily`、冷却与 `stickyAccount` 双向同步（除非 `activeAccountIds.argon` 当前指向一个拥有独立 `quotas.argon` 的账号）；拥有独立 `quotas.argon` 的账号仍严格保持按族隔离。
  - `recordFailure()` / `advanceAccount()` / `updateAccountQuotas()` 对主动指针的轮换或自愈均按模型族边界校验（`lastActiveAccountId` 仅服务 `google` 族兜底，绝不跨族劫持 `argon` / `anthropic` / `openai`）。
  - `getPoolData().resolvedActiveAccountIds` 预计算每个模型族当前真正命中的可用账号 ID，UI 将「当前使用」「设为当前」「冷却中」「清除冷却」直接嵌入对应模型族分组内，消除账号级冗余状态标签与横幅。
- `selectSessionAccount()` 中：
  - `stickyAccount()` 仅在会话上次绑定模型属于同一 `modelFamilyOf(b.model)` 时复用同族粘性账号（例如会话 A 选 `gemini-pro-orchestrator-neon` 在 `google` 池内轮换，会话 B 选 `gemini-4-argon` 在 `argon` 池内独立轮换，互不串扰）。
  - 若用户对该模型族显式切号发生在旧会话绑定更新时间之后（`Math.max(manualPinAt, manualPinAtByFamily[family]) > binding.updatedAt`），该同族会话**立即跟随用户新选账号**，不再被旧会话亲和拉回；且 `stickyAccount` 命中旧会话亲和时**绝不反向覆写全局其他族的 `activeAccountIds`**（`lastActiveAccountId` 亦受 `family === 'google' || !lastActiveAccountId` 守卫）。
- `syncSessionModel()` 兼容 `dsh-agent` 真实接口 `(await ctx.agents.resolve(sessionId))?.model?.select(...)` 与持久事件追加。

## 5. `--effort` 档位拒绝自愈（issue #67 / #115）

- 当模型拒绝 `--effort` 时，`streamWithEffortRetry()` 自动去掉 `--effort` 无感重放一次。
- 仅当已发现的实时目录未声明该模型支持档位（`catalogAdvertisesEffort(model) === false`）时，才写入 `effort-unsupported.json` 并广播 `notifyPicker()`（避免 `loadCodeAssist` 瞬时超时造成永久误学，issue #115）。

## 6. Orchestrator 上下级模型与思考档位（issue #174）

- 自 `agy 1.5.14` 起，命令行 `agy --settings '{"orchestrator":{"planner":"<tiered-slug>","executor":"<tiered-slug>"}}'` 支持为编排器角色模型（`gemini-pro-orchestrator*`）分别覆盖上级（Planner）与下级（Executor）模型及各自思考档位。`agy acp` 没有 `--settings` 入参，但启动时读取 `<home>/.gemini/antigravity-cli/settings.json`（与 `--settings` 同一套 key），因此编排器覆盖现在**写入该文件**而不是绕开 ACP（issue #204）。
- **唯一格式化与合并源（`src/common/orchestrator.ts`）**：`isOrchestratorModel()`、`resolveOrchestratorRoleSlug()`（保留 `gpt-oss-120b-medium` 等无独立档位枚举模型后缀、剥离其余已有档位后再拼接 `<base>-<effort>`）、`buildOrchestratorSettingsObject()` 与 `mergeOrchestratorIntoAgySettings()`（合并进现有内联 JSON 或文件路径型 `agySettings` 的 `orchestrator` 对象，不覆盖无关字段）。
- **角色白名单（issue #204）**：`agy 1.5.15` 的 `orchestrator-model-roles` 固定为 Planner = `gemini-4-neon` / `gemini-4-carbon` / `gemini-4-argon` / `claude-opus-5-5`，Executor = `gemini-4-hydrogen` / `claude-sonnet-5-5`。`ORCHESTRATOR_ROLE_MODELS` + `isOrchestratorRoleModel()` 是唯一判据，设置页两个下拉分别过滤；`/agy-btw` 下拉不受角色限制（它跑普通聊天模型）。
- **生效路由**：仅当当前会话模型命中 `isOrchestratorModel()` 且配置了至少一个上级/下级模型时，`resolveEffectiveAgySettings()` 才会生成 payload。若用户没有自己的自由 `agySettings`，`orchestratorSettingsCoveredByAcp()` 判定为「ACP 可覆盖」：`prepareOrchestratorSettingsForAcp()`（`src/features/acp/orchestrator-prep.ts`）先把 payload 合并写入账号 home 的 `settings.json`（原子写、保留无关字段、不可解析则放弃），并返回 payload 作为进程 key 的 `settingsTag`——不同 seats 绝不复用同一 ACP 进程，旧进程跑完由空闲 TTL 收敛；合并失败则返回 null 回退 CLI `-p --settings`，不允许静默丢失设置。用户自定义 `agySettings` 仍走 CLI，避免把一次调用的设置持久化进每个账号。
- **配置与界面**：`orchestratorPlannerModel`、`orchestratorPlannerEffort`、`orchestratorExecutorModel`、`orchestratorExecutorEffort`（`src/common/types/config.ts` / `config.ts` / `/config` / `/status` / `/agy status` / `OrchestratorSettingsRows.ts`）；模型选「自动」或固定无档位模型时档位下拉仅允许「自动」。

## 7. 测试锚点

- `test/host/models.test.ts`：折叠规则、按账号独立 single-flight 并发刷新、`name`/`efforts` 变更广播、`agy models` 未登录兜底输出不误标 `discovered`、`accountHasArgon` 目录优先于折叠 REST 列表。
- `test/domain/pool.test.ts` / `test/host/pool-auth.test.ts` / `test/transport/http-contract-*.test.ts`：切号单次触发不双倍 spawn、429 自动切号广播、OAuth `finishWithCode` 广播、`manualPinAt` 优先于旧会话 `stickyAccount`、`/config` 修改 `defaultEffort`/`enabled` 同步刷新选择器。

## 模型可见性是允许清单 + 拒绝清单两层（PR #149 / #131）

选择器展示哪些模型，由三层共同决定，顺序不可颠倒：

1. **目录来源**：`agy models` 发现的目录（顺序与命名权威）+ 从账号配额快照折叠出的模型（`src/domain/models/quota-catalog.ts`，纯函数）。配额行只**补充**目录里没有的模型，绝不覆盖 CLI 的结论——没有 CLI 的宿主正是靠它才有可用列表。
2. **允许清单 `selectedModels`**：空数组 = 无限制（默认，保证升级不破坏）；非空 = 只显示这些 id。
3. **拒绝清单 `hiddenModels`**：最后应用，**永远胜出**，让运维不必修改勾选状态就能临时隐藏某个模型。

- **解析（`resolveModel`）不受可见性过滤**：只有 `listModels`（选择器）过滤。用户取消勾选一个正在被会话使用的模型，该会话必须继续工作——把可见性当成可用性会打断进行中的任务。
- 作用域：默认按**活跃账号**的配额快照合并（与它显示的 `agy models` 目录同源，避免两个来源互相矛盾）；`poolWideCatalog` 开启时按整池枚举。
- 锚点：`test/features/quota/quota-catalog.test.ts`、`test/client/models-panel.test.ts`、`test/host/models.test.ts`、`test/common/config-precedence.test.ts`。
