# 凭据生命周期与鉴权状态机（唯一事实源）

> 维度：**一个账号的 OAuth 凭据何时可用、何时必须刷新、何时判定需重登或终态不可用，确保零误判「需重新登录」**。

## 1. 唯一凭据写入器与跨平台同步

`buildAgyCredentialDoc(tokens, now)`（`src/host/oauth.ts`）是 agy 凭据文档的**唯一**构造器：

| 落点 | 调用方 |
| --- | --- |
| `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token`（原子写 `0600`） | `writeAgyTokenFile()` / `persistRefreshedToken()` |
| Windows 凭据槽 `gemini:antigravity` + `.primary-credential.json` | `PoolAuthFlow` 主账号登录与导入分支 |
| macOS 登录钥匙串 / Linux Secret Service（`service=gemini, account=antigravity`） | `PoolAuthFlow` 主账号登录与导入分支同步更新，防止旧失效钥匙串凭据遮蔽新磁盘文件 |

不变式：
- 文档**必须**带本地时区偏移 ISO `expiry`（`tokens.expiryMs`；缺失时用 `now + 1h` 有界兜底，issue #112）；后台配额刷新的 `persistRefreshedToken()` 同样必须复用 `writeFileAtomicSync(..., 0o600)` 原子写入，严禁原地截断裸写。
- 主账号完成 OAuth 登录（`finishWithCode` 的 `primary` 分支）或导入 `refresh_token`（`importRefreshToken` 的 `systemHome` 分支）后，**必须**同步写入系统钥匙串/凭据存储（Windows 下 `writePrimaryCredential` 传入 `this.pool.dir`）并调用 `pool.clearAuthRequired(primary.id, true)`；新入池隔离账号若当前 MCP 桥已启用则同步写入隔离目录 MCP 配置。
- **一键原地重登（In-Place Re-Authentication）**：`POST /plugins/agy-link/pool/begin-add` 支持可选 `accountId` 参数，对主账号路由至 `poolAuth.beginPrimary()`、对隔离账号路由至 `poolAuth.beginAccount(accountId)`（带邮箱一致性校验），前端异常卡片提供一键「重新登录」按钮原地恢复凭据而绝不创建重复账号槽位。
- **`PoolAdmin.recordSuccess` 与跨进程持久化安全**：`recordSuccess()` 不得清除 `isTerminalAuthError`（如 `TOS_VIOLATION`）终态隔离；`PoolStore.persist()` 在多进程共享 `pool.json` 时合并磁盘上更新的 `quotas`、更晚的 `cooldowns` 以及终态 `TOS_VIOLATION` 标记，防止 Web 与 CLI 进程互相覆盖状态。

## 2. 新鲜度判断与防过期 Token 泄漏

`isAccessTokenFresh(tok, now)`（`src/features/quota/token.ts`）：只有**已知且未来**（`> now + 60s`）的 `expiryMs` 才算新鲜。

- **禁止在刷新因网络失败时回退返回已过期的 `accessToken`**：当 `!isAccessTokenFresh(tok)` 且 `refreshTokens()` 因代理/TLS/5xx 等瞬时故障抛错时，`getValidAccessToken()` **必须返回 `null`**（仅当 `tok.expiryMs` 缺失、无法本地证伪时才允许尝试现有 token），杜绝下游拿着已知过期的 Bearer token 请求接口收到 HTTP 401 后误判账号需重登，同时消除向 Google 发送必败 401 请求的风控噪声。
- **OAuth `invalid_grant` 二次退避确认**：参考 `Antigravity-Manager` 实战经验，`refreshTokens()` 首次遇到 `invalid_grant` 时延迟 `500ms` 重试一次确认，排除 Google 边缘节点瞬时状态同步抖动。

## 3. 权威鉴权错误判定（零误判红线）

`isAuthoritativeAuthError(message)`（`src/common/types/failures.ts`）**仅匹配精确的 OAuth / 账号撤销错误码**：

