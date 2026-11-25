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
   - `agy -p /usage --output-format stream-json` 由官方 Go 二进制发起，具备原生 TLS 指纹与官方 token 续期能力。**注意（2026-11-24 实测 agy 1.5.15）**：它的 `command.data` 只有 `description` + `groups[]`（`name/description/buckets[]`），**没有任何 tier / plan 字段**；`groups` 也不再为付费账号单独列 `Gemini 4 Argon` 分组（只剩 `Gemini Models` 与 `Claude and GPT models`），Argon 只以成员身份出现在 Gemini 组的 description 里。
   - `cliSlotHoldsAccount()` 通过比对系统钥匙串凭据与独立持久化的主凭据/磁盘凭据（`sameCredentialGrant`）严格验证槽归属（拒绝无独立锚点时的同义自证），验证通过即走 `agy -p /usage`。
2. **端点健康记忆（失败端点置后，绝不跳过探活）**：
   - `AGY_ENDPOINTS` 的固定顺序让**每个账号的每次配额请求**都从同一个端点起步。实测 2026-11-19：`daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` 对本机所有账号稳定 `ECONNRESET`（5.3~8.4s），而 sandbox 端点正常，于是每个账号每轮都要先白等一次超时。
   - `src/features/quota/endpoint-health.ts` 记录 **`操作|端点`** 维度的失败（TTL `QUOTA_ENDPOINT_DOWN_MS`=10 分钟，实例级、非模块全局），`orderEndpointsByHealth()` 把刚失败的端点排到最后；**全部端点都在冷却时按原顺序照常探测**，避免一次抖动把池子锁死。401/403 视为「端点活着、账号被拒」，不置为失败。
   - 摘要调用额外回报失败原因（`onSummaryFailure`）：`no_license`（403 且响应体提到 license）/ `auth`（401）/ `network` / `http`，只保留 API 枚举（如 `PERMISSION_DENIED`），不带响应正文。

### 2.1 不展示逐模型（图片）配额行 —— 2026-11-23 决定

- **`agy` CLI 不给逐模型配额。** 实测 `agy -p /usage`（文本）与 `agy -p /usage --output-format json`（`command.data.groups[]`）在 Pro 账号（3 组：Gemini / Claude&GPT / Gemini 4 Argon）与免费账号（2 组）上都**只有分组级桶**（weekly + 5h），整份输出中 `image`/`imagen` **零命中**；`agy models` 连 `gemini-3.1-flash-image` 这个模型 id 都不列。
- 逐模型的图片桶只存在于 Google 内部 REST（`fetchAvailableModels` 的 `quotaInfo` / `retrieveUserQuota`），也就是**降级路径**。
- 结论：**控制台不再渲染「图片额度」行**（原先 `renderModelQuotas` 筛选 `models[].modelId` 含 image/imagen）。若一次 REST 降级恰好带来该数据，也不再展示，避免把「降级残留」呈现成稳定指标，也避免为了它常态打 REST 增加指纹暴露。
- 「单模型暂停」（`renderModelPauses`）保留：它反映的是本地调度冷却（哪个模型被我们暂停），与配额采集来源无关。

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
   - 预热按**模型族**逐个探测（`account.quotas` 里出现的每个族各一条模型）；`warmupModels` 只决定族内选哪条模型（空数组=全禁），不是白名单。因此「配了 2 条模型」仍可能探 4 个族（google/anthropic/openai/argon）。
   - **`--effort` 由模型决定，不能按族硬塞**：只有 `gemini-*` 探针接受 `--effort`（Claude/GPT 的档位在模型 slug 里）。探针先查 `effort-unsupported` 学习列表跳过，若仍被 CLI 拒绝（`--effort is not supported for model …`）则**去掉 `--effort` 重试一次并回写学习列表**。教训：2026-11-23 实测 claude-sonnet-5-5 每次都因该参数被本地拒绝，anthropic 族周窗口从未被激活，lastRun 恒为 3 失败。
   - **账号之间 30–120s 随机间隔**（`warmupAccountGapMs()`），不是 1.5–3s：同出口多号在一分钟内连续点亮是最像号池 farm 的形态。族内探针之间仍是 1.5–3s（单号小爆发，贴近正常使用）。
   - **单轮探针硬上限** `warmupMaxProbesPerRun`（默认 12，`0` = 不限，env `DSH_AGY_WARMUP_MAX_PROBES`）：超限账号本轮以 `Run probe budget exhausted` 记为 skipped 并留到下次；预算用尽后不再插入无意义的账号间等待。
   - 设置页暴露 `warmupWindows` / `warmupModels` / `warmupMaxProbesPerRun`（此前窗口模式只能改配置文件），实际值与上限都从 `/status` 读回，避免面板和调度器各说一套。
   - **自动预热（`autoWarmup`，默认关闭）只在配额窗口「可激活」时触发**：调度器每 5 分钟 tick 一次，是否真探由按族判定决定（周窗口 6 天冷却 / 5h 窗口 4 小时冷却 / 失败 30 分钟退避 / 冷却中的族跳过），所以开启后每周每族最多 1 次，5h 模式约每 4 小时 1 次。
   - **调度与手动互斥**：`runScheduledWarmup()` 在 `isRunning()` 为真时直接返回（账号间隔 30–120s 意味着一次全池 run 会持续数分钟），否则一次手动预热会被下一个 tick 叠上第二轮全池扫描。
   - **日锚点带确定性抖动**：`warmupDailyTime` 采用分钟级锚点 + `dailyJitterMinutes(dayKey)`（0–20 分钟，同日稳定、跨日不可预测），避免每天同一分钟准点开跑；锚点钳到 23:59，深夜锚点不会跨日丢失。
   - **上游下架立即停车**：CLI 报 `retired / no longer available / unknown model` 时写入 `${identity}:${family}:parked`，该族停车 24 小时再试，而不是按 30 分钟退避无限重试（否则一天 48 次无效探针）；手动 force 仍可越过停车。
   - **调度锚点必须持久化**：日锚点与间隔锚点写入 `warmup-history.json`（`schedule:daily:<dayKey>` / `schedule:interval`），不再只存在内存里。否则插件重载会让间隔模式立刻"到期"、日锚点当天再判一次——按族冷却只是把探针挡住，白跑一轮全池扫描。多宿主共享 state 目录时也靠它去重。
   - **间隔下限 3 小时**（`MIN_WARMUP_INTERVAL_HOURS`，`0` = 关闭）：一次全池 run 按 30–120s 账号间隔要跑几分钟，1–2 小时的间隔会在上一轮没跑完时重新武装。`common/config.ts` 的 `clampWarmupIntervalHours()` 与配置路由校验共用同一常量。

