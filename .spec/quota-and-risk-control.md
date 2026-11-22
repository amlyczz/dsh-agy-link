# 配额采集与风控防封号规范（唯一事实源）

> 维度：**如何以最低风控暴露度安全采集配额、执行预热与调度多账号，绝不触发 `TOS_VIOLATION` 封号或跨账号级联污染**。

## 1. 第一原则：真实客户端指纹，零伪造推理请求

Google Cloud Code / Antigravity 风控网关会联合校验 TLS 指纹（Go `crypto/tls` vs Node `undici` OpenSSL）、`User-Agent`（版本号与二进制内部 Changelist 一致性）、`Client-Metadata`、请求信封（`userAgent` / `requestType` / `sessionId` 格式）及第三方代理特征头（如 `anthropic-beta: claude-code-*`）。

硬约束：

1. **禁止使用 Node.js 直接调用 `v1internal:streamGenerateContent` / `generateContent` / `loadCodeAssist`**：
   - `WarmupService` 预热探针**必须 100% 通过官方 `agy` 二进制执行**（`agy -p "hi" --mode plan --output-format stream-json --print-timeout 1m --model <model>`），携带对应账号隔离环境（`buildAgyEnv`）并在 Windows 下受 `acquireCredentialSlot` 保护。
   - 严禁构造 `sessionId: "warmup_..."`、`anthropic-beta` 等第三方/机器人特征头。
2. **消费级安全端点（剔除企业端 `cloudcode-pa.googleapis.com`）**：
   - 消费级 OAuth 仅使用 `https://daily-cloudcode-pa.googleapis.com`（及同体系 `https://daily-cloudcode-pa.sandbox.googleapis.com` 灾备回退）。企业生产端点 `https://cloudcode-pa.googleapis.com` 对消费级凭据返回 429/403，或在 `daily` 耗尽时错误返回 `1.0`（100%）导致配额跳变与撞墙，**严禁放入消费级轮询列表**。
3. **OAuth / UserInfo 请求头一致性、去重与按账号连接池隔离**：
   - `oauth2.googleapis.com/token` 与 `googleapis.com/oauth2/v1/userinfo` 统一收口于 `src/host/oauth.ts`，携带与 `daily-cloudcode-pa` 完全一致的实时探测版本号 `agyUserAgent(runtimeVersion)`（禁止裸露默认 `undici` 或同 token 混发兜底版本与真实版本），消除重复的 `userinfo` 实现。
   - `agyFetch(url, init, proxyUrl, accountScope)` 按 `accountScope@@effectiveProxy` 隔离 Undici `ProxyAgent` / 连接池（上限 32 LRU，退出时统一关闭），确保共享同一代理出口的不同 Google 账号绝不复用同一条上游 Keep-Alive TCP/TLS 会话。
4. **启动序列严格串行定锚与按出口错峰**：
   - 启动时先完成 `agy --version` 版本探测，填充真实版本号并同步给 OAuth 模块后，再允许后续 `QuotaService` 发起请求。
   - 手动与 CLI 全池配额刷新（`refreshAllQuotas(true)`）同样跳过已停用（`!acc.enabled`）与 `TOS_VIOLATION` 终态封禁账号；按有效出口代理分组（不同代理组间并行）。**同一代理/直连出口内：后台自动轮询强制串行（并发 1），用户手动刷新允许有界并发 2（`QUOTA_FORCE_CONCURRENCY`），且每次账号 START 之间仍插入 `400~850ms` 随机抖动**——「串行到底」曾让 5 号同出口的池子点一次刷新耗掉约 55 秒（2026-11-19 实测），而并发上限 2 + 起点抖动既压掉大部分等待，又不产生同 IP 瞬时多号爆发。调度实现见 `src/features/quota/sweep.ts`（`sweepAccountsByEgress` / `runStaggered`）；Windows 下隔离 REST 账号不再套用全局 `serializeWin32` 锁，同样享受同出口有界并发 2，且 Win32 Credential Manager 读写通过 `stateDir()/bin` 下缓存编译的轻量 `.NET` 辅助程序（`csc.exe` 懒编译，写密钥走 stdin，失败自动回退 `powershell.exe`）完成，避免每次逐号拉起 PowerShell 编译。
   - `AgyAdapter` 请求频率与账号/出口启动间隔采用 **TAT（理论到达时间）** 同步预占算法，防止多并发会话在 `await` 后同时唤醒形成惊群，并在共享出口跨号切换时保持 `350~650ms` 最小安全间隔。

