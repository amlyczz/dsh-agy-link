# Changelog

## 0.6.74 (2026-11-24)

### English

- **Feat(credentials): external credential leases with bearer auth (merges PR #181, supersedes #173).** A process that launches the official `agy` itself — e.g. a long-running runner whose jobs must survive a DSH restart — can now borrow a pool account through the plugin's own selection, credential-slot and failure-settlement code, instead of fighting it for the machine-wide slot.
  - **Four routes** (`POST /lease/acquire|renew|release`, `GET /lease`) plus a discovery file `<pool dir>/.link-endpoint.json`.
  - **An isolated account on agy ≥ 1.5 is leased without the slot**: the lease prepares that account's token file and returns the exact `env` the caller sets on `agy`. The primary account (and isolated accounts on older agy) holds the slot for the lease's lifetime, like any in-plugin run.
  - **Auth (the point that blocked #173):** a 256-bit token is generated per plugin start and published **only** in the discovery file, which is written atomically with mode `0600`; on POSIX the owner and mode are verified after the write and the file is deleted if either is wrong. Every `/lease*` request must send `Authorization: Bearer <token>`, checked with `timingSafeEqual` **before** the cross-origin and method gates. No discovery file, no token, no lease.
  - **Bounded leases:** TTL defaults to 2 minutes (min 15s, max 10min) and a sweeper reclaims expired leases every 5 seconds, so a crashed external process cannot pin an account for ever.

### 中文

- **特性(凭证)：带 bearer 鉴权的外部凭证租约（合并 PR #181，取代 #173）。** 自己启动官方 `agy` 的进程——例如长任务必须跨 DSH 重启存活的 runner——现在可以通过插件自己的选号、凭证槽与失败结算逻辑**借用**池账号，而不是去抢那个机器级槽位。
  - **四条路由**（`POST /lease/acquire|renew|release`、`GET /lease`）加一个发现文件 `<pool dir>/.link-endpoint.json`。
  - **agy ≥ 1.5 上的隔离账号租约不占槽位**：租约只准备该账号的 token 文件，并返回调用方设置到 `agy` 上的确切 `env`。主账号（以及旧版 agy 的隔离账号）则在租约期间持有槽位，与在插件内运行完全一致。
  - **鉴权（正是当初拦下 #173 的那一条）**：每次插件启动生成 256-bit 随机 token，**只**公布在发现文件里；该文件原子写入且权限 `0600`，POSIX 下还会在写入后校验 owner 与 mode，任一不符即删除文件。所有 `/lease*` 请求必须携带 `Authorization: Bearer <token>`，用 `timingSafeEqual` 校验，且**先于**跨源与方法门禁。没有发现文件就没有 token，也就没有租约。
  - **租约有界**：TTL 默认 2 分钟（最小 15 秒、最大 10 分钟），并有每 5 秒运行的清扫器回收过期租约——外部进程崩溃也不会永久占住账号。

## 0.6.73 (2026-11-24)

### English
- **Fix(critical): a third-party MCP schema no longer fails EVERY turn.** `agy` declares the MCP servers it opens itself (godot, blender, computer-use, chrome-devtools) to Google verbatim, so ONE tool whose schema says `"type":"array"` without `items` makes the whole `GenerateContentRequest` fail with `400 INVALID_ARGUMENT … properties[vertices].items: missing field` — even when that tool is never called. `godot-mcp` 3.1.0 ships 12 such tools, which is why six consecutive turns on the reporting machine could never complete. The fix adds a **schema doctor**: `writeMcpConfig()` routes every foreign stdio entry through `dist/mcp-sanitize.mjs`, a transparent stdio JSON-RPC proxy that repairs `tools/list` with the same `sanitizeMcpSchema` + `enforceArrayItems` the reverse bridge already uses and forwards every other frame untouched; the original spec travels in `DSH_AGY_MCP_TARGET`, so teardown (or another host rewriting the registry) can always unwrap. `agy`'s stale per-tool descriptors under `<home>/.gemini/antigravity-cli/mcp/<server>/` — which still carry the broken schema — are dropped on rewrite. Verified live: all 217 tools from the four wrapped servers now declare zero item-less arrays.
- **Fix(critical): the idle sweep no longer kills a live turn at the 15-minute mark.** `lastUsedAt` only moved on OUTBOUND RPCs, but a mirrored-tool turn sends exactly one `session/prompt` and then streams updates for however long the agent works — so `evictIdle()` read a healthy 15-minute turn as idle and closed the process tree (`agy acp exited (code=1, signal=null)`). `AcpProcess.isBusy` (any `session/prompt` still pending) now exempts a process from both the idle sweep and capacity eviction, every inbound frame refreshes `lastUsedAt`, and a pool that is full of busy processes oversubscribes by one instead of killing someone's work.
- **Fix(critical): a retry of a process-killed turn spawns a new process instead of replaying the corpse.** A recording that settled with `PROCESS_EXIT` / `TIMEOUT` / `INVALID_OUTPUT` cannot be resumed, yet the adapter re-drove it, so all five retries failed in 8/10/8/8/193 ms and the user saw `本轮运行失败` with the retry counter exhausted. `isRevivableFailure()` now makes the adapter forget the dead recording and assemble a fresh attempt; account-scoped failures keep their `claimFailover` rotation path.
- **Fix(selection): a live conversation never hops accounts mid-thread.** `selectSessionAccount()` short-circuited to `pool.selectAccount()` on Windows (`parallelSameAccount`, the shared-credential-slot rule) BEFORE the session's own binding was consulted, so any other session or background run that marked a different account active silently moved the user's NEXT turn onto that account — and on Windows that swaps the global credential slot, changing which quota the turn spends. Session affinity now runs first on every platform; the pack-share rule still decides for sessions with no usable binding (fresh sessions keep converging on one slot). Regression: `test/host-branches.test.ts` (bound session beats the pool pointer on win32) plus the long-red `test/adapter.test.ts` sticky-account case, now green.
- **Fix(ui): the conversation header badge reports THIS session's model family, not the Gemini pointer.** Account selection is per family: an `Gemini 4 Argon` turn runs on the Argon-eligible account even when the `google` pointer names another one, and Argon bills its own weekly book. The badge resolved `pool.resolvedActiveAccountIds.google` unconditionally, so an Argon session announced a different account *and* that account's Gemini 5-hour percentage — contradicting the model in the composer and the console's Argon row ("菜单里显示的 Argon 不是这个账号"). A new `GET /plugins/agy-link/session-view?session=<id>` resolves the model actually selected for the conversation (`model/selection` event → `defaultModel` → last run), maps it to its family, then picks the account in the scheduler's own order — the session's sticky binding, the per-family pin, the side-effect-free eligibility prediction — and reads the percentage from THAT family's quota book. Measured on the reporting machine: the session showed `AGY · dao 98%` (dao's Gemini 5h) while it was draining account **ele**'s Argon pool (100% → 34% during the session); the badge now reads `AGY · ele` with ele's Argon weekly.
- **Fix(ui): the badge claims nothing before it knows the family.** A conversation whose view has not answered yet shows the account count only — no alias, no percentage — instead of borrowing another family's pointer. The session-less preview (settings, older hosts) keeps the historical google readout, so nothing else regressed. `sessionStickyAccount` is now exported from account selection so the readout reuses the exact predicate the scheduler uses instead of a second copy.
- **Fix(ui): a quota window whose reset boundary already passed is marked stale** (muted percentage + "window reset · data is old") rather than printed as a live number, and Argon never borrows a 5-hour slot it does not have.
- **Fix(ui): one alias rule instead of three.** The console card, the enable/disable toast and the header badge each detected a "generated default" alias by comparing the stored string with the old Chinese literal `主账号 (系统登录)`; a row written in any other language therefore showed its raw stored label on one surface and the localized default on another. `accountDisplayAlias()` now decides in one place (flag first, then "primary slot created before the flag existed") and all three call it. Tests: `test/account-alias.test.ts`.
- **Contract/docs:** `StatusPayload.lastRun`'s client type now matches what the host sends (`processOk`/`processCode`) instead of the phantom `ok`/`code`; `lastActiveAccountId` no longer documents itself as "the single source of truth for the in-use badge"; the duplicated doc block on `markAccountActive` is gone; the router comment no longer names a fixed route count.
- **Docs:** `docs/KNOWN-GAPS.md` records the third-party MCP failure mode — `~/.gemini/config/mcp_config.json` servers are loaded by agy itself and their raw schemas go to Gemini, so one array without `items` fails the whole turn (`...properties[args].items: missing field`). godot-mcp declares 12 of them; the plugin's reverse bridge hardens DSH-side schemas (0 violations on the same tools) but cannot reach a server agy opens on its own.
- **Fix(test): the neutral aux workspace assert is separator-agnostic.** `test/call-context.test.ts` compared `workspaceRoot.endsWith('/agy-link/aux-cwd')`, which can never hold on Windows (`…\agy-link\aux-cwd`) even though `auxWorkspaceDir()` builds the path with `path.join` correctly. The assert now normalises separators, so the Windows-only red is gone without weakening the intent.
- **Tests:** `test/mcp-sanitize-doctor.test.ts` (8 — the real godot shapes, end-to-end shim handshake, registry wrap/restore, stale-shim re-pointing, cache invalidation, missing-shim fallback), `test/acp-busy-idle-guard.test.ts` (3 — busy lifecycle, inbound-frame activity, idle/capacity exemption), and a `PROCESS_EXIT` revival case in `test/idle-grace-empty-result-and-dead-continuation.test.ts`.
- **Tests:** `test/session-view.test.ts` (9 — family resolution, sticky vs pin, prediction vs "in use", stale window, empty selection, unsupported family), `test/session-badge.test.ts` (4 — view wins, unanswered session claims nothing, legacy preview, rendered badge), `test/account-alias.test.ts` (4 — one alias rule), and `/session-view` added to the frozen HTTP surface with a behavior test (session model outranks `defaultModel`).

### 中文
- **修复(关键)：第三方 MCP 的 schema 不再让整轮请求失败。** `agy` 会把自己加载的 MCP 服务器（godot、blender、computer-use、chrome-devtools）的 schema 原样声明给 Google：只要有一个工具写成 `"type":"array"` 却没有 `items`，整个 `GenerateContentRequest` 就会 `400 INVALID_ARGUMENT … properties[vertices].items: missing field`——哪怕那个工具根本没被调用。`godot-mcp` 3.1.0 一次就声明了 12 个这种工具，这正是现场连续六轮都无法完成的根因。本次加入**schema 医生**：`writeMcpConfig()` 把所有外部 stdio 条目改为经 `dist/mcp-sanitize.mjs` 启动（透明 stdio JSON-RPC 代理，仅用反向网桥同一套 `sanitizeMcpSchema` + `enforceArrayItems` 修 `tools/list`，其余字节原样转发），原始 spec 存在 `DSH_AGY_MCP_TARGET` 里，所以卸载/另一宿主改写注册表时总能还原；同时清掉 agy 在 `<home>/.gemini/antigravity-cli/mcp/<server>/` 下的旧工具描述缓存（它们还带着坏 schema）。实测：四个被包裹的服务器共 217 个工具，缺 `items` 的数组为 0。
- **修复(关键)：空闲清扫不再在 15 分钟处杀掉正在跑的轮次。** 旧实现只在**发出** RPC 时更新 `lastUsedAt`，而镜像工具模式下整轮只发一次 `session/prompt`，之后全是流式更新，于是 `evictIdle()` 把一个健康跑了 15 分钟的轮次当成空闲，`closeGracefully` → `killTree` 直接杀掉（`agy acp exited (code=1, signal=null)`）。现在 `AcpProcess.isBusy`（任一 `session/prompt` 仍在 pending）同时豁免空闲驱逐与容量淘汰，任何入站帧都刷新 `lastUsedAt`，池里全是活轮次时宁可控额超配一个新进程也不杀别人的工作。
- **修复(关键)：进程级死亡的轮次，重试要新起进程而不是重放尸体。** 以 `PROCESS_EXIT` / `TIMEOUT` / `INVALID_OUTPUT` 收尾的 recording 无法续接，但适配器仍去重驱它，于是 5 次重试分别耗时 8/10/8/8/193ms 全部失败，界面只剩「本轮运行失败」+ 重试计数耗尽。`isRevivableFailure()` 现在让适配器遗忘死 recording 并重新组装一次尝试；账号级错误仍走 `claimFailover` 换号路径。
- **修复(选号)：对话中途不再悄悄换号。** `selectSessionAccount()` 在 Windows 上先执行了 `pool.selectAccount()`（`parallelSameAccount`，共用凭据槽规则），**之后**才看会话自己的绑定；于是别的会话或后台任务一旦把另一个账号标成活跃，用户下一回合就被搬到那个账号上——在 Windows 上这还会切换全局凭据槽，连「这一轮花的是谁的额度」都变了。现在会话绑定在所有平台都优先；打包规则只决定**没有可用绑定**的新会话（新会话依旧收敛到同一个槽）。回归：`test/host-branches.test.ts`（win32 下绑定压过池指针）+ 长期失败的 `test/adapter.test.ts` 粘账户用例，现已通过。
- **修复(界面)：会话头徽标改为报告「本会话模型所属家族」的账号，而不是 Gemini 指针。** 选号是按模型族独立进行的：`Gemini 4 Argon` 的回合会落在有 Argon 权限的账号上，即使 `google` 指针指着另一个账号，而且 Argon 消耗它自己的周额度。徽标此前无条件读 `pool.resolvedActiveAccountIds.google`，于是 Argon 会话既报了错误的账号、又报了那个账号的 Gemini 5 小时百分比，与输入框里的模型和控台的 Argon 行同时矛盾（即「菜单里显示的 Argon 不是这个账号」）。新增 `GET /plugins/agy-link/session-view?session=<id>`：先解析该会话真实选中的模型（`model/selection` 事件 → `defaultModel` → 上次运行），映射到家族，再按调度器同一顺序取号（会话粘性绑定 → 该家族显式 pin → 无副作用的资格预测），百分比取自**该家族自己的配额账**。在现场机器上实测：会话显示的是 `AGY · dao 98%`（dao 的 Gemini 5h），而它实际一直在消耗 **ele** 的 Argon 池（会话期间 100% → 34%）；现在徽标显示 `AGY · ele` 并附 ele 的 Argon 周额度。
- **修复(界面)：在弄清家族之前，徽标什么都不声明。** 会话视图尚未返回时只显示账号数量，不借别的家族的指针来充数。没有会话上下文的预览（设置面板、旧宿主）仍走原来的 google 读数，其余行为不变。`stickyAccount` 已从选号模块导出为 `sessionStickyAccount` 供只读视图复用，避免再出现第二份「谁在用」的判定。
- **修复(界面)：重置边界已过的窗口标记为陈旧**（百分比转灰 +「窗口已重置 · 数据偏旧」），不再当作实时数字展示；Argon 也绝不会去借它并不存在的 5 小时窗口。
- **修复(界面)：账号别名只保留一套规则。** 控台卡片、启用/停用提示条与会话徽标各自用「与旧中文串 `主账号 (系统登录)` 相等」来判断「这是自动生成的默认别名」，于是用任何其他语言写入的账号会在一块界面上显示原始字符串、在另一块界面显示本地化默认名。现在由 `accountDisplayAlias()` 统一判定（先看标记，再看「标记出现之前创建的机器级主账号」），三处共用。测试：`test/account-alias.test.ts`。
- **契约/文档：** 客户端 `StatusPayload.lastRun` 的类型改成宿主真实下发的 `processOk`/`processCode`（原来写的是并不存在的 `ok`/`code`）；`lastActiveAccountId` 的注释不再自称「in-use 徽标的唯一事实源」；`markAccountActive` 上方重复的文档块已删；路由注释不再写死路由条数。
- **文档：** `docs/KNOWN-GAPS.md` 记录第三方 MCP 的失效模式——`~/.gemini/config/mcp_config.json` 里的服务器由 agy 自己加载、原始 schema 直接送给 Gemini，只要有一个数组缺 `items`，整个回合就被拒（`...properties[args].items: missing field`）。godot-mcp 声明了 12 处；本插件的反向网桥会硬化 DSH 侧 schema（同一批工具 0 违规），但碰不到 agy 自行拉起的服务器。
- **修复(测试)：中性 aux 工作目录的断言改为分隔符无关。** `test/call-context.test.ts` 用 `workspaceRoot.endsWith('/agy-link/aux-cwd')` 断言，而 Windows 的真实路径是 `…\agy-link\aux-cwd`——`auxWorkspaceDir()` 本身用的是 `path.join`，实现是对的。断言改为先归一化分隔符，既不放松语义，也消掉了这条 Windows-only 红。
- **测试：** `test/mcp-sanitize-doctor.test.ts`（8 条：真实 godot schema 形态、代理端到端握手、注册表包裹/还原、旧 shim 重指向、缓存失效、缺 shim 兜底）、`test/acp-busy-idle-guard.test.ts`（3 条：busy 生命周期、入站帧算活动、空闲/容量豁免），以及 `test/idle-grace-empty-result-and-dead-continuation.test.ts` 新增的 `PROCESS_EXIT` 复活用例。
- **测试：** 新增 `test/session-view.test.ts`（9 条：家族解析、粘性 vs pin、预测 vs「当前使用」、陈旧窗口、空选择、无可用家族）、`test/session-badge.test.ts`（4 条：视图优先、未返回时不声明、旧预览、实际渲染）、`test/account-alias.test.ts`（4 条：统一别名规则），并把 `/session-view` 纳入冻结的 HTTP 路由面与行为测试（会话模型优先于 `defaultModel`）。

## 0.6.72 (2026-11-23)

### English

- **Fix(client): a translate button that mounted while a translation was already in flight no longer spins forever (merges PR #180, fixes #179).** `TranslateAction` asked `GET /translate/state` exactly once on mount. A `busy` answer raised the spinner, and nothing asked again — only this page's own `POST /translate` settled `working`, and an auto-translation running in the session has none. The spinner then outlived the card until the panel remounted (switching conversations was the usual workaround).
  - The mount effect is now a small probe loop: `busy` keeps the spinner and re-asks in 3 s, `ready` settles to ✓, and an `idle` that follows a `busy` releases the spinner this probe raised (the run failed or was cancelled). An `idle` on the first probe still changes nothing, as before — so a reply that was never translating does not flash.

### 中文

- **修复(客户端)：若翻译按钮在「已有翻译正在进行」时挂载，不再永久转圈（合并 PR #180，修复 #179）。** `TranslateAction` 挂载时只查一次 `GET /translate/state`。返回 `busy` 会升起 spinner，但之后没有任何人再问——只有本页自己发起的 `POST /translate` 才会把状态落定，而会话里正在跑的自动翻译没有这一环。于是 spinner 一直活到面板重新挂载（用户通常靠切换会话再切回来绕过）。
  - 现在挂载 effect 变成一个小探测循环：`busy` 保持 spinner 并每 3 秒重问一次；`ready` 落定为 ✓；若 `busy` 之后变成 `idle`（该轮失败或被取消），则释放本次探测升起的 spinner。首次探测就是 `idle` 时行为不变——从没翻译过的回复不会闪一下。

## 0.6.71 (2026-11-23)

### English

- **The "Image quota" row is gone.** `agy -p /usage` (both the plain text and the `--output-format json` `command.data.groups[]`) only reports GROUP-level buckets — verified on a Pro account (Gemini / Claude&GPT / Gemini 4 Argon) and on a free one: neither output mentions `image`/`imagen` anywhere, and `agy models` does not even list `gemini-3.1-flash-image`. Per-model image buckets only exist in Google's internal REST fallback, so the panel no longer renders them: a value that can only appear when the CLI already failed is not a stable metric, and re-fetching it on every refresh would add Node TLS traffic to an internal endpoint for zero scheduling value. Single-model pause rows (local cooldowns) are kept.
- **A frozen 5-hour row no longer proves a paid plan.** The "quota refresh failed" note used to describe any account with a stale `remainingFraction` as a refused PAID account; a lapsed Pro account kept its frozen 100% bar and got that wording while its own CLI reported weekly-only. The paid wording now requires the 5-hour reading to be NEWER than the refusal stamp.
- **Feat(translate): a `replace` display mode, so the translation can stand in for the reply instead of repeating it (merges PR #178).** New setting `translateDisplay` (Settings → 「译文显示方式」, next to the translate-button switch):
  - `card` (**default**) — unchanged: the Gemini card sits under the reply.
  - `replace` — the translated text takes the reply's place, with a small footer (`✦ Gemini translation · Show original · Copy`) to flip back.
  - It is **display only**: the session, and therefore the model's own context, keeps the original text. The hiding is one declarative `:has()` stylesheet rule keyed on the card's own `data-display`/`data-show-original`; nothing in the DOM or the session is rewritten. If DSH ever seats an intermediate node the rule simply stops matching and both texts show — the failure direction is "shows too much", never "hides the reply for good".
  - Four locales carry the copy; config validation, `/status`, HTTP contract and DOM tests updated.

### 中文

- **去掉「图片额度」行。** 实测 `agy -p /usage`（文本与 `--output-format json` 的 `command.data.groups[]`）在 Pro 账号（Gemini / Claude&GPT / Gemini 4 Argon 三组）与免费账号上都只有**分组级桶**，整份输出 `image`/`imagen` 零命中；`agy models` 连 `gemini-3.1-flash-image` 都不列。逐模型图片桶只存在于 Google 内部 REST 的降级路径，因此控制台不再渲染：一个「只有 CLI 失败时才可能出现」的数值不是稳定指标，而为了它每轮去打内部端点只会凭空增加 Node TLS 指纹暴露、对调度毫无价值。「单模型暂停」行（本地冷却）保留。
- **冻结的 5 小时行不再当作付费证据。** 原来只要有 `remainingFraction` 就把账号描述成「付费账号被汇总接口拒绝」；订阅失效的账号会留着冻结的 100% 5h 行，于是文案与实际（CLI 只报周额度）自相矛盾。现在要求 5 小时读数**比拒绝时间更新**才使用付费措辞。
- **特性(翻译)：新增 `replace` 显示模式，让译文直接替代原回复而不是重复一遍（合并 PR #178）。** 新设置 `translateDisplay`（设置 → 「译文显示方式」，紧邻翻译按钮开关）：
  - `card`（**默认**）—— 行为不变：Gemini 卡片显示在回复下方。
  - `replace` —— 译文占据回复的位置，底部保留一条小栏（`✦ Gemini 翻译 · 显示原文 · 复制`）可翻回原文。
  - **仅影响显示**：会话与模型上下文仍保留原文。隐藏逻辑是一条声明式 `:has()` 样式规则，依据卡片自身的 `data-display` / `data-show-original`；DOM 与会话都不被改写。若 DSH 将来在中间插入节点，规则会**自然失效并同时显示两份**——失败方向是"多显示"，绝不是"回复被永久隐藏"。
  - 四语言文案齐全；配置校验、`/status`、HTTP 契约与 DOM 测试均已更新。

## 0.6.70 (2026-11-23)

### English

- **Fix(client): translation and ACP cards register once `uiConversation` exists, instead of racing boot.** The client boot entry only waits for `slots` and `locale`, so the host can apply this plugin before `dsh-client-ui-conversation` has provided its service. `installTranslationUi` / `installAcpCards` looked the service up once; when it was not there yet they registered nothing and logged nothing, so every `plugin:agy-link/translation` record stayed in the session while no card was ever rendered (seen on DSH desktop 0.2.2-rc.3: the conversation event registry held 34 Definitions and none was `agy-translation`, although the records had reached the renderer). Both now register through `ctx.inject(['uiConversation'], …)` — the host's own pattern — and re-register if the service is provided again; a composition without `inject` keeps the immediate lookup. Already-persisted records render as soon as the fixed client loads; nothing in the session log changes.

- **Fix(auth): the 需重新登录 badge now means what it says, and stops crying wolf.** Three unrelated states shared one red badge: a dead OAuth grant, a Google verification/TOS block, and "the plugin could not *prove* which account this process was". The third is transient (a flaky proxy makes agy's own `userinfo` lookup fail with `EOF`, so `applyAuthResult: email=` is empty) yet it quarantined a healthy login for up to ~70 minutes — the hourly poll is the only re-check, and flagged accounts are skipped by `shouldPollAccount()` in the meantime. Now: (1) `accountAuthState()` splits the badge into `relogin` / `validation` / `tos` (red) and `review` (**amber** "Verifying sign-in", tooltip says no re-login needed); (2) the ACP identity gate returns `unproven` for a keyring fallback whose userinfo lookup failed on the network and settles it as a **retryable NETWORK** failure — no strike, no flag — while a log that names a *different* account still quarantines (`classifyIdentity()` replaces `identityMismatch()`); (3) `healAuthFlagsFromQuota()` drops any flag older than a quota snapshot (whoever wrote it — web and CLI share `pool.json`), so "the card shows fresh percentages but still demands a sign-in" cannot happen; (4) `reverifyFlaggedAccounts()` runs on a 2-minute timer with a 2→4→8→16→30 min back-off, so a false positive clears on the first attempt while a genuinely dead login backs off. Spec: `.spec/credential-lifecycle.md` §4/§4.1. Tests: `test/acp-identity.test.ts`, `test/auth-flag-heal.test.ts`, `test/auth-flag.test.ts`.
- **Fix(acp): the context ring no longer reads 100% after a long tool-heavy turn (root cause of #158's remaining half).** `agy acp`'s `session/prompt` response reports usage **cumulative for the whole ACP session** — a 2-call session returns exactly `42216+14424 / 0+42217 / 760+7247`. DSH's context meter treats the last reported usage as current occupancy (`input + cacheRead + cacheWrite`), so forwarding that envelope produced a 4.45M prompt side on a 1,048,576 window. The authoritative per-call figure lives in `transcript.jsonl`, but `extractUsageFromRecord` only looked at nested `usage` / `token_usage` / `metadata.usage`; agy 1.5.x writes `input_tokens` / `cache_read_tokens` / `output_tokens` at the **top level**, so the tailer always returned zero samples and the plugin fell back to the cumulative envelope. The parser now accepts the top-level shape, and the post-prompt flush retries a bounded 4×40 ms so the last call is not lost to async disk writes.
- **Perf(aux): session-title / compaction / translation run in a neutral, cacheable directory.** These pure-text calls were spawned in the session workspace, so agy loaded the project's GEMINI.md/AGENTS.md on every one-shot process: ~12–20k uncached tokens at 0% cache each. They now run in `<state>/agy-link/aux-cwd` with no `--add-dir` (config `auxNeutralWorkspace`, default true; an explicit `workspaceRoot` wins). A stable empty prefix also makes later aux calls cache-hittable.
- **Perf(acp): one atomic model switch when the server advertises an effort-suffixed id.** When `models.availableModels` contains `gemini-4-hydrogen-xhigh`, one `session/set_model` replaces the `model → thought_level` double switch; any failure falls back to the two-step path.
- **Observability: every ACP turn logs `[cache] hit=..% ctx=.. in=.. cr=.. cw=.. out=.. reason=<...>`, and the counters are aggregated per local day.** `GET /plugins/agy-link/status` now carries `cacheStats` (today / up to 14 days / last turn / per-session last), `/agy cache-stats` (`/agy cache`) prints the daily report, and `/agy status` adds a one-line today summary. In-memory only — a health read-out, not a billing ledger. The reason taxonomy (`new-session` / `resume` / `rebuild` / `account-switch` / `model-switch` / `idle` / `retry` / `aux`) is a pure, tested function, so the next optimisation can be measured instead of guessed.
- **Fix(quota): a model-scoped 429 no longer cools the whole model family ("has quota left yet was benched" root cause).** Live account `ele` (Google family at 20%) was frozen from `google` for 4h32m by an **image-model** 429 — `You have exhausted your capacity on this model … reset after 4h32m32s`. The text matched `looksLikeHardRateLimit`, and `generate_image` was treated as family quota, so every Gemini text model lost rotation despite having quota. `isModelScopedQuotaFailure()` now recognises the three model-scoped shapes (`on this model`, model id containing `image`, `generate_image`): rotate this turn only, never write a family cooldown; `LiveQuotaFailoverState.modelScoped` stops `finalize` from adding one; `dropModelScopedCooldowns()` clears legacy model-scoped cooldowns at pool init.
- **Fix(quota): a single-account "sync" drops from ~19s to ~1–2s.** Measured `agy -p /usage` spending ~13s in `loadCodeAssist` then hitting the shutdown timeout, so the 20s budget expired before REST (which needed ~1s) produced the numbers. Each account now enters a 10-minute negative cache after a CLI `/usage` timeout (`CLI_USAGE_TIMEOUT_RETRY_MS`) and goes straight to REST; the hourly sweep also stops paying 20s per account.
- **Tests:** new `test/model-scoped-quota.test.ts`; `test/quota-failover-alignment.test.ts` case 5 rewritten for the new semantics (image-subagent 429 → rotate but **no** account cooldown). Spec: new [`.spec/cache-and-usage.md`](.spec/cache-and-usage.md) plus a model-scoped/CLI-negative-cache section in `.spec/quota-and-risk-control.md`.

- **Fix(ui): the subagent header pill now follows DSH's background-task behaviour — live only.** It previously rendered a permanent `0/45` pill and a panel whose only content was "已结束 45" (agy keeps finished subagent descriptors forever and never flips them off ALIVE). The control now returns nothing when no subagent is running, lists only running rows, shows `● N` instead of `running/total`, and the finished-history section plus its expand toggle/locales are gone.
- **Fix/quota: image generation now has its own scheduling dimension (model-scoped), instead of cooling or switching the whole Gemini family.** Google meters image generation against a per-model bucket inside the same `google` family (`quotas.google.models[].modelId = gemini-3.1-flash-image`), so a family-level 429 was the wrong granularity: a drained image bucket paused text models that still had quota, and the account switch interrupted any concurrent chat turn. Added persisted `modelCooldowns` per account+model, `isModelQuotaClear()` for the second dimension, `selectAccount(..., quotaModel)` plus a non-mutating `findAccount()` used by `ImageService` (so the sticky pointer never moves), and `recordModelFailure/recordModelSuccess` wired through the image failover hook. A `generate_image` 429 now pauses only the image model on that account, the parent turn keeps running, and the quota card shows `Model paused: gemini-3.1-flash-image → HH:MM`.
- **Fix(acp): an isolated account can no longer silently run as the machine-wide keyring account.** Root cause of session `8bade603`'s abrupt stop: after 15.6 min the ACP prompt returned an empty turn, the plugin discarded the process (`ForceStopCascadeTree` + `got signal terminated`) and fell back to CLI, whose six retries all exited 1 with empty stderr. The ACP process for isolated account `dao` had logged `ChainedAuth: authenticated via keyring` with `applyAuthResult: email=` (empty) — a stale isolated token fell back to the machine-wide keyring, the old gate treated "no email" as "unknown" and let it run as the primary account until that session died. Now: (1) isolated accounts refresh their own token (`ensureFreshToken`) before every ACP/CLI spawn; (2) `readAuthEvidenceFromLog` detects keyring fallback, and `identityMismatch` refuses it on an isolated HOME only when no email proves the expected identity (macOS legitimately labels a pre-seeded slot "keyring"); (3) `classifyExitOrFallback` keeps `rawErrText`, so the UI shows `ACP prompt returned an empty turn: ...` instead of a bare code 1. (4) An AUTH/identity failure now settles with an actionable error instead of falling back to CLI — the CLI would use the same bad credential and burn six retries.

- **修复/配额：生图改为独立的「模型级」调度维度，不再冷却或切换整个 Gemini 族。** Google 本来就按 **per-model** 计量，图片模型（`gemini-3.1-flash-image`）只是 `google` 族里的一个独立桶（`quotas.google.models[]`）。此前用族级 429 处理，导致「图片桶打空 → 还有额度的文本模型一起被暂停」，换号还会打断并行的聊天回合。现在：新增持久化的 `modelCooldowns`（账号 × 模型）、`isModelQuotaClear()` 第二维度、`selectAccount(..., quotaModel)` 与**不移动 sticky 指针**的 `findAccount()`（供 `ImageService` 局部轮换）、以及 `recordModelFailure/recordModelSuccess` 接入图片 failover。`generate_image` 的 429 只暂停该账号的图片模型，父回合继续跑，配额卡片新增 `单模型暂停: gemini-3.1-flash-image → HH:MM`。

- **修复(ui)：子代理表头改为与 DSH 后台任务一致，只展示"活的"。** 之前会常驻一个 `0/45` 胶囊，面板里只有「已结束 45」——agy 的子代理描述符会长期保留且状态永远停在 ALIVE。现在没有运行中的子代理时整个控件返回 `null`，面板只列运行中的行，计数改为 `● N`，并移除「已结束 / 展开已结束」及其文案。

### 中文

- **修复(客户端)：翻译卡片与 ACP 卡片改为等 `uiConversation` 就绪后注册，不再和启动顺序赛跑。** 客户端 boot 条目只等 `slots` 和 `locale`，宿主可能在 `dsh-client-ui-conversation` 提供服务之前就应用本插件。`installTranslationUi` / `installAcpCards` 只查一次服务，没查到就什么也不注册、也不留日志：`plugin:agy-link/translation` 记录照常写进会话，但一张卡片都不显示（DSH 桌面版 0.2.2-rc.3 实测：会话事件注册表里有 34 个 Definition，没有 `agy-translation`，而记录本身已经到了渲染进程）。现在两者都通过 `ctx.inject(['uiConversation'], …)`（宿主自己的写法）注册，服务重新提供时会重新注册；没有 `inject` 的环境仍走即时查找。修复后的客户端一加载，已落库的翻译就会显示，会话日志不做任何改动。

- **修复(鉴权)：红色的「需重新登录」现在名副其实，也不再狼来了。** 三种互不相干的状态共用一个红标：凭据真的失效、Google 验证/TOS 限制、以及「插件无法**证明**这个进程是哪个账号」。第三种是瞬时的（代理抖动会让 agy 自己的 `userinfo` 请求 EOF，于是 `applyAuthResult: email=` 为空），却能把健康登录隔离最长 ~70 分钟——后台轮询一小时才跑一次，而这期间 `shouldPollAccount()` 直接跳过被标记账号。现在：(1) `accountAuthState()` 把徽章拆成 `relogin` / `validation` / `tos`（红）与 `review`（**黄**「认证复核中」，tooltip 明确无需重新登录）；(2) ACP 身份门对「keyring 回落 + userinfo 网络失败」返回 `unproven`，按**可重试的 NETWORK** 处理——不记 strike、不落红标；只有日志点名**另一个**账号才隔离（`classifyIdentity()` 取代 `identityMismatch()`）；(3) `healAuthFlagsFromQuota()` 用「晚于标记的配额快照」证伪标记（无论写入者是本进程还是共用 `pool.json` 的另一个进程），杜绝「配额条是新的、徽章还要你登录」；(4) `reverifyFlaggedAccounts()` 由 2 分钟定时器驱动，并按 2→4→8→16→30 分钟退避：误报一轮即清，真死号不会被每两分钟敲 Google。规格：`.spec/credential-lifecycle.md` §4/§4.1；测试：`test/acp-identity.test.ts`、`test/auth-flag-heal.test.ts`、`test/auth-flag.test.ts`。
- **修复(acp)：隔离账号不再静默地以机器级 keyring 账号运行。** 会话 `8bade603` 突然中断的根因：跑满 15.6 分钟后 ACP 回合返回空结果，插件丢弃进程（日志 `ForceStopCascadeTree` + `got signal terminated`）并回退 CLI，CLI 六次重试全部 `agy exited with code 1`、stderr 为空。该回合的 ACP 进程是隔离账号 `dao`，但 agy 日志是 `ChainedAuth: authenticated via keyring` + `applyAuthResult: email=`（空）——隔离 token 失效后回落机器级 keyring，旧身份门把「无 email」当作「无法判断」放行，于是用主账号凭据一直跑到该会话失效。现在：(1) 隔离账号在每次 ACP/CLI spawn 前用 `ensureFreshToken` 刷新自己的 token；(2) `readAuthEvidenceFromLog` 识别 keyring 回落，`identityMismatch` 仅在**无法用 email 证明身份**时拒绝（macOS 上预置槽位后 agy 仍标 keyring，属正常）；(3) `classifyExitOrFallback` 保留 `rawErrText`，界面会显示 `ACP prompt returned an empty turn: ...` 而不是只剩 code 1。(4) AUTH/身份类失败不再回退 CLI，而是直接给出可操作错误——CLI 会拿同一份坏凭据再烧六次重试。
- **修复(acp)：长工具回合后上下文圆环不再显示 100%（#158 剩余一半的根因）。** `agy acp` 的 `session/prompt` 响应里 `usage` 是**整个 ACP 会话的累计值**——实测 2 次调用的会话精确返回 `42216+14424 / 0+42217 / 760+7247`。DSH 把最后上报的 usage 当作当前上下文占用（`input + cacheRead + cacheWrite`），于是转发这个信封会在 1,048,576 窗口上产生 4.45M 的 prompt 侧。真正单次调用的数字在 `transcript.jsonl`，但 `extractUsageFromRecord` 只读嵌套的 `usage` / `token_usage` / `metadata.usage`；agy 1.5.x 把 `input_tokens` / `cache_read_tokens` / `output_tokens` 写在**顶层**，所以 tailer 永远拿到 0 条样本、回退到累计信封。现在解析器接受顶层形状，且 prompt 返回后的 flush 最多重试 4×40ms，避免最后一次调用被异步落盘丢掉。
- **性能(辅助调用)：标题/压缩/翻译改到中立且可缓存的工作区。** 这些纯文本调用原先落在会话工作区，agy 每个一次性进程都要加载项目的 GEMINI.md/AGENTS.md：每次约 1.2–2 万未缓存 token、0% 命中。现在跑在 `<state>/agy-link/aux-cwd` 且不带 `--add-dir`（配置 `auxNeutralWorkspace`，默认 true；显式 `workspaceRoot` 优先）。前缀稳定后，后续辅助调用也能命中缓存。
- **性能(acp)：服务端广告了带 effort 后缀的模型 id 时单次原子切换。** 当 `models.availableModels` 含 `gemini-4-hydrogen-xhigh` 时，用一次 `session/set_model` 取代 `model → thought_level` 双切；失败即回退两步路径。
- **可观测性：每个 ACP 回合记录 `[cache] hit=..% ctx=.. in=.. cr=.. cw=.. out=.. reason=<...>`，并按本地日聚合。** `/plugins/agy-link/status` 增加 `cacheStats`（今日 / 最多 14 天 / 最近一轮 / 每会话最近一次），`/agy cache-stats`（别名 `/agy cache`）打印逐日报表，`/agy status` 增加一行今日摘要。仅进程内存，是健康读数，不是计费账本。归因分类（`new-session` / `resume` / `rebuild` / `account-switch` / `model-switch` / `idle` / `retry` / `aux`）是纯函数并有测试，后续优化可以量化而不是猜。
- **修复(quota)：模型级 429 不再冷却整个模型族（「明明还有额度却被冷却」的根因）。** 实测账号 `ele`（Google 族剩 20%）被一次图片模型 429（`You have exhausted your capacity on this model … reset after 4h32m32s`）打进 4h32m 的 `google` 冷宫：该文案被 `looksLikeHardRateLimit` 命中后按族级配额记了冷却，而所有 Gemini 文本模型其实还有额度。现在 `isModelScopedQuotaFailure()` 识别「on this model / 模型 id 含 image / `generate_image` 工具」三类模型级拒绝：只在本回合切号、绝不写族级冷却；`LiveQuotaFailoverState` 增加 `modelScoped` 标记让 `finalize` 不补记；池初始化时 `dropModelScopedCooldowns()` 清掉历史遗留的模型级冷却。
- **修复(quota)：单账号「同步」从 ~19s 降到 ~1-2s。** 实测 `agy -p /usage` 在 `loadCodeAssist` 上耗 ~13s 后触发 shutdown 超时，20s 预算撞满才回退 REST（REST 只用 ~1s）。现在每个账号在 CLI `/usage` 超时后进入 10 分钟负缓存（`CLI_USAGE_TIMEOUT_RETRY_MS`），期间直接走 REST；后台每小时扫描也不再逐号付 20s。
- **测试：** 新增 `test/model-scoped-quota.test.ts`；改写 `test/quota-failover-alignment.test.ts` 第 5 题以钉住新语义（图片子代理 429 → 切号但**不**冷却账号）。规格：新增 [`.spec/cache-and-usage.md`](.spec/cache-and-usage.md)，并在 `.spec/quota-and-risk-control.md` 记录模型级/CLI 负缓存契约。

- **修复(acp)：控制台的「n 进程」现在描述真机状态，残留 `agy acp` 会被真正杀掉。** 2026-11-23 那次「面板 1 进程、实际 2 个服务」的根因：`AcpProcess.close()` 只对非进程组长的子进程发一次 SIGTERM，agy 装了优雅退出钩子会忽略它，而池又先删掉了自己的 map 条目——于是被驱逐的服务继续拿着已失效的凭据轮询 Google（pid 75365 活了 13+ 分钟，每 60s 刷 `You are not logged into Antigravity`，还挂着 6 个 MCP 子进程）。现在：ACP 子进程在 POSIX 以 `detached` 启动（独立进程组），`close()` 复用导出的 `killTree()`（整组 SIGTERM → 3s SIGKILL；Windows 走 `taskkill /T /F`）；新增残留对账只匹配本宿主的**直系** `agy[.exe] acp` 子进程且排除 live/draining 集合，先杀后代再杀根；徽标改为 `active + draining + stray` 并附说明。测试：`test/acp-kill-tree.test.ts`、`test/acp-strays.test.ts`、`test/acp-pool-strays.test.ts`。
- **修复(预热)：Anthropic 族其实从未被真正预热过——`--effort` 是模型级参数，不是族级。** 探针给 `claude-sonnet-5-5` 也加了 `--effort low`，agy 1.5.15 直接拒绝（`--effort is not supported for model …`），于是每轮都在本地失败：17:45 那次 3/3 失败，周窗口从未被激活，还每次写入 30 分钟失败退避。探针层已拆到 `src/features/warmup/probe.ts`，只有 `gemini-*` 带 `--effort`；新出现的拒绝会被学习进 `effort-unsupported` 并「去掉参数重试一次」。已对真实 CLI 验证：`--model claude-sonnet-5-5` 不带该参数返回 SUCCESS。
- **修复(预热)：账号之间按分钟间隔、每轮有硬性探针上限。** 跨账号间隔从 1.5–3s 改为 30–120s（`warmupAccountGapMs`）——同一出口 IP 一分钟内连续点亮 N 个 Google 账号是最像号池 farm 的形态；新增 `warmupMaxProbesPerRun`（默认 12，`0`=不限，env `DSH_AGY_WARMUP_MAX_PROBES`），超限账号记 `Run probe budget exhausted` 并留到下次，预算用尽后不再空等。设置页新增窗口模式、预热模型与探针上限，文案写明真实节奏。
- **修复(调度)：自动预热不再叠加、不再准点、不再锤已下架的模型。** 5 分钟 tick 会在手动预热进行中（现在要跑几分钟）叠上第二轮全池扫描——`runScheduledWarmup()` 在 `isRunning()` 为真时直接返回；日锚点改为按日期确定性的 0–20 分钟抖动（`dailyJitterMinutes`，钳到 23:59），不再每天同一分钟起跑；CLI 报 retired/unknown 的模型会把该族停车 24 小时（`MODEL_UNAVAILABLE_PARK_MS`，手动 force 仍可越权），而不是每 30 分钟重试（一天 48 次）；调度锚点落盘到 `warmup-history.json`（`schedule:daily:<dayKey>` / `schedule:interval`），插件重载不会重复触发；`warmupIntervalHours` 增加 3 小时下限（`0` 仍表示关闭）。测试：`test/warmup-effort-throttle.test.ts`、`test/warmup-auto-schedule.test.ts`。
- **修复(MCP 桥)：任何数组都不允许缺 `items` 发往 Google。** Gemini 对 function declaration 的校验是**整轮**失败（`GenerateContentRequest.tools[0].function_declarations[N].parameters.properties[args].items: missing field`），而清洗器可能因 `anyOf` 合并、`$ref` 解析失败、深度截断漏掉节点。`prepareMcpTools()` 现在把 `enforceArrayItems()` 作为后置不变式，并导出 `findArraysMissingItems()` 供审计。已逐个审计配置里的 7 个第三方 MCP 服务（全部干净），说明观测到的 400 来自合并后的工具列表，而非它们自身的 schema。
- **文档：** `.spec/process-lifecycle.md` §5（ACP 终止/残留不变式与徽标诚实性）、`.spec/quota-and-risk-control.md` §2（模型级 effort、节奏、预算、自动预热调度、停车族、锚点持久化、间隔下限）、`.spec/security-hardening.md`（桥的 `items` 后置不变式）。


## 0.6.69 (2026-11-23)

### English

- **Fix(models): refresh the offline lineup to agy 1.5.15 — `Gemini 4 Neon` and `Orchestrator (Neon)` were missing (issue #174).** The signed-out fallback list mirrored `agy models` on **1.5.7**; agy has since added `gemini-4-neon` (low/medium/high/xhigh) and a second orchestrator role model, `gemini-pro-orchestrator-neon`. Anyone signed out — or on a machine where `agy models` fails, which is exactly when the fallback matters — could not pick Neon at all. The lineup and its test fixture now mirror 1.5.15, verified against **both** `agy models` and the ACP `session/new` → `models.availableModels` payload (they agree exactly, 23 entries).
- **Docs(models): record what the orchestrator entries actually are, and what agy does not expose.** `gemini-pro-orchestrator-neon` / `-g1-pro` are *role* models: selecting one runs the session on Antigravity's orchestrator. They carry no effort tiers, and the desktop app's **Orchestrator Model / Executor Model** pair is not reachable from the CLI or ACP — the ACP `configOptions` carries only `model`, `thought_level` and `mode`. That is now written next to the lineup so the next person does not go looking again.

### 中文

- **修复(模型)：离线模型列表刷新到 agy 1.5.15 —— 此前缺 `Gemini 4 Neon` 与 `Orchestrator (Neon)`（issue #174）。** 未登录时的兜底列表镜像的是 **1.5.7** 的 `agy models`；agy 之后新增了 `gemini-4-neon`（low/medium/high/xhigh）与第二个编排器角色模型 `gemini-pro-orchestrator-neon`。任何未登录、或 `agy models` 取失败的用户（而兜底列表恰恰是在这种时候起作用）都根本选不到 Neon。列表与测试基准已更新到 1.5.15，并同时用 `agy models` 与 ACP 的 `session/new` → `models.availableModels` 双向核对（两者完全一致，共 23 项）。
- **文档(模型)：写清编排器条目到底是什么、以及 agy 没有暴露什么。** `gemini-pro-orchestrator-neon` / `-g1-pro` 是**角色**模型：选中它会让会话跑在 Antigravity 的编排器上。它们没有档位，而桌面端的 **Orchestrator Model / Executor Model** 两段式设置无法从 CLI 或 ACP 触达——ACP 的 `configOptions` 只有 `model`、`thought_level`、`mode`。这一点已写在列表旁边，避免下一个人再去找一遍。

## 0.6.68 (2026-11-23)

### English

- **Fix(acp): read the FLAT token counters agy writes on `PLANNER_RESPONSE` (fixes #175).** The transcript tailer only looked inside `usage` / `token_usage` / `metadata.usage`; since 1.5.12 agy writes the counters as siblings of `step_index`/`type`/`status`, so every ACP step produced no sample and the context meter fell back to an estimate that grew with each tool step — reported as `3.1M / 1.0M (100%)` on a 19-step turn, dropping back to `294.3k` on the next turn with no tools. The record itself is now a candidate, but only when it actually carries a counter, so non-usage steps still yield nothing.
- **Fix(client): register the conversation Definitions through `ctx.inject` instead of a one-shot lookup (merges PR #177, fixes #176).** The client boot entry declares only `inject: ["slots", "locale"]`, so DSH may apply this plugin before `dsh-client-ui-conversation` provides `uiConversation`. `installTranslationUi` / `installAcpCards` looked the service up once; when it was missing they registered nothing **and logged nothing**, for the whole page lifetime — translation records kept reaching the renderer but no card was ever projected. Both now use `ctx.inject(['uiConversation'], scope => scope.effect(...))` and register events with their receiver.

### 中文

- **修复(acp)：读取 agy 在 `PLANNER_RESPONSE` 上写入的顶层 token 计数（修复 #175）。** 转录跟随器此前只在 `usage` / `token_usage` / `metadata.usage` 里找；而 1.5.12 起 agy 把计数平铺在 `step_index`/`type`/`status` 旁边，于是 ACP 每一步都取不到样本，上下文计量回退成"随工具步数增长"的估算——报告者在 19 步的那轮看到 `3.1M / 1.0M (100%)`，下一轮无工具时又跌回 `294.3k`。现在记录本身也是候选，但**只有真的带计数字段时**才采纳，非用量步骤仍返回空。
- **修复(client)：用 `ctx.inject` 注册会话 Definition，而不是一次性查找（合并 PR #177，修复 #176）。** 客户端启动入口只声明了 `inject: ["slots", "locale"]`，因此 DSH 可能在本插件之后才提供 `uiConversation`。`installTranslationUi` / `installAcpCards` 只在 apply 时查一次；服务缺失时**什么都不注册、也不打日志**，且持续整个页面生命周期——翻译记录照常进渲染器，却永远没有卡片。两者现在都改用 `ctx.inject(['uiConversation'], scope => scope.effect(...))` 并用 receiver 注册事件。

## 0.6.67 (2026-11-23)

### English

- **Fix(quota): Argon and Gemini are independent quota books — no cross-family borrowing.** Argon's quota row used to fall back to the Gemini row whenever the summary omitted a dedicated `Gemini 4 Argon` group, in four places (eligibility/ordering, single-model bench, model-row display, and family ingestion, which re-homed Argon model rows under `google`). On agy 1.5.14 they are provably separate: accounts whose Gemini weekly pool had hit 0% still reported Argon weekly at 100%, and no account lists an Argon model under `google`. The borrow could therefore bench a healthy Argon on a drained Gemini pool or mask a drained Argon behind a full one. Absent Argon data is now "unknown" (not benched, unknown reset, ordered after known resets) and Argon model rows are filed under `argon` only; when the backend omits the group, Argon's own model-row weekly reading becomes its row, never the Gemini aggregate.
- **Fix(ui): a quota card can no longer contradict itself.** (1) A Pro account carrying a 5h bar was labelled "free-tier account · weekly quota only" — the notice now picks neutral wording whenever the account has 5h evidence, matching `resolveAccountPlanTier`. (2) A quota row whose reset boundary had already passed rendered a bare percentage with no time marker (a 33-hour-stale 91% looked live) — it now reads "window already reset · data from <time>", and only a full 100% reads "reset · available". (3) A paid account refused with `403 PERMISSION_DENIED` was frozen for a week (the free-tier cadence), leaving its Gemini rows on a multi-day-old snapshot while Argon kept advancing — it now re-probes hourly, while genuinely free-tier accounts keep the 7-day cadence.
- **Behavior note: a single card may legitimately show families of different ages.** `updateAccountQuotas` merges per family and `mergeFallbackFamilyQuota` keeps the last complete value when the summary is not authoritative, so "Argon just refreshed, Gemini is two days old" is expected. The UI therefore surfaces each row's own freshness instead of dressing them up as one instant.

### 中文

- **修复(配额)：Argon 与 Gemini 是两本独立配额账，禁止跨族借用。** 当汇总里没有独立的 `Gemini 4 Argon` 组时，Argon 的配额行会回退去读 Gemini 行——这个错误被复制在四个地方（选号排序/资格判断、单模型让路、模型行展示、以及把 Argon 模型行归到 `google` 族的摄入逻辑）。在 agy 1.5.14 上二者可证明是独立的：Gemini 周额度已打到 0% 的账号，Argon 周额度仍是 100%，且没有任何账号把 Argon 模型列在 `google` 下。因此这种借用会把健康的 Argon 拖下水、或把见底的 Argon 掩护起来。现在缺失的 Argon 数据一律视为「未知」（不判让路、重置时间未知、排在有已知重置的账号之后），Argon 模型行只归 `argon` 族；后端不发该组时，用 Argon 自己模型行的周额度读数建行，绝不读 Gemini 聚合值。
- **修复(界面)：同一张配额卡片不会再自相矛盾。** （1）挂着 5 小时额度条的 Pro 账号曾被写成「免费账号 · 仅限周配额」——现在只要账号有 5h 证据就改用中性文案，与 `resolveAccountPlanTier` 口径一致。（2）重置时间已过期的窗口此前只渲染一个不带任何时间标记的百分比（一个 33 小时前的 91% 看起来像实时数据）——现在写「窗口已重置 · 数据停留在 <时间>」，只有满 100% 才写「已重置 · 可用」。（3）付费账号收到 `403 PERMISSION_DENIED` 后曾被按免费号冻结 7 天，导致其 Gemini 行停在数天前的快照、而 Argon 还在推进——现在付费号改为每小时重探，真正的免费号仍保持 7 天节奏。
- **行为说明：一张卡片上出现不同新鲜度的族是合理的。** `updateAccountQuotas` 按族合并，`mergeFallbackFamilyQuota` 在摘要非权威时保留上一份完整值，所以「Argon 刚刷新、Gemini 是两天前的」属于预期状态。界面因此改为逐行标注各自的真实数据时间，而不是伪装成同一时刻。
- **测试：** 新增 12 条（Argon 独立性、卡片一致性、付费号 1 小时重探），并更新守着旧折叠行为的既有用例。


## 0.6.66 (2026-11-22)

### English

- **Fix(usage): derive the total when the CLI reports one that cannot be right (merges PR #170).** A reported `totalTokens` that disagrees with `input + output` made the per-turn total either too small or too large; the mapper now derives the total from the parts it can trust and only falls back to the reported figure when they are consistent. 76 new tests.
- **Fix(acp): skip an unchanged session config before a turn (merges PR #171, fixes half of #167).** `session/set_config_option` is not idempotent on agy's side — it logs `Switching model in session …` and re-runs the switch even for an unchanged value, and DSH opens the session again on every turn. The applied mode/model/effort are now remembered per session, so an unchanged turn sends nothing, a model change re-sends the effort (agy resets it), and a resumed session still sends its settings once.
- **Fix(wakeup): the wake notice carries a producer-owned source kind (merges PR #172).** The wake prompt is instruction text the model must act on, so it is never stripped as context noise; a dedicated `common/agy-link-source.ts` kind keeps that decision in one place instead of relying on the generic plugin kind.
- **Test(isolation): a slot-contract test no longer reads the developer's real token file.** `cliSlotHoldsAccount refuses when neither durable primary credential nor disk token exists` took the `stored !== null` branch on any machine where agy had signed in (and passed on a clean CI runner). It now stubs `getStoredToken` so the environment is pinned.
- **Not merged: PR #168.** Its `protocol.ts` change writes `usage_update.used` back into `input_tokens` — the exact defect #165 fixed (#158). Its goals overlap #165; a rebase against current `main` is needed to see whether anything is left.

### 中文

- **修复(用量)：CLI 报告的 total 与 input+output 不一致时改为推导（合并 PR #170）。** 上报的 `totalTokens` 与 `input + output` 矛盾时，单轮总量会偏小或偏大；映射层现在用可信的分量推导总量，只有在两者一致时才采用上报值。新增 76 条测试。
- **修复(acp)：回合前跳过未变更的会话配置（合并 PR #171，修复 #167 的一半）。** agy 侧的 `session/set_config_option` 不幂等——即使值未变也会记录 `Switching model in session …` 并重跑切换，而 DSH 每轮都会重新打开会话。现在按会话记住已应用的 mode/model/effort：未变更的回合不发任何请求，模型变更会重发 effort（agy 会重置它），续接会话仍会发送一次设置。
- **修复(wakeup)：唤醒通知带上生产方自有 source kind（合并 PR #172）。** 唤醒 prompt 是模型必须照做的指令文本，绝不能被当作上下文噪声剥离；用 `common/agy-link-source.ts` 的专用 kind 把这一判断收敛到一处，而不是依赖通用 plugin kind。
- **测试(隔离)：一条 slot 契约测试不再读取开发者的真实 token 文件。** `cliSlotHoldsAccount refuses when neither durable primary credential nor disk token exists` 在任何 agy 登录过的机器上都会走 `stored !== null` 分支（而在干净的 CI runner 上通过）。现在 stub 了 `getStoredToken`，把环境固定住。
- **未合并：PR #168。** 它的 `protocol.ts` 改动把 `usage_update.used` 又写回 `input_tokens`——正是 #165 修掉的缺陷（#158）。目标与 #165 重叠，需要基于当前 `main` rebase 后重新评估是否还有剩余价值。

## 0.6.65 (2026-11-22)

### English

- **Node-script `agyBin` shims now run on every platform.** A `.mjs`/`.js`/`.cjs` binary was only routed through the running Node process on Windows; on Linux/macOS it was spawned directly, which needs an exec bit and a shebang it does not have (EACCES/ENOEXEC). It is now detected as a Node script everywhere — this is what turned the Linux CI run red for the one-shot tests.
- **Credential-slot contract test is platform-aware.** `cliSlotHoldsAccount` deliberately claims a keyring-only primary on Linux/macOS (agy keeps that credential in the OS keyring, #143); refusing there would kill CLI quota for every keyring-only primary. The test now asserts refusal on Windows and the sibling-ownership refusal on every platform.

### 中文

- **`.mjs/.js` 形式的 `agyBin` 现在各平台都能跑。** 之前只有 Windows 会把它交给当前 Node 进程执行；Linux/macOS 直接 spawn 需要可执行位与 shebang，而它两者都没有（EACCES/ENOEXEC）。现在所有平台都按 Node 脚本处理 —— 这正是让 Linux CI 上 one-shot 测试变红的原因。
- **凭据槽契约测试按平台区分。** `cliSlotHoldsAccount` 在 Linux/macOS 上有意认领「仅存于系统钥匙串」的主账号（agy 把该凭据放在 OS keyring 里，#143）；若在那里拒绝，所有仅钥匙串登录的主账号都会失去 CLI 配额。现在测试在 Windows 断言拒绝、在所有平台断言「槽属于兄弟账号时必须拒绝」。

## 0.6.64 (2026-11-22)

### English

- **Plan tier badge is now correct for Flash-only paid plans.** A paid account whose quota shows a 5-hour window was badged **Free** because the Gemini group description only mentions "Flash" — Free is weekly-ONLY, so a 5-hour window is the paid marker. Tiers are now derived from defining evidence: Argon in its own bucket ⇒ Pro, Argon folded into the shared Gemini group ⇒ Ultra, any 5-hour window ⇒ Pro, weekly-only ⇒ Free. A stored tier whose own defining marker has disappeared is treated as stale and recomputed (a "Free" badge on a 5-hour account, or an "Ultra" badge with no Argon anywhere), while a Pro/Enterprise tier detected from richer CLI groups is never downgraded by a weaker probe. Corrected at boot and on every quota update.
- **Duplicate Google accounts are surfaced.** The same account can sit in the pool twice (primary + isolated copy, or a re-add); both share ONE quota and one credential identity, so capacity is over-reported and the Windows credential slot thrashes between two rows that are the same person. Cards with a sibling now carry a **Duplicate** badge naming the other aliases, boot hygiene logs a warning, and `/agy doctor` lists every duplicate group.

### 中文

- **只有 Flash 的付费套餐不再被误标成 Free。** 之前只要 Gemini 分组描述里只有「Flash」就判 Free，可该账号明明有 5 小时窗口——Free 是「只有周额度」，**有 5 小时窗口就是付费**。现在按每个档位的定义性证据判定：Argon 独立成桶 ⇒ Pro；Argon 折进共享的 Gemini 分组 ⇒ Ultra；有任何 5 小时窗口 ⇒ Pro；只有周额度 ⇒ Free。若已存档位丢失了它自己的定义性证据（5 小时账号标着 Free、或完全没有 Argon 却标着 Ultra），判为陈旧并重算；而从 CLI 分组里正确识别出的 Pro/Ultra 不会被更弱的探测降级。开机时与每次配额更新都会纠正。
- **重复 Google 账号可见。** 同一个账号可能在池里出现两次（主账号 + 隔离副本，或重复添加），两者共享**同一份配额与同一份凭据身份**，于是容量被算成两倍、Windows 凭据槽在两行同一个人之间反复改写。现在有兄弟账号的卡片会显示 **重复** 徽标并列出其它别名，开机整洁日志会告警，`/agy doctor` 会列出所有重复组。

## 0.6.63 (2026-11-22)

### English

- **Startup no longer fans out over the pool.** The boot probe used to run `agy --version` → `agy models` → `warmAccounts(all accounts)`; because agy forks every server in the user MCP registry for a `models` call, eight accounts meant tens of seconds of background churn and a fresh MCP process tree per probe. The probe now (a) waits for an idle moment and backs off while a turn is in flight, and (b) refreshes only the ACTIVE account eagerly — other accounts stay lazy (`ensureAccountCatalog` on first use) unless the opt-in pool-wide catalog needs them.
- **Deferred maintenance pass.** Staging/log sweeps, the ecosystem mirror, stale `presence/*.lock` files (agy never removes them — hundreds accumulate across a pool) and orphaned MCP servers now run once after boot and then on a 30-minute interval, instead of on the plugin-load path. New `reapOrphanMcp` config (default `true`) only kills MCP-server processes whose parent is already dead and that have been running for more than five minutes; an unknown start time never triggers a kill.
- **Windows proxy env no longer duplicates case.** Writing `HTTPS_PROXY` next to an inherited `https_proxy` produced two case-differing keys in every child environment block, which breaks PowerShell's `env:` provider ("An item with the same key has already been added") and `Start-Process`. Windows now collapses to a single uppercase entry (its env lookups are case-insensitive); POSIX still gets both spellings. When a proxy is configured, loopback (`127.0.0.1`, `localhost`, `::1`) is added to `NO_PROXY` so the MCP bridge, media routes and OAuth callback never travel through it.
- **`/agy doctor` reports startup cost.** The report now lists the MCP registry (every agy spawn forks all of it), flags `@latest` entries that re-resolve against npm on every spawn (~1.4 s each), counts stale presence locks, and notes how many pool accounts have isolated homes.

### 中文

- **启动不再对全池扇出。** 原来开机流程是 `agy --version` → `agy models` → `warmAccounts(全部账号)`；由于 `agy models` 会 fork 用户 MCP 注册表里的每一个 server，8 个账号就是几十秒后台 churn 加一棵新的 MCP 进程树。现在探测会（a）等待空闲、有回合在跑就退避重试，（b）只主动刷新**当前账号**，其余账号保持惰性（首次使用时 `ensureAccountCatalog` 按需加载），只有开启 opt-in 的全池模型目录才需要全量预热。
- **维护任务延后执行。** staging/日志清扫、生态镜像同步、陈旧的 `presence/*.lock`（agy 从不清理，池子里能积几百个）与孤儿 MCP 进程，改为开机后延迟执行一次、之后每 30 分钟一次，不再占用插件加载路径。新增 `reapOrphanMcp` 配置（默认 `true`）：只清理「父进程已死且已运行超过 5 分钟」的 MCP server 进程；启动时间无法解析时一律不动。
- **Windows 代理环境变量不再大小写重复。** 把 `HTTPS_PROXY` 写在继承来的 `https_proxy` 旁边，会让每个子进程的环境块出现两个仅大小写不同的键，导致 PowerShell 的 `env:` 提供程序报「已添加了具有相同键的项」、`Start-Process` 直接失败。Windows 现在收敛为单个大写键（其环境变量查询本就大小写不敏感），POSIX 仍保留两种拼写。配置代理时会自动把 `127.0.0.1`、`localhost`、`::1` 加入 `NO_PROXY`，MCP 桥接、媒体路由与 OAuth 回调不再走代理。
- **`/agy doctor` 报告启动开销。** 报告新增 MCP 注册表清单（每次 agy 启动都会 fork 全部）、`@latest` 未锁定版本条目（每次启动都要重新解析 npm 版本，约 1.4 s）、陈旧 presence 锁数量，以及有隔离 home 的账号数。

## 0.6.62 (2026-11-22)

### English

- **ACP is the default transport.** `transport` now resolves to `acp` out of the box, so background commands, subagents, timers and the post-turn report path work without any configuration, and per-call usage/cache metrics stay accurate (#158). A pre-stream ACP failure, or an ACP turn that produces nothing, still falls back to `cli -p` for that turn. Opt back into the one-shot CLI with `/agy config transport cli`, `/agy transport cli`, `DSH_AGY_TRANSPORT=cli` or Settings → Runtime controls. `backgroundWakeup` remains opt-in.
- **Rename by clicking the name.** The separate "Rename" button is gone: the account label in each card header is itself the editor (click it, or focus it and press Enter/Space, to open the inline field). The label carries the rename hint as its tooltip.
- **Re-login is always available.** The "Sign in again" action no longer appears only after an authentication failure — every account shows it, so a healthy account can be re-authenticated, re-bound to a different Google identity, or refreshed after a server-side token revocation. On an account that actually needs auth it keeps the highlighted primary styling.

### 中文

- **ACP 成为默认传输通道。** `transport` 默认解析为 `acp`，开箱即用：后台命令、子代理、定时器与回合后汇报链路无需任何配置即可工作，逐次调用的用量/缓存统计也保持准确（#158）。若 ACP 在流式启动前失败，或该回合零产出，仅该回合自动回退 `cli -p`。需要回到单轮 CLI 时用 `/agy config transport cli`、`/agy transport cli`、`DSH_AGY_TRANSPORT=cli` 或设置页切换。`backgroundWakeup` 仍保持 opt-in。
- **点名字即可重命名。** 去掉独立的「重命名」按钮：账号卡片标题里的名称本身就是编辑入口（点击，或聚焦后按 Enter/空格，即展开行内输入框），名称的 tooltip 同时提示可重命名。
- **重新登录按钮常驻。** 「重新登录」不再只在认证失败后才出现——所有账号都会显示，便于对健康账号主动重新认证、换绑 Google 身份，或刷新被服务端吊销的 token；真正需要认证的账号仍保持高亮主按钮样式。

## 0.6.61 (2026-11-22)

### English

- **Fix(quota): the CLI `/usage` path now uses the same Argon rule as the REST summary path (fixes #169).** v0.6.38 taught the summary chain that a dedicated Argon pool is proven only by the group **name** or a bucket id — a shared `Gemini Models` group merely *enumerates* its members ("… Gemini 4 Argon …") in its description. The **CLI** mapping (`usageGroupsToFamilies`) was missed by that fix and still matched `desc.includes('argon')`, so on the default `quotaViaCli` path the whole Gemini pool was written into the `argon` family: `google` froze at an old snapshot, an extra Argon bar appeared, chatting with Gemini 4 Neon drained *Argon*, and `dedicatedGroups: ["argon"]` poisoned account selection and the cooldown gate. Both paths now agree, and a real dedicated Argon group (by name or `argon-*` bucket) is still recognised.
- Also widened one timing guard in `test/proxy-keychain.test.ts` (`durationMs < 2000` → a bound that only distinguishes "fired on the 400ms budget" from "fired on the 15-minute idle budget"). It was measuring machine load: a saturated host reported 9.7s while `timedOut` stayed correct.

### 中文

- **修复(配额)：CLI `/usage` 路径改用与 REST summary 路径相同的 Argon 判据（修复 #169）。** v0.6.38 已让 summary 链路认识到：**独立 Argon 池只由组名或 bucket id 证明**——共享的 `Gemini Models` 组只是在 description 里*枚举*成员（"… Gemini 4 Argon …"）。但那次修复**漏了 CLI 侧的映射**（`usageGroupsToFamilies`），它仍匹配 `desc.includes('argon')`，于是在默认的 `quotaViaCli` 路径上整个 Gemini 池被写进 `argon` 族：`google` 冻结在旧快照、多出一条 Argon 条、用 Gemini 4 Neon 聊天却掉 Argon 的额度、`dedicatedGroups: ["argon"]` 还会污染选号与冷却闸门。现在两条路径判据一致，且真实独立 Argon 组（按组名或 `argon-*` bucket）仍能识别。
- 顺带放宽了 `test/proxy-keychain.test.ts` 里一处时序断言（`durationMs < 2000` → 只区分「按 400ms 预算触发」还是「按 15 分钟空闲预算触发」）。它实际在测机器负载：饱和的宿主上报了 9.7 秒，而 `timedOut` 始终正确。

## 0.6.60 (2026-11-22)

### English

- **Fix(acp): report the real token usage instead of the context-window figure (merges PR #165, fixes #158).** agy 1.5.x's `usage_update` carries only `{ used, size }` — a context-window occupancy figure, **not** a usage sample. Writing `used` into `input_tokens` made the run's final usage `{ inputTokens: used, outputTokens: 0 }`, which zeroed the cache-hit rate and the token speed and inflated the uncached input count (multi-step runs accumulated 10M+). `used` is now recorded as a diagnostic-only `lastContextUsed` and never promoted to a usage sample; a future update that really carries cache-read/output counts is still honoured. 178 lines of new tests.
- **Feat(wakeup): cross-turn background wakeup, opt-in (merges PR #164, supersedes #156).** When an agy `schedule` timer, a detached task/subagent, or a persistent ACP update finishes **after** the turn returned, an idle DSH session can now be woken with a followup prompt. Three slices in one PR: keep one-shot `schedule` timers alive across turns, wake on detached task/message/subagent completion, and keep an ACP session alive while its background work runs.
  - **It is off by default** (`backgroundWakeup: false`): a session that speaks on its own after the turn is a behaviour change every user has to ask for. Turn it on in Settings → Runtime controls, with `/agy wakeup <on|off|status>`, or `DSH_AGY_BACKGROUND_WAKEUP=1`.
  - Guardrails: 30-minute TTL, at most 12 wakeups per session between real human turns, archived sessions skipped, an active run blocks the wake, message ids de-duplicated, and language-server restart notices ignored so dead CLI subagents cannot cause retry loops.

### 中文

- **修复(acp)：报告真实的 token 用量，而不是上下文窗口占用（合并 PR #165，修复 #158）。** agy 1.5.x 的 `usage_update` 只携带 `{ used, size }`——这是**上下文窗口占用**，不是用量样本。把 `used` 写进 `input_tokens`，会让该轮最终用量变成 `{ inputTokens: used, outputTokens: 0 }`，于是缓存命中率与输出速度归零、未缓存输入虚高（多步运行可累加到 10M+）。现在 `used` 只作为诊断字段 `lastContextUsed` 记录，绝不提升为用量样本；若未来版本真的携带 cache-read/output 计数，仍会被采纳。新增 178 行测试。
- **特性(唤醒)：跨轮后台唤醒，可选开启（合并 PR #164，取代 #156）。** 当 agy 的 `schedule` 定时器、游离任务/子代理、或持久 ACP 更新在**回合结束之后**才完成时，空闲的 DSH 会话现在可以被一条 followup prompt 唤醒。一个 PR 内含三片：让一次性 `schedule` 定时器跨轮存活、在游离任务/消息/子代理完成时唤醒、在 ACP 会话仍有后台工作时保活。
  - **默认关闭**（`backgroundWakeup: false`）：会话在回合结束后自己说话，是每个用户都必须主动要求的行为变更。可在 设置 → 运行时控制、`/agy wakeup <on|off|status>`、或 `DSH_AGY_BACKGROUND_WAKEUP=1` 开启。
  - 护栏：30 分钟 TTL、每会话在两次真人回合之间最多 12 次唤醒、归档会话跳过、活跃 run 阻止唤醒、消息 id 去重、语言服务器重启通知被忽略（避免死掉的 CLI 子代理引发重试循环）。

## 0.6.60 (2026-11-22)

### English

- **Fix(usage): the ACP transport reports the real token usage again (closes #158).** `agy acp` streams `session/update` with `usage_update` carrying only `{ used, size }` — the context-window occupancy at the end of an internal call, not a measurement of the call. The plugin promoted that number to `input_tokens`, and since a run reports `lastStepUsageRaw ?? resultRaw`, the placeholder shadowed the real `PromptResponse.usage`: the cache-hit rate stayed at 0%, the token speed read 0 tok/s, and the uncached input count was inflated (one multi-step turn could add up to 10M+).
  - **`src/features/acp/protocol.ts`**: `usage_update` now records `used` in a new diagnostic field `lastContextUsed` and leaves `lastUsage` alone. An update that really carries `outputTokens` / `cachedReadTokens` still counts as a sample.
  - **`src/host/recording.ts`**: `finalUsage()` prefers the last per-call sample only when it carries a token breakdown (`hasUsageBreakdown()`: output / cache read / cache write / thinking / total). An input-only sample now yields to the envelope, so the per-call-vs-cumulative protection the class was built for still holds.
  - **Token speed has an honest fallback**: when no step reported output tokens, `speedStats()` measures the envelope's output count over the run's own event span (never below a 500 ms window) instead of reporting 0 tok/s.
  - **No more placeholder `0/0` usage chunks**: a tool cut or a failed turn with no measurement now omits the usage chunk. DSH reads an absent chunk as "no new measurement", while an explicit `0/0` resets the context meter and drags the speed down.
- **Regression tests**: `test/usage-acp.test.ts` (11 cases) pins the whole chain — a context reading never rides along on streamed steps, an update with real counts still does, a full ACP turn's final usage equals the `PromptResponse` usage, an input-only sample yields to the envelope, the no-measurement cases emit no chunk, and the speed fallback reports the envelope rate.

### 中文

- **修复(用量)：ACP 传输重新上报真实的 token 用量（关闭 #158）。** `agy acp` 的 `session/update` 里，`usage_update` 只带 `{ used, size }`——那是内部调用结束时的**上下文占用**，不是这次调用的用量。插件曾把它写进 `input_tokens`，而一次运行上报的是 `lastStepUsageRaw ?? resultRaw`，于是这个占位值盖掉了真实的 `PromptResponse.usage`：缓存命中率长期 0%、输出速度显示 0 tok/s、未命中 token 虚高（多步切分可累加到 10M+）。
  - **`src/features/acp/protocol.ts`**：`usage_update` 改为把 `used` 记进新的诊断字段 `lastContextUsed`，不再碰 `lastUsage`；确实携带 `outputTokens` / `cachedReadTokens` 的更新仍算真实样本。
  - **`src/host/recording.ts`**：`finalUsage()` 只在最后一条 per-call 样本确实带分项计数时才优先（`hasUsageBreakdown()`：output / cache read / cache write / thinking / total），只有 input 的样本让位给信封值——这个类原本要防的「per-call 与累计值混用」依然成立。
  - **输出速度有了诚实的兜底**：没有任何 step 报过 output token 时，`speedStats()` 用信封的 output 数除以本轮事件跨度（窗口不小于 500ms）计算，而不是报 0 tok/s。
  - **不再发占位的 `0/0` usage chunk**：没有测量的工具切步或失败回合直接省略该 chunk。DSH 把「没有 chunk」理解为「没有新的测量」，而显式 `0/0` 会重置上下文计量并把速度拖到 0。
- **回归测试**：`test/usage-acp.test.ts`（11 个用例）钉住整条链路——上下文读数不会附着在流式 step 上、带真实计数的更新仍算样本、整轮 ACP 的最终 usage 与 `PromptResponse` 一致、只有 input 的样本让位给信封、无测量的两种情况不发 chunk、速度兜底给出信封速率。

## 0.6.59 (2026-11-22)

### English

- **Fix(open): a stale path is never handed to the OS opener (merges PR #159).** On Windows `explorer.exe /select,<missing>` does not fail — it silently opens the Desktop folder, so clicking a link whose file had since moved looked like the plugin randomly opening the user's Desktop. `executeOpenInSystem()` now checks the target exists first and answers with a real error otherwise. The opener is also injectable, so the unit test no longer launches a real Explorer/Finder/xdg-open on the developer's machine during a test run.
- **Fix(quota): never spawn `agy` with a token that is about to die (merges PR #160).** agy authenticates from the machine credential store at process start and gives that read a fixed 10s budget; when the stored access token is expired or expires inside that window the refresh can lose the race and agy falls back to **interactive OAuth** — it opens a browser and waits for a human. Measured on the reporter's machine: 9 of 375 hourly polls did this (2.4%), **every one with ≤60s of token life left**, and none of the 746 polls with ≥1min left. The hourly CLI poll now refreshes a comfortable margin ahead (`CLI_TOKEN_SAFETY_MS` = 2 minutes, far above both the observed failure band and the 1.5–5s refresh round-trip) and, when it cannot reach that window, **skips the CLI for that round and lets the REST path answer** — a skipped round costs nothing, a browser window costs the user's attention.

### 中文

- **修复(open)：过期路径不再交给系统打开器（合并 PR #159）。** Windows 上 `explorer.exe /select,<缺失>` 不会失败，而是**静默打开桌面文件夹**，于是点击一个文件已被移动的链接看起来像插件随机打开了用户的桌面。`executeOpenInSystem()` 现在先确认目标存在，否则返回真实错误。打开器也改为可注入，因此单元测试不再在开发者机器上真的拉起 Explorer/Finder/xdg-open。
- **修复(配额)：绝不用即将失效的 token 去 spawn `agy`（合并 PR #160）。** agy 在进程启动时从系统凭证库取 token，该读取有固定 10 秒预算；当存储的 access token 已过期或在该窗口内过期时，刷新可能输掉这场竞争，agy 便回退到**交互式 OAuth**——弹浏览器等人来处理。报告者机器实测：375 次每小时轮询里 9 次发生（2.4%），**全部是 token 剩余寿命 ≤60 秒的情形**，而 746 次 ≥1 分钟的轮询一次都没有。现在每小时的 CLI 轮询会提前一个舒适边际刷新（`CLI_TOKEN_SAFETY_MS` = 2 分钟，远高于观察到的失败带与 1.5–5 秒的刷新往返），若无法进入该窗口则**跳过本轮 CLI、让 REST 路径作答**——跳过一轮没有代价，弹一个浏览器窗口要的是用户的注意力。

## 0.6.59 (2026-11-22)

### English

- **Fix(quota): the hourly CLI quota poll can no longer make `agy` open the user's browser.** Every hour the plugin runs `agy -p /usage` for the account that owns the machine credential store. `agy` reads that store at startup with a FIXED 10s budget and runs the token refresh in a separate goroutine; when the stored access token was already dying the budget lost the race, `agy` fell back to INTERACTIVE OAuth and opened the system browser to wait for a human. Measured on one machine: **9 of 375 hourly polls (2.4%) opened a browser, every single one with at most 60s of token life left, and 0 of the 746 polls that had at least 1 minute left**.
  - **New pure module `src/features/quota/cli-token.ts`**: `CLI_TOKEN_SAFETY_MS = 120_000` (two minutes sits far outside the observed failure band and far above the measured 1.5-5s refresh round-trip), `tokenRemainingMs()`, `isTokenSafeForCli()` and `prepareCliToken()`. A credential with no known expiry counts as UNSAFE: `agy` would refresh at startup, which is exactly the browser-popping path, and "no expiry means valid forever" is the misreading that turned issue #112 into a permanent 401 loop.
  - **`QuotaService.readCliUsageFamilies` now brings the credential into the safety window before it spawns anything** (`src/host/quota.ts`): read the stored token, refresh once when it is dying, write the result into the OS store `agy` actually loads, re-read, and only then spawn. If any step fails the CLI stands down for that round and the REST path answers - a skipped round costs one quota sample an hour, a browser window costs the user their attention.
  - **The slot write-back is a host seam** (`syncSlot`): `persistRefreshedToken` only rewrites the on-disk document, which on Windows is a mirror - `agy` authenticates from Credential Manager. The host wires the write and it runs inside the `credentialSlotMutex` this read already holds. Left unwired in tests, so no unit test can write the real machine slot.
  - **`getValidAccessToken` / `isAccessTokenFresh` take the required validity as a parameter** (`src/features/quota/token.ts`, default unchanged at 60s): an HTTP call needs 60s, but a child process spends seconds before its first request, so the CLI path asks for the full two minutes. Without this the refresh would return a token with 90s left that the gate then rejects - a wasted refresh round-trip and a skipped CLI anyway.
  - Eleven new cases in `test/quota-cli-token.test.ts` pin the decision (expiry unknown, one second short, exactly at the boundary), the refresh window (90s is fresh for HTTP, not for a spawn) and the ordering (refresh, slot write, verification read, spawn).

### 中文

- **修复(配额)：每小时的 CLI 配额轮询不会再让 `agy` 打开用户的浏览器。** 插件每小时对「拥有系统凭据库」的账号执行一次 `agy -p /usage`。`agy` 启动时读该凭据库只有**固定的 10 秒预算**，而令牌刷新跑在另一个 goroutine 里；当已存的 access token 临近过期时，这 10 秒会输掉竞态，`agy` 于是回退到**交互式 OAuth**——打开系统浏览器等人操作。单机实测：**375 次每小时轮询中有 9 次（2.4%）弹出浏览器，全部落在令牌剩余不超过 60 秒的情况；而剩余至少 1 分钟的 746 次一次都没有**。
  - **新增纯函数模块 `src/features/quota/cli-token.ts`**：`CLI_TOKEN_SAFETY_MS = 120_000`（两分钟远高于实测失败带，也远高于实测 1.5-5 秒的刷新往返），以及 `tokenRemainingMs()`、`isTokenSafeForCli()`、`prepareCliToken()`。**没有过期时间的凭据一律视为不安全**——`agy` 会在启动时刷新，那正是弹浏览器的路径；而「没有过期时间等于永久有效」这种误读，正是 issue #112 变成永久 401 循环的原因。
  - **`QuotaService.readCliUsageFamilies` 在拉起任何进程之前先把凭据送进安全窗**（`src/host/quota.ts`）：读已存令牌，临期则刷新一次，把结果写进 `agy` 真正读取的系统凭据库，复读校验，才 spawn。任一步失败则本轮放弃 CLI、由 REST 兜底：少一次采样每小时只损失一个数据点，而一个浏览器窗口损失的是用户的注意力。
  - **写槽是宿主侧的注入点**（`syncSlot`）：`persistRefreshedToken` 只改磁盘文档，而在 Windows 上磁盘只是镜像——`agy` 是从 Credential Manager 取凭据的。宿主负责这次写入，它跑在本读取已持有的 `credentialSlotMutex` 内。测试里不注入该回调，因此任何单测都不可能写到真实的机器凭据槽。
  - **`getValidAccessToken` / `isAccessTokenFresh` 把所需有效期改成参数**（`src/features/quota/token.ts`，默认仍是 60 秒）：一次 HTTP 调用 60 秒够用，但子进程从启动到发出第一个请求要花几秒，所以 CLI 这条路径要求完整的两个小时窗。没有这一层，刷新会交回一个只剩 90 秒的令牌、随即被门禁拒掉——白跑一次刷新，CLI 照样跳过。
  - **`test/quota-cli-token.test.ts` 新增十一个用例**：既钉住判定（无过期时间、差一秒、恰好等于边界），也钉住刷新窗口（90 秒对 HTTP 算新鲜、对 spawn 不算），以及顺序（刷新、写槽、复读校验、spawn）。

## 0.6.58 (2026-11-22)

### English

- **Feat(accounts): a pool account's label is now editable from the console (fixes #152, part 1).** `pool.setAccountAlias()` existed but nothing exposed it — the alias could only be set while adding an account, so a typo, or a Google account that was renamed, left a stale label forever.
  - **New route `POST /plugins/agy-link/pool/alias`** (`{ id, alias }`): non-empty, ≤64 chars, 404 for an unknown id. A successful rename clears `defaultAlias`, which is exactly what makes the card stop rendering the generated "Backup Google account N" label and show the typed one instead.
  - **Inline rename in the card**: a "Rename" action opens an input under the card and saves through the host. The proxy editor and this one were the same layout written twice, so both now share `src/client/sections/inline-editor.ts` (which also keeps `AccountsPanel.ts` inside the file-size budget).
  - Four locales carry the copy. `saveAlias` lives with the other account-lifecycle actions, not with quota actions — renaming has nothing to do with quota, and keeping it there would have pushed `quotaActions` past the line budget.

### 中文

- **特性(账号)：池账号的显示名称现在可在控制台编辑（修复 #152 第一部分）。** `pool.setAccountAlias()` 早就存在，但没有任何入口暴露它——别名只能在添加账号时设定，于是打错字、或 Google 账号改名后，卡片上的旧名字会一直留着。
  - **新增路由 `POST /plugins/agy-link/pool/alias`**（`{ id, alias }`）：非空、≤64 字符、未知 id 返回 404。改名成功会清除 `defaultAlias`——这正是让卡片不再渲染自动生成的「备用 Google 账号 N」、改为显示用户输入的机制。
  - **卡片内联重命名**：一个「重命名」动作在卡片下展开输入框，经宿主保存。代理编辑器与它原本是同一套布局写了两遍，现在共用 `src/client/sections/inline-editor.ts`（同时让 `AccountsPanel.ts` 保持在行数预算内）。
  - 四语言文案齐全。`saveAlias` 归入账号生命周期动作而非配额动作——改名与配额无关，放在配额里会把 `quotaActions` 顶出行数预算。

## 0.6.56 (2026-11-21)

### English

- **Feat(accounts): a pool account's label is now editable from the console (fixes #152, part 1).** `pool.setAccountAlias()` existed but nothing exposed it — the alias could only be set while adding an account, so a typo or a renamed Google account left a stale label forever.
  - **New route `POST /plugins/agy-link/pool/alias`** (`{ id, alias }`) with the validations the UI relies on: non-empty, ≤64 chars, and a 404 for an unknown id. A successful rename clears `defaultAlias`, which is what makes the card stop rendering the generated "Backup Google account N" label and show the typed one.
  - **Inline rename in the card**: a "Rename" action opens an input under the card, saving through the host and refreshing the pool. The proxy editor and this one were the same layout twice, so both now share `src/client/sections/inline-editor.ts` (which also keeps `AccountsPanel.ts` inside the file-size budget).
- **Test(dx): the SIGKILL-escalation test no longer asserts a wall-clock upper bound.** `durationMs` spans spawn→exit, so on a saturated host it read **16 minutes** during a full coverage run while the escalation itself was correct. The lower bound (must wait out the 3s window) and the semantic `signal === 'SIGKILL'` assertion stay; "hangs forever" is covered by the race guard, which reaps the child.

### 中文

- **特性(账号)：池账号的显示名称现在可在控制台直接编辑（修复 #152 第一部分）。** `pool.setAccountAlias()` 早就存在，但没有任何入口暴露它——别名只能在添加账号时设定，于是打错字或 Google 账号改名后，卡片上的旧名字会一直留着。
  - **新增路由 `POST /plugins/agy-link/pool/alias`**（`{ id, alias }`），带 UI 依赖的校验：非空、≤64 字符、未知 id 返回 404。改名成功会清除 `defaultAlias`，这正是让卡片不再渲染自动生成的「备用 Google 账号 N」、改为显示用户输入的关键。
  - **卡片内联重命名**：一个「重命名」动作在卡片下展开输入框，经宿主保存后刷新池。代理编辑器与它原本是同一套布局写了两遍，现在共用 `src/client/sections/inline-editor.ts`（同时让 `AccountsPanel.ts` 保持在文件行数预算内）。
- **测试(开发体验)：SIGKILL 升级用例不再断言墙钟上界。** `durationMs` 是 spawn→exit 的跨度，在饱和的宿主上于一次完整覆盖率运行中读到 **16 分钟**，而升级本身是正确的。保留了下界（必须等过 3 秒窗口）与语义断言 `signal === 'SIGKILL'`；「是否永久挂住」由带回收的 race 守卫覆盖。

## 0.6.54 (2026-11-21)

### English

- **Fix(client): the rest of the DOM surfaces now speak the host language (fixes #153, part 2).** Part 1 localized the decision chips; this one covers the image chips and their toasts, the whole image lightbox (tooltips, button labels, loading and keyboard hints), the mermaid view-source toggle and parse warning, the compaction card title, and the question-card insert/recorded labels.
  - **New `src/client/i18n-bridge.ts`**: these modules are plain DOM enhancers, not React components, and several have no `ctx` of their own (the lightbox is opened by the scanner). They now read one translator bound once in `index.ts`, with `translateOr(key, englishFallback)` guaranteeing copy instead of a bare key when no locale service exists. `decisions.ts` was migrated onto it, deleting its private copy of the same fallback logic.
  - **`mermaid` keeps one Chinese literal on purpose**: `代码块` is DSH's own placeholder banner text, matched to DETECT "this banner carries no real language label". Translating it would break the detection.
  - **`compaction` no longer reads `document.documentElement.lang`**: that is DSH's page language, not this plugin's locale, and the two can disagree — the binding is the authority now.
- **Test(dx): hardened two timing guards in `test/proxy-keychain.test.ts`.** They measured machine load rather than the watchdog: a starved event loop on a busy host made a 5s guard fire before a 400ms timeout could settle, and one escalation test hung to the runner's 60s default. The guards are widened and now reap the child on overrun, while the assertions that bound the actual tick are unchanged.

### 中文

- **修复(客户端)：其余 DOM 界面也改用宿主语言（修复 #153 第二部分）。** 第一部分本地化了决策芯片；本次覆盖图片 chip 与其 toast、整个图片灯箱（tooltip、按钮文字、加载与键盘提示）、mermaid 的「查看源码」切换与解析失败警告、压缩卡片标题，以及问题卡片的填入/已记录文案。
  - **新增 `src/client/i18n-bridge.ts`**：这些模块是纯 DOM 增强器而非 React 组件，其中几个根本没有自己的 `ctx`（灯箱由 scanner 打开）。它们现在统一读取在 `index.ts` 一次性绑定的 translator，`translateOr(key, 英文兜底)` 保证没有 locale 服务时输出文案而不是裸 key。`decisions.ts` 已迁移过来，删掉了它自己那份重复的兜底逻辑。
  - **`mermaid` 刻意保留一处中文**：`代码块` 是 DSH 自己的占位 banner 文本，用来**识别**「该 banner 没有真实语言标签」。翻译它会破坏这段判断。
  - **`compaction` 不再读 `document.documentElement.lang`**：那是 DSH 的页面语言，不是本插件的 locale，两者可能不一致——现在以 locale 绑定为准。
- **测试(开发体验)：加固 `test/proxy-keychain.test.ts` 的两处时序守卫。** 它们实际在测机器负载而非看门狗：繁忙宿主上被饿死的事件循环会让 5 秒守卫早于 400ms 超时结算，另有一条升级用例会一直挂到 runner 的 60 秒默认超时。守卫已放宽，并在超时时主动回收子进程；约束真实 tick 的断言保持不变。

## 0.6.53 (2026-11-21)

### English

- **Feat(settings): the model list becomes a tick-list over the real selectable universe (merges PR #149, closes #131).** The "Model visibility" block was a deny-list of chips fed only by `agy models`, so a host without the CLI offered the 7 static fallback rows while the account pool already knew that account could run 23+ models — the picker looked broken.
  - **Ticking writes an allow-list.** `selectedModels` (`POST /config`, `DSH_AGY_SELECTED_MODELS`) is applied after `hiddenModels`, so a denied model stays denied (and its chip says why). An empty selection still means "no restriction", which keeps the shipped default byte-for-byte and makes unticking the last model unable to blank the picker.
  - **New pure module `src/domain/models/quota-catalog.ts`** folds `accounts[].quotas.<family>.models[]` into catalog entries (same effort-folding rules as the CLI list) and merges them into whatever `agy models` discovered — CLI order and naming stay authoritative, quota rows only contribute models the catalog never mentioned. `/status` scopes this to the active account (or the whole pool under `poolWideCatalog`) and echoes `selectedModels`; model resolution merges the same way so a quota-only model still resolves.
  - **Resolution is deliberately NOT filtered**: a session already running a model the user later untickes keeps resolving it — unticking must not break in-flight work. Only `listModels` (the picker) filters.
- Merge note: the PR's inline config validation was replaced by the unified `validateConfigValue()` that landed in v0.6.52, extended to cover `selectedModels`, and the maintainer-owned `CHANGELOG.md`/`package.json` were kept.

### 中文

- **特性(设置)：模型列表改为「真实可选集合」的勾选清单（合并 PR #149，关闭 #131）。** 原「模型可见性」是只由 `agy models` 供数的**拒绝清单**，于是没有 CLI 的宿主只列出 7 条静态兜底、而账号池其实知道该账号能跑 23+ 个模型——选择器看起来像坏了。
  - **勾选写入允许清单。** `selectedModels`（`POST /config`、`DSH_AGY_SELECTED_MODELS`）在 `hiddenModels` **之后**应用，因此被拒绝的模型仍然隐藏（chip 会说明原因）；空选择仍表示「无限制」，默认配置逐字节不变，也不会因为取消最后一个勾选而把选择器清空。
  - **新增纯模块 `src/domain/models/quota-catalog.ts`**：把 `accounts[].quotas.<family>.models[]` 折叠成目录条目（与 CLI 列表同一套 effort 折叠规则），再并入 `agy models` 的结果——CLI 的顺序与命名保持权威，配额行只贡献目录里从未出现的模型。`/status` 按活跃账号（或 `poolWideCatalog` 下的整池）限定范围并回显 `selectedModels`；模型解析同样合并，使「只有配额快照才知道」的模型仍可解析。
  - **解析刻意不做过滤**：用户后来取消勾选的模型，已在运行的会话仍能解析——取消勾选不得打断进行中的工作。只有 `listModels`（选择器）过滤。
- 合并说明：PR 内联的配置校验已替换为 v0.6.52 引入的统一 `validateConfigValue()` 并补充 `selectedModels`；维护者自有的 `CHANGELOG.md`/`package.json` 保持。

## 0.6.52 (2026-11-21)

### English

- **Fix(commands/goal & plan): align DSH `/goal`, `/plan`, and `/agy` bridges 1-to-1 with zero redundancy and strict idempotency.**
  - **DSH GoalService parity (`/agy goal`)**: `handleGoal` now delegates to DSH `ctx.goals` (`GoalService`) when present, adding `set` and `edit` subcommands, keeping `activation` (`armed`/`disarmed`), `goal/changed` broadcasts, and `roundsStarted` accurate, and turning repeated `pause`/`resume`/`complete`/`clear` calls into idempotent no-ops. Its fallback event-log path enforces DSH `goalProjectionDefinition` fold invariants (blocking illegal transitions like `complete -> pause` or empty `clear`), and `resolveSessionGoal()` no longer skips `edit` events.
  - **Plan mode & `exit_plan_mode` continuation**: `isPlanMode()` consults live session state (`ctx.planMode` / `plan/change`), `options.system` (`plan:policy`), and approved/rejected `exit_plan_mode` tool results; `classifyPlanToolContinuation()` only short-circuits on dismissal so approved plans execute outside `--mode plan` and keep-planning feedback re-runs cleanly; `buildChatPromptText()` preserves `agytc-bridge-*` tool results even on bound conversations; `buildPlanExitToolCallBlock()` ensures a leading `# ` heading and uses monotonic callIds excluded from `parseMirrorCallId()`.
  - **`EventMapper` & continuation safety**: `EventMapper` only synthesizes `update_goal` when `goalContext.goalId` is defined; `isSyntheticHarnessMessage()` recognizes `'plan-mode'` and `'<goal_blocked>'`; `hasFinishableEventFrom()` treats `CANCELED`/`CANCELLED` as terminal states.
- **Refactor(host/commands/routes): remove duplication and enforce idempotency across config, MCP bridge, session, pool, and image utilities.**
  - Deduplicated message-text helpers in `src/host/dsh-goal.ts` (reusing `prompt-text.ts`), MCP bridge registration via `registerBridgeMcpConfig()` / `teardownBridgeState()`, and session binding removal via `dropMostRecentBinding()` / `dropSessionBindings()`.
  - Made `setOverride()` disk writes, `copyArtifact()` (when `source === target`), `/agy remove-account` (`cleanupStaleAccounts?.()` + non-duplicated `notifyPicker`), `/agy effort`/`mode`/`workspace` (spaces preserved from `ctx.raw`), and `/config` `permissionMode` validation consistent and idempotent.
  - Fixed Windows drive/WSL path + `.bmp` extraction in `IMAGE_PATH_RE` (`src/features/image/prompt.ts`), unified Windows manual quota sweeps in `QuotaService.refreshAllQuotas(true)` through `sweepAccountsByEgress()` honoring `forceConcurrency`, and made `test/services.test.ts`'s mock `agy` stub cross-platform.

### 中文

- **修复(命令/Goal 与 Plan)：使 DSH `/goal`、`/plan` 与 `/agy` 桥接及状态机与 `agy` 一一对齐，零冗余且严格幂等。**
  - **对齐 DSH `GoalService`（`/agy goal`）**：优先委托给 DSH `ctx.goals`（`GoalService`），补全 `set` 与 `edit` 子命令，确保 `activation`（`armed`/`disarmed`）、`goal/changed` 事件和 `roundsStarted` 计数准确；重复执行 `pause`/`resume`/`complete`/`clear` 改为幂等空操作；事件日志回退路径严格遵循 DSH `goalProjectionDefinition` 折叠约束（阻止 `complete -> pause` 等非法跃迁）；修复 `resolveSessionGoal()` 跳过 `edit` 事件导致状态陈旧的 bug。
  - **Plan 模式与 `exit_plan_mode` 续接**：`isPlanMode()` 综合读取实时会话状态（`ctx.planMode` / `plan/change`）、`options.system`（`plan:policy`）及审批结果；`classifyPlanToolContinuation()` 仅在用户取消/驳回审查时短路结束，审批通过或带反馈继续规划时会继续驱动 `agy` 执行/修订，并在 `buildChatPromptText()` 中对已绑定会话保留 `agytc-bridge-*` 工具结果文本；`buildPlanExitToolCallBlock()` 自动补全 `# ` 标题前缀并使用不与镜像工具 ID 冲突的单调 `agytc-bridge-plan-*` ID。
  - **`EventMapper` 与续接一致性**：仅在 `goalContext.goalId` 明确存在时合成 `update_goal`；`isSyntheticHarnessMessage()` 补充识别 `'plan-mode'` 与 `'<goal_blocked>'`；`hasFinishableEventFrom()` 将 `CANCELED`/`CANCELLED` 识别为终止状态。
- **重构(宿主/命令/路由)：消除全项目冗余与非幂等问题，补齐校验与清理逻辑。**
  - 收敛 `dsh-goal.ts` 的消息文本提取（复用 `prompt-text.ts`）、`registerBridgeMcpConfig()` / `teardownBridgeState()` 的 MCP 配置幂等注册与清理，以及 `dropMostRecentBinding()` / `dropSessionBindings()`。
  - 修复 `setOverride()` 重复写盘、`copyArtifact()` 同路径复制、`/agy remove-account` 清理残留账号绑定与重复刷新选择器、`/agy effort`/`mode`/`workspace`（保留含空格路径）及 `/config` 的 `permissionMode` 校验。
  - 修复 `IMAGE_PATH_RE` 对 Windows 盘符路径及 `.bmp` 的匹配问题，统一 `QuotaService.refreshAllQuotas(true)` 在 Windows 下通过 `sweepAccountsByEgress()` 执行并尊重 `forceConcurrency`，并使 `test/services.test.ts` 的 mock `agy` 脚本跨平台兼容。

## 0.6.51 (2026-11-21)

### English

- **Fix(quota): a successful CLI refresh now clears the stale `quotaUnavailable` marker (fixes #151).** The CLI-first path returns as soon as it has families, before the REST/summary branch that owns `clearQuotaUnavailable`. A marker written while the summary endpoint was down therefore outlived the successful refresh: the panel kept showing "quota refresh failed · endpoint unreachable · data from 19:02" while the stored quotas advanced past 22:44. Fresh CLI data is authoritative for this account, so the marker is cleared on that path too.
- **Fix(client): the decision chips speak the host language (fixes #153, part 1).** `installDecisionChips()` injected hardcoded Simplified Chinese: the header, the button tooltips, and — worst of all — the text written into the composer, so an English-configured host received a Chinese prefix as its own prompt. The copy now goes through the plugin's `locale` binding with English fallbacks, and the four locales define `decision.quickFill` / `decision.insertTooltip` / `decision.insertPayload`. An existing test that asserted the Chinese payload was updated to assert the localized one.

### 中文

- **修复(额度)：CLI 刷新成功后清除陈旧的 `quotaUnavailable` 标记（修复 #151）。** CLI 优先路径拿到 families 就返回，早于拥有 `clearQuotaUnavailable` 的 REST/汇总分支。于是在汇总接口不可达期间写入的标记会比成功刷新活得更久：面板一直显示「配额刷新失败 · 接口不可达 · 数据停留在 19:02」，而存储的额度其实已推进到 22:44 之后。CLI 的新鲜数据对该账号是权威的，因此这条路径也要清除标记。
- **修复(客户端)：决策芯片改用宿主语言（修复 #153 第一部分）。** `installDecisionChips()` 硬编码了简体中文：标题、按钮 tooltip，以及**最糟的**——直接写进输入框的文本，导致英文配置的宿主把中文前缀当作自己的 prompt。文案现在走插件的 `locale` 绑定并带英文兜底，四个语言都新增 `decision.quickFill` / `decision.insertTooltip` / `decision.insertPayload`。一条原本断言中文 payload 的既有测试已改为断言本地化后的文本。

## 0.6.50 (2026-11-21)

### English

- **Fix(watchdog): a scheduled wake-up no longer releases the idle-grace exemption on its own status line (fixes #148).** When agy hands work to the background it asks the model for a short status update before it prints the idle line, so the sequence was: tool returns `state === 'RUNNING'` → `text`/`thinking` step → `root agent idle; waiting …`. `text`/`thinking` cleared the subagent exemption and `RUNNING` counted as a completed hand-off, so nothing held the exemption when the idle line finally arrived.
  - A `schedule` step that returns `RUNNING` is now tracked until it reports a terminal state, and that wait holds the exemption independently; a `text`/`thinking` step no longer cancels it (it still restores the normal idle *budget*, which is a different concern).
  - **`run_command` is deliberately excluded.** agy also uses it for daemons (dev servers, watchers) that never report back, and reclaiming those is exactly what #119 exists for — #124's test pins that. A backgrounded *build* is protected by agy's own count instead (`waiting for N background task(s)` with N > 0 disarms the reaper, shipped in v0.6.46/0.6.48), which needs no exemption and cannot resurrect the daemon case.
- **Fix(mcp-bridge): `/tools` now lists the caller's own tool surface (fixes #150).** The endpoint called `svc.schemas()` with no scope, so every tool registered inside a DSH preset (`present`, `todo_write`, `job_*`, `schedule_*`, `office_*`) was invisible to an allowlisted agy child even though `/call` could invoke it. The session→agent resolution that `/call` already performed is now a shared `resolveSessionAgent()` used by both endpoints, including the bare-sub-agent-key retry with the `session-` prefix.

### 中文

- **修复(watchdog)：定时唤醒不再因为自己的状态提示而解除 idle-grace 豁免（修复 #148）。** agy 把工作交给后台时，要求模型先发一句简短状态更新，然后才打印 idle 行，于是顺序是：工具返回 `state === 'RUNNING'` → `text`/`thinking` 步骤 → `root agent idle; waiting …`。而 `text`/`thinking` 会清掉子代理豁免，`RUNNING` 又被当作「已完成交接」，等 idle 行真正出现时已没有任何东西撑着豁免。
  - 返回 `RUNNING` 的 `schedule` 步骤现在被跟踪到它有终态为止，这个等待**独立**持有豁免；`text`/`thinking` 不再取消它（它仍然负责把空闲**预算**恢复正常，那是另一件事）。
  - **`run_command` 被刻意排除。** agy 也用它启动永不回报的守护进程（dev server、watcher），而回收这类进程正是 #119 存在的理由——#124 的测试锁定着这一点。而后台化的**构建**由 agy 自己的计数保护（`waiting for N background task(s)`，N > 0 时不武装收割器，v0.6.46/0.6.48 已发布），既不需要豁免，也不会把守护进程那一类放回来。
- **修复(mcp-bridge)：`/tools` 现在列出调用者自己的工具面（修复 #150）。** 该端点用无 scope 的 `svc.schemas()`，导致注册在 DSH preset 里的工具（`present`、`todo_write`、`job_*`、`schedule_*`、`office_*`）对已加入白名单的 agy 子进程完全不可见，尽管 `/call` 其实能调用它们。`/call` 原本就有的 session→agent 解析被提取为共用的 `resolveSessionAgent()`，两个端点都用它，包括「裸子会话 key 加 `session-` 前缀重试」的行为。

## 0.6.49 (2026-11-20)

### English

- **Fix(accounts/UI): one source of truth for quota admission, so the console never disagrees with the scheduler.** A Pro account at `0%` on the 5-hour window (e.g. `god`) was rotated out by `isQuotaBenched()` while every client surface still painted it eligible: the dot stayed green, no badge appeared, "Set as in use" was offered, and `/agy pool` printed `Ready`. Clicking it reported success and then silently retreated, because `setActiveAccount()` never consulted eligibility.
  - New `src/common/quota-bench.ts` holds the pure predicates (`is5hQuotaBenched`, `isWeeklyQuotaBenched`, `isQuotaBenched`, `accountHasActiveCooldown`, `accountHasQuotaBench`, `isAccountCriticalAuth`). `domain/accounts/selection.ts` re-exports them, so scheduling and rendering share one implementation instead of two drifting copies.
  - `AccountsPanel` now derives the dot, the `rate-limited` badge, the banner (with its clear action) and the visibility of "Set as in use" from those predicates; a quota-benched account is no longer advertised as usable. `VALIDATION_REQUIRED` / `TOS_VIOLATION` render as `Verification required` / `Suspended (ToS)` with the verification link, taken from `quotaUnavailable` when `authError` carries no URL.
  - `QuotaPanel` marks the 5-hour and weekly rows `· rate-limited` when they are what benched the account. `SessionStatus` includes quota benches in both the active-account and all-accounts-drained checks, so the header dot turns amber too.
  - `setActiveAccount()` validates with `isAccountEligible()`, so a rejected pin returns `false` up front instead of a false success. `/agy pool` reports `Quota-limited (auto-rotated until reset)` instead of `Ready`.
- **Fix(quota): the "data frozen at" stamp names the oldest frozen window.** `renderQuotaUnavailableNote` used `Math.max` across families, so a partial refresh that only touched `argon` dated the whole row to *now* (14:05) while the failing `google` snapshot was hours old (11:27). It now takes the oldest non-zero `updatedAt`, which is what "the data is stuck at" actually means.
- **Fix(quota): verification and ToS refusals quarantine the account immediately.** A `403` carrying `VALIDATION_REQUIRED` or `TOS_VIOLATION` recorded `quotaUnavailable` but left `authRequired` unset, so selection kept routing to an account Google had just refused. Both reasons now stamp `authRequired` (with the verification URL) and clear again once a later summary succeeds.
- Four locales updated (en/es/ptBR/zh). Regression suite added: `test/status-consistency.test.ts` (5 cases covering the benched-card render, the header dot, `setActiveAccount` agreement, the frozen-stamp choice, and the verification heals-on-success path).

### 中文

- **修复(账号/UI)：配额可用性判定收敛为单一真源，控制台不再与调度器打架。** 一个 5 小时额度 `0%` 的 Pro 账号（如 `god`）已被 `isQuotaBenched()` 轮转掉，但所有前端面仍把它画成可用：圆点还是绿的、没有任何标签、「设为当前使用」照常出现、`/agy pool` 也打印 `Ready`。点下去还会提示成功然后悄悄退回，因为 `setActiveAccount()` 从未校验可用性。
  - 新增 `src/common/quota-bench.ts` 承载纯谓词（`is5hQuotaBenched`、`isWeeklyQuotaBenched`、`isQuotaBenched`、`accountHasActiveCooldown`、`accountHasQuotaBench`、`isAccountCriticalAuth`）。`domain/accounts/selection.ts` 复用它并再导出，调度与渲染共用一份实现，而不是两份逐渐分叉的副本。
  - `AccountsPanel` 的圆点、`限流中` 标签、提示条（含清除动作）以及「设为当前使用」的可见性，全部由这些谓词推导；被配额限流的账号不再被宣称为可用。`VALIDATION_REQUIRED` / `TOS_VIOLATION` 显示为 `需安全验证` / `已封禁 (ToS)` 并附验证链接——当 `authError` 里没有 URL 时从 `quotaUnavailable` 取。
  - `QuotaPanel` 在 5 小时或周额度正是限流原因时，于对应行标注 `· 限流中`。`SessionStatus` 把配额限流也纳入「当前账号」与「全部账号耗尽」的判定，顶部圆点同步变琥珀色。
  - `setActiveAccount()` 改用 `isAccountEligible()` 校验，被拒绝的固定会当场返回 `false`，而不是假成功。`/agy pool` 输出 `Quota-limited (auto-rotated until reset)`，不再是 `Ready`。
- **修复(额度)：冻结时间戳改取最早冻结的那个窗口。** `renderQuotaUnavailableNote` 原先取各族的 `Math.max`，于是一次只刷新了 `argon` 的部分刷新会把整行标成「数据停留在」当下（14:05），而真正失败的 `google` 快照已经是几小时前（11:27）。现改取最早的非零 `updatedAt`——这才是「数据卡在什么时候」的本意。
- **修复(额度)：需验证与被封禁会被立即隔离。** 携带 `VALIDATION_REQUIRED` 或 `TOS_VIOLATION` 的 `403` 只记录了 `quotaUnavailable`，却没设 `authRequired`，于是选号仍在往 Google 刚拒绝过的账号上派活。现在这两种原因都会打上 `authRequired`（含验证链接），并在后续 summary 成功时自动解除。
- 四语言词条同步（en/es/ptBR/zh）。新增回归套件 `test/status-consistency.test.ts`（5 条用例，覆盖限流卡片渲染、顶部圆点、`setActiveAccount` 一致性、冻结时间戳选取，以及验证通过后自动恢复）。

## 0.6.48 (2026-11-20)

### English

- **Fix(idle-grace): three linked causes of `INVALID_OUTPUT: agy stream ended without a result event` (merges PR #147).** Follow-up to #144/#146, from a report that the failure could still replay three times within milliseconds on continuation retries:
  - **`waiting up to <duration> for N background task(s)`** is a second wording agy emits (e.g. `waiting up to 240m0s for 1 background task(s)`). `backgroundTasksFrom()` only matched `waiting for N`, so this variant returned `null` and the reaper was still armed for a positive count. The regex now accepts the optional `up to <duration>` segment.
  - **An empty error result no longer hides the recoverable reply.** On SIGTERM agy can flush `{ ok: false, response: '' }`; `hasResult` counted that envelope, so the `idleGraceTerminated` recovery was skipped while `EventMapper` ignored the empty result without finishing. The guard is now `hasConsumableResult` (ok, or non-empty response), so a usable reply or the explicit notice is always appended.
  - **A settled recording with no finishable event stops replaying.** When a continuation had no consumable result and no cuttable tool step after its resume point, every DSH retry re-drove the same dead recording (~20 ms each) until retries were exhausted. `hasFinishableEventFrom()` makes the adapter forget such a recording and spawn a fresh attempt instead. **This is the part that goes beyond what shipped in v0.6.47**, which only checked the result dimension — a recording cut mid-tool-step now resumes instead of re-running the work.
- Note: v0.6.47 independently landed the first two items and the `recording` helpers; this merge keeps that structure and takes the wider adapter predicate plus PR #147's regression suite (4 new tests, 347 lines).

### 中文

- **修复(idle-grace)：`INVALID_OUTPUT: agy stream ended without a result event` 的三条关联成因（合并 PR #147）。** 是 #144/#146 的后续，源于「该失败在续接重试时仍会在毫秒级重复三次」的报告：
  - **`waiting up to <duration> for N background task(s)`** 是 agy 的第二种措辞（例如 `waiting up to 240m0s for 1 background task(s)`）。`backgroundTasksFrom()` 只匹配 `waiting for N`，该变体返回 `null`，于是正数计数下收割器仍会被武装。正则现在接受可选的 `up to <duration>` 片段。
  - **空的错误 result 不再掩盖可恢复的回复。** SIGTERM 时 agy 可能刷出 `{ ok: false, response: '' }`；`hasResult` 把这个信封算作结果，导致 `idleGraceTerminated` 的恢复逻辑被跳过，而 `EventMapper` 又忽略空结果、不置 finished。判据改为 `hasConsumableResult`（ok 或非空 response），因此总会补上可用回复或明确提示。
  - **没有可完成事件的 settled recording 不再被重放。** 续接点在可消费 result 与可切割工具步骤之后都没有事件时，DSH 每次重试都会重驱同一份死 recording（每次约 20ms）直到重试耗尽。`hasFinishableEventFrom()` 让适配器遗忘这种 recording 并新起一次尝试。**这部分超出 v0.6.47 已发布的内容**——它只检查 result 维度；在工具步骤中途被切断的 recording 现在会续接，而不是重跑已有工作。
- 说明：v0.6.47 已独立落地前两项与 `recording` 辅助方法；本次合并保留其结构，吸收更宽的适配器判据与 PR #147 的回归测试（4 条新用例，347 行）。

## 0.6.47 (2026-11-20)

### English

- **Perf(translation): warm persistent `agy` worker pool + `low` default effort + zero-enrichment aux path.**
  - Added `TranslationWorkerPool` (`src/features/translation/worker.ts`) for POSIX hosts: keeps at most one warm `agy -p --output-format stream-json --input-format stream-json --mode plan` child (`cwd = tmpdir()`, no `--add-dir` / `--disable-slash-commands`) keyed by `${accountId}|${model}|${effort}`, with idle TTL (`5m`) and turn/char recycle (`8` turns / `32,000` chars). Subsequent translations skip the ~8–9s cold CLI startup and exit wait (~4–9s end-to-end vs ~20–40s before). Windows keeps `ctx.llm.stream` to preserve OS Credential Manager slot locking.
  - Changed default `translateEffort` from `medium` to `low` (plain-language rewriting does not benefit from extended chain-of-thought latency) and updated the four locale hints accordingly.
  - Auxiliary non-image runs (`isAux && !isImage`) now skip `SubagentTracker` and SQLite thought/tool-arg polling in `driveSpan`, and `startAttemptProcess` eagerly persists successful conversation bindings on `result` so rapid back-to-back bound calls never race child exit.
- **Fix(accounts/models): zero-redundancy per-account model lists, orchestrator model eligibility, and authoritative catalog attribution.**
  - Fixed false `lack model "gemini-pro-orchestrator-neon" in their catalog` rejections on Pro/Ultra accounts: Google's REST `fetchAvailableModels` breakdown never includes CLI-synthesized orchestrator slugs (`gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-g1-pro`), so whenever an account's per-account `agy models` cache was absent or stale, `accountSupportsModel` vetoed it. `accountSupportsModel` now recognizes backing quota evidence (`gemini-4-neon` for `gemini-pro-orchestrator-neon`, Argon access for `gemini-pro-orchestrator-g1-pro`) and `baseModelSlug` strips `-xhigh` and `-tiered-*` suffixes; global `ModelCatalog.refresh()` now also attributes its result to the exact `probedAccount.id` it ran under, and the issue-#125 self-heal `refreshQuota` also warms undiscovered accounts.
  - Added `buildAccountModelRows()` (`src/common/account-models.ts`) and surfaced `status.accountModels` (keyed by account id) from each account's real `agy models` discovery; `status.catalog.count` now tracks the active account's actual supported model count.
  - Account cards render the deduplicated per-account list (with effort tags when applicable) instead of raw 30+ row REST quota dumps, filtering `-sonar`/`-image` noise, folding `-tiered`/effort suffixes in fallback mode, and leaving unknown quota percentages blank instead of fabricating `100%`.
  - `POST /plugins/agy-link/pool/refresh-quota` now passes `id` to `catalog.forceRefresh(id)` on single-account sync and triggers `catalog.warmAccounts()` on full sync.
- **Fix(credentials): guard macOS/Linux `systemHome` against stale Keychain/disk clobbering and disabled-primary fallback.**
  - When refreshing an OAuth token for `systemHome` (`acc_primary`) on macOS/Linux, `getValidAccessToken` re-verifies the live OS Keychain `refreshToken` before persisting and discards the response if the user switched accounts in `Antigravity.app` mid-flight; `persistRefreshedToken` also avoids creating a new disk token file under real `HOME` when none exists.
  - Global `ModelCatalog` discovery now strictly skips disabled/unhealthy `lastActiveAccountId` and `primaryAccountId` entries and refuses to fall back to unisolated real `HOME` when all pool accounts are disabled.
- **Fix(quota): distinguish `VALIDATION_REQUIRED` and `TOS_VIOLATION` from free-tier `403 PERMISSION_DENIED` refusals.**
  - `classifySummaryRefusal()` now checks `TOS_VIOLATION` and `VALIDATION_REQUIRED` BEFORE the generic `403 PERMISSION_DENIED` free-tier branch, preventing Pro/Ultra accounts that require Google web verification from being mislabeled as "free-tier · weekly quota only". Extracts Google's `validation_url` into `quotaUnavailable.actionUrl` and renders a red warning banner with a direct "Verify now" link in the console (all 4 locales).
- **Fix(adapter): eliminate `agy stream ended without a result event` crashes and dead 3x retry replays on idle-grace termination.**
  - When `agy 1.5+` catches `SIGTERM` from the idle-grace reaper, it can emit a bare `{ ok: false, response: '' }` error result before exiting — which `EventMapper` ignores while `rec.hasResult` became `true`, skipping synthetic reply recovery and settling `failureInfo = null` (causing `agy stream ended without a result event` followed by 3 identical dead-recording replays). `handleAttemptOutcome` now checks for a *consumable* result (`ok || response !== ''`) before skipping recovery, and `AgyAdapter` forgets a settled recording lacking any consumable result past the cursor on retry instead of re-driving it.
- **Fix(client): eliminate Antigravity console/menu scroll flicker.**
  - Static unreported (`—`) quota bars no longer run infinite `.agy-shimmer-track` GPU animations (shimmer runs only during active refresh), removed `contain: paint` / `transform: translateZ(0)` / `isolation: isolate` from `.agy-shimmer-track` and `transform` / `filter` from `.agy-btn:hover` / `.agy-card-hover`, and added ref-counted `acquireOverlaySuspend()` while `SettingsSection` is mounted so scrolling inside DSH's native Settings -> Antigravity view suspends background conversation scanners.

### 中文

- **性能(翻译)：常驻热进程池 + 默认 `low` 思考档 + 辅助通道免 SQLite 轮询。**
  - 在 macOS/Linux 新增常驻翻译进程池 `TranslationWorkerPool`（`src/features/translation/worker.ts`）：最多保留 1 个 `agy -p --output-format stream-json --input-format stream-json --mode plan`（`cwd = tmpdir()`，不传 `--add-dir` 与 `--disable-slash-commands`），按 `${accountId}|${model}|${effort}` 复用，空闲 `5m` 或累计 `8` 轮 / `32,000` 字符自动回收；后续翻译免除约 8–9 秒 CLI 冷启动与退出等待（端到端降至约 4–9 秒）。Windows 维持 `ctx.llm.stream` 以遵守系统凭据槽互斥锁。
  - 默认 `translateEffort` 由 `medium` 调整为 `low`（口语化「译成人话」无需冗长思维链），同步更新四语言提示文案。
  - 非生图辅助调用（`isAux && !isImage`）跳过 `SubagentTracker` 与 `driveSpan` 的 SQLite 思考/工具参数重试轮询，并在 `result` 成功事件到达时即刻落盘会话绑定，避免连续调用与子进程退出竞态。
- **修复(账号/模型列表与选号)：单账号模型展示 0 冗余、修复编排模型误判不可用及全局发现目录归属。**
  - 修复 Pro/Ultra 账号偶发误报 `lack model "gemini-pro-orchestrator-neon" in their catalog`：Google REST 配额接口（`fetchAvailableModels`）不会返回 CLI 虚拟编排模型（`gemini-pro-orchestrator-neon`、`gemini-pro-orchestrator-g1-pro`），导致账号尚未预热单账号 `agy models` 目录（如刚重启或刚加号）或缓存陈旧时被 `accountSupportsModel` 误拒。现支持分别通过 `gemini-4-neon` 配额与 Argon 权限证据识别编排模型，`baseModelSlug` 同步兼容 `-xhigh` 与 `-tiered-*` 后缀；全局 `ModelCatalog.refresh()` 成功时同步写入实际被探测的 `probedAccount.id` 账号目录，选号自愈 `refreshQuota` 亦补齐 `warmAccounts()`。
  - 新增纯投影模块 `buildAccountModelRows()`（`src/common/account-models.ts`），并在 `/plugins/agy-link/status` 返回分账号发现目录 `accountModels`；`catalog.count` 同步对齐当前活跃账号真实可用模型数。
  - 账号卡片展开列表不再直接平铺原始 REST 配额里的 30+ 冗余行，而是优先展示该账号自身 `agy models` 发现的去重模型与档位，回退时自动折叠 `-tiered`/档位后缀、过滤 `-sonar`/`-image` 内部项、按名称去重，且未知余量留空不伪造 `100%`。
  - `POST /plugins/agy-link/pool/refresh-quota` 单账号刷新时显式传 `catalog.forceRefresh(id)`，全量刷新时同步触发 `catalog.warmAccounts()`。
- **修复(凭据隔离)：加固 macOS/Linux `systemHome` 防切号踩踏与禁用主账号回退防护。**
  - 非 Windows 下刷新 `systemHome`（`acc_primary`）OAuth token 落盘前，再次校验实时系统钥匙串 `refreshToken` 未切换；若刷新途中用户在 `Antigravity.app` 切号则丢弃旧响应，且当真实 `HOME` 下原本无磁盘 token 文件时不新建残片。
  - `ModelCatalog` 全局发现回退严格跳过已停用或异常的 `lastActiveAccountId` / `primaryAccountId`，池内全部账号禁用时拒绝回退真实 `HOME` 触发无隔离探测。
- **修复(额度提示)：区分 `VALIDATION_REQUIRED` / `TOS_VIOLATION` 与免费账号 `403 PERMISSION_DENIED`。**
  - `classifySummaryRefusal()` 现优先识别 `TOS_VIOLATION` 与 `VALIDATION_REQUIRED`，不再把需要 Google 网页验证的 Pro/Ultra 账号误报为「免费账号 · 仅限周配额」；并从 403 响应提取 `validation_url` 存入 `quotaUnavailable.actionUrl`，在控制台以红色提示条直接给出「前往验证」链接（四语言）。
- **修复(运行稳定性)：消除 `agy stream ended without a result event` 偶发失败与 3 次无效重放。**
  - `agy 1.5+` 收到空闲收割 `SIGTERM` 时可能先吐出一个空的 `{ ok: false, response: '' }` 结果信封：`EventMapper` 会忽略该空错误，但原先 `rec.hasResult` 已为 `true` 导致跳过 SQLite 末条回复恢复并落入 `failureInfo = null`，进而触发 `agy stream ended without a result event` 且重试时 3 次重放同一条死记录。现改为判断是否存在可消费结果（`ok || response !== ''`），且续接命中无结果的已结束记录时主动忘记旧记录重新恢复。
- **修复(客户端)：根治滚动 Antigravity 控制台/设置菜单闪屏。**
  - 静态未上报（`—`）的配额条不再常驻无限 `.agy-shimmer-track` 动画（仅真正刷新中显示），移除 `.agy-shimmer-track` 的 `contain: paint` / `transform: translateZ(0)` / `isolation: isolate` 及 `.agy-btn:hover` / `.agy-card-hover` 的 `transform` / `filter` 合成层抖动，并为原生设置页挂载的 `SettingsSection` 增加引用计数 `acquireOverlaySuspend()` 暂停后台会话 DOM 扫描器。

## 0.6.46 (2026-11-20)

### English

- **Fix(idle-grace): a turn waiting on its own background work is no longer reaped (fixes #144, merges PR #146).** agy prints `root agent idle; waiting for N background task(s)` while it finishes a build, integration test or Docker job it launched. The reaper that guards against genuinely orphaned waits gave that line a **hard-coded 5 seconds** and then SIGTERM'd the whole tree, so healthy turns died mid-flight and surfaced as `agy stream ended without a result event` (`INVALID_OUTPUT`, retried three times with the same outcome). Two independent problems, both fixed:
  - **The grace is configurable**: `idleGraceMinutes` / `DSH_AGY_IDLE_GRACE_MINUTES`, default **10 minutes** (deliberately below the normal generation idle budget so a real orphan is still reclaimed). `0` disables the reaper entirely, leaving the activity watchdog and `maxTurnMinutes` to bound the turn.
  - **The reaper stays suspended while any tool step is open**, not just the subagent hand-offs from #124 — a `run_command` build is exactly the same situation. It re-arms when the last step completes.
  - **The count agy prints is now authoritative** (maintainer follow-up on top of the PR): `N > 0` means agy knows work is still running, so the reaper is not armed at all — no grace length makes killing it correct. Only `N = 0` (or a line without a count) takes the grace path, which keeps the conservative behaviour for older builds and chunk boundaries. The parsing lives in `src/runtime/agy/idle-line.ts`.
- Two existing tests encoded the old assumption (reap even with one pending task) and were split into "0 pending → reaped after grace" and "N pending → never reaped".

### 中文

- **修复(idle-grace)：等待自身后台任务的轮次不再被收割（修复 #144，合并 PR #146）。** agy 在等待自己派发的构建、集成测试或 Docker 任务时会打印 `root agent idle; waiting for N background task(s)`。负责回收真正僵尸等待的收割器给这一行**硬编码 5 秒**，随后 SIGTERM 整棵进程树，于是健康轮次被杀在半路，表现为 `agy stream ended without a result event`（`INVALID_OUTPUT`，退避重试三次仍是同一结局）。两个独立问题都已修复：
  - **宽限期可配置**：`idleGraceMinutes` / `DSH_AGY_IDLE_GRACE_MINUTES`，默认 **10 分钟**（刻意低于普通生成的空闲预算，真正被遗弃的任务仍会被回收）。`0` 彻底关闭收割器，由活动看门狗与 `maxTurnMinutes` 兜底。
  - **任意未完成的工具步骤期间收割器挂起**，不再只限 #124 的子代理交接——`run_command` 启动的构建是同一情形；最后一步完成后重新武装。
  - **agy 自己打印的任务数现在具有权威性**（维护者在 PR 基础上补充）：`N > 0` 表示 agy 明确知道还有工作未完成，此时**完全不武装**收割器——任何宽限期长度都不足以让终止变得正确。只有 `N = 0`（或该行没有数字）才走宽限期路径，从而为旧版本与分块边界保留保守行为。解析逻辑位于 `src/runtime/agy/idle-line.ts`。
- 两条既有测试固化了「即使有一个待完成任务也要收割」的旧假设，现拆为「0 个待完成 → 宽限期后收割」与「N 个待完成 → 永不收割」。

## 0.6.45 (2026-11-20)

### English

- **Fix(quota): the free-tier verdict is decided by the API status, so the branch is no longer dead code (fixes #142).** The refusal classifier checked the `license` phrase before `PERMISSION_DENIED`, and a real 403 can carry **both** — so the free-tier branch added in v0.6.42 never ran and those accounts stayed on the 6h licence window instead of the 7-day free-tier one. `PERMISSION_DENIED` (the structured API-level detail) now wins, and a licence phrase **without** it still yields `no_license`, so both branches stay reachable and are pinned by tests.
- **Fix(client): a file link actually opens in the right Sidebar preview (fixes #141).** `canPreviewFiles()` probed `sidebarRightTabs.get()` with the tab **type id**, but that method is keyed by tab **kind** (`'text'`), so the probe always returned `undefined` and every click fell through to the OS opener. It now looks the id up in `entries()` and falls back to `get('text')` while confirming the returned id, so an unrelated text tab is never mistaken for the preview. `normalizeLocalPath()` also percent-decodes now (after the `?#` split, before separator normalization), so an encoded href (`Bio%20Fuel%20Cell`, `%5C`) matches the session cwd instead of being re-encoded into a path that does not exist.
- Two existing client tests encoded the *wrong* registry contract (mocking `get()` by id); they now mock the real one, which is what let this bug pass CI.

### 中文

- **修复(额度)：免费档判定改由 API 状态决定，分支不再不可达（修复 #142）。** 拒绝分类器先匹配 `license` 字样再匹配 `PERMISSION_DENIED`，而真实 403 **两者并存**——于是 v0.6.42 新增的免费档分支从未执行，这类账号仍停留在 6 小时许可窗口而非 7 天免费档窗口。现在结构化的 `PERMISSION_DENIED` 优先；**仅含** license 字样而无该状态时仍判 `no_license`，两个分支都保持可达并有测试锁定。
- **修复(客户端)：文件链接终于进右侧边栏预览（修复 #141）。** `canPreviewFiles()` 用标签**类型 id** 去查 `sidebarRightTabs.get()`，但该方法以标签 **kind**（`'text'`）为键，探测恒为 `undefined`，每次点击都落到系统程序。现在先在 `entries()` 里按 id 查，回退到 `get('text')` 时再核对返回值的 id，避免把别的 text 标签误认成预览。`normalizeLocalPath()` 也补上百分号解码（在 `?#` 拆分之后、分隔符归一之前），因此被编码的 href（`Bio%20Fuel%20Cell`、`%5C`）能与会话 cwd 对上，而不是被二次编码成不存在的路径。
- 两个既有客户端测试固化的正是**错误的**注册表契约（把 `get()` 当 id 查询用），现已改为真实契约——这正是该 bug 能通过 CI 的原因。

## 0.6.44 (2026-11-20)

### English

- **Fix(mcp-bridge): enabling the MCP bridge on the desktop build no longer steals window focus (fixes #140).** The generated `mcp_config.json` entry used `command: process.execPath`, which on the DSH desktop build is the **Electron** binary — so every time Antigravity spawned our stdio bridge it started a second Electron instance, and that window pulled focus back to DSH on each tool call. When the host really is Electron, the entry now carries `ELECTRON_RUN_AS_NODE=1`, which makes the same binary run as a plain Node process; a normal Node host gets no extra variable. The entry is built by a new `mcpServerEntry()` so the behaviour is unit-testable without spawning anything.

### 中文

- **修复(mcp-bridge)：桌面端开启 MCP bridge 后不再抢走窗口焦点（修复 #140）。** 生成的 `mcp_config.json` 用 `command: process.execPath`，而在 DSH 桌面构建里那就是 **Electron** 可执行文件——于是 Antigravity 每次拉起我们的 stdio bridge 都会启动第二个 Electron 实例，其窗口在每次工具调用时把焦点抢回 DSH。现在检测到宿主确实是 Electron 时，条目会带上 `ELECTRON_RUN_AS_NODE=1`，让同一个二进制以纯 Node 模式运行；普通 Node 宿主不会多出这个变量。条目由新的 `mcpServerEntry()` 构建，因此无需真实 spawn 即可单元测试。

## 0.6.43 (2026-11-20)

### English

- **Fix(host): workspace files no longer 403 on every `/open` and `/media` request (fixes #139).** `activeCwds()` asserted a `values()` method on DSH's session service and guarded it with `typeof … === 'function'`; the real store exposes `list()`/`get(id)`, so the guard was always false and the function always returned `[]`. Every session workspace therefore fell outside the allowed roots and any file link inside it was refused with "path outside allowed workspace roots". It now reads `list()` (falling back to `values()` for hosts that publish that shape) and de-duplicates cwds; a throwing/unusable service still degrades to empty.
- **Fix(adapter): a DSH context message no longer looks like a user steer (fixes #138).** `detectContinuation()` only skipped trailing `source.kind === 'plugin' && form === 'snapshot'`, but DSH 0.2.2 producers each use their own kind (`time-context`, `agent-instructions`, `plugin:<name>` — dsh-llm has no catch-all `plugin` kind). Any of them after a tool result made the adapter treat the continuation as a fresh user request: it aborted the live agy run, injected "the previous turn was interrupted … respond only to the newest request", and the in-progress work was dropped. The scan now skips exactly what `isSyntheticHarnessMessage()` classifies as harness-injected (that predicate gained `agent-instructions` and the `plugin:<name>` family), while a real typed message — and any unknown boundary — still ends the scan as before.

### 中文

- **修复(host)：工作区文件不再在每次 `/open` 与 `/media` 请求上 403（修复 #139）。** `activeCwds()` 对 DSH 会话服务断言了 `values()` 并用 `typeof … === 'function'` 守卫；而真实的 store 只暴露 `list()` / `get(id)`，于是守卫恒为 false、函数永远返回 `[]`。所有会话工作区因此落在白名单之外，工作区内的文件链接一律被拒并报 "path outside allowed workspace roots"。现在读取 `list()`（对只提供 `values()` 的宿主回退），并去重 cwd；抛错时仍降级为空。
- **修复(adapter)：DSH 的上下文消息不再被误判为用户插话（修复 #138）。** `detectContinuation()` 原先只跳过末尾 `source.kind === 'plugin' && form === 'snapshot'`，但 DSH 0.2.2 的各个生产者各有自己的 kind（`time-context`、`agent-instructions`、`plugin:<name>`——dsh-llm 并没有统一的 `plugin` kind）。工具结果之后只要出现其中之一，适配器就会把续接当成新的用户请求：中止正在运行的 agy run、注入「上一轮被中断…只回应最新请求」，进行中的工作被放弃。现在扫描只跳过 `isSyntheticHarnessMessage()` 认定为宿主注入的消息（该判定新增 `agent-instructions` 与 `plugin:<name>` 家族），真实用户文本与任何未知边界仍会像以前一样终止扫描。

## 0.6.42 (2026-11-20)

### English

- **Fix(quota): a free-tier account's refused summary is suppressed instead of retried every hour (fixes #137).** A Google account without a paid Antigravity subscription has no 5h window, so `retrieveUserQuotaSummary` answers `403 PERMISSION_DENIED` — without any "licence" wording. `classifySummaryRefusal()` therefore classified it as a generic `http` failure, `quotaUnavailable` recorded it as `partial`/`unreachable`, and `quotaSummarySuppressed()` only honours `no_license`: the hourly background poll kept repeating the same 403 forever. There is now a distinct **`no_summary_access`** verdict (403 + `PERMISSION_DENIED`), recorded with a **7-day** retry window aligned to the weekly quota cycle (an unlicensed account keeps its 6h window, since a fresh licence can arrive at any time).
- **The two kinds of suppression are now separate**, which matters because they have different scope: `quotaSummarySuppressed()` skips only the summary call (the pipeline still refreshes `fetchAvailableModels` / user quota), while the new `accountPollSuppressed()` decides whether an account leaves the background poll entirely — and only a licence-less account does. Folding the free-tier case into `no_license` would have frozen its model list, so it keeps polling and merely stops hammering the refused endpoint. The console now says "free-tier account · weekly quota only" instead of a generic refresh failure (four locales).

### 中文

- **修复(额度)：免费账号被拒绝的汇总请求改为压制，而不再每小时重试（修复 #137）。** 未购买 Antigravity 付费订阅的 Google 账号没有 5 小时窗口，`retrieveUserQuotaSummary` 直接返回 `403 PERMISSION_DENIED`——正文不含任何 `licence` 字样。因此 `classifySummaryRefusal()` 把它归为通用 `http` 失败，`quotaUnavailable` 记成 `partial`/`unreachable`，而 `quotaSummarySuppressed()` 只认 `no_license`：后台每小时轮询就一直重复同一个 403。现在新增独立的 **`no_summary_access`** 判定（403 + `PERMISSION_DENIED`），并按**7 天**（对齐周配额周期）压制；无许可账号仍保持 6 小时窗口，以便新许可随时恢复。
- **两类压制现在拆开**，因为作用域不同：`quotaSummarySuppressed()` 只跳过汇总请求（管道仍刷新 `fetchAvailableModels` / 用户额度），新增的 `accountPollSuppressed()` 才决定账号是否完全退出后台轮询——只有「无许可」账号如此。若把免费账号并进 `no_license`，会连带冻结它的模型列表，所以它继续参与轮询、只是不再打那个必然被拒的端点。控制台文案改为「免费账号 · 仅限周配额」，不再是通用的刷新失败（四语言）。

## 0.6.41 (2026-11-19)

### English

- **Fix(regression from v0.6.27): plan mode is decided from the current turn, not from history (fixes #136).** `isPlanMode()` scanned **every** message backwards, so once a session's history contained `"You are in plan mode"` — in source code the user read, in tool output, or in a planning turn that had already exited — every later turn was forced to `--mode plan`. With `permissionMode: skip` that flipped the run back to `request-review`, denied every `run_command` / outside-workspace `read_file`, and ended with DSH rejecting the synthesized `exit_plan_mode` (`only available in plan mode`); the session was unrecoverable without starting a new one. `isPlanMode()` now reads **only the last message**, and only when it is a `user`/`system` turn. Two further guards: the presence of `exit_plan_mode` in the tool list is no longer treated as proof of plan mode (current DSH ships it in standard mode too), and a `exit_plan_mode is only available in plan mode` rejection is decisive evidence that the session is NOT planning, so a false positive can self-correct instead of locking the session. Regression tests cover history-in-tool-output, a genuine current-turn instruction, and the rejection signal, plus an adapter-level check that `--dangerously-skip-permissions` survives a historical mention.

### 中文

- **修复(v0.6.27 引入的回归)：plan 模式只看当前轮，不再扫历史（修复 #136）。** `isPlanMode()` 原先**从后往前扫描全部消息**，只要会话历史里出现过 `"You are in plan mode"`——用户读过的源码、工具输出、或一次已经退出的规划轮——之后每一轮都会被强制 `--mode plan`。在 `permissionMode: skip` 下，这会退回 `request-review`、拒绝所有 `run_command` 与工作区外 `read_file`，并在回合结束时报 `exit_plan_mode is only available in plan mode`；会话无法恢复，只能新开。现在 `isPlanMode()` **只读最后一条消息**，且要求其角色为 `user`/`system`。另加两道保险：工具列表里出现 `exit_plan_mode` 不再被当作 plan 模式的证据（当前 DSH 标准模式也会下发该工具）；出现 `exit_plan_mode is only available in plan mode` 的拒绝即判定为非 plan，使误判能自我纠正而不是永久锁死。回归测试覆盖「历史工具输出误命中」「当前轮真实指令」「拒绝信号」三种情形，并补一条 adapter 级验证：历史提及不得抹掉 `--dangerously-skip-permissions`。

## 0.6.40 (2026-11-19)

### English

- **Improve(diagnostics): `AGY_NOT_INSTALLED` now says where agy was searched and how to point at it (merges PR #133).** The error used to read only "install it via …", which says "not installed" — but the more common case is the CLI being installed while a GUI-launched host inherits a different `PATH`. `resolveAgyBin()`'s probe list was computed and then discarded; it is now preserved. `agyBinCandidates()` splits the collection out, `agyBinDiagnostics()` adds the configured `agyBin` and the per-platform install hint, and `agyNotInstalledMessage()` reports the probed locations, both documented overrides (`agyBin` config / `DSH_AGY_BIN`) and a `/agy doctor` pointer. The header badge uses the same text, and `/agy doctor` lists every probed path under `agy lookup`. `resolveAgyBin()` keeps its signature and behaviour; 9 new tests. Thanks to @angel12538.
- **Test:** the PATH-probe case now injects its own `PATH` instead of assuming the host has a `nodejs` directory, so it passes on any machine.

### 中文

- **改进(诊断)：`AGY_NOT_INSTALLED` 现在会说明搜索过哪些位置、以及如何指向二进制（合并 PR #133）。** 此前错误文案只有「install it via …」，读起来就是「没装」——但更常见的情况是 CLI 已安装，只是 GUI 启动的宿主继承了不同的 `PATH`。`resolveAgyBin()` 原本算完探测列表就丢弃，现在保留下来：`agyBinCandidates()` 拆出候选收集，`agyBinDiagnostics()` 补充已配置的 `agyBin` 与各平台安装提示，`agyNotInstalledMessage()` 输出探测位置、两种已文档化的覆盖方式（`agyBin` 配置 / `DSH_AGY_BIN`）以及 `/agy doctor` 指路。头部徽标复用同一文案，`/agy doctor` 在 `agy lookup` 段列出每个探测路径。`resolveAgyBin()` 签名与行为不变；新增 9 条测试。感谢 @angel12538。
- **测试**：PATH 探测用例改为注入自定义 `PATH`，不再假设宿主存在 `nodejs` 目录，因此任何机器都能通过。

## 0.6.39 (2026-11-19)

### English

- **Fix(quota): a manual pool refresh no longer freezes one account for days or takes a minute (reported live: "the first one refreshed, the second is just stuck, and every refresh is far too slow").** Two independent causes, both fixed:
  - **Stuck row.** An account whose `retrieveUserQuotaSummary` was refused (`403 You do not have a valid license of this product`, with `ECONNRESET` on the daily endpoint) produced no authoritative snapshot — and `buildFamilyQuotas` deliberately keeps the previous complete value, so the card kept rendering yesterday's percentages with **no error anywhere** (three `catch` layers swallowed it and the route had already answered `ok`). The pipeline now records `quotaUnavailable = { reason, since, retryAfter, detail }` on the account (`no_license` / `auth` / `unreachable` / `partial`), the console renders "Quota refresh failed · <reason> · figures last updated <time>", and an authoritative snapshot clears the marker. A `no_license` account also leaves the hourly background sweep for `QUOTA_LICENSE_RETRY_MS` (6h) and skips the doomed summary call entirely, while an explicit click still probes (so a renewed licence recovers immediately).
  - **Slow.** `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` resets the connection for every account on this machine (measured 5.3-8.4s) while the sandbox endpoint answers, and every quota call walked the fixed endpoint list from that dead end first — on every account, every refresh, including the background sweep. A per-operation endpoint health memory (`QUOTA_ENDPOINT_DOWN_MS` 10min) now tries recently-failed endpoints last (never skipping them; a total outage still probes), and a user-initiated sweep may run 2 same-egress accounts in parallel with the existing 400-850ms start jitter (`sweep.ts`); the unattended sweep stays strictly serial. One five-account pool that measured ~55s now finishes its per-account work in roughly the time of two cascades.
- **Fix(ui): refresh progress is real, and a duplicate click says so.** `/status` now exposes `quotaRefreshing` (the host's in-flight account ids) and account cards render "syncing" from it instead of from the click that cleared the moment the route answered; `/pool/refresh-quota` returns `alreadyRunning: true` when the same key is still in flight, so the console says "a refresh is already running" instead of a false "started".

### 中文

- **修复(额度)：手动刷新账号池不再让某个号「永远卡住」，也不再慢到一分钟（现场反馈：第一个刷出来了、第二个一直卡着、每个都慢得离谱）。** 两个独立根因，都已修复：
  - **卡住**。某账号的 `retrieveUserQuotaSummary` 被拒（`403 You do not have a valid license of this product`，daily 端点还 `ECONNRESET`），拿不到权威快照；而 `buildFamilyQuotas` 的设计是**保留上一份完整数据**（防止部分回退数据覆盖好数据），于是卡片一直渲染前一天的百分比，**任何地方都没有报错**（三层 `catch` 全吞、路由还提前回了 `ok`）。现在管线把 `quotaUnavailable = { reason, since, retryAfter, detail }` 写到账号上（`no_license` / `auth` / `unreachable` / `partial`），控制台渲染「配额刷新失败 · 原因 · 数据停留在 <时间>」，拿到权威快照即清除标记。`no_license` 账号同时退出每小时后台轮询 `QUOTA_LICENSE_RETRY_MS`（6 小时）并跳过注定失败的摘要请求；**用户手动点击仍然必探**（续费后可立即恢复）。
  - **慢**。`daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` 对本机每个账号都重置连接（实测 5.3~8.4 秒），而 sandbox 端点正常，但每次配额调用都从这条死端点起步——每个账号、每次刷新、包括后台轮询。新增按「操作|端点」的失败记忆（`QUOTA_ENDPOINT_DOWN_MS` 10 分钟），把刚失败的端点排到最后（**绝不跳过**，全部失败时仍按原序探测）；用户手动全池刷新允许**同一出口内 2 个账号并发**并保留原有 `400~850ms` 起点抖动（`sweep.ts`），后台轮询仍严格串行。实测 5 号同出口的池子从约 55 秒降到约两个级联的时间。
- **修复(UI)：刷新进度是真的，重复点击也有话讲。** `/status` 新增 `quotaRefreshing`（宿主在途的账号 id），账号卡据此渲染「同步中」，不再依赖「点击后立刻清空」的客户端状态；`/pool/refresh-quota` 在同 key 仍在途时返回 `alreadyRunning: true`，控制台提示「正在刷新中」而不是谎报「已开始刷新」。

## 0.6.38 (2026-11-19)

### English

- **Fix(host): a missing OS opener no longer kills the DSH process (fixes #129, merges PR #132).** `executeOpenInSystem()` called `spawn('xdg-open', …)` with no `error` listener. A missing (ENOENT) or non-executable (EACCES) opener is reported **asynchronously**, so the surrounding try/catch never saw it and Node raised an `uncaughtException` — on a headless Linux host every "open in app" click exited the server (systemd restarted it four times). New `spawnDetachedOpener()` attaches the listener before the first tick on every platform branch, so a launch failure is contained instead of fatal; a synchronous throw still reports `{ ok: false, error }`. On headless hosts the click is now a silent no-op rather than a crash — an explicit "no desktop session" message would need a logger in the route, tracked but not bundled here.
- **Fix(quota): a shared Gemini pool is no longer misfiled as a dedicated Argon pool (fixes #130, merges PR #131).** Since agy 1.5.12 the plain `Gemini Models` group describes itself as "Models within this group: Gemini 4 Neon, … Gemini 4 Argon, …", and both `summaryHasArgonGroup()` and the summary→family mapping treated any `description` containing "argon" as proof of a dedicated pool. The shared pool was then written to the `argon` family, `google` lost its weekly numbers, a phantom `Argon` row appeared, and `noteDedicatedGroup('argon')` skewed selection and cooldown release. Dedicated-pool detection now accepts only the **group display name** or a **bucket id/name** containing "argon"; description-only mentions are ignored, while real Argon groups (`Gemini 4 Argon`, `argon-weekly`) are still recognised and the folded-into-Gemini case is unchanged.

### 中文

- **修复(host)：缺失的系统打开器不再杀死 DSH 进程（修复 #129，合并 PR #132）。** `executeOpenInSystem()` 直接 `spawn('xdg-open', …)` 且没有 `error` 监听。可执行文件缺失（ENOENT）或不可执行（EACCES）是**异步**通过 `error` 事件上报的，外层 try/catch 捕获不到，Node 于是抛 `uncaughtException`——在 headless Linux 上每次点「打开」都会让服务退出（systemd 连着重启了四次）。新增 `spawnDetachedOpener()`，在所有平台分支的第一个 tick 之前挂好监听，启动失败被收敛而不是致命；同步抛错仍返回 `{ ok: false, error }`。headless 主机上现在表现为静默无操作而非崩溃；若要在 UI 上明确提示「没有桌面会话」，需要路由层具备 logger，已记录但不在本次捆绑。
- **修复(额度)：共享 Gemini 池不再被误判为独立 Argon 池（修复 #130，合并 PR #131）。** agy 1.5.12 起普通 `Gemini Models` 组的 description 会枚举成员（「Models within this group: Gemini 4 Neon, … Gemini 4 Argon, …」），而 `summaryHasArgonGroup()` 与 summary→family 映射都把「description 含 argon」当作独立池证据。结果共享池被写进 `argon` 族、`google` 丢掉 weekly 数字、面板多出假的 `Argon` 行，`noteDedicatedGroup('argon')` 还会影响选号与 cooldown 释放。现在独立池只由**组 displayName** 或 **bucket id/name** 含 "argon" 认定；description-only 的提及被忽略，真实 Argon 组（`Gemini 4 Argon`、`argon-weekly`）仍能识别，「Argon 已并入 Gemini」的折叠场景行为不变。

## 0.6.37 (2026-11-19)

### English

- **Test coverage hardening on the turn-ending and boot-hygiene paths (no behaviour change).** The branch gate sat at 80.16%, leaving almost no margin for the next change. Added edge-case coverage for the idle-grace reply recovery (torn JSON rows, non-object rows, a directory where the transcript should be, an empty file) and for boot credential hygiene (an isolated pool home with no token file is quarantined and logged; a home whose credential came back has the quarantine lifted; system-home and dir-less accounts are never touched). `boot-hygiene.ts` branch coverage 45.8% → 73.9% (lines 68% → 80%), `idle-grace-reply.ts` 96/71 → 100/88, and the suite is now 1167 tests with the branch gate at 80.25%.

### 中文

- **收尾路径与启动期凭据卫生的测试覆盖加固（无行为变化）。** 分支门禁此前仅 80.16%，几乎没给下一次改动留余量。为 idle 回收的答复恢复补了边界用例（截断的 JSON 行、非对象行、transcript 位置被目录占用、空文件），并为启动期凭据卫生补了三条（隔离账号缺 token 文件时被隔离并记录；凭据回填后解除隔离；system-home 与无 dir 账号绝不触碰）。`boot-hygiene.ts` 分支 45.8% → 73.9%（行 68% → 80%），`idle-grace-reply.ts` 96/71 → 100/88，全量 1167 项、分支门禁提升到 80.25%。

## 0.6.36 (2026-11-19)

### English

- **Fix: an idle-reaped turn no longer loses its final answer (fixes #128 bug 2, addresses #127).** When the 5s idle reaper ended a turn whose final `PLANNER_RESPONSE` was already written to agy's `transcript.jsonl` but had not been flushed to stdout, the synthesized result carried `response: ''` — DSH then rendered a clean "completed" turn with **no reply bubble**, which reads as success for work that was never confirmed. `recoverFinalReply()` now reads a bounded (≤256 KiB) tail of `<brainDir>/.system_generated/logs/transcript.jsonl` and returns the last `PLANNER_RESPONSE` **after the final `USER_INPUT`** whose `content` is non-empty and which carries no pending `tool_calls`; the synthesized result uses it. When nothing can be recovered, a bilingual notice states the background wait ended without a confirmed outcome and that some steps may have run — the turn still finishes cleanly, and turns that already produced an answer are untouched.
- **Already fixed upstream, verified:** #128 bug 1 (historical subagent banners replayed on `--conversation` resume) is covered by v0.6.35's `SubagentTracker` baseline (`resumed` + `baselineExisting()`), which seeds pre-existing descriptors into `seenStepKeys` and starts transcripts at EOF.

### 中文

- **修复：被 idle 回收的轮次不再丢失最终答复（修复 #128 bug 2，回应 #127）。** 当 5s 回收发生在「最终 `PLANNER_RESPONSE` 已写入 agy `transcript.jsonl`、但尚未由 stdout 刷出」的时间窗内时，合成的 result 里 `response` 是空串，DSH 因此显示「正常完成」却**没有任何正文气泡**——这会被读成任务成功，而实际结果未确认。新增 `recoverFinalReply()`：有界读取（≤256 KiB）`<brainDir>/.system_generated/logs/transcript.jsonl` 尾部，返回**最后一条 `USER_INPUT` 之后**、`content` 非空且**无待执行 `tool_calls`** 的 `PLANNER_RESPONSE`，并写入合成 result。恢复不到时改为中英双语提示「后台等待已结束、结果未确认、部分操作可能已执行」；该轮仍以正常 finish 收尾，已有答复的回合完全不受影响。
- **上游已修复并核实**：#128 bug 1（`--conversation` 续接时重放历史子代理横幅）已由 v0.6.35 的 `SubagentTracker` 基线机制覆盖（`resumed` + `baselineExisting()`，把既有描述符预先记入 `seenStepKeys` 并把 transcript 起点设在 EOF）。

## 0.6.35 (2026-11-18)

### English

- **Risk control & quota pacing:** Added quota burn-rate & reset-pacing estimator (`common/quota-pacing.ts`), serialized burst spawns via `spawn-limiter.ts`, tightened false `authRequired` prevention against transient auth-check jitter (`pool-auth.ts`, `failure.ts`), and avoided aggressive/redundant network probes (`http.ts`, `token.ts`, `refresh.ts`, `warmup/service.ts`).
- **Instant model sync & 1-click reauth:** Pushed live model-catalog updates cleanly to DSH's session picker and added direct per-account 1-click re-authentication (`/pool/begin-add`, `AccountsPanel`, `useAuthFlow`) plus ETag/304 conditional polling on `/plugins/agy-link/status`.
- **Subagent state consistency & `CANCELED` handling:** `SubagentTracker` now baselines pre-existing descriptors when `conversationId` arrives late via `setConversationId()` on resumed turns (stopping stale `SUBAGENT_STATE_ALIVE` files from re-announcing as newly opened), honors descriptor `state` (never announces `已启动协同专员` for killed/failed descriptors), polls `ALIVE -> KILLED/STOPPED` transitions and transcript `ERROR`/`CANCELED` statuses, and surfaces `CANCELED` tool steps cleanly across `parser.ts`, `EventMapper`, and `tool-watchdog.ts` (including dropping idle-grace exemption when a subagent spawn fails or cancels).
- **Performance, UI & SSOT architecture:** O(1) SQLite metadata caching & async `git` HEAD lookup (`git-head.ts`), zero unkeyed React array-child warnings across client components, locales split under `src/client/locales/`, zero-redundancy domain consolidation (`quota-pacing.ts`, `countdown.ts`, `models/parse.ts`, `service-helpers.ts`), and living `.spec/` single-source-of-truth specifications across 225 modules.

### 中文

- **风控与额度节律保护**：新增额度消耗速率与重置节律估算（`common/quota-pacing.ts`）、并发限流启动器（`spawn-limiter.ts`），收紧瞬时鉴权抖动对 `authRequired` 的误判（`pool-auth.ts`、`failure.ts`），避免过度轮询与冗余网络探测。
- **模型列表实时同步与一键重登**：切换账号/刷新目录时及时同步推送更新到 DSH 会话模型选择器；新增账号池一键原位重登（`/pool/begin-add`、`AccountsPanel`、`useAuthFlow`）及 `/status` ETag/304 条件轮询，减少高频重绘与状态抖动。
- **子代理状态一致性与 `CANCELED` 收口**：修复 `SubagentTracker` 在续接会话延迟拿到 `conversationId` 时漏做历史基线导致重放旧 `SUBAGENT_STATE_ALIVE` 为「已启动协同专员」的问题；校验描述符 `state`（初始即终止不误报启动）、持续感知 `ALIVE -> KILLED` 跃迁与 `transcript.jsonl` 中的 `ERROR`/`CANCELED` 状态；并在 `parser.ts`、`EventMapper` 与 `tool-watchdog.ts` 中将 `CANCELED` 工具步按异常收口（子代理派发失败/取消时立即解除 idle 回收豁免）。
- **性能、前端零告警与 `.spec/` 单一事实源**：SQLite 元数据 O(1) 缓存、异步 `git HEAD` 查询（`git-head.ts`）、修复前端数组子元素缺 `key` 告警、拆分 `src/client/locales/`、收敛冗余逻辑，并建立覆盖 225 模块的 `.spec/` 活文档。

## 0.6.34 (2026-11-18)

### English

- **Fix(regression from v0.6.32/PR #119): subagent turns no longer die 5s after going idle (fixes #124).** Two linked defects. (1) `RunRecording.hasResult` was `resultConversationId !== null`, but `init` sets that id on the very first frame — so it was true before any `result` envelope, the synthetic result appended on an idle-grace kill never ran, and every such turn ended in `agy stream ended without a result event`. It now reflects an actual `result` event; the conversation id still comes from `init`. (2) The 5s idle reaper could not tell an orphaned background command from agy legitimately waiting for `invoke_subagent` / `send_message` / `run_workflow` / `swarm`. `RunningProcess.exemptIdleGrace()` now suspends the reaper while such a tool is outstanding (raised by the tool watchdog, cleared when the root agent speaks again), and new stdout output cancels a pending kill so a wake-up cannot race it. The orphan reaper still fires once the wait ends, and `maxTurnMinutes` / the activity watchdog still bound the total.
- **Fix(diagnostics): a stale model snapshot heals itself before failing the turn (fixes #125).** `accountSupportsModel()` still answers per account — that answer routes requests, so corroborating across accounts made selection pick an account that could not serve the model. Instead, when EVERY enabled account is denied *solely* because the requested model is missing from its per-model snapshot, `selectSessionAccount()` now refreshes pool quotas + catalog once (20s cap, non-forced so cooldowns are respected) and retries selection. A genuinely unsupported model simply fails the retry; quota/auth/cooldown blockers never trigger the refresh.
- **Refactor(modules):** extracted `src/provider/tool-watchdog.ts` and `src/host/model-support.ts` so `attempt.ts` / `pool.ts` stay under the 600-line budget with cohesive units rather than compressed comments. Test margins for two subprocess-based suites were widened so a cold Node start on a busy host cannot fail them spuriously.

### 中文

- **修复(v0.6.32 / PR #119 的回归)：子代理轮次不再在空闲 5 秒后被误杀（修复 #124）。** 两个联动缺陷。(1) `RunRecording.hasResult` 原先判断 `resultConversationId !== null`，而 `init` 在第一帧就写入了该 id——于是任何真实运行从第一帧起 `hasResult` 就为真，idle 宽限终止时合成的 result 成了死代码，每轮都以 `agy stream ended without a result event` 结束。现在只认真正的 `result` 事件；会话 id 仍由 `init` 提供。(2) 5 秒 idle 回收器无法区分「残留后台命令」与「agy 正常等待子代理回报」。新增 `RunningProcess.exemptIdleGrace()`：子代理协作工具未完成时挂起回收器（由工具看门狗置位、根 Agent 再次发言时清除），并让新的 stdout 输出取消已挂起的终止，避免唤醒竞态被误杀。等待结束后残留后台任务仍会被回收，总时长仍受 `maxTurnMinutes` 与活动看门狗约束。
- **修复(诊断)：陈旧模型快照在整轮失败前先自愈一次（修复 #125）。** `accountSupportsModel()` 仍按账号作答——该答案用于路由，跨账号互证会让选择器挑到无法服务该模型的账号。改为：当**所有启用账号都仅因「型号不在 per-model 快照」被淘汰**时，`selectSessionAccount()` 先刷新一次号池额度与目录（上限 20s、非强制以尊重冷却），再重试选择。型号确实不受支持时重试仍失败；额度/认证/冷却类阻塞不会触发刷新。
- **重构(模块)**：抽出 `src/provider/tool-watchdog.ts` 与 `src/host/model-support.ts`，让 `attempt.ts` / `pool.ts` 以高内聚单元而非压缩注释维持在 600 行预算内。两处子进程测试的 margin 放宽，避免忙主机上冷启动 Node 造成的假失败。

## 0.6.33 (2026-11-17)

### English

- **Fix(diagnostics): "model not in catalog" is no longer reported as a missing plan (fixes #120, #122).** `explainIneligibility()` used one `'unsupported'` reason for both "the account has no access to this family/plan" and "this model id isn't in the account's catalog"; `unavailableError()` then always hinted `requires a plan with google enabled`. That sent users account-shopping when every account simply lacked the model. A distinct `'model-unsupported'` reason now produces a targeted message ("not in any enabled account's catalog — refresh the model list or pick a listed model; NOT a missing plan"), while genuine family-level `unsupported` keeps its original wording.
- **Fix(models): a stale/fallback `agy models` snapshot can no longer veto the account's own quota groups (fixes #122).** `accountSupportsModel()` treated a negative `source: 'discovered'` catalog as authoritative even when the snapshot was captured while agy's auth was unavailable (a static 4/6-item fallback list) or simply stale. A discovered catalog still affirms positively; a *negative* entry now yields to explicit per-model quota evidence, so `gemini-4-hydrogen` from a fresh `/pool/refresh-quota` is selected without manually re-activating every account.
- Tests: new pure regression file for the reason split and stale-catalog veto, plus an updated error-message assertion. A family with no quota evidence still reports `unsupported`; a catalog with no quota evidence remains authoritative.

### 中文

- **修复(诊断)：「模型不在目录」不再误报为套餐缺失（修复 #120、#122）。** `explainIneligibility()` 把「账号没有该 family/套餐权限」与「该 model id 不在账号目录」都归为 `'unsupported'`，`unavailableError()` 于是一律提示 `requires a plan with google enabled`——用户会误以为掉权限而反复换号，实则所有账号都没有这个型号。现在新增独立的 `'model-unsupported'` 原因，文案改为「不在任何启用账号的目录里——刷新模型列表或换一个已列出的型号；不是套餐问题」；真正的 family 级 `unsupported` 文案保持不变。
- **修复(模型)：陈旧/兜底的 `agy models` 快照不再否决账号自身额度组（修复 #122）。** `accountSupportsModel()` 此前把 `source: 'discovered'` 目录的**否定**结果当权威，即使该快照是 agy 鉴权未就绪时打印的静态 4/6 条兜底清单、或已经陈旧。现在已发现目录仍可**正向确认**模型；但**否定**结果要让位于明确的 per-model 额度证据，因此执行 `/pool/refresh-quota` 后即可选到 `gemini-4-hydrogen`，无需逐账号手工 `set-active` 重探。
- 测试：新增纯函数回归覆盖原因分流与陈旧目录否决，并更新错误文案断言。无额度证据时 family 仍报 `unsupported`，无额度证据时目录仍为权威。

## 0.6.32 (2026-11-17)

### English

- **Fix(provider): a turn can no longer hang for hours on agy background tasks (merges PR #119).** When a command backgrounds itself (a dev server, or a GUI dialog blocking on an uncaught exception), agy's root agent finishes the reply but then waits up to 4h for the background task. Routine daemon stderr chatter (`fetchAvailableModels`, `token refreshed`, `loadCodeAssist`, …) was re-arming the stderr keepalive watchdog every ~6 minutes, so neither the 10-minute idle budget nor the 240-minute print timeout ever fired and `proc.outcome` never settled — DSH hung at `eventsFrom`. Now background stderr noise is filtered, `root agent idle; waiting …` starts a 5s grace then terminates the process tree (`idleGraceTerminated`), `classifyFailure()` treats that as a normal completion, and a synthetic successful `result` event closes the mapper/usage/finish chain when agy emitted no envelope. `openToolKeys` is released when the model resumes text/thinking or a tool reaches `RUNNING`, and `printTimeoutMinutes` respects `maxTurnMinutes` (default `longToolIdleMinutes: 240` is unchanged).
- **Refactor(timeouts): `IDLE_BACKGROUND_GRACE_MS` lives in `common/timeouts.ts`** alongside the other deadlines — no second constant inside `process.ts`. `.spec/process-lifecycle.md` documents the termination invariants (local, gitignored).
- Tests: five subprocess-bounded regressions (idle grace, both message forms, normal-completion classification, `RUNNING` tool card, noise not feeding the watchdog). Thanks to @Ronnoc for the diagnosis and patch.

### 中文

- **修复(provider)：一轮对话不再因 agy 后台任务挂起数小时（合并 PR #119）。** 命令自行后台化（dev server、未捕获异常卡住的 GUI 弹窗等）时，agy 根 Agent 已产出全部回复，却会为后台任务等待最多 4 小时；守护进程每约 6 分钟打印的例行 stderr 日志（`fetchAvailableModels`、`token refreshed`、`loadCodeAssist` 等）又不断喂狗，10 分钟空闲预算与 240 分钟 print 超时都不会触发，`proc.outcome` 永不 settle，DSH 卡在 `eventsFrom`。现在过滤后台噪声、识别 `root agent idle; waiting …` 后给 5s 宽限并终止进程树（`idleGraceTerminated`），`classifyFailure()` 视为正常完成；若 agy 未发 result envelope，则合成一条成功的 result 事件闭合 mapper/usage/finish 链。模型恢复 text/thinking 或工具进入 `RUNNING` 时释放 `openToolKeys`，`printTimeoutMinutes` 受 `maxTurnMinutes` 约束（缺省 `longToolIdleMinutes: 240` 不变）。
- **重构(超时常量)**：`IDLE_BACKGROUND_GRACE_MS` 与其他 deadline 一起收敛到 `common/timeouts.ts`，`process.ts` 不再另立常量。`.spec/process-lifecycle.md` 记录终止不变式（本地 gitignored）。
- 测试：5 条子进程有界回归（idle 宽限、两种文案、正常完成分类、`RUNNING` 工具卡片、噪声不喂狗）。感谢 @Ronnoc 的定位与补丁。

## 0.6.31 (2026-11-16)

### English

- **Refactor(host): extract the effort-unsupported persistence into its own store (5-day review).** `createEffortUnsupportedStore()` now owns the file path, the filter/dedupe rules, the picker notification and the live-reload invariant; the composition factory only wires it in. `src/host/services.ts` drops from 599 to 576 lines, giving the three modules that sat on the 600-line ceiling real headroom again. **No behaviour change** — the existing `HostServices` surface and `test/services.test.ts` contract are unchanged, and the new module has its own filesystem-level tests (filtering, invalid/missing file, live reload, dedupe, persistence failure). Architecture/budget gates stay at 215 modules, 0 cycles, 0 violations.

### 中文

- **重构(host)：把 effort-unsupported 持久化拆成独立 store（5 天全面 review）。** `createEffortUnsupportedStore()` 统一持有文件路径、过滤/去重规则、picker 广播与即时重载不变式；组合工厂只负责装配。`src/host/services.ts` 从 599 行降到 576 行，让三处贴在 600 行上限的模块重新有了余量。**行为零变化**：`HostServices` 对外形状与 `test/services.test.ts` 契约保持不变，新模块自带文件系统级测试（过滤、缺失/非法文件、外部修改即时生效、去重、写盘失败）。架构/预算门禁仍为 215 模块、0 环、0 违规。

## 0.6.30 (2026-11-16)

### English

- **Fix(parser): bounded protobuf varint lengths — no more main-thread hangs (fixes #116, merges PR #117).** `readVarint()` accumulated with `val |= (byte & 0x7f) << shift`, which coerces to signed 32-bit: `2 ** 31` decoded as `-2147483648`, and six-byte lengths wrapped the shift modulo 32 (`2 ** 35 + 1` → `9`). Both length-delimited walkers only checked the upper bound, so a negative/oversized length moved the cursor backwards (observed `pos = -2064995381` on a 336-byte buffer) and the synchronous parse wedged DSH's web listener. Lengths now accumulate numerically with a safe-integer check, offsets are validated, and both outer and field-20 walkers reject any length that exceeds the remaining bytes. Four subprocess-bounded regressions cover nested overflow, six-byte wraparound, valid sibling thoughts after malformed nesting, and truncated input — the dangerous cases run in a killable child so the suite itself cannot hang. Thanks to @MorseWayne for the stack trace, synthetic reproduction and patch.

### 中文

- **修复(解析器)：为 protobuf 长度 varint 加边界，避免主线程卡死（修复 #116，合并 PR #117）。** `readVarint()` 原先用 `val |= (byte & 0x7f) << shift` 累积，JS 位运算会截断成有符号 32 位：`2 ** 31` 被解成 `-2147483648`，六字节长度的 shift 还会按 32 回绕（`2 ** 35 + 1` → `9`）。两层 length-delimited walker 只检查长度上界，负长度会让游标大幅回退（现场 336 字节 buffer 上 `pos = -2064995381`），同步解析直接把 DSH web 监听器卡住。现在改为数值累积 + 安全整数校验、校验读取偏移，outer 与 field-20 两层均拒绝超过剩余字节数的长度。四条子进程有界回归覆盖多层嵌套溢出、六字节回绕、异常嵌套后仍能取到后续有效思考内容、截断输入；危险输入放在可被 kill 的子进程里，避免测试自身阻塞。感谢 @MorseWayne 提供堆栈、合成复现与补丁。

## 0.6.29 (2026-11-15)

### English

- **Fix(models): a transient refusal can no longer blacklist a model's reasoning efforts (fixes #115).** When agy's model-config fetch fails (e.g. a `loadCodeAssist` TLS timeout), its print-mode validation emits a perfectly well-formed `--effort is not supported for model "X"` even though `agy models` lists that level. `streamWithEffortRetry()` learned ANY such refusal as a static capability: the model went into `effort-unsupported.json`, `resolveModel()` stopped advertising `reasoning`, and DSH then rejected later turns with `UNSUPPORTED_REASONING_EFFORT` while the live catalog still showed `xhigh`. A new `ModelCatalog.advertisedEfforts()` collects the efforts the **discovered** catalog (base + per-account) advertises; a refusal that contradicts it is still replayed without `--effort` (the #67 invariant) but is NOT persisted. Fallback entries are deliberately not evidence.
- **Fix(models): `effort-unsupported.json` is now live-reloaded.** The host no longer caches the file for the process lifetime, and `EffortPolicy` rebuilds when the seed changes (keeping refusals learned in the current process), so an operator clearing a false entry no longer needs to restart DSH.
- Tests: real discovered-catalog regression (refusal not learned, effort row preserved), external-edit visibility, and file re-read. Thanks to @AlaIchhe for the timeline, transcript evidence and the minimal reproduction.

### 中文

- **修复(模型)：瞬时拒绝不再把模型的思考档位永久拉黑（修复 #115）。** agy 在模型配置拉取失败（如 `loadCodeAssist` TLS 超时）时，print-mode 硬校验会输出**格式完全合法**的 `--effort is not supported for model "X"`，而 `agy models` 明明列着该档位。`streamWithEffortRetry()` 此前把任何这类拒绝当作静态能力学习：写入 `effort-unsupported.json`、`resolveModel()` 不再发布 `reasoning`，于是 DSH 后续轮次直接抛 `UNSUPPORTED_REASONING_EFFORT`，档位行永久消失，而实时目录仍显示 `xhigh`。新增 `ModelCatalog.advertisedEfforts()` 汇总**已发现**目录（base + 各账号）声明的档位；与目录矛盾的拒绝仍按 #67 重放一次（不带 `--effort`），但**不落盘、不收回能力声明**。fallback 阵容是静态镜像，不作为证据。
- **修复(模型)：`effort-unsupported.json` 现在即时生效。** 宿主不再对文件做进程级缓存，`EffortPolicy` 在 seed 变化时重建（保留本进程学到的条目），运维清空误学条目后无需重启 DSH。
- 测试：真实已发现目录回归（矛盾拒绝不学习、档位行保留）、外部修改即时可见、文件重读。感谢 @AlaIchhe 提供时间线、transcript 证据与最小复现。

## 0.6.28 (2026-11-15)

### English

- **Fix(auth): a terminal TOS quarantine can no longer be cleared by the same warmup request (fixes #114).** v0.6.26 correctly marked a `TOS_VIOLATION` account `authRequired`, but `handlePoolWarmup` then ran an unconditional `refreshAccountQuota(acc, true)`; the quota pipeline (and boot hygiene / token refresh) calls `clearAuthRequired` on any successful refresh. A banned account still has a valid refresh token, so the flag was set and cleared within one HTTP request, and `needsAuthReverify` would have retried it every 10 minutes. `clearAuthRequired(id, force = false)` now refuses to lift a terminal ban; only **explicit user actions** (a completed OAuth login or a fresh credential import) pass `force: true`. `needsAuthReverify()` excludes terminal errors. Regression tests: pure classifier, real `AccountPoolManager` stickiness, and a route-level warmup → forced quota refresh → still `authRequired` test.

### 中文

- **修复(认证)：TOS 终态隔离不再被同一轮 warmup 清除（修复 #114）。** v0.6.26 已正确把 `TOS_VIOLATION` 账号标为 `authRequired`，但 `handlePoolWarmup` 随后无条件执行 `refreshAccountQuota(acc, true)`，而配额流水线（以及启动凭据恢复、token 刷新）在任何一次刷新成功后都会调用 `clearAuthRequired`。被停用账号的 refresh_token 仍然有效，于是「打标记 → 清标记」发生在同一次 HTTP 请求内，`needsAuthReverify` 还会每 10 分钟重试一次。现在 `clearAuthRequired(id, force = false)` 拒绝解除终态封禁；只有**显式用户操作**（完成 OAuth 登录、重新导入凭据）传入 `force: true`。`needsAuthReverify()` 也排除终态错误。回归测试覆盖：纯分类器、真实 `AccountPoolManager` 的粘性，以及路由级「预热 → 强制配额刷新 → authRequired 仍为真」。

## 0.6.27 (2026-11-15)

### English

- **Fix(security): DSH plan mode is now read-only at the agy layer (issue #113, part 2).** `permissionMode` was always taken from the static config (default `skip` → `--dangerously-skip-permissions`), so during a plan-mode turn agy could still write files and the `exit_plan_mode` approval card only constrained the prompt. A new `effectivePermissionMode()` forces `--mode plan` when the host is in plan mode, using the presence of the `exit_plan_mode` tool as a **current-turn** signal so exiting plan mode immediately restores the configured mode; auxiliary calls keep their existing read-only policy. Pure decision matrix + real-spawn argv regression tests.
- **Not planned: interactive `ask_question` / `/grill-me` (issue #113, part 1).** This is not a filter bug: agy's `-p` / `--input-format stream-json` print mode is one-way and auto-answers `ask_question` with `User Skipped`. Making it interactive requires replacing the bridge's transport with ACP (`agy acp`, stdio JSON-RPC) — a different session lifecycle, streaming protocol and tool-mirroring path, i.e. a separate architectural project, not a patch. The question card rendering already exists; it appears after the turn because print mode cannot pause. Tracked in the issue reply, not shipped here.

### 中文

- **修复(安全)：DSH plan mode 在 agy 层也强制只读（issue #113 第 2 项）。** `permissionMode` 此前只取静态配置（缺省 `skip` → `--dangerously-skip-permissions`），所以规划轮次里 agy 仍能直接写文件，`exit_plan_mode` 审批卡只约束了提示词。新增 `effectivePermissionMode()`：当宿主处于 plan mode 时强制 `--mode plan`，并以「本轮提供了 `exit_plan_mode` 工具」作为当前轮次信号（避免历史里的 plan 提示词让会话永久只读），退出 plan mode 立即恢复配置值；辅助调用沿用既有只读策略。纯函数矩阵 + 真实 spawn argv 双重回归测试。
- **暂不实现：交互式 `ask_question` / `/grill-me`（issue #113 第 1 项）。** 这不是过滤逻辑缺陷：agy 的 `-p` / `--input-format stream-json` 是单向 print 模式，会把 `ask_question` 自动回填 `User Skipped`。要真正交互必须把桥接层传输协议换成 ACP（`agy acp`，stdio JSON-RPC），涉及完全不同的会话生命周期、流式协议与工具镜像链路，属于独立架构项目而非补丁。问题卡片渲染已存在，只是因为 print 模式无法暂停而出现在轮次结束之后。已在 issue 回复中说明，本版本不发布该能力。

## 0.6.26 (2026-11-15)

### English

- **Fix(goal): only trust `<goal_complete>` on a user-role message (merges PR #111).** `isGoalToolContinuation()` matched the marker as a plain substring on every message role, so any tool result that merely *printed* the literal string (e.g. grepping this package's own `dist/index.js` doc comments) short-circuited the next request into a zero-content `finish(stop)` that DSH records as a normal completion — three silent replies in a row in the reported incident. The textual marker is now gated on `m.role === 'user'`; the genuine `source.kind === 'tool-goal'` notice still short-circuits. Regression test built from the real grep output plus an assistant echo. Thanks to @AlaIchhe for the diagnosis and RED-first test.
- **Fix(auth): imported Windows credentials no longer create a permanent 401 deadlock (fixes #112).** `/agy import` on a Windows primary account hand-built a token document without `expiry`; `getValidAccessTokenUncached()` read the missing expiry as "valid forever", so the stale access token was reused until Google rejected it, and every refresh path (`force:true` warmup/quota) reused the same judgment — a self-inflicted, unrecoverable loop. The import now uses `buildAgyCredentialDoc()` (the same single writer as the on-disk token file, always with an expiry or a bounded fallback), and a token with **no known expiry** is treated as needing refresh/validation rather than fresh.
- **Fix(warmup): terminal TOS bans are quarantined instead of probed every 5 minutes (fixes #112).** 403 `TOS_VIOLATION` responses were truncated to 160 characters (losing `appeal_url`) and returned as an ordinary failure, so `authRequired`/cooldowns stayed empty. Errors now keep up to 2000 characters plus an explicit `Appeal:` link; a `TOS_VIOLATION` marks the account `authRequired` and logs the full reason, stopping the scheduled loop. Pure classifier + injected-network regression tests cover both.

### 中文

- **修复(goal)：`<goal_complete>` 仅信任 user 角色消息（合并 PR #111）。** `isGoalToolContinuation()` 此前把该标记当普通子串匹配所有角色；工具输出只要「打印」出这串字面量（例如 grep 本包 `dist/index.js` 的文档注释），下一轮请求就会被短路成零内容 `finish(stop)`，而 DSH 将其记为正常完成——报告里连续三轮空白回复。现文本标记限制在 `m.role === 'user'`，真正的 `source.kind === 'tool-goal'` 通知仍正常短路。回归测试用真实 grep 输出与 assistant 回声构造。感谢 @AlaIchhe 的定位与 RED-first 测试。
- **修复(认证)：Windows 导入凭据不再造成永久 401 死锁（修复 #112）。** `/agy import` 在 Windows 主账号分支手工拼装了缺少 `expiry` 的 token 文档；`getValidAccessTokenUncached()` 把「缺失 expiry」当成永久有效，旧 access_token 一直复用到 Google 拒绝，而 `force:true` 的预热/额度刷新同样绕不过该判断——一次导入就自造不可逆死循环。现在导入复用 `buildAgyCredentialDoc()`（与磁盘 token 文件同一写入器，必带 expiry 或有界兜底），且**未知 expiry 一律视为需要刷新/校验**而非新鲜。
- **修复(预热)：TOS 终态封禁改为隔离，不再每 5 分钟空转（修复 #112）。** 403 `TOS_VIOLATION` 此前被截到 160 字符（丢失 `appeal_url`）并按普通失败返回，`authRequired`/冷却一直为空。现在保留最多 2000 字符并显式附 `Appeal:` 链接；`TOS_VIOLATION` 会把账号标为 `authRequired` 并记录完整原因，停止定时探测。纯分类器 + 注入网络层的回归测试均已覆盖。

## 0.6.25 (2026-11-15)

### English

- **Perf(client): scope DOM scanning so streaming no longer sweeps the whole document (merges PR #110).** `scanAndEnhanceImages()` runs on a 100ms debounce for every DOM mutation; it previously re-queried every `a[href]` for three separate enhancers and walked every markdown container on each pass, even when nothing new existed. Links are now visited once (`data-agy-link-scanned`), image/video/file dispatch is a single pass, alt-span work exits early when no unenhanced spans remain, and origin rewrites skip already-processed images. Thanks to @Ronnoc for the profiling and patch.
- **Fix(client): a streaming markdown change re-evaluates previously skipped alt spans.** The perf pass stamps non-matching alt spans as scanned; without a guard, a span present before its `![...](file:///...)` link streamed in would be skipped forever. Containers now carry a short text fingerprint, and a changed fingerprint clears the stamps so the span is retried — the fast path stays a single attribute query. Regression test reproduces the two-chunk stream.

### 中文

- **性能(客户端)：收敛 DOM 扫描范围，避免流式输出时全文档轮询（合并 PR #110）。** `scanAndEnhanceImages()` 在每次 DOM 变更的 100ms debounce 上执行，旧实现对全部 `a[href]` 跑三遍增强器、并遍历页面上每个 markdown 容器，即使没有新节点也重复解析。现在链接只访问一次（`data-agy-link-scanned`）、图片/视频/文件判断合并为单趟、无未处理 alt span 时快速返回、已改写的图片不再重复处理。感谢 @Ronnoc 的定位与补丁。
- **修复(客户端)：markdown 文本变化后重新评估此前跳过的 alt span。** 性能优化会把「当前没有本地图片匹配」的 span 标记为已扫描；若 span 先于 `![...](file:///...)` 链接出现（流式分块），就会永久跳过。现为每个容器保存短文本指纹，指纹变化时清除标记并重试；快速路径仍只是一次属性查询。新增两段式流式回归测试。

## 0.6.24 (2026-11-14)

### English

- **Fix(client): toggling `poolWideCatalog` now refreshes the model picker immediately (fixes #108, #109).** `/config` only emitted `llm/adapters-updated` for `hiddenModels`, so switching the just-shipped pool-wide catalog flag changed the setting and `/status` but left DSH's cached model selector showing the old account's models until a restart. Both keys that change the visible model set now announce a picker update; the HTTP-contract test pins the event count. Note for multi-account Windows users: `agy models` discovery still reads the machine-wide credential slot, so if a secondary account's probe returns only the primary account's basic models, the union cannot invent Argon/Hydrogen — that is an upstream credential-isolation limitation, not a filter in this plugin.

### 中文

- **修复(客户端)：切换「号池全量模型并集」后立即刷新模型选择器（修复 #108、#109）。** `/config` 此前只对 `hiddenModels` 广播 `llm/adapters-updated`，导致刚上线的 `poolWideCatalog` 开关虽然写入了配置、状态也变了，DSH 缓存的模型列表却仍是旧账号的，必须重启才生效——表现为「开关没作用」。现两个会改变可见模型集合的配置键都会触发选择器刷新，HTTP 契约测试锁定事件次数。另说明：Windows 多账号下 `agy models` 探测仍读取机器级凭据槽，若备用账号的探测被系统凭据劫持、只返回主账号的基础模型，并集也不会凭空补出 Argon/Hydrogen；这属于上游凭据隔离限制，不是本插件的过滤逻辑。

## 0.6.23 (2026-11-14)

### English

- **Feat(models): opt-in pool-wide model catalog (fixes #107).** Since v0.6.21 the picker showed only the ACTIVE account's models, so a model owned by another account (e.g. Argon on a backup account) could not be selected even though `selectSessionAccount()` already routes via `pool.selectAccount(family, model)` and self-heals on a "model not recognized" refusal. The new `poolWideCatalog` switch (default `false`) makes `listAvailableModels()` use the already-tested `getUnion(enabledAccounts, pool)`; the scheduler then routes to an account that can serve the chosen model without a manual "set active" round-trip. Available in Settings, via `DSH_AGY_POOL_WIDE_CATALOG`, and through the guarded `/config` endpoint; `/status` exposes its state. Default off keeps strict single-account isolation unchanged. Covered by a two-account heterogeneous-catalog regression test, config-precedence, HTTP-contract, SSR row and four-locale dictionary tests. Thanks to @Ronnoc for the proposal and the precise code walkthrough.

### 中文

- **新增(模型)：号池全量模型并集开关（修复 #107）。** v0.6.21 起模型选择器只显示当前活动账号的模型，异构权限多账号场景下，备用账号独有的模型（如 Argon）即使底层已支持按模型自动调度也无法被选中。`poolWideCatalog`（默认关闭）让 `listAvailableModels()` 改走现成的 `getUnion(enabledAccounts, pool)`，选中后由 `selectAccount(family, model)` 自动路由到支持该模型的账号，无需先手动「设为当前使用」。设置面板、`DSH_AGY_POOL_WIDE_CATALOG` 环境变量与受白名单保护的 `/config` 均可配置，`/status` 同步状态；默认关闭保持严格单账号隔离不变。异构双账号目录回归测试、配置优先级、HTTP 契约、SSR 行与四语言字典测试均已覆盖。感谢 @Ronnoc 的提案与精确定位。

## 0.6.22 (2026-11-13)

### English

- **Fix(mirror, ptc): drop the top-level `return` from the replay program (fixes #103).** In Code/PTC Mode the generated `run_code` wrapper emitted `return await tools['agy_tool'](...)`; DSH's REPL validator rejects a top-level `return` with `Return statement is not allowed here`, so *every* mirrored agy tool step failed. The wrapper now ends with `await tools['agy_tool'](...)` (final expression), which evaluates in both REPL and function-body runtimes. `parseMirrorInvocation` still accepts legacy `return await` programs; regression test pins both shapes. Thanks to @lzh-marble for the precise report and @fall2wish for PR #104.
- **Feat(client): hide the header status badge and the per-reply translate button (fixes #105).** Two opt-out switches — `showHeaderBadge` and `showTranslateAction` (default `true`) — are available in the settings panel, via `DSH_AGY_SHOW_HEADER_BADGE` / `DSH_AGY_SHOW_TRANSLATE_ACTION`, and through the guarded `/config` endpoint. The `/status` snapshot feeds them into a single `isUiVisible()` rule; only an explicit `false` hides anything, so a missing/older status payload never makes the UI blink out. On narrow viewports (≤680px) the badge text is hidden by CSS, leaving just the status dot. Translation cards, `/tsl` and auto-translate are unaffected. Covered by config-precedence, HTTP-contract, SSR, jsdom and four-locale dictionary tests.
- **Fix(pool): an explicit `home` argument now wins over `DSH_STATE_DIR`.** `defaultPoolDir(home)` used to return the parent process's state dir whenever the env var was set, breaking isolated-account path recovery (and the regression test in any environment that exports `DSH_STATE_DIR`). Production callers pass no argument and keep using the state dir.
- **Fix(transport): the 30s route deadline no longer kills slow translations (code-review blocker).** `/translate` fronts a full agy turn (`translateTimeoutMs` defaults to 120s, medium takes 20–45s); with the general deadline the host answered 504 first and the exactly-once `sendJson` then discarded the real 200. The route now uses `longRouteTimeout(cfg.translateTimeoutMs)` (job budget + 15s slack). `sendJson` swallows aborted-socket write errors so a late timeout callback cannot crash the host, and the manual quota-refresh dedupe entry now belongs to the real work (90s hard cap) instead of a 30s race that let a second `agy /usage` pipeline overlap. Fake-timer regression tests cover both.
- **Fix(models): a failed catalog discovery no longer self-excites `listModels` (fixes #106).** With an active pool account, every `listModels()` called `forceRefreshAndNotify()`, which unconditionally emitted `llm/adapters-updated`; DSH's browser answered by re-reading the model catalog, closing a `listModels → refresh → announce → listModels` loop. Discovery failure never populated the per-account catalog, so the loop never converged (one `agy models` spawn per cycle). Read paths now use the new throttled `ensureAccountCatalog()` (change-only announcements, per-account 60s retry stamps), and `forceRefreshAndNotify()` no longer announces a failed first discovery while keeping account-switch semantics. A regression test reproduces the browser feedback loop and proves 20 reads → 1 probe → 0 announcements. Thanks to @Rey50 for the analysis and offline reproduction.
- **Fix(runtime): the idle watchdog no longer kills a healthy child after a blocked host event loop.** libuv runs the timers phase before the poll phase, so an expired watchdog could fire before queued stdout/stderr from an actively-writing child was delivered — a false timeout that also made the two keep-alive tests flake under a fully parallel `npm test` (the Publish gate). One short grace (`WATCHDOG_GRACE_MS`, capped at the run's own idle budget) lets that output re-arm the watchdog; a deterministic test blocks the loop on purpose and asserts the run survives.
- **Fix(console): "同步中" no longer spins forever — every request now has a hard deadline.**
  - Three independent causes stacked: host routes were bare `void (async () => …)()` IIFEs (a thrown dependency became an unhandled rejection and **no HTTP response at all**), `refresh-quota` awaited a 20s `agy /usage` spawn plus several REST calls before answering, and browser writes had no timeout (only the 3s status poll did).
  - `runRoute()` in `respond.ts` is now the single guard for all 23 async routes: a rejection returns 500, a hang past `ROUTE_TIMEOUT_MS` returns 504, and `sendJson` is exactly-once so a late body cannot write a second head. No duplicated per-route error handling.
  - `refresh-quota` answers immediately with `pending: true` and runs the refresh in the background (deduped per account, with its own deadline so a hung pipeline cannot block future syncs). The existing 3s status poll delivers fresh numbers; the toast now says "syncing" instead of claiming "refreshed".
  - Client `postJson`/`getJson` share one `timedSignal()` helper and a `useBusyAction()` watchdog: no busy flag can outlive `WRITE_TIMEOUT_MS + 5s`. All timeouts live in `src/common/timeouts.ts`.
- **Fix(models): one source of truth for models & thinking levels — the DSH picker now matches agy exactly, with zero duplicate definitions.**
  - **`xhigh` no longer leaks in as a fake model.** agy 1.5.7 lists `gemini-4-hydrogen-xhigh`; the fold only knew `low/medium/high`, so DSH showed **both** `Gemini 4 Hydrogen` and `Gemini 4 Hydrogen (XHigh)` as separate models. Effort suffixes now come from `agy --help` (`low|medium|high|xhigh|max`) and are matched longest-first, so Hydrogen is ONE model with four levels, `xhigh` rendered as **Extra** (agy's own picker label).
  - **The catalog is agy's catalog.** Fallback lineup refreshed to `agy models` 1.5.7 (adds `gemini-4-hydrogen`, `gemini-pro-orchestrator-g1-pro`; drops the retired Claude 4.6 line and `gemini-4-carbon`, which agy lists as *Unavailable*). Folded entries are now emitted in `agy models`' own order, so Orchestrator sits third, not last. A regression test replays the verbatim 1.5.7 output and asserts the fallback line-up is byte-identical to discovery.
  - **Zero-redundancy vocabulary.** `src/common/reasoning.ts` is now the only definition of the effort list/labels/suffix parsing; `src/common/model-lineup.ts` the only place concrete model ids live. The settings default-effort buttons, the translate/image effort dropdowns, the model-visibility chips and `agy_ask`'s help text are all derived from the live catalog — the four independent hardcoded `low/medium/high` copies are gone. The defaults dropdown now offers `Extra` because the catalog exposes it.
  - `agy_ask`: a level written into the model word (`"gemini-4-hydrogen extra"`) is now honoured as `--effort` instead of being silently dropped.
- **Fix(release): publishing now retries transient registry failures and verifies the version actually lands.**
  - v0.6.19 and v0.6.20 both got GitHub Releases that were never installable: a single transient `404 Not Found - PUT https://registry.npmjs.org/dsh-agy-link` killed `npm publish`, and nothing checked whether the version was readable. v0.6.21 succeeded minutes later with the same token.
  - `scripts/publish-retry.mjs` now: skips an already-published version (idempotent re-runs), retries only transient errors with backoff, fails fast on fatal auth/version errors, and polls `npm view <name>@<version> version` after a successful publish. Slow registry propagation (2–6 min observed) is a WARNING, not a failed run; `PUBLISH_STRICT_VERIFY=1` makes it fatal for canaries. Publish workflow uses the wrapper.
  - 8 unit tests cover classification, retry/exhaustion, fatal fast-fail, idempotency, and post-publish verification.
- **Fix(test): widen the watchdog keep-alive tests' timing margin.** Two `proxy-keychain` tests timed out at 800ms whenever a fully parallel `npm test` starved the parent event loop; they are a Publish gate, so the flake could block releases. Child activity now outlives a 2000ms idle budget with the same keep-alive semantics. Full suite: 1028/1028.
- **Feature: subagent activity streams live into DSH, and local file links open in the native right Sidebar.**
  - **Live subagent progress.** New `src/features/subagent/tracker.ts` follows agy's `brain/<conversationId>/.system_generated/` tree while a run is active: it discovers every `subagents/*.json` descriptor (nesting included), then tails each worker's `transcript.jsonl` and emits one `stepKind: 'subagent'` event per tool call and per planner milestone. A 40-minute delegation no longer looks like a single frozen `invoke_subagent` card — the reasoning channel shows which file each worker reads or edits, which command it runs, which concept art it generates. Every emitted event also refreshes the idle watchdog, because a worker writing to disk is real progress.
  - **Bounded tailing.** Each poll reads only the bytes appended since the previous one and buffers a half-written trailing line, so an hours-long transcript costs one small read per tick instead of a full re-read and re-parse.
  - **Honest failure reporting.** Unexpected tracker errors go to the run logger instead of being swallowed; ordinary churn (a row still being written, a rotated file, a denied read) stays quiet.
  - **Subagent cards.** `invoke_subagent` now reads the flat `Role`/`TypeName` argv agy actually sends, so the mirror presenter and the client card both title the call `Subagent: DeepInvestigator (Deep Game Investigator)`; `toolStepBrief` follows the same keys.
- **Feature: local file links open in DSH's native right Sidebar.**
  - The provider rewrites `[label](file:///…)` to the plain local path before DSH renders the Markdown (keeping a `#L…` anchor in the form DSH already parses), so a delivered artifact becomes a native file chip whose click opens the right Sidebar — no plugin code involved.
  - Replies that already rendered a raw `file://` anchor are intercepted by the client scanner: clicking the link text opens the same `dsh-resource://file/session/<sessionId>/<path>` address through `ctx.sidebarRight.openResource` (no extra badge — the link is the affordance; a `#L12` anchor rides as `params.line`, and a path inside the workspace travels relative, exactly as `fileAddressFor` builds it). If no preview tab type can claim that address (web/headless profiles) the click falls back to the OS opener instead of reporting a false success.
  - Opening no longer depends on the file's shell association: `/plugins/agy-link/open` resolves `~` paths, `#L12-L40` anchors and Antigravity's `brain/` directories (now media search roots), so an artifact under `~/.dsh/agy-accounts/…` stops 404ing.
- **Fix(windows): opening a local file honours the registry's modern default app.** `cmd /c start` silently did nothing when the `.md` association pointed at an uninstalled program; the opener now tries PowerShell `Start-Process` first (the ShellExecute path that respects the user's current choice, e.g. VS Code), then `code`/`notepad` for text files, then reveals the file in Explorer, and passes `/select,<path>` as the single argument Explorer expects.
- **Fix(test): the full suite is green on Windows.** Three cases redirected `HOME` alone although `os.homedir()` reads `USERPROFILE` there — they now redirect both (and no longer risk reading the developer's live token file); a path assertion compared `/`-separated prefixes against `path.join` output; the symlink-escape case is skipped where symlink creation is not permitted. Full suite: 1035/1035 (1 environment skip).

### 中文

- **修复(镜像, ptc)：移除重放程序的顶层 `return`（修复 #103）。** 代码 / PTC 模式下生成的 `run_code` 包装脚本是 `return await tools['agy_tool'](...)`，而 DSH 的 REPL 语法校验不接受顶层 `return`（报 `Return statement is not allowed here`），导致每个 agy 工具步骤的镜像回放都失败。现改为以 `await tools['agy_tool'](...)` 作为末表达式，在 REPL 与函数体两种运行时下都能求值；解析器仍兼容旧的 `return await` 脚本，两种形态均有回归测试。感谢 @lzh-marble 的精确定位与 @fall2wish 的 PR #104。
- **新增(客户端)：可隐藏会话头状态徽标与单条翻译按钮（修复 #105）。** 设置页新增 `showHeaderBadge`、`showTranslateAction` 两个开关（默认开启），同时支持 `DSH_AGY_SHOW_HEADER_BADGE` / `DSH_AGY_SHOW_TRANSLATE_ACTION` 环境变量与受白名单保护的 `/config` 接口。状态快照经统一的 `isUiVisible()` 规则下发：只有显式 `false` 才隐藏，状态未到达或旧宿主没有该字段时保持可见，不会闪退。窄屏（≤680px）下徽标文字自动隐藏、只留状态圆点。译文卡片、`/tsl` 与自动翻译功能均不受影响。配置优先级、HTTP 契约、SSR、jsdom 与四语言字典均有对应测试。
- **修复(号池)：显式传入的 `home` 优先于 `DSH_STATE_DIR`。** 此前只要环境变量存在，`defaultPoolDir(home)` 就忽略参数直接返回父进程状态目录，破坏了隔离子账号的路径恢复逻辑（在导出该变量的环境中也会让回归测试失败）。生产调用不传参数，行为不变。
- **修复(传输层)：30s 通用路由超时不再掐断慢速翻译（代码评审阻断项）。** `/translate` 承载一整轮 agy 调用（`translateTimeoutMs` 缺省 120s，medium 实测 20–45s）；套用通用 deadline 会先回 504，而 `sendJson` 的恰好一次语义会丢弃随后真正的 200 —— 「译成人话」在慢速档位必然失败。现改为 `longRouteTimeout(cfg.translateTimeoutMs)`（任务预算 + 15s 宽限）。`sendJson` 同时吞掉客户端断连时的写异常，避免迟到的超时回调拖垮宿主；手动额度刷新的去重条目改由真实工作持有（90s 硬上限），不再被 30s 竞速提前释放而让第二次 `agy /usage` 叠加。两处均有假时钟回归测试。
- **修复(模型)：目录发现失败时不再让 `listModels` 自激循环（修复 #106）。** 存在当前池账号时，每次 `listModels()` 都会调用无条件广播的 `forceRefreshAndNotify()` → 发出 `llm/adapters-updated` → DSH 浏览器重读模型目录 → 再次 `listModels`，形成闭环；而发现失败不会写入该账号的目录缓存，循环永不收敛，每圈还会 spawn 一次 `agy models`。读路径现改走带节流的 `ensureAccountCatalog()`（仅在内容真正变化时广播，按账号记录 60s 重试时间戳），`forceRefreshAndNotify()` 也不再为失败的首次发现广播，同时保留切号时的广播语义。新增回归测试复刻浏览器反馈环，验证 20 次读取 → 1 次探测 → 0 次广播。感谢 @Rey50 的分析与离线复现。
- **修复(运行时)：宿主事件循环被阻塞后，空闲看门狗不再误杀仍在输出的子进程。** libuv 的 timers 阶段先于 poll 阶段，看门狗到期时可能子进程已写入的 stdout/stderr 还排在管道里没被投递，于是被误判为超时；满并发 `npm test` 下这会让两项保活用例偶发失败、挡住发布门禁。现给一次短暂宽限（`WATCHDOG_GRACE_MS`，不超过本次运行的空闲预算），让排队数据重新喂狗；新增确定性测试主动阻塞事件循环并断言运行不超时。
- **修复(控制台)：「同步中」不再无限转圈——所有请求现在都有硬超时。**
  - 三个原因叠加：宿主路由都是裸的 `void (async () => …)()`（依赖抛错会变成未处理的 rejection，**HTTP 永远不响应**）；`refresh-quota` 要等 20s 的 `agy /usage` 子进程加若干 REST 调用才返回；而浏览器端写请求没有超时（只有 3s 的状态轮询有）。
  - `respond.ts` 新增 `runRoute()`，作为全部 23 条异步路由的统一守卫：抛错返回 500、超过 `ROUTE_TIMEOUT_MS` 挂起返回 504，`sendJson` 保证只写一次（超时的迟到响应不会二次写 head）。不再有逐路由重复的错误处理。
  - `refresh-quota` 立即返回 `pending: true`，刷新放到后台执行（按账号去重，并带独立超时，避免挂死的流水线永久挡住后续同步）。现有 3s 状态轮询会自动带出最新额度；提示文案改为「正在同步」而不是谎称「已刷新」。
  - 客户端 `postJson`/`getJson` 共用 `timedSignal()`，并有 `useBusyAction()` 兜底：任何 busy 状态都不会超过 `WRITE_TIMEOUT_MS + 5s`。所有超时常量集中在 `src/common/timeouts.ts`。
- **修复(模型)：模型与思考等级收敛为单一事实源——DSH 的模型列表现在与 agy 完全一致，且不再有重复定义。**
  - **`xhigh` 不再被当成独立模型。** agy 1.5.7 列出的是 `gemini-4-hydrogen-xhigh`，而旧的折叠逻辑只认识 `low/medium/high`，于是 DSH 里同时出现了 `Gemini 4 Hydrogen` 和 `Gemini 4 Hydrogen (XHigh)` 两个模型。档位词表现已取自 `agy --help`（`low|medium|high|xhigh|max`）并按**后缀长度降序**匹配：Hydrogen 就是**一个**模型、带四个档位，`xhigh` 显示为 **Extra**（与 agy 自己的菜单一致）。
  - **目录即 agy 目录。** 离线兜底阵容同步到 `agy models` 1.5.7（新增 `gemini-4-hydrogen`、`gemini-pro-orchestrator-g1-pro`；移除已下线的 Claude 4.6 线与 agy 标记为 *Unavailable* 的 `gemini-4-carbon`）。折叠后的条目也按 `agy models` 的原始顺序输出，Orchestrator 因此回到第三位而不是垫底。新增回归测试逐字回放 1.5.7 输出，并断言兜底阵容与真实发现结果完全一致。
  - **词表零冗余。** `src/common/reasoning.ts` 成为档位列表/显示名/后缀解析的唯一定义；`src/common/model-lineup.ts` 成为具体模型 id 的唯一出处。设置页“默认思考强度”按钮、翻译/生图档位下拉、模型显示 chips 与 `agy_ask` 帮助文本全部由实时目录派生——原来四处各自硬编码的 `low/medium/high` 已全部删除；目录里有 `xhigh`，下拉框就自动多出「Extra」。
  - `agy_ask`：写在模型词里的档位（如 `"gemini-4-hydrogen extra"`）现在会被识别为 `--effort`，不再被静默丢弃。
- **修复(发布)：发布遇瞬态故障会自动重试，并校验版本真的可用。**
  - 0.6.19/0.6.20 都建了 GitHub Release 却装不上：一次瞬态 `404 Not Found - PUT registry.npmjs.org` 直接打断 `npm publish`，且没有任何环节检查版本是否可读；0.6.21 用同一 token 几分钟后就成功了。
  - `scripts/publish-retry.mjs`：已发布则跳过（可重复运行）、只对瞬态错误退避重试、鉴权/版本类致命错误立即失败，发布成功后轮询 `npm view` 确认。registry 传播慢（实测 2–6 分钟）只告警不误判失败，canary 可用 `PUBLISH_STRICT_VERIFY=1` 严格化。
  - 8 项单测覆盖错误分类、重试/耗尽、致命快失败、幂等与发布后校验。
- **修复(测试)：加宽 watchdog 保活用例的计时余量。** 两项 `proxy-keychain` 用例在满并发下会被父进程事件循环饿死导致 800ms 误超时；它们是发布门禁，flaky 会挡住发版。现子进程活动长于 2000ms 空闲预算且语义不变；全量 1028/1028。

- **新功能：子代理活动实时流式呈现，本地文件链接直接在 DSH 原生右侧边栏打开。**
  - **子代理实时进度。** 新增 `src/features/subagent/tracker.ts`：运行期间跟随 agy 的 `brain/<会话ID>/.system_generated/` 目录树，自动发现每个 `subagents/*.json` 描述文件（含多层嵌套），并增量读取各专员的 `transcript.jsonl`；每次工具调用与每条规划里程碑都会产生一条 `stepKind: 'subagent'` 事件。40 分钟的委派不再只显示一张冻结的 `invoke_subagent` 卡片——思考区会实时显示专员正在读/改哪个文件、执行什么命令、生成哪张概念图。每条事件同时刷新空闲看门狗，因为专员在磁盘上写进度就是真实进展。
  - **增量读取。** 每次轮询只读取上次之后新增的字节，并缓存未写完的最后一行；再长的会话记录每跳只付一次小读取，而不是整篇重读重解析。
  - **失败不再静默。** 非预期的跟踪错误写入运行日志；正常抖动（行还没写完、文件被替换、读取被拒）保持安静。
  - **子代理卡片。** `invoke_subagent` 现在读取 agy 实际发送的扁平 `Role`/`TypeName` 参数，镜像卡片与客户端卡片都显示 `Subagent: DeepInvestigator (Deep Game Investigator)`；`toolStepBrief` 同步。
- **新功能：本地文件链接在 DSH 原生右侧边栏打开。**
  - Provider 在交给 DSH 渲染前把 `[label](file:///…)` 改写为纯本地路径（行号锚点保留为 DSH 已支持的 `#L…` 形式），于是交付件直接渲染成原生文件 chip，点击即打开右侧边栏，全程无需插件脚本。
  - 已经渲染成裸 `file://` 锚点的历史回复，由客户端扫描器接管点击：点击链接文字即通过 `ctx.sidebarRight.openResource` 打开同一个 `dsh-resource://file/session/<会话ID>/<路径>` 地址（不再挂额外胶囊——链接文字本身就是入口；`#L12` 锚点以 `params.line` 传递，工作区内路径按 `fileAddressFor` 的规则转为相对路径）。若当前配置没有任何预览类型能接收该地址（web/headless 配置），点击回退到系统打开，而不是谎报成功。
  - 打开不再依赖文件关联：`/plugins/agy-link/open` 现在能解析 `~` 路径、`#L12-L40` 锚点与 Antigravity 的 `brain/` 目录（已并入媒体检索根），`~/.dsh/agy-accounts/…` 下的交付件不再 404。
- **修复(Windows)：用系统现代默认程序打开本地文件。** 当 `.md` 关联指向一个已卸载的程序时，`cmd /c start` 会静默失败；现在优先用 PowerShell `Start-Process`（ShellExecute 路径，尊重用户当前选择，例如 VS Code），文本类文件再回退 `code`/`notepad`，最后回退到在资源管理器中定位，并把 `/select,<路径>` 作为 Explorer 期望的单个参数传入。
- **修复(测试)：Windows 下全量回归全绿。** 三处用例只重定向了 `HOME`，而 Windows 的 `os.homedir()` 读的是 `USERPROFILE`——现在两个都重定向（也避免误读开发者真实 token 文件）；一处路径断言把 `/` 前缀与 `path.join` 的结果比较；符号链接逃逸用例在不允许创建符号链接的环境下跳过。全量：1035/1035（1 项环境跳过）。

## 0.6.21 (2026-11-12)

### English

- **Fix(catalog, models): Strict real model discovery from `agy models` CLI, account-scoped catalog isolation & eliminated quota pollution.**
  - **Authoritative CLI Discovery**: Completely removed `acc.quotas` injection into runnable model catalogs. Quota buckets (such as `gemini-2.5-flash-thinking`, `gemini-3.8-flash-tiered`, and duplicate `Gemini 3.5 Flash Lite` entries returned by Google Cloud quota APIs) are strictly restricted to quota telemetry and never treated as runnable LLM models.
  - **Account-Scoped Catalog Isolation (`getModelsForAccount`)**: The DSH model picker and Settings panel ("Model visibility") now reflect strictly the active account's models discovered from `agy models`. Claude 4.6 and Claude 5.5 no longer cross-pollinate, and Argon is only shown on Argon-eligible accounts.
  - **Real-Time Account Switch Synchronization**: Switching accounts immediately resolves and refreshes the target account's catalog, updating both the picker and the settings panel with zero redundancy and no ghost models.

### 中文

- **修复(目录与模型)：严格从真实 `agy models` 提取模型列表、账号专属目录隔离与彻底根除配额分桶污染。**
  - **真实 CLI 权威探测**：彻底移除 `getAllKnownModels()` 中对 `acc.quotas` 配额分桶的合流读取。Google Cloud 配额接口返回的内部资源分桶（如 `gemini-2.5-flash-thinking`、`gemini-3.8-flash-tiered` 以及重复命名的 4 个 `Gemini 3.5 Flash Lite`）严格仅用于额度条展示，绝不再当作可运行 LLM 模型混入目录。
  - **账号专属目录隔离（`getModelsForAccount`）**：DSH 右下角模型选择器与设置面板“模型显示”直接绑定当前活动账号通过 `agy models` 真实探查到的模型列表。主账号（Claude 5.5 + Argon）与子账号（Claude 4.6，无 Argon）彻底实现互不污染，消除跨账号冗余。
  - **切账号即时同步**：切换活动账号时，立即在后台以新账号环境执行权威探测、写入账号专属缓存并即时触发 `notifyPicker()` 广播，实现毫秒级无缝刷新。

## 0.6.20 (2026-11-12)

### English

- **Major Architecture: Full-Repository Modular Monolith Refactoring (`refactor/modular-monolith`).**
  - **Zero Monolithic Files**: Refactored the entire codebase into 207 focused, decoupled modules. Every single source file now strictly obeys `<= 600` lines (empty ratchet list, 0 legacy overrides), with target functions `<= 120` lines.
  - **Acyclic Layered Domain Architecture**: Enforced strict unidirectional dependency rules via `scripts/check-architecture.mjs` (0 cyclic dependencies, 0 direction violations) across clearly separated layers:
    - `src/domain/`: Extracted slot state machines, leasing, atomic file locks, and pool administrative scheduling from the legacy monolithic `AccountPoolManager`.
    - `src/provider/`: Decomposed the multi-turn attempt loop into dedicated context assembly, retry policies, and DSH tool event mappers.
    - `src/runtime/`: Modularized agy process execution and SQLite DB trajectory parsing.
    - `src/features/`: Isolated autonomous agent features including the Image Agent, Translation Service, and Warmup Engine.
    - `src/transport/`: Modularized HTTP route handlers across 31 typed REST endpoints.
    - `src/client/`: Split the monolithic frontend bundle into standalone UI panels, toolview renderers, decisions, and compaction components.
  - **Two-Tier Test Suite (Aligned with academic-agent)**:
    - **Inner Loop (TDD Fast-Ring, 0.3s - 1.5s)**: Introduced `pnpm run test:fast` for lightning-fast incremental test execution targeted by Git diff or module keywords.
    - **Outer Loop (Full Regression Gate, 1018 Tests)**: Expanded the comprehensive test suite to 1,018 automated tests with 85%+ branch coverage, including JSDOM browser simulation, SSR DOM rendering fixtures, injectable CLI exit-code harnesses, and 100% route contract coverage.
- **Feat & Fix(client, media): Clickable local file links, native OS launching, and redesigned glassmorphic lightbox.**
  - **In-App Clickable Local Links**: Intercept clicks on `file://` and local relative links (`.png`, `.mp4`, `.md`, `.txt`, `.pdf`, etc.) in DSH chat, overcoming Chromium's `Not allowed to load local resource` restriction and relative URL 404 navigations. Clicking media opens the in-app Lightbox, while documents/code trigger the native host editor or file manager with instant Toast feedback.
  - **Video Streaming & Range 206 Support**: Added video MIME mappings (`.mp4`, `.webm`, `.mov`, `.mkv`) and HTTP 206 Partial Content Range streaming to `/plugins/agy-link/media`. Built-in Lightbox video player supports instant seeking and smooth scrubbing.
  - **Session-Aware Deep Media Resolution**: `resolveLocalMediaPath` dynamically inspects active DSH session working directories (`header.cwd`) and performs bounded recursive search (up to depth 3) across project folders, resolving deeply nested assets (e.g. `master_continuous/master_montage_6panel.png`) without 404 black screens.
  - **Host OS File Opener API**: Added `/plugins/agy-link/open` endpoint using native platform openers (`open` / `open -R` on macOS, `explorer` / `start` on Windows, `xdg-open` on Linux).
  - **Modern UI Redesign**: Replaced retro monospace/emoji controls with an Apple/Linear-style glassmorphism interface featuring a floating pill island toolbar, crisp vector SVG icons (Zoom, 1:1, Reveal in Finder, Open in App, Copy Path with checkmark animation, Close), and refined chat chips.
- **Feat(auth, catalog): Direct Token Import, Credential Auto-Healing & Dynamic Model Filtering (#102).**
  - **Direct Token Import**: Add accounts by directly pasting a `refresh_token` string or OAuth JSON document via CLI (`/agy import`), HTTP API, or Settings UI.
  - **Credential Auto-Healing**: Corrupted or missing credentials automatically restore from adjacent `.bak` backup files.
  - **Dynamic Model Scoping**: The model picker and status catalog dynamically synchronize on account switch, isolating Argon permissions per active account.

### 中文

- **重大架构重构：全仓模块化单体重构（`refactor/modular-monolith`）。**
  - **全仓彻底消除单体大文件**：全代码库拆解重构为 207 个高内聚、低耦合的独立模块。全量源文件严格恪守 `<= 600` 行预算红线（清空历史棘轮，0 遗留违规），目标函数严格 `<= 120` 行。
  - **无环分层领域架构**：通过 `scripts/check-architecture.mjs` 门禁实现单向依赖约束（0 循环依赖，0 越级调用），清晰划分六大层次：
    - `src/domain/`：从原重型 `AccountPoolManager` 中剥离出凭据槽状态机、租约管理、原子文件锁与号池调度管理；
    - `src/provider/`：将多轮请求循环解耦为上下文组装、重试策略与 DSH 原生工具事件映射管道；
    - `src/runtime/`：模块化底层 `agy` 进程执行与 SQLite 数据库轨迹提取；
    - `src/features/`：独立图像生成智能体、划词翻译服务与模型预热保活引擎；
    - `src/transport/`：模块化注册 31 个类型安全的 HTTP REST 接口；
    - `src/client/`：将庞大前端代码拆分为独立的设置面板、工具卡片渲染器、决策流与历史折叠组件。
  - **两级双环极速测试体系（对齐 academic-agent）**：
    - **内环（TDD 极速环，0.3s ~ 1.5s）**：引入 `pnpm run test:fast`，精准基于 Git 变更或关键字毫秒级执行关联单测，告别漫长等待；
    - **外环（全量回归门禁，1018 项测试）**：单测规模跃升至 1,018 项，分支覆盖率突破 85%+，涵盖 JSDOM 前端交互用例、SSR 渲染断言、CLI 退出码矩阵与全部 31 个 HTTP 路由边界测试。
- **功能与体验重构(客户端与媒体)：支持 DSH 对话内直接点击本地文件链接、视频播放、深度路径解析与全新现代化毛玻璃预览 UI。**
  - **DSH 对话内链接直接点击可用**：拦截 `file://` 与本地文件链接（`.png`、`.mp4`、`.md`、`.txt`、`.pdf`、代码文件等）的点击事件，彻底解决 Chromium 浏览器安全沙箱拦截 `file:///`（"Not allowed to load local resource"）或相对路径 404 导致的链接无法点击问题。点击媒体直接唤起应用内预览，点击文档/代码直接在系统默认编辑器中打开或在访达中定位，并带有全局 Toast 操作反馈。
  - **视频播放与 HTTP 206 Range 边下边播**：`/plugins/agy-link/media` 路由全面支持视频格式（`.mp4`、`.webm`、`.mov`、`.mkv`），并实现 HTTP 206 Partial Content Range 分段传输，支持进度条任意时间点平滑拖拽即时播放。
  - **会话工作区动态感知与 3 层嵌套有界检索**：`resolveLocalMediaPath` 现自动采集 DSH 各活动会话工作目录（`header.cwd`）与常用工作区，支持最多 3 层深度的有界递归匹配，毫秒级定位深层嵌套产物（如 `master_continuous/master_montage_6panel.png` 与 `eren_rumbling_master_78s.mp4`），彻底根除 404 黑屏。
  - **本地系统打开与定位接口**：新增 `/plugins/agy-link/open` 路由，调用系统原生指令（macOS `open` / `open -R`、Windows `explorer` / `start`、Linux `xdg-open`）即时打开文件或在访达中显示。
  - **现代化毛玻璃预览重构**：全面重构 Lightbox 预览与链接胶囊样式，采用 Apple / Linear 风格高透毛玻璃与顶部悬浮药丸工具栏，搭配纯正矢量 SVG 图标（放大、缩小、1:1 复位、访达定位、系统打开、复制路径打勾动画、ESC 关闭），彻底替换粗糙的旧式文本按钮，并提供操作反馈 Toast 浮层。
- **新增(认证与目录)：支持直接导入 Refresh Token / OAuth JSON 快捷登录与凭据备份自愈（#102）。**
  - **Token 直接导入**：支持直接粘贴 `refresh_token` 字符串或 OAuth JSON 凭据导入账号。提供 CLI 命令（`/agy import <token> [别名]` 与 `/agy import-token`）、HTTP API 接口（`POST /plugins/agy-link/pool/import`）以及设置面板（"Token 导入" 选项卡）。系统自动换取 Token、验证 Google 身份并就地更新或创建账号，并即时拉取额度。
  - **凭据文件自愈修复**：当凭据文件缺失、截断或损坏时，自动从同目录 `.bak` 备份文件中恢复；启动自检中自动为凭据完整有效的账号清除误标的 `authRequired` 异常标记。
  - **切号动态同步模型列表与权限**：切换活动账号时即时依据新账号权限动态过滤可用模型列表，无 Argon 权限的账号不再在当前状态中残留展示不可用模型；切到不支持 Argon 的账号时自动清理过期的 Argon 活动指针。

## 0.6.19 (2026-11-12)

### English

- **Feat(auth): import accounts directly via refresh token or OAuth JSON document; auto-heal credentials from backup (#102).**
  - **Direct token import**: Added support for adding accounts by directly pasting a `refresh_token` string or token JSON payload. Available via CLI (`/agy import <token> [alias]`), HTTP API (`POST /plugins/agy-link/pool/import`), and the Settings UI ("Token" tab in the Add Account section). Token is exchanged, identity is verified, and the account is added or updated in place with full quota discovery.
  - **Credential auto-healing**: When an account's credential file is missing or corrupted/truncated, it is automatically restored from the adjacent `.bak` backup file. Boot hygiene clears any false `authRequired` state when credentials are restored or valid.
- **Fix(catalog): dynamically scope model picker and status catalog to the active account on switches.**
  - When switching active accounts, model capabilities are re-evaluated immediately so models without permission (e.g. Argon on standard accounts) are properly filtered out of catalog status.
  - Selecting an account without Argon automatically clears obsolete Argon active account pointers.

### 中文

- **新增(auth)：支持直接导入 Refresh Token / OAuth JSON 快捷登录与凭据备份自愈（#102）。**
  - **Token 直接导入**：支持直接粘贴 `refresh_token` 字符串或 OAuth JSON 凭据导入账号。提供 CLI 命令（`/agy import <token> [别名]` 与 `/agy import-token`）、HTTP API 接口（`POST /plugins/agy-link/pool/import`）以及设置面板（"Token 导入" 选项卡）。系统自动换取 Token、验证 Google 身份并就地更新或创建账号，并即时拉取额度。
  - **凭据文件自愈修复**：当凭据文件缺失、截断或损坏时，自动从同目录 `.bak` 备份文件中恢复；启动自检中自动为凭据完整有效的账号清除误标的 `authRequired` 异常标记。
- **修复(目录)：切号时动态同步模型列表与权限状态。**
  - 切换活动账号时即时依据新账号权限动态过滤可用模型列表，无 Argon 权限的账号不再在当前状态中残留展示不可用模型；切到不支持 Argon 的账号时自动清理过期的 Argon 活动指针。

## 0.6.18 (2026-11-11)

### English

- **Fix(catalog): the model picker shows the pool-wide model set, and dispatch routes Argon to an account that actually has it.** (thanks @Ronnoc, #95)
  - The picker now exposes the **union** of models across enabled accounts (fallback + discovered + quota-reported), so Argon is visible whenever *some* account in the pool can serve it — not only when the currently active account can. Listing stays synchronous and side-effect-free (no probing).
  - **Model resolution is pure again**: an earlier revision switched the active account inside `resolveModel()`; that now happens only at turn dispatch, so rendering the picker or inspecting a model can never rewrite `lastActiveAccountId`.
  - Eligibility gained an explicit `unsupported` reason (distinct from `quota`/`cooldown`): when no enabled account has access to the family, the error says so and the hint no longer suggests a quota fix. Argon requests route via family eligibility (accounts without Argon are `unsupported` for that family).

### 中文

- **修复(目录)：模型选单展示号池全集，Argon 请求路由到真正具备权限的账号。**（感谢 @Ronnoc，#95）
  - 选单合并所有启用账号的模型（回退 + 发现 + 配额上报），只要池中有账号支持 Argon 就可见；列举仍为同步、无副作用（不探测）。
  - **模型解析恢复纯读**：早期修订在 `resolveModel()` 里切换活动账号，现只在**请求派发**时切换，渲染选单/查看模型不会再改 `lastActiveAccountId`。
  - 资格判定新增 `unsupported` 原因（区别于 `quota`/`cooldown`）：全池都无该族权限时错误会明确说明，提示也不再误导为配额问题；Argon 请求按族资格路由。

## 0.6.17 (2026-11-11)

### English

- **Feat(auth): reauthenticate an existing pool account in place — `/agy auth <id|alias|email>`, final result via `/agy auth-status`.** (thanks @Ronnoc, #96)
  - When a secondary account's stored credential is missing or invalid, you no longer have to remove and recreate it (losing its configuration and local state): the browser flow writes into a staging slot, verifies the Google identity, and only then **atomically** moves the new token into that account's isolated `.gemini/antigravity-cli` dir (mode 0600).
  - Identity checks before the swap: the account must be isolated (not the system-HOME primary), the verified email must match the account's recorded email when one exists, and no **other** pool account may already own that email. Missing email, missing refresh token or a mismatched/duplicate identity aborts with `identity_unverified` / `identity_mismatch` and leaves the old credential untouched.
  - The flow is stale-safe (a superseded flow never writes), clears `authRequired`, records the address, and refreshes that account's quota. No credential value is ever printed.

### 中文

- **新增(auth)：原地重登已有账号——`/agy auth <ID|别名|邮箱>`，最终结果用 `/agy auth-status` 查看。**（感谢 @Ronnoc，#96）
  - 副账号凭据缺失/失效时，不必再「删除后重建」（会丢配置与本地状态）：浏览器流程先写入 staging 槽位并校验 Google 身份，再把新 token **原子地** rename 到该账号独立的 `.gemini/antigravity-cli`（0600 权限）。
  - 替换前的身份校验：必须是隔离账号（不是 system-HOME 主账号）；已记录邮箱的账号要求邮箱一致；同一邮箱不得属于池中**其他**账号。缺邮箱/缺 refresh token/身份不符或重复 → `identity_unverified` / `identity_mismatch`，旧凭据保持不动。
  - 流程具备「旧流程不写盘」的过期保护，成功后清除 `authRequired`、记录邮箱并刷新该账号配额；任何输出都不打印凭据值。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.16...v0.6.17

## 0.6.16 (2026-11-10)

### English

- **Feat(image): headless image generation as a CLI (`dsh-agy-image`) that reuses the real `AgyAdapter` — no new HTTP API.**
  - The CLI instantiates the plugin's own `AgyAdapter` with a new `purpose:'image'` route, so account selection, quota cooldown/rotation, proxy, failure classification and the `--effort`-refusal replay are the same code path a normal turn uses. A region/quota refusal rotates the pool and the retry lands on the next account (verified live: the primary was region-refused, a proxied account generated the image).
  - The adapter sends the caller's bridge prompt verbatim (`agyImagePrompt`), is not forced into plan mode (the tool writes an artifact), and hands raw agy events back through `agyOnEvent` / `agyOnAccount` so the service can locate `brain/<conversation_id>/`.
  - The bridge prompt pins `Prompt` / `ImageName` / `AspectRatio` / `ImagePaths` and asks for `IMAGE_PATH=` / `IMAGE_ERROR=`. Success is accepted only after magic-byte sniff (PNG/JPEG/WebP/GIF/BMP), dimension parsing, `imageMaxBytes` and a 3% aspect-ratio check.
  - `--json` exposes `{ok, path, mime, width, height, aspectRatio, bytes, accountId?, conversationId?}` plus stable failure codes. Config: `imageModel` / `imageEffort` / `imageTimeoutMs` / `imageMaxBytes` / `imageOutputDir` / `imageRetries`.

- **Docs/UI: one README per language, a single configuration source, and a Settings row for image generation.**
  - `README.md` is now Chinese-only; the duplicated English half moved to `docs/README.en.md` (fully rewritten, including image generation). Stale `docs/README.es.md` / `docs/README.pt-BR.md` were removed, and historical process docs moved under `docs/archive/`.
  - The configuration table is no longer duplicated in the README — `docs/CONFIGURATION.md` is the only copy.
  - Settings → Antigravity now shows an **Image generation** row: model/effort dropdowns (`imageModel` / `imageEffort`) plus a copyable `dsh-agy-image` command. It documents the CLI instead of pretending to run it in-page.

- **Fix(translate): the per-reply "translate" button now explains the message you actually clicked — and the translation is faster and much more colloquial.**
  - `translateMessage` resolved the clicked message to its *turn* and then translated that turn's **last** answer. A turn often holds a preamble plus the real answer, so clicking message A could show a translation of message B. It now translates the clicked message by `messageId` (own text, own anchor seq).
  - Dedupe is message-scoped: `findTranslationRecord` accepts a `messageId`, so siblings in one turn can each have their own card and clicking B never returns A's stored translation. Records written before `messageId` existed remain a fallback only while the turn has no message-scoped record at all.
  - Default thinking effort drops from `high` to `medium`: on real agy the same 964-char reply takes **low ≈ 12s / medium ≈ 33s / high ≈ 45s** (≈9s is agy's own startup), and high-effort output also reads like a formal report. Switch to `low` in Settings for ~12s, or `high` when rigour matters.
  - Prompt rewritten around "这一条回复": plain spoken Chinese, no report headings/bullets, no 书面 connectors, terms unpacked — and **keep the real content volume** (the old "挑重点" hint is gone; long sources are told to finish the walk-through instead of compressing).
  - `sessionDigest` is now one pass instead of rescanning the whole log per turn (O(n²) → O(n)); chunked translations join with a blank line instead of a `---` divider.

### 中文

- **新增(生图)：headless 生图 CLI（`dsh-agy-image`），直接复用真实 `AgyAdapter`——不新增 HTTP API。**
  - CLI 用插件自己的 `AgyAdapter` 新增 `purpose:'image'` 通道：选号、额度冷却/换号、代理、失败分类、`--effort` 被拒重放，全部与真实对话同一套代码。地区/额度拒绝会前移号池指针，重试落到下一个账号（实测：主号被地区拒绝 → 自动落到代理账号成功出图）。
  - Adapter 原样发送调用方的桥接提示词（`agyImagePrompt`），不强制 plan 模式（工具要写 artifact），并通过 `agyOnEvent` / `agyOnAccount` 把 agy 原始事件与账号 HOME 交回服务层，用于定位 `brain/<conversation_id>/`。
  - 提示词固定 `Prompt` / `ImageName` / `AspectRatio` / `ImagePaths`，要求回 `IMAGE_PATH=` / `IMAGE_ERROR=`；成功必须通过魔数识别（PNG/JPEG/WebP/GIF/BMP）、宽高解析、`imageMaxBytes` 与 3% 比例核对。
  - `--json` 返回 `{ok, path, mime, width, height, aspectRatio, bytes, accountId?, conversationId?}`，失败带稳定 `code`。配置：`imageModel` / `imageEffort` / `imageTimeoutMs` / `imageMaxBytes` / `imageOutputDir` / `imageRetries`。

- **文档/UI：每种语言只留一份 README，配置只维护一份，设置页新增「生图」一行。**
  - `README.md` 现在只保留中文；重复的英文半边移到 `docs/README.en.md`（完整重写，含生图）。删除过时的 `docs/README.es.md` / `docs/README.pt-BR.md`，历史过程文档移到 `docs/archive/`。
  - README 不再重复配置表 —— `docs/CONFIGURATION.md` 是唯一副本。
  - 设置 → Antigravity 新增「生图」行：模型/思考档下拉框（`imageModel` / `imageEffort`）+ 可复制的 `dsh-agy-image` 命令；只展示 CLI，不假装页面内能直接跑。

- **修复(翻译)：每条回复的「译成人话」按钮现在翻的就是你点的那一条，并且更快、更口语。**
  - `translateMessage` 原来先把消息映射到所属回合，再翻该回合的**最后一条**答复。一个回合里常常先有一段说明、后面才是真正的答复，所以点 A 可能拿到 B 的译文。现在按 `messageId` 精确翻译被点的那条（用它自己的正文和锚点 seq）。
  - 去重改成消息级：`findTranslationRecord` 接受 `messageId`，同一回合的 A/B 各自可以有卡片，点 B 不会命中 A 的旧译文；没有 `messageId` 的历史记录只在该回合完全没有消息级记录时兜底。
  - 默认思考档从 `high` 降到 `medium`：真实 agy 上同一段 964 字回复实测 **low ≈ 12s / medium ≈ 33s / high ≈ 45s**（其中约 9s 是 agy 启动开销），且 high 的译文更像正式报告。想更快可在设置里切 `low`（≈12s），需要更严谨再切 `high`。
  - 提示词围绕「这一条回复」重写：大白话、短句、不要标题/分点/报告腔、不要「首先 / 其次 / 综上 / 因此」这类书面词、术语先用日常说法解释；同时**保留实际内容量**（删掉了旧的「挑重点」提示，长原文改为要求按顺序讲完，而不是压成结论）。
  - `sessionDigest` 改为单次遍历（原来每个回合都重扫全量事件，O(n²)）；多块翻译之间改用空行连接，不再插入 `---` 分隔线。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.15...v0.6.16

## 0.6.15 (2026-11-10)

### English

- **Fix(catalog): `listModels()` is side-effect free — the `agy models` feedback loop is gone (no more 100% CPU / fan spin / UI flashing).**
  - `listModels()` kicked off `catalog.refreshIfNeeded()`, and a refresh that discovered models emits `llm/adapters-updated` — which makes DSH call `listModels()` again. Each round could spawn `agy models`, producing a self-sustaining probe loop until the TTL happened to suppress it (and for an account with no cached catalog the TTL guards were skipped entirely).
  - Listing is now pure: it reads the cached catalog only. Freshness is owned by the startup probe, a new **30-minute periodic TTL refresh** (one probe per window at most), account switches (`forceRefreshAndNotify`) and the explicit `/agy` refresh paths.
  - Test asserts two consecutive `listModels()` calls spawn zero discovery processes even with a zero TTL.

### 中文

- **修复(catalog)：`listModels()` 无副作用——`agy models` 反馈循环消失（不再 100% CPU / 风扇狂转 / UI 闪烁）。**
  - 原实现里 `listModels()` 会触发 `catalog.refreshIfNeeded()`，而刷新发现新模型时会发 `llm/adapters-updated`，DSH 收到后又调用 `listModels()`——每轮都可能 spawn `agy models`，形成自维持的探测循环（对「尚无缓存目录」的账号更是完全跳过 TTL 守卫）。
  - 现在列举是纯读缓存；新鲜度由启动探测、新增的**每 30 分钟 TTL 刷新**（每窗口最多一次探测）、切换账号（`forceRefreshAndNotify`）与显式 `/agy` 刷新负责。
  - 测试断言：即使 TTL=0，连续两次 `listModels()` 也不会 spawn 任何探测进程。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.14...v0.6.15

## 0.6.14 (2026-11-10)

### English

- **Feat(stability): optional `maxTurnMinutes` wall-clock cap — a self-driving turn can no longer run unbounded (issue #92).**
  - The idle watchdog is re-armed by every output line, so an agy turn that keeps emitting events (async `task-xxxx` receipts, tool chatter) never trips it: `longToolIdleMinutes` (default 240) only bounds *silence*. A new `maxTurnMinutes` bounds the whole turn regardless of activity; when it fires the runner kills the agy process tree (SIGTERM group → SIGKILL escalation, `taskkill /T /F` on Windows) and the turn fails with a resumable `maxTurnMinutes` error.
  - Default `0` = **off**, so behaviour is unchanged until you opt in (e.g. `DSH_AGY_MAX_TURN_MINUTES=60` for exploratory sessions). Env + config key, README/CONFIGURATION rows, and tests for the cap and the config precedence.

### 中文

- **新增(稳定性)：可选 `maxTurnMinutes` 墙钟上限——自驱动轮次不再可能无限运行（issue #92）。**
  - 空闲看门狗会被每一行输出重置，所以「持续有输出」的 agy 轮次（异步 `task-xxxx` 回执、工具碎碎念）永远不会触发；`longToolIdleMinutes`（默认 240）只约束**静默**。新增 `maxTurnMinutes` 约束整轮墙钟，触发时 runner 会杀掉 agy 进程树（组 `SIGTERM`→`SIGKILL`，Windows `taskkill /T /F`），并返回可续跑的 `maxTurnMinutes` 错误。
  - 默认 `0` = **关闭**，不改变现有行为；需要时显式开启（如排障类会话设 `DSH_AGY_MAX_TURN_MINUTES=60`）。含 env + 配置键、README/CONFIGURATION 说明，以及上限与配置优先级的测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.13...v0.6.14

## 0.6.13 (2026-11-10)

### English

- **Fix(models/warmup): follow the 5.5 migration everywhere — no shipped default points at the retired Claude 4.6 any more.**
  - Found during the 5-day architecture review: after 0.6.11/0.6.12 moved the catalog to Claude 5.5, four places still pinned 4.6 — the `warmupModels` config default (`types.ts`), the warmup family fallback and its internal default list (`warmup.ts`), and the cross-family failover map (`adapter.ts`). With 4.6 retired upstream, an auto-warmup probe or a family failover could therefore target a model that no longer exists.
  - All four now use `claude-sonnet-5-5`; legacy accounts still get their own 4.6 picked from `quotas.anthropic.models` first (per-account resolution from #88), so nothing regresses for older plans.
  - Bare name aliases (`claude-sonnet`, `claude-opus`) now resolve to the 5.5 line, while explicit `claude-*-4.x` names keep resolving to 4.6 (legacy sessions untouched).
  - Tests: warmup default + anthropic fallback + alias resolution; README/CONFIGURATION warmup rows and the `/tsl` example updated.

### 中文

- **修复(models/warmup)：处处跟上 5.5 迁移——不再有任何出厂默认指向已下线的 Claude 4.6。**
  - 5 天架构 review 发现：0.6.11/0.6.12 把目录迁到 Claude 5.5 后，仍有四处钉着 4.6——`warmupModels` 配置默认值（`types.ts`）、预热族回退与内部默认列表（`warmup.ts`）、跨族失败转移映射（`adapter.ts`）。4.6 上游已退役，自动预热或跨族回退可能打到一个不存在的模型。
  - 四处统一改为 `claude-sonnet-5-5`；旧账号仍会**优先**从 `quotas.anthropic.models` 里取自己的 4.6（#88 的按账号解析），不会回退。
  - 裸名别名（`claude-sonnet`、`claude-opus`）解析到 5.5 世代；显式 `claude-*-4.x` 仍解析到 4.6（不影响历史会话）。
  - 测试：预热默认值、anthropic 回退、别名解析；README/CONFIGURATION 的预热行与 `/tsl` 示例同步更新。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.12...v0.6.13

## 0.6.12 (2026-11-09)

### English

- **Fix(models): enable reasoning effort for Claude 5.5 — verified against agy 1.5.3.**
  - `agy models` lists Claude 5.5 only as tiered slugs (`claude-sonnet-5-5-low/medium/high`), and agy **rejects a tiered slug combined with `--effort`** (`--model claude-sonnet-5-5-low conflicts with --effort=high`), while the **base slug accepts it** (`--model claude-sonnet-5-5 --effort high` → works).
  - Therefore the catalog now folds the Claude 5.5 tiers into one entry with `efforts: low|medium|high`, `resolveModelSlug()` strips a tiered Claude 5.5 slug back to its base (so a stored tiered id can never collide with the flag), and `buildArgs` passes `--effort` for a base Claude 5.5 model.
  - Claude 4.6 keeps its documented no-effort behaviour (it is no longer in the live catalog, and was not verified).

### 中文

- **修复(models)：Claude 5.5 支持推理档位 —— 已用本机 agy 1.5.3 实测确认。**
  - `agy models` 只列出带档位的 slug（`claude-sonnet-5-5-low/medium/high`），而 agy 对「带档位 slug + `--effort`」会直接报冲突（`--model claude-sonnet-5-5-low conflicts with --effort=high`），**base slug 则接受**（`--model claude-sonnet-5-5 --effort high` 正常返回）。
  - 因此目录把 5.5 的档位折叠为一个条目（`efforts: low|medium|high`）；`resolveModelSlug()` 会把带档位的 5.5 slug 还原成 base（避免与 `--effort` 冲突）；`buildArgs` 对 base 的 Claude 5.5 传 `--effort`。
  - Claude 4.6 维持原有「不传 effort」行为（已不在在线目录，也未验证）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.11...v0.6.12

## 0.6.11 (2026-11-09)

### English

- **Fix(models): drop the retired Gemini 3.5/3.6/3.7 fallback rows and add the current Claude 5.5 line-up.**
  - Those Gemini models are gone upstream (maintainer-confirmed 2026-11-09), so the fallback catalog no longer advertises models the backend cannot serve. `claude-sonnet-5-5` and `claude-opus-5-5` are added next to the 4.6 entries.
  - The 5.5 entries deliberately carry **no effort tiers** yet: until agy's `--effort` support for Claude is verified, advertising tiers would show levels the adapter cannot pass. When that is confirmed, add `efforts` and extend `isEffortCapable` together.
  - Why this matters: the live catalog comes from `agy models`, but the fallback list is what the picker shows when that command cannot run (signed out / offline) — a stale entry there produces a model that fails on selection.

### 中文

- **修复(models)：移除已下线的 Gemini 3.5/3.6/3.7 回退项，补上当前 Claude 5.5 阵容。**
  - 这几个 Gemini 模型上游已下线（维护者 2026-11-09 确认），回退目录不再列出后端无法提供的模型；`claude-sonnet-5-5`、`claude-opus-5-5` 与 4.6 并列。
  - 5.5 条目**暂不声明 effort 档位**：agy 对 Claude 的 `--effort` 支持尚未验证，声明了只会显示实际传不下去的档位；确认后再同步加 `efforts` 与 `isEffortCapable`。
  - 影响面：在线目录来自 `agy models`，但 `agy models` 不可用时（未登录/离线）选择器显示的就是这份回退目录——残留的旧条目会给出一个一选就失败的模型。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.10...v0.6.11

## 0.6.10 (2026-11-09)

### English

- **Fix(client): the account console is readable again — full email addresses, pre-compaction sizing (reverts the density part of #81).**
  - #81 capped the email badge at `maxWidth: 135px`, so real addresses rendered as `q98646558@gm`, and shrank every card/row (`8px 10px` cards, 10.5–11px quota type, 6px bars, 2px 6px badges) — the panel felt visibly smaller than before. The compaction is reverted; cards are back to `10px 14px` / `8px` gaps and the quota rows to 11.5px type.
  - The two good parts of #81 are kept in a non-shrinking form: the reset/cooldown cluster now has a **fixed 150px width** (bars share identical start/end X — no jagged staircase) and status badges carry `whiteSpace: nowrap` + `flexShrink: 0` (中文 labels no longer wrap character-by-character).
  - New `test/client-account-card-style.test.ts` guards all three: no fixed email width cap, roomy card density, aligned-and-readable quota rows.

### 中文

- **修复(client)：账号控制台恢复可读——邮箱完整显示、尺寸回到压缩前（回退 #81 的「紧凑化」部分）。**
  - #81 给邮箱徽章加了 `maxWidth: 135px`，真实地址被截成 `q98646558@gm`；同时把每张卡片/每行都压小（卡片 `8px 10px`、额度字号 10.5–11px、进度条 6px、徽章 `2px 6px`），整体观感明显变小。现回退：卡片恢复 `10px 14px` / `8px` 间距，额度行字号回到 11.5px。
  - 保留 #81 两个**不靠压缩**的改进：右侧「重置/冷却」簇固定 **150px** 宽（所有进度条起止 X 一致，不再呈阶梯状）；状态徽章加 `whiteSpace: nowrap` + `flexShrink: 0`（`冷却中` 不再逐字换行）。
  - 新增 `test/client-account-card-style.test.ts` 守住三点：邮箱不再有固定宽度上限、卡片密度恢复、额度行对齐且字号不缩。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.9...v0.6.10

## 0.6.9 (2026-11-09)

### English

- **Fix(pool): `pool.json` can no longer be torn by two writers, and a corrupt file recovers from a last-good snapshot instead of emptying the pool (issue #90).**
  - Persists used a single fixed `.pool.json.tmp`, so two host processes writing at once could overwrite/truncate each other and leave a half-written file that `load()` could only discard — the UI then showed an empty account pool. Writes now go through a tmp name unique per writer (pid + random), a JSON round-trip validation, and `rename` with retries.
  - Every successful persist also refreshes `pool.json.last-good`. If the primary file is unparsable, `load()` keeps the forensic `pool.json.corrupt-<ts>` copy **and** restores the last-good snapshot (`recoveredFromLastGood` is observable for diagnostics) before falling back to defaults.

### 中文

- **修复(pool)：两个写者同时持久化不再撕裂 `pool.json`，损坏时会从 last-good 快照恢复而不是把账号池清空（issue #90）。**
  - 持久化过去固定用 `.pool.json.tmp`，两个宿主进程同时写会互相覆盖/截断，留下半截文件，`load()` 只能丢弃——UI 表现为「账号全没了」。现在写入改为**每写者唯一**的 tmp 名（pid + 随机）、写后 JSON 往返校验、`rename` 重试。
  - 每次成功持久化同时刷新 `pool.json.last-good`；主文件无法解析时，`load()` 先保留 `pool.json.corrupt-<ts>` 取证副本，**再**恢复 last-good 快照（`recoveredFromLastGood` 可供诊断），两者都失败才回落默认池。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.8...v0.6.9

## 0.6.8 (2026-11-08)

### English

- **Fix(warmup): the 7-day warmup no longer freezes on a floating post-reset window, and probes use models each account actually has.** (thanks @Ronnoc, #88)
  - After an upstream weekly reset (or for an account with zero usage), Google returns a floating `resetTime = now + 7 days` with no `description`. The old trigger only fired at `now >= resetTs - 60s`, so those accounts were never probed and the weekly timer floated at "7d 0h" forever. A probe now also fires when `remainingMs >= 6 days`, and the cooldown key is deterministic (`identity:family:weekly`) so a floating reset can no longer invalidate it.
  - Argon is exposed with effort tiers; probing the bare `gemini-4-argon` got a 404. It maps to `gemini-4-argon-low`, and when the account's quota row lists Argon models the low tier is picked from it.
  - Accounts differ in which Claude generation they can use (legacy `claude-sonnet-4-6` vs migrated `claude-sonnet-5-5-*`). The probe model is now chosen per account from `quotas.anthropic.models` (monitored pick → any Sonnet low/medium → any Sonnet → any Claude), instead of a global `claude-sonnet-4-6`.

### 中文

- **修复(warmup)：7 天预热不再卡在「重置后的浮动窗口」，且探测模型按账号实际可用选择。**（感谢 @Ronnoc，#88）
  - 上游周额度重置后（或本周期零使用），Google 返回浮动的 `resetTime = now + 7 天` 且无 `description`；旧逻辑只在 `now >= resetTs - 60s` 时触发，于是这些账号永远不被探活，周计时器一直显示浮动「7d 0h」。现在 `remainingMs >= 6 天` 也会触发，且冷却键固定为 `identity:family:weekly`，浮动 reset 不会再让它失效。
  - Argon 上游按思考档位暴露模型，直接探测 `gemini-4-argon` 会 404；现映射到 `gemini-4-argon-low`，并优先从该账号的配额模型列表里取 low 档。
  - 不同账号可用的 Claude 代际不同（旧账号 `claude-sonnet-4-6`，迁移账号 `claude-sonnet-5-5-*`）；探测模型改为按 `quotas.anthropic.models` **逐账号**选择（monitored 命中 → 任意 Sonnet low/medium → 任意 Sonnet → 任意 Claude），不再全局写死 `claude-sonnet-4-6`。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.7...v0.6.8

## 0.6.7 (2026-11-08)

### English

- **Fix(config): the model context window and output cap are set via env, so a 256K model stops showing as 1M (issue #83).**
  - `contextWindowDefault` / `maxTokensDefault` drive DSH's per-model `context.contextWindow` — and therefore the "context used %" tooltip — but agy's model list carries no window, and neither key was exposed through an env var or the settings UI. A user whose model is really 262 144 tokens could only see the 1 048 576 default.
  - `DSH_AGY_CONTEXT_WINDOW` and `DSH_AGY_MAX_TOKENS` now override them (positive integers only; invalid values fall back), with README rows in 中文 and English.

### 中文

- **修复(config)：模型上下文窗口与输出上限可用环境变量设置，256K 模型不再显示成 1M（issue #83）。**
  - `contextWindowDefault` / `maxTokensDefault` 决定上报给 DSH 的每模型 `context.contextWindow`（也就是「上下文已用 %」浮层），但 agy 的模型列表不上报窗口，且这两个键此前既没有环境变量也没有设置面板入口——真实窗口是 262144 的用户只能看到 1048576 的默认值。
  - 现支持 `DSH_AGY_CONTEXT_WINDOW` / `DSH_AGY_MAX_TOKENS`（仅接受正整数，非法值回落），并在中英 README 配置表中补充说明。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.6...v0.6.7

## 0.6.6 (2026-11-08)

### English

- **Docs: document the DSH 0.2.2 boot failure seen on 0.4.99 and the upgrade path (issue #86).**
  - Users still on 0.4.99 (and earlier) can hit `web boot: 1 entry did not activate` with `locale "es" is already registered` after upgrading to DSH 0.2.2-rc.1: that client called `locale.addLanguage` unconditionally, and the host may have registered `es`/`pt-BR` first. Idempotent registration landed in **0.5.5** (#70/`31c99c1`), so the fix is an upgrade to ≥ 0.5.5; both FAQs now say so, in 中文 and English, together with the disable-plugin workaround.

### 中文

- **文档：记录 0.4.99 在 DSH 0.2.2 下的启动失败与升级路径（issue #86）。**
  - 仍在使用 0.4.99（及更早）的用户升级到 DSH 0.2.2-rc.1 后可能遇到 `web boot: 1 entry did not activate` 与 `locale "es" is already registered`：旧客户端无条件调用 `locale.addLanguage`，而宿主可能已先注册 `es`/`pt-BR`。幂等注册已在 **0.5.5**（#70/`31c99c1`）落地，升级到 ≥ 0.5.5 即可；中英 FAQ 均已补充该说明与「临时禁用插件」的兜底。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.5...v0.6.6

## 0.6.5 (2026-11-07)

### English

- **Fix(mcp-bridge): bridged calls work again on DSH 0.2.2 — send the batch shape and unwrap its result (issue #84).** (thanks @hjwsm1989, #85)
  - DSH 0.2.2 changed `tools.execute()` from a single call to a batch (`{ calls, signal, agent }`), so the 0.2.1-shaped payload made `executeToolBatch()` read `input.calls` as `undefined` and **every** bridged call died with `ToolBatchExecutionError` before dispatch (whole reverse-MCP surface, including `agent_teams_*`, unusable). The bridge now sends both shapes — 0.2.1 ignores `calls`, 0.2.2 ignores the extra fields — and `settledToolResult()` unwraps `results[0].result` (matched by call id) while passing a 0.2.1 single result through untouched.
  - Hardening on merge: the PTC nested-dispatch `parent` token from #66 is restored, but only for a PTC surface (`run_code` visible), so 0.2.1 PTC keeps working while native calls never carry it (0.2.2 gates PTC on the execution source).

### 中文

- **修复(mcp-bridge)：DSH 0.2.2 下桥接调用恢复可用——发送批量形状并解包结果（issue #84）。**（感谢 @hjwsm1989，#85）
  - DSH 0.2.2 把 `tools.execute()` 从单次调用改成批量（`{ calls, signal, agent }`），旧的 0.2.1 形状让 `executeToolBatch()` 读到 `undefined` 的 `input.calls`，于是**所有**桥接调用在派发前就 `ToolBatchExecutionError`（整套反向 MCP 面，含 `agent_teams_*`，全部不可用）。现同时发送两种形状（0.2.1 忽略 `calls`，0.2.2 忽略多余字段），并用 `settledToolResult()` 按 call id 解包 `results[0].result`，0.2.1 的单结果原样透传。
  - 合并时加固：恢复 #66 的 PTC 嵌套派发 `parent` 令牌，但**仅在检测到 PTC 面**（可见 `run_code`）时携带，使 0.2.1 的 PTC 继续可用，而 native 调用永不携带（0.2.2 以执行源判定 PTC）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.4...v0.6.5

## 0.6.4 (2026-11-07)

### English

- **Fix(goal): a completed goal is no longer re-completed on every later turn, and synthetic call ids are unique (issue #80).** (thanks @hjwsm1989, #82)
  - `detectGoalContext()` scanned the whole history, so markers from an already completed goal still matched a brand-new human turn; the adapter then emitted a synthetic `update_goal(complete)` whose call id was deterministic (`…-<goalId>-<revision>`). Nine identical `tool_call` ids piled up in the transcript — harmless on the agy route (it never serializes the transcript) but an immediate, permanent `400 Duplicate 'call_id'` after switching to an HTTP provider.
  - The scan now stops at the newest genuine human message; a new `resolveGoalContext(messages, live)` makes the live goal view authoritative (`live === null` → never synthesize a completion; `undefined` → history fallback for older hosts); and each emission mints a unique id (`…-<time36>-<seq36>`). The `sessionGoal()` log fallback no longer returns a completed/blocked goal.

- **Fix(client): compact the account modal and align the quota progress bars.** (thanks @Ronnoc, #81)
  - 4+ accounts now fit without truncating the fourth card (`max-height: min(88vh, 880px)`, tighter card padding/margins); the left window-label column is a fixed 64px so every progress bar starts/ends on the same X; status badges are `nowrap`/`flexShrink: 0` so `冷却中` no longer wraps character-by-character.

### 中文

- **修复(goal)：已完成的目标不再在后续每轮重复完成，合成 call id 也保证唯一（issue #80）。**（感谢 @hjwsm1989，#82）
  - `detectGoalContext()` 扫描整段历史，已完成目标的标记仍会匹配到新的用户轮次，适配器因此反复发出 `update_goal(complete)`，call id 又是确定值（`…-<goalId>-<revision>`）；九条相同 `tool_call` id 堆积后在 agy 路由上无感，但切到 HTTP provider 就会永久 `400 Duplicate 'call_id'`。
  - 现在扫描在最近一条真实用户消息处停止；新增 `resolveGoalContext(messages, live)` 让实时 goal 视图权威（`null` → 绝不合成完成；`undefined` → 旧宿主走历史回退）；每次发号都唯一（`…-<time36>-<seq36>`）；`sessionGoal()` 的日志回退也不再返回已完成/阻塞的目标。

- **修复(client)：压缩账号弹窗、对齐额度进度条。**（感谢 @Ronnoc，#81）
  - 4 个以上账号不再截断第 4 张卡片（`max-height: min(88vh, 880px)`、更紧凑的卡片内外边距）；左侧窗口标签列固定 64px，所有进度条起止 X 对齐；状态徽章 `nowrap`+`flexShrink: 0`，`冷却中` 不再逐字换行。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.3...v0.6.4

## 0.6.3 (2026-11-06)

### English

- **Fix(compaction): the compaction card now actually renders in DSH, reports real token deltas, and no longer duplicates across accounts.** (thanks @Ronnoc, #79)
  - DSH's markdown renderer uses `allowDangerousHtml: false`, so the previous raw `<div class="agy-compaction-card">` marker was escaped into visible text. The marker is now a standard blockquote **link** (`> [✂️ 上下文已压缩 · 128.5k → 14.2k tokens (-89%)](#agy-compaction-card?…)`) that the client enhancer upgrades to the native card — and legacy raw/escaped markers still upgrade.
  - Token accounting summed only `input_tokens` (the uncached delta), so cards fired at tiny counts like `4.6k → 205`; `calcPromptTokens()` now adds `cache_read_tokens` + `cache_write_tokens` for the real prompt size.
  - Multi-account compaction cleared only the active account's binding, so rotating steps re-triggered duplicate cards; compaction now invalidates every binding for the session across accounts and debounces repeated notices.
  - Hardening on merge: marker query values now percent-encode `( ) ' !` too, so a digest containing parentheses can't terminate the markdown link early.

### 中文

- **修复(compaction)：压缩卡片现在能在 DSH 里真正渲染、显示真实 token 变化，且不再跨账号重复。**（感谢 @Ronnoc，#79）
  - DSH 的 markdown 渲染器 `allowDangerousHtml: false`，旧的原始 `<div class="agy-compaction-card">` 标记会被转义成可见文本。现改为标准引用块**链接**（`> [✂️ 上下文已压缩 · 128.5k → 14.2k tokens (-89%)](#agy-compaction-card?…)`），由客户端增强器升级为原生卡片；旧的原始/转义标记仍可升级。
  - token 记账只加 `input_tokens`（未缓存增量），导致卡片在 `4.6k → 205` 这种小值就触发；`calcPromptTokens()` 现加上 `cache_read_tokens` + `cache_write_tokens` 得到真实 prompt 规模。
  - 多账号下压缩只清当前账号的绑定，切换账号的后续步骤会重复触发卡片；现按会话清空所有账号的绑定并对重复提示去抖。
  - 合并时加固：标记的查询值额外百分号编码 `( ) ' !`，避免含括号的摘要把 markdown 链接提前截断。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.2...v0.6.3

## 0.6.2 (2026-11-06)

### English

- **Fix(quota): Argon is weekly-only when the backend folds it into the Gemini bucket, and `/agy clear-cooldown` can now lift a quota bench (issue #77).** (thanks @hjwsm1989, #78)
  - The model-level fallback filed Argon's **weekly** `quotaInfo` under `remainingFraction` (the 5-hour slot), so the 10% 5h floor benched accounts whose weekly quota was still above the 5% weekly floor — the `5% < weekly ≤ 10%` dead band. Argon without a backend 5-hour window is now written to `weeklyFraction/weeklyResetTime` only (an existing mis-filled row is healed on the next poll).
  - The "no account can serve" error now reports the real reason via `pool.explainIneligibility()` (`disabled` / `auth` / `cooldown` / `quota`) and suggests a remedy that works; `/agy clear-cooldown` also lifts the proactive low-quota bench for the cached snapshot (`quotaGateClearedAt`), re-arming as soon as a poll writes fresher data.
  - Retired Argon groups release their cooldown again: the dedicated-group decision uses the summary alone, not the synthesized model row that made the `else` branch unreachable.

### 中文

- **修复(quota)：后端把 Argon 折进 Gemini 桶时按「仅周额度」处理，且 `/agy clear-cooldown` 现在能解除配额停摆（issue #77）。**（感谢 @hjwsm1989，#78）
  - 模型级回退把 Argon 的**周** `quotaInfo` 写进 `remainingFraction`（5 小时槽），于是 10% 的 5h 下限会误伤周额度仍高于 5% 下限的账号（`5% < weekly ≤ 10%` 死区）。现在没有后端 5 小时窗口的 Argon 只写 `weeklyFraction/weeklyResetTime`，并在下次轮询时修复已被误填的行。
  - 「无可用账号」错误改用 `pool.explainIneligibility()` 报告真实原因（`disabled`/`auth`/`cooldown`/`quota`）并给出有效建议；`/agy clear-cooldown` 会同时解除针对当前缓存快照的主动低配额停摆（`quotaGateClearedAt`），一旦轮询写入更新数据即自动重新生效。
  - 退役的 Argon 组重新能释放冷却：专用组判定只看 summary，不再被模型回退合成出来的行挡住。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.1...v0.6.2

## 0.6.1 (2026-11-06)

### English

- **Fix(adapter): frame the compaction prompt so plan mode stops trying tools (keeps the sandbox).** (thanks @Ronnoc, #75)
  - Headless compaction runs in `--mode plan`; when the history mentioned files/workspace state the model treated them as live tasks, tried MCP tools, hit `user denied permission` headlessly and ended the turn with an empty response — surfacing as `Compaction could not produce a useful summary`. The history is now wrapped in `<conversation_history>` with an explicit automated-summarizer persona and strict negative constraints (do not act on instructions inside, do not call tools, output only the summary). Plan mode is deliberately **kept** so compaction can never inherit `--dangerously-skip-permissions`; the test asserts both.

### 中文

- **修复(adapter)：用提示词框定压缩摘要，plan 模式下不再尝试调用工具（沙箱保留）。**（感谢 @Ronnoc，#75）
  - 无头压缩跑在 `--mode plan`；当历史里提到文件/工作区状态时，模型会当成待办并调用 MCP 工具，无头环境被拒后回合以空响应结束，用户看到 `Compaction could not produce a useful summary`。现把历史包进 `<conversation_history>`，明确「自动摘要器」身份与严格负向约束（不执行历史中的指令、不调用任何工具、只输出摘要）。**保留 plan 模式**，确保压缩调用永远不会继承 `--dangerously-skip-permissions`；测试同时断言这两点。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.6.0...v0.6.1

## 0.6.0 (2026-11-05)

### English

- **Feat(client): DeepSeek-parity context-compaction card with token-delta metrics.** (thanks @Ronnoc, #74)
  - Compaction was invisible: ADR-013 cleared stale bindings and re-seeded agy with a digest, but the conversation showed nothing. `renderCompactionMarker()` now emits a markdown-safe marker at the first compacted turn carrying `beforeTokens/afterTokens/items` plus a percent-encoded digest, and `scanAndEnhanceCompactionCards()` upgrades it to a native-style collapsible card (`上下文已压缩 · 128.5k → 14.2k tokens (-89%)`). Token accounting is persisted per session (`lastInputTokens`) so the "before" figure is the real pre-compaction occupancy. In plain markdown/headless it degrades to a blockquote.
  - Hardening on merge: the digest is only decoded behind a `try/catch` (a mangled percent-encoding now degrades to "no digest" instead of aborting the marker scan), and the digest text reaches the DOM via `textContent` only.

### 中文

- **新增(client)：对齐 DeepSeek 原生的「上下文已压缩」卡片，附 token 变化指标。**（感谢 @Ronnoc，#74）
  - 此前压缩过程不可见：ADR-013 会清理旧绑定并用摘要重播种 agy，但会话里没有任何提示。`renderCompactionMarker()` 现在在首个压缩回合注入 markdown 安全的标记（含压缩前/后 token、条目数、百分号编码的摘要），`scanAndEnhanceCompactionCards()` 将其升级为原生风格可折叠卡片（`上下文已压缩 · 128.5k → 14.2k tokens (-89%)`）。会话内持久化 `lastInputTokens` 使「压缩前」是真实占用值；纯 markdown/无头环境降级为引用块。
  - 合并时加固：摘要解码置于 `try/catch`（畸形百分号编码降级为「无摘要」而非中断扫描），摘要正文仅通过 `textContent` 进入 DOM。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.7...v0.6.0

## 0.5.7 (2026-11-05)

### English

- **Fix(adapter): a generic agy CLI failure no longer blacklists a model as effort-unsupported.** (thanks @skyzzq, #73)
  - `parseEffortUnsupported()` had a fallback branch that learned ANY `invalid model selection … --effort` echo. agy echoes the whole invocation on unrelated failures (`…): quota exhausted`, `rate limit exceeded`, TLS/auth jitter), so one quota blip permanently recorded the model in `effort-unsupported.json`; DSH core then threw `model … does not support reasoning effort` on every later turn. The fallback now requires the error text itself to say effort is unsupported; adds regression cases for quota/rate-limit echoes.

### 中文

- **修复(adapter)：agy 的普通 CLI 失败不再把模型误记为「不支持 effort」。**（感谢 @skyzzq，#73）
  - `parseEffortUnsupported()` 的回退分支会对任何包含 `invalid model selection … --effort` 的报错做学习。agy 在额度耗尽/限流/TLS 抖动时会回显整条调用（`…): quota exhausted`、`rate limit exceeded`），于是一次抖动就把模型永久写进 `effort-unsupported.json`，随后 DSH 核心对之后每一轮都抛 `model … does not support reasoning effort`。现回退分支要求错误文本自身明确说明 effort 不受支持；补充额度/限流回显的回归用例。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.6...v0.5.7

## 0.5.6 (2026-11-05)

### English

- **Fix(host): a proxy blip is classified NETWORK, not AUTH (issue #71).**
  - `runLogText` reached only the narrow `looksLikeAuthVerificationJitter` set. agy 1.4.12 logs a two-second proxy flap as `keyringAuth: token validation failed due to network error (token may still be valid)`, which only the wide `looksLikeNetworkError` matches — so `transportFailure` was false and a healthy account was quarantined as `AUTH`. The decision now lives in a pure, tested `isTransportFailure({…})` seam that feeds the same evidence (raw error, auth text, stderr, stdout head, run log) to both matchers; the exact 1.4.12 log is a regression test.

- **Perf(client): stop re-sweeping expanded think rows and avoid forced layout.** (thanks @Ronnoc, #72)
  - `scanThinkingRows()` now queries `div[data-variant="think"]:not([data-agy-expanded="true"])`, so already-handled turns are filtered by the selector engine instead of re-walked on every mutation. `tryExpandThinkRow()` checks `aria-expanded`/`data-expanded`/hidden-display before reading `body.clientHeight`, removing a forced synchronous layout from the critical path in long conversations.

### 中文

- **修复(host)：代理抖动判为 NETWORK 而非 AUTH（issue #71）。**
  - `runLogText` 只喂给了窄匹配 `looksLikeAuthVerificationJitter`。agy 1.4.12 会把两秒的代理抖动记成 `keyringAuth: token validation failed due to network error (token may still be valid)`，而只有宽匹配 `looksLikeNetworkError` 认这句 → `transportFailure` 为 false，健康账号被当作 `AUTH` 隔离。现把判断收敛到纯函数、可测试的 `isTransportFailure({…})`（原始错误、auth 文本、stderr、stdout 头部、运行日志统一输入两个匹配器），并把真实 1.4.12 日志作为回归用例。

- **性能(client)：不再重复扫描已展开的思考行，且避免强制重排。**（感谢 @Ronnoc，#72）
  - `scanThinkingRows()` 改为查询 `div[data-variant="think"]:not([data-agy-expanded="true"])`，已处理的轮次由选择器引擎过滤；`tryExpandThinkRow()` 先查 `aria-expanded`/`data-expanded`/隐藏样式，再读 `body.clientHeight`，把强制同步布局移出长会话关键路径。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.5...v0.5.6

## 0.5.5 (2026-11-05)

### English

- **Fix(client): locale/dictionary registration is idempotent — retry & re-sync no longer trap the plugin in FAILED.** (thanks @Ronnoc, #70)
  - DSH's `locale.addLanguage`/`locale.register` throw when an entry already exists (`locale "pt-BR" is already registered`). The apply effect registered `pt-BR`/`es` and four `agy-link` dictionaries unconditionally, so re-applying the module (inventory page retry / fiber reconciliation) threw and marked the entry `FAILED`. Registration now checks the existing catalog and tolerates only the documented `already registered` / `already has locale` errors (anything else still rethrows); disposing never removes host-owned entries. Also hardens the settings nav-icon observer against a missing `<body>`/DOMContentLoaded timing, and isolates toolview slot registration failures.

### 中文

- **修复(client)：locale/词典注册幂等——重试与重新同步不再把插件卡进 FAILED。**（感谢 @Ronnoc，#70）
  - DSH 的 `locale.addLanguage`/`locale.register` 在条目已存在时会抛错（`locale "pt-BR" is already registered`）。apply effect 无条件注册 `pt-BR`/`es` 与四份 `agy-link` 词典，插件重载/条目重试时会抛异常并把条目置为 `FAILED`。现注册前检查现有目录，仅容忍 `already registered`/`already has locale` 两类错误（其它仍抛出）；dispose 不会删除宿主已有的条目。同时加固设置导航图标的 observer（body/DOMContentLoaded 时机）并把 toolview 槽位注册失败隔离。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.4...v0.5.5

## 0.5.4 (2026-11-05)

### English

- **Fix(quota): serialize Windows CLI quota refresh and close two Windows slot-isolation holes.** (thanks @Ronnoc, #69)
  - `readCliUsageFamilies` ran `agy -p /usage` **without** the credential-slot mutex. On Windows the OS credential store is one shared slot that secondary runs temporarily swap, so an in-flight CLI read could attribute a secondary account's quota/reset to the primary. The read now holds `credentialSlotMutex` (4 s timeout, REST fallback on contention), and forced refreshes run sequentially on Windows.
  - `cliSlotHoldsAccount()` could tautologically match the slot against itself when no independent durable credential/disk token existed; `getStoredToken()` now takes `allowKeychainFallback` and the slot check refuses that self-match.
  - Deduplicates the Windows credential read via `wincred.readWindowsCredentialRaw`, and makes `defaultPoolDir()`/`isolatedHomeEnv()` recover the top-level `.dsh/agy-accounts` when invoked inside an isolated account dir (prevents nested credential files / mislabeled accounts).

### 中文

- **修复(quota)：Windows 下串行化 CLI 额度刷新，并堵住两个槽位隔离漏洞。**（感谢 @Ronnoc，#69）
  - `readCliUsageFamilies` 调 `agy -p /usage` 时**没有**持 `credentialSlotMutex`。Windows 的凭据存储是单槽，子账号运行会临时换槽，于是进行中的 CLI 读取可能把子账号的额度/重置时间记到主账号。现读取期间持锁（4s 超时，争用则回退 REST），Windows 的强制刷新也改为顺序执行。
  - `cliSlotHoldsAccount()` 在缺少独立持久凭据/磁盘 token 时可能拿槽位与自己比对（恒真）；`getStoredToken()` 新增 `allowKeychainFallback`，该检查拒绝这种自匹配。
  - 通过 `wincred.readWindowsCredentialRaw` 复用 Windows 凭据读取；`defaultPoolDir()`/`isolatedHomeEnv()` 在隔离账号目录内调用时恢复到顶层 `.dsh/agy-accounts`（避免嵌套凭据文件与账号误标）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.3...v0.5.4

## 0.5.3 (2026-11-05)

### English

- **Fix(models): a missing Google per-model quota breakdown no longer hides Gemini 4 Argon for Google AI Ultra (issue #68).**
  - `accountHasArgon()` treated *"a `google` quota group exists but has no `models` list"* as an authoritative negative, so the discovered-catalog fallback below it was unreachable. Ultra folds Argon into the shared Gemini bucket and omits the per-model list entirely, so Ultra accounts never saw `Gemini 4 Argon` in `/model`. A negative is now only authoritative when the Google group DOES enumerate its models (a free/standard account listing them without Argon); a missing list is treated as unknown and the per-account discovered catalog decides. Adds Ultra + free-breakdown regression tests.

### 中文

- **修复(models)：Google 配额缺少逐模型明细时不再把 Gemini 4 Argon 从 Google AI Ultra 账号隐藏（issue #68）。**
  - `accountHasArgon()` 把「存在 `google` 配额组但没有 `models` 列表」当成权威否定，导致后面的已发现目录回退永远不可达。Ultra 会把 Argon 折进共享的 Gemini 桶并完全不发逐模型列表，因此 Ultra 账号在 `/model` 里始终看不到 `Gemini 4 Argon`。现在只有 Google 组**确实枚举了模型**时（免费/标准账号列出模型但不含 Argon）才判为否定；缺少列表视为未知，由该账号的已发现目录决定。补充 Ultra 与免费账号逐模型明细的回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.2...v0.5.3

## 0.5.2 (2026-11-04)

### English

- **Fix(client/translate): the translation card is a native DSH surface.** It read as a foreign banner inside a transcript: a blue→purple→pink gradient fill, a gradient border with a top-right bloom, a gradient wordmark and a "Translated by Gemini" footer stacked on a second header row - all in saturated brand colour. It now follows the host's own tool-card recipe: a 0.5px hairline (`--dsw-alias-border-l1`), the markdown code-block fill, a 12px radius and a code-block-banner header. Identity is reduced to one monochrome spark plus the localized 「Gemini 译文」 label (the spark takes the DSH accent token); model/effort ride the header as caption meta; copy / show-original / collapse share one flat action group that wraps as a unit, so a narrow panel truncates the meta instead of splitting the buttons.
- **Feat(client/settings): pick the translation model and effort from the Auto-translate row.** Both were config-file/env-only, so changing how the translation call runs meant editing settings and restarting. Two native dropdowns now sit on the right of that row and write through the existing `POST /config`; the empty value still means "let the host decide". Layout measured rather than guessed: at the 640px panel the toggle plus both selects stay on ONE line (label absorbs the shrink) and the description wraps; below 680px the selects stretch to share the line.
- **Fix(client): the console can no longer flash while scrolling.** The 0.4.72 flicker fix added two compositing hints while chasing that symptom - `contain: content` on the panel and `transform: translateZ(0)`. Both are themselves Chromium traps here: paint containment on an ancestor of a scrolling subtree makes the compositor drop and rebuild the backing layer mid-scroll, and a forced layer over a translucent fixed backdrop re-composites the whole panel per frame. A 640px panel needs neither; plain `overflow: hidden` already clips it, and the decorative shimmer loses its `will-change`. Two isolation holes are closed too: wheel/touch over any part of the overlay that is not its own scroller (header, padding, the dim itself) no longer leaks to the transcript behind, and the same applies while the console is open on phone-width. Reported flash: **gone** on the reporter's machine.
- A temporary Alt+Shift+F render probe used to bisect that flash was removed before this release.

### 中文

- **修复(client/translate)：译文卡片改成 DSH 原生表面。** 之前它在会话里像个"外来的横幅"：蓝→紫→粉渐变底、带左上光晕的渐变边框、渐变字标，再加一行"Translated by Gemini"页脚压在第二个标题行上，全是高饱和品牌色。现在照抄宿主自己的工具卡片配方：`--dsw-alias-border-l1` 发丝线、markdown 代码块底色、12px 圆角、代码块横幅式表头。身份只剩一枚单色星形 + 本地化的「Gemini 译文」标签（星形取 DSH accent 令牌）；模型/档位降级为表头 caption 元信息；复制 / 看原文 / 折叠合并成一组扁平操作，按整体换行——面板窄时先截断元信息，而不是把按钮拆开。
- **新增(client/settings)：在"自动翻译"那一行直接选翻译模型与档位。** 这两个原本只能改配置文件/环境变量，改一次就要重启。现在该行右侧是两个原生下拉（走既有的 `POST /config`），空值仍表示"交给宿主决定"。布局是按实测定的：640px 面板下开关 + 两个下拉保持**一行**（靠标签列收缩吸收），描述换行；680px 以下下拉按行均分。
- **修复(client)：控制台滚动时不再闪屏。** 0.4.72 的防闪补丁为了追同一个症状加了两个合成提示——面板上的 `contain: content` 与 `transform: translateZ(0)`——它们在这里本身就是 Chromium 的坑：滚动子树祖先上的 paint containment 会让合成器在滚动中途丢弃并重建 backing layer；而半透明固定背板上的强制图层会每帧重合成整个面板。640px 面板两者都不需要，`overflow: hidden` 本来就裁得干净，装饰光晕也去掉了 `will-change`。同时补上两个隔离漏洞：覆盖层内任何**非自身滚动区**（表头、内边距、遮罩本体）上的滚轮/触摸不再漏给后面的会话；手机宽度下控制台打开时同理。报告者的闪屏：**已消失**。
- 发布前移除了用于二分定位该闪屏的临时 Alt+Shift+F 渲染探针。

### Full Changelog

https://github.com/amlyczz/dsh-agy-link/compare/v0.5.1...v0.5.2

## 0.5.1 (2026-11-04)

### English

- **Feat(client): the translation card is a Gemini surface now, not a generic notice.** The card carries the official four-point spark filled with Google's brand gradient (`#4285F4 → #9B72CB → #D96570`), the gradient wordmark, a hairline brand border with a soft top-right bloom, and a "Translated by Gemini" attribution line. Copy and the original-text toggle move onto pill buttons, and the per-reply action glyph reuses the same gradient spark, so the affordance reads as Gemini before you hover. Every colour is an rgba overlay or a DSH token, so the card holds up in both themes, and each render mints its own gradient id so several cards can coexist.
- **Fix(client): the reply action settles even when the panel remounts mid-flight.** The chat timeline re-creates the transcript whenever a card lands in it, so the instance that started a translation could be gone before the promise resolved — its `setState` was a no-op and the spinner never stopped. Action state is now published to every mounted instance (`setActionState` / `subscribeActionState`) and `ACTION_INFLIGHT` alone decides `working`, so the surviving instance settles to `done`; the durable-record lookup still keeps a finished card `done` across reloads and session switches.
- **Fix(client): the hover hint can no longer leak as body text.** The tooltip node now carries the `.agy-tsl-tip` class that owns its bubble styling, and `showTip()` repairs a node left behind by an older build (class plus `position: fixed`) before showing it. A missing stylesheet now degrades to "no hint", never to a stray line under the action strip.
- **Fix(host): a bound translation explains the reply it was given, not one it remembers.** With `translateBindConversation` the host used to send the raw source text on every turn, which left the model free to answer from an earlier turn it had seen. Each turn now sends `buildTranslationRequest()` — an explicit "current turn's reply" instruction plus the source — while the persona still goes out once per conversation. The prompt also stopped being a style contract: unpack jargon before moving on, keep conclusions and conditions, and never compress a long answer into a verdict.
- **Docs: README rewritten for 0.5.x.** One file with Chinese and English, refreshed pt-BR / es / en standalone pages, a dedicated Console and settings section (header badge, account card, runtime note, pool scheduling, auto-warmup, auto translate, effort, model visibility), a complete [configuration reference](docs/CONFIGURATION.md), and re-captured screenshots (console, model picker, settings) with mailbox and alias redaction.

### 中文

- **新增(client)：翻译卡片改成 Gemini 专属外观，不再是一张通用提示条。** 卡片带官方的四点星标（用 Google 品牌渐变 `#4285F4 → #9B72CB → #D96570` 填充）、渐变字标、品牌细描边与右上柔光，底部有「Translated by Gemini」署名；复制与原文对照换成胶囊按钮，回复动作条上的图标复用同一枚渐变星标，光标移上去之前就认得出是 Gemini。所有颜色都是 rgba 叠加或 DSH 令牌，深浅主题都成立；每次渲染各自生成渐变 id，多张卡片可以共存。
- **修复(client)：面板中途重挂载时，回复动作也能收尾。** 聊天气泡里一有新卡片落地，DSH 就会重建时间线，发起翻译的那个实例可能在 Promise 完成前就没了——它的 `setState` 是空操作，转圈永远不停。现在状态通过 `setActionState` / `subscribeActionState` 广播给所有已挂载实例，`working` 只看 `ACTION_INFLIGHT`，于是活下来的那个实例能落到 `done`；跨刷新、跨会话仍由持久化记录把已完成的卡片保持在 `done`。
- **修复(client)：悬停提示不会再漏成正文。** 提示节点现在带上负责气泡样式的 `.agy-tsl-tip` 类，`showTip()` 还会先修复旧构建遗留的节点（补类名与 `position: fixed`）。样式表缺失时最坏只是「没有提示」，不会在动作条下面多出一行字。
- **修复(host)：绑定会话里的翻译只讲这一轮给的回复，不去翻历史。** 开了 `translateBindConversation` 时，以前每轮只发原文，模型可能拿它记住的上一轮来答。现在每轮都发 `buildTranslationRequest()`——明确「当前这一轮 AI 回复」再加上原文，人格仍然每条会话只发一次。提示词也不再是风格契约：先解释术语再往下讲，结论与条件必须留着，别把长回答压成一句结论。
- **文档：README 按 0.5.x 重写。** 单文件中英双语，pt-BR / es / en 三份独立页同步，新增「控制台与设置」一节（顶栏徽标、账号卡片、运行方式、号池调度、周额度预热、自动翻译、思考强度、模型显示），补上完整的[配置参考](docs/CONFIGURATION.md)，并重拍了截图（控制台、模型选择器、设置页），邮箱与别名已打码。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.5.0...v0.5.1

## 0.5.0 (2026-11-03)

### English

- **Feat(translate): `/tsl` — Gemini rewrites the session output in plain language, pinned under the reply.**
  - One unified entry (`TranslationService`) serves three consumers: the `/tsl` command, an opt-in automatic post-turn hook, and a per-reply "译成人话" action. The model call rides this plugin's own auxiliary adapter route (`purpose:'translation'`), so it uses the same account pool — **a quota-exhausted account is cooled down and the retry lands on the next account automatically** — while staying out of conversation bindings, tools and concurrency slots.
  - Defaults to `gemini-3.8-flash` · `high` (configurable, with a live-catalog fallback chain). Each result is persisted as a `plugin:agy-link/translation` session record and rendered as a labelled **"✨ Gemini translation" card anchored directly under the translated reply**; it survives reloads, keeps the original text behind a toggle, and never enters model-visible history. Historical turns get the same card from a hover action.
  - Auto mode is **off by default** (`autoTranslate`, toggled in Settings → Antigravity, or per session with `/tsl auto on`). It reacts only to new `turn/end` completions, skips turns already produced by the translate model, throttles repeated runs, and never disturbs the agent loop when translation fails.
  - Adapter: `purpose:'translation'` joins the auxiliary channel but keeps the caller's explicit reasoning effort (aux calls would otherwise pin Gemini to `low`) and is exempt from `allowAuxiliary`.

- **Client polish, same release.** The settings panel drops the permission-mode row — the permission mode stays `skip` (still overridable by config / `DSH_AGY_MODE`, e.g. headless runs). The reasoning-effort row **stays**, relabelled **Default thinking effort** (`auto` / `low` / `medium` / `high`): it seeds the level DSH's session **model menu** starts on (`defaultEffort` defaults to `high`, mapping 1:1 to agy's levels) while the menu itself can still switch it per model. Auto-warmup and auto-translate toggles use native `[ On | Off ]` segmented capsule button groups matching pool scheduling, cleanly demonstrating that auto-translation is disabled by default.

- **Fix(client): closed-loop translation action state machine & DSH event extraction.** The Gemini translation button now transitions cleanly through `idle` (Gemini spark) -> `working` (true circular SVG spinner with rotation animation and click guard) -> `done` (green checkmark, kept while the card exists) / `error` (red retry icon, reverts after 3s), stopping event propagation on click. On the host side, `sessionEvents()` reads real DSH sessions via `session.snapshotEvents()` and `session.ownEvents()`, and `appendRecord()` supports native `session.append()`, eliminating `SESSION_UNAVAILABLE` failures when requesting translations. Unindexed messages fall back gracefully to the latest completed turn.

- **Fix(client): the hint actually shows, and the button state survives a remount.** Three follow-ups from dogfooding:
  - **Hover hint**: the native `title` bubble never appeared inside the desktop shell (and DSH's internal `Tooltip` primitive is not exposed to plugin bundles), so the action owns a small CSS tooltip. Root cause of the first attempt rendering as **inline text next to the icon**: `injectStyles()` returned early whenever the style tag already existed, so after a plugin reload the *older* sheet stayed and the newly added hover rules never applied — the tooltip `<span>` was then a plain text node in the action row. The sheet is now self-healing (it rewrites the tag when the content differs), its id is versioned (`…-tsl-css-v2`), and the hint is drawn by `::after` from a `data-tip` attribute instead of a real node, so **a missing stylesheet degrades to "no hint" rather than leaked text**. It grows to the **right** because the action strip hugs the left edge of the reply, where a centred bubble would be clipped by the transcript scroller. Verified in a browser in both states: stylesheet present → dark bubble on hover; stylesheet absent → clean icon row, no stray text.
  - **State persistence**: the chat timeline re-creates the panel when the window regains focus, so component-local state used to snap back to `idle` mid-flight ("the state vanishes when I switch windows"). The state now lives in a module-level map plus an in-flight set, and on every mount the button asks the new `GET /plugins/agy-link/translate/state?session=&message=` whether this reply already owns a durable record — so **a finished translation keeps its ✓ after a window switch, a session switch or a full page reload**, and a request still running is restored as the spinner instead of looking un-translated. A successful run now stays `done` (the card is durable) instead of reverting to `idle` after 2.5s; only an error auto-clears, back to retryable `idle` after 3s.

- **Fix(issue #67): a model that refuses `--effort` no longer breaks every turn.** agy 1.4.6 (Windows) rejects the *whole* invocation when `--effort` is passed to a model that does not take one — `invalid model selection (… --effort "medium"): --effort is not supported for model "gemini-3.8-flash"` — and with the fallback catalog active (which advertises `low/medium/high` for the Gemini Flash family as a *guess*) a single `defaultEffort` setting made every request fail. Effort support is now learned from agy itself: the refusal is parsed for the model id, that model is replayed **once without `--effort`** so the turn succeeds (the refusal arrives before any output, so the replay is safe), it is persisted to `~/.dsh/agy-link/effort-unsupported.json` so a restart never asks again, and the model stops advertising `reasoning.efforts` — the session model menu drops its effort row instead of offering levels agy will reject. Visible in `/plugins/agy-link/status` (`effortUnsupported`) and the `/agy doctor` report for support. Invariant: an effort mismatch may cost one extra agy process, never a failed turn. The one-shot path (`agy_ask`) honours the same learned list — it spawns agy directly — and `runAgyOnce` now prefers the result envelope's own error over a bare `agy exited with code 1: `, which is what made that path unable to learn (and hard to diagnose) in the first place.

- **Feat(translate): one agy conversation per DSH session (1:1), so the translation persona is sent once.** Translations used to spawn a brand-new, unbound agy call every time and re-send the whole instruction block. Now a translation conversation is bound per DSH session under `<sessionKey>#tsl` (account-scoped like the turn binding, so it never collides with it and inherits the cooldown/re-seed behaviour), running with `--conversation`, `--mode plan` and the **session's own workspace as cwd**. The first message carries the persona: who agy is, **the DSH session id**, that workspace, the absolute path of the session's raw log (`~/.dsh/sessions/*/session-<id>/session.*.jsonl.zstd`) with a `zstd -dc … | jq` recipe, and a bounded digest of the thread — so agy can look the history up itself. Later translations reuse the conversation.
  - Measured on real agy while building this, and it changed the design: in a bound conversation a bare source text — and even a 6-char "把这段讲成人话" cue — produced an **empty answer** or an off-task "I am researching the codebase…", while the short request line answered correctly every time (55 chars, 22s cold; 29 chars, 32s on the bound conversation). So the **persona** goes out once and the **request line stays**: `translateBindConversation=false` restores the old always-self-contained form.

- **Fix(client): the hint is a body-level node BELOW the row — DSH's own portal shape.** Going above was the wrong cure: every other hint in the strip (copy, thumbs, branch) shows below, so alignment broke. The real difference is that DSH's tooltip is a portal: it is not a child of the scroller, so it can float over the composer instead of being clipped by it. Ours now matches that: one lazily-created singleton node appended to body, position: fixed, hidden by INLINE styles (so a stale stylesheet can still only mean "no hint", never leaked text), shown on hover/focus with the localized label and positioned BELOW the anchor (+6px, centred, clamped to the viewport; it flips above only at the viewport edge, which the composer cannot trigger). Verified in a browser with the shipped sheet: the layout that showed the bubble half-covered now renders it 6px under the row, fully inside the viewport, floating over the composer exactly like the primitive does.

- **Superseded in the same night: the hint briefly went ABOVE the row** (a data-tip-side flip, no longer in the code) to dodge the composer. It broke alignment with every other hint and is replaced by the body-level node above.

 Anchoring the bubble below the icon was right for matching DSH's own strip, but the affordance lives on the NEWEST reply — the row sits directly above the composer, and the bubble ended up half-hidden behind it. Above is now the default (and the no-script fallback); `placeTip` measures the row against its nearest scrollable ancestor on hover/focus and only flips below when there is less than one bubble of room up there, writing `data-tip-side` for the stylesheet to act on. Verified in a browser replicating the reported layout: the bubble renders above the row, fully inside the transcript, clear of the composer, with the DSH tokens unchanged.

- **Fix(client): the reply hint now uses DSH's own tooltip tokens.** The bubble was white-on-light with its own caret and sat above the icon, so it read as a foreign widget next to DSH's dark "有问题的回答" bubble. It now copies the primitive's own bubble verbatim — `--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00`, 13px/20px, `3px 7px`, `--dsw-radius-sm`, no caret, `.15s` fade-in, below the anchor and centred — so the action strip has exactly one tooltip look. Verified against the shipped primitive: computed background, colour, font-size, line-height, padding, radius and the anchor gap are identical.

- **Perf(context): tool payloads no longer crowd out the history digest (80/20).** A digest budget is spent by payloads, not by decisions: in this session's real context-transfer file, **91% of the 691 KB was `Tool result` bodies** (376 records, p90 ≈ 4 KB, max 40 KB) while asks and answers together were under 9%. Tool result lines are now middle-elided to 800 B by default (`elideMiddle`: head + `…[elided NB]…` + tail, so a command's verdict at the end still survives), tunable per call with `toolLineBytes`. Projected on that same file: 691 KB → ~236 KB (−66%) with every user ask, every assistant reply and the head+tail of every tool call retained; `toolLineBytes: 400` would land at ~163 KB (−76%).

- **Prompt(translate): one line instead of a style contract.** The six-rule prompt ("结论先行 / 去黑话 / 保留可执行信息 / 输出 Markdown…") made Gemini write a book report — headings, bullet lists, formal register — which is the opposite of "人话". It is now a single sentence asking for the same explanation you would give a colleague out loud, plus the three constraints that actually matter (plain words, keep the meaning, invent nothing). A long source gets one budget hint ("挑重点讲清楚") rather than a format mandate. Live check on a real 7,905-char structured reply: conversational prose in four short paragraphs, no headings, no lists.

- **Fix(translate): an empty model answer is now retried instead of failing the turn.** A live failure was diagnosed as agy/Gemini finishing with a clean `stop` and **no visible text at all** after ~25s (no error envelope, no max-tokens cut): the call was reported as a generic `AGY_ERROR`, so the bounded retry — which only covered account/transport failures — never re-asked, and the user just saw a failed translation. The runner now reports this case as its own `EMPTY_RESPONSE` code, includes the finish kind in the message and logs model/effort/duration to the host log, and the code joined the retryable set with a longer (~0.9s) back-off than an account stall. Verified live: the same reply that failed translated fine on a re-run (961 chars, 53s), so the condition is transient rather than prompt-specific.

### 中文

- **新增(翻译)：`/tsl` —— 用 Gemini 把会话输出改写成大白话，并固定显示在该回复下方。**
  - 统一入口 `TranslationService` 同时服务三个消费者：`/tsl` 命令、可选的"回合结束自动翻译"、以及每条回复上的「译成人话」按钮。模型调用走本插件自己的辅助通道（`purpose:'translation'`），复用同一账号池——**额度耗尽的账号会被冷却，重试自动落到下一个账号**，同时不绑会话、不暴露工具、不占并发槽。
  - 默认 `gemini-3.8-flash` · `high`（可配置，并有目录回退链）。结果以 `plugin:agy-link/translation` 记录持久化，渲染为「✨ Gemini 译文」卡片并**锚定在被翻译回复的正下方**：重载后仍在、可展开对照原文、永不进入模型可见历史。历史回合通过悬浮按钮按需生成同一张卡片。
  - 自动模式**默认关闭**（`autoTranslate`，设置 → Antigravity 开关，或 `/tsl auto on` 按会话覆盖）：只响应新的 `turn/end`，跳过翻译模型自己产出的回合，限制重复频率，翻译失败绝不影响 agent 主循环。
  - 适配器：`purpose:'translation'` 纳入辅助通道，但保留调用方显式档位（否则辅助调用会把 Gemini 钉在 `low`），且不受 `allowAuxiliary` 限制。

- **同版本内的客户端打磨。** 设置面板移除「权限模式」一行——权限模式固定 `skip`（仍可用配置 / `DSH_AGY_MODE` 覆盖，例如无头运行）。思考强度一行**保留**，改名为「默认思考强度」（`auto` / `low` / `medium` / `high`）：它决定 DSH 会话**模型下拉框**的初始档位（`defaultEffort` 默认 `high`，与 agy 的等级一一对应），下拉框本身仍可按模型临时切换。自动预热与自动翻译切换均采用原生分段胶囊按钮组（`[ 开启 | 关闭 ]`），与调度策略视觉统一，明确呈现默认关闭状态（关闭态高亮），杜绝歧义。

- **修复(client/host)：Gemini 翻译动作状态机闭环与真实 DSH 事件提取。** 翻译按钮状态机完整闭环：`idle`（Gemini 星形图标）→ `working`（**真正的 SVG 旋转 Loading 圆环态**，禁用重复点击并阻止事件冒泡）→ `done`（绿色对勾，卡片存在期间保持）/ `error`（红色重试警告，3 秒后复位），各状态附带专用提示文案。服务端 `sessionEvents()` 深度适配真实 DSH 会话的 `session.snapshotEvents()` / `session.ownEvents()`，`appendRecord()` 支持原生 `session.append()` 持久化通道，根治点击翻译报 `SESSION_UNAVAILABLE` 导致无反应的问题；若特定消息 ID 未能精确定位，自动平滑回退至最新已完结回合。

- **修复(client)：提示注记真的显示出来了，按钮状态也能跨重挂载存活。** 三条来自实机使用的问题：
  - **悬浮提示**：桌面壳内原生 `title` 气泡从不弹出（DSH 内部 `Tooltip` 基元也未对插件包开放），故动作自绘 CSS 提示。首版之所以把提示**当普通文字渲染在图标旁边**，根因是 `injectStyles()` 只要发现同名 style 标签就已存在便直接返回——插件热重载后旧样式表被保留，新增的 hover 规则从未生效，于是提示 `<span>` 退化成动作条里的一个文本节点。现在样式表会自愈（内容不一致即重写）、id 带版本号（`…-tsl-css-v2`），提示改由 `data-tip` 属性配合 `::after` 绘制、不再存在真实节点，因此**即使样式表缺失也只会"没有提示"，绝不会漏出文字**。因为动作条紧贴回复左缘，提示**向右展开**，避免被会话滚动容器裁切。已在浏览器中按"有样式 / 无样式"两种状态验证：有样式 hover 出深色气泡，无样式只剩干净图标行、没有任何多余文字。
  - **状态持久化**：窗口重获焦点时聊天时间线会重建面板，组件内状态曾导致转圈中途被打回 `idle`（"切窗口状态就消失了"）。现有状态放入模块级 Map + 在途 Set，且每次挂载都会通过新增的 `GET /plugins/agy-link/translate/state?session=&message=` 询问该回复是否已有持久化记录——因此**翻译完成后，切窗口、切会话乃至整页刷新都仍保留 ✓**，仍在跑的请求也会还原成转圈态而不是看起来没翻译过。翻译成功后保持 `done`（卡片本身是持久的），不再 2.5 秒后回退 `idle`；只有失败态会在 3 秒后回到可重试的 `idle`。

- **修复(issue #67)：模型拒绝 `--effort` 时不再让每一轮都失败。** agy 1.4.6（Windows）在给不支持的模型传 `--effort` 时会**拒绝整次调用**——`invalid model selection (… --effort "medium"): --effort is not supported for model "gemini-3.8-flash"`；而 fallback 目录（把 Gemini Flash 系列的 `low/medium/high` 标成**推测**）一旦生效，用户只要设了 `defaultEffort`，每轮请求都失败。现在档位支持改为**向 agy 学习**：从拒绝文本里解析出模型 id，把这次调用**原样重放一次、只是不带 `--effort`**（拒绝发生在任何输出之前，重放安全），并把该模型写进 `~/.dsh/agy-link/effort-unsupported.json`（重启后不再问）；同时**收回能力声明**——该模型不再发布 `reasoning.efforts`，会话模型菜单里的档位行会消失，而不是让用户选到一个必然被拒的档位。可在 `/plugins/agy-link/status` 的 `effortUnsupported` 与 `/agy doctor` 报告里看到（便于支持定位）。不变式：档位不兼容最多多花一个 agy 进程，**绝不让用户的一轮对话失败**。 一次性路径（`agy_ask`，直接 spawn agy）同样遵守这份学习结果；`runAgyOnce` 的失败信息改为优先取 result 信封里的 error，而不再是空洞的 `agy exited with code 1: `——这既是它原先学不到的根因，也顺带让 `agy_ask` 失败可诊断。

- **新增(translate)：每个 DSH 会话一条 agy 翻译会话（1:1），人格只发一次。** 以前每次翻译都是一次全新的、不绑定会话的 agy 调用，并重发整个指令块。现在翻译会话按 DSH 会话绑定为 `<sessionKey>#tsl`（与轮次会话同级的账号隔离，因此互不干扰，并继承冷却/重新播种机制），以 `--conversation`、`--mode plan` 运行，**工作目录 = 该会话的项目目录**。第一条消息带人格：身份（人话翻译器）、**DSH 会话 id**、该会话工作目录、**原始日志绝对路径**（`~/.dsh/sessions/*/session-<id>/session.*.jsonl.zstd`）与 `zstd -dc … | jq` 读法，以及一段有界摘要——agy 想知道更多可以自己去读。之后的翻译复用这条会话。
  - 实机验证过程中发现了一个改变设计的事实：在已绑定的会话里**只发原文**、甚至只发 6 个字的"把这段讲成人话"，agy 会给出**空回答**，或跑偏成"我正在研究代码库…"；而带上那一行短请求行，每次都立刻正确输出（冷启动 55 字/22 秒；复用会话 29 字/32 秒）。因此**人格不重发、请求行保留**；设 `translateBindConversation=false` 可回到旧的"每次自带完整指令"形态。

- **修复(client)：提示气泡改为挂到 body、显示在动作行下方——和 DSH 自己的 portal 同构。** 改成朝上是治错了病：这一栏里其它提示（复制、点赞、分支）都在下方，朝上就破坏了统一；真正的差别在于 DSH 的 tooltip 是 **portal**——它不是滚动容器的子节点，所以能浮在输入区之上，而不是被输入区盖住。现在照此实现：`<body>` 上一个懒创建的单例节点、`position: fixed`，默认由内联样式隐藏（因此样式表过期最多只会“没有提示”，绝不会漏出文字），hover/focus 时写入本地化文案并显示在锚点下方（+6px、水平居中、视口内收边；只有视口底边才会翻到上方，输入区不会触发）。已用浏览器 + 打包后的样式表复现原版式：原先被盖住一半的情形，现在气泡落在行下 6px、完整在视口内、像基元那样浮在输入区之上。

- **同一晚被取代的中间方案：气泡曾短暂改为朝上**（`data-tip-side` 翻转，代码中已不存在）以躲开输入区。它破坏了与其它提示的一致性，现由上面的 body 级节点方案取代。

 朝下虽然和 DSH 原生动作条一致，但入口就在**最新那条回复**上——动作行紧贴输入框，气泡于是被输入区遮了一半。现在默认朝上（也是脚本没跑到时的兜底）；`placeTip` 在 hover/focus 时把动作行与最近的可滚动祖先比较，只有上方不足一个气泡高（32px）才翻到下方，并把结论写进 `data-tip-side` 交给样式表。已用浏览器复现报告中的版式验证：气泡出现在行上方、完整落在会话区域内、不与输入区重叠，DSH 令牌不变。

- **修复(client)：回复提示气泡改用 DSH 自己的 tooltip 令牌。** 之前是白底浅色 + 自绘小尖角、还挂在图标上方，摆在 DSH 原生的深色「有问题的回答」气泡旁边一眼就是外来控件。现在**逐项对齐基元自身的样式**：`--dsw-alias-tooltip-bg` / `--dsw-static-neutral-bluish-00`、13px/20px、`3px 7px`、`--dsw-radius-sm`、无尖角、`.15s` 淡入，位于锚点正下方并居中——整条动作栏只剩一种提示外观。已对照打包后的基元实测：背景色、文字色、字号、行高、内边距、圆角与锚点间距完全一致。

- **性能(context)：工具输出不再挤占历史摘要（8:2 原则）。** 摘要预算实际是被"载荷"吃掉的，不是被"决策"吃掉的：本会话真实的 context-transfer 文件里，**691 KB 中有 91% 是 `Tool result` 正文**（376 条，p90≈4 KB，最大 40 KB），而提问+回答加起来不到 9%。现在工具结果行默认做"掐头去尾留两端"的中段省略（`elideMiddle`：头 + `…[elided NB]…` + 尾，命令末尾的结论依然保留），默认 800 B，可用 `toolLineBytes` 按调用调整。按同一份文件测算：691 KB → 约 236 KB（**−66%**），且每条用户提问、每条助手回答、每次工具调用的头尾都保留；若设 `toolLineBytes: 400` 则可到约 163 KB（−76%）。

- **提示词(translate)：从"风格契约"改成一句话。** 原先六条规则（结论先行 / 去黑话 / 保留可执行信息 / 输出 Markdown…）会让 Gemini 写成一份"工作报告"——标题、分点、书面腔，恰恰不是人话。现在就是一句话：像跟同事随口解释那样讲一遍，外加三条真正必要的约束（说大白话、别改原意、别编）。原文较长时只加一句"挑重点讲清楚"，不再规定格式。实机验证：对一条 7,905 字的真实结构化回复，输出是四段短句口语讲解，无标题无列表。

- **修复(translate)：模型返回空内容时不再直接判失败，而是自动重试。** 实机失败已定位：agy/Gemini 在约 25 秒后以**干净的 `stop` 收尾但一个字的正文都没输出**（既无错误信封，也不是 max-tokens 截断）。旧逻辑把它报成笼统的 `AGY_ERROR`，而重试白名单只覆盖账号/传输类失败，于是**根本不会重问**，用户只看到一次失败的翻译。现在该情形有自己的 `EMPTY_RESPONSE` 码：错误信息带上 finish 类型、host 日志记录 model/effort/耗时，并纳入可重试集，且退避时间（约 0.9 秒）比账号类排队更长。已用实机复现验证：同一条此前失败的回复重跑成功（961 字，53 秒），说明这是**偶发**而非提示词问题。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.100...v0.5.0

## 0.4.100 (2026-11-02)

### English

- **Fix(host): stop dropping reasoning text on tool turns; debounce the negative thought cache.** (thanks @Ronnoc, #65)
  - With `--input-format stream-json`, thought text is written asynchronously to agy's SQLite DB, so on turns that immediately call a tool the initial `text` step often found `null`, and `cache.checkedSteps` then cached that miss for 5 minutes — the model's thoughts never surfaced. The cache miss skip is now a 500 ms debounce, pending thought steps are retried when tool steps arrive, and `flushBannerOnlyThoughts()` appends late-arriving prose to the reasoning block before a tool cut / result envelope closes it. Also resolves conversation DB dirs from the real HOME for isolated pool accounts.

### 中文

- **修复(host)：工具轮不再丢弃思考正文；负缓存改为短去抖。**（感谢 @Ronnoc，#65）
  - `--input-format stream-json` 下思考正文异步写入 agy 的 SQLite，若回合立即调用工具，初始 `text` 步骤常读不到（null），而 `cache.checkedSteps` 会把这次未命中缓存 5 分钟，导致思考内容永远不显示。现未命中跳过改为 500ms 去抖、工具步骤到来时重试待定思考步骤，并在工具切分/结果信封关闭前用 `flushBannerOnlyThoughts()` 补写迟到的正文；同时支持从真实 HOME 解析池账号的会话 DB 目录。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.99...v0.4.100

## 0.4.99 (2026-10-31)

### English

- **Feat(toolview): unwrap Antigravity MCP meta-tools into native terminal/search cards.** (thanks @Ronnoc, #64)
  - External MCP tools are dispatched by agy through meta-tools (`call_mcp_tool` / `callMcpTool` / `mcp__<server>__<tool>`), so every MCP call previously rendered as one repetitive `call_mcp_tool` card with raw JSON. Host mirror presenters and Client toolviews now unwrap the inner invocation: terminal-ish tools (`ops_bash`, `sh`, `shell`, …) become native Terminal cards (`$ cmd`, cwd, exit code, timeout), glob/grep become Search cards, and other MCP tools show as `<server>: <tool>`. MCP text envelopes (`{content:[{type:'text',text}]}`) are cleaned. Adds tests (588+ passing).

### 中文

- **新增(toolview)：把 Antigravity 的 MCP 元工具拆包为原生终端/搜索卡片。**（感谢 @Ronnoc，#64）
  - 外部 MCP 工具由 agy 经元工具（`call_mcp_tool` 等）调度，此前所有 MCP 调用都退化成一个重复的 `call_mcp_tool` 原始 JSON 卡片。现 Host 镜像 Presenter 与 Client Toolview 都会拆包内层调用：终端类（`ops_bash`/`sh`/`shell`…）渲染为原生终端卡片（`$ cmd`、cwd、退出码、超时），glob/grep 渲染为搜索卡片，其它 MCP 显示 `<server>: <tool>`；并清理 MCP 文本信封。补充测试（588+ 通过）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.98...v0.4.99

## 0.4.98 (2026-10-30)

### English

- **Fix(client/mermaid): re-render a diagram after streaming settles instead of leaving the finished reply as a code block.**
  - A streaming reply rewrites its code block in place (React keeps the element and only replaces the text), so the scanner's `data-agy-mermaid` state survived every chunk. The first pass usually saw an incomplete mermaid prefix, failed to parse, and silently marked the block `fallback`; when the full text arrived the element was never rebuilt, so the block was skipped forever and stayed a plain `代码块` until the user switched sessions (which remounts the block and wipes the state — exactly the "切走再切回就显示了" symptom). The scanner now fingerprints the current source (`sourceSignature`) and remembers what it last attempted (`data-agy-mermaid-sig`); when the text changes it waits one quiet pass (`data-agy-mermaid-pending`, so intermediate stream prefixes are not rendered) and then renders the settled source. `renderInto()` also reschedules a scan on completion so a source change during an in-flight render is caught. Adds `mermaidScanAction`/`sourceSignature` regression tests (verified live: partial → full in place now ends `done` with an SVG).

### 中文

- **修复(client/mermaid)：流式回复结束后会自动重渲染图表，不再把已经完整的回复留成代码块。**
  - 流式输出会**原地改写**代码块（React 复用同一个元素、只替换文本），所以扫描器打的 `data-agy-mermaid` 状态会一直保留。第一遍扫描往往看到的是**不完整的 mermaid 前缀**，解析失败后被静默标成 `fallback`；等完整文本到达时元素并没有重建，于是永远跳过、一直显示成普通「代码块」——直到你切到别的会话再切回来（元素被重新挂载、状态被清空）才渲染，这正是“切走再切回就显示了”的现象。现在扫描器会给当前源码打指纹（`sourceSignature`）并记住上次尝试过的源码（`data-agy-mermaid-sig`）：源码变化时先等一个“安静”的扫描周期（`data-agy-mermaid-pending`，避免把流式中间态每个前缀都渲染一遍），确认稳定后再渲染完整内容。`renderInto()` 完成时也会补一次扫描，覆盖“渲染过程中源码又变了”的情况。新增 `mermaidScanAction`/`sourceSignature` 回归测试（已实测：partial → full 原地更新后最终 `done` 并出图）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.97...v0.4.98

## 0.4.97 (2026-10-30)

### English

- **Fix(pool): switching the active account ("设为当前使用" / set primary) now refreshes that account's model catalog and always re-announces the model picker, so the composer's cached list updates immediately (e.g. Gemini 4 Argon appears after switching to a Pro/Ultra account).**
  - `/pool/set-active` refreshed via `catalog.forceRefresh(id)` and relied on `ModelCatalog` emitting an update *only when the catalog contents changed*. But the composer model picker caches its snapshot and re-reads only on the `llm/adapters-updated` event, and the visible set also depends on the active account's plan (`listModels()` filters the Argon family). So switching to an account whose catalog happened to match the previous one left the picker showing the old models (Argon missing). Added `ModelCatalog.forceRefreshAndNotify()` — refresh the target account, then emit unconditionally — and wired it into `/pool/set-active`, `/pool/primary` and `/pool/reorder`; `enable`/`remove` now announce too. Adds a regression test (identical catalog still re-announces).

### 中文

- **修复(pool)：切换「设为当前使用」/主用账号后会刷新该账号的模型目录并强制重新广播，会话窗口的模型列表立即更新（切到 Pro/Ultra 账号后 Gemini 4 Argon 正常出现）。**
  - `/pool/set-active` 之前只调 `catalog.forceRefresh(id)`，且 `ModelCatalog` 仅在**目录内容发生变化**时才发更新事件；但会话模型选择器缓存快照、只在 `llm/adapters-updated` 事件后重读，而可见集还取决于当前账号的套餐（`listModels()` 会按账号过滤 Argon）。因此切到「目录恰好与之前相同」的账号时，选择器仍显示旧模型（Argon 不出现）。新增 `ModelCatalog.forceRefreshAndNotify()`（刷新目标账号后**无条件**广播），并接入 `/pool/set-active`、`/pool/primary`、`/pool/reorder`；`enable`/`remove` 也会广播。补充回归测试（目录未变也重新广播）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.96...v0.4.97

## 0.4.96 (2026-10-30)

### English

- **Fix(client/mermaid): serialize diagram rendering so multiple charts don't clobber each other and silently degrade to code blocks.**
  - `mermaid.render()` is not reentrant: it injects shared temporary nodes into `document.body`, and `renderInto()`'s post-render `cleanupTempElements()` sweeps all of them. When one scan pass found two or more diagrams at once (a long answer with several charts, or the first lazy load resolving for every already-pending block), concurrent renders removed each other's in-flight temp DOM — the losers threw and auto-sniffed blocks silently set `data-agy-mermaid="fallback"`, i.e. the diagram simply stayed a plain `代码块`. All renders now go through a single `enqueueMermaidRender()` promise chain so exactly one diagram is drawn at a time; a failing task never breaks the chain. Adds serialization regression tests (verified live: 4 concurrent generic fences now all render).
- **Fix(adapter): session-title calls keep their format constraints (forward the system prompt) and don't force plan mode.**
  - When DSH generates a session title (`options.purpose === 'session-title'`), the length/single-line/no-prefix constraints live in `options.system`, which was dropped (forwardSystemPrompt off, only review whitelisted), and aux calls were forced into `--mode plan` — chatty models then emitted conversational preambles that DSH stored verbatim as the title. Title calls now forward `options.system` and use `cfg.permissionMode` (no forced plan). Corrected from #63 (which used an invalid `'default'` mode); adds a regression test.

### 中文

- **修复(client/mermaid)：串行化图表渲染，避免一次扫描内的多个图表相互踩踏、静默降级成代码块。**
  - `mermaid.render()` 不是可重入的：它会向 `document.body` 注入共享的临时节点，而 `renderInto()` 渲染后的 `cleanupTempElements()` 会清扫全部这类节点。当一次扫描同时命中两个及以上图表（长回答里有多个图表，或首次懒加载对所有待渲染块同时 resolve）时，并发渲染会互相删掉对方正在用的临时 DOM——败者抛错，自动嗅探的块静默进入 `data-agy-mermaid="fallback"`，也就是图表没渲染、仍显示成普通「代码块」。现在所有渲染都经过单一 `enqueueMermaidRender()` promise 链串行执行，单个任务失败也不会中断整条链。新增串行化回归测试（已在真实客户端实测：4 个并发通用代码围栏全部渲染成功）。
- **修复(adapter)：会话标题调用保留格式约束（转发系统提示词）且不强制 plan 模式。**
  - 生成会话标题时，单行/无前缀等格式约束位于 `options.system`，此前被丢弃且 aux 调用被强加 `--mode plan`，导致模型输出客套前缀被原样当作标题。现标题调用转发 `options.system` 并使用 `cfg.permissionMode`（不再强制 plan）。实现修正自 #63（其使用了无效的 `'default'` 模式）；补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.95...v0.4.96

## 0.4.95 (2026-10-30)

### English

- **Fix(runner): stop Linux pool accounts from reading the desktop Secret Service (primary token) — isolate D-Bus per account.** (thanks @superwiboy, #62)
  - On Linux with a desktop session, agy's credential reader queries the OS Secret Service (gnome-keyring/secret-tool) before the isolated token file, so pooled sub-accounts silently used the primary account's token (primary quota drained, sub-accounts at 0 usage). `isolatedHomeEnv()` now sets `DBUS_SESSION_BUS_ADDRESS` to a nonexistent, **per-account private** path (`<home>/.no-dbus-session`), forcing agy to read only its slot token.
  - Hardening over the original patch: the dummy bus path is private to each isolated home instead of a shared world-writable `/tmp` path (which a local user could hijack by binding a fake bus socket). Adds `linuxDbusDisabledEnv()` + tests.

### 中文

- **修复(runner)：Linux 池账号不再穿透到桌面 Secret Service（读到主账号 token）——按账号隔离 D-Bus。**（感谢 @superwiboy，#62）
  - Linux 桌面会话下，agy 读取凭据时会先查系统 Secret Service（gnome-keyring/secret-tool），导致池内子账号静默使用主账号 token（主账号额度被耗、子账号 0 用量）。`isolatedHomeEnv()` 现在把 `DBUS_SESSION_BUS_ADDRESS` 指向一个不存在、且**每账号私有**的路径（`<home>/.no-dbus-session`），强制 agy 只读自己 slot 的 token。
  - 相较原补丁的加固：临时 bus 路径使用各账号私有 home，而非共享可写的 `/tmp` 路径（后者可能被本机其他用户伪造 bus socket 劫持）。新增 `linuxDbusDisabledEnv()` 及测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.94...v0.4.95

## 0.4.94 (2026-10-29)

### English

- **Security(media): block symlink escape in the static-asset route.**
  - `handleAssetRequest()` built the path with `join(assetDir, subPath.replace('\.\.',''))` and only checked `existsSync`. A symlink placed inside the asset dir that pointed outside it would be followed and served (any file type, e.g. a `.txt` with secrets). The route now canonicalizes with `realpathSync` and requires the target to stay inside the canonical asset dir (`403` otherwise). Adds a symlink-escape regression test.

### 中文

- **安全(media)：静态资源路由阻止符号链接逃逸。**
  - `handleAssetRequest()` 之前用 `join(assetDir, 去掉'..'的 subPath)` + `existsSync` 判断；若资产目录内放入一个指向外部的符号链接，会被跟随并对外提供（任意类型文件，如含密钥的 `.txt`）。现用 `realpathSync` 规范化并要求目标仍在资产目录内（否则 `403`）。补充符号链接逃逸回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.93...v0.4.94

## 0.4.93 (2026-10-29)

### English

- **Fix(oneshot): don't split a UTF-8 character when truncating an inlined file.**
  - `inlineFiles()` truncated a large text file with a raw byte slice (`buf.subarray(0, INLINE_MAX_BYTES)`), so if the 256 KiB boundary fell inside a multibyte character the prompt got a replacement char (`�`). Truncation now walks back to a UTF-8 code-point boundary (`truncateUtf8`). Adds a regression test that places a 3-byte char across the boundary.

### 中文

- **修复(oneshot)：截断内联大文件时不再把一个 UTF-8 字符切断。**
  - `inlineFiles()` 之前用裸字节切片（`buf.subarray(0, INLINE_MAX_BYTES)`），若 256 KiB 边界落在多字节字符中间，prompt 里会出现替换符 `�`。现截断回退到 UTF-8 码点边界（`truncateUtf8`）。补充把一个 3 字节字符跨边界放置的回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.92...v0.4.93

## 0.4.92 (2026-10-29)

### English

- **Fix(models): don't parse lowercase `error:`/`failed:` diagnostic lines into bogus model slugs.**
  - The two-column text fallback skipped rows starting with capital `Fetching`/`Error` only, so a lowercase `error:  …` / `failed:  …` line (two-space aligned) was parsed as a model with slug `error:`. The banner filter is now case-insensitive and also covers `failed`. Adds a regression test.

### 中文

- **修复(models)：不再把小写的 `error:`/`failed:` 诊断行解析成假模型条目。**
  - 两列文本回退只跳过首字母大写的 `Fetching`/`Error`，因此小写且以两空格对齐的 `error:  …`/`failed:  …` 会被解析成 slug 为 `error:` 的假模型。现 banner 过滤改为大小写不敏感并覆盖 `failed`。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.91...v0.4.92

## 0.4.91 (2026-10-29)

### English

- **Security(doctor): redact secret URL query parameters (`access_token`, `token`, `api_key`, …).**
  - `redactLine()` fully redacted accounts.google.com URLs but left secret-bearing query parameters on any other URL (OAuth callbacks, signed URLs) in the clear. Query keys `access_token/refresh_token/id_token/token/api_key/apikey/client_secret/key` are now masked as `<key>=<redacted>` while other query parameters are preserved. Adds a regression test.

### 中文

- **安全(doctor)：脱敏 URL 查询串中的密钥参数（`access_token`、`token`、`api_key` 等）。**
  - `redactLine()` 只整体脱敏 accounts.google.com 的 URL，其它 URL（OAuth 回调、签名链接）上的密钥查询参数会明文残留。现对 `access_token/refresh_token/id_token/token/api_key/apikey/client_secret/key` 统一掩码为 `<key>=<redacted>`，其它查询参数保留。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.90...v0.4.91

## 0.4.90 (2026-10-29)

### English

- **Fix(config): parse boolean env/plugin values case-insensitively (`TRUE`, `Yes`, `on`, …).**
  - `asBool()` only accepted the exact strings `true`/`1`, so `DSH_AGY_MCP_BRIDGE=TRUE` (or `Yes`/`on`) was silently ignored and fell back to the default — a common footgun for boolean env vars. It now trims + lowercases and accepts `true/1/yes/on` and `false/0/no/off`; anything else still falls back. Adds a regression test.

### 中文

- **修复(config)：布尔型 env/配置值大小写不敏感（`TRUE`、`Yes`、`on` 等）。**
  - `asBool()` 之前只认精确的 `true`/`1`，于是 `DSH_AGY_MCP_BRIDGE=TRUE`（或 `Yes`/`on`）被静默忽略、回落到默认值——布尔环境变量的常见坑。现 trim+小写后接受 `true/1/yes/on` 与 `false/0/no/off`，其它仍回落。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.89...v0.4.90

## 0.4.89 (2026-10-29)

### English

- **Fix(sessions): use a unique temp file for the atomic store write (multi-process safety).**
  - `SessionStore.persist()` wrote through a deterministic `".sessions.json.tmp"`. Web + headless host processes share one store, so two concurrent persists could interleave into the same temp file and race the rename — corrupting the store or failing a writer with `ENOENT`. Extracted `src/common/atomic-write.ts` (`writeFileAtomicSync`) which uses a per-write unique temp name (`<file>.<pid>.<seq>.<rand>.tmp`) and cleans it up on failure; sessions now uses it. Adds unit tests for uniqueness, no-residue, and failure cleanup.

### 中文

- **修复(sessions)：原子写改用每次唯一的临时文件（多进程安全）。**
  - `SessionStore.persist()` 之前用固定的 `".sessions.json.tmp"`。Web 与 headless 宿主进程共享同一个 store，并发写会写进同一个临时文件并竞争 rename——导致文件损坏或某个写入者 `ENOENT`。抽出 `src/common/atomic-write.ts`（`writeFileAtomicSync`），临时名每次唯一（`<file>.<pid>.<seq>.<rand>.tmp`），失败时清理；sessions 改用它。补充单测：唯一性、无残留、失败清理。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.88...v0.4.89

## 0.4.88 (2026-10-29)

### English

- **Security(media): add `X-Content-Type-Options: nosniff` and a CSP sandbox to served media/assets.**
  - The media and asset routes serve local image/SVG files from the DSH origin. They now send `X-Content-Type-Options: nosniff` (no MIME sniffing) and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so an operator-supplied SVG cannot execute scripts if opened/navigated directly. Adds header assertions to the media test.

### 中文

- **安全(media)：媒体/静态资源响应增加 `X-Content-Type-Options: nosniff` 与 CSP sandbox。**
  - 媒体与静态资源路由从 DSH 同源提供本地图片/SVG。现附加 `X-Content-Type-Options: nosniff`（禁止 MIME 嗅探）与 `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`，使运维提供的 SVG 即使被直接打开/导航也无法执行脚本。为媒体测试补充响应头断言。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.87...v0.4.88

## 0.4.87 (2026-10-29)

### English

- **Security(doctor): tighten existing diagnostics dir/file to 0700/0600 on every write.**
  - v0.4.86 set `mode` only at creation, so a pre-existing `diagnostics/` directory (0755 from an older version) stayed world-readable, and an overwritten report kept its old mode. `writeDoctorReport()` now `chmod`s the dir to `0700` and the file to `0600` after writing (best-effort). Adds a regression test.

### 中文

- **安全(doctor)：每次写入都把已存在的诊断目录/文件收紧到 0700/0600。**
  - 0.4.86 只在创建时设 `mode`，因此已存在的 `diagnostics/`（旧版本创建的 0755）仍可被他人读取，覆盖写同名报告也保留旧权限。现 `writeDoctorReport()` 写完后显式 `chmod` 目录为 `0700`、文件为 `0600`（best-effort）。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.86...v0.4.87

## 0.4.86 (2026-10-29)

### English

- **Security(doctor): write the diagnostic report owner-only (dir 0700, file 0600).**
  - `/agy doctor` wrote its (redacted) report with the default umask (typically 0644), so another local user could read config paths and any residual log text. The diagnostics dir is now `0700` and the report `0600`.
- **Docs(spec): add the spec index and the security-hardening invariants.**
  - `.spec/README.md` indexes the project's truth sources; `.spec/security-hardening.md` records the MCP bridge / HTTP / doctor / media / parser security invariants and the exact test that guards each one, so future changes cannot silently relax them.

### 中文

- **安全(doctor)：诊断报告改为仅本人可读（目录 0700、文件 0600）。**
  - `/agy doctor` 之前按默认 umask 写（通常 0644），同机其他用户可读到配置路径与残留日志。现目录 `0700`、报告 `0600`。
- **文档(spec)：新增 spec 索引与安全不变式文档。**
  - `.spec/README.md` 作为真相源索引；`.spec/security-hardening.md` 记录 MCP 桥接 / HTTP / doctor / media / parser 的安全不变式与对应测试，防止后续改动静默放宽。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.85...v0.4.86

## 0.4.85 (2026-10-29)

### English

- **Security(doctor): redact `Authorization: Basic`, `Cookie` and `X-Api-Key` headers.**
  - `redactLine()` only masked `Bearer …` tokens, so a doctor log line carrying `Authorization: Basic <base64>`, `Cookie:` / `Set-Cookie:`, or `X-Api-Key:` values landed in the report verbatim. All auth-carrying headers are now masked (`<name>: <redacted>`) while ordinary text is preserved. Adds a regression test.

### 中文

- **安全(doctor)：脱敏 `Authorization: Basic`、`Cookie`、`X-Api-Key` 等头。**
  - `redactLine()` 此前只处理 `Bearer …`，因此 doctor 日志中 `Authorization: Basic <base64>`、`Cookie:`/`Set-Cookie:`、`X-Api-Key:` 的值会原样落入报告。现将这些携带凭据的头统一脱敏为 `<name>: <redacted>`，普通文本不变。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.84...v0.4.85

## 0.4.84 (2026-10-29)

### English

- **Perf(parser): parse a multi-line chunk in O(n) instead of O(n²).**
  - `StreamJsonParser.feed()` walked the buffer with a `while` loop that re-sliced `this.buffer` on every newline — each slice copies the whole remainder, so a large chunk carrying many lines was quadratic in copied bytes. It now splits once (`split('\n')`, keep the torn tail), which is linear; behaviour (incl. `\r\n` stripping and torn-chunk buffering) is unchanged. Adds a large-single-chunk regression test.

### 中文

- **性能(parser)：多行 chunk 由 O(n²) 改为 O(n) 解析。**
  - `StreamJsonParser.feed()` 原来用 `while` 循环逐行 `this.buffer = this.buffer.slice(...)`，每次 slice 都会复制整个剩余缓冲，含大量行的大 chunk 呈平方级复制。现改为一次性 `split('\n')` 并保留未完成的尾部（线性）；`\r\n` 去除与断块缓冲等行为不变。补充「单个大 chunk」回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.83...v0.4.84

## 0.4.83 (2026-10-29)

### English

- **Fix(media): a malformed `file://` percent-escape no longer throws out of the media route.**
  - `resolveLocalMediaPath()` called `decodeURIComponent()` unguarded on the `file://` path. A double-encoded query (`?path=file%3A%2F%2F%2F%25E0...`) decodes to the literal `file:///%E0%A4%A`, whose inner decode throws `URIError: URI malformed` straight out of `handleMediaRequest()` (unhandled). Malformed escapes are now decoded via a safe helper that returns `null`, so the route answers `404` instead of throwing. Adds a regression test.

### 中文

- **修复(media)：畸形的 `file://` 百分号转义不再把异常抛出媒体路由。**
  - `resolveLocalMediaPath()` 对 `file://` 路径直接 `decodeURIComponent()`，未做保护。经双重编码的查询（`?path=file%3A%2F%2F%2F%25E0...`）解析出字面量 `file:///%E0%A4%A`，其内部解码抛出 `URIError: URI malformed` 并从 `handleMediaRequest()` 直接逃逸。现在改用安全解码助手，畸形转义返回 `null`，路由回 `404` 而非抛异常。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.82...v0.4.83

## 0.4.82 (2026-10-29)

### English

- **Fix(sessions): don't mis-purge live bindings whose session key contains `:`.**
  - `cleanupStaleAccounts()` split the binding key on the FIRST `:`. A DSH session id can itself be composite and contain `:` (as several plugins produce), so `ns:sess:acc_valid` parsed its "account id" as `sess:acc_valid`, which is never in the valid set — the cleanup then **deleted a live binding**. It now splits on the LAST `:` and only treats the suffix as an account id when it matches the pool shape `acc_<...>`, so colon-containing session keys are never mistaken for accounts. Adds a regression test.

### 中文

- **修复(sessions)：不再误删会话键本身含 `:` 的有效绑定。**
  - `cleanupStaleAccounts()` 之前按**第一个** `:` 切分绑定键。DSH 的会话 id 有可能本身是含 `:` 的复合键（部分插件如此），于是 `ns:sess:acc_valid` 被解析出的「账号 id」为 `sess:acc_valid`，永远不在有效集合里——清理逻辑因此**删掉了一个有效绑定**。现在改为按**最后一个** `:` 切分，且仅当后缀符合账号池形态 `acc_<...>` 时才当作账号 id，含 `:` 的会话键不会被误判为账号。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.81...v0.4.82

## 0.4.81 (2026-10-29)

### English

- **Fix(parser): bound a runaway un-newline-terminated stdout buffer.**
  - `StreamJsonParser.feed()` only split on `\n`, so a malformed/runaway stream that produced megabytes with no newline (or one giant partial line) grew the internal buffer without bound. A partial line over `MAX_STREAM_LINE_BYTES` (8 MiB) is now dropped and surfaced as a `garbage` event, keeping memory bounded; well-formed newline-delimited events are unaffected. Adds a regression test.

### 中文

- **修复(parser)：限制无换行结尾的超大 stdout 缓冲。**
  - `StreamJsonParser.feed()` 只按 `\n` 切分，若输出异常/失控产生数 MB 且不含换行（或一整条超长未完成的行），内部缓冲会无界增长。现在超过 `MAX_STREAM_LINE_BYTES`（8 MiB）的未完成行会被丢弃并以 `garbage` 事件上报，内存保持有界；正常的按行 NDJSON 事件不受影响。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.80...v0.4.81

## 0.4.80 (2026-10-29)

### English

- **Security(doctor): redact OIDC/JWT id_tokens and more provider secret shapes in `/agy doctor`.**
  - `redactLine()` already stripped `ya29.*`, `1//0…` refresh tokens, `AIza…` keys, `Bearer` headers, `4/` codes and proxy credentials, but a Google `id_token` (a JWT `header.payload.signature`), `sk-…` provider keys, and `GOCSPX-…` OAuth client secrets passed through verbatim when agy echoed them into the log ring buffer. All three are now redacted; ordinary text is preserved. Adds regression tests.

### 中文

- **安全(doctor)：`/agy doctor` 额外脱敏 OIDC/JWT id_token 及更多密钥形态。**
  - `redactLine()` 原本已脱敏 `ya29.*`、`1//0…` refresh token、`AIza…` key、`Bearer` 头、`4/` 授权码与代理凭证，但 Google `id_token`（JWT `header.payload.signature`）、`sk-…` 提供方密钥、`GOCSPX-…` OAuth client secret 在 agy 回显进日志环时仍会原样落入报告。现三类均已脱敏，普通文本保持不变。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.79...v0.4.80

## 0.4.79 (2026-10-29)

### English

- **Fix(mcp): never silently drop tools whose names collide after MCP normalization.**
  - `toMcpName()` maps any non-`[A-Za-z0-9_-]` character to `_`, so distinct DSH tools like `a.b` and `a_b` normalized to the same MCP name and the second was silently removed from `/tools` — hiding a real, possibly allowlisted, tool from the agent. Colliding names are now disambiguated with a stable `__<n>` suffix; `bridge.mjs` still calls back by the exact `_dshName`, so execution is unaffected. Adds a regression test.

### 中文

- **修复(mcp)：名称经 MCP 归一化后撞名的工具不再被静默丢弃。**
  - `toMcpName()` 会把非 `[A-Za-z0-9_-]` 字符替换成 `_`，于是 `a.b` 与 `a_b` 这类不同工具会归一化成同一个 MCP 名，第二个被从 `/tools` 静默删除，导致一个真实（且可能已加入 allowlist 的）工具对 agent 不可见。现在撞名会加稳定的 `__<n>` 后缀消歧；`bridge.mjs` 仍按精确 `_dshName` 回调，执行不受影响。补充回归测试。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.78...v0.4.79

## 0.4.78 (2026-10-29)

### English

- **Refactor(mcp/http): one bounded JSON body reader for every HTTP surface.**
  - Extracted `src/host/read-json-body.ts` and routed both the MCP bridge `/call` and all `/plugins/agy-link/*` web routes through it. Plugin payloads are tiny config JSON; the old unbounded buffer let any local client (including a prompt-injected agy child holding the bridge token) exhaust host memory by streaming a huge POST body. Bodies are now capped (1 MiB for plugin routes, 8 MiB for `/call`) and oversized ones are discarded. Adds focused unit tests for the reader (valid/malformed/array/oversized/stream-error).

### 中文

- **重构(mcp/http)：所有 HTTP 面共用同一个有界 JSON body 读取器。**
  - 抽出 `src/host/read-json-body.ts`，MCP 桥接 `/call` 与全部 `/plugins/agy-link/*` Web 路由统一走它。插件请求体都是很小的配置 JSON，此前的无界缓冲会让任意本地客户端（包括持有桥接 token、被提示词注入的 agy 子进程）用超大 POST body 打爆宿主内存。现在缓冲有上限（插件路由 1 MiB、`/call` 8 MiB），超限直接丢弃。为该读取器补充了针对性单测（正常/非法/数组/超限/流错误）。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.77...v0.4.78

## 0.4.77 (2026-10-29)

### English

- **Security(mcp): harden the loopback endpoint against a token-holding, prompt-injected child.**
  - **Bounded request body** — `/call` now caps the buffered body at 8 MiB and returns **413 `request body too large`** instead of buffering an unbounded payload, so a compromised/injected agy child cannot OOM the host process by streaming huge tool arguments.
  - **Constant-time bearer check** — the shared-secret token is compared with `crypto.timingSafeEqual` (length-guarded) rather than `!==`, removing the timing side-channel.

### 中文

- **安全(MCP)：加固 loopback 端点，防御持有 token、被提示词注入的子进程。**
  - **请求体上限**：`/call` 现在把缓冲上限设为 8 MiB，超限直接返回 **413 `request body too large`**，避免被攻陷/注入的 agy 子进程用超大工具参数把宿主进程内存打爆。
  - **常量时间 token 校验**：共享密钥改用 `crypto.timingSafeEqual`（先校验长度）比对，消除 `!==` 的时序侧信道。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.76...v0.4.77

## 0.4.76 (2026-10-29)

### English

- **Security(mcp): enforce `mcpToolAllowlist` at execution time, not just on `/tools`.**
  - `GET /tools` filtered the served set by `mcpToolAllowlist`, but `POST /call` accepted any tool name (except the internal `run_code`/`agy_ask`). The agy child holds the bridge bearer token, so a prompt-injected or compromised child could `POST /call` for a tool the operator never exposed (e.g. `bash`, `write`) and bypass the allowlist entirely. `/call` now returns **403 `tool not allowed`** for any tool outside a non-empty allowlist, and audit-logs it as `mcp call <tool> [denied: not in allowlist]`. Empty allowlist still means "all non-internal tools" (unchanged).
- **Security(mcp): stop exposing the internal `agy_tool` mirror over the bridge.**
  - The internal-tool filter only excluded `run_code`/`agy_ask`, so the activity-mirror tool `agy_tool` (which replays recorded agy tool activity back into DSH) was listed by `/tools` and executable via `/call` — letting the external agy child re-enter the bridge. The exclusion set is now centralized (`INTERNAL_TOOL_NAMES = run_code, agy_ask, agy_tool`) and enforced identically when listing and when executing, so the two can never drift.

### 中文

- **安全(MCP)：`mcpToolAllowlist` 现在在「执行时」强制生效，而不只是过滤 `/tools` 列表。**
  - 此前 `/tools` 按 allowlist 过滤，但 `POST /call` 只拦内部 `run_code`/`agy_ask`，任意工具名都会被真正执行。agy 子进程本身持有桥接 token，因此被提示词注入或攻陷的子进程可以 `POST /call` 调用运维并未暴露的工具（如 `bash`、`write`），完全绕过 allowlist。现在非空 allowlist 之外的 `/call` 一律返回 **403 `tool not allowed`**，并审计为 `mcp call <tool> [denied: not in allowlist]`。空 allowlist 仍表示「全部非内部工具」（行为不变）。
- **安全(MCP)：不再把内部的 `agy_tool` 镜像工具暴露给桥接。**
  - 内部工具过滤此前只排除 `run_code`/`agy_ask`，导致「活动镜像」工具 `agy_tool`（把 agy 记录的工具活动回放到 DSH）会被 `/tools` 列出、并可经 `/call` 执行，等于让外部 agy 子进程重新进入桥接。现将内部工具集合集中为 `INTERNAL_TOOL_NAMES = run_code, agy_ask, agy_tool`，在「列出」与「执行」两处统一生效，避免两处漂移。

**Full Changelog**: https://github.com/amlyczz/dsh-agy-link/compare/v0.4.75...v0.4.76

## 0.4.75 (2026-10-29)

### English

- **Fix(context-transfer): stop agy's 192,000-byte single-message cap from swallowing the live request.**
  - Measured on agy 1.4.9 (latest; no newer build fixes it): a SINGLE user message is silently truncated to **192,000 UTF-8 bytes** and the cut lands on the **TAIL** — ASCII 300,047 B → 192,000 B kept, CJK 490,864 B → 191,998 B kept, identical for `--input-format stream-json` and `text`. There is no flag, env var, or config key to raise it; the model's 1M window only applies across MANY messages.
  - The old first-contact prompt was `buildDigest(...) + livePrompt`, so an oversized history truncated away the `[end of conversation so far]` marker AND the user's newest question; the model then saw history only, treated the previous turn's instruction as current, and re-ran it (the "ignored my latest message" failure, twice).
  - The live request now leads the prompt (`wrapLiveRequest()` wraps it as `[CURRENT REQUEST …][/CURRENT REQUEST]`), so a tail cut can only discard background.
  - **Byte-aware budget**: `buildDigest(messages, fromIdx, maxChars, { maxBytes, maxLineBytes, includeTaskLine })` now trims by UTF-8 bytes (oldest turns dropped first, 40 KB per-line cap), never splitting a code point.
- **Feat(context-transfer): deliver oversized history as a file reference instead of inlining it.**
  - Above `contextTransferFileAboveBytes` the digest is written to `<stateDir>/context-transfer/<session>-<ts>.md`, the prompt keeps only the path, and the directory is exposed with `--add-dir` so agy pages through it with `read_file` — the first path that actually uses the model's 1M-token window. Verified live: a 368 KB .md was read and answered correctly from a 300 B prompt.
  - Sending guard: prompts over 180,000 B are tail-trimmed with a log line, so agy's silent truncation can never fire.
  - New config: `contextTransferMaxBytes` (150000), `contextTransferFileAboveBytes` (55000), `contextTransferFileMaxBytes` (2000000).
- **Test**: byte-ceiling digest, live-request-first assembly, file-referenced context transfer (3 new cases); `resolveConfig` proxy test now isolates `DSH_HOME` so its assertion no longer depends on the operator's real `runtime-overrides.json`.

### 中文

- **修复（上下文注入）：不再让 agy 的 192,000 字节单条消息上限吞掉当前提问。**
  - agy 1.4.9（已是最新，升级无解）会把**单条用户消息**静默截断到 **192,000 UTF-8 字节**，且**从尾部切**：ASCII 300,047 B → 保留 192,000 B；中文 490,864 B → 保留 191,998 B；`--input-format stream-json` 与 `text` 结果一致。没有 flag / 环境变量 / 配置键可调；1M 上下文只对**多条消息**生效。
  - 旧的首包拼法是 `buildDigest(...) + 当前提问`，历史一大就把 `[end of conversation so far]` 和用户最新提问一起切掉，模型只看到历史、把上一轮指令当新任务重做（“忽略我最新消息”两次事故的同一死法）。
  - 现在**当前请求前置**（`wrapLiveRequest()` 包成 `[CURRENT REQUEST …][/CURRENT REQUEST]`），尾截断最多只丢背景。
  - **字节预算**：`buildDigest` 新增 `{ maxBytes, maxLineBytes, includeTaskLine }`，按 UTF-8 字节裁剪（先丢最老轮次，单条 40KB 上限），且不切断多字节字符。
- **新增（上下文注入）：超长历史改为文件引用，不再内联。**
  - 超过 `contextTransferFileAboveBytes` 时把 digest 写入 `<stateDir>/context-transfer/<session>-<ts>.md`，prompt 只保留路径，并通过 `--add-dir` 暴露目录，让 agy 用 `read_file` 分页读取 —— 这是真正吃满 1M 上下文的路径。实测：368 KB 的 .md 由 agy 读取后正确回答，prompt 仅 300 B。
  - 发送前兜底：超过 180,000 B 的 prompt 裁尾并记日志，永不触发 agy 的静默截断。
  - 新增配置：`contextTransferMaxBytes`(150000)、`contextTransferFileAboveBytes`(55000)、`contextTransferFileMaxBytes`(2000000)。
- **测试**：字节上限 digest、当前请求前置装配、文件引用上下文（新增 3 例）；`resolveConfig` 代理测试改为隔离 `DSH_HOME`，不再依赖运维机器上真实的 `runtime-overrides.json`。

## 0.4.74 (2026-10-28)

### English

- **Feat(warmup): opt-in 7-day weekly quota auto-warmup and manual pre-warming (PR #60).**
  - `WarmupService` activates an idle account's weekly reset timer with a minimal `loadCodeAssist` + one-token `generateContent` probe, only when the weekly bucket is explicitly full and its reset instant has passed (or the bucket is genuinely cold).
  - Adds "Warmup" buttons to the account card and console header. `autoWarmup` (env `DSH_AGY_AUTO_WARMUP`) defaults to **false**: enabling it scans every 5 minutes with 1.5–3s jitter, a 30-minute failure backoff, and skips accounts in cooldown / auth quarantine.
  - Hardened before release: a missing `weeklyFraction` is treated as unknown (never 100%), `cloudaicompanionProject` accepts both string and `{id}` shapes and never falls back to a foreign project id (the old `bamboo-precept-lgxtn` fallback produced 403s), malformed request bodies can no longer fan out to all accounts, and the scheduler cannot overlap itself.
- **Fix(mcpBridge): pass the required abort signal to bridged tool calls (PR #57).**
  - Every bridged `/call` creates an `AbortController`, passes `signal` to `tools.execute()` (DSH declares it required; tools reading `exec.signal` previously died with `Cannot read properties of undefined (reading 'aborted')`), and aborts when the MCP client goes away.
  - Session keys resolve in both shapes: `session-<uuid>` for top-level web sessions and bare `<uuid>` for sub-agent/fork sessions. A resolvable bare id is never rewritten; only a miss retries with the `session-` prefix.
- **Feat(mcpBridge): audit-log every bridged call (PR #58).**
  - Each `/call` logs `mcp call <tool> [<outcome>] <ms>` through the plugin logger (journald), with the caller class and failure text. Arguments are never logged.
- **Docs(mcpBridge): DSH `send_message` can be bridged (PR #58, issue #59).**
  - `send_message` is not restricted: add it to `mcpToolAllowlist` and call it explicitly on the `dsh-tools-<port>` MCP server. The DSH sub-agent footer names agy's native tool, which cannot resolve DSH agent ids — root cause is upstream in `@deepseek-ai/dsh-subagent`; `agent_teams_send_message` remains the reliable path for agy members.
- **Fix(client): isolate the console overlay to eliminate scroll flicker at the root.**
  - The Antigravity console is a full-viewport overlay that neither froze the page behind it nor suspended the plugin's global DOM scanners, and its backdrop carried a full-viewport `backdrop-filter: blur()`. Every frame of motion behind it (wheel/inertia scrolling, the modal's 3s status polling, scanner DOM injection) was re-sampled through the GPU filter and re-laid-out → the recurring "打开控制台后滚动闪屏" root cause.
  - Removed the full-viewport backdrop blur (stable `rgba` dim instead), added an explicit overlay-isolation contract (`agyModalStore.setOpen()` toggles `html.agy-modal-open`, which locks `[data-conversation-scroll]` with `overflow:hidden` and contains overscroll), and routed decisions/images/reasoning/mermaid scanners through `isInteractionLocked()` (scroll OR overlay) with a catch-up scan on resume and cleanup on teardown.
  - Regression tests pin the contract: no full-viewport `backdrop-filter`, the scroller is locked while the overlay is open, and all four scanners gate on `isInteractionLocked()`.

### 中文

- **新增（warmup）：7 天周配额自动预热与手动预热（opt-in，PR #60）。**
  - `WarmupService` 只在周额度明确满额且已到重置时间（或确实处于冷启动）时，发送一次极小的 `loadCodeAssist` + 单 token `generateContent` 探活，提前激活 7 天计时器。
  - 账号卡片与顶栏新增「预热」按钮。`autoWarmup`（环境变量 `DSH_AGY_AUTO_WARMUP`）默认 **false**；开启后每 5 分钟巡检一次，带 1.5–3s 随机抖动、30 分钟失败退避，并跳过冷却中/需重新认证的账号。
  - 发版前加固：缺失 `weeklyFraction` 一律视为未知（不再当成 100%）；`cloudaicompanionProject` 同时兼容字符串与 `{id}` 结构，且不再回退到外部共享 project id（旧的 `bamboo-precept-lgxtn` 回退会 403）；畸形请求体不会触发全账号预热；调度器不会自我重叠。
- **修复（mcpBridge）：为桥接工具调用补上必需的 abort signal（PR #57）。**
  - 每次桥接 `/call` 创建 `AbortController`，把 `signal` 传给 `tools.execute()`（DSH 声明为必填；此前读取 `exec.signal` 的工具会抛 `Cannot read properties of undefined (reading 'aborted')`），并在 MCP 客户端断开时中止。
  - 会话 key 两种形态都能解析：顶层 Web 会话为 `session-<uuid>`，子代理/fork 会话为裸 `<uuid>`；能直接解析的裸 id 绝不会被改写，只有未命中时才重试 `session-` 前缀。
- **新增（mcpBridge）：每次桥接调用记审计日志（PR #58）。**
  - 每次 `/call` 通过插件日志（journald）输出 `mcp call <工具> [<结果>] <毫秒>`，含调用方类别与失败信息，**不记录参数**。
- **文档（mcpBridge）：DSH 的 `send_message` 可被桥接（PR #58，issue #59）。**
  - `send_message` 不受限制：把它加进 `mcpToolAllowlist`，在 `dsh-tools-<port>` 这个 MCP server 上显式调用即可。DSH sub-agent footer 指向的是 agy 原生工具，无法识别 DSH agent id——根因在 `@deepseek-ai/dsh-subagent` 上游；agy 成员仍应使用 `agent_teams_send_message` 上报。
- **修复（client）：从根因消除「打开 Antigravity 控制台后滚动闪屏」。**
  - 控制台是全屏浮层，却既没有冻结背后页面，也没有暂停插件自身的全局 DOM 扫描器，且遮罩带全屏 `backdrop-filter: blur()`。浮层背后的一切移动/重绘（滚轮/惯性滚动、控制台每 3s 状态轮询、扫描器注入）都会每帧被 GPU 滤镜重新采样并重新布局 → 即闪屏根因。
  - 移除全屏遮罩模糊（改用稳定的 `rgba` 半透明遮罩）；建立显式「浮层隔离契约」：`agyModalStore.setOpen()` 切换 `html.agy-modal-open`，锁定 `[data-conversation-scroll]`（`overflow:hidden`）并阻断滚动链；decisions/images/reasoning/mermaid 四个扫描器统一走 `isInteractionLocked()`（滚动中或浮层打开），关闭后补扫一次，卸载时清理锁类。
  - 回归测试锁定契约：全屏遮罩不得再出现 `backdrop-filter`、浮层打开时滚动容器必须锁定、四个扫描器必须走 `isInteractionLocked()`。

## 0.4.73 (2026-10-27)

### English

- **Fix(digest): preserve chronological order in conversation digest and prevent latest task misplacement.**
  - `buildDigest()` previously placed the latest user task at the top of the digest array before appending older history (`kept.push(taskLine)` followed by `kept.push(...keptOther)`), completely inverting the digest timeline. Agy received the newest request at the beginning of the context and the previous turn's request/response at the bottom, leading the model to treat the previous turn as the freshest instruction and ignore the new request.
  - Corrected assembly order so historical messages precede the latest task (`[...keptOther, taskPart]`) while preserving priority budget reservation for the latest task.
- **Fix(sessions): prevent false-positive compaction detection from dropping healthy conversation bindings.**
  - `adapter.ts` previously invalidated the session binding whenever `messages.length < binding.lastMessageCount`. Minor fluctuations in message counts (e.g. 1-2 messages dropped by telemetry filtering or message store pruning after reconnection) falsely triggered compaction detection, deleting the valid agy session binding and forcing an unnecessary full-context digest re-seed.
  - Introduced threshold-based compaction detection: true compaction requires substantial history reduction (e.g. drop by >20% or down to <=4 messages), while minor fluctuations only adjust the message watermark without invalidating the agy conversation.

### 中文

- **修复（digest）：修复会话摘要时间线逆序导致的“最新任务被历史覆盖/失忆”缺陷。**
  - 此前 `buildDigest()` 为给最新用户任务预留空间，先将任务推入数组首位，再追加其余历史记录（`kept.push(taskLine)` 后跟 `kept.push(...keptOther)`），导致摘要内部时间线颠倒：最新任务被排在最开头，而上一轮的指令与回复出现在历史摘要最末尾。agy 接收后将末尾上一轮历史误判为最新要求，进而忽略了用户的最新输入。
  - 修正组装顺序，保证早期历史在前、最新任务在后（`[...keptOther, taskPart]`），同时保留优先为最新任务分配字符配额的设计。
- **修复（sessions）：消除 Compaction 压缩检测假阳性，防止健康会话绑定被误删。**
  - 此前一旦 `messages.length < binding.lastMessageCount` 即判定为历史压缩并清空绑定。当会话闲置重新激活时，遥测过滤或消息存储微调导致的消息数微小减少（如减少 1~2 条）会误触发该逻辑，彻底删除原有的 agy 会话绑定并退化为全量摘要重放。
  - 引入梯度阈值判定：仅在历史大幅度缩减（如减少超 20% 或缩减至 4 条以下）时才判定为 Context Compaction，微小消息变动仅校准水位标尺，避免误断开底层长会话。

## 0.4.72 (2026-10-27)

### English

- **Fix(mcpBridge): publish MCP config to the agy 1.4+ registry and carry caller identity (Issue #55, PR #56).**
  - `writeMcpConfig()` previously wrote `<workspace>/.mcp.json`, but `agy` 1.4+ loads MCP servers exclusively from `~/.gemini/config/mcp_config.json` (and per-account `.gemini` sandboxes), causing bridged tool calls to fail with `No MCP servers configured`.
  - Added multi-target publishing supporting the global registry, isolated account homes, and workspace scopes (`mcpConfigScope: 'global' | 'workspace' | 'both'`, plus `mcpConfigPath` override).
  - Port-keyed entries (`dsh-tools-<port>`) prevent collisions between multiple DSH hosts sharing the registry, with clean atomic LIFO restoration on disposal.
  - Exported `DSH_MCP_SESSION` to the agy child process and forwarded it as `X-DSH-Session` to resolve the calling agent, fixing `agent_teams tools require a calling agent (exec.agent was undefined)`.
- **Fix(credential-slot): eliminate line-barging and concurrent holder race condition in `AsyncMutex`.**
  - Identified and resolved a critical race condition where releasing the mutex dropped `holders` to 0 before the scheduled microtask ran, allowing synchronous callers to barge ahead and grant multiple concurrent holders simultaneously.
  - Implemented direct ownership handoff without dropping holder count when waiters are queued, guaranteeing strict mutual exclusion and FIFO queueing under high concurrency.
- **Fix(client): eliminate session console first-open flicker.**
  - Session status badge now claims primary modal host synchronously on mount, preventing asynchronous portal remount flicker.
  - Status polling now gracefully relaxes to a 15s interval when idle to keep the cache warm, with complete timer cleanup upon client context disposal.
- **Fix(mermaid): prevent Dagre 0x0 / 16x16 collapsed SVG artifacts.**
  - Render Mermaid diagrams without an unattached mount container so viewport metrics measure accurately, and detect/heal empty or collapsed SVGs.
- **Fix(keychain): provision isolated macOS Keychain on account creation.**
  - Automatically provisions isolated login keychains when adding account slots or committing staging accounts on macOS, avoiding SecurityAgent system prompts.

### 中文

- **修复（mcpBridge）：发布 MCP 配置至 agy 1.4+ 实际读取的注册表并携带调用者身份（Issue #55，PR #56）。**
  - 此前 `writeMcpConfig()` 仅写入工作区 `.mcp.json`，而 `agy` 1.4+ 仅从 `~/.gemini/config/mcp_config.json`（及子账号 `.gemini` 沙箱）加载 MCP 服务，导致会话提示 `No MCP servers configured`。
  - 支持多目标发布（全局注册表、多账号隔离主目录及工作区范围，提供 `mcpConfigScope: 'global' | 'workspace' | 'both'` 及 `mcpConfigPath` 覆盖配置）。
  - 每个桥接实例按端口隔离服务键名（`dsh-tools-<port>`），防止多实例覆盖，并在退出时原子化恢复原有内容。
  - 会话生成时将 `DSH_MCP_SESSION` 注入子进程环境，经由桥接脚本转发为 `X-DSH-Session` 请求头，在宿主端通过 `agents` 服务解析调用者身份，彻底解决 `agent_teams tools require a calling agent (exec.agent was undefined)`。
- **修复（credential-slot）：消除 `AsyncMutex` 的插队竞争与并发持有者缺陷。**
  - 对抗性审计发现：旧实现中 `releaseOne()` 先将 `holders` 归零后通过 `queueMicrotask` 唤醒等待者，在此微任务微小窗口内同步调用的 `acquire()` 会发生插队并导致两个调用者同时进入临界区。
  - 改造为排队时直接所有权移交机制（Direct Handoff），保证严格互斥与 FIFO 先入先出顺序，消除测试套件偶发的 flake。
- **修复（client）：消除控制台首次打开时的宿主交接闪烁。**
  - 会话状态角标在挂载时同步声明主宿主身份，消除异步交接导致的状态闪烁与 Portal 重新渲染。
  - 状态轮询在无激活视窗时平滑降频至 15 秒保活缓存，并在客户端插件卸载时完整清理定时器。
- **修复（mermaid）：修复离屏/虚拟容器中 Dagre 测绘产生的 16x16 / 0x0 折叠 SVG。**
  - 避免将尚未有几何尺寸的容器传递给 Mermaid 渲染，结合 `isInvalidOrCollapsedSvg` 智能识别并修复空图或折叠伪影。
- **修复（keychain）：在 macOS 账号槽位创建与提交时即时初始化独立 Keychain。**
  - 避免 macOS SecurityAgent 在后续刷新凭据或打开终端时弹出系统钥匙串确认弹窗。

## 0.4.71 (2026-10-27)

### English

- **Fix: restore Argon quota reporting for isolated Pro-tier accounts (PR #54 regression).**
  - PR #54 established that retrieveUserQuotaSummary with the agy User-Agent returns the separate Gemini 4 Argon quota group for accounts on paid Pro/Ultra plans.
  - Removed premature clearQuotaFamily(account.id, 'argon') in readCliUsageFamilies fast-reject branches, allowing isolated accounts to receive authentic Argon quota from Google's REST API.
  - Stale/orphaned Argon entries on free-tier accounts are now cleared cleanly when an authoritative summary (CLI or REST) succeeds without an Argon quota group.
- **Feat(quota): organic randomized jitter on sequential multi-account polling.**
  - Replaced the fixed 2000ms sleep between account checks with an organic 2000ms~3500ms randomized jitter delay (staggerJitterMs), avoiding rigid clock-tick request signatures against upstream endpoints.
- **Fix: every pool row displayed the same account's quota (2026-10-26 report).**
  - Root cause: agy resolves its credential from the platform keystore (Windows Credential Manager, macOS Keychain, Linux Secret Service) BEFORE the per-HOME token file, and that store is a single per-user entry. Handing an isolated HOME to agy -p /usage therefore does not isolate the identity — the CLI always answers for the store's owner, so CLI-first polling filed the owner's numbers under every secondary row (all four rows showed 97% / 55% / 56% with identical reset instants).
  - The CLI is now scoped to the account that can actually own that store, and everything else takes the REST path, which signs with each account's own token file and runs concurrently on every platform.
  - Isolated accounts are rejected BEFORE any keystore read, so a poll no longer pays a PowerShell cold start per account; the owner itself is still proven by sameCredentialGrant, because a running secondary temporarily holds the slot and a CLI read would then return that secondary's numbers.

### 中文

- **修复：恢复子账号（如 Pro 订阅账号）的 Argon 额度显示（PR #54 回归）。**
  - PR #54 证明了发送 agy User-Agent 时，Google REST API retrieveUserQuotaSummary 会正常返回 Pro/Ultra 账号独立的 Gemini 4 Argon 额度组。
  - 移除了 readCliUsageFamilies 快速拒绝分支中对 argon 的误清理，子账号回落走 REST 时可完整展示其真实的 Argon 额度。
  - 免费账号或降级账号上残留的伪 Argon 额度，现在由权威汇总（CLI 或 REST 成功返回且不含 Argon 组）统一精准清理。
- **功能（quota）：多账号顺序轮询增加有机随机抖动。**
  - 账号间的固定 2000ms 错峰间隔升级为 2000ms~3500ms 随机抖动（staggerJitterMs），避免向 Google Cloud Code 发送过于机械刻板的定频网络请求。
- **修复：号池每一行都显示了同一个账号的额度（2026-10-26 反馈）。**
  - 根因：agy 解析凭据时**优先读系统钥匙串**（Windows 凭据管理器 / macOS Keychain / Linux Secret Service），且该存储是「每个 OS 用户只有一条」。因此给 agy -p /usage 一个隔离 HOME 并不能隔离身份——CLI 永远回答存储主人的额度，CLI 优先轮询就把主人的数字写进了每个子账号行（四行全部 97% / 55% / 56%，重置时刻完全相同）。
  - 现在 CLI 只用于「真正能拥有该存储」的那个账号，其余账号全部走 REST —— 用各自的 token 文件签名，全平台并发执行。
  - 隔离账号在**读取钥匙串之前**就被快速拒绝，轮询不再为每个账号付一次 PowerShell 冷启动；持有者本身仍要过 sameCredentialGrant 校验，因为子账号运行期间会临时占用该槽，此时 CLI 会返回子账号的数字。

## 0.4.70 (2026-10-25)

### English

- **Fix: the 5-hour quota row showed the weekly numbers (2026-10-22 report).**
  - `fetchAvailableModels` returns a per-model `quotaInfo` with NO window label. For some accounts it carries the 5-hour bucket, for others the WEEKLY bucket: live `daoxzeex@gmail.com` reported `0.1736 / reset 2026-10-24T18:19:18Z` on every Gemini model, which is exactly the weekly bucket of `retrieveUserQuotaSummary`.
  - The merge took "the lowest remaining across all sources" and filed it into the family 5-hour slot, so the GUI painted `5-hour quota 19% / Weekly 19%` with the SAME weekly reset on both rows (the filed screenshot) while the account actually had 82% of its 5-hour quota left.
  - The reset instant now decides the window (`sameQuotaWindow`, 5-minute tolerance): a reading that matches the summary weekly reset tightens ONLY the weekly row; one that matches the 5-hour reset tightens the 5-hour row; an unmatchable reading keeps the old conservative behaviour. Eligibility is unchanged — the weekly row still drives the 5% drain check.
- **Fix: a queued turn no longer looks frozen for 15 minutes.**
  - Windows has ONE machine-global agy credential slot, so sessions serialize: a healthy long run in one workspace made two other sessions sit with a completely empty transcript for `dispatchTimeoutMinutes` (15m) and then silently re-queue for another cap — indistinguishable from a hang (2026-10-22: the promo-tcn sessions, while a 15-minute run in another project held the slot).
  - The wait now streams a session-visible `[agy] waiting for the agy credential slot …` line into the transcript, with an escalating cadence (20s → 60s → 3m → 9m) so even a 15-minute queue leaves a handful of lines. Re-queues after a cap are announced too.
  - A generator abandoned while waiting (Stop / stream closed) now hands a late grant back instead of leaking a concurrency slot.
- **Fix: the machine-wide credential slot is held only until agy has READ it — different accounts now run concurrently.**
  - Measured on agy 1.4.3 with a live 14-minute run: print mode resolves its credential ONCE at startup (`printmode.go:403 "not authenticated, trying silent auth"` → `:405 "silent auth succeeded"` at +3.2s) and performs zero further token/auth work for the rest of the run. Holding the Windows slot for the whole run was pure serialization, and it is what parked the 2026-10-22 promo-tcn sessions for 15 minutes behind another project's run.
  - `armSlotHandoff` releases the lease on the child's FIRST output line (45s ceiling for a slow startup, run-end fallback, idempotent), while the identity is still installed under the mutex immediately before each spawn — so a later switcher cannot change what an already-started run read.
  - `JETSKI_OAUTH_TOKEN` (the only env-based credential route in the binary) was probed with a bogus token: the run still authenticated from the keyring, so true per-process injection remains unavailable upstream. Recorded in KNOWN-GAPS with the measurement.
- **Fix: a rejected credential-slot write now refuses the run instead of billing the account that happens to be installed.**
  - The Windows write is a PowerShell cold start that compiles a C# P/Invoke shim; its old 8-second ceiling made it time out and return `false` **without touching the slot** on a loaded machine (reproduced 2026-10-23: delete then write reported false and left the slot empty). All four install sites ignored that boolean, so the next spawn authenticated as the PREVIOUS account — silent cross-account quota spend, the exact corruption class the module exists to prevent.
  - Install sites now verify the write (one retry, then `SlotUnavailableError` → the turn fails visibly); teardown/restore paths log loudly instead of failing a finished turn. Writes get a 30s ceiling; reads stay at 8s because they sit on the poll path.
  - New test: a write that always reports false refuses the run, leaves the slot untouched and does not leak the mutex.

### 中文

- **修复：5 小时额度行显示成了周额度（2026-10-22 反馈）。**
  - `fetchAvailableModels` 的 per-model `quotaInfo` 不带窗口标签：有的账号返回 5 小时桶，有的账号返回**周**桶（实测 `daoxzeex@gmail.com` 每个 Gemini 模型都返回 `0.1736 / reset 2026-10-24T18:19:18Z`，正是 `retrieveUserQuotaSummary` 里的周桶）。
  - 旧合并逻辑「取所有来源里最低的余量」把它塞进了 5 小时行，界面于是显示 `5 小时额度 19% · 周额度 19%`、两行 reset 完全相同（反馈截图），而该账号 5 小时其实还剩 82%。
  - 现在由 reset 时刻判定窗口归属（`sameQuotaWindow`，5 分钟容差）：命中周 reset 的读数只收紧周行；命中 5 小时 reset 的收紧 5 小时行；无法判定的读数保持原有保守行为。可用性判定不变——周行依旧参与 5% 耗尽检查。
- **修复：排队中的回合不再看起来卡死 15 分钟。**
  - Windows 只有一个全局 agy 凭据槽，会话之间必须串行：另一个工作区一次正常的长任务就能让其它会话的转录区**整整 15 分钟一片空白**（`dispatchTimeoutMinutes`），随后再静默重排一轮——和卡死无法区分（2026-10-22 的 promo-tcn 两个会话就是被另一个项目 15 分钟的运行挡住）。
  - 等待期间现在会向会话流里写入可见的 `[agy] 正在等待 agy 凭据槽 …` 提示，节奏递增（20s → 60s → 3m → 9m），15 分钟排队也只留几行；超时重排同样会写明。
  - 等待中被 Stop / 关流放弃的请求，现在会把迟到的许可归还，而不是漏掉一个并发槽。
- **修复：全局凭据槽只占用到 agy 读完凭据为止——不同账号现在可以真正并发。**
  - 实测 agy 1.4.3 一次 14 分钟的运行：print 模式只在启动瞬间解析一次凭据（`printmode.go:403` 未认证 → `:405` silent auth 成功，+3.2 秒），之后 14 分钟**再无任何 token/auth 操作**。把 Windows 全局槽占满整个 run 纯属多余串行——2026-10-22 的 promo-tcn 两个会话正是被另一个项目那 14 分钟的运行堵了 15 分钟。
  - 新增 `armSlotHandoff`：在子进程输出**第一行**时立刻交还租约（启动慢则 45 秒上限、run 结束兜底、幂等），而身份安装依旧在每次 spawn 前、在互斥锁内完成，因此后来的切换不可能改变已启动 run 读到的凭据。
  - 二进制里唯一的进程级凭据入口 `JETSKI_OAUTH_TOKEN` 已用假 token 实测：仍然从系统 keyring 认证成功，说明上游还不支持真正的进程级注入；该结论连同测法已写入 KNOWN-GAPS。
  - 补充实测：**把全局凭据条目删掉后，agy 确实会改读家目录凭据文件**（假 token → `UNAUTHENTICATED 401`）。但 keyring 在写入侧同样优先（`Failed to save token to keyring, falling back to file`），任何一次成功运行都会把全局条目写回来，所以"永久空槽 + 纯文件隔离"仍不成立；凭据隔离目前只是读取侧能力。
- **修复：凭据槽写入被拒绝时，拒绝启动，而不是用"当前碰巧装着"的账号去计费。**
  - Windows 侧写入是一次 PowerShell 冷启动（Add-Type 编译 C# P/Invoke），旧实现的 8 秒上限在机器繁忙时会**超时并返回 false，而槽位根本没被改动**（2026-10-23 实测：删除后再写入返回 false，槽位保持空）。四个安装点都没检查这个布尔值，于是紧接着的 spawn 会以**上一个账号**的身份认证 —— 静默跨账号扣额度，正是本模块要防的那类污染。
  - 现在安装点会校验写入（失败重试一次，仍失败则抛 `SlotUnavailableError`，让这一轮可见地失败）；收尾/恢复路径改为大声告警而不毁掉已完成的轮次。写入超时提到 30 秒，读取保持 8 秒（在轮询路径上）。
  - 新增测试：写入恒返回 false 时必须拒绝运行、槽位保持原状、互斥锁不泄漏。

## 0.4.69 (2026-10-23)

### English

- **Feat: Google risk-control hardening and CLI-first quota architecture.**
  - Implemented CLI-first quota detection via official `agy -p /usage`: 100% genuine Go TLS fingerprint and client handshake, eliminating Node.js-level direct REST calls (`v1internal:retrieveUserQuotaSummary`) that trigger JA3/JA4 fingerprint mismatch warnings.
  - Purged internal test endpoints (`daily-cloudcode-pa.sandbox.googleapis.com` and `autopush-cloudcode-pa.sandbox.googleapis.com`) from `AGY_ENDPOINTS` to prevent sandbox probe alarms on consumer accounts.
  - Token refresh is fully delegated to the native `agy` CLI Go runtime; Node.js host process no longer issues direct refresh requests to `oauth2.googleapis.com/token`.
  - Background quota polling interval widened from 15m to 60m (`quotaPollIntervalMs: 60m`), and account polling incorporates a 2-second stagger sleep to avoid simultaneous process bursts.
- **Feat: Full concurrency on Windows credential slot via global primary account alignment (Scheme A).**
  - Resolved Windows single-slot mutex serialization: concurrent sessions align to the current primary healthy candidate, hitting the `parallelSameAccount: true` fast path for 100% lock-free concurrency across sessions.
  - Single-direction migration to the next candidate only occurs when the active account encounters a 429 quota exhaustion.
- **Feat: Two-tier dual-loop test framework aligned with academic-agent & test suite speedup.**
  - Introduced `pnpm run test:fast` (powered by `scripts/fast-test.mjs`) for inner TDD vibe loops (0.5s~5s), running only Git-affected test files or specified module keywords (`pnpm run test:fast <keyword>`).
  - Tuned simulated asynchronous delay timers in `test/adapter.test.ts` and `fake-agy.mjs` from 5000ms/8000ms down to 300ms/400ms, speeding up adapter unit test execution by ~4x.
- **Feat: Scroll guard & tool view expansion state persistence.**
  - Added `scroll-guard.ts` to suspend DOM mutations and heavy scans (decisions, images, reasoning, mermaid) during active scrolling and smooth momentum settling.
  - Preserved user expanded/collapsed tool card states across TanStack Virtualizer dynamic remount cycles.

### 中文

- **新功能：针对 Google 敏感风控强化防护与 CLI 优先配额体系。**
  - 配额查询全面转向官方 `agy -p /usage` 解析：100% 走官方原生 Go 二进制握手与正规 TLS 指纹，消除 Node.js 层使用 `undici` 直接裸调 Google 内部 `v1internal` 接口带来的 JA3/JA4 客户端指纹断层风险。
  - 从 `AGY_ENDPOINTS` 中彻底移除 `daily-cloudcode-pa.sandbox.googleapis.com` 与 `autopush-cloudcode-pa.sandbox.googleapis.com` 内部测试端点，杜绝异常沙箱端点探测对正式 Google 账号的风控隐患。
  - OAuth 令牌刷新完全交由 `agy` 官方 Go 运行时在日常使用中原生完成，Node.js 宿主停止主动向 `oauth2.googleapis.com/token` 发送换票请求。
  - 默认后台巡检周期放宽至 60 分钟（`quotaPollIntervalMs: 60m`），多账号后台轮询增加 2 秒错峰休眠，避免瞬时并发拉起 CLI 进程造成的系统负载颠簸。
- **新功能：Windows 凭证槽位并发性能全面解锁（方案 A：全局主导账号收敛）。**
  - 解决 Windows 系统下因全局唯一定制凭证槽位 `gemini:antigravity` 导致的跨 Session 串行卡顿问题：所有会话默认对齐到号池主导活跃健康账号，命中 `parallelSameAccount: true` 快速通道，实现跨会话 100% 无锁全并发执行。仅当主导账号 429 配额耗尽时，全局指针单向整体迁移至下一账号。
- **新功能：对齐 academic-agent 的两级双环极速测试架构与用例调优。**
  - 新增 `pnpm run test:fast` 极速内环测试工具（`scripts/fast-test.mjs`），实现基于 Git 变动的秒级精准回归（0.5s~5s）以及按模块关键字直跑（`pnpm run test:fast <keyword>`）。
  - 优化 `adapter.test.ts` 与 `fake-agy.mjs` 中的异步等待延迟（由 5000ms/8000ms 降至 300ms/400ms），单测执行速度提升近 4 倍，保障日常开发极速反馈心流。
- **新功能：页面平滑滚动守卫与工具卡片展开状态持久化。**
  - 增加 `scroll-guard.ts` 滚动守卫机制，在用户主动滚屏及平滑滑动期间挂起 DOM 探测（decisions/images/reasoning/mermaid），彻底杜绝滚屏时内容突变抖动与闪烁。
  - 工具卡片折叠/展开状态跨 TanStack-Virtual 虚拟列表重新挂载自动持久化保留（`expandedToolBlockKeys`）。

## 0.4.68 (2026-10-23)

### English

- **Feat: Dynamic model picker reflects active account eligibility (Gemini 4 Argon isolation).**
  - Accounts in the pool now discover and cache models independently (`ModelCatalog` keyed by `accountId`).
  - When switching the active account in the UI or pool, the DSH composer model picker automatically refreshes (`llm/adapters-updated`).
  - If the active account lacks Argon access (free/standard tier), `gemini-4-argon` is dynamically excluded from the picker to prevent generation errors. When an account with Pro/Ultra subscription is active, Argon models are immediately restored.
- **Fix: Eliminate page scrolling and violent screen flickering in Antigravity client.**
  - Root cause: In `src/client/decisions.ts`, decision chip toolbar was repeatedly injected into TanStack-Virtual dynamic measurement containers because container-level marker `data-agy-decisions-scanned` was checked but never set, and re-rendering reconstructed heading nodes. The item height expansion triggered scroll position adjustments, which caused a re-render and re-injection flywheel.
  - In addition, settings nav row `MutationObserver` watched the entire subtree including `characterData` and re-triggered on its own marker writes without an attribute filter, and account button busy states repainted the entire account list instead of scoping to the target account.
  - Resolved with container-level idempotence guards (`data-agy-decisions-scanned` written before mutation), pre-checking existing toolbar containers, filtering nav mutation observer strictly to marker attribute changes, and scoping button busy states and shimmer animations to target accounts.
- **Fix: Send agy CLI User-Agent in quota requests so Argon quota group is returned (PR #54, Fixes #53).**
  - Google's Cloud Code backend requires a genuine `agy` CLI User-Agent header (format `Antigravity/<version> (darwin; arm64)`) to return the `Gemini 4 Argon` quota bucket in `retrieveUserQuotaSummary`. Without this header, only generic Gemini and 3P groups were returned.
  - Quota service now detects the installed `agy` CLI version and passes the proper User-Agent header in HTTP requests. When an account transitions or drops dedicated groups, obsolete cooldowns and stale last-known-good entries are cleanly evicted.
- **Fix: DSH Host 100% CPU busy loop on macOS caused by copying active SQLite WAL files (Fixes #52).**
  - Root cause: `loadAgyDbData()` previously copied `conversation.db`, `-wal`, and `-shm` to a temporary directory before querying tool step parameters and model thoughts. On macOS (and other BSD-derived libuv platforms), when an active SQLite WAL file is checkpointed or truncated to 0 during `copyFile`, libuv's `uv_fs_copyfile` enters an infinite busy loop in a worker thread, causing the Host process to permanently consume 100% of a CPU core.
  - Solution: Replaced file copying with direct SQLite reads (`node:sqlite` DatabaseSync with `readOnly: true`, falling back to `sqlite3` CLI with `-cmd ".timeout 2000" -cmd "PRAGMA query_only = ON;"`). SQLite's native WAL architecture provides atomic, consistent MVCC read snapshots concurrently with active writers without blocking or file-copying races.
  - Added regression test covering active WAL querying, WAL truncation/checkpointing during active use, sqlite3 CLI fallback, and zero-byte database handling.
- **Fix: Transport failures outlast a real egress outage, and no longer rotate a shared-egress pool.**
  - Live case (2026-10-21 16:34–16:48): the machine's proxy answered `CONNECT 200` and then killed TLS for ~14 minutes. Every `agy` run on every account died in its startup probe with `Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF`, which agy wraps as `Eligibility check failed: …`. DSH retried twice inside ~4 seconds and gave up — while the Antigravity desktop's own language server simply kept retrying and recovered.
  - Transport (`NETWORK`) failures now state their own backoff via `providerRetryAfterMs`: **5s → 15s → 30s** for consecutive failures in one session, reset on success or any non-transport failure, and treated as fresh after 10 minutes of quiet. `providerRetryPolicy` grew to 3 retries with `maxDelayMs: 45s` (the retry plugin *drops* a retry whose requested delay exceeds that cap, so it must sit above the longest transport delay).
  - A transport failure is only account-scoped when accounts leave through **different** proxies. With a single shared egress (every account on the config/system proxy, including pool accounts seeded with a copy of the system proxy) the retry stays on the current account: the sticky pointer is not advanced, the conversation binding is kept, and the account-rotation budget stays available for real quota/eligibility hops. The in-step failover of a settled recording also skips the budget without changing accounts.
  - Non-transport retries keep their 2s/4s starting schedule; nothing else about classification (AUTH vs NETWORK vs ELIGIBILITY) changed.

### 中文

- **新功能：模型选择框按当前活动账号资格动态隔离（Gemini 4 Argon 自动感知）。**
  - 号池内账号支持按账号独立发现并缓存模型目录（`ModelCatalog` 按 `accountId` 隔离）。
  - 在前端或号池切换当前活动账号后，DSH 输入框模型选择列表即时联动刷新（`llm/adapters-updated`）。
  - 若当前活动账号无 Argon 权限（标准/免费层），输入框模型列表中自动剔除 `gemini-4-argon`，防止误选调用报错；当切回 Pro/Ultra 订阅账号时，Argon 模型自动呈现。
- **修复：解决 Antigravity 插件设置及历史页面来回滚动疯狂闪屏问题。**
  - 根因定位：在 `src/client/decisions.ts` 中，决策按钮增强器容器级标记 `data-agy-decisions-scanned` 此前只读未写，且在 TanStack-Virtual 动态虚拟列表中，重新挂载渲染会重建 heading 节点。工具条反复注入导致项高度变化，进而触发虚拟列表重算 scrollTop 并再次触发重渲染注入飞轮。
  - 此外，设置导航图标的 `MutationObserver` 监听范围过广且在修改属性时自身被反复触发，且操作账号按钮的全局 busy 状态导致 40+ 个元素属性全量刷新并引发重排重绘。
  - 修复方案：在变更 DOM 前对容器写入 `data-agy-decisions-scanned` 并严格预检容器已有工具条；导航 Observer 限制仅监听对应属性变更（`attributeFilter`）并剥离 `characterData`；按钮 loading 状态与额度进度条 shimmer 动画改为账号级别作用域隔离。
- **修复：配额请求中上报 agy CLI 原生 User-Agent 以获取 Argon 额度分组（合并 PR #54，修复 #53）。**
  - Google Cloud Code 后端要求在 `retrieveUserQuotaSummary` 请求中携带真实的 `agy` CLI User-Agent（格式如 `Antigravity/<version> (darwin; arm64)`）才会返回 `Gemini 4 Argon` 独立额度桶。缺少该头时后端仅下发普通 Gemini 与 3P 组。
  - 配额探测服务现在自动探测本地 `agy` 版本并携带该头发送请求；当账号升级或移出专用桶时，旧版冷却记录与失效缓存自动淘汰。
- **修复：macOS 下复制活跃 SQLite WAL 时触发 libuv `copyFile` 忙循环导致 DSH Host 持续 100% CPU（修复 #52）。**
  - 原因分析：`loadAgyDbData()` 此前在读取工具参数和思考内容时，顺序将 `conversation.db`、`-wal` 和 `-shm` 复制到临时目录。在 macOS（以及其他基于 BSD 的 libuv 平台）上，当活跃 WAL 文件在复制过程中被 SQLite checkpoint 截短为 0 字节时，libuv 的 `uv_fs_copyfile` 工作线程会陷入无限忙循环，导致 DSH Host 进程持续耗尽单核 100% CPU。
  - 修复方案：完全移除临时目录与文件复制逻辑，改为直接通过 SQLite 引擎一致性读取（优先使用 `node:sqlite` 的 `DatabaseSync` 只读模式并开启 `PRAGMA query_only = ON;` 与 `busy_timeout`，后备使用 `sqlite3` CLI）。SQLite WAL 模式天然支持多读一写并发 MVCC 快照，既消除了文件截短忙循环与临时文件 I/O 争用，又保证了读取一致性。
  - 补充回归测试：覆盖活跃 WAL 读取、WAL 截短/检查点处理、sqlite3 CLI 后备路径及 0 字节文件防御。
- **修复：网络抖动时重试不再 4 秒内放弃，共用出口的号池不再被无意义轮换。**
  - 实测案例（2026-10-21 16:34–16:48）：本机代理对 `CONNECT` 返回 200 后直接掐断 TLS 长达约 14 分钟。每个账号上每次 `agy` 运行都在启动探测阶段死于 `Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": EOF`，被 agy 包成 `Eligibility check failed: …`。DSH 约 4 秒内重试两次即宣告失败，而 Antigravity 桌面端自己的 language server 只是一直重试，网络恢复后照常工作。
  - 传输类（`NETWORK`）失败现在通过 `providerRetryAfterMs` 自带退避：同一会话连续失败按 **5s → 15s → 30s** 递增；成功或出现非传输类失败即归零，静默超过 10 分钟后重新从 5s 起算。`providerRetryPolicy` 提升为 3 次重试、`maxDelayMs: 45s`（重试插件对**超过上限**的请求延迟会直接放弃该次重试，因此上限必须高于最长退避）。
  - 只有当各账号走**不同代理**时，传输失败才算账号级问题。共用同一出口时（所有账号都走配置/系统代理，含新建号池账号被写入系统代理副本的情况）重试留在当前账号：不推进粘性指针、保留会话绑定、也不消耗本该留给配额/资格跳转的轮换预算；已结算记录的步内失败切换同样不再计数、不再换号。
  - 非传输类重试仍从 2s/4s 起步；AUTH / NETWORK / ELIGIBILITY 的判定逻辑未做任何改动。

## 0.4.67 (2026-10-20)

### English

- **Fix: Host authorization-review calls lost their output protocol (Fixes #50).**
  - When DSH's `@deepseek-ai/dsh-experimental-auto-review` plugin reviews a tool call it sends the entire rubric in `options.system` (`REVIEW_POLICY`, which demands "Return exactly one JSON object and no other text"). The adapter only forwarded `options.system` when `forwardSystemPrompt` was on — and that flag defaults to `false` — so the model received the data sections alone.
  - The model then answered the way a coding agent does ("Based on a…", preceded by a plan and a self-written test script), and the caller's `JSON.parse` threw `Unexpected token 'B', "Based on a"... is not valid JSON`. Every reviewed tool call was denied with "its body was not executed" instead of being reviewed.
  - The adapter already detects these calls (`isReview`, used to exempt reviews from the auxiliary-call gate). System-prompt forwarding now also fires on that probe, so the policy always reaches the model regardless of the global opt-in. Ordinary turns are untouched: `forwardSystemPrompt` remains `false` by default and non-review calls still drop the system prompt.
  - New tests pin both directions: a review call forwards the policy without the opt-in, and an ordinary turn still sends a bare prompt.

### 中文

- **修复：宿主授权复核调用丢失了输出协议（修复 #50）。**
  - DSH 的 `@deepseek-ai/dsh-experimental-auto-review` 插件复核工具调用时，把整份规则放在 `options.system` 里（`REVIEW_POLICY`，要求「只返回一个 JSON 对象，不得有其他文本」）。该适配器仅在 `forwardSystemPrompt` 开启时才转发 `options.system`，而此配置默认 `false`，于是模型只拿到了数据段。
  - 模型随后按编码代理的方式作答（「Based on a…」开头，前面还有计划和自写的测试脚本），调用方的 `JSON.parse` 抛出 `Unexpected token 'B', "Based on a"... is not valid JSON`。结果是每一次被复核的工具调用都以「its body was not executed」被拒绝，而不是被复核。
  - 适配器本来就能识别这类调用（`isReview`，用于把复核豁免出辅助调用闸门）。现在该判定同时触发系统提示转发，策略无论全局开关如何都会送到模型。普通轮次不受影响：`forwardSystemPrompt` 默认仍为 `false`，非复核调用照旧丢弃系统提示。
  - 新增测试固定两个方向：复核调用在未开启开关时也转发策略；普通轮次仍只发送裸提示。

## 0.4.66 (2026-10-19)

### English

- **Fix: Residual Windows console flash from agy's own auto-updater (Fixes #49).**
  - Root cause confirmed on agy 1.4.2: `--bg-updater` is spawned *inside* agy, and its `agy --version` grandchild allocates a fresh visible console. The parent's `windowsHide` and `AGY_CLI_DISABLE_AUTO_UPDATE=1` therefore apply too late — the window is already on screen (this invalidates the #23 assumption).
  - New `src/host/auto-updater.ts` pre-empts the check instead of the child: agy's 15-minute fast path (`auto_updater.go:281 Last check was less than 15 minutes ago, skipping update (fast path)`) only stats `<agy home>/last_check.timestamp`, so the plugin refreshes that mtime immediately before every spawn. The `--bg-updater` chain is then never created.
  - Covers every spawn path: turns, boot `--version`/`models` probes, model-picker `listModels` refresh, login probes and auxiliary oneshot calls. Verified end-to-end against agy 1.4.2: the run logs `skipping update (fast path)` and spawns no child.
  - Isolated accounts are respected — the timestamp is resolved through the same `ANTIGRAVITY_APP_DATA_DIR` / `GEMINI_CLI_HOME` / `HOME` / `USERPROFILE` chain the plugin spawns with, so pooled homes are never mixed and the real profile is only touched for the system account.
  - New config `suppressAgyAutoUpdate` (env `DSH_AGY_SUPPRESS_AUTOUPDATE`), default `true` on Windows and `false` elsewhere; `false` restores agy's own auto-update behaviour. Pre-emption is best-effort and never fails a run.
  - `/agy doctor` now reports the auto-updater suppression state, and the FAQ documents both this fix and the read-only `update.lock` workaround for older versions.

### 中文

- **修复：agy 自身自动更新链导致的 Windows 残留闪窗（修复 #49）。**
  - 在 agy 1.4.2 上实锤根因：`--bg-updater` 是 **agy 内部** spawn 的，它再拉起的 `agy --version` 孙进程会自行分配可见控制台，因此父进程的 `windowsHide` 与 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 都来不及生效（#23 的假设在此版本不成立）。
  - 新增 `src/host/auto-updater.ts`，改从「阻止检查」下手：agy 的 15 分钟 fast path（`auto_updater.go:281 Last check was less than 15 minutes ago, skipping update (fast path)`）只 stat `<agy home>/last_check.timestamp`，插件在每次 spawn 前刷新该文件 mtime，`--bg-updater` 链便完全不产生。
  - 覆盖全部 spawn 路径：对话轮次、启动 `--version` / `models` 探测、模型选择器的 `listModels` 刷新、登录探测与 oneshot 辅助调用。已用真实 agy 1.4.2 端到端验证：日志为 `skipping update (fast path)`，无任何子进程。
  - 隔离账号同样生效——时间戳按插件 spawn 时使用的 `ANTIGRAVITY_APP_DATA_DIR` / `GEMINI_CLI_HOME` / `HOME` / `USERPROFILE` 链路解析，号池目录互不串扰，只有系统主账号才会碰到真实 profile。
  - 新增配置 `suppressAgyAutoUpdate`（环境变量 `DSH_AGY_SUPPRESS_AUTOUPDATE`），Windows 默认 `true`、其他平台默认 `false`；设为 `false` 即恢复 agy 原本的自动更新行为。拦截为 best-effort，失败绝不影响对话。
  - `/agy doctor` 增加自动更新拦截状态行；FAQ 同时补充本修复说明与旧版本可用的只读 `update.lock` workaround。

## 0.4.65 (2026-10-19)

### English

- **Fix: Paid Pro Argon Quota Pool Recognition & Metric Display (Fixes #46).**
  - Added support for top-level `summary.buckets` parsing and model-level quota metrics via `/v1internal:retrieveUserQuota`.
  - Automatically backfills `weeklyFraction` and `weeklyResetTime` when Argon models are detected in model catalog, resolving empty quota pills and dashes in `/agy pool`.
  - Updated `/agy pool` display formatting to seamlessly fallback to `remainingFraction` when `weeklyFraction` is unset.
- **Fix: Eliminate 15-Minute Flashing Black Terminal Window on Windows (Fixes #47).**
  - Removed redundant `catalog.refreshIfNeeded()` background spawn from the 15-minute periodic watchdog timer, ensuring background heartbeats strictly execute HTTPS network queries without launching `agy` CLI sub-processes.
  - Models now refresh cleanly on startup and on-demand upon model picker access.
  - Fixed `ModelCatalog` cache TTL initialization to accurately honor `getConfig().modelsCacheTtlMs`.
- **Fix: Quota Parity with `agy` CLI, Stale 5h Bucket Detection & Session Cleanup (Fixes #48).**
  - Integrated official `/v1internal:retrieveUserQuota` model-level quota metrics into `refreshAccountQuota`, matching the exact figures reported by the `agy` CLI.
  - Added `isStale5hBucket` heuristic to detect unmetered production endpoint placeholders (`remainingFraction === 1.0` with `resetTime ≈ now + 5h`) and overwrite them with active window model-level quota data.
  - Fixed endpoint fallback behavior in `fetchQuotaSummary` so `preferredEndpointIndex` is not locked to the production endpoint when endpoint 0 (`daily-cloudcode-pa.googleapis.com`) responds normally with partial groups.
  - Added unrounded quota percentage preview in frontend pill tooltips (`title="... (raw: 0.9711094)"`) for precise verification against raw API responses.
  - Added automatic cleanup of stale account bindings in `sessions.json` upon engine startup and session selection.

### 中文

- **修复：付费 Pro 账号 Argon 额度池识别与展示（修复 #46）。**
  - 增强额度解析，支持后端顶层 `summary.buckets` 以及通过 `/v1internal:retrieveUserQuota` 获取模型级别额度数据。
  - 模型探测阶段发现 Argon 模型时自动补充 `weeklyFraction` 与 `weeklyResetTime`，彻底解决客户端胶囊与 `/agy pool` 中显示空白破折号（`—`）的问题。
  - `/agy pool` 命令兼容展示 `weeklyFraction ?? remainingFraction`。
- **修复：彻底解决 Windows 环境下每 15 分钟闪烁黑终端窗口问题（修复 #47）。**
  - 从 15 分钟周期的后台刷新任务中移除了 `catalog.refreshIfNeeded()` 调用，使后台心跳严格保持在无外部进程的纯 HTTPS 网络请求，杜绝 Windows 终端弹窗。
  - 模型目录在启动和模型选择器打开时按需刷新，并修复了 `ModelCatalog` 构造时硬编码 TTL 的问题（接入 `getConfig().modelsCacheTtlMs`）。
- **修复：面板额度与 agy CLI 保持严格一致、识别 5h 虚假占位符并清理残留失效账号（修复 #48）。**
  - 对接官方 agy CLI 相同的 `/v1internal:retrieveUserQuota` 接口，将模型级实际 WTUS 额度纳入账户额度刷新体系。
  - 实现 `isStale5hBucket` 智能检测机制，识别生产域未记账的 5 小时虚假占位符（`remainingFraction === 1.0` 且 `resetTime ≈ now + 5h`），并由真实生效窗口数据覆盖替换。
  - 修复 `fetchQuotaSummary` 端点降级逻辑，在 daily 域仅返回部分组别时进行多组结果合并，不再将全局端点锁死到不记账的生产域。
  - 客户端胶囊悬浮气泡增加原始未舍入比例（例如 `97.1% (raw: 0.9711094)`）与 ISO 重置时间，方便与 agy 命令行及 API 返回对比。
  - 启动及选择账号时自动清理 `sessions.json` 中已不存在的失效废弃账号引用。

## 0.4.64 (2026-10-18)

### English

- **Feat: DSH Standard Error Code Alignment & Context Window Overflow Auto-Compaction.**
  - Added `Err.CONTEXT_WINDOW_EXCEEDED` (`CONTEXT_WINDOW_EXCEEDED`), `Err.QUOTA`, and `Err.INVALID_CREDENTIAL` aligned with `@deepseek-ai/dsh-llm` standard contracts.
  - Implemented `looksLikeContextWindowExceeded` classifier detecting Gemini/Antigravity token limit overflow signatures (`prompt is too long: \d+ tokens > \d+ maximum`, `context window exceeded`, `token limit exceeded`, etc.).
  - Mapped context overflow to `CONTEXT_WINDOW_EXCEEDED`, allowing DSH's native agent loop to trigger context auto-compaction and summarization automatically rather than failing the turn with a fatal `PROCESS_EXIT`.
- **Perf & Concurrency: Windows High-Concurrency & Zero-Blocking Credential Slots.**
  - Added in-memory cached reads for Windows Credential Manager (`readWindowsCredentialRaw`, `invalidateWindowsCredentialCache`), slashing read latency from ~516ms (synchronous PowerShell process invocation) to <0.01ms (50,000x faster).
  - Refactored `acquireCredentialSlot` cross-process locking to release `.credential-slot.lock` immediately after writing the slot identity, eliminating thread/process blocking across concurrent sessions during long LLM runs.
  - Replaced slot join polling with an event-driven `slotEvents: EventEmitter`, providing 0ms instant wakeup for concurrent turns sharing the active identity.
- **Feat: Multi-Turn Tool Call Disambiguation & Collision Self-Healing.**
  - Implemented `ToolCallState`, `rememberToolCallId`, `consumeToolBinding`, and `expirePendingToolCalls` in `src/host/mapper.ts`.
  - Disambiguates duplicate call IDs across tools (`${id}#${name}`) with FIFO ordering and assistant-turn expiration, eliminating `INVALID_ARGS` crashes in long agentic conversations.
  - Updated `parseMirrorCallId` in `src/host/recording.ts` to seamlessly parse both canonical and hash-suffixed call IDs.
- **Hardening: Headless Browser & Process Isolation Hardening.**
  - Injected `AGY_CLI_NONINTERACTIVE_HEADLESS: '1'`, `BROWSER: 'none'`, and `CI: '1'` into `withAgyQuietEnv` to strictly prevent accidental browser popups during background checks.
  - Redirected `ANTIGRAVITY_GEMINI_DIR` and `ANTIGRAVITY_APP_DATA_DIR` into isolated account directories in `isolatedHomeEnv` to eliminate credential bleed.
- **Clean: Removed redundant native `generate_image` tool.**
  - Fully removed `generate_image` registration, config schema, and related test fixtures.

### 中文

- **特性：对齐 DSH 标准错误码规范与上下文超限自动压缩触发。**
  - 新增 `Err.CONTEXT_WINDOW_EXCEEDED` (`CONTEXT_WINDOW_EXCEEDED`)、`Err.QUOTA` 与 `Err.INVALID_CREDENTIAL`，深度对齐 `@deepseek-ai/dsh-llm` 标准协议契约。
  - 实现 `looksLikeContextWindowExceeded` 分类器，精准识别 Gemini/Antigravity 上下文溢出特征（`prompt is too long: \d+ tokens > \d+ maximum`、`context window exceeded`、`token limit exceeded` 等）。
  - 上下文溢出时抛出标准 `CONTEXT_WINDOW_EXCEEDED` 错误码，使 DSH 原生 Agent 循环自动触发上下文压缩（Context Compaction / Summarization），彻底告别直接进程崩溃断连（`PROCESS_EXIT`）。
- **性能与并发：Windows 极致高并发与凭据槽位零阻塞优化。**
  - 为 Windows Credential Manager 实现高频读内存缓存（`readWindowsCredentialRaw` / `invalidateWindowsCredentialCache`），将每次查询耗时从 516ms（同步拉起 powershell.exe）降至 <0.01ms（提速超 50,000 倍），彻底杜绝事件循环被卡死。
  - 重构 `acquireCredentialSlot` 跨进程锁机制，在凭据写入槽位完成后立即释放 `.credential-slot.lock`，不再跨越整个 LLM 流式输出生命周期持锁，彻底解决多会话并发竞争卡死。
  - 将轮询等待重构为基于事件的 `slotEvents: EventEmitter` 唤醒机制，同身份并发会话实现 0ms 零延迟极速放行。
- **特性：多轮工具调用标识去重与碰撞自愈机制。**
  - 在 `src/host/mapper.ts` 中实现 `ToolCallState`、`rememberToolCallId`、`consumeToolBinding` 与 `expirePendingToolCalls` 状态机。
  - 对跨工具复用的相同 `callId` 自动添加后缀（`${id}#${name}`）并按 FIFO 队列匹配，在新 Assistant 消息到达时自动过期队列，杜绝 DSH `INVALID_ARGS` 报错。
  - 同步更新 `parseMirrorCallId`，完美支持带 `#` 后缀的工具调用解析与回溯。
- **加固：无头环境与进程隔离全面加固（防弹窗机制）。**
  - 在 `withAgyQuietEnv` 中注入 `AGY_CLI_NONINTERACTIVE_HEADLESS: '1'`、`BROWSER: 'none'` 与 `CI: '1'`，从底层彻底阻止任何意外触发的浏览器登录弹窗。
  - 在 `isolatedHomeEnv` 中重定向 `ANTIGRAVITY_GEMINI_DIR` 与 `ANTIGRAVITY_APP_DATA_DIR` 至账号隔离目录，杜绝环境变量遗漏导致的全局配置污染与凭据泄露。
- **精简：移除冗余原生图像生成工具（`generate_image`）。**
  - 彻底下线 `generate_image` 工具定义、配置项声明及对应测试文件。

## 0.4.63 (2026-10-18)

### English

- **Fix: Prevent Mermaid post-render cleanup from deleting active diagram SVGs.**
  - Resolved an issue where rendered flowchart SVGs were immediately removed by `cleanupTempElements` in the `finally` block due to an indiscriminate `document.getElementById(id)` query matching the newly inserted diagram SVG.
  - Added ancestor check (`closest('[data-agy-mermaid-svg]')`) to ensure only leaked standalone temporary DOM elements outside the diagram container are purged.
- **Fix: Enhanced Argon quota pool detection (Issue #46) and model effort support.**
  - Added bucket-level Argon detection in quota summary parsing (`hasArgonBucket`), resolving cases where Paid Pro accounts had their Argon quota pools omitted due to varied group naming.
  - Enabled reasoning effort folding and `--effort` parameter support for `argon`-prefixed models, and added `gemini-4-argon` to `DEFAULT_FALLBACK_MODELS`.
- **Docs: Correct feature descriptions & refresh visual documentation.**
  - Corrected inaccurate and exaggerated phrasing in the README feature table regarding settings consolidation, secondary parallel leases, and native context caching.
  - Replaced dashboard screenshot with pixel-perfect mosaic redactions on all user email addresses, and enriched the documentation with real-world Token usage and 1M context metering figures.

### 中文

- **修复：Mermaid 流程图渲染后被清理机制误删导致内容空白消失的问题。**
  - 修复 `cleanupTempElements` 在清理泄漏的临时 DOM 元素时，因直接通过 `document.getElementById(id)` 查找而误删了刚刚挂载到页面容器中的正式 `<svg>` 节点，导致流程图渲染后瞬间空白的问题。
  - 增加最近祖先判断（`closest('[data-agy-mermaid-svg]')`），确保仅清理逃逸至容器外部的游离临时节点，正式图表永久保留。
- **修复：付费 Pro 账号 Argon 额度池识别增强（Issue #46）与模型调用支持。**
  - 在配额解析中增加 bucket 层级的 Argon 标识检测（`hasArgonBucket`），彻底解决因分组名称变体导致的付费 Pro 账号未识别 Argon 额度池的问题。
  - 支持 `argon` 模型前缀的思维强度折叠与 `--effort` 参数传递，并在 `DEFAULT_FALLBACK_MODELS` 中补齐 `gemini-4-argon`。
- **文档：纠正功能说明表述并升级图文文档（邮箱全面脱敏）。**
  - 纠正 README 特性表中关于“插件页详情零冗余复用”、“同账号二次并发租赁”与“97% 缓存命中”的不准确表述，还原本质功能（设置控制台内嵌、副账号同身份并发租约、原生上下文缓存真实计量）。
  - 全新更新控制台仪表盘截图，对所有账号邮箱实施严格的像素级马赛克脱敏，并新增真实会话 Token 用量与 1M 上下文负载的图文展示。

## 0.4.62 (2026-10-17)

### English

- **Feat: Capacity vs. Account exhaustion separation & stay-on-capacity backoff.**
  - **Decoupled Capacity vs. Account**: Added `looksLikeCapacityExhaustion` to distinguish upstream datacenter/cluster overload (503/529, "high demand", "capacity exceeded", "resource temporarily exhausted") from per-account rate limits (429 per-token/per-request exhaustion).
  - **Stay Strategy**: Capacity overloads now surface as retryable `Err.OVERLOADED` (preserving `rate limit (server capacity overloaded)` for downstream compatibility). `rotateAway` skips account rotation when capacity is overloaded, avoiding rapid, fruitless churn through the entire account pool during regional Google outages.
- **Feat: Windows cross-process slot lock with `process.kill(pid, 0)` liveness detection & instant self-healing.**
  - **Liveness Detection**: Implemented `isProcessAlive(pid)` leveraging `process.kill(pid, 0)` with proper platform-level `ESRCH` and `EPERM` error code handling.
  - **Instant Stale Lock Reclamation**: In `acquireCrossProcessSlotLock` for Windows multi-process slot arbitration, stale locks from abruptly killed or crashed processes are detected immediately upon PID verification and cleanly removed, eliminating unneeded blocking waits.
- **Feat: Zero-flicker optimistic account switching & shimmer loading animation.**
  - **Optimistic Account Switch**: Switching accounts in `AgySettingsSection` triggers an immediate 0ms UI update (`optimisticActiveId`) with graceful rollback on error, eliminating UI redraw jitter and perception latency.
  - **Quota Shimmer Effect**: Integrated CSS shimmer animation (`@keyframes agy-shimmer` & `.agy-shimmer-track`) into quota progress bars during refresh and pending states, delivering a polished, modern look.
- **Fix: Unified proxy indicator badge & system proxy inheritance for primary account.**
  - **Inherited Proxy Visibility**: The proxy tag (`[globe] Proxy`) now resolves effective proxy configuration (`acc.proxyUrl || pool.systemProxy`). When accounts rely on global/system proxy settings, the proxy badge is reliably shown on the primary account alongside other accounts instead of silently omitting it.
  - **Proxy Tooltip & Placeholder**: Hovering on the proxy tag now shows the effective proxy URL (`title: effectiveProxy`), and modal/input placeholders dynamically reflect the inherited system/global proxy URL.

### 中文

- **新功能：容量过载与账号配额耗尽精准解耦，机房压力下实行原地退避（Stay）。**
  - **过载类型分离**：引入 `looksLikeCapacityExhaustion`，精准区分 Google 机房级/区域级容量瓶颈（503/529、"high demand"、"capacity exceeded"、"resource temporarily exhausted"）与单个账号的 429 频率超限。
  - **原地退避调度（Stay）**：容量压力统一抛出可重试的 `Err.OVERLOADED`（错误信息保留 `rate limit (server capacity overloaded)` 以向下兼容）。`rotateAway` 遇到容量过载时跳过轮换、留在当前账号，彻底杜绝在机房整体拥堵时盲目将全号池快速轮换耗尽的恶性循环。
- **新功能：Windows 跨进程凭证锁与 `process.kill(pid, 0)` 进程存活探测秒级自愈。**
  - **进程存活性探测**：实现高可靠的 `isProcessAlive(pid)`，基于 `process.kill(pid, 0)` 准确识别 `ESRCH`（进程不存在）与 `EPERM`（跨权限存活进程）。
  - **崩溃孤儿锁秒级清理**：在 Windows 多进程凭证槽互斥锁（`acquireCrossProcessSlotLock`）中，当持锁 PID 意外崩溃或被强杀时，竞争进程通过存活探测瞬间判定孤儿锁并自愈重置，无需冗长的超时等待。
- **新功能：前端账号切换 0ms 乐观响应防闪烁与配额微光（Shimmer）动效。**
  - **0ms 乐观切换**：在 `AgySettingsSection` 控制台切换账号时立即通过 `optimisticActiveId` 刷新界面状态并带有错误自动回滚保护，彻底消除切换等待过程中的白屏闪烁与延迟感。
  - **配额微光流光动效**：配额条（`renderFamilyQuotaBar`）在刷新或等待就绪时接入平滑流光动效（`@keyframes agy-shimmer` 与 `.agy-shimmer-track`），交互反馈更具质感。
- **修复：统一代理标识展示与主账号系统/全局代理继承识别。**
  - **继承代理完整透出**：代理徽标（`[globe] 代理`）统一解析账号生效代理（`acc.proxyUrl || pool.systemProxy`）。当主账号继承使用系统/全局代理设置时，与号池副账号一样稳定展示代理徽标，消除“主账号缺少代理标识”的疑惑。
  - **代理悬浮提示与输入框占位符**：鼠标悬停在“代理”徽标上可直接查看完整生效代理 URL；代理编辑框与新建账号对话框动态展示当前继承的系统代理地址。

## 0.4.61 (2026-10-17)

### English

- **Feat: Official vector logo redesign & zero-redundancy console reuse across DSH.**
  - **Redesigned Vector Logo** (`assets/icon.svg` & `./icon.svg` + `package.json` `icon`): Clean, transparent-background 36x36 retina vector icon featuring a vibrant antigravity orb gradient (`#38BDF8` → `#6366F1` → `#9333EA` → `#C026D3`), front/back occluded orbital rings, specular crescent highlight, and dual satellite bridge nodes (cyan & magenta). Pinned by `test/client-plugin-meta.test.ts`.
  - **Settings & Navigation Brand Icons**:
    - Upgraded `agyIcon` in Settings section header and Modal Console dialog to render the full official vector logo geometry.
    - Added `installSettingsNavIcon` dynamically targeting the Settings dialog navigation sidebar (`[role="dialog"] nav button`), replacing DSH's fallback gear icon with the official Antigravity logo.
  - **Zero-Redundancy Plugin Page Console**: Directly reuses the identical `AgySettingsSection` console in the plugins bundle/row view (`plugins.bundle.config` & `plugins.row.config`), eliminating duplicate dashboard code while keeping list card summaries clean.
  - **Display Metadata**: Localized title and description in `locale/{en,zh,es,pt-BR}.json` ("Antigravity 桥接").

### 中文

- **新功能：官方矢量 Logo 视觉重构与 DSH 全场景控制台零冗余复用。**
  - **矢量 Logo 全新设计**（`assets/icon.svg` 与 `./icon.svg` + `package.json` `icon` 字段）：采用纯透明背景、36x36 视网膜矢量微标，包含反重力渐变球体（`#38BDF8` → `#6366F1` → `#9333EA` → `#C026D3`）、前后立体穿插引力环、月牙镜面液态高光与双子引力光节点（天青与洋红）；通过 `test/client-plugin-meta.test.ts` 强校验。
  - **设置界面与左侧导航图标全面接入 Logo**：
    - 设置面板顶部与控制台弹窗标题的 `agyIcon` 升级为官方矢量微标几何体。
    - 新增 `installSettingsNavIcon`，动态匹配设置对话框左侧导航菜单（`[role="dialog"] nav button`），将系统默认齿轮图标替换为专属 Antigravity Logo。
  - **插件详情页零冗余复用**：侧边栏插件页（`plugins.bundle.config` 与 `plugins.row.config`）在详情页面中直接复用原版 `AgySettingsSection` 控制台，列表摘要卡片保持纯粹轻量，彻底避免界面冗余与代码重复。
  - **展示元数据**：`locale/{en,zh,es,pt-BR}.json` 注入本地化展示元数据（"Antigravity 桥接"）。

## 0.4.60 (2026-10-17)

### English

- **Fix: same-grant runs on a SECONDARY pool account now run in parallel — only identity SWITCHES serialize (cardboard-empire starvation, 2026-10-17).**
  - **Incident**: the active pool account was a secondary (`elegantmanco@…`); only the primary account had a fast path, so every secondary run held the machine-global Windows credential slot EXCLUSIVELY for its whole run. One long agy run (the quota-investigation session, 12:34:30–12:44:18, 79 mirrored steps) starved all other sessions: three cardboard-empire turns sat at `request/context` for 8m50s+ with zero tokens even though their `request/header` had already been logged. When the long run exited the queue drained 16s later (first token 12:44:34) — the slot, not agy, was the bottleneck.
  - **Change** (`credential-slot.ts`): the installed SECONDARY identity is now reference-counted. The first run performs the exclusive handoff and keeps the mutex; later runs on the SAME grant join as fast leases after proving the slot still carries that grant (`sameCredentialGrant` on every join, so an external slot takeover is never joined). **Runs already queued for the slot also join**: while waiting they poll every 100ms and take a lease the moment their own grant is installed, so a backlog of turns drains in parallel instead of one whole run at a time (the exact incident shape). The LAST holder persists a rotated access token and restores the primary. `fastPathRunCount()` now reports primary fast runs + live same-identity secondary holders, and `/agy status` shows the combined number.
  - **Anti-starvation invariant preserved**: a run that needs a DIFFERENT identity (or the primary) registers a switch claim BEFORE queueing on the mutex; new same-identity joins are refused while any claim is outstanding (the single `slotSwitchPending` boolean became a `pendingSwitchClaims` counter), so a switcher can no longer be postponed indefinitely. Same-grant refreshes remain safe: refresh tokens are not single-use, and every joiner verifies the grant before running.
  - **Tests** (`credential-slot.test.ts`): same-identity secondary runs share one installed identity and run in parallel (the mutex stays held by the owner until the last peer exits); an identity switch waits for EVERY peer; a pending switch refuses new peers (no starvation); a peer does not join an installed identity the slot no longer carries; last-holder rotated-token write-back; `parallel: false` still restores full exclusivity; existing corruption guards unchanged (26/26 pass).
- **Fix: live Gemini quota synchronization & accurate 5h / weekly limit display.**
  - **Root Cause**:
    1. `AGY_ENDPOINTS` placed `https://cloudcode-pa.googleapis.com` ahead of `https://daily-cloudcode-pa.googleapis.com`. `cloudcode-pa` is the Cloud Code for VS Code legacy PA endpoint, returning a separate quota pool (which showed 4% @ 15:07).
    2. `src/host/quota.ts` hardcoded `agyUserAgent` default to `1.1.15`. Google's Antigravity backend (`daily-cloudcode-pa.googleapis.com`) checks client versions and omits the entire `Gemini Models` group when receiving `1.1.15`, returning only third-party models. With `2.24.0` (matching Antigravity IDE 2.24.0), it immediately returns both Gemini Models and Claude/GPT groups with live 5-hour and weekly buckets.
    3. Reordered `AGY_ENDPOINTS` to prioritize Antigravity's native `https://daily-cloudcode-pa.googleapis.com` endpoint, and updated `agyUserAgent` default version to `2.24.0`.
  - **Result**: "刷新额度" and "同步" immediately display accurate Gemini 5-hour and weekly limits matching Antigravity IDE (e.g. 99% / 99% with correct reset countdowns) instead of getting stuck at 4%.
- **Fix: primary account on Windows self-heals from durable verified store and prevents sibling account log pollution.**
  - **Issue**: On Windows, the primary account (`systemHome`) could display a secondary account's email (e.g. `elegantmanco@…` instead of `g98…`) after background quota polls. The background quota poller read `detectEmailFromAgyLogs` from `~/.gemini/antigravity-cli/log`, where secondary accounts executing in the shared CLI home wrote auth success log lines.
  - **Fix**: The primary account on Windows now binds directly to the durable verified store (`.primary-credential.json`, written only from live Google token verification). `normalizeLegacyPrimary` self-heals on startup/reload, and `detectEmailFromAgyLogs` rejects any email belonging to sibling accounts in the pool.

### 中文

- **修复：同一授权下的次级账号运行现在可以真正并行——只有「身份切换」才串行（cardboard-empire 饿死事件，2026-10-17）。**
  - **事件**：当时生效的是号池里的次级账号（`elegantmanco@…`），而快路径只给系统主账号，于是每个次级运行都要独占机器级 Windows 凭据槽直到整个 run 结束。一个长 agy 运行（额度排查会话，12:34:30–12:44:18，79 个镜像步骤）把其它会话全部饿死：三个 cardboard-empire 回合停在 `request/context` 8 分 50 秒以上、零 token，而它们的 `request/header` 早已记录。长运行退出后 16 秒内队列就动了起来（12:44:34 首个 token）——证明瓶颈是凭据槽而不是 agy。
  - **改动**（`credential-slot.ts`）：次级账号装入槽位的身份改为**引用计数**。第一个 run 完成独占交接并持有互斥锁；之后**同一授权**的 run 通过 `sameCredentialGrant` 校验槽位仍携带该凭据后直接加入（外部改写槽位时不会误加入）。**已经排队等槽的 run 也会加入**：排队期间每 100ms 轮询一次，一旦自己的授权被装入就立刻转成并行租约——这样一整批积压回合会并行排空，而不是一个 run 接一个 run 地串（正是本次事件形态）。**最后一个 holder** 才回写轮换后的 access token 并还原主账号。`fastPathRunCount()` = 主账号快路径 + 次级同身份在跑数，`/agy status` 展示合并值。
  - **防饿死不变量保留**：需要切换身份（或切回主账号）的运行会在排队**之前**登记切换声明；只要有声明未完成，新的同身份 run 一律拒绝加入（原来的单个 `slotSwitchPending` 布尔改为 `pendingSwitchClaims` 计数），切换者不会再被无限推迟。同授权并发刷新是安全的（refresh token 非一次性），且每个加入者都会先校验授权。
  - **测试**：同身份次级并行（互斥锁由所有者持有直到最后一个 peer 退出）、身份切换等待全部 peer、切换待定时拒绝新 peer（防饿死）、槽位被外部改写时不加入、最后持有者回写轮换 token、`parallel: false` 仍完全串行、原有防损坏守卫不变（26/26 通过）。
- **修复：Gemini 额度显示 4% 卡死及刷新/同步无效问题，还原真实的 5 小时与周额度。**
  - **根本原因**：
    1. `AGY_ENDPOINTS` 此前误将 `https://cloudcode-pa.googleapis.com`（Cloud Code PA 遗留端点）置于首位，导致请求命中了非 Antigravity 的老配额周期（显示为 4.06% ↺ 15:07）。
    2. `src/host/quota.ts` 中的 `agyUserAgent` 默认写死了版本号 `1.1.15`。Google Antigravity 后端（`daily-cloudcode-pa.googleapis.com`）对客户端版本有特性拦截：当 UA 为 1.x 时，响应中直接剔除 `Gemini Models` 额度组，导致此前测试误以为该端点缺失 Gemini 数据。更新为 `2.24.0`（与 Antigravity IDE 2.24.0 官方客户端一致）后，后端即刻完整返回 Gemini Models 的 5 小时与周额度。
    3. 将 `AGY_ENDPOINTS` 调整为优先请求 Antigravity 原生端点 `https://daily-cloudcode-pa.googleapis.com`，并将 `agyUserAgent` 默认版本升级为 `2.24.0`。
  - **效果**：点击「刷新」或「同步」后，插件面板即刻正确呈现与 Antigravity IDE 一致的真实额度（如 99% 5 小时额度与 99% 周额度及各自正确的重置倒计时），不再卡死在 4%。
- **修复：Windows 主账号身份自愈并防御副账号日志污染（主账号显示为副账号邮箱问题）。**
  - **问题**：在 Windows 单槽位多账号环境下，后台每 15 分钟的额度轮询通过 `detectEmailFromAgyLogs` 扫描全局 CLI 日志目录；当副账号（如 `elegantmanco@…`）在本地运行留下认证日志后，主账号邮箱被误覆盖为副账号，导致控制面板主账号显示错误。
  - **修复**：主账号在 Windows 下权威绑定持久化验证凭据（`.primary-credential.json`），启动与重新载入时通过 `normalizeLegacyPrimary` 自动自愈；日志探测增加兄弟账号守卫（Sibling Account Guard），坚决忽略已在号池中的副账号邮箱，杜绝反向污染。

## 0.4.59 (2026-10-16)

### English

- **Fix: turns queued for the Windows credential slot could pend forever as invisible zombies, immune to Stop (cardboard-empire incident, 2026-10-16 22:44).**
  - **Incident**: a turn dispatched while another session's 32-minute run held the process-global credential slot never received the release wake-up. The turn sat at `request/context` with no agy process spawned for 30+ minutes; the idle watchdog never armed (it only arms after spawn); Stop did nothing because no wait in the dispatch phase observed the abort signal; and the leaked dispatch held one of the 3 `maxConcurrent` slots, starving later turns of other sessions into the same wedge.
  - **Changes**:
    1. **`AsyncMutex` rewrite** (`credential-slot.ts`): the promise-chain FIFO could never remove a waiter — an abandoned/aborted one would wedge the whole chain behind it. Now an explicit queue: a cancelled or timed-out waiter is REMOVED and the holder's release wakes the head directly. Cancelling a waiter deliberately does NOT grant the mutex (it is still held).
    2. **Abort + bounded wait for the slot** (`acquireCredentialSlot`): new `signal` / `dispatchTimeoutMs` resolve-options. Stop now ends a queued dispatch immediately (`AbortedWaitError`); a bounded wait fails visibly (`WaitTimeoutError`) instead of parking silently.
    3. **Lost-wake-up self-heal**: while queued, a liveness poll (5s) re-checks and takes the mutex directly if it is actually free — the exact failure shape from the incident now self-corrects within seconds even if a wake-up is ever lost again.
    4. **Dispatch observability**: a 2-minute heartbeat logs the queue state ("dispatch still waiting Nm — X waiter(s), Y holder(s) … press Stop to cancel") so a stuck dispatch is visible in the console instead of a silent spinner.
    5. **Dispatch retry** (`adapter.ts`): on a hard-cap slot timeout the dispatch releases the concurrency slot, backs off abort-aware (2s→4s→…→15s), and retries (`dispatchRetries`, default 1); exhaustion fails the turn VISIBLY with guidance — never an infinite pending state. Retry is confined to the pre-spawn dispatch phase; a turn that already emitted output is never re-driven.
    6. **Rate-limit spacing sleep** is now abort-aware (Stop during the 60s window no longer spawns a turn nobody is reading).
  - **Config**: new `dispatchTimeoutMinutes` (default **15** — each attempt waits up to 15 minutes for the slot, so persistence ≈ (1+retries)×15 min before a visible failure; 0 = wait indefinitely, still abort-aware / poll-healed / heartbeat-logged) and `dispatchRetries` (default 1). User-facing entry: `/agy dispatch` (inspect live queue + effective caps), `/agy dispatch <minutes|off>` and `/agy dispatch-retries <n>` — persisted via runtime overrides, effective next turn.
  - **Fix: artificial concurrency limits removed — native agy parallelism restored.**
    - agy is a stateless CLI and handles concurrent processes natively; the only machine-global constraint on Windows is the single credential store, and only when its IDENTITY changes.
    - **Same-account fast path** (`parallelSameAccount`, default **on**): a run whose credential already sits in the slot starts immediately WITHOUT the mutex, so N sessions on one account run truly in parallel (concurrent refreshes on one grant are safe — refresh tokens are not single-use). `/agy parallel <on|off>` toggles it.
    - **Account switches still serialize** (correctness): a secondary waits for same-account runs to drain before swapping the slot, new fast paths are refused while a switch pends, and the switch restores the primary afterwards — the anti-corruption invariants are unchanged and covered by new tests.
    - **`maxConcurrent` default 3 → 0 (unlimited)**: no artificial admission bound; Google rate limits and the pool's cooldowns are the natural regulators. `/agy max-concurrent <n|off>`.
  - **Fix: quota merge — the real remaining was blocked by the 6h window gate.** When the 5h bucket is exhausted, Google reports the NEXT reset at the weekly boundary (14+ hours out); the `is5hWindow` gate (reset must land within 6h) skipped the per-model merge, so the UI kept showing the coarse summary's meaningless "100%, resets in now+5h" placeholder while the account was actually down to **4.06%** (observed live 2026-10-17 00:37: reported reset 05:37:49 == refresh+5h exactly, while every model row carried 4.06% @ 15:07). The merge now tightens to the LOWEST reported remaining regardless of which window it owns; the weekly row stays visible separately. Regression test reproduces the exact incident numbers.
  - **Fix: goal completion short-circuit swallowed genuine user messages.** `isGoalToolContinuation` scanned a fixed trailing window for goal markers "anywhere": a message sent right after a goal completed (the goal tool-result was still in that window) was finished as an EMPTY turn without spawning agy — twice in a row, "把相关的经验整理到agents.md" never reached the agent (2026-10-17, turns completed in 7s/16s with zero output). The scan now walks backwards and STOPS at a genuine user instruction (harness-injected texts — time samples, system-reminder wrappers, runtime context — stay transparent), so markers only short-circuit while they are actually the trailing content.
  - **Tests**: mutex cancel-removes-and-wakes-next; timeout keeps the queue flowing; lost-wake-up poll grant; `acquireCredentialSlot` rejects when already aborted, honors Stop while queued, and fails visibly on the bounded wait; same-account fast path / drain / starvation; quota weekly-boundary tightening; goal-continuation genuine-message cases.

### 中文 (Chinese)

- **修复：排队等 Windows 凭据槽位的回合可能永远挂起成隐形僵尸，且 Stop 无法取消（cardboard-empire 事件，2026-10-16 22:44）。**
  - **事件**：一个回合在另一会话 32 分钟长任务持有进程级凭据槽位期间派发，之后永远没有收到释放唤醒。该回合停在 `request/context`，30 多分钟没有拉起任何 agy 进程；空闲看门狗从未武装（只在 spawn 后才武装）；按 Stop 无效，因为派发阶段的所有等待都没有观察中止信号；泄漏的派发还占着 3 个 `maxConcurrent` 槽位之一，把其他会话的新回合也拖进同样的卡死。
  - **修改**：
    1. **重写 `AsyncMutex`**（credential-slot.ts）：原来的 promise 链式 FIFO 无法移除等待者——一个被放弃/中止的等待者会把整条链卡死。现在改为显式队列：被取消/超时的等待者会被移除，持有者释放时直接唤醒队头。取消等待者刻意不发放互斥锁（锁仍被持有）。
    2. **槽位等待支持中止与限时**（`acquireCredentialSlot`）：新增 `signal` / `dispatchTimeoutMs` 选项。Stop 现在立即结束排队中的派发（`AbortedWaitError`）；限时等待可见地失败（`WaitTimeoutError`），不再静默挂起。
    3. **丢失唤醒自愈**：排队期间每 5 秒自检一次，发现锁实际空闲就直接取锁——即使唤醒再次丢失，本事件形态也会在数秒内自愈。
    4. **派发可观测性**：每 2 分钟心跳记录队列状态（"dispatch still waiting Nm — X waiter(s), Y holder(s) … press Stop to cancel"），卡死的派发在控制台可见，而不是无声转圈。
    5. **派发重试**（adapter.ts）：槽位硬超时后释放并发槽位、可中止退避（2s→4s→…→15s）并重试（`dispatchRetries`，默认 1）；重试耗尽则让回合可见地失败并给出处理指引——绝不无限 pending。重试仅限 spawn 前的派发阶段；已经产出内容的回合绝不重跑。
    6. **限流退避 sleep** 支持中止（60 秒窗口内的 Stop 不再照常 spawn 一个没人读的回合）。
  - **配置**：新增 `dispatchTimeoutMinutes`（默认 **15** —— 每轮最多等 15 分钟，含重试总坚持 ≈ (1+重试)×15 分钟后可见失败；0 = 无限等待，仍可中止/轮询自愈/心跳可见）与 `dispatchRetries`（默认 1）。用户入口：`/agy dispatch`（查看实时队列与当前配置）、`/agy dispatch <分钟|off>` 与 `/agy dispatch-retries <次数>` —— 经 runtime overrides 持久化，下一回合生效。
  - **修复：移除人为并发限制，恢复 agy 原生并行能力。**
    - agy 是无状态 CLI，天然支持多进程并发；Windows 上唯一的机器级约束是单一凭据库，且仅在**账号身份切换**时才需要互斥。
    - **同账号快路径**（`parallelSameAccount`，默认**开**）：凭据已在槽位中的账号立即启动、完全不取互斥锁 —— N 个会话在同一账号上真并行（同一授权的并发 token 刷新是安全的，refresh token 非一次性）。`/agy parallel <on|off>` 开关。
    - **账号切换仍然串行**（正确性）：副账号先等同账号 run 全部退出再换槽位；切换等待期间拒绝新的快路径；切换完成后恢复主账号 —— 防腐蚀不变量原样保留，新增测试覆盖。
    - **`maxConcurrent` 默认 3 → 0（不限制）**：移除人为准入上限；Google 速率限制与账号池冷却是天然调节器。`/agy max-concurrent <n|off>`。
  - **修复：配额合并 —— 真实剩余被 6 小时窗口门槛挡掉。** 5 小时桶耗尽时，Google 把下一次重置报在周边界（14+ 小时后）；`is5hWindow` 门槛（重置必须落在 6 小时内）跳过了逐模型合并，于是界面持续显示粗粒度汇总端点那个无意义的"100%，now+5h 重置"占位值，而账号实际只剩 **4.06%**（2026-10-17 00:37 实测：上报重置 05:37:49 恰好等于刷新时刻+5h，而所有模型行都是 4.06% @ 15:07）。合并现在无条件取各来源中**最低**的剩余值；周额度行照常单独显示。回归测试复现了本次事故的精确数字。
  - **修复：目标完成短路吞掉了真实用户消息。** `isGoalToolContinuation` 在固定尾部窗口里"任意位置"找目标标记：目标完成后立刻发送的消息（目标工具结果还在窗口里）被当成完成跳直接空转结束——连续两次，"把相关的经验整理到agents.md" 根本没到达 agent（2026-10-17，7 秒/16 秒"已完成"但零输出）。扫描改为从末尾回溯，遇到**真实用户指令即停止**（宿主注入的文本——时间采样、system-reminder 包裹、运行时上下文——保持透明），目标标记只有在真正处于末尾时才短路。
  - **测试**：互斥锁取消后移除并唤醒下一个；超时不阻塞队列；丢失唤醒的轮询补偿；`acquireCredentialSlot` 已中止即拒绝、排队中响应 Stop、限时等待可见失败；同账号快路径 / 排空 / 防饿死；配额周边界收紧；目标延续真实消息场景。

## 0.4.58 (2026-10-16)

- **Fix: DSH `/goal` loop restart bug (autonomous runs continuing indefinitely instead of marking complete).**
  - **Root Cause**:
    1. In `src/host/mapper.ts`, whenever an agy run finished with `!ev.ok` (e.g. background EOF/network timeout right as generation finishes), it yielded `{ type: 'finish', reason: { kind: 'stop' } }` and returned early, bypassing the `supportsGoalUpdate` synthetic `update_goal` completion call even when agy generated a full, successful text response. DSH interpreted this as an uncompleted round and scheduled subsequent rounds indefinitely.
    2. In `src/index.ts`, `sessionGoal` attempted to read `session.events`, but DSH `Session` instances store events in `session.log` / `session.snapshotEvents()`, causing session goal resolution to always return `null`.
    3. In `src/host/dsh-goal.ts`, `isGoalToolContinuation` only inspected `messages[messages.length - 1]`. When DSH executes `update_goal`, it defers a `<goal_complete>` user notice (`source.kind: 'tool-goal'`), placing the tool result at `messages.length - 2` and causing agy to respawn on the completion notice.
  - **Fix**:
    1. `EventMapper.map` now unifies the finish path so `update_goal` and `exit_plan_mode` are always dispatched upon successful response generation regardless of trailing transport EOF flags.
    2. `sessionGoal` queries DSH's live `ctx.goals.get(agent)` in O(1) and falls back to `session.log` / `session.snapshotEvents()`.
    3. `isGoalToolContinuation` checks the trailing span for `agytc-bridge-goal-`, `source.kind === 'tool-goal'`, and `<goal_complete>`, finishing cleanly without respawning agy.
    4. Marked `tool-goal` and `<goal_complete>` as synthetic harness messages so they never get treated as human user instructions.

- **Fix: real-time 5-hour quota consumption and rolling countdown now accurately display instead of staying frozen at 100% / blank.**
  - **Root Cause**:
    1. Google's `retrieveUserQuotaSummary` endpoint returns coarse group-level numbers (`gemini-5h: 1.0`), while `fetchAvailableModels` reports the actual per-model 5-hour consumption and active rolling reset time (e.g. `0.70`, reset in 12 minutes). `QuotaService.refreshAccountQuota` gated the per-model tightening behind `else if (familyQuotas[fam]!.remainingFraction === undefined)`, so whenever the coarse summary returned `1.0`, active model usage was completely ignored and the family quota was locked at `100%`.
    2. In `fetchAvailableModels`, hitting any staging endpoint (`daily-cloudcode-pa`) set `this.preferredEndpointIndex`, causing subsequent `retrieveUserQuotaSummary` calls to target the staging endpoint (which omits Gemini entirely).
    3. `mergeFallbackFamilyQuota` returned stale `prev` data whenever `prev.remainingFraction` existed, freezing accounts at their 10:04 AM state (`resetTime` in the past), which caused `formatQuotaWindow` to drop the expired timestamp as empty and render no duration at all.
  - **Fix**:
    1. `fetchAvailableModels` now only sets `preferredEndpointIndex` if the endpoint is the official production endpoint (index 0).
    2. Active 5-hour model consumption (window <= 6h) now tightens `familyQuotas[fam].remainingFraction` and its `resetTime` even when summary returned a coarse `1.0`.
    3. Full-quota rows where `resetTime` has expired safely fall back to "已重置 · 可用" instead of a blank row, while active windows display the real rolling countdown (e.g. `↻ 02:50 (4小时 55分钟)`).

## 0.4.57 (2026-10-16)

### English

- **Fix: transient network jitter no longer sticky-quarantines healthy accounts as "需重新登录".**
  - **Background**: agy prints the same 939-byte "Authentication required" stderr banner whether the login is really dead OR its keyring auth merely missed its hard 10s window on a flaky network. One afternoon of proxy jitter (2026-10-16) quarantined three healthy accounts on first sight; `setActiveAccount` then refused the quarantined slot with 该账号当前不可用（冷却或需重新登录）.
  - **Changes**:
    1. **Log-evidence classification** (`src/host/agy-log.ts` + `looksLikeAuthVerificationJitter`): the adapter now snapshots agy's per-run `cli-*.log` set before spawning and reads this run's log on an auth-shaped failure. `keyringAuth: timed out after 10s` / `failed to fetch user info` / `userinfo request failed` prove a STORED credential existed and only the network was down — the failure is reclassified NETWORK (retryable, rotates, no quarantine). An authoritative token error (`invalid_grant`…) always wins over jitter. Verified against real logs: the genuine sign-out log contains zero occurrences of every jitter marker.
    2. **Confirmation-gated quarantine** (`pool.noteAuthFailure`): a bare, non-authoritative "not signed in" banner no longer sets the sticky `authRequired` flag on the first occurrence — it only rotates the account away for the current retry. The flag hardens into a real quarantine on a second consecutive failure with no success in between; a successful run resets the streak. Authoritative OAuth paths (`invalid_grant` from the token endpoint) and the explicit re-login paths still quarantine immediately.
  - **Tests**: classifier fixtures from the real jitter and sign-out logs; log-reader run attribution; single-strike / streak-reset pool semantics; end-to-end `auth-jitter` fake mode ⇒ NETWORK with no flag, bare `auth` banner ⇒ AUTH with no flag on first sight.

### 中文 (Chinese)

- **修复：瞬时网络抖动不再把健康账号错误地隔离为"需重新登录"。**
  - **背景**：无论登录是真的失效，还是 keyring 鉴权在抖动网络上没赶上 10 秒硬超时，agy 都会打印同一段 939 字节的 "Authentication required" stderr 横幅。2026-10-16 一个下午的代理抖动就让三个健康账号被一次性隔离；随后 `setActiveAccount` 对被隔离账号直接返回 该账号当前不可用（冷却或需重新登录）。
  - **变更**：
    1. **基于日志证据的分类**（`src/host/agy-log.ts` + `looksLikeAuthVerificationJitter`）：适配器在 spawn 前对 agy 的本次运行日志（`cli-*.log`）做快照，出现鉴权形态失败时读取本次日志。`keyringAuth: timed out after 10s` / `failed to fetch user info` / `userinfo request failed` 证明本地确实存有凭据、只是网络不通 —— 此时失败改判为 NETWORK（可重试、轮转、不隔离）。权威的 token 错误（`invalid_grant` 等）永远优先于抖动证据。已用真实日志验证：真正登出的日志中所有抖动标记出现次数为 0。
    2. **隔离需二次确认**（`pool.noteAuthFailure`）：不带权威证据的裸"未登录"横幅，第一次出现不再直接置粘性 `authRequired` 标记，仅为本次重试轮转走；只有连续两次失败且中间没有成功才升级为真正隔离；一次成功运行即清零计数。权威 OAuth 路径（token 端点返回 `invalid_grant`）与显式重新登录路径仍在首次即隔离。
  - **测试**：取自真实抖动/登出日志的分类器用例；日志读取器的"仅本次运行"归属；单次不隔离/成功清零的池语义；端到端 `auth-jitter` 假模式 ⇒ NETWORK 且无标记，裸 `auth` 横幅 ⇒ AUTH 且首次不隔离。

## 0.4.56 (2026-10-16)

### English

- **Feature: Gemini 4 Argon (Pro/Ultra) now shows as its own quota family with its separate weekly limit.**
  - **Background**: Antigravity now grants paid Google AI Pro / Ultra accounts access to **Gemini 4 Argon**, which bills against its OWN weekly quota pool (it does not consume the plain Gemini pool). The backend surfaces this as a dedicated quota group in `retrieveUserQuotaSummary` (display name like "Gemini 4 Argon") and as `gemini-4-argon-low/-medium/-high` model ids in `fetchAvailableModels`.
  - **Changes**:
    1. Added a new `'argon'` entry to `ModelFamily`; `modelFamilyOf` now classifies any id containing `argon` into it BEFORE the generic `gemini-` gate — previously argon ids folded into the `google` family and their usage silently drained/reported the plain Gemini counter.
    2. `QuotaService.refreshAccountQuota` detects the Argon quota group (its display name still contains "gemini", so the argon gate must win) and ingests its weekly bucket into `quotas.argon`; argon model-level breakdown follows the same family.
    3. GUI quota panel: an **Argon** row renders directly under Gemini ONLY when the backend actually returned argon quota data for that account — free plans and accounts without the Argon permission never see an empty Argon panel. Since Argon is a weekly-only counter today, the ghost "5-hour / —" line is suppressed unless the backend reports one.
    4. `/agy pool` status appends `| Argon N% (weekly)` to the Quota line only for accounts that carry argon data.
    5. Cross-family auto-failover (`autoFallbackModel`) intentionally does NOT target the argon family: it is a paid-plan-only pool and must not become a silent fallback for exhausted Gemini quota.
  - **Tests**: argon model-id classification; argon summary group lands in `quotas.argon` without clobbering `quotas.google`; accounts without argon access carry no argon entry (row hidden).

### 中文 (Chinese)

- **功能：Gemini 4 Argon（Pro/Ultra 专属）现在作为独立的额度家族展示，并显示其单独的周额度。**
  - **背景**：Antigravity 已向付费 Google AI Pro / Ultra 账号开放 **Gemini 4 Argon**，它消耗独立的周额度池（不占用普通 Gemini 额度）。后端在 `retrieveUserQuotaSummary` 中以独立的额度组返回（显示名形如 "Gemini 4 Argon"），并在 `fetchAvailableModels` 中返回 `gemini-4-argon-low/-medium/-high` 模型 ID。
  - **改动**：
    1. `ModelFamily` 新增 `'argon'`；`modelFamilyOf` 在通用 `gemini-` 前缀判定**之前**优先识别包含 `argon` 的 ID —— 此前 argon 模型会被归入 `google` 家族，其用量会错误地挤占/上报普通 Gemini 计数。
    2. `QuotaService.refreshAccountQuota` 识别 Argon 额度组（其显示名仍包含 "gemini"，因此 argon 判定必须优先）并把周额度桶写入 `quotas.argon`；模型级明细同样按该家族归类。
    3. GUI 额度面板：仅当后端确实返回了该账号的 argon 额度数据时，才在 Gemini 下方渲染 **Argon** 面板 —— 免费套餐及无 Argon 权限的账号绝不会看到空的 Argon 栏。由于 Argon 目前只有周额度，后端未上报 5 小时窗口时不再显示幽灵的「5 小时额度 —」行。
    4. `/agy pool` 状态输出仅为携带 argon 数据的账号在 Quota 行尾追加 `| Argon N% (weekly)`。
    5. 跨家族自动故障转移（`autoFallbackModel`）刻意不指向 argon 家族：它是付费专属额度池，不应在 Gemini 额度耗尽时被静默兜底。
  - **测试**：argon 模型 ID 分类；argon 额度组写入 `quotas.argon` 且不覆盖 `quotas.google`；无 argon 权限的账号不产生 argon 条目（面板隐藏）。

---

## 0.4.55 (2026-10-16)

### English

- **Fix: Gemini weekly quota displaying as empty/dash (`—`) after sync.**
  - **Root Cause**: `AGY_ENDPOINTS` placed Google's internal staging endpoint (`https://daily-cloudcode-pa.googleapis.com`) ahead of the official production endpoint (`https://cloudcode-pa.googleapis.com`). While the staging endpoint responds HTTP 200, its `retrieveUserQuotaSummary` output completely omits the `Gemini Models` group (returning only `Claude and GPT models`). Consequently, `QuotaService.fetchQuotaSummary` took the 200 response and locked onto the staging endpoint; `familyQuotas['google']` never received the server's weekly bucket and fell back to model-level 5-hour discovery data (`weeklyFraction: undefined`), resulting in the UI rendering Gemini's weekly quota as `—`.
  - **Resolution**:
    1. Reordered `AGY_ENDPOINTS` to prioritize the official production endpoint `https://cloudcode-pa.googleapis.com`, matching the official `agy` CLI binary.
    2. Added a completeness gate in `fetchQuotaSummary`: if an endpoint returns a partial summary that omits the primary `Gemini Models` group, `QuotaService` continues falling through to the remaining endpoints until a complete summary is obtained, rather than locking onto the partial staging response.
- **Feature/Fix: auto-repair common LLM Mermaid syntax flaws and graceful fallback.**
  - **Auto-repair (`repairMermaidSource`)**: When models produce flowchart/graph diagrams with common pseudo-code syntax flaws (e.g. using `+` to join nodes `A + B --> C + D` instead of `A & B --> C & D`, unquoted subgraph titles with colons/spaces like `subgraph 链条1: 工具打制`, or node labels containing unquoted special characters like `T[人口 > 12]`, `S[私有制: 守罐人]`), the client-side renderer now automatically heals these patterns before passing to Mermaid, enabling diagrams to render successfully without errors.
  - **Graceful fallback for auto-sniffed blocks**: If an unrecognized code block (`代码块`) sniffed as Mermaid fails parsing even after auto-repair, the plugin now silently falls back to displaying it as a normal clean code block without rendering an intrusive `Mermaid render failed:` error banner under it.

- **Fix: DSH "Stop generating" (停止生成) button failing in multi-turn tool continuation spans and queues.**
  - **Root Cause**: While single-turn initial spans wired `options.signal` to process termination, tool continuation spans (`detectContinuation(messages) !== null`) and live run debounce rescue invoked `driveSpan` without forwarding `options.signal`. Furthermore, `driveSpanBody` lacked an `abort` event listener, causing the generator to wait indefinitely on `rec.eventsFrom(from)` even when DSH signaled an abort. Similarly, queued requests blocked on `Semaphore.acquire()` did not observe `signal` cancellations.
  - **Resolution**:
    1. Forwarded `options.signal` across all `driveSpan` callsites (continuation, debounce rescue, and initial span).
    2. Attached an `abort` listener in `driveSpanBody` that immediately calls `rec.requestAbort?.()`, terminates the underlying `agy` process, pushes `{ type: 'finish', reason: { kind: 'aborted' } }` into the chunk queue, and closes the stream iterator cleanly.
    3. Added `signal` cancellation support to `Semaphore.acquire(signal)` and burst throttle backoff to release queued requests immediately upon abort.
- **Fix/Feature: Mermaid rendering swallowing source code, wide layout collapse, and interactive view toggle.**
  - **Root Cause**:
    1. Language detection in `fenceLang` matched DSH's generic banner text `"代码块"`, erroneously treating explicitly tagged ````mermaid```` blocks as untagged generic blocks.
    2. Large multi-subgraph flowcharts using Chromium's default `<foreignObject>` HTML labels collapsed into invisible blank boxes when constrained by `max-width: 100%`.
    3. When Mermaid rendering threw or produced an error SVG, the CSS rule hiding code blocks paired with the suppression of error text resulted in swallowing all content—leaving a completely blank white container.
  - **Resolution**:
    1. Corrected `fenceLang` to inspect code block classes and attributes before falling back to banner labels.
    2. Configured Mermaid with `flowchart: { htmlLabels: false }` to render reliable native SVG `<text>` elements, eliminating the Chromium `<foreignObject>` blank-paint bug.
    3. Added an interactive `查看源码 / 查看图表` toggle button allowing users to switch between the visual diagram and raw Mermaid source code at any time.
    4. Guarded against swallowed content: when rendering fails, the original code remains 100% visible alongside a subtle warning banner, ensuring source content is never lost.

### 中文 (Chinese)

- **修复：DSH 界面中点击「停止生成」在多轮工具调用延续期失效的问题。**
  - **根本原因**：在首轮对话中 `options.signal` 正确绑定了进程终止，但在原生工具镜像调用的后续延续轮次（`detectContinuation` 分支）以及防抖拯救调用中，`driveSpan` 均未向下传递 `options.signal`。此外，`driveSpanBody` 内部没有监听 `signal.abort` 事件，导致用户在 DSH 点击停止时，生成器依旧停在 `eventsFrom` 等待事件流，后台进程未被杀死，界面停止按钮卡住无效。同时跨会话并发信号量 `Semaphore.acquire()` 在排队等待时也未响应取消信号。
  - **解决方案**：
    1. 在所有 `driveSpan` 调用处（工具延续、防抖拯救、首轮启动）完整传递 `options.signal`。
    2. 在 `driveSpanBody` 挂载 `abort` 监听器：一旦收到取消信号，立即触发 `rec.requestAbort?.()` 杀死底层 `agy` 进程，向输出队列推送 `{ type: 'finish', reason: { kind: 'aborted' } }` 并安全关闭队列，使 DSH 的流式迭代器瞬间退出。
    3. 升级 `Semaphore.acquire(signal)` 及并发节流延时，支持在排队中收到 abort 信号时立即退出并清理队列，杜绝无意义挂起。
- **修复/功能：Mermaid 图表内容被吞、超宽图表缩放空白及源码交互式切换。**
  - **根本原因**：
    1. `fenceLang` 语言嗅探提取到了 DSH 顶部横幅文本 `"代码块"`，导致显式声明为 ````mermaid```` 的图表被误当成未指定语言的通用块。
    2. Mermaid 默认使用 HTML `<foreignObject>` 标签渲染文本，在 Chromium / Electron 宿主中遇到多子图超宽流程图（如 >3000px）并应用 `max-width: 100%` 缩放时，极易发生文本排版崩溃或整体空白不渲染的 bug。
    3. 当 Mermaid 渲染报错或生成空图时，由于隐藏原生代码块的 CSS 规则生效且错误提示被隐藏，导致原始代码和图表全部消失，形成一片空白区域（内容被吞）。
  - **解决方案**：
    1. 修正 `fenceLang`：优先读取 `code` 标签 class 及属性，忽略无意义的横幅标签 `"代码块"`。
    2. 优化渲染配置：初始化 Mermaid 时启用 `flowchart: { htmlLabels: false }`，使用原生 SVG `<text>` 渲染节点，彻底规避 Chromium `<foreignObject>` 缩放渲染空白的底层缺陷。
    3. 增加交互式切换工具栏：在渲染图表右上角提供「查看源码 / 查看图表」按钮，用户可随时一键切换查看 Mermaid 原始 Markdown 代码与可视化图表。
    4. 兜底保护机制：若渲染异常，确保原始代码块 100% 完整保留可见，并在上方以友好提示条展示，绝不吞没用户和模型的内容。

- **修复：点击「同步」后 Gemini 周额度显示为空/短横杠（`—`）的问题。**
  - **根本原因**：`AGY_ENDPOINTS` 此前将 Google 内部预演端点（`https://daily-cloudcode-pa.googleapis.com`）排在官方生产端点（`https://cloudcode-pa.googleapis.com`）之前。虽然预演端点返回 HTTP 200，但其 `retrieveUserQuotaSummary` 响应中完全缺失了 `Gemini Models` 额度组（仅返回了 `Claude and GPT models`）。这导致 `QuotaService.fetchQuotaSummary` 命中 200 后锁定该端点，`familyQuotas['google']` 无法获取到官方周配额桶，只能回退使用单模型 5 小时数据（`weeklyFraction` 始终为 `undefined`），前端进而将 Gemini 的周额度渲染为 `—`。
  - **解决方案**：
    1. 调整 `AGY_ENDPOINTS` 顺序：优先请求与官方 `agy` CLI 保持一致的官方生产端点 `https://cloudcode-pa.googleapis.com`。
    2. 增强 `fetchQuotaSummary` 完整性校验门禁：若端点返回的配额摘要缺失了核心的 `Gemini Models` 组，自动顺次下穿到后续端点获取完整摘要，不再过早锁定仅包含第三方模型的残缺响应。
- **功能/修复：Mermaid 常见大模型语法自动自愈修复与优雅降级。**
  - **语法自动自愈（`repairMermaidSource`）**：针对大模型输出流程图时高频出现的伪代码语法瑕疵（例如材料合成中用加号连接 `A + B --> C + D`、包含冒号的子图未加引号 `subgraph 链条1: 工具打制`、节点文本包含特殊字符未加引号 `T[人口 > 12]`、`S[私有制: 守罐人]` 等），客户端在解析前自动自愈修正，直接成功渲染图表。
  - **自动嗅探代码块优雅降级**：对于未显式标注为 ````mermaid```` 的通用代码块（语言标签为 `代码块` 或未指定），若自愈后仍无法解析，安静降级为普通代码块展示，不再在代码下方直接打印刺眼的 `Mermaid render failed:` 错误文本。

## 0.4.54 (2026-10-16)

### English

- **Fix (macOS): complete resolution for recurring modal keychain password prompts.** Older versions (v0.4.41-v0.4.48) accidentally ran `security default-keychain -s <isolated-kc>`, permanently redirecting the user's desktop session `default-keychain`, `login-keychain`, and user search list (`list-keychains -d user`) to a locked per-account keychain under `~/.dsh/agy-accounts/` created with an un-unlockable random passphrase. On modern macOS, `Library/Keychains/login.keychain-db` is also a special-cased filename that SecurityServer associates with the user's OS login password, rejecting empty-passphrase unlocks. The plugin now:
  1. Automatically detects and repairs hijacked `default-keychain`, `login-keychain`, and `list-keychains` on boot (`repairMacSystemKeychain`), restoring the real user login keychain (`~/Library/Keychains/login.keychain-db`) safely and idempotently.
  2. Automatically purges legacy un-unlockable isolated keychains (`purgeStaleIsolatedKeychain`), unregistering them from `securityd` and deleting conflicting files so SecurityAgent never raises unanswerable password dialogs.
- **Feature (Multi-platform): comprehensive cross-platform logic unification.**
  1. **Unified Terminal Launcher (`openAccountTerminal`)**: Fully unified interactive terminal launching across macOS (AppleScript Terminal.app), Windows (`cmd.exe /c start` with `USERPROFILE` + `HOME` environment and `windowsHide: true`), and Linux (adaptive detection across `xdg-terminal-exec`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `alacritty`, `xterm`).
  2. **Unified System Proxy Detection (`detectSystemProxy`)**: Automatically discovers system-wide proxy settings for GUI environments where shell env vars are missing—supporting macOS (`scutil --proxy`), Windows Registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`), Linux desktop (`gsettings` GNOME proxy mode), and fallback environment variables (`ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`).
  3. **Cross-Platform Credential Isolation**: Standardized credential boundaries across platforms—Windows Credential Manager targeted isolation, macOS isolated throwaway keychains with auto-repair, and standard Unix file-based isolation.

### 中文 (Chinese)

- **修复（macOS）：彻底解决钥匙串密码弹窗反复弹出问题。** v0.4.41-v0.4.48 曾调用 `security default-keychain -s <isolated-kc>`，导致用户的桌面会话全局 `default-keychain`、`login-keychain` 以及用户搜索列表被持久化重定向到了 `~/.dsh/agy-accounts/` 下由旧版本生成的随机密码隔离钥匙串中。此外 macOS 的 SecurityServer 会对名为 `login.keychain-db` 的路径做特殊绑定，强制要求系统用户登录密码，导致空密码解锁失败并引发系统 SecurityAgent 弹窗提示输入密码。本次修复：
  1. 插件启动时自动执行 `repairMacSystemKeychain`：检测并修复被篡改的 `default-keychain`、`login-keychain` 与用户搜索列表，自动恢复为用户真实的登录钥匙串（`~/Library/Keychains/login.keychain-db`），幂等且安全。
  2. 自动检测并清理历史遗留的无法解锁的废弃钥匙串（`purgeStaleIsolatedKeychain`），从 `securityd` 会话中彻底注销并删除文件，阻断 SecurityAgent 弹出任何死循环密码框。
- **功能（多平台）：全面梳理并实现 Windows、macOS、Linux 跨平台逻辑统一。**
  1. **多平台统一终端唤醒器（`openAccountTerminal`）**：彻底统一账号登录终端的唤醒逻辑，原生支持 macOS（AppleScript 激活 Terminal.app）、Windows（`cmd.exe /c start` 注入 `USERPROFILE` + `HOME` 隔离目录并设置 `windowsHide: true` 避免控制台闪烁）以及 Linux（自适应探测 `xdg-terminal-exec`、`x-terminal-emulator`、`gnome-terminal`、`konsole`、`xfce4-terminal`、`alacritty`、`xterm` 等各种桌面环境）。
  2. **多平台系统代理自动感知（`detectSystemProxy`）**：针对 GUI 宿主未继承终端 Shell 代理环境变量的场景，全面支持三端系统级代理自动检测——macOS（`scutil --proxy` 解析 HTTP/HTTPS/SOCKS）、Windows（读取注册表 WinINet Internet Settings 代理设置）、Linux（通过 `gsettings` 读取 GNOME 桌面代理配置）以及标准环境变量兜底。
  3. **多平台凭据与隔离统一**：规范各端凭据存储边界——Windows 使用 Credential Manager 目标隔离、macOS 使用独立钥匙串配给加自愈防篡改机制、Linux 使用标准 Unix 用户目录隔离。

## 0.4.53 (2026-10-15)

### English

- **Fix: a NUL byte in a tool result can no longer kill the turn before agy starts.** Tool output that quoted binary content (an agent listing or reading a `.git` directory, a packed object, an image) carried U+0000 into the assembled prompt; because the prompt travels as an `-p` argv element, `spawn()` rejected it with `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[16]' must be a string without null bytes` and the turn failed as "failed to spawn agy" before agy was ever launched — the retry re-sent the same history and failed identically, so the session could not make progress. `stripNulBytes()` now removes U+0000 from the rolling digest (per message text), from the final prompt on its single path into `buildArgs` — covering both the argv transport and the `--input-format stream-json` stdin transport — and from the one-shot/compaction prompt after file inlining. Every other control character is legal in argv and is left untouched.

### 中文 (Chinese)

- **修复：工具结果里的 NUL 字节不再让整个轮次在 agy 启动前就崩溃。** 当工具输出引用了二进制内容（agent 列出或读取 `.git` 目录、packed object、图片等）时，U+0000 会被带进拼装好的提示词；提示词以 `-p` 参数进入 argv，`spawn()` 因此抛 `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[16]' must be a string without null bytes`，整轮以「failed to spawn agy」失败——重试会重发同一段历史，于是同样失败，会话彻底卡死。现在 `stripNulBytes()` 会从三处移除 U+0000：滚动摘要中每条消息的文本、进入 `buildArgs` 前的最终提示词（同时覆盖 argv 与 `--input-format stream-json` 的 stdin 两种传输）、以及一次性/压缩任务内联文件后的提示词。其余控制字符在 argv 中合法，保持原样。

## 0.4.52 (2026-10-15)

### English

- **Fix: DSH `/goal` infinite continuation loop resolved.** In DSH, `/goal` runs a multi-round state machine (up to 256 rounds) that keeps injecting `<goal_round>` until the agent explicitly invokes `update_goal(action='complete')`. Because `agy` CLI uses its own native tools and terminates after finishing, DSH treated the goal as perpetually active (running up to 93+ rounds). The bridge now intercepts the completion event in goal mode and emits a synthetic `update_goal(complete)` tool-call, properly closing the goal state machine.
- **Feature: DSH `/plan` mode support.** When running in plan mode (prompt containing "You are in plan mode"), the bridge automatically emits the `exit_plan_mode` tool-call carrying the generated plan markdown for user interactive review and approval.
- **Feature: /agy goal command family.** Added `/agy goal [status|complete|pause|resume|clear]` allowing users to inspect the current goal state (ID, revision, objective, round count) or manually control/complete/clear the active goal.
- **Feature: /agy session command family.** Added `/agy session [info|clear]` for inspecting session workspace CWD, bound agy conversation ID, event counts, and safely dropping session bindings without guessing. `/agy clear` is also upgraded to prioritize the current session.
- **Feature: Intelligent quota-expiry-first rotation (Weekly & 5h).** Refactored pool candidate selection: when switching accounts, the pool prioritizes accounts whose weekly quota is expiring soonest (Priority 1: preventing irreversible weekly quota loss), followed by accounts whose 5-hour quota is expiring soonest (Priority 2). Execution maintains seamless sticky sequential drain, continuing on the current account until its quota is exhausted before cleanly advancing to the next optimal candidate.
- **UI: Simplified thinking turn banner.** Replaced verbose `[agy thinking turn · N thinking tokens]` chip with concise `[agy · N tokens]` (or `[agy]` when no count is present), avoiding long headers crowding out the collapsed reasoning summary in DSH.
- **UI: Removed redundant "Set as primary" action.** Dropped the confusing "Set as primary" button from the account cards across all locales. Manual account activation is cleanly handled via the existing "Set as in use" action.

### 中文 (Chinese)

- **修复：彻底解决 DSH `/goal` 目标空转死循环问题。** DSH 的 `/goal` 状态机在模型未调用宿主原生 `update_goal(action='complete')` 前，会在每轮结束后自动注入 `<goal_round>` 启动下一轮（最多 256 轮，曾导致 93+ 轮空转）。由于 agy 是自闭环 Agent 引擎，完成任务后正常退出但不会直接调用 DSH 宿主工具。桥接层新增 `dsh-goal` 协议转换模块，在检测到目标轮次执行完毕后，自动向 DSH 发射 `update_goal(complete)` 工具调用块，使 DSH 目标状态机正常流转至完成态并停止重试。
- **功能：支持 DSH `/plan` 规划模式适配。** 当检测到会话处于规划模式（上下文携带 "You are in plan mode"）时，桥接层在模型生成规划后自动发射 `exit_plan_mode` 工具调用块，将规划 Markdown 提交给 DSH 宿主渲染审核弹窗供用户审批。
- **功能：新增 `/agy goal` 目标管理命令。** 支持 `/agy goal [status|complete|pause|resume|clear]`，可实时查看当前会话的目标状态（目标 ID、版本号、目标描述、已执行轮次/上限），或手动完成、暂停、恢复、清除卡住的目标。
- **功能：新增 `/agy session` 会话管理命令。** 支持 `/agy session [info|clear]`，可精确查看当前 DSH 会话绑定的工作区 CWD、agy 会话 ID、事件总数等信息，或一键清除当前会话的 agy 绑定；同时增强 `/agy clear` 优先清理当前活动会话的绑定。
- **功能：按配额临期优先度智能轮换账号（周额度优先，5小时次优）。** 重构账号轮换调度算法：在切号时，第一优先级优先选取周额度剩余时间最少（最先到期）的账号（避免周硬额度清零浪费），第二优先级选取 5 小时窗口最先到期的账号；同时严格遵循无感黏性消耗原则（只要当前账号的 5 小时或周额度未耗尽绝不切号，耗尽后自动无缝切换下一个最优账号），最大化利用全部账号配额。
- **体验：精简思考过程标签（thinking banner）。** 将冗长的 `[agy thinking turn · N thinking tokens]` 简化为精炼的 `[agy · N tokens]`（无计数时为 `[agy]`），大幅缩减括号内字符宽度，让 DSH 折叠思考栏能够更完整展现具体的思维链与工具摘要。
- **体验：移除冗余的“设为主用”按钮。** 从前端控制台卡片操作栏和各语言包中彻底移除“设为主用”按钮，手动切换账号统一由“设为当前使用”负责，简化界面操作。

## 0.4.51 (2026-10-15)

### English

- **Feature: Per-account Enable / Disable toggles.** Added dedicated Enable / Disable buttons and status badges to each account card in the WebUI console and CLI (`/agy enable-account <id>`, `/agy disable-account <id>`). Disabled accounts are dimmed with a gray "Disabled" badge.
- **Fix: Account rotation and selection strictly skips disabled accounts.** Rotation algorithms (`selectAccount`, `advanceAccount`, sticky sequential drain, round-robin, and fallback model degradation) skip disabled accounts completely.
- **Fix: Cooldown & quota reset fallback never returns a disabled account.** `getActiveAccountId` previously fell back to `primaryAccountId` or the first account without checking `enabled`, which could surface a disabled slot as active; it now only falls back to eligible enabled accounts (or `undefined` if all accounts are disabled).
- **Fix: Background auth reverification skips disabled accounts.** `needsAuthReverify` now checks `account.enabled`, preventing the background quota poller from probing disabled slots.
- **Fix: Detailed error diagnostics when accounts are disabled.** When all or remaining accounts cannot serve a model family, the error message explicitly enumerates disabled slots and informs the user to re-enable them in the console or CLI rather than reporting misleading 0 cooldown/auth counts.

### 中文 (Chinese)

- **功能：每个账号增加启用 / 停用按钮。** 在 WebUI 控制台的每个账号卡片上以及 CLI 命令中增加了启用/停用按钮与操作（`/agy enable-account <id>`、`/agy disable-account <id>`）。停用账号卡片以半透明呈现并标记灰色“已停用”徽章。
- **修复：切号与调度严格跳过停用账号。** 顺次耗尽（sequential）、轮询（round-robin）、主动切号（advanceAccount）、跨家族自动降级（autoFallbackModel）等调度算法在选号时全部严格跳过已停用账号。
- **修复：号池活动指针降级不再回退到已停用账号。** 修复了 `getActiveAccountId` 在全部账号限流时无条件 fallback 到主账号或首个账号导致停用账号被当作当前在用账号的缺陷；现在严格仅回退到已启用的账号（若全部账号均被停用则返回 `undefined`）。
- **修复：后台静默身份复验跳过已停用账号。** `needsAuthReverify` 增加了 `account.enabled` 检查，彻底杜绝后台轮询向 Google 请求复验已停用账号。
- **修复：账号不可用时清晰提示停用状态。** 当全部或部分账号不可用时，错误提示中会明确指出有几个账号处于“已停用”状态，并提示用户在控制台或通过 CLI 重新启用，不再报出误导性的 0 冷却/0 登录错误。

## 0.4.50 (2026-10-14)

### English

- **Fix: the header badge now names the same account as the console.** The session header applied an eligibility fallback chain (any enabled account, else `accounts[0]`) when the server-scheduled slot was cooling down or auth-flagged, so it displayed a DIFFERENT account than the console modal's "in use" badge. The header is a readout, not a picker: it now displays exactly `pool.activeAccountId`, with the dot turning red/amber for auth-required/cooldown states.

### 中文 (Chinese)

- **修复：顶栏徽章与控制台显示同一个账号。** 当服务端调度的账号处于冷却或被标记时，会话顶栏会走降级链（任选其他合格账号，再不行取第 1 个），导致与控制台弹窗的"当前使用"徽章显示不同的账号。顶栏是状态显示器而不是选择器：现在严格显示 `pool.activeAccountId`，账号需重新登录/冷却中时圆点相应变红/变黄。

## 0.4.49 (2026-10-14)

### English

- **Removal: Gemini Web (chat.gemini.google.com) account support is gone.** The whole web-login feature was removed per user request: the reverse-engineered web client, isolated-profile browser capture, the five `/plugins/agy-link/pool/*` web routes, the web execution branch in the adapter, web quota handling, all `web.*` UI (type switcher, browser picker, capture progress, test/re-login buttons, Web badge) and locale strings. Legacy `gemini-web` entries in `pool.json` are dropped automatically on load, with dangling active/primary pointers cleaned up. Existing AGY accounts are untouched.
- **Fix (macOS): keychain password popups are gone for good.** `ensureIsolatedKeychain` never touches the user's global `default-keychain` / search list anymore (the per-account isolated keychain under the account HOME is enough), and `readMacKeychainToken` now targets the real `~/Library/Keychains/login.keychain-db` explicitly instead of whatever the hijacked default pointed at. Stale locked keychains from the pre-0.4.45 random-password era should be deleted once — they are unanswerable prompts by construction.
- **Fix: a dead agy child can no longer crash the whole DSH host.** EPIPE on child stdin arrives asynchronously as an `error` event (the old `try/catch` only guarded sync throws); `startAgyProcess` now attaches a no-op error handler so a `WriteWrap.onWriteComplete write EPIPE` uncaughtException — and the crash dialog — cannot happen from our spawns.
- **Fix: "needs re-login" no longer shows for healthy accounts.** The Gemini-Web error path flagged accounts on bare `401`/`403`/`unauthorized` substrings, quarantining healthy slots whenever transport noise happened to contain those digits; flagged accounts skip background polling, so only a manual sync could disprove the flag. The web branch is gone entirely, and the auth-flag classifier keeps its transport-noise exemptions.
- **Fix: the header badge no longer flashes "AGY (0)" with a grey dot.** The status snapshot is now persisted in `localStorage` and preloaded on mount (stale-while-revalidate), so session switches render the last known account immediately; the truly-cold first render shows a neutral `AGY` placeholder instead of a misleading zero count.

### 中文 (Chinese)

- **移除：Gemini 网页端（chat.gemini.google.com）账号支持。** 应用户要求整体移除网页登录功能：逆向网页客户端、独立 Profile 浏览器捕获、5 个 `/plugins/agy-link/pool/*` 网页路由、adapter 中的网页执行分支、网页配额处理、全部 `web.*` 界面（类型切换、浏览器选择、捕获进度、测试连接/重新登录按钮、Web 徽章）与语言串。`pool.json` 中遗留的 `gemini-web` 账号会在加载时自动剔除，悬空的 active/primary 指针同步清理；现有 AGY 账号不受影响。
- **修复（macOS）：钥匙串密码弹窗彻底消失。** `ensureIsolatedKeychain` 不再触碰用户全局的 `default-keychain` / 搜索列表（账号 HOME 下的隔离钥匙串已足够）；`readMacKeychainToken` 显式指向真实的 `~/Library/Keychains/login.keychain-db`，不再受被篡改默认值影响。0.4.45 之前随机密码时代遗留的锁定钥匙串需手动删除一次——它们天然是无法回答的弹窗。
- **修复：agy 子进程死亡不再拖垮整个 DSH 宿主。** 子进程 stdin 上的 EPIPE 以异步 `error` 事件到达（旧的 `try/catch` 只能挡同步异常）；`startAgyProcess` 现在挂载 no-op 错误监听，`WriteWrap.onWriteComplete write EPIPE` 不可捕获异常与崩溃弹窗不会再由我们的拉起触发。
- **修复：健康账号不再显示"需重新登录"。** 网页版错误路径曾用裸 `401`/`403`/`unauthorized` 子串拉黑账号，传输噪音消息里碰巧带这些数字就隔离健康槽位；被标记账号会被后台轮询跳过，只有手动同步能翻案。该分支已整体移除，拉黑分类器保留传输噪音豁免。
- **修复：顶部徽章不再闪烁灰色 `AGY (0)`。** 状态快照现在持久化到 `localStorage` 并在挂载时预加载（stale-while-revalidate），切换会话立即显示上次的账号；真正冷启动的首帧显示中性 `AGY` 占位，而不是误导性的 0 计数。

## 0.4.48 (2026-10-13)

### English

- **Feature: Google Account email retrieval & verification.** Enhanced browser login CDP extraction and `extractSnlm0e` regex across multi-language Google interfaces (including Chinese `Google 账号 / 帐号`, `WIZ_global_data`, and custom workspace domains). Verified emails are automatically saved and displayed as an email badge on account cards upon addition and connection testing.
- **Feature: Isolated per-account browser profiles.** Each Gemini Web account now runs in a dedicated, isolated browser profile directory (`~/.dsh/agy-accounts/<accountId>/browser-profile`). Multiple accounts maintain independent cookie jars, session stores, and locks, eliminating session cross-contamination and allowing seamless multi-account management.
- **Feature: Dynamic Gemini Web build (`bl`) & update sniffing.** Live sniffing of Google's frontend build label (`bl`, e.g. `boq_assistant-bard-web-server_...`) directly from HTML during login, connection tests, and periodic probes, dynamically passed to `StreamGenerate` RPC. Stale sessions, cookie expirations, and token rotations are automatically detected, with immediate UI alerts and a dedicated re-login button.
- **Feature: Dedicated proxy URL for Antigravity OAuth login.** Added a per-account proxy URL configuration input to the Google Antigravity OAuth tab, consistent with Gemini Web accounts, ensuring reliable authentication in domestic network environments.
- **Feature: Direct model mapping & removed `gemini-3.1-pro` fallback.** Removed the fictional `gemini-3.1-pro` fallback and purged it from `DEFAULT_FALLBACK_MODELS`. Requests directly preserve and map to the exact model selected by the user.
- **Feature: Real-time dynamic model catalog.** Wired `ModelCatalog` updates to notify DSH via `notifyPicker()` (`llm/adapters-updated`), and integrated automatic background refreshes so newly discovered `agy` models immediately appear in the DSH model picker without restarting DSH.
- **Feature: Active model synchronization with DSH composer picker.** When model auto-failover, default resolution, or Gemini Web mapping switches the active model, the new model is synchronized back to the active DSH session (`model/selection`), updating the model chip in the bottom-right corner of the composer.
- **Fix: Eliminated modal screen flickering and refresh loop.** Implemented singleton portal mounting (`registerModalInstance` / `unregisterModalInstance`), moved global modal styles out of the React render tree into a one-time `<head>` injection, and added payload equality guards (`isStatusEqual`) on polling intervals to eliminate duplicate renders and flickering.

### 中文 (Chinese)

- **新增特性：Google 账号邮箱回显与连通性验证。** 全面强化 CDP 浏览器捕获与 `extractSnlm0e` 正则解析，支持中文界面（`Google 账号 / 帐号`）、`WIZ_global_data` 及任意域名 Google 邮箱；添加与测试连接时均自动保存并回显邮箱徽章于卡片上。
- **新增特性：每个账号完全独立的浏览器隔离 Profile。** 每个 Gemini 网页端账号分配并持久化独占的 profile 目录（`~/.dsh/agy-accounts/<accountId>/browser-profile`）；多账号各自拥有独立 Cookie、会话与锁文件，多账号并行登录或切换互不干扰、互不污染。
- **新增特性：动态嗅探 Gemini 官方最新构建版本（`bl`）与状态。** 实时从页面嗅探 Google 最新前端构建版本号（`bl`，如 `boq_assistant-bard-web-server_...`）并动态传递至 `StreamGenerate` RPC；自动捕获 Session 状态变化与凭据失效，卡片提供一键「重新登录」按钮。
- **新增特性：Google Antigravity（OAuth 授权）独立代理配置。** 在 Google Antigravity 添加弹窗中新增独立代理 URL 输入框，与网页端账号保持一致，国内网络环境下直连或代理灵活切换。
- **新增特性：模型精准直接映射与彻底移除 `gemini-3.1-pro`。** 彻底移除虚构的 `gemini-3.1-pro` 强制降级逻辑，并从系统默认候选模型中删除；用户选择什么模型就直接映射到什么模型，原汁原味。
- **新增特性：模型列表无需重启 DSH 实时刷新。** 将 `ModelCatalog` 更新与 `notifyPicker()` (`llm/adapters-updated`) 连通，并引入定期检测与触发式刷新；agy 本地更新模型后，DSH 输入框模型选择器即时自动呈现最新列表，无需重启应用。
- **新增特性：自动切模型实时回显到 DSH 输入框右下角。** 当额度耗尽自动切模型、默认模型解析或网页端模型映射发生时，自动向当前会话广播同步 `model/selection`，使 DSH 右下角模型选框即时同步回显当前真实运行的模型。
- **优化与修复：彻底解决控制台频繁刷新与闪屏问题。** 引入弹窗单例守卫（`registerModalInstance` / `unregisterModalInstance`）防止多头部重复挂载，将全局样式抽离至 `<head>` 单次注入避免全页重排，并在轮询时加入状态深比较（`isStatusEqual`）杜绝无效渲染。

## 0.4.47 (2026-10-13)

### English

- **Merge (2026-10-13): the recovered working tree is back on top of 0.4.46, and Windows pool-credential isolation is real again.** Upstream's line stays the baseline (adapter spawn-window slot ownership, async keychain/Credential-Manager reads, desktop thinking visibility #43, the vendored mermaid renderer with no CDN fallback plus its error-bomb sweep, model visibility, pool/data hardening). Restored on top of it: the Windows Credential Manager handoff described below, the local `/plugins/agy-link/media` route with the image lightbox and decision chips, Windows system-proxy auto-detection (WinINet registry), the pool corruption diagnostics/repair scripts, and the `src/host/wincred.ts` primitives. Merge calls worth knowing: `runner.ts`, `assets/mermaid.min.js`, `src/client/mermaid.ts` and the proxy/keychain test take upstream (equivalent fixes, already hardened — the duplicate mermaid renderer and its tests were dropped); `quota.ts` keeps upstream's async read *and* the durable-store-first primary resolution; the `credentialIsolationLimited` warning (status field, adapter log, settings banner, four locale strings) is gone now that rotation isolates credentials; and the real Credential Manager slot is never touched under `node:test`.
- **Fix (critical): multi-account pools no longer cross-contaminate credentials on Windows, and quota failover works again.** On Windows, `agy.exe` resolves its Google credential from ONE process-global store (Credential Manager target `gemini:antigravity`); `HOME`/`USERPROFILE` are ignored, so a per-account directory does not isolate credentials the way a per-account Keychain does on macOS. The previous handoff logic corrupted a real pool: all four accounts ended up holding the primary's refresh token, every quota row reported the same identity, and clicking "refresh/sync" appeared to replace the main account. Three defects were fixed:
  - The handoff snapshotted "whatever is currently in the slot" as the primary backup. A secondary run could therefore overwrite the backup with a secondary credential, and the next restore installed that secondary as the system-wide login. The primary credential is now resolved from a durable, identity-VERIFIED store (`agy-accounts/.primary-credential.json`) and is never inferred from the live slot.
  - The restore step wrote the slot's content back into the account's token file whenever it differed. While another account owned the slot this copied a FOREIGN credential into the account file. Write-back now requires that the slot still carries THAT account's refresh token; otherwise nothing is written and a warning is logged.
  - Nothing serialized slot ownership, so interactive runs, background quota polls and manual refreshes raced. A process-wide FIFO mutex (`AsyncMutex`) now spans the entire run.
- **Add: a run is refused instead of silently using the wrong account.** `acquireCredentialSlot` throws `SlotUnavailableError` (surfaced as `AGY_ERROR`) when the slot cannot be handed back safely: the primary credential cannot be verified, the secondary has no credential, or the secondary holds the SAME grant as the primary. This stops a corrupted slot from quietly spending the primary's quota.
- **Fix: quota refresh can no longer relabel or overwrite an account.** An isolated account resolved to another slot's email is now quarantined (`authRequired`) instead of being relabeled; an isolated account whose stored credential equals the primary's is quarantined offline before any network call. The durable store is consulted before the volatile slot for the primary, so a mid-handoff slot can no longer make the primary row display a secondary's numbers.
- **Fix: refreshed tokens keep their refresh token and agy's nested on-disk shape.** The writer used to emit a flat `{access_token,expiry}` document when the file did not exist yet, silently DROPPING `refresh_token`. A credential without a refresh token has no stable identity across access-token rotations, which disabled every identity guard. The writer now always emits `{"token":{…},"auth_method":"consumer"}` and preserves the refresh token.
- **Add: identity comparison anchored on the OAuth grant.** `sameCredentialGrant()` requires a refresh token on both sides ("cannot prove it" means "not the same"); adoption of a primary credential now skips candidates without a refresh token so the durable store can never be degraded.
- **Add: corruption diagnostics and repair tooling.** `findDuplicateCredentialIdentities()` reports accounts sharing one login, and the boot log now warns loudly. `scripts/repair-pool.mts` (dry-run by default, `--apply` to write) restores the primary slot and quarantines overwritten accounts; `scripts/verify-credential-store.mts` verifies the store's live identity. Running `pnpm test` no longer touches the real pool directory — credential handling is anchored on `AccountPoolManager.dir` instead of a process-global path.
- **Fix: a malformed `mermaid` block no longer paints Mermaid's own "Syntax error in text" bomb into the page.** Mermaid's standalone renderer appends a temporary `<div id="d<id>">` to `document.body` and, when a diagram fails to parse, draws its built-in error diagram into that div *instead of throwing* — so the failure never reached our `catch`, and the bomb escaped the message card and floated detached at the end of the page. The runtime is now initialized with `suppressErrorRendering: true`, every block is pre-validated with `mermaid.parse(text, { suppressErrors: true })` before `render()` runs, and a sweep removes body-level error diagrams left behind by older client builds. Invalid or still-streaming diagrams simply keep their original code block, and an unchanged failing block is no longer re-parsed on every DOM mutation.

### 中文

- **合并（2026-10-13）：被舍弃的工作区内容重新叠加回 0.4.46，Windows 账号池凭据隔离真正恢复。** 以上游为主线（适配器 spawn 窗口槽位归属、异步钥匙串/凭据管理器读取、桌面端思考可见性 #43、无 CDN 的本地 mermaid 渲染器与其错误炸弹清理、模型可见性、账号池与数据加固），在其之上恢复：下述 Windows 凭据管理器交接、本地 `/plugins/agy-link/media` 路由与图片灯箱/决策芯片、Windows 系统代理自动探测（WinINet 注册表）、账号池串号诊断与修复脚本、以及 `src/host/wincred.ts` 原语。几处取舍：`runner.ts`、`assets/mermaid.min.js`、`src/client/mermaid.ts` 与 proxy/keychain 测试取上游（同类问题已被上游加固，重复的 mermaid 实现与其测试被删除）；`quota.ts` 同时保留上游的异步读取与你的「持久化存储优先」主账号解析；轮巡已能真正隔离凭据，因此 `credentialIsolationLimited` 警告（状态字段、适配器日志、设置面板横幅、四语言文案）全部移除；`node:test` 下绝不触碰真实凭据管理器槽位。
- **修复（严重）：Windows 下多账号池不再串号，额度耗尽切换恢复正常。** Windows 上 `agy.exe` 只从**一个全局凭据槽**（凭据管理器 `gemini:antigravity`）读取 Google 凭据，`HOME`/`USERPROFILE` 被忽略，因此「每账号独立目录」并不像 macOS 的独立钥匙串那样隔离凭据。旧的手递逻辑破坏了一个真实账号池：四个账号全部持有主账号的 refresh token、每一行额度都显示同一个身份、点击「刷新/同步」看起来会把主账号替换掉。本次修复三个缺陷：
  - 旧逻辑把「当前槽里的内容」当作主账号备份快照，于是副账号运行会用自己的凭据覆盖备份，下次恢复就把副账号装成了系统级登录。现在主账号凭据来自**经过身份校验的持久化存储**（`agy-accounts/.primary-credential.json`），绝不从活动槽推断。
  - 恢复阶段只要发现槽内容与账号文件不同就写回账号文件；当槽被别的账号占用时，这会把**别人的凭据**写进该账号文件。现在写回前必须确认槽仍持有**该账号自己的 refresh token**，否则不写并记录警告。
  - 槽的归属完全没有串行化，交互运行、后台额度轮询、手动刷新互相竞争。现在由一个进程级 FIFO 互斥锁（`AsyncMutex`）覆盖整个运行周期。
- **新增：无法安全交接时直接拒绝运行，而不是悄悄用错账号。** `acquireCredentialSlot` 在以下情况抛出 `SlotUnavailableError`（表现为 `AGY_ERROR`）：无法验证主账号凭据、副账号没有凭据、或副账号持有与主账号**相同的授权**。这阻止了被污染的槽偷偷消耗主账号额度。
- **修复：额度刷新不再改名或覆盖账号。** 独立账号解析出的邮箱若属于另一个槽，改为**隔离**（`authRequired`）而不是改名；独立账号的凭据与主账号相同的，在任何网络请求之前就离线隔离。主账号优先读取持久化存储而非易变的槽，中途被交接的槽再也无法让主账号行显示副账号的数字。
- **修复：刷新后的 token 保留 refresh token 与 agy 的嵌套磁盘格式。** 旧写入器在文件不存在时会写成扁平 `{access_token,expiry}`，**静默丢弃 `refresh_token`**。没有 refresh token 的凭据在 access token 轮换后就没有稳定身份，导致所有身份守卫失效。现在固定写入 `{"token":{…},"auth_method":"consumer"}` 并保留 refresh token。
- **新增：以 OAuth 授权为锚的身份比较。** `sameCredentialGrant()` 要求双方都有 refresh token（「无法证明」即视为「不同」）；主账号凭据的采纳会跳过没有 refresh token 的候选，持久化存储因此不会再被降级。
- **新增：串号诊断与修复工具。** `findDuplicateCredentialIdentities()` 报告共享同一登录的账号，启动日志会明确告警。`scripts/repair-pool.mts`（默认 dry-run，加 `--apply` 才写入）恢复主账号槽并隔离被覆盖的账号；`scripts/verify-credential-store.mts` 校验存储的真实身份。`pnpm test` 不再触碰真实账号池——凭据处理改为锚定 `AccountPoolManager.dir` 而非进程级全局路径。
- **修复：语法错误的 `mermaid` 代码块不再把 Mermaid 自带的「Syntax error in text」炸弹图渲染到页面上。** Mermaid 独立版渲染器会向 `document.body` 追加一个临时 `<div id="d<id>">`，图表解析失败时它把内置错误图**画进这个容器而不是抛异常**——失败因此永远到不了我们的 `catch`，炸弹图逃出消息卡片、孤立地漂在页面末尾。现在运行时以 `suppressErrorRendering: true` 初始化，每个代码块在 `render()` 之前先用 `mermaid.parse(text, { suppressErrors: true })` 预校验，并会清理旧客户端版本遗留在 body 层的错误图。语法错误或仍在流式输出的图表只保留原始代码块，同一份失败代码也不再因每次 DOM 变更而反复解析。

## 0.4.46 (2026-10-12)

### English

- **Fix (review cycle 2026-10-12): concurrency-slot leak in the adapter spawn window.** `stream()` acquired a `maxConcurrent` slot and only released it from the process-outcome closure — a caller that abandoned the generator while it was suspended on the burst-spacing throttle (steer abort, DSH closing the stream) dropped the release closure, and each incident permanently leaked one slot until every future run dead-locked in the queue. The spawn window now owns the slot through try/finally, an already-aborted signal short-circuits before spawn, and an abort that lands during the window kills the process immediately instead of running a full turn nobody reads.
- **Fix (review cycle): a stale pool-auth flow could kill the new login or commit a ghost account.** `finishWithCode` resolved against `this.flow` without checking WHICH flow the callback belonged to: flow A's late `exchangeCode` resolution during flow B either failed B with `invalid_state` (deleting B's staging dir) or, worse, wrote A's token file into A's freshly cleaned dir and committed a one-file ghost account. Settlement is now flow-identity-checked.
- **Fix (review cycle): long agy tools no longer look like a frozen session.** ACTIVE tool envelopes now emit a one-time `[agy tool running: …]` note into the reasoning block, so a ten-minute maven build shows live progress instead of silence (the 5-minute heartbeat only ever reached the logs). Subagent reasoning snapshots also stop duplicating the whole transcript (suffix-delta like the thinking branch), and a tool-cut span forwards the last per-call usage sample instead of a hard 0/0 that reset DSH's token meter on every tool hop.
- **Fix (review cycle): synthetic-message filtering can no longer eat the user's real message.** When the sniffed synthetic-looking text is the ONLY user content of the trailing span (a pasted `<system-reminder>` block being the actual question), the bridge now forwards it instead of failing with "request carries no user text" — while an image-only turn still never digs up an older question.
- **Fix (review cycle): pool/data hardening.** `deleteAccount` only ever `rmSync`s directories under the pool base dir (a hand-edited `dir: "~"` used to be deleted recursively); `pool.json` persists through a known-ids merge so web + headless stop erasing each other's accounts (corrupt files are backed up before defaults overwrite them, and persist failures are surfaced on stderr); `/agy add-account` and `POST /pool/add` quarantine the new slot with `authRequired` until the terminal login is verified, so the scheduler can no longer route real runs to an account nobody signed into; a drained quota window with an UNPARSEABLE reset now counts as exhausted in eligibility and rotation instead of "already reset".
- **Fix (review cycle): quota/OAuth robustness.** All Google endpoint calls carry a 10s default timeout (a hung refresh-token/quota endpoint used to park `/agy refresh-quota` for minutes); keychain/Secret Service/Credential-Manager reads are async (`execFileSync` up to 8s used to freeze the whole DSH event loop on every poll); concurrent `getValidAccessToken` calls for one account share one in-flight refresh; quota fractions are clamped to [0,1] with NaN rejected; refreshed token files are written 0600.
- **Fix (review cycle): auth flow lifecycle.** Cancelling during the URL wait now resolves the pending `begin()` (the `/plugins/agy-link/auth` HTTP route used to hang forever), a superseded `begin()` can no longer overwrite the newer flow's state, and the probe/settle timers are cleaned up.
- **Fix (review cycle): agy conversation DB reads.** A missing `sqlite3` binary or oversized/locked DB used to re-spawn sqlite3 on EVERY step event with the failure silently swallowed (cache still marked loaded, so the storm never converged); failures now back off (ENOENT for the full window, transient for 300ms), log once, and concurrent readers share one in-flight load. The DB copy is taken into a private `mkdtemp` dir with 0600 instead of a predictable /tmp path.
- **Fix (review cycle): misc.** The OAuth callback page HTML-escapes the reflected `error` parameter; Windows `openBrowser` refuses URLs containing quotes/newlines before the cmd string build; doctor redaction covers `1//0…` refresh tokens, `AIza…` keys and credentialed proxy URLs, and the config dump scrubs `proxyUrl` credentials; `/agy pool` prints proxy URLs redacted; fallback-source model discovery re-probes at most once per minute instead of spawning `agy models` on every list; fallback conversation-id discovery watches the pool account's isolated HOME; mermaid's CDN fallback is removed entirely (floating-version unsigned script in the app origin) and the mermaid/reasoning overlay observers are disposed through `ctx.effect`.
- **Add: token-speed statistics.** Every recorded event now carries its arrival time; per-step generation windows (≥500 ms) yield `lastTps`/output-weighted `avgTps`/output-token totals on the recording, surfaced through `/agy status` ("last run tokens: N output tokens — avg X tok/s (last generation step: Y tok/s)") and the `lastRun` status payload.
- **Fix (issue #43): thinking and tool activity are no longer invisible on desktop hosts.** Two compounding causes: (1) thought prose comes from the agy conversation SQLite DB, and the reader required the external `sqlite3` CLI — which GUI/desktop hosts often lack on PATH (macOS GUI apps do not inherit the shell PATH; Windows never ships one). The reader now prefers Node's built-in `node:sqlite` (no external binary) and keeps the CLI as fallback, so reasoning text resolves on desktop hosts. (2) When prose is unavailable, high-effort turns rendered nothing at all; a banner-only `[agy thinking turn · N thinking tokens]` chip now streams before the first visible text (and on thinking-only turns), with the real prose appended seamlessly when the DB resolves later — no duplicate banner, no dropped text, and no clutter on tool-heavy steps after text already streamed.
- **Fix (issue #45): Windows pool-credential isolation is now an explicit, visible limitation.** agy on Windows stores its login in the system-wide Credential Manager slot `gemini:antigravity` (go-keyring); HOME isolation moves files only, so every isolated pool account still authenticates — and bills — as the system login. The plugin now (1) exposes `credentialIsolationLimited` in `/plugins/agy-link/status`, rendered as a warning banner in the settings panel, (2) logs once per isolated account when it is selected on Windows, and (3) documents the boundary (and why per-run `CredWrite` slot-swapping is not safe with `maxConcurrent > 1`) in KNOWN-GAPS.md. Full isolation needs an upstream agy change (per-HOME keyring namespace or file fallback when the keyring slot is empty).


- **Fix: the stuck-run heartbeat no longer lies about how long the run has been silent.** With no tool step open the silence clock was seeded from `Date.now()` over an empty map, so the every-5-minutes log permanently claimed "no new output for 1m" while the run had actually been quiet for hours. It now reports the time since the last stdout line (`lastOutputAt`), which is the number a human needs when deciding whether to press Stop.
- **Fix: `agy_tool` no longer blames a "recycled" output for a cursor that never pointed at one.** An out-of-range step index (or a non-tool event) and a genuinely evicted recording both used to return the "recorded output is no longer resident" notice — telling the model that output was lost when it was never recorded at all. The degraded message now states the actual reason ("outside this recording — not recorded yet / not a completed tool step" vs. "the in-memory recording was recycled").
- **Fix: account failover now actually continues the session — including after a completed tool step (the "quota exhausted, turn lost" bug).** DSH re-issues the failed step, and a step that failed inside a tool continuation carried a trailing tool result, so it was resumed from the SETTLED recording and re-emitted the identical failure: a quota/region/auth refusal after any tool call ended the turn while a healthy account was sitting idle (reproduced offline against `test/fake-agy.mjs`). The continuation branch now refuses to re-drive a settled recording whose failure is account-scoped, forgets it, and re-assembles on the next account — inside the same step, with no visible interruption. The failover is bounded (at most `enabled accounts - 1` re-spawns per session per 2 minutes) and never applies to request-level failures, so a deterministic error cannot loop through the pool re-running the user's tools.
- **Fix: transport-shaped "not logged in" is no longer reported as AUTH (the "API 密钥无效 / API key is invalid" hunt).** agy reports "not logged into Antigravity" both for a real sign-out and for a healthy login whose token it could not VALIDATE (live 2026-10-10 14:17: the retry account's token had expired 9 minutes earlier and its refresh died on `Post https://oauth2.googleapis.com/token: EOF`, next to TLS handshake timeouts). The adapter classified that as `AUTH`, which (a) ended the turn on a healthy account, (b) flagged the account for re-login, and (c) made DSH render its `message.failure.auth` label — "API key is invalid" — for a credential that was never the problem. Transport evidence in the auth-shaped stdout banner, stderr or the result envelope now yields a retryable `NETWORK` failure that rotates to the next account and never quarantines a login.
- **Fix: the retry budget follows the pool, and a sign-out can continue on another account.** `maxRetries` was a flat 1, so a 3-account pool could never reach the third account — and the live incident needed exactly that (primary ELIGIBILITY → second account "not signed in" → turn lost, though the third was healthy). The budget is now `min(enabled accounts - 1, 2)`, and `AUTH` is retryable when at least one other account exists (the failed one is flagged `authRequired` and leaves rotation).
- **Fix: soft capacity refusals rotate instead of dead-ending the turn.** "model overloaded" / "experiencing high traffic" used to be a deterministic `AGY_ERROR` — terminal, no rotation, no retry — so a turn died while another account could serve it. They are now `OVERLOADED`: retryable, pointer rotated, and deliberately WITHOUT a cooldown (nothing was spent). The hard-quota matcher also recognises real phrasings it used to miss (`Resource has been exhausted (e.g. check quota).`, `You have exhausted your quota`, `out of quota`, `check quota`), which previously fell through to a bare "agy exited with code 1" on the SAME account.
- **Fix: the idle watchdog no longer kills a run that is demonstrably working.** 12 of the 37 failures in one week of real logs were exactly `agy run was idle for 600000ms without output`, each costing a turn and a resend. stderr now counts as liveness (agy prints progress there), and once a run has produced ANY output the long budget applies (`longToolIdleMinutes`, default 240m) — before the first event the strict `timeoutMs` stays, which is the genuinely wedged / Google-unreachable shape. The 5-minute heartbeat now also covers a silent-but-alive run instead of only open tool steps, so the user can see it is waiting and press Stop.
- **Fix: prompts no longer re-send tool output the live agy conversation already owns, and synthetic harness telemetry is filtered.** A bound conversation was piping prior tool results back into `-p` (a live command line was captured carrying a 6.4 KB Godot simulation dump) — stale output ahead of the actual question, which is one of the ways the model ends up answering the previous work. Tool payloads are now dropped when the conversation already has them (they still ride the prompt on a fresh conversation, where agy has never seen them). Separately, DSH runtime telemetry messages injected with `role: 'user'` (`time-context`, `runtime-context`, `<system-reminder>`) are filtered so timestamps never overwrite the human prompt, and an image-only (text-less) newest message no longer falls back to older questions.
- **Fix: an interrupted turn can no longer make agy answer the message you interrupted.** DSH persists the partial reply of a Stop/steer as a normal assistant message, so the plugin treated the interrupted user turn as answered agy-native history while agy's server-side turn had no finalized reply — the next prompt was just the new message, and the model answered the interrupted one (live: `session-c65a826e` turns 17→19, the user re-asked verbatim with "这个咋不回答呢"). The binding is now flagged `interrupted` when a run is aborted or times out, the next prompt carries an explicit "do not continue that unfinished work" boundary, and a successful turn clears the flag. Images staged by an interrupted run are no longer marked delivered either (re-sending the same screenshot after a Stop was silently deduped away and an image-only follow-up failed with "request carries no user text or images").
- **Fix: a run that already produced its result is no longer killed by the next call.** Steer preemption aborted a process that had already streamed its answer (recording a false `ABORTED` and cutting agy mid-finalize); it now waits briefly for a natural exit and only preempts a still-running turn. The bounded settle wait reports when it expires, and a superseded run's late write-back can no longer regress `lastMessageCount` / `sentImageIds`.
- **Fix: pool and binding robustness.** A partial `pool.json` (account missing `cooldowns`/`quotas`) threw a `TypeError` inside `selectAccount`, so every turn failed with an opaque internal error and no failover — records are normalized on load. Rate limits no longer delete the `(session, account)` binding, so a resumable native conversation is not thrown away for a 15-minute cooldown (only a real sign-out or an agy-side "conversation not found" invalidates it). Conversation adoption from a live run is scoped to the SAME account (adopting account A's id under account B produced a wasted "conversation not found" turn). `sessions.json` now performs the dirty-key merge its own docs promised, so the web and headless hosts stop clobbering each other's bindings. A failed turn reports the last per-call context sample instead of a hard-coded 0/0. ADR-012 no longer claims a flat "zero interruption" fallback with a 10-minute cooldown.

### 中文 (Chinese)

- **修复（2026-10-12 审查周期）：适配器 spawn 窗口的并发槽位泄漏。** `stream()` 取得 `maxConcurrent` 槽位后只由进程结算闭包释放——调用方在突发节流 sleep 处放弃生成器（插话中止 / DSH 关闭流）会直接丢掉 release 闭包，每次事故永久泄漏一个槽位，累积后所有后续请求在队列里死锁。现在 spawn 窗口用 try/finally 持有槽位；已中止的 signal 会在 spawn 前短路；窗口内到达的中止会立刻杀进程，而不是跑完一轮没人读的 turn。
- **修复（审查周期）：滞后的 pool-auth 流程可能杀死新登录或提交幽灵账号。** `finishWithCode` 直接对 `this.flow` 结算、不校验回调属于哪个 flow：用户取消 A 并开始 B 后，A 的 `exchangeCode` 迟到返回，要么以 `invalid_state` 杀掉 B（连带删掉 B 的 staging 目录），要么把 A 的 token 文件写进刚清理的 A 目录并提交一个只剩 token 文件的幽灵账号。现在结算带 flow 身份校验。
- **修复（审查周期）：长时间 agy 工具不再让会话看起来卡死。** ACTIVE 工具信封现在会在推理块输出一次性 `[agy tool running: …]` 进行中注解——十分钟的 maven 构建期间界面有实时进展，而不是只有日志里的 5 分钟心跳。subagent 推理快照改用与 thinking 分支相同的 suffix-delta，不再整段重复；工具切割 span 转发最后一次 per-call 用量样本，不再用硬编码 0/0 在每个工具 hop 重置 DSH 的 token 计量。
- **修复（审查周期）：合成消息过滤不再吞掉用户的真实消息。** 当被嗅探命中的文本是尾随 span 里唯一的用户内容（用户粘贴 `<system-reminder>` 块本身就是要问的问题），桥接现在会转发它，而不是报「request carries no user text」；纯图片轮次依旧不会回捞更早的问题。
- **修复（审查周期）：账号池与数据加固。** `deleteAccount` 只会删除池 baseDir 下的目录（手改 `dir: "~"` 曾会被递归删除）；`pool.json` 持久化改为 known-ids 合并，web 与 headless 不再互相清掉对方账号（损坏文件先备份再被默认值覆盖，写盘失败打到 stderr）；`/agy add-account` 与 `POST /pool/add` 在登录验证通过前用 `authRequired` 隔离新槽位，调度器无法再把真实 run 路由到没人登录过的账号；额度耗尽但 reset 时间不可解析时按「已耗尽」参与资格判定与轮换，而不是「已重置」。
- **修复（审查周期）：配额 / OAuth 健壮性。** 所有 Google 端点调用默认 10s 超时（挂死的 refresh-token / 配额端点曾让 `/agy refresh-quota` 卡死数分钟）；钥匙串 / Secret Service / Windows 凭据管理器读取全部异步化（`execFileSync` 最长 8s 曾在每个轮询周期冻结整个 DSH 事件循环）；同账号并发 `getValidAccessToken` 共享一次 in-flight 刷新；配额比例钳制到 [0,1] 并拒绝 NaN；刷新后的 token 文件以 0600 落盘。
- **修复（审查周期）：登录流程生命周期。** URL 等待期间取消会 resolve 挂起的 `begin()`（`/plugins/agy-link/auth` HTTP 路由曾永久挂起）；被取代的 `begin()` 不会再覆盖新流程状态；probe/settle 计时器均已清理。
- **修复（审查周期）：agy 会话数据库读取。** 缺 `sqlite3` 或库超大/被锁时，之前每个 step 事件都会重新 spawn 一次 sqlite3 且失败被静默吞掉（缓存仍标记 loaded，风暴永不收敛）；现在失败退避（ENOENT 按整个缓存窗口、瞬时失败 300ms）、告警一次、并发读者共享一次 in-flight 加载；DB 拷贝改为私有 `mkdtemp` 目录 + 0600，不再落在可预测的 /tmp 路径。
- **修复（审查周期）：其他。** OAuth 回调页对反射的 `error` 参数做 HTML 转义；Windows `openBrowser` 在拼 cmd 字符串前拒绝含引号/换行的 URL；doctor 脱敏覆盖 `1//0…` refresh token、`AIza…` key 与带凭据的代理 URL，config dump 会抹掉 `proxyUrl` 凭据；`/agy pool` 打印脱敏后的代理；fallback 模型目录每分钟最多重探一次（未登录时不再每次列表调用都 spawn `agy models`）；会话 id 兜底发现改为监视池账号隔离 HOME；彻底移除 mermaid 的公网 CDN 回退（应用 origin 内的浮动版本无签名脚本），mermaid/reasoning 的 overlay observer 通过 `ctx.effect` 释放。
- **新增：token 速度统计。** 每条录制事件现在带到达时间；≥500ms 的分步生成窗口给出 `lastTps` / 按输出加权的 `avgTps` / 输出 token 总量，通过 `/agy status`（「last run tokens: N output tokens — avg X tok/s」）与 `lastRun` 状态载荷暴露。
- **修复（issue #43）：桌面端不再看不到思考过程与工具活动。** 两个叠加原因：(1) 思维正文来自 agy 会话 SQLite 库，而读取器依赖外部 `sqlite3` CLI——桌面/GUI 宿主的 PATH 经常没有它（macOS GUI 应用不继承 shell PATH，Windows 从不自带）。读取器现在优先用 Node 内置的 `node:sqlite`（无需外部二进制），CLI 退居兜底，桌面端也能解析出推理文本。(2) 拿不到正文时高强度轮次此前什么都不渲染；现在首段可见文本之前（以及纯思考轮次）会先流出 `[agy thinking turn · N thinking tokens]` 横幅，DB 正文稍后解析出来时无缝追加——不重复横幅、不丢文本，正文已开始后也不在工具密集步骤上刷屏。
- **修复（issue #45）：Windows 号池凭据无法隔离现在是明确、可见的已知限制。** Windows 上 agy 把登录存进系统级 Credential Manager 的单一槽位 `gemini:antigravity`（go-keyring）；HOME 隔离只隔离文件，所有池账号实际仍以系统登录认证与扣额度。插件现在 (1) 在 `/plugins/agy-link/status` 暴露 `credentialIsolationLimited` 并在设置面板渲染警告横幅，(2) Windows 下选中隔离账号时告警一次，(3) 在 KNOWN-GAPS.md 记录边界（以及为何 `maxConcurrent > 1` 时逐 run 的 `CredWrite` 槽位互换不安全）。彻底解决需要上游 agy 改动（按 HOME 命名空间的 keyring，或 keyring 槽位为空时回落文件）。


- **修复：卡死 run 的心跳日志不再谎报静默时长。** 当没有未完成的工具步骤时，静默时钟从一个空 map 上的 `Date.now()` 起算，于是每 5 分钟一次的日志永远显示「无新输出 1m」，而 run 实际已经安静了数小时。现在报告的是距最后一条 stdout 行的真实时长（`lastOutputAt`）——这正是用户决定是否按 Stop 时需要的数字。
- **修复：`agy_tool` 不再把「从未指向过任何步骤的游标」归因为「输出被回收」。** 越界的 step 索引（或非工具事件）与真正被淘汰的录像此前返回同一句「录制输出已不在内存中」——告诉模型输出丢了，而它其实从未被录制过。降级消息现在说明真实原因（「索引在此录像范围之外——尚未录制 / 不是已完成的工具步骤」vs「内存中的录像已被回收」）。
- **修复：账号故障转移现在真的能续上会话——包括在工具步骤之后（「额度用完、整轮作废」问题）。** DSH 重发失败步骤时，如果失败发生在工具续跑 span 内，消息尾部带着工具结果，于是适配器从**已 settle** 的录像里恢复、把同一个失败原样重放一遍：任何在工具调用之后出现的额度/地区/认证拒绝都会让整轮失败，而旁边还有健康账号闲着（已用 `test/fake-agy.mjs` 离线复现）。现在续跑分支拒绝重放「账号级失败的已 settle 录像」，改为丢弃它并在下一个账号上重新组装——仍在同一步内完成，用户看不到中断。故障转移有界（每会话每 2 分钟最多 `启用账号数 - 1` 次重发），且绝不适用于请求级失败，因此确定性错误不会在账号池里反复重跑用户的工具。
- **修复：传输形态的「未登录」不再被报成 AUTH（「API 密钥无效」误导）。** agy 对于真正的登出、以及**无法校验** token 的健康登录，都会说「not logged into Antigravity」（线上 2026-10-10 14:17：重试账号的 token 早 9 分钟就过期，刷新死在 `Post https://oauth2.googleapis.com/token: EOF`，同时伴随 TLS 握手超时）。适配器把它归类为 `AUTH`，后果有三：(a) 在健康账号上终止本轮；(b) 把该账号标记为「需重新登录」；(c) 让 DSH 渲染 `message.failure.auth` 文案——「API 密钥无效」——而凭据从来不是问题。现在，只要认证形态的 stdout banner、stderr 或结果信封里出现传输层证据，就会得到可重试的 `NETWORK` 失败：轮换到下一个账号，且绝不隔离任何登录状态。
- **修复：重试预算跟随账号池，登出也能在另一个账号上继续。** `maxRetries` 原先固定为 1，3 账号池永远到不了第三个账号——而线上事故恰好需要它（主账号 ELIGIBILITY → 第二账号「未登录」→ 整轮丢失，尽管第三个账号健康）。现在预算是 `min(启用账号数 - 1, 2)`；当至少还有一个账号时 `AUTH` 可重试（失败账号被标记 `authRequired` 并退出轮换）。
- **修复：软容量拒绝改为轮换，而不是直接终止本轮。** 「model overloaded」/「experiencing high traffic」原先归类为确定性 `AGY_ERROR`——终止、不轮换、不重试——于是明明还有别的账号可用，本轮却失败了。现在它们是 `OVERLOADED`：可重试、指针已轮换、且**故意不加冷却**（没有消耗任何额度）。硬额度识别也补上了过去漏掉的真实措辞（`Resource has been exhausted (e.g. check quota).`、`You have exhausted your quota`、`out of quota`、`check quota`）——这些以前会退化成一句「agy exited with code 1」，并且重试仍打在同一个已耗尽账号上。
- **修复：空闲看门狗不再杀掉「明显还在干活」的 run。** 真实日志一周内 37 次失败里有 12 次正是 `agy run was idle for 600000ms without output`，每次都赔上一轮和一次重发。现在 stderr 也算活跃（agy 会把进度写在 stderr），并且只要 run 产出过任何输出就适用长预算（`longToolIdleMinutes`，默认 240 分钟）——首个事件之前仍用严格的 `timeoutMs`，那才是真正卡死/连不上 Google 的形态。5 分钟心跳也从「仅有未完成工具步骤」扩展为覆盖「安静但存活」的 run，用户能看到它在等，并可以按 Stop。
- **修复：提示词不再重发当前 agy 会话已有的工具输出，并严格过滤 DSH 合成遥测消息。** 已绑定的会话会把历史工具结果重新塞回 `-p`（线上抓到一条命令行里带着 6.4 KB 的 Godot 模拟输出）——陈旧输出排在真正的问题前面，这正是模型转去回答「上一件事」的原因之一。现在会话已拥有工具输出时不再重发（全新会话仍会带上，因为那时 agy 从未见过）。此外，DSH 在运行时高频注入的 `role: 'user'` 合成遥测消息（如 `time-context` 时间戳、`runtime-context` 上下文快照、`<system-reminder>` 等）现在会被严格过滤，彻底解决时间戳冲掉真实用户任务导致 agy 忽略最新输入的问题；纯图片（无文本）的最新消息也不再回溯拾取旧问题。
- **修复：被中断的轮次不会再让 agy 回答你打断的那条消息。** DSH 会把 Stop / 插话时的半截回复当作普通 assistant 消息持久化，于是插件把「被打断的用户轮次」当成 agy 原生历史（而 agy 服务端那一轮并没有最终回复）——下一条提示词只有新消息，模型却去回答被打断的那条（线上 `session-c65a826e` 第 17→19 轮，用户原样重问并追问「这个咋不回答呢」）。现在 run 被中断或超时时会在 binding 上标记 `interrupted`，下一条提示词带上明确的「不要继续那件未完成的事」边界，成功一轮后清除该标记。被中断的 run 暂存的图片也不再被记为「已投递」（Stop 之后重发同一张截图会被静默去重，纯图片追问则直接报「request carries no user text or images」）。
- **修复：已经产出结果的 run 不会再被下一次调用杀掉。** 插话抢占原先会中止一个已经流完答案的进程（记为假的 `ABORTED`，并把 agy 的收尾切断）；现在会短暂等待它自然退出，只抢占仍在运行的轮次。有界的 settle 等待在超时时会记录日志，被取代的 run 的迟到回写也无法再回退 `lastMessageCount` / `sentImageIds`。
- **修复：账号池与会话绑定的健壮性。** 残缺的 `pool.json`（账号缺 `cooldowns`/`quotas`）会让 `selectAccount` 抛 `TypeError`，导致每一轮都以不透明的内部错误失败、且完全没有故障转移——现在加载时会规范化记录。限流不再删除 `(会话, 账号)` 绑定，因此不会为了 15 分钟冷却丢掉一个可续跑的原生会话（只有真正的登出或 agy 侧「conversation not found」才会作废它）。从存活 run 采纳会话 id 时限定为**同一账号**（把账号 A 的 id 用到账号 B 上会产生一次白跑的「conversation not found」）。`sessions.json` 现在真正实现其文档承诺的 dirty-key 合并，web 与 headless 宿主不再互相覆盖绑定。失败的轮次会报告最后一次 per-call 上下文用量，而不是硬编码的 0/0。ADR-012 不再声称「零中断」的平铺回退与 10 分钟冷却。

### English (continued)

- **Fix: a long-running span can no longer lose its recording to the shared run registry (`no recorded agy run`).** `RunRegistry` kept only the 8 most recently **created** runs (global FIFO across every DSH session). A run whose span waited hours on a wedged agy tool step (e.g. a headless test scene that hit a script error and never quit) was evicted while it was still in flight, and the `agy_tool` mirror call the span had already emitted — `agy_tool({run, step})` — failed with "no recorded agy run", which sent the model off to debug the bridge instead of finishing the user's task (flash-blast incident, 2026-10-10; the same shape recurred on 2026-10-09). The registry now (1) pins a run for the whole lifetime of the span driving it, (2) exempts pinned and unsettled runs from eviction, (3) never evicts the most recent entry, and (4) `remember()` now refreshes recency (delete-then-set) instead of silently keeping the old slot. Spans re-register their recording when they start and when they finish, so the run an `agy_tool` dispatch addresses is always resident, while memory stays bounded by evicting the oldest settled, unpinned run.
- **Fix: a missing recording now degrades instead of throwing a harness-internal error at the model.** `agy_tool` returning `no recorded agy run` was unrecoverable for the agent: it read the error as an environment fault and spent a whole turn reverse-engineering the plugin bundle (including a stale published copy from the pnpm store). When a run's recording is gone the mirror now returns an explicit, task-facing notice stating that the step did run, that its replay is unavailable, that there is nothing to debug, and that the operation can simply be re-run — then the agent continues its real work.
- **Add: configurable long-tool idle budget + stuck-tool heartbeat.** The watchdog raise for open tool steps (previously hard-coded to the ≥ 4 h print-mode ceiling) is now `longToolIdleMinutes` / `DSH_AGY_LONG_TOOL_IDLE_MINUTES` (default 240; `0` disables the raise so a wedged tool fails the turn after `timeoutMs` instead of holding the session for hours). While any tool step is open the adapter now logs a heartbeat every 5 minutes (open count + age + budget), so a stalled turn is visible instead of looking like a dead session.
- **Fix: `toolStepBrief` reads `CommandLine`.** The code-mode/step preview for `run_command` steps showed "run command" whenever agy sent the modern `CommandLine` key; it now shows `$ <command>` like the native card does.
- **Fix: cross-conversation & cross-account assistant replies are now digested when returning.** In multi-account pool scenarios where turns alternated between accounts, an assistant message emitted under another agy conversation id was previously ignored by `isForeignAssistant` (because `provider` was identically `antigravity`). The returning conversation never saw that intervening answer in its context digest. `isForeignAssistant` now verifies `source.replayState` conversation IDs against the current binding, guaranteeing complete cross-conversation context.
- **Fix: `forwardSystemPrompt` falls back to `role: 'system'` messages.** When `options.system` is omitted on `GenerateOptions` but system instructions are provided as an explicit system message in the chat history, the prompt now correctly includes the system instructions.
- **Add: native card presentations for web search, URL fetching, task management, scheduling, and subagents.** Mirrored cards and step previews now cleanly project `search_web`, `read_url_content` / `web_fetch`, `manage_task`, `schedule`, and `invoke_subagent` / `send_message`, avoiding generic raw JSON fallbacks. `TerminalResultView` also extracts process exit codes (`The command exited with code X`) from `run_command` output to render native status pills in DSH terminal cards.

### 中文（续）

- **修复：长时间运行的 span 不会再因为共享 run 注册表而丢失录像（`no recorded agy run`）。** `RunRegistry` 原先只按**创建顺序**保留最近 8 条 run（跨全部 DSH 会话的全局 FIFO）。当某条 run 的 span 因为 agy 工具步骤卡死（例如无头测试场景脚本报错后不退出）等待数小时，它会在仍在飞行时被淘汰，而该 span 已经排好队的 `agy_tool({run, step})` 镜像调用随即报 "no recorded agy run"——模型据此掉头去调试桥接插件，而不是继续用户的任务（flash-blast 事故，2026-10-10；2026-10-09 出现过同样形态）。现在注册表：(1) 在 span 驱动期间**钉住**该 run；(2) 被钉住与未 settle 的 run 免于淘汰；(3) 永不淘汰最近使用的那一条；(4) `remember()` 改为真正的 `delete` 再 `set`，刷新最近使用顺序而不是原地保留旧位置。span 在启动与结束时都会重新登记自己的录像，因此 `agy_tool` 派发时寻址的 run 必定仍在内存中，同时内存仍通过淘汰「最老的、已 settle 且未钉住」的 run 保持有界。
- **修复：录像缺失时改为优雅降级，而不是向模型抛桥接内部错误。** `agy_tool` 返回 `no recorded agy run` 对 agent 来说不可恢复：它把该错误理解为环境故障，整轮都在逆向插件产物（还是一份 pnpm store 里的旧发布副本）。现在录像不存在时，镜像工具返回一条明确面向任务的提示：该步骤确实执行过、只是回放不可用、这里没有可调试的东西、需要输出就重跑一次同样的操作——随后 agent 继续原本的工作。
- **新增：可配置的长工具空闲预算 + 卡死工具心跳。** 未完成工具步骤期间的空闲预算（原先硬编码为 ≥ 4 小时的 print-mode 上限）现在是 `longToolIdleMinutes` / `DSH_AGY_LONG_TOOL_IDLE_MINUTES`（默认 240；设为 `0` 表示不抬高预算，卡死的工具会在 `timeoutMs` 后让本轮失败，而不是把会话挂住数小时）。只要存在未完成的工具步骤，适配器每 5 分钟记录一条心跳（未完成数量 + 最久时长 + 当前预算），让卡住的轮次可见，而不是看起来像会话已死。
- **修复：`toolStepBrief` 会读取 `CommandLine`。** 当 agy 发送新式 `CommandLine` 键时，`run_command` 步骤的 Code Mode / 预览标题只会显示 "run command"；现在与原生卡片一致，显示 `$ <命令>`。
- **修复：跨会话 / 跨账号的助理回复在切回时现在会被完整消化（跨会话上下文丢失漏洞）。** 在多账号池轮换场景下，当某轮切到备用账号并在新 agy 会话中回答后，切回原账号会话时，由于原先 `isForeignAssistant` 仅比对 `provider !== 'antigravity'`，导致另一会话产出的 assistant 回复被误认为“本机历史”而从补充摘要中剔除，使原会话完全缺失该轮的回答上下文。现在通过对比 `source.replayState` 中的会话 ID，跨会话回复会准确作为外部上下文消化到提示词中。
- **修复：`forwardSystemPrompt` 在 `options.system` 缺省时自动回退读取 `role: 'system'` 消息。** 当宿主未在选项顶层传入 `options.system`、但在消息历史中携带了系统指示时，提示词现在仍能准确拼接系统指示。
- **新增：全面支持网页搜索、网页抓取、后台任务管理、定时任务及子 Agent 的原生工具卡片渲染。** 镜像卡片与步骤摘要现已原生支持 `search_web`、`read_url_content` / `web_fetch`、`manage_task`、`schedule` 以及 `invoke_subagent` / `send_message`，避免退化为生硬的 raw JSON；终端卡片 `TerminalResultView` 现在会从 `run_command` 输出中提取真实退出码（`The command exited with code X`），以便 DSH 渲染原生状态药丸。

## 0.4.45 (2026-10-10)

### English

- **Fix (macOS): `ensureIsolatedKeychain` no longer causes modal SecurityAgent password popups on startup (issue #42).** On macOS, `ensureIsolatedKeychain` applied `security set-keychain-settings` on existing isolated keychains on every boot and spawn. When the keychain was locked across app restarts, macOS's SecurityAgent raised blocking GUI dialogs demanding the password for each account — an unanswerable prompt because the isolated keychain was created with an ephemeral random passphrase. The settings (never auto-lock, no timeout) are already persisted on creation, so `ensureIsolatedKeychain` now returns `false` immediately when the keychain file exists on disk, never poking the security CLI again. New keychains are also provisioned with an empty passphrase (`-p ""`) and unlocked upon creation.
- **Fix: reasoning thinking thoughts arriving asynchronously are no longer dropped (issue #43).** In `EventMapper`, the thinking announcement gate prematurely consumed `thinkingAnnounced` when `thoughtTokens > 0` even before thought prose had finished resolving from the SQLite database. Later fragments or DONE tails carrying the resolved thought prose were subsequently dropped as "already announced". The announcement gate now only marks thoughts as announced when thought text is actually present. In addition, `readStepThoughts` in the adapter now adds a retry interval to accommodate SQLite WAL flush latencies during active model generation.
- **Fix (Mermaid): prevent "Syntax error in text" bomb SVG from leaking into the document body.** When a code block containing invalid diagram syntax was processed, Mermaid's fallback error-renderer appended a 2412px-wide SVG with a bomb icon directly into `document.body`. Due to an internal throw before cleanup in Mermaid v11, the leaked elements remained permanently attached to the window footer. `mermaid.initialize` now sets `suppressErrorRendering: true`, pre-validates syntax using `api.parse()`, passes a scoped mount container to `api.render()`, unconditionally sweeps temporary and stray elements (`#dagy-mmd*`, `#iagy-mmd*`) in a `finally` block, and injects protective CSS preventing body-level leaked nodes from rendering.

### 中文 (Chinese)

- **修复 (macOS)：`ensureIsolatedKeychain` 不再在每次启动时触发 SecurityAgent 钥匙串密码弹窗（issue #42）。** 在 macOS 上，`ensureIsolatedKeychain` 原先在每次 DSH 启动和进程拉起时都会对已存在的隔离钥匙串执行 `security set-keychain-settings`。当钥匙串在应用重启后处于锁定状态时，macOS 的 SecurityAgent 会对每个隔离账号弹出阻塞式系统密码框——由于此前钥匙串是使用未持久化的随机密码创建的，用户输入任何密码都无法通过。钥匙串的“永不自动锁”设置在首次创建时已持久化落盘，因此当钥匙串文件已存在时，`ensureIsolatedKeychain` 现在直接返回 `false`，绝不再调用 security CLI；新建钥匙串时也改用空密码（`-p ""`）创建并立即静默解锁。
- **修复：异步从数据库解析的思考过程正文不再被静默丢弃（issue #43）。** 在 `EventMapper` 中，思考公布逻辑原先只要检测到 `thoughtTokens > 0`，即使 SQLite 中的思考正文尚未完成异步提取，也会过早消耗 `thinkingAnnounced` 标记，导致后续分片或 DONE 尾包即使成功提取到了思考正文也被判定为“已公布”而直接丢弃。现在公布标记仅在实际存在思考正文时才消耗；同时适配器中的 `readStepThoughts` 增加了重试等待，以包容模型生成期间 SQLite WAL 写入的延迟。
- **修复 (Mermaid)：彻底解决 Mermaid 语法错误导致巨大的“Syntax error in text”炸弹图标残留在窗口底部的问题。** 当代码块包含不合法的图表语法时，Mermaid 内部的兜底错误渲染逻辑会向 `document.body` 追加一个 2412px 宽的巨大炸弹图标（💣）SVG；由于 Mermaid v11 在内部抛错前未执行清理，该临时元素会永久留在窗口底部污染界面。现在初始化时开启了 `suppressErrorRendering: true`，在渲染前通过 `api.parse()` 预校验语法，向 `api.render()` 传入局部挂载容器，在 `finally` 块中无条件清理临时节点（`#dagy-mmd*`、`#iagy-mmd*`），并通过安全 CSS 全面隐藏逃逸到 body 层级的任何错误元素。

## 0.4.44 (2026-10-09)

### English

- **Fix: a conversation stalled on a tool step no longer dead-ends after a host restart.** Continuation spans resolve their run from an **in-memory** `RunRegistry`; after DSH restarts (or the run is evicted) the recording is gone, and `stream()` used to fail that turn — and every retry of it — with "agy run … is no longer available (server restarted?) — please resend your message", an advice that could never succeed because the stale tool result stays at the end of the message list. The adapter now logs a warning and falls back to fresh-turn prompt assembly instead: the history digest carries the recorded tool result, and the session's `sessions.json` binding still points at the same agy conversation, so the next turn heals the conversation with no user action. Related hardening in the same change: (1) the `agy_tool` mirror now bypasses DSH's auto-review / permission gates via a `tools/pre-execute` hook (it only replays output agy already executed — routing it through the reviewer caused redundant review LLM calls, timeouts, and crashes on reviewer tool-call endings); (2) review-mode calls (`REVIEW_POLICY` system prompt) and calls with explicit `tools: []` are treated as auxiliary and never cut spans on tools; (3) on Windows, `.mjs`/`.js`/`.cjs` bins are spawned via `process.execPath` instead of failing with `EFTYPE` (this also makes the full test suite pass natively on Windows — the 33 pre-existing platform failures are gone). (PR #40)
- **Add: hide models from the DSH model picker (`hiddenModels`).** The Antigravity settings section (below account-pool scheduling) now renders a "Model visibility" row with one toggle per known model: hidden models disappear from the `/model` picker, everything else stays visible (deny-list semantics, so newly discovered models appear by default). Hiding is picker-only by design — `resolveModel` still accepts hidden ids, so in-flight sessions and direct model references keep working, and no catalog-cache invalidation is needed. The list is served from `/status` (`catalogModels` + `hiddenModels`) through the same sanitizer that feeds `listModels`, so the UI and the picker can never disagree; writes go through the existing `POST /config` allowlist (validated as an array of model ids) and persist to the runtime-overrides file immediately. `DSH_AGY_HIDDEN_MODELS` (comma-separated) also works as an env fallback. The plugin now also emits the payload-free `llm/adapters-updated` event whenever picker output can change (`hiddenModels` writes, boot-probe discovery, re-login, manual quota refresh) — the webview picker caches its catalog snapshot and only re-reads after that event, so without it toggles would not show up until the next app restart. (PR #39)
- **Fix: the Windows node-shim spawn merged from #40 now really runs the script instead of booting a second app instance.** `process.execPath` is the Electron binary in the packaged desktop host, so the `isNode` branch now sets `ELECTRON_RUN_AS_NODE=1`; plain node ignores the variable, so POSIX and the test suite are unaffected.

### 中文 (Chinese)

- **修复：停在工具步骤上的会话在宿主重启后不再进入死胡同。** 续接 span 依赖的 run 录像存放在**纯内存**的 `RunRegistry` 里;DSH 重启(或录像被淘汰)后录像即消失，`stream()` 会让该轮失败——而且每次重试都失败，报 "agy run … is no longer available (server restarted?) — please resend your message"。这个"请重发消息"的建议永远不可能成功：失效的工具结果始终钉在消息列表末尾，续接检测每轮都命中同一个 runId。现在适配器会记录一条警告并**回退到全新轮次的 prompt 组装**：历史 digest 携带已记录的工具结果，会话在 `sessions.json` 里的 conversation 绑定仍指向同一个 agy 会话，下一轮即自动自愈，无需用户做任何事。同一批提交中的相关加固:(1) `agy_tool` 镜像现在通过 `tools/pre-execute` 钩子绕过 DSH 的 auto-review / 权限门(它只是重放 agy 已经执行过的输出——送审会导致重复审查 LLM 调用、审查超时，以及审查员以 tool-calls 结尾时的崩溃);(2) 审查模式调用(`REVIEW_POLICY` 系统提示)与显式 `tools: []` 的调用按辅助调用对待，不再在工具步骤上切分 span;(3) Windows 下 `.mjs`/`.js`/`.cjs` 形式的 bin 改为经 `process.execPath` 启动，不再触发 `EFTYPE`(这也让整个测试套件在 Windows 上原生全绿——33 个既有平台失败清零)。（PR #40）
- **新增：在 DSH 模型选择器中隐藏指定模型（`hiddenModels`）。** Antigravity 设置区（号池调度下方）新增"模型显示"一行，每个已知模型一个开关：关闭的模型从 `/model` 选择器中消失，其余照常显示（黑名单语义——新发现的模型默认可见）。隐藏只作用于选择器：`resolveModel` 仍接受被隐藏的模型 id，进行中的会话与直接引用不受影响，也无需清空模型目录缓存。模型列表由 `/status`（`catalogModels` + `hiddenModels`）提供，与 `listModels` 共用同一清洗逻辑，UI 与选择器永远不会不一致；写入走现有 `POST /config` 白名单（校验必须是模型 id 数组），立即持久化到 runtime-overrides 文件。环境变量 `DSH_AGY_HIDDEN_MODELS`（逗号分隔）亦可作为回退。插件现在会在所有会影响选择器输出的时机发出无负载的 `llm/adapters-updated` 事件（`hiddenModels` 写入、启动探测发现模型、重新登录、手动刷新额度）——webview 的模型选择器缓存目录快照、只在该事件后重读，缺少它时开关要到下次重启应用才会生效。（PR #39）
- **修复：合入自 #40 的 Windows node 脚本启动现在真正执行脚本，而不是再启动一个 App 实例。** 打包桌面端里 `process.execPath` 是 Electron 二进制，因此 `isNode` 分支现在会设置 `ELECTRON_RUN_AS_NODE=1`；纯 node 会忽略该变量，POSIX 与测试不受影响。

## 0.4.43 (2026-10-06)

### English


- **Fix (Windows): Chinese tool output is no longer mangled (issue #37).** Windows pipes carry bytes in the child's console code page: on a zh-CN system agy captures pwsh output as CP936 (GBK), and the plugin decoded every stream as UTF-8 — so the Chinese refusal text arrived as mojibake, and because that text is what agy stores in its conversation database the damage was permanent. stdout/stderr are now read as raw bytes and decoded **per line** through the console code page (`chcp` probe → GBK/Big5/Shift_JIS/EUC-KR/Windows-125x), falling back to UTF-8 whenever a line is valid UTF-8; POSIX behaviour is bit-for-bit unchanged (the probe returns `utf-8`). Lines — not chunks — are the decoding unit because a multi-byte character can straddle a chunk boundary but never a newline.
- **Fix: `dsh plugin add git+https://…` installs now build the plugin (issue #38).** `dist/` is not committed and only `prepack` existed, which never runs for git dependencies — so a hub/git install produced a package without `dist/` and failed to load. A `prepare` script now builds on git installs (npm/pnpm install devDependencies for git deps first); npm consumers are unaffected because `prepare` does not run for published tarballs. The install also aborted **earlier** than that: `@deepseek-ai/dsh-client-locale` was declared as a **non-optional** peer, so npm's automatic peer installation tried to fetch the unpublished `@deepseek-ai/dsh-paths@^0.0.1-rc.1` chain from the public registry and failed with a 404 — every `@deepseek-ai/*` peer is now optional (the host provides them at runtime and the bundle keeps them external), matching how third-party DSH plugins declare theirs.
- **Fix: the live "User location is not supported for the API use" refusal is now recognized, explained and routed around.** agy exits 3 with a `FAILED_PRECONDITION (code 400)` result envelope for this refusal, but the classifier only knew the older issue-#32 wording — so it surfaced as a bare `PROCESS_EXIT`, the sticky account never moved, and every retry hit the same unsupported location (hence the recurring failure). The signature is now matched, the failure carries a dedicated, retryable `ELIGIBILITY` code plus the actionable hint, and the refused account is rotated off the sticky pointer before the error surfaces (no cooldown penalty) — the automatic retry is then served by an account whose own proxy/egress region is supported.
- **Add: rotation now drains the account whose quota expires soonest (use-it-or-lose-it).** Sequential fallback used to advance in pool order, which could leave an account sitting on 60 % of a 5-hour window that resets in 20 minutes — that residual is discarded at the reset, so it was wasted. When the sticky account is drained (hard quota, cooldown, silent timeout) the next account is now the eligible one whose quota window refreshes **soonest** (5-hour window or weekly cap, whichever comes first); ties and accounts with no quota metadata yet keep the previous cyclic order, so a drained slot never bounces back to the primary, and rotation still never cools an account down on its own.
- **Fix: quota exhaustion and silent timeouts now retry onto the next account instead of dead-ending.** A hard server-issued quota / rate-limit refusal was classified as the generic `AGY_ERROR`, which the provider retry policy never retried — the account cooled down and the sticky pointer advanced, but the turn still surfaced a user-visible error while a healthy account sat idle. It now carries a dedicated, retryable `RATE_LIMIT` code, so the automatic retry is served by the next account in the pool. Deterministic `AGY_ERROR`s (bad region, empty request, pool fully cooled) deliberately stay single-shot. A **silent** timeout (no stdout event at all — unreachable Google or a wedged credential) now rotates the sticky pointer to the next account for the retry *without* a cooldown, so one account's black hole cannot masquerade as "all accounts in cooldown". Finally, `autoFallbackModel` is no longer useless: the hardcoded `gemini-3.5/3.6-flash` list downgraded *within* the exhausted family (all Gemini models share one quota pool), so a drained Google family could never be rescued — it now fails over across families (Gemini ⇄ Claude ⇄ GPT-OSS), which have separate quotas.
- **Fix: Antigravity console and chat toolbar now immediately display the active account when switching or after quota exhaustion.** When an account exhausted its 5h or weekly quota or hit rate limits, the scheduler advanced to the next backup account, but `lastActiveAccountId` was not proactively updated, leaving the console showing an outdated badge or no badge at all. `recordFailure` and `updateAccountQuotas` now proactively advance the active pointer immediately, self-heal client badges away from cooldown/quarantined accounts, clean up pointers when accounts are deleted/disabled/quarantined, and the chat toolbar button now visibly displays the active account alias (`AGY · <alias>`) in real-time. Furthermore, caller-aborted runs (`outcome.aborted`) are exempt from recording rate-limit failures, preventing ghost cooldowns (`"agy run aborted by caller"`) from poisoning pool rotation, and any historical abort cooldowns are automatically purged on startup.
- **Fix & Add: Mermaid diagram rendering with bundled local assets and universal block sniffing.** DSH renders fences with unknown grammar (like `mermaid`) as localized code blocks (labeled "代码块" in Chinese or "Code block" in English) with stripped or non-standard language attributes. Diagram detection now universally scans `.md-code-block` elements, filters known programming languages, and sniffs Mermaid diagrams from the content. Furthermore, `mermaid.min.js` (v11.17.2) is now served directly from the local plugin endpoint (`/plugins/agy-link/mermaid.min.js`), completely eliminating external CDN timeouts, failures, or blocking.
- **Fix: code cards referenced a non-existent font token, so the code font silently fell back to the hardcoded stack.** `ROW_CSS` spelled the DSH code-font token as `--dsw-font-family-code`, but the real token is `--ds-font-family-code` (no `w`). The mistyped name has zero definitions anywhere in DSH, so every `var(--dsw-font-family-code, <fallback>)` resolved to its hardcoded fallback (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), which carries no CJK coverage — Chinese text inside agy tool cards rendered in the OS default (SimSun / Microsoft YaHei) instead of the host's configured code font. The three affected selectors are `.agy-tv-card` (whose `font-family` is inherited by the header, copy button and body), `.agy-tv-preview` and `.agy-tv-diff-stat`.
- **Fix: tool-hop continuations no longer re-attach every historical screenshot.** When a continuation carried no new image, the prompt builder fell back to collecting attachments from *all* earlier user turns, so the same 4–5 UI screenshots were re-staged and re-referenced on every step (observed: 61 staged files for 5 unique images in one session). Image forwarding is now watermark-aware (`SessionBinding.sentImageIds`): only attachments the current agy conversation has not seen are staged. Staged files are also keyed by attachment id instead of call index, so a legitimate re-reuse overwrites rather than accumulates.
- **Fix: account / model switches now transfer the prior conversation properly.** A brand-new agy conversation (account switch, model switch, post-compaction re-seed) used to be seeded with only `digestMaxChars` (8K), silently dropping most of a long session. First contact now uses the new `contextTransferMaxChars` budget (default 660K, sized for 1M-token-class models), and the attachments that carry the visual context ride along once via the same image watermark.

### 中文 (Chinese)


- **修复（Windows）：中文工具输出不再乱码（issue #37）。** Windows 管道里的字节使用**子进程的控制台代码页**：中文系统上 agy 捕获到的 pwsh 输出是 CP936（GBK），而插件把整条流按 UTF-8 解码——中文报错于是变成乱码；又因为这段文本正是 agy 写入会话库的内容，损坏不可追回。现在 stdout/stderr 以**原始字节**读取并按**行**用控制台代码页解码（`chcp` 探测 → GBK/Big5/Shift_JIS/EUC-KR/Windows-125x），凡是合法的 UTF-8 行仍按 UTF-8 处理；POSIX 行为逐字节不变（探测直接返回 `utf-8`）。以「行」而非「块」为解码单位，是因为多字节字符可能跨块但绝不会跨换行。
- **修复：`dsh plugin add git+https://…` 安装现在会构建插件（issue #38）。** 仓库里没有提交 `dist/`，而只有 `prepack`——它**不会**在 git 依赖安装时执行，所以市场/git 安装得到的包没有 `dist/`，加载失败。现在新增 `prepare` 脚本，git 安装时会构建（npm/pnpm 会先为 git 依赖安装 devDependencies）；从 npm 安装的用户不受影响，因为 `prepare` 不会对已发布的 tarball 执行。安装其实在更早一步就已经失败：`@deepseek-ai/dsh-client-locale` 曾被声明为**非可选** peer，npm 的自动 peer 安装因此去公共 registry 拉取未发布的 `@deepseek-ai/dsh-paths@^0.0.1-rc.1` 依赖链并报 404 —— 现在所有 `@deepseek-ai/*` peer 都标为 optional（运行时由宿主提供，打包时保持 external），与第三方 DSH 插件的声明方式一致。
- **修复：线上「User location is not supported for the API use」区域拒绝现在被正确识别、解释并绕开。** 该拒绝报文是 agy 以退出码 3 + `FAILED_PRECONDITION (code 400)` 结果信封抛出的，而分类器只认得 issue #32 时期的旧措辞——于是它被当成裸 `PROCESS_EXIT`，粘性账号也不会移动，每次重试都撞同一个不支持的地区，所以你会觉得"总是出现这个问题"。现在该签名已被匹配，失败会带专用且**可重试**的 `ELIGIBILITY` 错误码与可操作提示，同时在错误抛出前把被拒账号从粘性指针上换掉（**不扣冷却**），自动重试就会落到代理/出口地区受支持的账号上。
- **新增：轮换优先使用「快过期」的账号（不用就浪费）。** 顺次兜底此前按号池顺序推进，可能让某账号 5 小时窗口里还剩 60%、20 分钟后就要刷新——这部分余量在刷新时会被直接丢弃，等于白扔。现在当粘性账号耗尽（硬限流 / 冷却 / 静默超时）时，轮换目标改为**额度窗口刷新最近**的可用账号（5 小时窗口与周额度取更早者）；时间相同或尚无额度信息时沿用原有循环顺序，既避免耗尽后回弹到主账号，也保证轮换本身不会给账号扣冷却。
- **修复：额度耗尽与静默超时不再「直接失败」，而是自动重试到下一个账号。** 服务器硬性限流/额度拒绝此前被归为通用 `AGY_ERROR`，而重试策略从不重试该错误码——账号确实进了冷却、粘性指针也确实推进了，但这一轮仍然把错误抛给用户，明明还有健康账号闲着。现在它使用独立的可重试错误码 `RATE_LIMIT`，自动重试即由池中下一个账号接管。确定性的 `AGY_ERROR`（区域不可用、空请求、全池冷却）刻意保持不重试。**静默超时**（全程零 stdout 事件——连不上 Google 或凭证卡死）现在会推进粘性指针到下一个账号供重试，且**不给账号扣冷却**，避免单个账号的黑洞被误报成「所有账号都在冷却」。另外 `autoFallbackModel` 不再是废功能：原先硬编码的 `gemini-3.5/3.6-flash` 是**同族内**降级（所有 Gemini 模型共用一个额度池），Google 族耗尽时永远救不回来；现在改为**跨族兜底**（Gemini ⇄ Claude ⇄ GPT-OSS，各自独立额度）。
- **修复：账号额度用尽或切号后，Antigravity 控制台与会话工具栏即时准确展示当前使用账号。** 当首选账号 5 小时/周额度用尽或触发限流冷却时，调度器虽能在内部切到次选账号，但此前 `lastActiveAccountId` 未被主动更新，导致管理控制台的绿色「当前使用」徽标停留在旧账号上或未点亮。现在 `recordFailure` 与 `updateAccountQuotas` 在耗尽时主动推进激活指针，前端直接信赖后端权威计算的当前账号；会话顶栏按钮直接常驻显示当前账号（如 `AGY · g98`），一目了然；同时修复了用户主动中断（Stop / 插话抢占）被误判为限流并给账号扣上“幽灵冷却”（`"agy run aborted by caller"`）的严重缺陷，启动时自动清理历史幽灵冷却。
- **修复与新增：Mermaid 图表离线本地直出与通用代码块识别。** DSH 的 Markdown 渲染管线没有 Mermaid 语法高亮，未识别的围栏会被渲染为“代码块”（英文 "Code block"）且语言标识可能丢失或非标准。探测机制现升级为全覆盖扫描 `.md-code-block`，排除常见编程语言后智能探测图表语法；并将 `mermaid.min.js` (v11.17.2) 随插件本地内置并由插件端口直出（`/plugins/agy-link/mermaid.min.js`），彻底告别外网 CDN 超时、连接挂起或被阻断导致的图表无法渲染问题。
- **修复：代码卡片引用了一个不存在的字体 token，导致代码字体静默回落到硬编码兜底栈。** `ROW_CSS` 里把 DSH 的代码字体 token 写成了 `--dsw-font-family-code`，而真实 token 是 `--ds-font-family-code`（无 `w`）。这个拼错的名称在整个 DSH 代码库里零定义，因此每一处 `var(--dsw-font-family-code, <兜底>)` 都取到硬编码兜底值 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`——该栈不含中文字形，导致 agy 工具卡片里的中文以系统默认字体（宋体 / 微软雅黑）渲染，而非宿主配置的代码字体。受影响的三个选择器是 `.agy-tv-card`（其 `font-family` 会向下继承到标题栏、复制按钮与正文）、`.agy-tv-preview` 与 `.agy-tv-diff-stat`。
- **修复：工具往返续跑不再重复附加全部历史截图。** 当续跑请求里没有新图片时，提示词组装会回退成收集**全部**历史 user 轮次的附件，于是同样的 4～5 张 UI 截图在每一步都被重新落盘、重新引用（实测一个会话 61 个暂存文件只有 5 份唯一内容）。图片转发现在按水位去重（`SessionBinding.sentImageIds`）：只暂存当前 agy 会话还没见过的附件。暂存文件名也改为按 attachment id 而不是调用序号，合法重用会覆盖而不是堆积。
- **修复：切换账号 / 切换模型后能正确带上此前的对话上下文。** 新建 agy 会话（切账号、切模型、压缩后重播种）此前只用 `digestMaxChars`（8K）做种子摘要，长会话的历史被大量丢掉。首次接入现在使用新的 `contextTransferMaxChars` 预算（默认 660K，面向 1M token 级模型），承载视觉上下文的图片也会通过同一水位机制补发一次。

## 0.4.43 (2026-10-03)

### English

- **Add: native Mermaid diagram rendering in DSH Desktop and Web.** Antigravity models (especially Gemini / Claude) frequently emit ````mermaid```` code blocks to visualize workflows, timelines, and architectures. Because DSH renders code blocks as plain text, diagrams previously showed as raw source text. `dsh-agy-link` now bundles an offline standalone Mermaid.js runtime (served from `/plugins/agy-link/assets/mermaid.min.js`) and mounts an interactive diagram viewer over `.md-code-block` elements:
  - Non-destructive DOM rendering preserving React's original `<pre>` structure to avoid re-render conflicts.
  - Tab switching between "Diagram" and "Code".
  - Interactive SVG zoom controls (Zoom In, Zoom Out, Reset, Fit).
  - Copy SVG source button with visual feedback.
  - Automatic dark/light theme synchronization with DSH's CSS color variables.
- **Add: local image & media display (`file:///`, absolute Windows & WSL paths) with fullscreen Lightbox.** Models generating or referencing local visual assets (e.g. concept art, mockups, artifacts) emit `file:///` URLs or local filesystem paths. Because DSH's markdown renderer rejects non-HTTP URLs (`remoteImageUrl`), images previously rendered as inert text (`<span class="imageAlt">`).
  - Added host endpoint `/plugins/agy-link/media` with security validation, MIME type sniffing, stream piping, and client cache headers, supporting Windows drive paths (`D:/...`), UNC paths, and WSL paths (`/mnt/...`, `/home/...`).
  - Integrated live streaming markdown image rewrite (`![alt](file:///...)` -> `![alt](http://127.0.0.1:${port}/plugins/agy-link/media?path=...)`).
  - Retrospective DOM enhancer inspecting React Fiber props on `<span class="imageAlt">` in historical session turns to recover original file paths and restore image previews retroactively.
  - Enhanced local file links (`a[href^="file://"]`) to image files with thumbnail previews.
  - Fullscreen interactive Lightbox modal with zoom, pan, and "Copy Path" button.
- **Add: interactive user decision & choice adaptation (`ask_question` and Markdown Choices).** Antigravity models actively solicit user decisions and guidance through the `ask_question` tool or structured markdown decision templates (`### 💬 请您拍板` / `请选择`).
  - Extended tool card mirroring for `ask_question` with structured question text, selectable answer badges, and a "Fill into Chat" action button.
  - Extended tool card mirroring for image tools (`generate_image`, `view_file` on images) with inline visual thumbnails and Lightbox triggers.
  - Added markdown choice scanner detecting decision headers and list options, mounting interactive quick-action selection chips that directly fill the selected option text into DSH's chat composer (`[data-composer-input]`).
- **Fix: code cards referenced a non-existent font token, so the code font silently fell back to the hardcoded stack.** `ROW_CSS` spelled the DSH code-font token as `--dsw-font-family-code`, but the real token is `--ds-font-family-code` (no `w`). The mistyped name has zero definitions anywhere in DSH, so every `var(--dsw-font-family-code, <fallback>)` resolved to its hardcoded fallback (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), which carries no CJK coverage — Chinese text inside agy tool cards rendered in the OS default (SimSun / Microsoft YaHei) instead of the host's configured code font. The three affected selectors are `.agy-tv-card` (whose `font-family` is inherited by the header, copy button and body), `.agy-tv-preview` and `.agy-tv-diff-stat`.
- **Fix (Windows): auto-detect system proxy from Windows Internet Settings (WinINet) to fix quota refresh and sync timeouts.** On Windows GUI hosts (DSH Desktop / Electron), `process.env` does not inherit terminal `HTTP_PROXY`/`HTTPS_PROXY` variables. Direct requests to Google endpoints (`daily-cloudcode-pa.googleapis.com` / `googleapis.com`) timed out behind GFW, silently dropping quota updates while the frontend showed "额度已刷新". The host now automatically detects system proxy settings from the Windows Registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` `ProxyServer`) and routes all undici fetch calls and child process environments through the proxy.
- **Fix (Windows): Windows Credential Manager multi-account collision / quota draining across pool accounts.** On macOS, each account has an isolated Keychain file (`login.keychain-db`) via `$HOME`. On Windows, `agy.exe` reads credentials via `zalando/go-keyring` (`advapi32!CredRead("gemini:antigravity")`), which accesses Windows Credential Manager globally per logon session and ignores `HOME` / `USERPROFILE`. When secondary pool accounts were spawned, `agy.exe` read the primary account's token from Credential Manager, running secondary turns under the primary account and draining its quota (e.g. `g98` dropping to ~17% while secondary accounts appeared unused). The host now actively synchronizes Windows Credential Manager before each turn with the target account's token, persists any refreshed tokens back to that account's directory upon completion, and restores the primary account upon release.

### 中文 (Chinese)

- **新增：DSH 客户端 / Web 端原生 Mermaid 流程图与图表渲染。** Antigravity 上的 Gemini 与 Claude 模型在梳理架构与方案时经常输出 ````mermaid```` 代码块。DSH 原本仅将其作为普通文本代码块展示，导致图表无法直观查看。`dsh-agy-link` 现内置离线 Mermaid.js 运行时（通过 `/plugins/agy-link/assets/mermaid.min.js` 托管），为所有包含 `mermaid` 代码块的区域挂载交互式图表卡片：
  - 无破坏性 DOM 操作，安全保留 React `<pre>` 节点结构以防重渲染崩溃。
  - "图表" 与 "代码" 标签页一键无缝切换。
  - 交互式缩放控制（放大、缩小、重置比例）。
  - 一键复制 SVG 源码到剪贴板。
  - 自动跟随 DSH 主题色（暗色 / 亮色）切换渲染配色。
- **新增：本地图片与媒体展示（支持 `file:///`、Windows 绝对路径与 WSL 路径）及全屏灯箱。** 模型在生成或引用本地视觉资源（如设计图、原画预览、制品图）时，通常会输出 `file:///` 协议或本地文件系统路径。DSH 内置的 Markdown 渲染器出于安全只接收 HTTP(S) 地址，导致图片回退为静态文本 `<span class="imageAlt">`。
  - 插件后端新增 `/plugins/agy-link/media` 路由，具备安全边界校验、MIME 类型自动推断、流式传输与客户端缓存支持，全面兼容 Windows 盘符路径（`D:/...`）、UNC 路径以及 WSL 环境路径（`/mnt/...`、`/home/...`）。
  - 流式响应实时重写：在模型输出流中即时将 `![alt](file:///...)` 转换为通过本地服务代理的安全可访问 URL。
  - 历史会话无损追溯：前端增强器通过 React Fiber 属性提取历史消息中已失效 `<span class="imageAlt">` 的原始路径，自动补全渲染出真实缩略图，重开历史对话亦可完整查看图片。
  - 本地超链接图片识别：自动识别指向图片的 `file://` 链接并在下方挂载缩略图。
  - 全屏交互式灯箱（Lightbox）：支持双击/按钮放大缩小、拖拽平移以及「复制路径」到剪贴板。
- **新增：用户选择与拍板决策交互适配（`ask_question` 工具卡片与 Markdown 决策选项快捷填入）。** Antigravity 体系下的模型经常调用 `ask_question` 或输出结构化的拍板询问（如 `### 💬 请您拍板：1. 路线 A... 2. 路线 B...`）。
  - 深度适配 `ask_question` 工具卡片：以结构化卡片渲染问题与候选选项，提供候选气泡及「填入输入框」一键操作。
  - 扩展图片类工具卡片预览：`generate_image` 以及针对图片路径调用的 `view_file` 均以大图卡片配合直接查看与灯箱展示。
  - 自动扫描 Markdown 拍板决策区：自动识别「请您拍板 / 请您指示 / 请选择」等段落选项，挂载交互式快捷选项芯片（Chips），点击即可自动填入 DSH 底部聊天输入框，极大提升人机协作效率。
- **修复：代码卡片引用了一个不存在的字体 token，导致代码字体静默回落到硬编码兜底栈。** `ROW_CSS` 里把 DSH 的代码字体 token 写成了 `--dsw-font-family-code`，而真实 token 是 `--ds-font-family-code`（无 `w`）。这个拼错的名称在整个 DSH 代码库里零定义，因此每一处 `var(--dsw-font-family-code, <兜底>)` 都取到硬编码兜底值 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`——该栈不含中文字形，导致 agy 工具卡片里的中文以系统默认字体（宋体 / 微软雅黑）渲染，而非宿主配置的代码字体。受影响的三个选择器是 `.agy-tv-card`（其 `font-family` 会向下继承到标题栏、复制按钮与正文）、`.agy-tv-preview` 与 `.agy-tv-diff-stat`。
- **修复 (Windows)：自动识别 Windows 系统代理（WinINet），修复点击「刷新/同步」额度静默超时失效。** Windows 桌面版客户端（Electron GUI）启动时，`process.env` 默认不包含终端环境下的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。当未在设置里显式填入代理时，直连 Google 额度接口（`daily-cloudcode-pa.googleapis.com` 及 `googleapis.com`）会触发连接超时，后端异常捕获后静默退出，前端虽提示「额度已刷新」但数值永远保持原样。插件现增加自动注册表探针（读取 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`），自适应识别系统代理（如 `127.0.0.1:17891`），并自动注入到 undici 请求与子进程环境变量中。
- **修复 (Windows)：Windows 凭据管理器跨账号撞车，导致池中副账号偷偷消耗主账号（g98）额度。** macOS 下每个账号拥有独立的钥匙串文件（`login.keychain-db`），通过重定向 `$HOME` 即可实现天然隔离；而 Windows 下 `agy.exe` 使用 `zalando/go-keyring`，直接调用 Win32 API `advapi32!CredRead("gemini:antigravity")`。Windows 凭据管理器是全局绑定到当前登录会话的，完全忽略 `HOME` 与 `USERPROFILE`！这导致无论池中调度哪个副账号，`agy.exe` 启动时始终读取系统凭据管理器中残留的主账号 token 执行，造成「用着副账号，消耗的全是主账号额度」（导致用户发现 g98 额度无故跌至十几个点而副账号几乎不动）。插件现针对 Windows 实现动态凭据同步：每次调用前将目标账号 token 瞬时写入 `gemini:antigravity`，调用结束后将最新刷新后的 token 存回该账号目录，并自动恢复主账号原始凭据。


## 0.4.42 (2026-09-30)

### English

- **Fix: provisioned pool keychains are now set to never auto-lock.** A created keychain can lock later (system sleep / lock policy); a locked keychain turns every agy keyring save into an unanswerable password dialog — the keychain password is random and only the plugin knows it, so the user's login password is always rejected. `ensureIsolatedKeychain` now applies never-auto-lock settings on every boot/spawn/login (idempotent), not just at creation.

### 中文 (Chinese)

- **修复：预置的池账号钥匙串现在设置为永不自动锁。** 新建的钥匙串之后可能被系统上锁（系统睡眠/锁定策略）；一旦上锁，agy 的每次 keyring 保存都会弹一个**无法回答**的密码框——钥匙串密码是随机的、只有插件自己知道，用户输登录密码永远不对。`ensureIsolatedKeychain` 现在在每次启动/拉起/登录时都会幂等地套用"永不自动锁"设置，而不仅仅在创建时。

## 0.4.41 (2026-09-30)

### English

- **Fix: the UI Stop button could not kill an offline wedged run.** `killTree` sent a single SIGTERM to the process group; agy's graceful-shutdown path ignores it while the process is wedged in offline dial retries (verified live: the run survived `kill <pid>` and only died on `kill -9`). The runner now escalates to SIGKILL for the whole group 3s after SIGTERM, so Stop always wins.
- **Fix: offline runs spun on "thinking" forever.** The idle watchdog treated stderr chatter as activity — agy logs a dial-retry line to stderr every ~35s when it cannot reach Google, so a run that never emitted one stdout event stayed "active" until the 240m print-timeout. The watchdog is now **stdout-only**; login flows opt back in via the new `stderrKeepalive` run option (a browser login is legitimately stdout-silent for minutes). A timeout with zero stdout events now reports the likely cause: the run cannot reach Google (check proxy/network).
- **Add: global `proxyUrl` config (`DSH_AGY_PROXY_URL` env works too).** GUI hosts don't inherit shell proxy env — the #1 reason plugin runs time out while the same command in a terminal works. An account's dedicated `proxyUrl` wins, then the global config; the effective proxy is injected into every agy spawn (`ALL_PROXY`/`HTTP(S)_PROXY`) and used by the quota / OAuth fetches. `/agy pool` now shows the effective proxy per account.
- **Fix (macOS): recurring "create login keychain" password popup.** Pool accounts run with an isolated HOME, and macOS has **no login keychain inside it** (`security default-keychain` → "A default keychain could not be found"), so agy's keyring save triggered the `system.keychain.create.loginkc` password dialog on every ~hourly token refresh; denying it fell back to the on-disk token (auth kept working — exit status 45/154 in agy logs). The plugin now provisions a throwaway per-account keychain and sets it as the default under that HOME — idempotently at boot, before every spawn and before every login — so keyring writes are silent and truly per-account.
- **Fix: transient network errors no longer flag accounts as "needs re-login".** Both flagging paths were too eager: the run-failure path matched any message containing `/auth/i` (e.g. `oauth2.googleapis.com … i/o timeout` transport noise) and the token-refresh path flagged **any** `token endpoint 400` — including captive-portal / proxy error pages. Both now require an authoritative OAuth state (`invalid_grant` / `invalid_client` / `revoked` / `disabled` / `unauthorized_client`) and transport-shaped failures are exempt — even a genuine AUTH classification is not trusted when the message is transport-shaped. A false flag also **removed the account from pool rotation** (`selectAccount` skips authRequired), so this was silent capacity loss plus a scary badge that the next manual quota refresh would immediately disprove.
- **Add: flagged accounts self-heal in the background.** `markAuthRequired` now stamps `authMarkedAt`; after 10 minutes the background poll includes the flagged account for one token verification — if the stored refresh token still works the flag clears itself (previously this required a manual 刷新额度 click); if it is truly dead the flag is re-stamped. Risk-control exposure: at most one token-endpoint call per 10 minutes per flagged account.
- **Add: "In use" badge in the Antigravity console.** Exactly **one** account card shows the green zap badge: the account of the most recent agy spawn (`lastActiveAccountId`), localized (zh/en/pt-BR/es). The per-family scheduler pointers (`activeAccountIds`) are an internal scheduling detail and can legitimately sit on families that are not running anything — deriving the badge from them lit up two cards at once, which reads as "two accounts in use".
- **Fix: a steer replacement now waits for the run it killed to exit.** A new prompt arriving while a run is live preempts that run and resumes the same agy conversation (`--conversation <id>`); the replacement spawn previously raced the abort, so two agy processes could briefly append to one conversation. The spawn now waits (bounded, 3.5 s) for the aborted run to settle.
## 0.4.40 (2026-09-28)

### English

- **Fix (issue #34): post-tool hops dropped the task text and images.** dsh-llm 0.1.7 promotes tool results to `role: 'tool'` (0.1.x used `role: 'user'` + `source.callId`). `detectContinuation` and the trailing-span extractor only accepted the 0.1.x shape, so every hop after the first tool round-trip lost the mirror continuation, assembled an empty/digest-only prompt (`request carries no user text` or "what should I do next?"), and silently dropped image attachments. Both schemas are now accepted (`message.toolCallId`, `source.callId`, nested `tool-result` blocks); nested tool-result text and images are forwarded.
- **Fix (issue #35): continuation prompts must keep the live task.** `buildDigest` used to let a wall of tool-result text consume the 8K budget and truncate the user's question away. The latest real user turn is now reserved at the head of the digest; the assembled prompt always re-states it whenever the trailing span is tool-results only. A dead loop of "read my own agy logs" with no task can no longer start.
- **Fix (issue #35): aborted runs now persist the agy conversation id.** Binding was only written when `failure === null`, but a tool-cut / caller abort / timeout is exactly the path that used to drop it — so the next hop always started a brand-new agy conversation (`conversationID=""`) with digest-only prompt. The id is now harvested from a live run before steer-preemption and persisted on abort/timeout/process-exit (auth / rate-limit / conversation-rejected still drop the binding).
- **Fix (issue #32): region eligibility refusals get a clear cause.** agy exits 1 with `Eligibility check failed: … not currently available in your location` (e.g. Seoul). This is a Google-side account/region restriction, not a proxy or quota bug. The bridge now classifies it and surfaces an explicit `AGY_ERROR` with guidance instead of a bare `PROCESS_EXIT`.

### 中文 (Chinese)

- **修复：UI 的 Stop 按钮杀不掉离线卡死的 run。** `killTree` 只对进程组发一次 SIGTERM；而 agy 困在离线拨号重试里时会无视 SIGTERM（实测 `kill <pid>` 无效、只有 `kill -9` 能杀掉）。现在 runner 在 SIGTERM 3 秒后对整组升级 SIGKILL，Stop 按钮必定生效。
- **修复：连不上 Google 时 run 永远转圈。** 旧看门狗把 stderr 输出当作活动——agy 连不上 Google 时每 ~35 秒往 stderr 写一条拨号重试日志，于是一个连一条 stdout 事件都没有的 run 一直“活着”，直到 240 分钟的 print-timeout。看门狗现在**只认 stdout**；登录流程通过新的 `stderrKeepalive` 选项继续保活（浏览器登录本来就会长时间没有 stdout）。零 stdout 事件的超时现在会直接说明原因：无法连接 Google（检查代理/网络）。
- **新增：全局 `proxyUrl` 配置（也支持 `DSH_AGY_PROXY_URL` 环境变量）。** GUI 应用不继承 shell 的代理环境变量——这是“终端里没问题、插件里必超时”的头号原因。账号专属 `proxyUrl` 优先，其次全局配置；生效代理会注入每个 agy 进程（`ALL_PROXY`/`HTTP(S)_PROXY`），额度 / OAuth 请求同样走代理。`/agy pool` 现在会显示每个账号的生效代理。
- **修复（macOS）：反复弹出“创建登录钥匙串”密码框。** 池账号使用隔离 HOME，而隔离 HOME 里**没有登录钥匙串**（`security default-keychain` → "A default keychain could not be found"），agy 每次约每小时的 token 续期写入都会触发 `system.keychain.create.loginkc` 密码弹窗；取消后回退磁盘 token（认证不受影响——agy 日志里的 exit status 45/154 即此）。插件现在会为每个池账号预置一个专属的一次性钥匙串并设为该 HOME 的默认——在启动时、每次拉起前、每次登录前幂等执行——钥匙串写入从此静默，且真正做到按账号隔离。
- **修复：瞬时网络错误不再把账号标记为「需重新登录」（误判修复）。** 两条标记路径都过于激进：run 失败路径会匹配任何包含 `/auth/i` 的报错（比如 `oauth2.googleapis.com … i/o timeout` 这种纯传输噪音）；token 刷新路径会把**任何** `token endpoint 400` 都当成认证死亡——包括代理/门户返回的错误页。现在两条路径都要求出现权威的 OAuth 状态（`invalid_grant` / `invalid_client` / `revoked` / `disabled` / `unauthorized_client`），传输型失败一律豁免——即使带 AUTH 分类，只要报错文本是传输形态也不标记。误判的代价不只是吓人的徽标：被标记的账号会被调度器**排除出轮换**，等于静默损失一个账号，直到手动「刷新额度」把它证伪。
- **新增：被标记的账号后台自动复验。** `markAuthRequired` 现在会记录 `authMarkedAt`；10 分钟后后台轮询会把该账号放进来做一次 token 验证——刷新令牌若仍可用，标记自动清除（以前必须手动点「刷新额度」）；若真的失效则重新盖章。风控代价：每个被标记账号至多每 10 分钟一次 token endpoint 调用。
- **新增：控制台「当前使用」标识。** 现在**只会有一张**账号卡片显示绿色 ⚡「当前使用」徽标：最近一次真正拉起 agy 的账号（`lastActiveAccountId`），四种语言（zh/en/pt-BR/es）均已本地化。按模型族的调度指针（`activeAccountIds`）只是内部调度细节，可能停在当前并没有跑任何东西的模型族上——用它做徽标会一次点亮两张卡，看起来像"两个账号在用"。
- **修复：插话（steer）替换进程现在会等被抢占的 run 真正退出。** run 还在跑时来一条新提示词会抢占该 run 并续用同一个 agy 会话（`--conversation <id>`）；此前替换进程与 abort 存在竞争，极端情况下会有两个 agy 进程短暂同时往同一个会话追加。现在拉起前会有界等待（3.5 秒）被抢占的 run 收尾。
## 0.4.40 (2026-09-28)

### 中文 (Chinese)

- **修复 #34：工具往返之后任务文本和图片丢失。** dsh-llm 0.1.7 把工具结果提升为 `role: 'tool'`（0.1.x 是 `role: 'user'` + `source.callId`）。`detectContinuation` 与尾部消息提取只认 0.1.x 形态，于是第一次工具往返之后的每一跳都丢掉镜像续跑，拼出空 prompt 或纯 digest（`request carries no user text`，或 agy 反问「接下来做什么」），图片附件也一并丢失。现在两种 schema 都识别（`message.toolCallId` / `source.callId` / 嵌套 `tool-result`），嵌套工具结果文本与图片会一并转发。
- **修复 #35：续跑提示词必须保住任务。** 旧 `buildDigest` 允许大段工具结果吃掉 8K 预算，把用户的问题截掉。现在最新一条真实用户消息固定保留在 digest 开头；只要尾部只有工具结果，组装出的 prompt 也会重申该任务。「反复读自己日志、没有题目」的死循环不会再出现。
- **修复 #35：aborted 路径也会落库 conversationId。** 旧逻辑只在 `failure === null` 时写 binding，而工具切断 / 调用方中止 / 超时恰恰是最容易丢 id 的路径——下一跳于是每次都开全新 agy 会话（`conversationID=""`）+ 纯 digest。现在会在 steer 抢占前从 live run 收割 id，并在 abort/timeout/process-exit 时落库（auth / 限流 / 会话失效仍会删除 binding）。
- **修复 #32：地区资格拒绝给出明确原因。** agy 以 `Eligibility check failed: … not currently available in your location` 退出（例如首尔）。这是 Google 账号/地区限制，不是代理或额度问题。桥接层现在会识别并给出明确的 `AGY_ERROR` 与指引，而不是裸的 `PROCESS_EXIT`。

## 0.4.39 (2026-09-21)

### English

- **Fix (issue #33): DSH session interrupt during long tools (maven / compile).** An ACTIVE agy tool is silent on stdout for many minutes while it builds. The idle watchdog used the normal `timeoutMs` (default 10 min) and killed the healthy run mid-compile. While any tool step is outstanding the idle budget now rises to the print-mode ceiling (≥ 4 h) and restores to `timeoutMs` when the last tool completes (`RunningProcess.noteActivity`).
- **Fix (issue #33): identical retries no longer preempt a live long tool.** Session ownership is decided after prompt assembly: same prompt + live run → `BUSY` (leave the maven/compile alone); different prompt + live run → steer-preempt; settled run → retry allowed (still honors issue #32).

### 中文 (Chinese)

- **修复 #33：耗时工具（Maven/编译）期间会话被中断。** 工具 ACTIVE 后 agy 在 stdout 上长时间静默是正常的；旧空闲看门狗按 `timeoutMs`（默认 10 分钟）把还在编译的进程杀掉。现在只要存在未完成的工具步骤，空闲预算就抬到 print-mode 上限（≥ 4 小时），工具全部结束后恢复 `timeoutMs`。
- **修复 #33：同 prompt 重试不再抢占正在跑的长任务。** 会话所有权在 prompt 组装之后判定：同 prompt + live run → `BUSY`（不杀 Maven/编译）；不同 prompt + live run → 作为 steer 抢占；已 settle 的请求仍放行重试（兼容 #32）。

## 0.4.38 (2026-09-21)

### English

- **Fix (issue #32): "Duplicate request ignored" dead-end after a failed turn.** The in-flight debounce used a 10-second time wall keyed only on identical prompt text, and never cleared when a run settled. DSH auto-retries after a fast agy failure; that retry was rejected as `BUSY`, so every subsequent turn looked like "model unreachable" even with quota at 100% and a healthy proxy. Debounce now rejects only while a live (unsettled) run owns the session, or during a tight pre-spawn double-submit race. Settled runs (success / error / abort) never block a retry. A stream that itself preempts a live run always proceeds.

### 中文 (Chinese)

- **修复 #32：失败后重试被「Duplicate request ignored」卡死。** 旧的防抖只按「同 prompt + 10 秒」拦截，且请求结束后不清理。agy 快速失败后 DSH 会自动重试，结果被当成 BUSY 拒掉，后续每一轮都看起来像「模型不可访问」（额度 100%、代理正常也会中招）。现在只有会话上仍存在未结束的 live run，或 spawn 前极短窗口内的真双击，才会拒绝；已 settle 的请求（成功/失败/中止）一律放行重试；由本请求抢占 live run 的新回合一定放行。

## 0.4.37 (2026-09-18)

### English

- **Fix: ordinary `run_code` calls lost the code card.** The keyed `tool.call.toolview` registration for `run_code` **replaces** the host's built-in code row (a keyed slot is a takeover, not an addition), so every non-mirror Code Mode program was rendered by the plugin's fallback wrapper instead of DSH's code card. That wrapper used three classes — `agy-tv-header`, `agy-tv-badge`, `agy-tv-pre` — that carry **no CSS rule at all** in this package or in the host, so the icon, title and copy affordance disappeared and the body rendered as unstyled block text; the program was also silently truncated to 400 characters.
  - Non-mirror programs now render through a new `AgyCodeToolView` that reuses the mirror card's own styled vocabulary (`agy-tv-row`, `agy-tv-leading`, `agy-tv-title`, `agy-tv-sep`, `agy-tv-summary`, `agy-tv-card`, `agy-tv-card-content`, `agy-tv-copy-btn`): tool icon, localized title, `description` (or first program line) as the summary, click-to-expand full program, and a copy button.
  - Mirror wrappers are unaffected: they still delegate to `AgyMirrorToolView`, and the classification is byte-for-byte unchanged.
  - Added `code.title` / `code.inspect` / `code.copy` / `code.copied` to all four locale dictionaries, and declared `locale: NS` on the `run_code` registration so the standard `t` seat resolves them.

### 中文 (Chinese)

- **修复：普通 `run_code` 调用丢失代码卡片。** `run_code` 的 keyed `tool.call.toolview` 注册是**接管**而非叠加，因此每一次非镜像的 Code Mode 程序都落到插件的兜底包装上，而该包装用的 `agy-tv-header` / `agy-tv-badge` / `agy-tv-pre` 三个类在本包与宿主中**都没有任何 CSS 规则**——图标、标题与复制入口消失，正文变成无样式块级文本，程序还被静默截断到 400 字。
  - 非镜像程序改由新的 `AgyCodeToolView` 渲染，复用镜像卡片自身的样式词汇：工具图标、本地化标题、`description`（或程序首行）摘要、点击展开全文、复制按钮。
  - 镜像包装不受影响：仍委托 `AgyMirrorToolView`，分类结果逐字节不变。
  - 四份词典补齐 `code.title` / `code.inspect` / `code.copy` / `code.copied`，并在 `run_code` 注册上声明 `locale: NS`，让标准 `t` 座位解析这些键。

## 0.4.36 (2026-09-18)

### English

- **Fix (issue #30): Windows quota panel empty.** `readSystemKeychainToken()` had no win32 branch; primary credentials live in Windows Credential Manager (`gemini:antigravity`), not a disk token file. Added a PowerShell `CredRead` reader (same zero-dep pattern as macOS `security` / Linux `secret-tool`).
- **Fix: thinking blank after a reply finishes.** The client no longer rewrites React-managed `thinkBody` DOM (that wiped thought text on post-turn re-render). Styling is CSS-only; auto-expand uses the host disclosure control when prose is present.

### 中文 (Chinese)

- **修复 #30：** Windows 额度读取 — 从 Credential Manager 读 `gemini:antigravity`。
- **修复：思考结束后变空** — 不再改写宿主 React 的 thinkBody；仅 CSS + 非破坏性展开。

## 0.4.35 (2026-09-18)

### English

- **Reasoning UI: only show thinking when there is real content.** Empty `[agy thinking turn · N thinking tokens]` chips no longer spam tool-heavy turns. When agy stores only `toolAction`/`toolSummary` (common), those become the visible thought line (e.g. `Searching the web — Search Wo Tianyu profile`). Full CoT prose still renders when present in the conversation DB.

### 中文 (Chinese)

- **思考 UI：** 无正文时不再刷 token 横幅；工具步骤优先展示 `toolAction`/`toolSummary` 作为意图说明；完整思维链仍按 DB 正文展示。

## 0.4.34 (2026-09-18)

### English

- **UI: cleaner tool cards in Code Mode.** When DSH registers `agy_tool`, the bridge now emits native tool-call blocks instead of `run_code` wrappers. Code Mode titles use a human preview (`$ ls · run_command`) instead of `replay agy tool step N`. A `run_code` toolview renders Antigravity cards when the program is still a mirror wrapper.
- **UI: less thinking spam.** Banner-only `[agy thinking turn · N tokens]` chips (no prose) emit at most once per run; turns that extract thought prose still show full reasoning.

### 中文 (Chinese)

- **界面：** Code Mode 下工具卡片更干净；有 prose 的思考仍完整展示，无正文的 token 横幅每轮最多一条。

## 0.4.33 (2026-09-18)

### English

- **Fix: thinking / tool-args invisible for pool accounts.** agy conversation SQLite DBs for isolated accounts live under `~/.dsh/agy-accounts/<id>/.gemini/antigravity-cli/conversations`, not system `~/.gemini`. The reader now searches the run's account home, `GEMINI_CLI_HOME`, system home, and pool account dirs.
- **Fix: `/agy status` could hang the command UI.** Auth probe is now bounded (8s) so command results always return (issue #29 symptom).

### 中文 (Chinese)

- **修复：号池隔离账号看不到思维链/工具参数** — 会话库在账号自己的 HOME 下，读取时会搜索账号目录。
- **修复：`/agy status` 可能挂起导致命令无输出** — 探测加 8s 超时。

## 0.4.32 (2026-09-17)

### English

- **Fix: agy Active Workspace falls back to C-drive scratch (issue #26).**
  - agy ignores process `cwd` for workspace activation; the resolved DSH/session workspace root is now always passed via `--add-dir` (in addition to media staging dirs).
- **Fix: `/agy <subcommand>` treated as plain chat (issue #27).**
  - Registered `input.hint` on the `/agy` command so DSH's composer intercepts `/agy workspace`, `/agy status`, etc. instead of silently falling back to a prompt.
- **Feature (via PR #25): stream full model thoughts** from agy SQLite (protobuf field 20.3) as native reasoning blocks.

### 中文 (Chinese)

- **修复：agy 无 Active Workspace、落到 C 盘 scratch（#26）** — 工作区根目录现在会通过 `--add-dir` 传入。
- **修复：`/agy` 子命令被当普通对话（#27）** — 补上 `input.hint` 声明。
- **特性（PR #25）：** 从 agy SQLite 提取并流式展示完整思维链。

## 0.4.31 (2026-09-17)

### English

- **UI & UX: Align thinking process and tool invocation view with native DeepSeek Harness (DSH) styling.**
  - **Native SVG Icons & Hover Transition (`src/client/toolview.ts` & `src/client/reasoning.ts`)**: Integrated native DSH icons (`IconChevronDownOutline14`, `IconApiOutline14`, `IconCodeOutline16`, `IconEditOutline16`, `IconBrowseOutline16`, `IconSearchOutline16`, `IconCopyOutline16`, `IconCheckOutline14`). Hovering over a row smoothly transitions the leading icon into a downward chevron (`chevronHover`, opacity 0 -> 1), reproducing official DSH micro-interactions.
  - **Tool Row & Card Restyling (`src/client/toolview.ts`)**: Replaced custom boxed badges with native 24px borderless inline rows featuring official running sweep animation (`data-state="run"`). Expanded card includes an interactive header with Cwd, command/path, and a one-click copy button with temporary checkmark feedback.
  - **Scrollable Long Content (`src/client/toolview.ts`)**: Added scrollable bounds (`max-height: 260px` / `280px` with thin scrollbars) for terminal stdout, file edits/diffs, and file viewing, preventing long output from overwhelming the chat stream.
  - **Reasoning Process Presentation (`src/client/reasoning.ts`)**: Adheres to official DSH default collapsed state. Implemented scrollable container (`max-height: 360px`) with slim scrollbars for expanded reasoning thoughts and styled turn metadata into clean tags (`.agy-thought-banner`).

### 中文 (Chinese)

- **界面与交互：深度对齐官方 DeepSeek Harness (DSH) 默认思维链与工具调用展示样式。**
  - **原生 SVG 图标与鼠标悬停动效（`src/client/toolview.ts` 与 `src/client/reasoning.ts`）**：集成官方原生工具图标（`IconChevronDownOutline14`、`IconApiOutline14`、`IconCodeOutline16`、`IconEditOutline16`、`IconBrowseOutline16`、`IconSearchOutline16`、`IconCopyOutline16`、`IconCheckOutline14`）。鼠标悬浮整行时，小图标平滑过渡显示为下拉箭头图标（`chevronHover`，opacity 0 → 1），高度还原官方原生微动效。
  - **工具行与卡片设计还原（`src/client/toolview.ts`）**：移除冗余徽章药丸，还原原生 24px 无边框轻量内联行与运行态扫光动画（`data-state="run"`）；展开卡片包含 Cwd、命令/路径头部与交互式「复制」按钮（带「已复制」反馈与自动复原）。
  - **超长内容滚动浏览（`src/client/toolview.ts`）**：针对终端输出、文件查看与 Diff 代码块增加最大高度限制（`max-height: 260px` / `280px`）与微型细滚动条，避免超长内容撑乱对话流。
  - **思维链正文呈现（`src/client/reasoning.ts`）**：遵循官方默认折叠规范；为展开后的思考过程增加独立滚动浏览区域（`max-height: 360px`）与细滚动条，并将轮次思考元数据美化为轻量圆角标签（`.agy-thought-banner`）。

## 0.4.30 (2026-09-15)

### English

- **Feature: Extract and stream model thoughts/reasoning from agy database.**
  - **Protobuf Field 20.3 Extraction (`src/host/agy-db.ts`)**: Decodes full model Chain-of-Thought (thoughts) from agy SQLite conversation databases (`steps` table, step_type `14`/`15` agent_response) via a deterministic varint protobuf scanner with sub-millisecond execution and zero external dependencies.
  - **Live Streaming Reasoning Card (`src/host/mapper.ts` & `src/host/adapter.ts`)**: Injects resolved thoughts into native DSH reasoning blocks (`reasoning: true`), presenting the structured template `[agy thinking turn · {N} thinking tokens]\n\n{thoughtBody}` for model thinking turns. Supports both eager leading reasoning blocks and deferred trailing blocks without breaking tool spans or text fragments.
  - **Client-Side Auto-Expansion (`src/client/reasoning.ts`)**: Auto-expands reasoning blocks when thoughts prose is present, while strictly respecting manual user collapse actions via DOM attribute tracking.
  - **Run Traceability (`src/host/recording.ts`)**: Persists extracted thought text in `AgyRunRecording` for full lifecycle traceability and replay.

### 中文 (Chinese)

- **特性：从 agy 数据库提取并流式展示完整思维链（Reasoning/Thinking）。**
  - **Protobuf Field 20.3 确定性解码（`src/host/agy-db.ts`）**：针对 agy 会话 SQLite 库（`steps` 表，step_type `14`/`15` agent_response），通过原生 Varint Protobuf 扫描器高性能提取模型完整思考正文（Field 20 -> Sub-field 3），亚毫秒级解析且无额外依赖。
  - **原生 Reasoning 卡片流式呈现（`src/host/mapper.ts` 与 `src/host/adapter.ts`）**：将提取到的思考内容流式推送至 DSH 原生推理卡片（`reasoning: true`），格式化呈现 `[agy thinking turn · *** thinking tokens]\n\n{思维链正文}`；支持前置流式输出与延迟解析补发，与工具步骤及正文片段无缝衔接。
  - **客户端智能展开（`src/client/reasoning.ts`）**：检测到思维链正文时自动展开 Reasoning 卡片，并通过 DOM 属性标记保证用户手动折叠行为不被覆盖。
  - **会话持久化与回放（`src/host/recording.ts`）**：在 `AgyRunRecording` 中记录思维链内容，保障全生命周期可追溯与回放。

## 0.4.29 (2026-09-15)

### English

- **Hotfix: client blank page / `cannot get property "locale" without inject` (issue #24).**
  - 0.4.28 removed `locale` from the client `export inject` list while still reading `ctx.locale`. Cordis treats every inject entry as a hard dependency and throws on undeclared service access, so the web client failed to load.
  - Restored `inject = ['slots', 'locale']`, use `ctx.locale` directly, and mark `@deepseek-ai/dsh-client-locale` as a required peer (shipped with `dsh-web-app`).

### 中文 (Chinese)

- **热修：0.4.28 客户端白屏 / `cannot get property "locale" without inject`（#24）。**
  - 0.4.28 把 `locale` 从 client `inject` 里拿掉却仍访问 `ctx.locale`；Cordis 对未声明服务的属性访问会直接抛错。
  - 恢复 `inject = ['slots', 'locale']`，直接使用 `ctx.locale`，并将 `@deepseek-ai/dsh-client-locale` 标回必选 peer。

## 0.4.28 (2026-09-15)

### English

- **Fix: Long prompts no longer hit Windows `spawn ENAMETOOLONG` (issues #14 / #11).**
  - When assembled argv would exceed a 24KB budget, the bridge drops `-p <prompt>` and feeds the prompt via `--input-format stream-json` on stdin (`{"event":"user","message":{"role":"user","content":...}}`), verified against live agy 1.2.x.
- **Fix: No flashing CMD consoles on Windows GUI hosts (issue #13).**
  - `openBrowser` and pool `open-terminal` / `add` `execFile('cmd.exe', …)` now pass `windowsHide: true`.
- **Fix: Dropped keyword-driven Recovery-boundary prompt injection** (from PR #20). Missing-file guidance stays in `/agy status` only.
- **Fix: Harden agy conversation DB reads.** Conversation ids are whitelist-validated before path join (path-traversal guard).
- **i18n: `@deepseek-ai/dsh-client-locale` is an optional peer.** Older DSH hosts install cleanly; the client falls back to Chinese strings when `ctx.locale` is absent.
- **CI: fork PR workflow approval documented** in `AGENTS.md` (maintainers approve `action_required` runs).
- **Fix: Windows conhost flash from agy itself (issue #23).**
  - Every agy spawn now defaults `AGY_CLI_DISABLE_AUTO_UPDATE=1` and `AGY_CLI_INTERACTIVE_HEADLESS=1` (present in the official binary; breaks the `--bg-updater` child chain that creates visible conhost even under `windowsHide`). Operator-set values win.
  - Boot-time `agy --version` + catalog probe is deferred 4s (unref'd); catalog still refreshes lazily on first model list / turn.

### 中文 (Chinese)

- **修复：长 prompt 在 Windows 上触发 `spawn ENAMETOOLONG`（#14 / #11）。**
  - argv 预算超过 24KB 时改为 `--input-format stream-json` 经 stdin 传入 prompt，协议已在本机 agy 1.2.x 验证。
- **修复：Windows GUI 下 CMD 窗口闪烁（#13）** — 相关 `execFile` 增加 `windowsHide: true`。
- **修复：移除关键词驱动的 Recovery boundary prompt 注入**；missing_file 指引仅保留在 `/agy status`。
- **加固：** agy 会话库 conversation id 白名单校验，防路径穿越。
- **i18n：** locale peer 改为可选，旧宿主可安装；无 `ctx.locale` 时回退中文。
- **CI：** 在 `AGENTS.md` 记录 fork PR 需维护者批准 workflow。
- **修复：Windows 上 agy 自身拉起可见 conhost（#23）。** 所有 agy spawn 默认注入 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 与 `AGY_CLI_INTERACTIVE_HEADLESS=1`（阻断 `--bg-updater`）；启动探测延迟 4s。

### English

- **Feature: Native `agy_tool` Tool Card UI for DSH >= 0.1.5.**
  - **Root cause (verified against DSH 0.1.5-rc.2)**: The browser conversation UI (`@deepseek-ai/dsh-client-ui-tool`) hardcodes card rendering by wire tool name through a lookup table (`TOOL_VARIANTS`: `bash`/`pwsh`→terminal, `write`/`edit`→diff, `read`/`grep`/`glob`→read/search, etc.), and never consults `presentCall`/`presentResult`. The bridge's internal `agy_tool` had no entry, causing every mirrored tool step (`run_command`, `write_to_file`, `replace_file_content`, `view_file`, `grep_search`, ...) to regress to a generic "agy_tool" raw JSON text row.
  - **Fix**: Registered a keyed `tool.call.toolview` extension slot for `agy_tool`, rendering native cards (`terminal`, `diff`, `read`, `search`, `list`, `delete`, `generic`) directly from mirror arguments in pure React with DSH theme CSS variables.
- **Fix: Restore Full Tool Arguments & Real Line Diffs via Agy DB (`replace_file_content` / `write_to_file`).**
  - **Root cause**: agy CLI's `filterToolParameters` strips large arguments (`CodeContent`, `TargetContent`, `ReplacementContent`) from `stream-json`, leaving only metadata like `TargetFile`. Diff cards could not show old vs new line contents.
  - **Fix**:
    - `src/host/agy-db.ts`: Sub-millisecond deterministic protobuf parser directly extracts `tool_name` and full arguments JSON from the agy SQLite conversation database (`~/.gemini/antigravity-cli/conversations/<id>.db`), copying `-wal` and `-shm` sidecars to guarantee WAL commit visibility.
    - `src/host/adapter.ts`: Dynamically resolves `activeConvId` and step index (`parseInt(ev.stepKey, 10)`), pre-resolving full tool args. Incorporates `getGitHeadContent` for `write_to_file` to diff against committed git HEAD on full-file writes.
    - Fixed `readFullToolArgs` cache to reload SQLite DB when newly generated steps are queried, plus added 50ms WAL flush retry.
- **Fix: Tool Span Cutting on Completion When Output Is Omitted in Stream-JSON.**
  - **Root cause**: In `agy stream-json`, file modification tools (`replace_file_content`, `write_to_file`) emit `state: "DONE"` without an `output` field in `tool_info`. `mapper.ts` previously checked `ev.tool.output !== undefined || ev.tool.error !== undefined`, dropping the completion event and causing the tool card to be skipped entirely (falling through to assistant text).
  - **Fix**: Updated `EventMapper` to recognize `ev.state === 'DONE' || ev.state === 'ERROR'`, cutting the span and emitting native `agy_tool` cards even when `output` is omitted. Ensured `toolInfo.error` is populated on `state: 'ERROR'`.
- **UI: Default Collapsed State, Content Previews, Badges, and Semantic Diff Styling.**
  - **Default Collapsed**: Tool cards now default to collapsed state (`useToggle(false)`), keeping the conversation stream neat and compact.
  - **Content Preview**: Collapsed cards display a concise one-line preview in the header (e.g. `± demo/old.txt` for edits, `+ demo/old.txt` for writes, first line of terminal output, search queries).
  - **Header Badges**: Added card kind badge (`[diff]`, `[terminal]`, etc.) and wire tool name badge (`[replace_file_content]`, `[run_command]`, etc.) beside the title.
  - **Body Output Caption**: Added an uppercase **输出** (OUTPUT) label caption above the output content in the expanded card body.
  - **Line Diff Styling**: Line diffs format relative paths (`Edit demo/old.txt`), bold red deletion markers (`-`) on red background, and bold green addition markers (`+`) on green background.
  - **Reliable Toggle**: Replaced raw `useState` setter with `makeToggle(setValue)` to ensure infinite multi-click collapse/expand reliability.
- **Test Suite**: 22 new unit tests across `test/toolview.test.ts`, `test/agy-db.test.ts`, and `test/mapper.test.ts`. 173/173 tests passing.

---

### 中文 (Chinese)

- **新特性：适配 DSH >= 0.1.5 的 `agy_tool` 原生工具卡片 UI**
  - **根因分析（针对 DSH 0.1.5-rc.2 前端验证）**：DSH 浏览器对话界面（`@deepseek-ai/dsh-client-ui-tool`）通过硬编码变体表（`TOOL_VARIANTS`）按 wire tool name 渲染卡片，且未消费 `presentCall`/`presentResult`。桥接内部镜像工具 `agy_tool` 未在表中，导致所有工具调用（`run_command`、`write_to_file`、`replace_file_content`、`view_file`、`grep_search` 等）均退化为带有原始 JSON 参数的通用文本行。
  - **修复方案**：为 `agy_tool` 注册专有的 keyed `tool.call.toolview` 扩展槽，直接基于镜像参数渲染高仿生的原生卡片（终端 `terminal`、代码对比 `diff`、阅读 `read`、搜索 `search`、列出目录 `list`、删除 `delete`、通用 `generic`），完全使用原生 React 与 DSH 主题 CSS 变量实现。
- **修复：通过 Agy 会话数据库恢复完整工具参数与真实代码 Diff（`replace_file_content` / `write_to_file`）**
  - **根因分析**：`agy` CLI 在输出 `stream-json` 时通过 `filterToolParameters` 过滤掉了大参数字段（`CodeContent`、`TargetContent`、`ReplacementContent` 等），导致前端 Diff 卡片仅能拿到 `TargetFile`，无法展示旧行与新行的代码变更。
  - **修复方案**：
    - `src/host/agy-db.ts`：实现确定性亚毫秒级 Protobuf 解析器，直接从本地 SQLite 会话库（`~/.gemini/antigravity-cli/conversations/<id>.db`）精准提取完整 JSON 参数，并拷贝 `-wal` 和 `-shm` 侧车文件以保证 WAL 提交完全可见。
    - `src/host/adapter.ts`：动态获取 `activeConvId` 与真实的步骤索引（`parseInt(ev.stepKey, 10)`），提前异步解析全量参数；并在 `write_to_file` 时结合 `getGitHeadContent` 读取已提交的 Git HEAD 内容进行整文件 Diff 比对。
    - 修复 `readFullToolArgs` 缓存：当查询会话后续新增的步骤时重新读取数据库，并加入 50ms WAL 刷盘重试容错。
- **修复：解决 stream-json 中工具完成无 output 时卡片截断丢失问题**
  - **根因分析**：在 `agy stream-json` 中，文件修改与写入工具（`replace_file_content`、`write_to_file`）在 `state: "DONE"` 时 `tool_info` 不输出 `output` 字段。原 `mapper.ts` 检查 `output !== undefined` 导致该完成事件被丢弃，卡片从未触发截断派发，直接滑入了后续助手正文。
  - **修复方案**：更新 `EventMapper` 完成判断，支持 `state === 'DONE' || state === 'ERROR'`，确保无输出工具亦能正常截断并生成原生工具卡片。
- **界面优化：默认折叠状态、单行内容预览、卡片双徽章与高亮 Diff 呈现**
  - **默认折叠**：工具卡片默认初始为折叠状态（`useToggle(false)`），保持对话流整洁紧凑，点击卡片头部即可展开查看输出。
  - **单行内容预览**：折叠状态下在头部展示单行内容摘要（如 Diff 显示 `± demo/old.txt` 或 `+ demo/old.txt`，终端显示首行输出，只读显示文件路径等）。
  - **双标签徽章**：卡片头部展示卡片类型徽章（如 `[diff]`、`[terminal]`）与工具原始名（如 `[replace_file_content]`、`[run_command]`）。
  - **正文输出标题**：卡片正文区域增设大写 **输出**（OUTPUT）标签标题。
  - **Diff 高亮呈现**：标题展示相对工作区路径（`Edit demo/old.txt`），删除行带有加粗红底 `-`，新增行带有加粗绿底 `+`。
  - **展开/折叠防死锁**：修复 `useToggle` 在无参调用时触发 `setState(undefined)` 导致折叠后无法再次展开的缺陷，封装为纯函数 `makeToggle` 保证多轮点击稳定翻转。
- **测试套件**：新增 22 个单元测试用例，涵盖 `test/toolview.test.ts`、`test/agy-db.test.ts` 与 `test/mapper.test.ts`，173 个测试全部通过。

---

## 0.4.27 (2026-09-11)

- **Fixed: Windows binary discovery misses the official Google installer path (Issue #7).**
  - `resolveAgyBin()` now probes `%LOCALAPPDATA%\agy\bin\agy.exe` (plus `.cmd`/`.bat` siblings and the WinGet Links shim), so installs via `irm https://antigravity.google/cli/install.ps1 | iex` no longer raise `AGY_NOT_INSTALLED` when PATH has not propagated to the GUI process.
- **Fixed: Quota unavailable on Linux (Issue #8).**
  - Added `readLinuxSecretToken()`: the primary account's OAuth credential is now read from the FreeDesktop Secret Service (GNOME Keyring / KDE Wallet) via `secret-tool`, with a python3-dbus fallback — the same `service="gemini" / username="antigravity"` go-keyring slot agy writes on Linux.
  - `QuotaService.readSystemKeychainToken()` now dispatches per platform (darwin → Keychain, linux → Secret Service), restoring quota refresh on Linux where no on-disk token file exists.
  - Shared go-keyring payload parsing (raw or `go-keyring-base64:` prefixed JSON) extracted into `parseGoKeyringPayload`.

## 0.4.26 (2026-09-07)

- **Added: Support for `gemini-3.8-flash` in Fallback Models Catalog (Issue #6).**
  - **Root cause**: `DEFAULT_FALLBACK_MODELS` defined in `src/common/types.ts` had not been synced with Google's latest model line-up, stopping at `gemini-3.7-flash`. When DSH booted or ran offline prior to dynamic `agy models` discovery, `gemini-3.8-flash` was missing from the model picker.
  - **Fix**: Added `{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] }` to `DEFAULT_FALLBACK_MODELS`.
- **Fixed: Client Bundle `process is not defined` (PR #5 / realguan).**
  - In `tsdown.config.ts`, marked `react-dom` and `react/jsx-runtime` as external dependencies for client bundling (`platform: "browser"`), preventing development React runtime from being inlined into `dist/client.js` and eliminating browser `ReferenceError: process is not defined`.
- **Hardened: Test Suite Stability & Debounce Timing on macOS.**
  - Relaxed duplicate submission debounce window in `AgyAdapter` to 10,000ms with automatic size-capped map pruning, and adjusted test thresholds to account for cold Node subprocess spawning latency on macOS. All 151 unit tests passing.

## 0.4.25 (2026-09-04)

- **Fixed: Plugin Startup Blocker on DSH >= 0.1.1-rc.x / 0.1.2-rc.1 (`missing export 'CallId'`, issue #4).**
  - **Root cause**: Newer `@deepseek-ai/dsh-llm` versions (e.g. `0.1.2-alpha.1` ~ `0.1.2-rc.1`) renamed `CallId` to `ToolCallId`. A named import `import { CallId } from '@deepseek-ai/dsh-llm'` caused Node ESM static resolution to fail at startup with `The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'CallId'`, surfacing as a plugin load failure on DSH Desktop 2.0.5 and CLI.
  - **Fix**: Replaced named import with a namespace fallback resolution `toToolCallId = dshLlm.ToolCallId ?? dshLlm.CallId ?? identity`. This avoids missing named export evaluation errors and ensures seamless backwards and forwards compatibility across all DSH host versions.
  - **Ecosystem & Test Hardening**: Upgraded development dependencies to `@deepseek-ai/dsh-*@0.1.2-rc.1`. Configured `--test-concurrency=1` in test runner to prevent mock environment variable collisions across concurrent subprocess tests, achieving 100% pass rate across all 151 unit tests. Verified live startup with DSH 0.1.2-rc.1 and `dsh-lark-link`.

## 0.4.24 (2026-08-28)

- **Fixed: Antigravity Models Missing From Picker When Logged In (已登录/显示余量但模型列表不显示 — issue #1).**
  - **Decoupled Adapter Registration from Synchronous Binary Discovery**: `registerAdapter` now executes regardless of initial `bin()` probe results (using resilient fallback model catalog), ensuring the Antigravity provider is never dropped during startup even if CLI path resolution is deferred.
  - **Expanded macOS / Linux GUI App Path Discovery**: extended `resolveAgyBin` search candidates to include `~/.bun/bin`, `~/.cargo/bin`, `~/.local/share/pnpm`, `~/Library/pnpm`, `~/.yarn/bin`, `~/.npm-global/bin`, NVM (`~/.nvm/versions/node/*/bin`), FNM, Volta, ASDF shims, Linuxbrew, etc., fixing GUI desktop apps starting with minimal default system PATH.
  - **Account-Aware Model Discovery & Environment Isolation**: model discovery now inherits current active/primary account isolated environment and proxy settings, falling back across ready pool accounts if default system HOME is unauthenticated.
  - **Defensive Model & Effort Sanitization**: defensive catalog cleaning against empty IDs, blank names, empty reasoning effort arrays, and out-of-bounds `defaultEffort` to strictly satisfy DSH host validation and prevent fail-all provider group drops (`INVALID_CATALOG` / `INVALID_MODEL_*`).
  - **Cross-Platform & Unit Tests**: added defensive catalog normalization and explicit binary path resolution tests across test suites.

## 0.4.23 (2026-08-27)

- **Enhanced: Antigravity Tool Mirroring with Native Git +/- Diff Cards & Full Tool Vocabulary.**
  - **Tool Vocabulary & Parameter Mapping**: mapped agy's official editing tool `replace_file_content` (`TargetFile`, `TargetContent`, `ReplacementContent`, `Description`, `Instruction`) and write tool `write_to_file` (`TargetFile`, `CodeContent`, `Overwrite`, `Description`) to DSH native `DiffCallView` / `DiffResultView` cards.
  - **Git Head Base Line Diffing**: added cross-platform `getGitHeadContent` to retrieve committed file content for full-file writes (`write_to_file`), allowing DSH to render line-by-line git `+`/`-` additions and deletions rather than treating existing modified files as blank new files.
  - **Expanded Tool Support**: mapped `view_file` (with `AbsolutePath`/`StartLine` line location navigation), `grep_search`, `find_by_name`, `ask_question`, `read_url_content`, and `generate_image` onto their respective native/generic tool cards with descriptive titles.
  - **Cross-Platform Hardened**: path normalization with forward-slash compatibility across Windows/macOS/Linux, `windowsHide: true`, strict subprocess timeout, and safe error fallback.

## 0.4.22 (2026-08-27)

- **Fixed: `registration.adapter.prepareCall is not a function` on new DSH hosts (本轮运行失败 UNKNOWN).**
  - **Field report**: after upgrading the DSH host (manjh's source checkout), every turn failed immediately with `registration.adapter.prepareCall is not a function` — category UNKNOWN in the GUI, no reply at all.
  - **Root cause (interface drift)**: dsh-llm >= 0.1.1-rc.2 added `LlmAdapter.prepareCall(provider, model, signal)` and `LlmRuntime.prepareCall()` now calls `registration.adapter.prepareCall(...)` **unconditionally** (both the prepared-call path and the direct `adapterStream` path). The plugin's devDependency pinned `@deepseek-ai/dsh-llm ^0.1.0-rc.6` (base class without `prepareCall`); when the plugin's adapter class resolved an older dsh-llm copy than the host runtime, `registration.adapter.prepareCall` was `undefined` and every turn threw a bare TypeError.
  - **Fix**: `AgyAdapter` now implements `prepareCall` explicitly, returning `{ model: await this.resolveModel(...), stream: options => this.stream(options) }` — the exact one-generation capability-bound handle the new runtime expects (same shape as the base default, but present regardless of which dsh-llm copy the plugin resolves). Backward compatible: runtimes < 0.1.1-rc.2 never call it. The method is declared structurally (no `override` / new-type import) so the plugin keeps typechecking against dsh-llm `^0.1.0-rc.6` and the repo's `npm ci` peer resolution stays intact; the runtime contract matches the 0.1.1-rc.2 `PreparedAdapterCall` shape.
  - Regression test pins the contract end-to-end: `prepareCall` returns resolved model metadata (id/provider/defaultMaxTokens) plus a stream that runs a full fake turn.

## 0.4.21 (2026-08-27)

- **Fixed: Silent `agy exited with code 1` Hid the Real Cause (发送消息无回复、只见 exit 1).**
  - **Field report**: a user session log showed every turn failing with the bare message `agy exited with code 1` (code PROCESS_EXIT, empty stderr, zero tokens) — each attempt ran ~7–10s, failed once, retried once, failed again, and the UI never surfaced WHY (no reply text at all).
  - **Root cause of the blindness (verified live against agy 1.1.22)**: agy reports its failure as a `result` envelope on **stdout** (`{"event":"result",...,"status":"ERROR","error":"<human-readable reason>"}`) and exits 1 with EMPTY stderr — e.g. an invalid model/effort pairing fails instantly with `--model gemini-3.7-flash requires --effort (available: low, medium, high)`. The adapter's non-zero-exit branch dropped that envelope entirely: rate-limit-shaped errors were still classified (the classifier already read `lastResultError`), but any OTHER failure degraded to the bare exit-code line with no cause.
  - **Fix**: the PROCESS_EXIT failure message now prefers the stdout envelope's error text (falling back to the stderr tail). Same error code and retry policy; users finally see agy's own reason, e.g. `agy exited with code 1: upstream request failed while generating` or `…: --model gemini-3.7-flash requires --effort (available: low, medium, high)`.
  - **Diagnostics unaffected**: `/agy doctor` (`~/.dsh/agy-link/diagnostics/doctor-*.md`) still carries the full redacted raw stdout tail for deeper incidents.
  - Regression test pins the exact silent-failure shape (stdout envelope + exit 1 + empty stderr) via a new `exit-error` fake-agy mode.

## 0.4.20 (2026-08-27)

- **Fixed: Primary Account Quota Fetched With a STALE Token (主账号刷新/同步拿的值不对).**
  - **Root cause (verified live)**: on macOS, agy >= 1.1.15 keeps its CURRENT credential in the Keychain; the on-disk `antigravity-oauth-token` was a stale leftover from a PREVIOUS account's login. `getStoredToken` read the disk file FIRST and only fell back to the Keychain — so every 刷新/同步 used the old account's (still-valid) token and displayed ITS quota under the current login's name (observed: agy authenticated as q98… while the disk file still held elegantmanco's token; UI showed the wrong account's 5h/weekly numbers).
  - **Keychain-first token resolution**: for the primary / system-HOME account the Keychain credential now WINS over the on-disk file (disk remains the fallback for older agy builds and non-mac systems). Isolated pool accounts are pinned by test to never touch the shared Keychain. Verified end-to-end against live Google endpoints: the primary's token identity and quota now match the actual agy login (5h 91% / weekly 31% instead of the stale account's numbers).
  - **Token-anchored identity on manual refresh**: `refreshAccountQuota(force=true)` additionally calls the OAuth userinfo endpoint once per explicit user click and re-labels the slot to the token's TRUE owner (`resetAccountIdentity`), so an external `agy logout` + re-login self-heals in one click even when logs disagree.
  - **Log detection hardened**: `detectEmailFromAgyLogs` returns the LAST match per file (append-ordered logs → newest login wins), fixing first-match returning a superseded account.
  - **Risk posture preserved**: background polls (force=false) still NEVER call userinfo — zero extra network on the automatic path (pinned by a regression test).

## 0.4.19 (2026-08-26)

- **Fixed: Antigravity Models Missing From the Model Picker (登录成功、额度正常但模型列表为空 — issue #1).**
  - **Root cause**: when `agy models` lists a bare Gemini base alongside its effort variants (the agy 1.1.13 output shape, e.g. `gemini-3.7-flash` + `gemini-3.7-flash-medium`), `foldEfforts` emitted the base id TWICE — once as the folded base entry and once as a verbatim row. DSH's `llm.listModels` contract throws `INVALID_CATALOG` on any duplicate model id, and the host's model-catalog builder then drops the ENTIRE Antigravity provider group from the picker — so login and quota panels looked perfectly healthy while no Antigravity model could be selected.
  - **Fix (three layers)**: (1) `foldEfforts` now absorbs the bare base into its folded entry instead of duplicating it; (2) `parseModelsOutput` dedupes repeated raw slugs (first occurrence wins); (3) `AgyAdapter.listModels` dedupes ids as a final guard, so even a user-configured `fallbackModels` list containing repeats can never nuke the whole group.
  - Regression tests pin both bare-base-plus-variants shapes and the duplicate-slug parse, plus an adapter-level uniqueness guard test.
  - **Observability**: when the adapter-level guard drops duplicate ids it now logs which ids were removed (`model catalog contained duplicate ids [...]`) so field instances surface in DSH server logs instead of being silently masked. When reporting picker issues, attach the `/agy doctor` report (`~/.dsh/agy-link/diagnostics/doctor-*.md`) and the raw `agy models` output.

## 0.4.18 (2026-08-25)

- **Quota Fallback Never Clobbers Good Data (5h=100%/weekly-missing 根因).**
  - **What happened**: `retrieveUserQuotaSummary` transiently failed (proxy blip) while `fetchAvailableModels` still answered; the per-model fallback then OVERWROTE the stored family entry with a single-window partial shape — weeklyFraction vanished and the 5h row received wrong-window numbers (observed 5h=100%, reset a week out, weekly `—`, while the live API actually reported 5h 84% / weekly 47%).
  - **`mergeFallbackFamilyQuota`**: last-known-good complete family data now always wins over partial fallback; the fallback only fills families with no usable previous entry (first-ever refresh). Verified live: both endpoints answer correctly and a successful summary refresh fully restores the display.
  - Added `scripts/diag-quota.mts` one-shot endpoint probe for future incidents.

## 0.4.17 (2026-08-25)

- **Ghost-Cooldown & Quota-Display Fix (额度显示 0% 根因).**
  - **What happened**: the UI showed 5h quota as 0% while `agy` reported 98% — the parsed quota data was CORRECT all along, but (a) any active local cooldown forced the 5h bar to render 0%, and (b) the loose rate-limit classifier kept creating ghost cooldowns: it scanned the ENTIRE stdout (model prose mentioning "rate limit"/"quota", hash fragments containing "429") and matched bare keywords, so an unrelated tool/permission error froze a healthy account out of rotation with a 15-minute+ cooldown (captured real reason: `rate limit reached: declaring permissions: cortex tool write_to_file … invalid tool call error`).
  - **Hard vs soft classification**: new `looksLikeHardRateLimit` (RESOURCE_EXHAUSTED / code·status·HTTP 429 / too many requests / individual quota reached / quota exceeded·reached·exhausted / rate limit exceeded·reached·hit) is the ONLY pattern allowed to put an account into cooldown; soft signals (model overloaded / high traffic) still shape the error message but never cool accounts.
  - **Scan scope narrowed**: error classification reads stderr + the result envelope's error field only — stdout (event JSON + model prose) no longer participates.
  - **Honest quota bars**: a local cooldown no longer overwrites the server-reported fraction with 0%; it now appends a `· 本地冷却中` note next to the reset time instead.
  - Regression tests pin the exact incident text (cortex tool permission error) as a non-rate-limit fixture.

## 0.4.16 (2026-08-24)

- **External Re-Login Sync (换号自动/手动同步).**
  - **Root cause fixed**: after `agy logout` + re-login as a DIFFERENT account, the pool slot kept the old account's email, cooldowns, quotas and `auth_required` quarantine — and poll gating (0.4.15) then skipped the flagged slot forever, freezing the UI on the stale account.
  - **`resetAccountIdentity`**: detecting a changed email (from local CLI logs, zero network) now resets all identity-bound state (cooldowns / quotas / auth quarantine) while keeping slot config — the new account starts clean instead of inheriting the old one's restrictions.
  - **Zero-network reconciliation before poll gating**: the background poller pre-checks flagged slots via local log scan, so an external re-login self-heals within one poll cycle (≤15 min) without any extra request to Google. Manual click is instant.
  - **Auth self-heal on success**: a successful authenticated quota fetch clears a stale `auth_required` flag (the old token's invalid_grant no longer condemns the new login).
  - **Manual refresh upgrades**: the 刷新 button now also re-reads the model catalog (one `agy models` spawn per explicit click only — new subscription tier may expose different models), and every account card gains a 同步 button for single-account refresh.
  - **Primary slot always re-bootstrapped (real root cause of "UI stuck on old account")**: the primary slot was only created for an EMPTY pool, so once deleted it never came back while other accounts remained — the system-HOME login (e.g. after `agy logout` + re-login) had no slot to attach to and the UI kept showing an isolated account as 主账号. The slot is now recreated at the front on every load; deleting it no longer promotes an isolated account to primary. Disable the slot instead of deleting if unwanted.

## 0.4.15 (2026-08-24)

- **Quota Polling Risk-Exposure Minimization (root-cause follow-up).**
  - **Poll Interval 5min → 15min (configurable)**: New `quotaPollIntervalMs` config (env `DSH_AGY_QUOTA_POLL_INTERVAL_MS`, clamped to >= 60s) cuts background `v1internal` polling volume by 3x — the poller was the last remaining high-frequency network surface after the CLI-level hardening.
  - **Restricted-Account Poll Gating**: Automatic polling now skips disabled, auth-quarantined (`invalid_grant`) and 429-cooldown accounts (`shouldPollAccount`), so the poller never keeps probing Google endpoints for accounts already known to be limited. Manual UI force-refresh still refreshes everything.
  - **Userinfo Endpoint Called Only When Email Unknown**: The primary account previously hit the OAuth userinfo endpoint on every poll cycle just to detect account switching; that detection now rides the local log scan (`detectEmailFromAgyLogs`, zero network), eliminating one network call per cycle.

## 0.4.14 (2026-08-24)

- **Hardened 429 Rate Limit Cooldown & Circuit Breaker (Anti-Risk Control).**
  - **Accurate Reset Duration Parsing**: Added `parseResetDurationMs` to accurately extract server reset countdowns from strings like `"Resets in 21m25s"`, `"Resets in 2h26m6s"`, `"Resets in 45s"`, or verbose duration phrases.
  - **Safety Cooldown Buffer**: Account failures on 429 now automatically apply the parsed reset duration + a 10s safety buffer (or a 15-minute minimum backoff), preventing accounts from re-triggering rate limiters at the exact millisecond of reset.
  - **Non-Retryable 429 Classification**: Identified 429 / quota exhaustion errors from stderr / stdout and classified them as non-retryable `Err.AGY_ERROR` instead of `Err.PROCESS_EXIT`, stopping DSH from executing automatic rapid retries on exhausted accounts.
- **Organic Spacing Jitter, In-Flight Debounce & Burst Protection.**
  - **Human-like Timing Jitter**: Added randomized timing jitter (`+100ms ~ 400ms`) on top of the 500ms single-account throttle to produce natural non-periodic traffic distributions that evade automated queue detection.
  - **In-Flight Session Debounce**: Rejects identical prompt submissions within a 3-second window while an existing request is active (`Err.BUSY`), preventing frontend repeat loops and double-clicks from hammering the backend.
  - **Sliding-Window Rate Limiter**: Added configurable `rateLimitPerMinute` protection across all sessions to prevent runaway `/goal` autonomous loops from draining daily quotas.
- **Account Health Quarantine & Self-Healing.**
  - **Invalid Grant Quarantine**: Automatically detects `invalid_grant` / revoked OAuth tokens during refresh and flags the account as `auth_required`, immediately taking it out of pool selection and alerting the user in UI.
  - **Visual Health Dashboard**: Added red alert badges (`需重新登录`) and health indicators on account cards.
  - **Automatic Fallback Model**: Supports `autoFallbackModel` to smoothly route requests to available lower-tier models when high-tier models are exhausted.
- **System Hygiene & Telemetry Minimization.**
  - **Telemetry Opt-out**: Injected telemetry suppression flags (`DO_NOT_TRACK`, `DISABLE_TELEMETRY`) into child process environments to reduce unnecessary background event tracking to Google `cclog`.
  - **Automated Old Log Purge**: Added `sweepOldLogs` on plugin boot to automatically sweep CLI log files older than 7 days across system and isolated account directories.

## 0.4.13 (2026-08-21)

- **Fixed Multimodal Image Attachment Staging & Direct Disk Fallback.**
  - **Dynamic Attachment Service Lookup**: Fixed Cordis proxy boundary issue where `(ctx as any).attachments` evaluated to `undefined` when not statically declared in `inject`; now resolves via `ctx.get('attachments')`.
  - **Local Storage Direct Disk Fallback**: Added direct fallback to read from DSH's local content-addressed storage (`~/.dsh/attachments/v1/objects/<prefix>/<id>`), guaranteeing 100% reliable image byte extraction even if service bindings are uninitialized.
  - **Explicit Vision Tool Directives**: Enhanced prompt staging lines to explicitly reference the `view_file` tool and absolute file path (`[image attached: "..." staged at ... Inspect it using the view_file tool with AbsolutePath: "..."]`), ensuring `agy` proactively inspects attached images even when the user sends an image without accompanying text.

## 0.4.12 (2026-08-21)

- **Adaptive Tool Dispatch for Both Standard / Native Mode and Code Mode.**
  - Dynamically inspects `options.tools` on each model stream call.
  - In **Code Mode** (`run_code` present in tools list): emits `run_code` program wrapping `tools['agy_tool'](...)` to conform to code-mode dispatch rules.
  - In **Standard / Native Mode** (`agy_tool` / normal tools present): emits `agy_tool` directly with structured cursor arguments, eliminating `unknown tool "run_code"` and `unknown tool "agy_tool"` errors across all preset modes.
- **Fixed Primary Account Stale Token & Quota Sync on macOS Keychain.**
  - `agy` 1.1.15+ on macOS persists active login credentials via `go-keyring` in the macOS Keychain (`service: "gemini"`, `account: "antigravity"`), leaving stale files in `~/.gemini/antigravity-cli/antigravity-oauth-token` when users switch accounts outside DSH.
  - Added `readMacKeychainToken` to decode active `go-keyring-base64` credentials directly from macOS Keychain for the primary/system account.
  - Live quota & user profile (`fetchUserInfo`) now always read the active Keychain token, immediately detecting account switches and syncing the correct email and quotas.
- **Auto-Invalidate Conversation Binding on Model Switch.**
  - Switching models in the same DSH session now automatically drops the old agy `conversationId` binding, ensuring the prompt immediately executes with the new model without being locked to old agy conversation state.

## 0.4.11 (2026-08-21)

- **Fixed `Error: unknown tool "agy_tool": only run_code is callable directly` in DSH Code Mode.**
  - Restored the `run_code` wrapper dispatch (`WRAPPER_TOOL_NAME` + `buildMirrorRunCode`) for span cuts.
  - Under DSH's default Code Mode (`agent-presets: default: code`), model-direct tool calls are collapsed unless addressed to `run_code`. Wrapping the mirror invocation in `run_code` allows internal sub-dispatch to `agy_tool` to replay recorded events without being blocked by DSH's dispatch guard.

## 0.4.10 (2026-08-21)

- **Fixed `Error: unknown tool "run_code"` loop (Root Cause).**
  - Standard DSH agents and WebUI run direct tool dispatch without Code Mode runner (`run_code`). Emitting span cuts addressed to `run_code` triggered `ToolNotFoundError: unknown tool "run_code"` and trapped agy in an infinite error loop.
  - Span cuts now directly emit `agy_tool` tool-call blocks, which execute instantly and render native tool cards (Terminal, Diff, Read, Search).
- **Emphasized System Proxy & TUN Mode Requirements in README.**
  - Added prominent warnings and configuration instructions for system proxy, TUN mode, and environment variables (`HTTPS_PROXY`) required for Google connectivity in restricted regions.

## 0.4.9 (2026-08-20)

- **Theme-Adaptive System & High-Contrast Typography.**
  - Dynamic adaptation to DSH light and dark themes (`body[data-ds-dark-theme]` / `[data-theme="dark"]` / system preferences) across all UI elements (Settings section, header status badge `AGY (n)`, and modal console dialog).
  - High-contrast text & palette tuning: replaced hardcoded dark backgrounds and pale/white text with responsive semantic tokens, ensuring crystal clear legibility in light mode without washed-out or invisible text.
  - Redesigned quota bars, status pills, submodel breakdown rows, buttons, segment toggles, OAuth dialogs, and alert banners with theme-adaptive contrast.

## 0.4.8 (2026-08-20)

- **Pure SVG UI icon system (zero emojis).** Replaced tacky unicode emojis across the UI (trash can, star, plus, refresh, globe, mail, zap, alert, chevrons, close buttons) with clean, crisp, Lucide-style vector SVG icons for a professional developer experience.
- **Accurate quota window display & weekly lockout aggregation.**
  - Quota bars and breakdown rows now display clear window badges (`5h 滚动` / `周限额`) and time countdowns (`↻ 15:46 (4h36m)`).
  - Fixed family quota aggregation: bottleneck model selection now correctly binds the family `resetTime` to the bottleneck model with the lowest `remainingFraction` (and picks the furthest reset on tie), ensuring 7-day weekly rate limits are faithfully preserved and displayed.


- **Mid-turn steer preemption.** DSH claims a steered ("插话") message at the next step boundary and opens a NEW stream() call; the previous run's agy process used to stay alive and keep appending to the SAME conversation concurrently. The adapter now tracks the in-flight run per session and aborts it before starting the steered run (auxiliary calls neither preempt nor get tracked).
- **UI simplification.** Sidebar bottom-left shortcut removed (the console modal now lives on the header `AGY (n)` badge); quota rows are percent-first — brand logo + bar + `85%` + `↻ 14:44 · 3h12m` — with language-neutral `5h`/`7d` window badges and all Chinese status words (`充足/紧张/适中/未知`) dropped.

## 0.4.6 (2026-08-20)

- **Fixed premature context compaction (root cause).** agy's `result` envelope reports CONVERSATION-CUMULATIVE usage (input 3.8M / cacheRead 72M in the wild), while `step_update` usage is per-call (true current context). DSH's token meter treats the last sample as context occupancy, so forwarding the cumulative envelope exploded pressure past the 80%-of-1M threshold within a few turns and fired constant compactions. The mapper now reports the last per-call step sample (tracked on the shared run recording, span-safe); falls back to the envelope only when no step carried usage.
- **Quota windows + model logos in the UI.** Per-family bars now carry official Gemini / Claude / OpenAI brand SVG marks, a 5小时额度/周额度 window badge (inferred from reset distance), and a live reset countdown; per-model breakdown rows stay available on expand. Removed the verbose mechanism-explainer block.
- **Unified browser login everywhere.** `/agy auth` now runs the same PKCE + loopback-callback flow as the pool's add-account (new `PoolAuthFlow.beginPrimary()` writing agy-format tokens into the real HOME); the QR/code-paste-first copy is gone from README and command help. Primary flows never touch staging cleanup.
- **README refresh.** Install/login instructions match the browser flow; new References section (CLIProxyAPI, opencode-antigravity-auth, OmniRoute, pi-mono).

## 0.4.5 (2026-08-20)

- **Fixed Quota Display (Root Cause).**
  - agy ≥ 1.1.15 writes the token file in a NESTED shape (`{"token": {...}, "auth_method": "consumer"}` with ISO-8601 string expiry); the old flat parser read the nested `token` object as the access token string, producing `Authorization: Bearer [object Object]` → every quota fetch failed 401 → the UI permanently showed a fake `100% 充足`.
  - `normalizeStoredToken` now handles nested + flat shapes, ISO/epoch-second/epoch-ms expiries, and rejects non-string access tokens.
  - Token refresh now works out of the box via the public Antigravity client credentials (env-overridable with `AGY_CLIENT_ID`/`AGY_CLIENT_SECRET`), and quota fetch walks the verified 4-endpoint fallback order (daily → prod → daily-sandbox → autopush).
  - All Node-side Google calls now go through `src/host/net.ts` (undici's own fetch + EnvHttpProxyAgent): Node's built-in fetch ignores `HTTP(S)_PROXY`, and mixing an external undici dispatcher into it throws `UND_ERR_INVALID_ARG` — both silently failed every call behind a proxy. Per-account `proxyUrl` wins over env.
  - The client renders an explicit grey `— 未知` state when no quota data exists instead of a fake 100%.
  - Background quota refresh every 5 minutes (token-file reads only — no agy spawns, no Keychain prompts).
- **Rebuilt Add-Account OAuth (Root Cause).**
  - The old flow scraped a login URL out of `agy -p ping` print mode; agy ≥ 1.1.15 never prints one when logged out, so the probe timed out after 20s and the route STILL returned `ok:true` — the UI claimed "浏览器已调起" while no browser ever opened, leaving a stuck `auth.phase='ok'` and orphaned `staging_*` dirs.
  - New self-owned flow (`src/host/oauth.ts` + `src/host/pool-auth.ts`): PKCE + public Antigravity client credentials + loopback callback listener on `http://localhost:51121/oauth-callback` (the redirect registered for the Antigravity client), browser opened server-side. The authorization code is captured automatically — no manual pasting; paste of a bare code or the full callback URL remains as fallback.
  - Tokens are written in agy's own on-disk format into the account's isolated HOME, so the official agy binary is immediately signed in for that account; email is resolved via userinfo and quota refreshed on commit.
  - Failures now return `ok:false` with the real reason; staging dirs are cleaned on failure/cancel, and stale `staging_*` dirs are swept at boot.
- **Fixed "cannot add a second account".** The server holds the `done` auth status for 30s so pollers can observe it; reopening the add-account panel inside that window replayed the previous success toast and closed the panel instantly. The client now only reacts to `done`/`failed` for a flow actually started from the current panel session.
- **Cross-Platform Hardening.**
  - Windows account isolation actually works now: `isolatedHomeEnv()` sets `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` alongside `HOME` — Node (libuv) and Go ignore `$HOME` on Windows, so secondary accounts previously shared the real user profile there. Applied to the adapter, the auth probe, and the terminal-login routes.
  - Windows browser open no longer breaks on the OAuth URL's `&` query separators (pre-quoted `cmd /d /s /c start "" "url"` with verbatim arguments).
  - Quota `User-Agent` now reflects the real platform/arch instead of a hardcoded `darwin/arm64` fingerprint.
  - Token file writes are mode-0600 on POSIX and safely skipped on Windows.
- **Fixed Settings Flicker (Residual).**
  - v0.4.3 removed the per-poll re-render; the remaining flash came from the settings modal unmounting the section on close — every reopen rendered a misleading amber "待认证" empty state until the first poll landed. A module-level status cache now seeds the first render instantly.
  - Removed the 2s pulse animation on status dots (static dots; color still conveys state) and added a fixed-height skeleton for the first-ever load.

## 0.4.3 (2026-08-20)

- **Eliminated macOS Keychain Prompts ("Antigravity Safe Storage").**
  - Removed periodic `agy models` process spawns from the high-frequency `/plugins/agy-link/status` endpoint.
  - The status endpoint now serves instantaneous cached state in 0ms, preventing macOS Gatekeeper / Security daemon from triggering keychain dialogs or access errors in background sessions.
- **Fixed UI Flickering & Re-render Thrashing.**
  - Implemented payload hash/equality checks before setting state in the React hook, completely eliminating re-render flashing during polling.
  - Cleaned up duplicated definitions in the client bundle.
- **Fixed Quota Percentage Display.**
  - Properly unified remaining quota percentage rendering for Gemini, Claude, and GPT-OSS families across all active and primary accounts (showing `100% 充足` / live percentages or cooldown time).

## 0.4.2 (2026-08-20)

- **Remaining Quota Quantitative Display & Clean Progress Meters.**
  - Every account card now displays explicit, quantitative remaining quota meters (percentages and progress bars) for all three model families: Gemini (`✨`), Claude (`🧠`), and GPT-OSS (`⚡`).
  - Active and healthy accounts display 100% capacity (or live fractional quota returned from Google CloudCode backend) with emerald green progress bars; accounts in cooldown display 0% with real-time countdown badges (`Xs 冷却`).
- **Eliminated False Premature Account Additions & Browser OAuth.**
  - Staging account slot isolation: new accounts are created in temporary staging directories and only committed to `pool.json` when authorization code verification actually succeeds (`code === 0`). Cancelling or failing auth cleans up staging files with zero ghost accounts left behind.
  - Automatic system browser launch (`open <url>` on macOS, `start` on Windows, `xdg-open` on Linux) when initiating account addition, plus a direct one-click fallback link in the UI.
- **Drastic WebUI Simplification & Modern Redesign.**
  - Clean, high-contrast, linear-style UI: removed all noisy explanatory paragraphs, repetitive buttons, and cluttered text disclaimers.
  - Compact account cards with essential actions (`设为主用`, `⚙️ 代理`, `🗑️ 移除`).
  - Sleek segmented pill controls for pool scheduling mode (`顺次耗尽` / `轮询均衡`), permission mode (`plan` / `accept-edits` / `skip`), and reasoning effort (`auto` / `low` / `medium` / `high`).

## 0.4.1 (2026-08-20)

- **Context Optimization & Compaction Lifecycle Sync (ADR-013).**
  - **Uniform 1M Context Window**: `resolveModel` uniformly advertises 1,048,576 (1M) context window across all Antigravity models (Gemini, Claude via Antigravity, GPT-OSS). Prevents DSH from prematurely firing context compaction requests due to agy's cumulative tool token reporting.
  - **Compaction-Aware Session Rebinding**: When DSH compacts history or clears session messages (detected by `messages.length < binding.lastMessageCount`), the adapter automatically releases the stale `conversationId` binding and seeds a fresh, clean agy session with the compacted summary digest, eliminating infinite compaction loops.
  - **Pure Transparent Message Pass-Through**: Multi-turn continuations in active bound sessions pass only the trailing user prompt + `--conversation <id>`, leaving conversation state management and tool chaning to Antigravity's native engine.
  - **Multimodal Support Fix**: Declared `inputModalities: ['text', 'image']` across all Antigravity models in `listModels` and `resolveModel`, enabling native drag-and-drop / paste image support in DSH.
  - **Unified One-Click macOS Terminal Login**: Streamlined account addition to native macOS Terminal auth with real Gmail extraction and visual health indicators.

## 0.4.0 (2026-08-20)

- **Multi-Account Pool & Process-Level Profile Isolation.**
  - Account pool management under `~/.dsh/agy-accounts/` with physical process-level environment isolation (`HOME=~/.dsh/agy-accounts/<id>/`).
  - Primary account rides system `HOME` to reuse Mac OS Keychain credentials without duplicate login.
  - Multi-profile Google OAuth flow: dynamic state machine per account, drop hardcoded OAuth credentials, secure in-memory and isolated disk storage.
  - Per-account proxy configuration (`ALL_PROXY` / `HTTPS_PROXY`) preventing IP correlation across accounts.
- **Sticky Sequential Drain (按模型家族顺次耗尽).**
  - Fine-grained rate limit tracking scoped to model family (`google`, `anthropic`, `openai`). Exhausting Claude quota will not penalize Gemini requests.
  - Transparent in-flight failover: upon encountering `429` / `RESOURCE_EXHAUSTED`, the active turn immediately and seamlessly switches to the next healthy account.
  - Automatic cooldown calculation with tiered backoff and reset time detection.
- **Real-Time Quota Progress Bars & Silent Degradation.**
  - Real-time token consumption and quota percentage tracking for all pooled accounts.
  - Quota statistics surface directly to DSH WebUI with visual progress bars and bottleneck indicators.
  - Graceful silent degradation: token polling failures fall back smoothly without interrupting ongoing runs.
- **DSH In-GUI Management & Slash Commands.**
  - New slash commands: `/agy pool`, `/agy add-account`, `/agy switch`, and `/agy quota`.
  - Rich WebUI status card with account list, quota meters, proxy badges, and fast switcher.

## 0.3.6 (2026-08-20)

- **Comprehensive Google OAuth login state machine & reliable QR rendering.**
  - Fixed broken QR image rendering by generating inline base64 data URLs directly in the `/status` payload (`auth.qrDataUrl`).
  - Added direct one-click authorization link (`👉 点击在浏览器中打开 Google 授权页面`) so users can open the consent URL in their browser tab with proxy support.
  - Implemented explicit state machine lifecycle: `signed-out` -> `pending` (URL & QR active) -> `submitting` (exchanging authorization code) -> `ok` (connected & refreshed) / `failed` (actionable error & restart).
  - Added `/plugins/agy-link/auth-cancel` endpoint and in-GUI Cancel / Restart buttons.
- **Fixed non-Gemini model execution (Claude Sonnet / Claude Opus / GPT-OSS).**
  - The agy CLI rejects the `--effort` flag for Claude and GPT-OSS models (`--effort is not supported for model ...`). The adapter now automatically strips `--effort` when calling non-Gemini models.
  - Added automatic model slug alias resolution: `claude-opus-4-6` and `claude-opus` resolve to `claude-opus-4-6-thinking`; `gpt-oss-120b` resolves to `gpt-oss-120b-medium`.
  - Updated `DEFAULT_FALLBACK_MODELS` to match live agy 1.1.15 slugs.


- **Sliding activity watchdog for long-running tasks.** Replaced the static
  wall-clock timeout with an activity-based idle watchdog: the timer rearms
  on every chunk of stdout/stderr activity. Long-running tasks (e.g. multi-step
  refactors, extensive test suites, deep searches) can now run indefinitely as
  long as the process is actively working, while deadlocked/silent processes
  are still cleanly terminated after `timeoutMs` of complete inactivity.
  The agy CLI `--print-timeout` is given a generous ceiling (4h) to avoid
  premature termination of active print sessions.

## 0.3.4 (2026-08-19)

- **Tool activity moved out of the thinking panel into the reply body.**
  User feedback on 0.2.8: tool annotations hidden inside the DSH thinking
  fold were invisible and felt wrong. agy tools now render as visible
  `🔧 [agy tool: name] args -> output` lines in the message body (they
  cannot become native DSH tool cards: a finish:tool-calls would make the
  DSH agent try to execute tools it does not own — agy runs its own closed
  tool loop). The thinking panel keeps only what is genuinely thinking
  signal: `[agy thinking turn · N thinking tokens]` turn annotations
  (agy print mode never streams thinking text) and terminal error notes.

## 0.2.8 (2026-08-19)

- **Fix: real agy 1.1.15 stream-json parsing.** The parser only understood
  flat, hypothesized event shapes; the live CLI nests every step payload
  under a `step_update` envelope and uses a different vocabulary
  (`agent_response` + `text_delta` fragments, `tool` with `tool_name` /
  `tool_info` with `parameters` / `output` / `error`). As a result thinking
  and tool activity were silently dropped and only the final result text
  survived. Both shapes are now parsed (legacy aliases kept).
- **New: visible thinking turns + tool activity.** agy does not stream
  thinking text in print mode (only `thinking_tokens` usage), so each
  thinking-only `agent_response` turn surfaces as an annotated reasoning
  block (`[agy thinking turn · N thinking tokens]`), tool calls render as
  `[agy tool: name] args -> output` reasoning annotations, and failed tools
  render `[agy tool error: name] message`.
- **Fix: `result.status=ERROR` with a usable response** (e.g. a tool timed
  out mid-run) no longer discards the answer — the response streams, the
  error is annotated, the turn finishes normally. A bare envelope error
  now maps to a precise `AGY_ERROR` finish instead of INVALID_OUTPUT.
- **Fix: `agy models` deadlock — stdin pipe never closed.** agy reads stdin
  when it is a pipe and waits for EOF; every non-auth spawn kept the pipe
  open, so model discovery silently timed out and the catalog always fell
  back to the bundled list. Stdin now closes right after spawn (auth probes
  keep it open).
- **Fix: auth phase was always `idle`** until someone ran `/agy auth`, so
  the settings page claimed "needs Google login" for signed-in users.
  Status surfaces now lazily probe the real login state via `agy models`
  (60s cache) and report `ok` / `signed-out` truthfully.
- **Fix: `/plugins/agy-link/*` routes never registered on dsh web** (settings
  page stuck on `binary: not found / auth: unknown / models: 0`). Routes are
  now registered through a reactive `ctx.inject(['webServer'])` sub-fiber,
  so they attach whenever the service appears instead of racing it. The
  settings page also renders an honest "endpoint unreachable" state instead
  of misleading placeholders when the route is missing.
- **Removed: sidebar footer AGY button** (user request). Login (QR +
  authorization code) and mode/effort quick controls moved to Settings →
  Antigravity; the conversation header `AGY` pill stays.
- Tests: real-1.1.15 fixture modes (`real`, `real-error`, `real-fail`) and
  parser/mapper/adapter coverage for the nested format (73 tests).

## 0.2.7 (2026-08-19)

- Visible agy status in DSH: conversation header `AGY` pill, Settings → Antigravity status page, and sidebar footer label.
- Workspace auto-binding: agy now runs in the DSH session's `cwd` when `workspaceRoot` is not configured.
- New `/agy workspace [path]` command and `DSH_AGY_WORKSPACE_ROOT` env.
- README language switcher at the top (中文 / English).

## 0.2.2 (2026-08-19)

- README: dedicated Prerequisites section (DSH, Node >= 24, the agy CLI with Google's official install guide link, first-run login, subscription note), a "how it works" intro paragraph, and an honest "what it cannot do" list in both languages - onboarding now covers first-time users.
## 0.2.1 (2026-08-19)

- Cross-platform hardening (Linux / macOS / Windows):
  - binary discovery is platform-aware: agy / agy.exe / .cmd / .bat across
    PATH, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin,
    %LOCALAPPDATA%\Programs, and the npm shim dir; a real executable is
    always preferred over a cmd shim
  - Windows .cmd/.bat shims spawn through cmd.exe with cross-spawn-style
    argument quoting (unit-tested)
  - tree-kill uses taskkill /T /F on Windows (Unix process groups do not
    exist there); detached sessions are POSIX-only so no console window
    flashes on Windows
  - CRLF stdout is normalized (trailing \r stripped per line)
  - the MCP bridge script path resolves via fileURLToPath (URL.pathname
    would yield /C:/... on Windows and break the spawn)
- 5 new cross-platform tests (56 total).

## 0.2.0 (2026-08-19)

- Multimodal (path-based): DSH image attachments are staged to a local media
  directory (config `mediaDir`, TTL sweep `mediaTtlMs`, caps `mediaMaxBytes` /
  `mediaMaxImages`) and referenced by absolute path in the agy prompt with
  `--add-dir` - agy views them with its own tools. Env: `DSH_AGY_MEDIA_DIR`,
  `DSH_AGY_MEDIA_TTL_MS`.
- `agy_ask` gains `readPaths` (inline text files into the one-shot prompt;
  binaries skipped with a note) and `schema` (JSON Schema enforced via
  `--json-schema`).
- MCP reverse bridge (experimental, `mcpBridge: true` / `DSH_AGY_MCP_BRIDGE=1`):
  agy can call DSH-side tools through a loopback, token-guarded endpoint plus a
  zero-dep stdio MCP server merged into the workspace `.mcp.json`.
  `mcpToolAllowlist` restricts the exposed set; `run_code` / `agy_ask` are
  never bridged.
- Abort semantics locked by a regression test: everything the model produced
  before the caller hits stop is preserved (open block closed, then failure
  finish).
- 12 new tests (51 total).

## 0.1.5 (2026-08-19)

- README restructured into a single bilingual page: Chinese first, then
  English (README.zh.md removed; package files list updated).
- Releases now publish to npm automatically (NPM_TOKEN secret configured).