## 逐模型读数落哪个窗口：只看 reset 距离，不看族名（2026-11-24）

`fetchAvailableModels` 的 `quotaInfo` **不带窗口标签**：同一个字段，有的账号给 5 小时桶，有的给周桶。判别依据只能是 reset 时刻。

- **物理判据**：真实的 5 小时桶**永远在 5 小时内**重置（后端时钟抖动不会让它变成一天以后）。因此 `resetTime - now > 6h` → 这只可能是**周窗口**。常量 `WEEKLY_WINDOW_MIN_RESET_MS`（`src/domain/quota/buckets.ts`）。
- **摘要被拒时没有可匹配的桶**：免费账号的 `retrieveUserQuotaSummary` 恒 403 PERMISSION_DENIED，`familyQuotas` 为空，于是旧 fallback 把**周读数写进了 5 小时行** —— 屏幕上就是「5 小时额度 100% · 周额度（空白）· 重置 11/30 22:46」外加一个 Pro 徽章，四者描述的都是账号根本没有的桶（实测 2026-11-23/24，主账号）。
- **规则**：`ingestModelCatalog` 在「该族没有摘要行」时，若读数按上述判据是周窗口，就只写 `weeklyFraction`/`weeklyResetTime`，5 小时槽位保持「未知」；有真 5 小时读数（<6h）才写 5 小时行。摘要权威时行为不变（按 `sameQuotaWindow` 匹配）。
- **已落盘的错行必须能自愈**：`undoWeeklyInFiveHourSlot()` 把「5 小时行里装着周窗口、且周行缺失或与该窗口同一时刻」的行搬回周行。否则 `mergeFallbackFamilyQuota` 会用它当「last-known-good」把错误和旧时间戳一起永久冻住（面板上的「数据停留在 …」正是这么来的）。
- **套餐徽章必须与卡片一致**：`isStalePlanTier('pro', ev, quotaUnavailable)` —— 账号处于 `no_summary_access` 且**没有任何 5h 证据**时，持久化的 `pro` 与证据矛盾，按 Free 呈现。有 5h 读数的付费账号不受瞬时拒绝影响（`has5h` 仍成立）。

### Pro / Ultra 不能从配额数据推断（2026-11-24）

实测结论（agy 1.5.15，7 账号实测）：

- **所有付费账号的 Gemini 组 description 都枚举 `… Gemini 4 Argon …`**，且 `groups` 里没有独立的 Argon 组；所有账号的模型目录也都列出 argon 模型。于是「description 含 argon / 目录含 argon 模型 ⇒ Ultra（折叠共享池）」这条判据对 **Pro 与 Ultra 同样为真**，把 6 个 Pro 账号全部标成了 Ultra（用户报告：「我大多数都是 pro」）。
- `/usage` 的 JSON 不含任何 tier 字段；本机也没有持久化的用户档位（`jetsy_state.pbtxt` 只有 onboarding 状态）。
- `loadCodeAssist`（cloudcode-pa）返回的是 **Gemini Code Assist** 的档位，不是 Antigravity 订阅：实测所有账号都是 `currentTier.id = "free-tier"`、`allowedTiers = [free-tier*, standard-tier]`，与「能不能跑 Argon」无关。Antigravity 真实档位在 `google.gca.aicode.v1main.FetchLicensesResponse.userTier`（binary 内含 `G1_PRO_TIER` / `G1_ULTRA_TIER` / `G1_ULTRA_LITE_TIER` / `gcp-ge-ultra-tier` 等），但 `:fetchLicenses` 在 `cloudcode-pa` / `aicode.googleapis.com` 两个主机上都 404（需要 project/parent 上下文），**当前不探测**。
- 结论：**没有可证的 Ultra 信号时不得声称 Ultra**。付费账号（有 5h 窗口或独立 Argon 桶）一律呈现 **Pro**——既是常见套餐，也是保守答案；`isStalePlanTier('ultra')` 恒为 `true`，持久化的 Ultra 会被重算掉。真要显示 Ultra，必须补一条许可证读取（`userTier`）或用户手动指定档位，而不是从配额数据猜。
- **用户手动指定档位已落地**（`planTierOverride` + `/agy plan <id|alias> <pro|ultra|free|enterprise|auto>`，`src/host/commands/pool.ts`）：`resolveAccountPlanTier` 先看这个 pin，再用推断；pin 存在 `pool.json` 的账号上，**不受每小时配额刷新影响**（刷新只写 `planTier`，不碰 pin）。`auto` 清除 pin。这是目前唯一诚实的 Ultra 来源，UI 上不额外标注（命令会回报当前状态）。
- 锚点：`test/domain/plan-tier-and-duplicates.test.ts`（description 枚举形态 → Pro；无证据时 stored Ultra 会被重算）。
- 锚点：`test/features/quota/quota-weekly-window-filing.test.ts`。

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