- 匹配：`invalid_grant`、`invalid_client`、`unauthorized_client`、`token_revoked`、`account_disabled`、`user_disabled`、`token has been expired or revoked`、`TOS_VIOLATION`。
- **严禁裸匹配宽泛词 `disabled`**：`agy` 运行日志中常含 `auto-update disabled`、`telemetry disabled`、`sandbox disabled`，或普通报错含 `model is disabled`；裸匹配 `/disabled/i` 会短路 `looksLikeAuthVerificationJitter()` 并绕过 `AUTH_CONFIRM_STRIKES = 2` 直接将健康账号打入 `authRequired`！
- **同秒日志增量读取（`src/host/agy-log.ts`）**：`snapshotAgyLogs()` 记录 `Map<filename, byteOffset>` 而非仅文件名集合；同一秒内多次 `agy` 进程共享同一 `cli-YYYYMMDD_HHMMSS.log` 时，`readAgyRunLogText()` 按字节偏移读取新增尾部，确保 `keyringAuth: timed out` 等网络抖动证据永不丢失（issue #71 深化）。
- **第三方 MCP 鉴权错误隔离**：stderr 中明确带 MCP 服务前缀的鉴权报错不归因于 Google Antigravity 账号登出。
- **Windows 凭据槽瞬时网络错误与文件缺失解耦**：`resolvePrimaryCredentialAt` 因网络不可达无法在线核验主账号身份时，抛可重试瞬时错误而非把当前调度的辅账号标为 `authRequired`；仅当账号自身凭据文件确实缺失或损坏时才标 `authRequired`。
- **macOS 启动钥匙串自愈无损化（`boot-hygiene.ts` / `keychain.ts`）**：`security` 命令超时不删除隔离钥匙串文件；`restoreTokenFromMacKeychain` 复用统一的 `parseGoKeyringPayload`（同时兼容 `go-keyring-base64:` 与明文 JSON）。
- **macOS/Linux `systemHome` 与 OS 钥匙串互不踩踏（`token.ts` / `services.ts`）**：
  - 隔离池账号使用各自目录的 `Library/Keychains/login.keychain-db`（macOS）与 `.gemini/antigravity-cli/antigravity-oauth-token`，绝不触碰系统默认钥匙串；仅 `systemHome`（`acc_primary`）与 `Antigravity.app` / 系统终端 `agy` 共用单一钥匙串项（`service=gemini, account=antigravity`）。
  - 非 Windows 下对 `systemHome` 刷新 OAuth token 时，落盘前再次校验实时系统钥匙串 `refreshToken` 未切换；若用户在刷新途中于 `Antigravity.app` 切号则直接丢弃本次旧响应，且当 `~/.gemini/antigravity-cli/antigravity-oauth-token` 不存在时不创建磁盘残片。
  - `ModelCatalog` 全局发现回退严格跳过已禁用/异常的 `lastActiveAccountId` 与 `primaryAccountId`（`pickEnabled`）；当池内所有账号均停用或不可用时拒绝回退真实 `HOME` 触发无隔离 `agy models`。

## 4. 结构化异常态：区分「需重登」「需网页验证」与「终态封禁」

| 状态原因 | 判定特征 | 自动恢复语义 | UI 呈现 |
| --- | --- | --- | --- |
| `TOS_VIOLATION`（终态封禁） | `TOS_VIOLATION` / `violation of Terms of Service`（含 `appeal_url`） | **粘性隔离（#114）**：`clearAuthRequired(id, false)` 与 `needsAuthReverify()` 均不清除；仅用户显式重新授权/导入（`force = true`）可解除 | 显示「服务受限 / 申诉」及可点击 `appeal_url` |
| `VALIDATION_REQUIRED`（临时人机/手机验证） | `VALIDATION_REQUIRED` / `Verify your account`（含 `validation_url`） | 允许后台重验与验证完成后恢复 | 显示「需安全验证」及可点击 `validation_url`，不误导重走 OAuth |
| 普通 `authRequired`（凭据过期/撤销） | 连续 2 次确认或权威 `invalid_grant` | 任意有效请求/配额成功即自动 `clearAuthRequired(id, false)`；满 `AUTH_REVERIFY_DELAY_MS`（10m）允许后台自愈重验 | 显示「需重新登录」 |

## 5. 测试锚点

- `test/failure-classifier.test.ts` / `test/auth-jitter.test.ts`：`disabled` 日志不误判权威鉴权失败、同秒日志偏移读取、MCP 错误不误判、HTTP/2 `GOAWAY` 与代理 `502/504` 归类为 `NETWORK`。
- `test/credential-slot.test.ts` / `test/issue101-slot-failover.test.ts`：主槽网络超时不连坐隔离辅账号、带 `expiry` 唯一写入。
- `test/pool-auth.test.ts`：主账号 OAuth 登录与导入清除 `authRequired` 并触发选择器同步。

## 账号显示名（alias）与 `defaultAlias`（issue #152）

- `alias` 是卡片上的**显示标签**；`defaultAlias === true` 表示它仍是「自动生成」的占位（`备用 Google 账号 N` / 主账号默认名），界面会按 locale 重新渲染。
- 用户手动改名必须走 `setAccountAlias()`——它同时 `trim()` 并置 `defaultAlias = false`，否则输入的名字永远不会被显示（界面仍在渲染生成标签）。
- 路由 `POST /plugins/agy-link/pool/alias` 是唯一写入口：非空、长度上界、未知 id → 404。空名会让卡片无标签，因此服务端直接拒绝而不是静默接受。
- **主账号换号自动重置旧别名（issue #152 第二部分）**：当 `systemHome` 主账号通过 `/agy auth` 重新登录为**不同 Google 邮箱**时，`resetAccountIdentity(id, email, true)` 同步重置自定义旧别名并恢复 `defaultAlias = true`，防止卡片仍展示上一个账号的名称。
- 锚点：`test/issue152-alias-edit.test.ts`、`test/slice3-ssh-tier-143-145-152.test.ts`、`test/http-contract.test.ts`（路由表面登记）。

