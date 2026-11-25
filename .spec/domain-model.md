# 领域模型与术语（Ubiquitous Language）

本文件定义 `dsh-agy-link` 的**统一语言**：同一个概念在 host / domain / provider / client 里必须叫同一个名字。改动调度、配额、UI 之前先对齐这里；其余维度文档只补充该领域的规则，不重复定义。

## 1. 实体

| 概念 | 定义 | 代码锚点 |
| --- | --- | --- |
| **Account（账号）** | 一个 Antigravity 登录身份。`Primary` 使用系统 HOME；`Isolated` 拥有独立 HOME 与独立 token。 | `ManagedAccount`（`common/pool-types.ts`） |
| **Account Pool（账号池）** | 本机可轮换的账号集合 + 每族 active 指针 + 冷却/配额快照；持久化在 `pool.json`。 | `AccountPoolManager`（`host/pool.ts`） |
| **Credential Slot（凭据槽）** | 同一时刻只允许一个 agy 进程占用的系统凭据/钥匙串资源；跨会话串行化。 | `acquireSlotLease` / `credentialSlotMutex` |
| **Session Binding（会话绑定）** | DSH 会话 ↔ agy conversation 的映射，决定 `session/resume` 还是重建。 | `SessionStore`、`binding.conversationId` |
| **Run / Attempt** | 一次 DSH 模型调用对应的一次 agy 运行；ACP 与 CLI 是两种 transport。 | `AttemptInput`、`runAcpAttempt`、`runAgyAttempt` |
| **Aux Call（辅助调用）** | 标题/压缩/翻译等非用户主对话调用，使用中立工作区以稳定缓存。 | `auxNeutralWorkspace`、`call-context.ts` |

## 2. 配额与可用性（本项目的核心模型）

| 概念 | 定义 | 代码锚点 |
| --- | --- | --- |
| **Model Family（配额族）** | 账号级配额组：`google` / `argon` / `anthropic` / `openai`。**`quotas.google.description` 是否显式列名 Argon 是唯一判据**：列名 ⇒ `argonSharesGoogleGroup(acc)` 为真（`agy 1.5.15+` 付费共享组），`google` ↔ `argon` 共享同一物理配额桶、冷却、倒计时与同账号指针，UI 只渲染**一个**配额桶；未列名 ⇒ 二者账本独立。`quotas.argon` 行单独存在**不构成**独立证据——上游会把合并组同时写在两个 key 下（argon 那份通常只带同一个 weekly 窗口、没有自己的 5h 行），据此判独立会让账号卡片长出第二个幽灵「Argon 0%」桶（2026-11-25）。 | `ModelFamily`、`effectiveFamilyQuota()`、`argonSharesGoogleGroup()` |
| **Model Bucket（模型桶）** | 族内的 per-model 配额桶，例如图片模型 `gemini-3.1-flash-image`。Google 本来就按 model 计量，family 只是聚合。 | `FamilyQuotaInfo.models[]` |
| **Quota Snapshot（配额快照）** | 某族某时刻的 `remainingFraction` / `weeklyFraction` / reset / `models[]` / `updatedAt`。 | `FamilyQuotaInfo` |
| **Family Cooldown（族级冷却）** | 账号级硬拒绝（如 `Individual quota reached`）导致**整个族**暂不可用。 | `cooldowns[family]` |
| **Model Cooldown（模型级暂停）** | 单个桶的 429（如 `on this model`、`generate_image`）只暂停**该模型**，族与其他模型照常。 | `modelCooldowns[baseSlug]`、`recordModelFailure` |
| **Quota Bench（主动让路）** | 剩余量过低时**主动**退出轮换：5h ≤10% 或周 ≤5%，到 reset 自动恢复；可被用户「清除冷却」覆盖。 | `LOW_QUOTA_5H`、`isQuotaBenched` |
| **Eligibility（资格）** | 一个账号能否服务「某族 + 某模型」：`disabled` / `auth` / `model-unsupported` / `cooldown` / `model-cooldown` / `quota`。 | `explainIneligibility()` |
| **Quota Model（第二配额维度）** | 生图请求同时受「驱动聊天模型」与「图片模型桶」约束；`quotaModel` 就是后者。 | `quotaModel`、`isModelQuotaClear()` |
| **Sticky Pointer（粘性指针）** | 每族当前使用的账号；正常聊天尽量粘住，只有不可用才前进。 | `activeAccountIds[family]`、`lastActiveAccountId` |
| **Local Rotation（局部轮换）** | 一次生图请求内部的换号：用 `avoidAccountIds` + `findAccount()`，**不移动**粘性指针。 | `ImageService.runAttempts` |
| **Session Binding（会话绑定）** | 某个 DSH 会话在某族上实际跑过的账号（`store` 的 `<sessionKey>:<accountId>`）。**仍可用时压过族粘性指针**：会话不应在对话中途悄悄换号。 | `stickyAccount()` |
| **Quota Hops（换号预算）** | 一次请求内允许因配额再试的账号数上限（`min(启用账号数-1,16)`）。 | `poolQuotaHops` |
| **Failover（失败接管）** | 冷却/暂停当前账号并切到下一个可用账号；TOS 终态**永不**跨账号。 | `quota-failover.ts` |