- `test/features/quota/quota-*.test.ts` / `test/domain/domain-quota.test.ts`：CLI `/usage` 主账号放行、REST 按需降级、Proto3 零值省略解析为 `0%`、消费级单一端点。
- `test/features/warmup/warmup.test.ts`：CLI 探针执行（零 `undici` 推理请求、零 `anthropic-beta` 伪造头）、`TOS_VIOLATION` 终态隔离与 `appeal_url` 保留、非终态错误不误标 `authRequired`。
- `test/features/warmup/warmup-effort-throttle.test.ts`：claude/gpt 探针不带 `--effort`、学习列表前置生效、被拒后去 effort 重试一次并回写、账号间隔 30–120s、单轮探针上限与 `0` 关闭语义。
- `test/features/warmup/warmup-auto-schedule.test.ts`：调度 tick 不与运行中的预热叠加、日锚点抖动 0–20 分钟且同日稳定、上游下架模型停车 24 小时（force 可越权）、锚点跨重载持久化、间隔下限 3h。
- `test/provider/failure-classifier.test.ts` / `test/common/rate-limit-classify.test.ts`：CLI 文本 `TOS_VIOLATION` 识别与停止跨号连坐重试。
- `test/features/quota/quota-availability.test.ts`：端点健康 TTL 与置后不丢弃、403 license 分类为 `no_license`、`quotaUnavailable` 写入/清除、`no_license` 后台摘要短路与手动强制探测、同出口有界并发 + 起点抖动、`refreshingAccounts()` 进度暴露。
- `test/transport/http-contract-*.test.ts`：`/pool/refresh-quota` 的 `alreadyRunning` 重复点击回报、`/status` 的 `quotaRefreshing` 透出。

## 独立 Argon 池的判据：组名或 bucket，绝不用 description（issue #130）

agy 1.5.12 起，普通 `Gemini Models` 组的 description 会**枚举成员**：
`Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash`。

- 若把「description 含 argon」当作证据，共享 Gemini 池会被写进 `argon` 族：`google` 丢掉 weekly、面板出现假 `Argon` 行，且 `noteDedicatedGroup('argon')` 会污染选号与 `shouldReleaseOrphanedCooldown()`。
- 判据只有两个：**组 `displayName` 含 argon**，或 **bucket 的 `bucketId`/`displayName` 含 argon**（如 `argon-weekly`）。`summaryHasArgonGroup()` 与 `ingestSummaryGroups()` 的 `isArgon` 都遵守此规则。
- `description` 仍可参与**正向**家族归类（含 gemini → google），但不得用于判定「独立池」。
- 「Argon 组不存在」**不再**意味着它与 Gemini 共用一池；见下一节，缺失即未知，绝不继承。
- 测试：`test/domain/domain-quota.test.ts`（description 枚举形态必须归 google 且保留 weekly；`Gemini 4 Argon` 组名 与 `argon-weekly` bucket 仍识别）。

## Argon 与 Gemini 是两本独立配额账（禁止任何跨族 fallback）

**第一原则：`argon` 与 `google` 永远不互相顶替。一个族没有自己的数据时，答案是"未知"，不是"抄另一个族的"。**

实测反证（2026-11-23，7 个账号的 `pool.json`）：6 个拥有独立 `argon` 组的账号里，`elegantmanco` 的 `google` 5h 已到 `0%` 而 `argon` 周额度仍是 `100%`，`simplegod158` 的 `google` 周额度已到 `0%` 而 `argon` 周额度仍是 `100%`。若二者共用一池，这些数字不可能分叉。所有账号的 `google.models` 中也**不含任何 argon 模型**（`argon-in-google = []`）。

禁止的四处具体写法（历史上同一表达式被复制了四份）：