## 2. 配额采集：CLI 优先 + 按需最小化 REST 降级

1. **主账号 / 槽持有者优先走官方 `agy -p /usage`（零 Node REST 暴露）**：
   - `agy -p /usage --output-format stream-json` 由官方 Go 二进制发起，具备原生 TLS 指纹与官方 token 续期能力，且能返回 Pro/Ultra 专属 `Gemini 4 Argon` 独立分组。
   - `cliSlotHoldsAccount()` 通过比对系统钥匙串凭据与独立持久化的主凭据/磁盘凭据（`sameCredentialGrant`）严格验证槽归属（拒绝无独立锚点时的同义自证），验证通过即走 `agy -p /usage`。
2. **端点健康记忆（失败端点置后，绝不跳过探活）**：
   - `AGY_ENDPOINTS` 的固定顺序让**每个账号的每次配额请求**都从同一个端点起步。实测 2026-11-19：`daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` 对本机所有账号稳定 `ECONNRESET`（5.3~8.4s），而 sandbox 端点正常，于是每个账号每轮都要先白等一次超时。
   - `src/features/quota/endpoint-health.ts` 记录 **`操作|端点`** 维度的失败（TTL `QUOTA_ENDPOINT_DOWN_MS`=10 分钟，实例级、非模块全局），`orderEndpointsByHealth()` 把刚失败的端点排到最后；**全部端点都在冷却时按原顺序照常探测**，避免一次抖动把池子锁死。401/403 视为「端点活着、账号被拒」，不置为失败。
   - 摘要调用额外回报失败原因（`onSummaryFailure`）：`no_license`（403 且响应体提到 license）/ `auth`（401）/ `network` / `http`，只保留 API 枚举（如 `PERMISSION_DENIED`），不带响应正文。

3. **权威快照缺失必须显式化（禁止静默保留旧值当新值）**：
   - `buildFamilyQuotas` 在摘要失败时**故意保留上一份完整数据**（部分回退数据不得覆盖好数据）。这条规则本身正确，但旧实现让「摘要拿不到」完全无声：账号卡片会永远显示前一天的百分比，用户只能看到「一直卡在那」。
   - 现在摘要非权威时写入账号级 `quotaUnavailable = { reason, since, retryAfter, detail? }`，控制台据此渲染「配额刷新失败 · 原因 · 数据停留在 <时间>」；拿到权威摘要后立即清除（`clearQuotaUnavailable`）。
   - 原因分类：`no_license` / `auth` / `unreachable`（网络层全失败）/ `partial`（只有模型级回退数据）。

4. **无 license 账号的后台静默期**：
   - `reason === 'no_license'` 且未过 `retryAfter`（`QUOTA_LICENSE_RETRY_MS`=6 小时）的账号：后台轮询（`shouldPollAccount`）直接跳过，且管线内的摘要请求短路（`quotaSummarySuppressed`），不再每小时撞两次注定失败的摘要端点。
   - **用户手动点「同步」不受此限制**（`force=true` 必探），这样续费/恢复许可后点一下就能立刻恢复；探测成功即清标记。