## 6. 三端免全局钥匙串隔离（`SSH_CONNECTION`）与外部独立登录保护（issue #145）

- **`SSH_CONNECTION` 隔离（`agy >= 1.5`）**：`isolatedHomeEnv()` 为所有带独立 `dir` 的隔离池账号注入 `SSH_CONNECTION="127.0.0.1 0 127.0.0.1 0"`，`agy 1.5+` 将其识别为远程 SSH 会话并直接读写各自 `dir/.gemini/antigravity-cli/antigravity-oauth-token`，三端（含 Windows）绕开全局共享钥匙串/凭据管理器。Windows 下当 `supportsSshIsolation(agyVersion)` 成立时，隔离辅账号免除全局凭据槽排队与 ACP 切号驱逐，且 `QuotaService.readCliUsageFamilies` 可直接为隔离账号（含免费账号，issue #143）执行官方 `agy -p /usage`。
- **外部独立登录保护（issue #145，`respectExternalSignIn`）**：`src/domain/credentials/external-guard.ts` 追踪插件上次写入 Windows 凭据槽的指纹（`.last-installed-slot.json`）；当配置 `respectExternalSignIn: true` 且检测到用户在独立 `agy` 终端中重新登录了未识别的外部账号时，租约获取前拒绝覆盖并在租约释放后保留外部登录。锚点：`test/slice3-ssh-tier-143-145-152.test.ts`。

## 7. 外部进程凭据租约（External credential lease）

- **问题**：Windows 凭据槽的同号快路径计数与辅账号引用计数只存在插件进程内存里。自己启动官方 `agy` 的外部进程（如 `dsh-codex-conductor` 的 WSL runner，长任务需扛过 DSH 重启并自行消费 stream-json）对插件不可见：插件可能在它运行中切槽，它也无法以池内辅账号身份运行。
- **原则：不新增切换逻辑**。`ExternalLeaseRegistry`（`src/host/external-lease.ts`）只是插件自身运行用的同一套部件的又一个调用方：`pool.selectAccount(modelFamilyOf(model || 'gemini'), model)` 选号 → `acquireCredentialSlot()` 取槽（`baseDir: pool.dir`、`proxyUrl` 按「账号 > 全局 > 系统代理」、`parallel: cfg.parallelSameAccount`、`respectExternalSignIn: cfg.respectExternalSignIn`，与 provider 相同）→ 释放时由共享的 `settleRunFailure()` 结算。
- **失败分类唯一实现**：`src/host/run-settlement.ts` 的 `settleRunFailure()` / `settleSlotUnavailable()` 从 one-shot 原样抽出（顺序：TOS → `--effort` 拒绝 → 硬额度（排除瞬时突发限流，按错误里的模型族冷却并在族不同时 advance）→ 模型不识别（`markModelUnsupported` + advance）→ 地区资格（advance）→ 登出（`shouldMarkAuthRequired` 时 `noteAuthFailure` + advance）→ 其它不可消费失败），one-shot 与外部租约共用，不得再各写一份。
- **钉住账号**：`accountId` 或 `accountDir`（Windows 下路径大小写/尾分隔符不敏感）钉住续接对话所属账号；只要求存在、启用、未 `authRequired`，**不检查冷却**。不钉住时 `SlotUnavailableError` 按 one-shot 规则结算（`markAuthRequired`，或主账号重申失败的隔离辅账号只 advance）后换下一个可选账号，同一账号不试两次。
- **等待有界**：`waitMs` 默认与 one-shot 相同（`dispatchTimeoutMinutes × 60000`，未配置 60000），上限 1 小时；多次换号共享同一截止时间，剩余时间耗尽即 `slot_timeout`，绝不传 `0`（`0` 对槽表示无限等待）。
- **生命周期**：租约仅在内存；DSH 宿主重启全部丢失，客户端重新 acquire。TTL 默认 120s、夹到 15s–600s；`unref` 的清扫器每 5s 释放过期租约且**不结算**并记日志。`release` 恰好释放一次槽；`dispose` 中止排队中的取槽、释放全部租约、移除路由与发现文件。租约 id 为 128 位 `crypto.randomBytes`。
- **发现文件**：`<pool.dir>/.link-endpoint.json`（`{url,pid,startedAt}`，原子写）；卸载时仅当文件仍指向本进程 pid 与 url 才删除，另一个宿主接管后不误删。
- **非 Windows**：取槽为空操作（`undefined` 租约），选号、TTL 与结算照常。测试运行（`NODE_TEST_CONTEXT`）下默认取槽同样为空操作，永不触碰真实凭据管理器。
- 锚点：`test/external-lease.test.ts`、`test/lease-routes.test.ts`、`test/run-settlement.test.ts`。