| 位置 | 旧行为（已删除） | 新行为 |
| --- | --- | --- |
| `src/domain/accounts/selection.ts` `effectiveFamilyQuota()` | `quotas[family] ?? quotas.google`（argon 时） | 只读 `quotas[family]` |
| `src/common/quota-bench.ts` `isQuotaBenched()` | 同上 | 只读 `quotas[family]` |
| `src/common/account-models.ts` 模型行 fallback | 同上 | 只读 `quotas[family]` |
| `src/domain/quota/parse.ts` `ingestModelCatalog()` | `argonSharesGemini` 把 argon 模型行归档进 `google` 且丢弃其读数 | 永远按 `modelFamilyOf()` 的真实族归档 |

语义后果（有意为之，不是退化）：

- **独立账本与显式共享组边界（2026-11-24 对齐 agy 1.5.15+）**：
  - 凡账号拥有独立 `quotas.argon` 行，或 `quotas.google.description` 未显式列名 Argon，仍严格执行「独立账本、绝不借用」：`isQuotaBenched()` 只读自身行，`nextQuotaResetAt()` 返回 `NaN`，`orderByExpiry()` 把未知重置排在有已知重置之后。
  - 当且仅当 **`argonSharesGoogleGroup(acc)` 为真**（`acc.quotas?.argon === undefined && isArgonModel(acc.quotas?.google?.description)`，即 `agy 1.5.15+` 付费号把 Argon / Orchestrator (Argon) 折叠进 `Gemini Models` 共享组）时，`argon` 与 `google` 物理同桶：
    - 配额门控与排序：`effectiveFamilyQuota()`、`isQuotaBenched()`（含 `effectiveQuotaGateClearedAt()`）共享 `quotas.google` 读数；
    - 冷却、失败与接管：`effectiveFamilyCooldown()`、`earliestResetCountdown()` / `earliestAvailableCountdown()`、`recordFailure()` / `recordSuccess()` / `clearCooldown(..., includeQuotaBench)` / `createLiveQuotaController()` / `advanceAccount()` 在 `google` ↔ `argon` 间双向联动，防止 Orchestrator (Argon) 在子代理/执行模型触发 `google` 429 后重试回同一冷却账号；
    - CLI `/usage` 刷新（`refreshAccountQuotaPipeline`）与 REST summary 一致，使用 `shouldReleaseOrphanedCooldown()`（以 `hasDedicatedGroup(id, 'argon')` 为前提）守卫 `clearCooldown(id, 'argon')`，避免稳态共享组账号刷新配额时误删仍在生效的 429 冷却；
    - 展示收口：`accountKnownFamilies()` 与 `AccountsPanel` 在共享组账号上不额外渲染幽灵 `Argon` 卡片行或重复冷却标签，`QuotaPanel` 与 `/agy pool` 通过 `effectiveFamilyCooldown()` 读取有效冷却。
- **argon 行唯一的替代数据源是 argon 自己的模型行**（2026-11-23 决策）：后端不发 `argon` 组但模型列表里有 `gemini-4-argon-*` 时，用这些模型行自己的周额度读数建 `argon` 行，绝不读 `google` 的聚合值。
  - 已知取舍：若某个 agy 版本（如 1.5.5）把 argon 折叠进共享 Gemini 桶，argon 模型行的读数就是该桶的镜像，此时 `argon` 行会呈现镜像值。这是「绝不跨族借用」换来的代价，优于把健康 argon 判死或把见底 argon 放过。
  - 反向也不允许：`google` 的模型列表里不再出现 argon 行，避免 Gemini 面板被 argon 污染。
- **`accountHasArgon()` 仍保留 `google.models` 里出现 argon 模型的判据**：这不是 fallback，而是为了兼容旧版本已把 argon 模型行落盘进 `google.models` 的历史数据（以及 `agy` 把 argon 成员列进共享组 catalog 的形态）。
- **argon 模型行只出现在 `argon` 族**：gemini 模型面板不再混入 argon 行。
- `refresh.ts` 的 dedicated-group 记账**不变**：只有组名/bucket 名才是「独立池」证据；无组时清除 argon 行与冷却，因此「无组 + 有未读数」不会残留成假 argon 行。
- 锚点：`test/domain/argon-independence.test.ts`；同时更新 `test/domain/account-models.test.ts`、`test/integration/phase2-backend.test.ts`、`test/features/quota/quota-*.test.ts` 中守着旧折叠行为的断言。

## 额度汇总被拒绝的两类终态（issue #137）

`retrieveUserQuotaSummary` 可能对账号给出**终态**拒绝，且作用域不同，必须分开：

| 判定 | 触发 | 压制对象 | 周期 |
| --- | --- | --- | --- |
| `no_license` | 403 且正文含 license | **整个账号**退出后台轮询 | 6h（新许可随时可能到达） |
| `no_summary_access` | 403 且 `status = PERMISSION_DENIED` | **仅汇总请求**；`fetchAvailableModels` / 用户额度照常 | **有 5h 证据**（已上报过 5 小时窗口）= 1 小时；**无 5h 证据** = 7 天（对齐周配额周期） |