5. **REST 降级采用「按需补充，避免冗余三并发」**：
   - 先请求 `retrieveUserQuotaSummary` 与 `fetchAvailableModels`；仅当 `fetchAvailableModels` 未携带模型级 `quotaInfo` 时才回退请求 `retrieveUserQuota`（保留 issue #48 修正过期 5h 占位符能力的同时，消除稳态下每次轮询多余的第 3 个内部端点请求）。
   - 后台自动轮询通过 `shouldPollAccount` 跳过已禁用、终态封禁以及**全族冷却（`isAccountFullyCooling`）**的账号；单模型族冷却（例如仅 Gemini 处于 429/本地冷却而 Argon/Claude/GPT 仍健康）绝不阻断其余模型族的轮询与调度；账号间保持 `2000~3500ms` 随机抖动间隔（`staggerJitterMs`）。
   - 预热规划（`planWarmupTargets` / `WarmupService`）按**模型族粒度**判定冷却与激活资格（`isFamilyCooling`）：点击一键预热默认使用 `force: false, ignoreFailureBackoff: true`，只激活已过期且健康的配额窗口，不强探周期中（mid-cycle）窗口、不触碰冷却中的模型族，且整号跳过时不插入账号间休眠延迟。

## 3. Proto3 零值省略与耗尽态解析

Google Cloud Code PA 使用 Proto3 JSON 序列化：当配额耗尽（`remainingFraction === 0`）时，服务端可能**省略 `remainingFraction` 字段**，仅返回未来的 `resetTime`（或 `remainingAmount: 0`）。

- `src/domain/quota/parse.ts` 在解析 `QuotaSummaryBucket`、`DiscoveredModelEntry.quotaInfo`、`UserQuotaBucket` 时：若 `remainingFraction === undefined` 但存在合法的 `resetTime`（或 `remainingAmount === 0`），**必须归一化为 `0`**，严禁丢弃该条目或默认渲染为 `100%`。

## 4. 跨账号 IP/凭据防串味与封号风暴熔断（Sweep Protection）

1. **Windows 凭据槽隔离全覆盖（`agy models`、`WarmupService` 与 `agy_ask`）**：
   - Windows 下 `agy.exe` 始终读取全局 `gemini:antigravity` 凭据槽。对隔离辅账号执行 `agy models`、`WarmupService` CLI 探针或 `agy_ask`（`runAgyOnce`）前**必须持有 `acquireCredentialSlot`**；若槽被长任务占用则跳过后台发现，**绝不允许在未切换凭据槽的情况下注入辅账号 `HTTPS_PROXY`**（否则会导致主账号同一 Token 在数秒内横跨多个代理 IP 出口，触发异地重放风控）。
2. **配额节奏智能调度（Quota Pacing & Surplus Tie-Breaking）**：
   - 保持 `LOW_QUOTA_5H = 0.10` 与 `LOW_QUOTA_WEEKLY = 0.05` 主动轮换红线不变，Argon 共享池完整继承 `google` 桶的 `nextQuotaResetAt`、`orderByExpiry` 与主动切号判断。
   - `orderByExpiry()` 对处于 `QUOTA_WINDOW_MATCH_TOLERANCE_MS`（5 分钟）内的同周期重置时间视为同一批次，在同批次内优先选择**零异常计数（`authStrikes=0` 且无连续失败）且配额时间盈余比（`remainingFraction - timeRemainingFraction`）更高**的账号，避免被秒级重置时间戳抖动误导去消耗濒临见底的账号。
2. **`TOS_VIOLATION` 终态识别与防级联传染熔断**：
   - 同时在 CLI 输出流（如 `[warning] This service has been disabled in this account for violation of Terms of Service`）与 HTTP 错误体中识别 `TOS_VIOLATION`（提取 `appeal_url`）和 `VALIDATION_REQUIRED`（提取 `validation_url`）。
   - 一旦某轮请求命中 `TOS_VIOLATION`，立即将该账号标记为终态隔离，且**本轮立即终止自动跨号重放（不消耗 failover 预算去连坐池内其余健康账号）**，向用户明确提示封禁原因与申诉链接。
