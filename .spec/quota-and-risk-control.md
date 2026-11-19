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
   - 手动与 CLI 全池配额刷新（`refreshAllQuotas(true)`）同样跳过已停用（`!acc.enabled`）与 `TOS_VIOLATION` 终态封禁账号；按有效出口代理分组（不同代理组间并行，**同一代理/直连出口内的多账号强制串行并附加 `400~850ms` 随机抖动**），消除同 IP 瞬时多号关联爆发。
   - `AgyAdapter` 请求频率与账号/出口启动间隔采用 **TAT（理论到达时间）** 同步预占算法，防止多并发会话在 `await` 后同时唤醒形成惊群，并在共享出口跨号切换时保持 `350~650ms` 最小安全间隔。

## 2. 配额采集：CLI 优先 + 按需最小化 REST 降级

1. **主账号 / 槽持有者优先走官方 `agy -p /usage`（零 Node REST 暴露）**：
   - `agy -p /usage --output-format stream-json` 由官方 Go 二进制发起，具备原生 TLS 指纹与官方 token 续期能力，且能返回 Pro/Ultra 专属 `Gemini 4 Argon` 独立分组。
   - `cliSlotHoldsAccount()` 通过比对系统钥匙串凭据与独立持久化的主凭据/磁盘凭据（`sameCredentialGrant`）严格验证槽归属（拒绝无独立锚点时的同义自证），验证通过即走 `agy -p /usage`。
2. **REST 降级采用「按需补充，避免冗余三并发」**：
   - 先请求 `retrieveUserQuotaSummary` 与 `fetchAvailableModels`；仅当 `fetchAvailableModels` 未携带模型级 `quotaInfo` 时才回退请求 `retrieveUserQuota`（保留 issue #48 修正过期 5h 占位符能力的同时，消除稳态下每次轮询多余的第 3 个内部端点请求）。
   - 后台自动轮询严格跳过已禁用、冷却中、终态封禁账号（`shouldPollAccount`），账号间保持 `2000~3500ms` 随机抖动间隔（`staggerJitterMs`）。

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

## 独立 Argon 池的判据：组名或 bucket，绝不用 description（issue #130）

agy 1.5.12 起，普通 `Gemini Models` 组的 description 会**枚举成员**：
`Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash`。

- 若把「description 含 argon」当作证据，共享 Gemini 池会被写进 `argon` 族：`google` 丢掉 weekly、面板出现假 `Argon` 行，且 `noteDedicatedGroup('argon')` 会污染选号与 `shouldReleaseOrphanedCooldown()`。
- 判据只有两个：**组 `displayName` 含 argon**，或 **bucket 的 `bucketId`/`displayName` 含 argon**（如 `argon-weekly`）。`summaryHasArgonGroup()` 与 `ingestSummaryGroups()` 的 `isArgon` 都遵守此规则。
- `description` 仍可参与**正向**家族归类（含 gemini → google），但不得用于判定「独立池」。
- 「Argon 已并入 Gemini」的折叠场景（argon 组不存在）行为不变。
- 测试：`test/domain-quota.test.ts`（description 枚举形态必须归 google 且保留 weekly；`Gemini 4 Argon` 组名与 `argon-weekly` bucket 仍识别）。