**「独立 Argon 池」的判据只有一条，两条链路必须共用（#130/#131/#169）**：组**名**或 bucket 的 id/displayName 含 argon。**description 不是证据**——agy 的共享 `Gemini Models` 组会在 description 里枚举成员（"… Gemini 4 Argon …"），用它会把整个 Gemini 池误判为独立 Argon 池。该规则适用于 **REST summary** 与 **CLI `/usage`** 两条路径（`summaryHasArgonGroup` / `ingestSummaryGroups` / `usageGroupsToFamilies`）；description 仅可用于**正向家族归类**（如含 gemini → google），不得用于证明"独立池"。

**判定顺序不可颠倒（#142）**：真实 403 正文可能**同时**含 `license` 字样与 `PERMISSION_DENIED`。`status` 是结构化的 API 级结论，必须优先于 message 文本匹配；若先匹配 license 正则，免费档分支就变成死码。仅含 license 字样而无该 status 时仍判 `no_license`——两个分支都要有测试保证可达。

- `quotaSummarySuppressed(account)` 对两类都返回 true（都意味着「先别打那个端点」）。
- `accountPollSuppressed(account)` 只对 `no_license` 返回 true；`shouldPollAccount()` 用它决定账号是否完全退出轮询——免费账号**必须继续轮询**，否则模型列表会被冻结。
- 手动刷新（`force`）绕过压制，用户升级后可立即恢复。
- UI 对 `no_summary_access` **必须区分是否真有 5h 窗口**（四语言 locale）：
  - 无 5h 证据 → 「免费账号 · 仅限周配额（汇总接口被拒绝）」。
  - **有 5h 证据 → 绝不能写「免费账号」**：该账号同一张卡片上还挂着 Pro 徽章和 5 小时额度条，文案与事实互相打脸（2026-11-23 实测 4/7 账号出现）。改用中性的「汇总接口被拒绝（403 PERMISSION_DENIED）· 5 小时/周汇总未更新」。
  - 判定依据必须与 `resolveAccountPlanTier` 一致（`!ev.has5h`），不得另起一套。
- 锚点：`test/integration/issue137-free-tier-summary.test.ts`（分类、两类压制边界、轮询不变式、周期常量）。

## 额度新鲜度：用完即刷 + 可调全量扫描（2026-11-23）

全量扫描（`refreshAllQuotas`）默认 **60 分钟**一次（`quotaPollIntervalMs`，运行时可用 `/agy config quota-poll <分钟>` 或设置路由 `quotaPollIntervalMs` 调整，下限 60s）。60 分钟意味着"正在烧额度的那个号"最多显示一小时前的数字——这是用户报告"更新不及时"的根因。

修正：**把刷新花在正在使用的账号上**，而不是提高全池扫描频率（后者是封号风险的主因）。

1. **用完即刷**：`AccountPoolManager.recordSuccess()` 与"因失败切到新号"分支触发 `onAccountUsed(accountId, family)`；host 侧 `AccountQuotaRefresher` 只刷新该账号。
2. **节流 5 分钟**（`QUOTA_ACCOUNT_REFRESH_MIN_GAP_MS`）：路由钩子每回合都会触发，不节流会打爆配额端点；5 分钟同时约束 Google API 与 `agy -p /usage` 进程 spawn（凭据槽持有者走 CLI）。
3. **绝不阻塞回合**：`trigger()` 是 fire-and-forget，刷新抛错被吞掉——额度是咨询性数据，不能因此让一回合成功/失败。
4. **边界**：这是最终一致性，不是实时。面板仍逐族显示 `updatedAt`，过期窗口按上一节标注"数据停留在 X"。
5. **未采纳**：阻塞式"切号前预检"（在 `selectSessionAccount` 里 await 刷新）—— 会与即将 spawn 的 agy 抢凭据槽并引入秒级延迟；改用"切号即刷新新号"（上面的失败切换分支）。
6. 锚点：`test/features/quota/quota-freshness.test.ts`（节流、吞错、stale 判定、recordSuccess 触发）。

## 卡片一致性：同一张卡不得自相矛盾（2026-11-23）

账号卡片同时展示「套餐徽章 + 各模型族配额条 + 失败提示 + 时间戳」，四者来自不同字段，必须彼此自洽。

1. **文案不得与可见数值冲突**：标着 Pro 徽章、挂着 5 小时额度条的账号，不得被写成「免费账号」。判定依据统一走 `resolveAccountPlanTier` 的 `ev.has5h`，见上一节。
2. **重置时间已过期的窗口不得裸奔**：`resetTime` 已过 = 窗口已滚动，缓存的 `remainingFraction` 描述的是**上一个**窗口。
   - `>= 100%` → 「已重置 · 可用」（既有行为）。
   - `< 100%` → **必须**标「窗口已重置 · 数据停留在 {该族 updatedAt}」，绝不能只渲染一个不带任何时间标记的百分比（实测：91% 且采用 33 小时前的边界，看起来像实时数据）。
   - 锚点：`test/client/quota-panel-consistency.test.ts`。