3. **上游 Prompt WAF 瞬时裸 429 识别**：
   - 当账号缓存额度健康（`> 50%`），而请求在极短时间内返回无 `resetTime` 的裸 429（常见于上游系统提示词/工具描述 WAF 拦截），不对其施加长冷却并避免无意义轮转污染全池账号。

## 5. 验证锚点

- `test/quota.test.ts` / `test/domain-quota.test.ts`：CLI `/usage` 主账号放行、REST 按需降级、Proto3 零值省略解析为 `0%`、消费级单一端点。
- `test/warmup.test.ts`：CLI 探针执行（零 `undici` 推理请求、零 `anthropic-beta` 伪造头）、`TOS_VIOLATION` 终态隔离与 `appeal_url` 保留、非终态错误不误标 `authRequired`。
- `test/failure-classifier.test.ts` / `test/rate-limit-classify.test.ts`：CLI 文本 `TOS_VIOLATION` 识别与停止跨号连坐重试。
- `test/quota-availability.test.ts`：端点健康 TTL 与置后不丢弃、403 license 分类为 `no_license`、`quotaUnavailable` 写入/清除、`no_license` 后台摘要短路与手动强制探测、同出口有界并发 + 起点抖动、`refreshingAccounts()` 进度暴露。
- `test/http-contract.test.ts`：`/pool/refresh-quota` 的 `alreadyRunning` 重复点击回报、`/status` 的 `quotaRefreshing` 透出。

## 独立 Argon 池的判据：组名或 bucket，绝不用 description（issue #130）

agy 1.5.12 起，普通 `Gemini Models` 组的 description 会**枚举成员**：
`Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash`。

- 若把「description 含 argon」当作证据，共享 Gemini 池会被写进 `argon` 族：`google` 丢掉 weekly、面板出现假 `Argon` 行，且 `noteDedicatedGroup('argon')` 会污染选号与 `shouldReleaseOrphanedCooldown()`。
- 判据只有两个：**组 `displayName` 含 argon**，或 **bucket 的 `bucketId`/`displayName` 含 argon**（如 `argon-weekly`）。`summaryHasArgonGroup()` 与 `ingestSummaryGroups()` 的 `isArgon` 都遵守此规则。
- `description` 仍可参与**正向**家族归类（含 gemini → google），但不得用于判定「独立池」。
- 「Argon 已并入 Gemini」的折叠场景（argon 组不存在）行为不变。
- 测试：`test/domain-quota.test.ts`（description 枚举形态必须归 google 且保留 weekly；`Gemini 4 Argon` 组名与 `argon-weekly` bucket 仍识别）。

## 额度汇总被拒绝的两类终态（issue #137）

`retrieveUserQuotaSummary` 可能对账号给出**终态**拒绝，且作用域不同，必须分开：

| 判定 | 触发 | 压制对象 | 周期 |
| --- | --- | --- | --- |
| `no_license` | 403 且正文含 license | **整个账号**退出后台轮询 | 6h（新许可随时可能到达） |
| `no_summary_access` | 403 且 `status = PERMISSION_DENIED`（免费账号无 5h 窗口） | **仅汇总请求**；`fetchAvailableModels` / 用户额度照常 | 7 天（对齐周配额周期） |

**判定顺序不可颠倒（#142）**：真实 403 正文可能**同时**含 `license` 字样与 `PERMISSION_DENIED`。`status` 是结构化的 API 级结论，必须优先于 message 文本匹配；若先匹配 license 正则，免费档分支就变成死码。仅含 license 字样而无该 status 时仍判 `no_license`——两个分支都要有测试保证可达。