### 调度不变量（任何改动都不得破坏）

1. **族冷却 ⇒ 全族不可用；模型冷却 ⇒ 仅该模型不可用。** 模型级 429 禁止写族冷却。
2. **生图不得移动粘性指针**：图片桶耗尽只影响图片，不能打断并行的聊天回合。
3. **Argon 与 Gemini 账本规则**：`google.description` 未列名 Argon 时，二者账本/冷却/指针完全独立（缺行是「未知」，绝不借用）；当且仅当 `argonSharesGoogleGroup(acc)` 为真（`agy 1.5.15+` 折叠共享组，判据只看 `description`，`quotas.argon` 行的存在不改变结论）时，`google` ↔ `argon` 双向共享配额门控、冷却（`effectiveFamilyCooldown`）、倒计时、活跃指针与会话粘性（`sharedArgonPeerFamily`），确保 Orchestrator (Argon) 规划、执行与内部子代理同账号运行并在任一侧 429/切号时同步切换。
4. **`TOS_VIOLATION` 永不跨账号重试**，避免连坐封号。
5. **无可用账号时必须显式报错**，严禁 `account = undefined` 回落系统主账号。
6. **启动迁移**清掉历史遗留的「模型级 429 写出的族冷却」。
7. **用户「清除冷却」** = 清该族冷却 + 该账号全部模型桶（`quotaGateClearedAt` 仅用于主动让路）。
8. **会话绑定先于平台策略**：`selectSessionAccount()` 在所有平台都先走 `stickyAccount()`；Windows 的「同账号打包」（`parallelSameAccount`）只用于**没有可用绑定**的新会话，用来让并发回合共用一个凭据槽。绑定账号被烧掉/冷却后才落到 `selectAccount()`（该族账本正常前进）。

## 3. 传输与上下文

| 概念 | 定义 | 代码锚点 |
| --- | --- | --- |
| **Transport** | `acp`（默认，常驻 JSON-RPC）与 `cli`（`agy -p`，一次性）。 | `cfg.transport`、`AgyTransportMode` |
| **Single-turn CLI fallback** | 仅当 ACP 在**流式开始前**失败或零产出时，本回合改走 CLI；AUTH/身份失败**不回退**。 | `retryOnCli`、`settleEarlyFailure` |
| **Session-cumulative usage** | ACP `session/prompt` 的 usage 是会话累计；per-call 值在 `transcript.jsonl`。 | `transcript-usage.ts` |
| **Cache Bucket** | 按本地日聚合的缓存命中/上下文统计。 | `cacheMetrics`、`cacheStats` |

## 4. 能力域

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 文本/工具 | `AgyAdapter` | 文件、命令、搜索、浏览器、子代理等由 agy 内部工具执行并镜像为 `agy_tool` 卡片 |
| 生图 | `agy_image` / `dsh-agy-image` / `/agy image` | 驱动模型 + 图片模型桶；支持参考图、比例、产物校验、局部轮换 |
| 翻译 | `/tsl` | `TranslationService`，独立重试预算 |
| 子代理/后台 | `SubagentTracker`、`backgroundWakeup` | transcript tail、看门狗保活 |
| 预热 | `WarmupService` | 避开冷却/让路账号 |
| 账号管理 | `/agy ...`、`/plugins/agy-link/*`、账号池面板 | 登录、启停、当前账号、配额同步、清除冷却 |

## 5. 概念 → UI

| UI 元素 | 展示的概念 |
| --- | --- |
| 账号卡片「冷却中」 | `isFamilyCooling()` = 族冷却 ∪ 主动让路 |
| 账号卡片「单模型暂停: … → HH:MM」 | `modelCooldowns`（图片桶等） |
| 族条下的「图片额度」行 | `quotas[family].models[]` 中 image 桶的剩余与 reset |
| 「设为当前」 | `activeAccountIds[family]` 指针 |
| 「清除冷却」 | 族冷却 + 模型桶 + 主动让路覆盖 |

## 6. 文档索引

- 风控与配额规则：[quota-and-risk-control.md](quota-and-risk-control.md)
- 凭据生命周期：[credential-lifecycle.md](credential-lifecycle.md)
- 生图细节：[image.md](image.md)
- 其余维度见 [README.md](README.md)