3. **按族合并写入意味着单卡多时间戳是合法的**：`updateAccountQuotas()` 逐族合并，某族刷新失败不会清掉其它族。`mergeFallbackFamilyQuota` 在摘要非权威时**保留上一份完整值及其 `updatedAt`**，因此「argon 刚刷新、google 停在两天前」是预期状态——正因为它是预期状态，UI 才必须逐族标出新鲜度，而不能让整卡看起来同一时刻。
4. **不要用「按最新时间戳渲染」抹平差异**：把整卡的 `updatedAt` 取最大值会让旧族伪装成新数据，属于伪造新鲜度。
5. **「当前使用」必须是事实，不能是预测**（2026-11-23 实测：Orchestrator/Argon 会话实跑 `ele`，面板 Argon 行却标主账号为「当前使用」）：
   - `markAccountActive(id, family)` **按族**记录真实使用的账号：写 `activeAccountIds[family]`，只有 `google` 才动全局 `lastActiveAccountId`，且**不**写 `manualPinAtByFamily`（运行使用不是用户手动钉选）。
   - 无真实钉选的族由 `resolveEligibleActiveAccountId` 回退算出的是**预测**，UI 必须标「预计使用」（`account.predictedInUse`，弱化配色），不得标「当前使用」。
   - 锚点：`test/domain/active-account-scope.test.ts`。

## 刷新成功后必须清除 unavailable 标记（issue #151）

`quotaUnavailable` 是「当前额度不可信」的标记，任何**真正拿到新鲜数据**的路径都必须清除它，而不只是 REST/汇总分支。

- CLI 优先路径拿到 families 后**提前 return**，早于拥有 `clearQuotaUnavailable` 的汇总分支——于是接口故障期间写入的 `unreachable` 会一直残留，面板持续显示旧时间戳，而存储额度其实在推进。
- 规则：**谁证明数据是新鲜的，谁负责清标记**。CLI 成功 → clear；汇总权威 → clear；只有「什么都拿不到」才保留/写入。
- 锚点：`test/integration/issue137-free-tier-summary.test.ts`（CLI 成功后清除；CLI 无数据时不动标记）。

## 6. 全路径额度耗尽统一自动切号对齐（主代理 / 子代理 / 辅助路由 / 工具）

所有请求入口（主会话 `AgyAdapter`、内嵌子代理、辅助路由 `isAux`、`runAgyOnce`/`agy_ask`、`ImageService`/`agy_image`、`TranslationService` 与 `runAcpAttempt`）必须遵守同一套「硬配额耗尽即冷却并切向下一个健康账号」契约，同时严格保留 `TOS_VIOLATION` 终态防连坐熔断：

1. **带部分输出（partial response）或 `end_turn` `⚠` 横幅的硬配额失败绝不可吞成成功**：
   - 当 `agy`（CLI `-p` 或 `acp`）在输出过部分文本/工具后返回 `status: ERROR` 且 `error`/`response` 匹配 `isHardQuotaResultError`（如 `RESOURCE_EXHAUSTED (code 429): Individual quota reached`），**或者** `agy` 将硬配额拒绝包装成末尾独立的 `⚠` 警告行（如 `⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.` / `⚠ Your AI credits balance is too low...`，判定函数 `isAgyQuotaBannerLine` / `extractAgyQuotaBanner`）并以 `end_turn` / `ok: true` 结束回合时：`EventMapper`（跨分片暂存并剥离 `⚠` 配额横幅，避免向用户泄露或污染重试流）、`RunRecording`、`classifyRun()` 与 `runAcpPrompt()` 必须判定为**不可消费失败**并映射为 `Err.RATE_LIMIT`，冷却当前账号（优先解析精确重置时长）并切号重试，严禁调用 `recordSuccess()`、以 `stop` 结束或在未冷却切号时回落到同账号 CLI `-p`。
   - 非配额类的工具报错但带有效答复（如 `Find command timed out.`）或非配额 `⚠` 正文警告（如 `⚠ 端口 8080 已被占用`）保持既有收尾语义，绝不误判为配额冷却。
- **`agy` 内部子代理、主对话 429 死循环与图像/委派工具实时配额熔断切号（`SubagentTracker` + `ParentQuotaMonitor` + `src/provider/quota-failover.ts`）**：
   - 严禁从普通终端命令输出（如 `Command exited with code 1`）或未核验正文中误判 429；仅当满足可信来源约束（父对话 `transcript.jsonl` 来自 `SYSTEM` 的 `The subagent ... encountered an error` 通知、父对话 `transcript_full.jsonl` 中来自 `SYSTEM` 的 `ERROR_MESSAGE` 429 重试环与 `Stop hook blocked termination`、子代理 `transcript.jsonl` 终态 `ERROR`/`FAILED` 中包含权威 Google Cloud Code / `image failed to generate` / `agent executor error` 配额信号，或 `generate_image`/`invoke_subagent` 工具调用错误）且排除 ≤30s 瞬时 QPS 突发（`isTransientBurstRateLimit`，如 `RATE_LIMIT_EXCEEDED` `1s`）与 `TOS_VIOLATION` 时，才判定为硬配额耗尽。
   - 主对话 429 重试熔断器（`ParentQuotaMonitor`）增量尾随 `transcript_full.jsonl`（尚未生成时回退 `transcript.jsonl` 并在出现后平滑切换）：收到健康 `PLANNER_RESPONSE`（非 ERROR）或 `GENERIC` (`status === 'DONE'`) 时清零计数；连续出现 2 次权威 `QUOTA_EXHAUSTED` / `Individual quota reached` / `reset > 30s`，或连续 3 次通用 `RESOURCE_EXHAUSTED (code 429)`，或在本轮已出现过 429 计数后紧随 `Stop hook blocked termination` 时，立即发射 `source: 'parent-retry-loop'`。
   - 实时检测到硬配额耗尽后，立即对耗尽的模型族（若错误信息指定了 model 则优先归属该模型所属族）执行 `pool.recordFailure(..., serverResetTime)`，并检查池内是否还存在满足主模型及耗尽族资格的替代账号：若存在则 `proc.kill('quota')`（保留非 aborted/timeout 状态以映射为 `RATE_LIMIT`），让上层立刻在替代账号重放；若不存在替代账号，子代理/工具路径仅记录冷却而不强杀仍在运行的主进程，而 **`parent-retry-loop` 在 `!alt` 时同样立即 `proc.kill('quota')`**（主对话本身已陷死锁），直接以 `RATE_LIMIT` 结束阻塞。
   - `handleAttemptOutcome()` 必须先 `await finalizeAttempt(...)` 完成冷却与切号落盘，再 `rec.settle(failure)` 唤醒上层消费方。