- `quotaSummarySuppressed(account)` 对两类都返回 true（都意味着「先别打那个端点」）。
- `accountPollSuppressed(account)` 只对 `no_license` 返回 true；`shouldPollAccount()` 用它决定账号是否完全退出轮询——免费账号**必须继续轮询**，否则模型列表会被冻结。
- 手动刷新（`force`）绕过压制，用户升级后可立即恢复。
- UI 对 `no_summary_access` 显示「免费账号 · 仅限周配额」，不显示通用失败（四语言 locale）。
- 锚点：`test/issue137-free-tier-summary.test.ts`（分类、两类压制边界、轮询不变式、周期常量）。

## 刷新成功后必须清除 unavailable 标记（issue #151）

`quotaUnavailable` 是「当前额度不可信」的标记，任何**真正拿到新鲜数据**的路径都必须清除它，而不只是 REST/汇总分支。

- CLI 优先路径拿到 families 后**提前 return**，早于拥有 `clearQuotaUnavailable` 的汇总分支——于是接口故障期间写入的 `unreachable` 会一直残留，面板持续显示旧时间戳，而存储额度其实在推进。
- 规则：**谁证明数据是新鲜的，谁负责清标记**。CLI 成功 → clear；汇总权威 → clear；只有「什么都拿不到」才保留/写入。
- 锚点：`test/issue137-free-tier-summary.test.ts`（CLI 成功后清除；CLI 无数据时不动标记）。

## 6. 全路径额度耗尽统一自动切号对齐（主代理 / 子代理 / 辅助路由 / 工具）

所有请求入口（主会话 `AgyAdapter`、内嵌子代理、辅助路由 `isAux`、`runAgyOnce`/`agy_ask`、`ImageService`/`agy_image`、`TranslationService` 与 `runAcpAttempt`）必须遵守同一套「硬配额耗尽即冷却并切向下一个健康账号」契约，同时严格保留 `TOS_VIOLATION` 终态防连坐熔断：

1. **带部分输出（partial response）的硬配额失败绝不可吞成成功**：
   - 当 `agy`（CLI `-p` 或 `acp`）在输出过部分文本/工具后返回 `status: ERROR` 且 `error`/`response` 匹配 `isHardQuotaResultError`（如 `RESOURCE_EXHAUSTED (code 429): Individual quota reached`），`EventMapper`、`RunRecording`（`hasConsumableResult` / `hasFinishableEventFrom`）、`classifyRun()` 与 `driveAcpPrompt()` 必须判定为**不可消费失败**并映射为 `Err.RATE_LIMIT`，冷却当前账号（优先解析精确重置时长）并切号重试，严禁调用 `recordSuccess()` 或以 `stop` 结束。
   - 非配额类的工具报错但带有效答复（如 `Find command timed out.`）保持既有软收尾（`stop` + `[agy finished with error]`）。
2. **`agy` 内部子代理与图像/委派工具实时配额熔断切号（`SubagentTracker` + `src/provider/quota-failover.ts`）**：
   - 严禁从普通终端命令输出（如 `Command exited with code 1`）或未核验正文中误判 429；仅当满足可信来源约束（父对话 `transcript.jsonl` 来自 `SYSTEM` 的 `The subagent ... encountered an error` 通知、子代理 `transcript.jsonl` 终态 `ERROR`/`FAILED` 中包含权威 Google Cloud Code / `image failed to generate` / `agent executor error` 配额信号，或 `generate_image`/`invoke_subagent` 工具调用错误）且排除 ≤30s 瞬时 QPS 突发（`isTransientBurstRateLimit`，如 `RATE_LIMIT_EXCEEDED` `1s`）与 `TOS_VIOLATION` 时，才判定为硬配额耗尽。
   - 实时检测到硬配额耗尽后，立即对耗尽的模型族（若错误信息指定了 model 则优先归属该模型所属族）执行 `pool.recordFailure(..., serverResetTime)`，并检查池内是否还存在满足主模型及耗尽族资格的替代账号：若存在则 `proc.kill('quota')`（保留非 aborted/timeout 状态以映射为 `RATE_LIMIT`），让上层立刻在替代账号重放；若不存在替代账号，仅记录冷却而不强杀仍在运行的主进程。
   - `handleAttemptOutcome()` 必须先 `await finalizeAttempt(...)` 完成冷却与切号落盘，再 `rec.settle(failure)` 唤醒上层消费方。