3. **重试深度跟随池容量并覆盖非 `llm-retry` 路径（含后台辅助模型弹性回退）**：
   - `providerRetryPolicyFor()` 按 `Math.min(Math.max(1, enabledAccounts - 1), 16)` 放开 `poolHops`，不再硬截断在 2 跳导致多号池提前放弃。
   - `streamWithEffortRetry()` 对不经过 `@deepseek-ai/dsh-llm-retry` 的 `isAux` 辅助路由在未产出任何实质输出前遇到 `Err.RATE_LIMIT` 时，在池内按 `enabledAccounts - 1`（上限 16）自动切号重放（绝不重放 `TOS_VIOLATION`）。
   - **后台辅助调用（`compaction` / `session-title`）模型弹性**：DSH 发起 `compaction` 时可能携带过期 `modelSelection.lastUsed`；`AgyAdapter` 优先读取会话最新 `model/selection`（同 provider）覆盖过期模型；当请求的稀缺模型（如仅少数账号支持的 `gemini-pro-orchestrator-neon`）在全池均无可用账号时，`selectSessionAccount(..., { allowAuxModelFallback: true })` 与 `streamWithEffortRetry()` 自动按同族主力（`PREFERRED_GEMINI_FLASH` → `PREFERRED_GEMINI_HYDROGEN` → `PREFERRED_GEMINI_ARGON` → 跨族主力）挑选有可用账号的模型完成压缩/标题生成，且绝不改写用户会话的模型选择器；常规聊天（`chat`）保持严格校验不静默降级。
   - `runAgyOnce()`（`agy_ask` / `/agy ask`）、`ImageService`（`agy_image` 含工具级 429 `QUOTA_EXHAUSTED` 检测与独立 `quotaHops` 预算）与 `TranslationService`（按 `poolQuotaHops` 放开 `RATE_LIMIT`/`QUOTA` 重试上限，非配额错误仍受 `translateRetries` 约束）均接入统一冷却与切号循环；全池无可用账号时明确报错，**严禁**回退到 `account = undefined` 悄悄消耗系统主账号。
4. **单模型粒度主动让路（`isQuotaBenched`）**：
   - 当某族缓存配额的 `models` 列表包含匹配请求模型（`modelMatches`）的条目且**所有匹配条目**的剩馀比例均 `<= LOW_QUOTA_WEEKLY`（0.05）且处于有效重置窗口内时，即使该族宏观均值仍高于 `0.10`，预选阶段也直接判定该账号对该模型进入配额让路（`quotaGateClearedAt` 覆盖规则不变）。
- **验证锚点**：`test/features/quota/quota-failover-alignment.test.ts`。

## CLI 配额轮询不得使用即将失效的 token（PR #160）

agy 启动时从凭证库取 token，该读取只有 10 秒预算。token 已过期或在该窗口内过期时，刷新会输掉竞争，agy 回退到**交互式 OAuth（弹浏览器等人）**。

- 实测：375 次每小时轮询中 9 次触发交互登录（2.4%），**全部 token 寿命 ≤60 秒**；≥1 分钟的 746 次零触发。
- 规则：CLI 轮询前要求 token 仍有 `CLI_TOKEN_SAFETY_MS`（2 分钟）寿命；不足则先刷新，仍不足则**跳过本轮 CLI，改用 REST**。跳过一轮无代价，弹浏览器窗口则以用户注意力为代价。
- **Windows 主账号存储一致（issue #199）**：`cliTokenSource(platform, account)` 对 Windows `systemHome` 主账号返回 `'slot'`（检查凭据管理器 `gemini:antigravity` 而非 `.primary-credential.json` 镜像）；刷新后 `syncSlot`（`syncPrimarySlotFromStore`）**必须**按 `sameCredentialTokenState` / `isSlotAtLeastAsFresh` 校验 `accessToken` 与 `expiryMs`，严禁只凭 `sameCredentialGrant`（仅比对 `refreshToken`）跳过写槽，同时不得用旧镜像覆盖槽内更新的凭据。
- 不要把"几秒钟的聪明"引入每小时才跑一次的轮询——边际取得足够宽，比精确贴近失效点更重要。
- 锚点：`test/features/quota/quota-cli-token.test.ts`（121 行纯函数 + 用例）。

## ACP 的 `usage_update` 不是用量样本（PR #165 / issue #158）

agy 1.5.x 的 `session/update`（`usage_update`）**只带 `{ used, size }`**——那是上下文窗口占用，**不是**本次调用的计费 token。

- **不得**把 `used` 写入 `input_tokens`：那会让该轮最终 usage 变成 `{ inputTokens: used, outputTokens: 0 }`，导致缓存命中率 0%、输出速度 0 tok/s、未缓存输入虚高。真实数字只在 `PromptResponse.usage` 里。
- `used` 仅作诊断记录（`lastContextUsed`）。只有当更新真的携带 `cachedReadTokens` / `outputTokens` 时才可作为用量样本。
- 通用原则：**「上下文占用」与「计费用量」是两个量，永不互相替代。**
- 锚点：`test/integration/usage-acp.test.ts`（178 行）。

## 模型级 429 不得冷却整个模型族（2026-11-23）

- 实测：账号 `ele`（Pro，Google 族还剩 20%，Argon 80%）被一次**图片模型** 429 打进 4h32m 的 `google` 冷宫：
  `ResourceExhausted, HTTP 429: You have exhausted your capacity on this model. Your quota will reset after 4h32m32s.`
  该消息被 `looksLikeHardRateLimit`（`exhausted your capacity`）命中，随后 `generate_image` 又被当作族级配额，`recordFailure(family=google, reset=+4h32m)` → 整个文本族被冷却，而所有文本模型其实还有额度。
- 建模：Google 的配额维度本来就是 **per-model**，`google` 族只是我们的聚合。图片模型（`gemini-3.1-flash-image`）是族里的一个**独立桶**，因此可用性必须分两层：族级 `cooldowns[family]` + 模型级 `modelCooldowns[baseSlug]`（持久化在 `pool.json`）。**不要**为图片新建 family/账号池：没有独立的图片配额组，也没有另一批图片账号，缺行还会被误判成“永远可用”。
- 契约：
  - **判定**：`explainIneligibility(acc, family, now, pool, model)` 对 `modelCooldowns[model]` 未过期返回 `model-cooldown`；`isModelQuotaClear(acc, family, model, now)` 单独回答“这个模型的桶还有额度吗”。
  - **选择**：`selectAccount(family, model?, quotaModel?)` 支持第二个配额维度；图片路径用 **`findAccount(...)`（不移动 active 指针）**，再叠加 `avoidAccountIds` 做本请求内的局部轮换。
  - **记录**：模型级 429 只写 `recordModelFailure(account, model)`，**不写族冷却、不 `advanceAccount`**；成功调用 `recordModelSuccess` 清掉该模型冷却。`generate_image` 的工具级 429 由工具名直接绑定图片模型 id。
  - **不再中断**：子代理/工具层面的模型级 429 只暂停该模型并提示，**不 kill 当前 run、不切账号**（此前会中断整轮，正是双会话同时中断的放大器）。
  - **UI**：族条保持健康（76% 仍是 76%），卡片下补一行 `单模型暂停: gemini-3.1-flash-image → 20:46`。
  - **迁移**：`PoolAdmin.dropModelScopedCooldowns()` 在池初始化时清掉历史遗留的模型级族冷却（reasons 命中模型级签名者）；用户的「清除冷却」同时清空该账号全部模型桶。
- 只有 `Individual quota reached` / 纯 `RESOURCE_EXHAUSTED` 这类**账号级**拒绝才允许族级冷却。
- 锚点：`test/domain/model-cooldown.test.ts`（族不被冷却、跨重启持久化、按 image 桶预筛、ImageService 局部轮换且指针不动）、`test/features/quota/model-scoped-quota.test.ts`、`test/features/quota/quota-failover-alignment.test.ts` 第 5/8 题。

## CLI `/usage` 超时后的负缓存（同步慢的根因）

- 实测 2026-11-23：单个账号点「同步」耗时 **19.1s**。日志显示 `agy -p /usage --output-format stream-json` 在 `loadCodeAssist` 上花了 ~13s，随后 `Language server shutdown timed out`，撞满 20s 预算后 REST 兜底只用 ~1s。
- 契约：每个账号维护 `cliUsageSkipUntil`；`readAgyUsage` 返回 `null`（超时/失败）后，**10 分钟内**跳过 CLI 直接走 REST（`CLI_USAGE_TIMEOUT_RETRY_MS`）。一次超时之后，后续同步 ~1-2s。
- 不要把超时预算调大来「修」慢：探针没有返回，加大预算只会让每次点击更慢；CLI 是防封首选，但连续超时的探针必须暂时让位给 REST。
- 锚点：`test/features/quota/model-scoped-quota.test.ts` 的「CLI usage negative cache」用例。