3. **重试深度跟随池容量并覆盖非 `llm-retry` 路径**：
   - `providerRetryPolicyFor()` 按 `Math.min(Math.max(1, enabledAccounts - 1), 16)` 放开 `poolHops`，不再硬截断在 2 跳导致多号池提前放弃。
   - `streamWithEffortRetry()` 对不经过 `@deepseek-ai/dsh-llm-retry` 的 `isAux` 辅助路由在未产出任何实质输出前遇到 `Err.RATE_LIMIT` 时，在池内按 `enabledAccounts - 1`（上限 16）自动切号重放（绝不重放 `TOS_VIOLATION`）。
   - `runAgyOnce()`（`agy_ask` / `/agy ask`）、`ImageService`（`agy_image` 含工具级 429 `QUOTA_EXHAUSTED` 检测与独立 `quotaHops` 预算）与 `TranslationService`（按 `poolQuotaHops` 放开 `RATE_LIMIT`/`QUOTA` 重试上限，非配额错误仍受 `translateRetries` 约束）均接入统一冷却与切号循环；全池无可用账号时明确报错，**严禁**回退到 `account = undefined` 悄悄消耗系统主账号。
4. **单模型粒度主动让路（`isQuotaBenched`）**：
   - 当某族缓存配额的 `models` 列表包含匹配请求模型（`modelMatches`）的条目且**所有匹配条目**的剩馀比例均 `<= LOW_QUOTA_WEEKLY`（0.05）且处于有效重置窗口内时，即使该族宏观均值仍高于 `0.10`，预选阶段也直接判定该账号对该模型进入配额让路（`quotaGateClearedAt` 覆盖规则不变）。
- **验证锚点**：`test/quota-failover-alignment.test.ts`。

## CLI 配额轮询不得使用即将失效的 token（PR #160）

agy 启动时从凭证库取 token，该读取只有 10 秒预算。token 已过期或在该窗口内过期时，刷新会输掉竞争，agy 回退到**交互式 OAuth（弹浏览器等人）**。

- 实测：375 次每小时轮询中 9 次触发交互登录（2.4%），**全部 token 寿命 ≤60 秒**；≥1 分钟的 746 次零触发。
- 规则：CLI 轮询前要求 token 仍有 `CLI_TOKEN_SAFETY_MS`（2 分钟）寿命；不足则先刷新，仍不足则**跳过本轮 CLI，改用 REST**。跳过一轮无代价，弹浏览器窗口则以用户注意力为代价。
- 不要把"几秒钟的聪明"引入每小时才跑一次的轮询——边际取得足够宽，比精确贴近失效点更重要。
- 锚点：`test/quota-cli-token.test.ts`（121 行纯函数 + 226 行用例）。

## ACP 的 `usage_update` 不是用量样本（PR #165 / issue #158）

agy 1.5.x 的 `session/update`（`usage_update`）**只带 `{ used, size }`**——那是上下文窗口占用，**不是**本次调用的计费 token。

- **不得**把 `used` 写入 `input_tokens`：那会让该轮最终 usage 变成 `{ inputTokens: used, outputTokens: 0 }`，导致缓存命中率 0%、输出速度 0 tok/s、未缓存输入虚高。真实数字只在 `PromptResponse.usage` 里。
- `used` 仅作诊断记录（`lastContextUsed`）。只有当更新真的携带 `cachedReadTokens` / `outputTokens` 时才可作为用量样本。
- 通用原则：**「上下文占用」与「计费用量」是两个量，永不互相替代。**
- 锚点：`test/usage-acp.test.ts`（178 行）。
