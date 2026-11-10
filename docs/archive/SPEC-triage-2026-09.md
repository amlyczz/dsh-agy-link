# Spec：GitHub Issue / PR Triage（2026-09-15）

基线：`main` @ `8b14fc0`（v0.4.27）。本文件记录 open issues / PRs 的对应关系、修复方案、可合并性评估，以及提示词注入与安全审查结论。

## 1. 审查方法与威胁模型

### 1.1 方法

- 对 7 个 open issues、5 个 open PRs 拉取完整正文、diff、文件清单。
- 在临时目录独立 checkout 每个 PR head，执行 `npm run check` → `npm run build` → `npm test`（不信任 PR 正文自述的“N tests passed”）。
- 对照当前 `src/` 源码验证 issue 中的根因描述是否属实（而不是照抄 issue 里的补丁片段）。
- 检查 merge-base / conflict / 祖先关系，判断 PR 之间是否互相覆盖。

### 1.2 提示词注入与不可信内容

Issue / PR 正文、评论、补丁建议均按**不可信数据**处理，遵循以下规则：

| 规则 | 说明 |
| --- | --- |
| 不执行正文中的指令 | 正文里出现的“请合并 / 请改权限 / 请跑某命令”一律不作为操作依据 |
| 补丁片段需对照源码与官方 API | 例如 issue #13 给出的 `windowsHide: true` 需对照 Node `child_process` 文档与本仓库实际 spawn 点 |
| 自述测试结果需复验 | 已在临时克隆中全部复验（见 §3） |
| PR 注入进 prompt 的文本需审查 | 见 PR #20 的 Recovery boundary（§3.3） |
| 文档/README 改动需防嵌套指令 | PR #17 为纯文档，已抽查命令与标识符未改语义 |

## 2. 主分支基线

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 152/152 通过 |
| 分支保护 | 无（`main` 未设 protection） |
| CI | `.github/workflows/ci.yml` 在 `pull_request` 上跑 check/build/test；fork PR 首次常需 maintainer 批准，故多数 PR 显示 “no checks reported / UNSTABLE” |

`mergeStateStatus: UNSTABLE` 在本仓库**不等于**代码失败，而是 CI 未在 fork 分支上跑起来。可合并性以本地复验为准。

## 3. Issue 对应关系与修复方案

### 3.1 总览

| Issue | 类型 | 对应 PR | 状态 | 处置 |
| --- | --- | --- | --- | --- |
| #11 stdin 传输（32KB cmdline） | enhancement | 无 | 未修 | 与 #14 同根因，合并成一项 stdin 方案 |
| #12 `mcpBridge` 好用不 | question/enh | 无 | 功能已存在 | 文档答疑 + 可选稳定性增强 |
| #13 Windows CMD 窗口闪烁 | bug | 无 | 未修 | 小补丁，可快速合入 |
| #14 `spawn ENAMETOOLONG` | bug | 无 | 未修 | 高优先级；与 #11 一并做 stdin |
| #16 多语言文档 | docs | **#17** | PR 可合 | 合 #17 即可 close |
| #18 headless 权限拒绝 / replay 生命周期 | bug | **#20**（覆盖并优于 #15） | PR 可合 | 合 #20，close #15 |
| #19 插件 UI i18n | feat | **#21** | PR 可合 | 依赖新 peer，需审 |

### 3.2 Issue #13 — Windows 控制台闪窗（可立即修）

**根因核验（属实）**：

1. `src/host/oauth.ts:316-320` — `openBrowser` 的 `execFile('cmd.exe', …)` **未传** `windowsHide: true`。
2. `src/index.ts:519` 与 `:545` — `pool/add`、`pool/open-terminal` 拉起 `cmd.exe /c start cmd.exe /k …` **未传** `windowsHide: true`。
3. `runner.ts` 的 `startAgyProcess` / `killTree` **已有** `windowsHide: true`（v0.4.x 已修主路径）；`mirror-tool.ts` 的 `execFileSync` 也有。issue 里第 3、4 点（agy 子进程 / git shim）在 bridge 侧已基本覆盖，残余在 agy 上游。

**修复方案（bridge 侧，低风险）**：

```ts
// oauth.ts openBrowser — win32 分支
{ windowsVerbatimArguments: true, windowsHide: true }

// index.ts pool/add 与 pool/open-terminal — win32 分支
execFile('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `set "HOME=${acc.dir}" && set "USERPROFILE=${acc.dir}" && agy`],
  { windowsHide: true }, () => {})
```

注意：`open-terminal` 的**内层**可见终端仍会弹出（这是产品意图）；要隐藏的是**外层**包装 CMD 的闪窗。

**验收**：Windows 上触发 openBrowser / pool/open-terminal，无额外一闪而过的黑框；内层交互终端仍可用。补 `windowsHide` 选项的单元断言（若现有测试有 spawn 包装点）。

### 3.3 Issue #14 / #11 — `ENAMETOOLONG` 与 stdin 传输（高优先级）

**根因核验（属实）**：

- `src/host/adapter.ts:286`：`args.push('-p', opts.prompt)` 把整段 prompt（含 digest）塞进 argv。
- `src/host/oneshot.ts:120`：同样 `args.push('-p', prompt)`。
- Windows `CreateProcess` 命令行上限 ~32767 字符；走 `cmd.exe` 包装时（`runner.ts:214`，cmd-shim）还会再吃一层长度。
- issue #11 提出改 stdin，与 #14 同源。

**修复方案（建议一次做完）**：

1. **探测 agy 是否支持 prompt-from-stdin**（`-p -` / `--stdin` / 管道写入；以当前 agy 1.2.x 文档与 `--help` 为准，实现前先探测，不要假设 flag 名）。
2. **阈值策略**（稳健、可回退）：
   - argv 总长度 < 某阈值（建议 ~24KB，给 env/cwd/引号留余量）：维持现状 `-p <prompt>`。
   - 超过阈值且 CLI 支持 stdin：改为 `stdio: ['pipe','pipe','pipe']` + 写入 prompt 后 `stdin.end()`。
   - 超过阈值且 CLI **不**支持 stdin：明确报错（带长度与建议），避免静默截断。
3. **Windows cmd-shim 路径**：`viaCmd` 时拼接进 `/c` 的字符串同样受限；stdin 方案可绕过。若仍走 argv，应优先 `spawn(bin, args)` 直启（已有非 cmd 路径）并仅在必要时回退 cmd。
4. **注意 `keepStdin` 语义**（`runner.ts:175`）：当前非 keepStdin 会立刻 `stdin.end()`，因为 agy 在 pipe stdin 下会挂住（见注释）。引入 stdin-prompt 时必须区分“prompt 管道”与“挂着不用的 stdin”，避免复现挂死。
5. **测试**：构造 >32KB prompt 的 fake-agy，断言 spawn 成功、prompt 内容完整到达；Windows 条件下跑 cmd-shim 路径。

**不建议**：仅加大 `digestMaxChars` 来规避——多轮对话仍会超限，且会丢上下文。

### 3.4 Issue #12 — `mcpBridge` 现状答疑

**事实**：功能自 v0.2 起存在，默认 `mcpBridge: false`（`src/common/types.ts:105`）。实现见 `src/host/mcp-bridge.ts` + `src/host/bridge.mjs`；`docs/KNOWN-GAPS.md:12-17` 标注为 experimental。本地 E2E（`test/v02.test.ts`）覆盖 loopback endpoint、allowlist、stdio JSON-RPC。

**答复建议**（可直接回 issue）：

- 可用，但是实验特性：loopback + token 守卫，向 workspace `.mcp.json` 注册 `dsh-tools`，禁用 `run_code`/`agy_ask`，可用 `mcpToolAllowlist` 收窄。
- 开启：配置 `mcpBridge: true` 或 `DSH_AGY_MCP_BRIDGE=1`。
- PR #20 还修了 dispose 期间 bridge 启动竞态与 `server.unref()`，合入后更稳。
- 若仍有问题，请附 `/agy doctor` 与 agy 版本。

## 4. PR 可合并性评估

本地复验结果（临时克隆，`check + build + test`）：

| PR | 标题 | +/− | 本地结果 | 冲突 | 与 main 关系 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| #15 | skip trailing snapshots + unref | +34/−15 | 152/152 | 无 | 落后 main 若干 release | **不要合**；被 #20 取代 |
| #17 | docs pt-BR/es/en | +205/−1 | 152/152 | 无 | 干净 | **可合** |
| #20 | headless denial + lifecycle + config | +418/−28 | 163/163 | 无 | 含 #15 的改进版 | **可合（带 review 意见）** |
| #21 | UI i18n zh/en/pt-BR/es | +511/−109 | 158/158 | 无 | 干净 | **可合（先审依赖）** |
| #22 | native toolview + agy-db | +1330/−7 | 173/173 | 无 | 干净 | **可合（带 review 意见）** |

### 4.1 PR #15 — 建议 Close（被 #20 取代）

- 改动：`detectContinuation` 回跳时跳过**所有** `source.kind === 'plugin'` 消息 + unref timers/bridge。
- 问题：跳过任意 plugin 消息过宽——plugin 非 snapshot 形态可能携带指令/通知，误判 continuation 会复放错误 run。
- #20 已包含 unref 修复，并把 continuation 收窄为 **仅跳过 `source.form === 'snapshot'`**，语义更安全。
- 祖先关系：PR #15 **不是** #20 的 git 祖先（#20 重做/摘取而非 merge #15 分支）。
- **处置**：合并 #20 后评论并关闭 #15，致谢作者；不要两边都合。

### 4.2 PR #17 — 可合并

- 纯文档：`README` 链接 + `docs/README.{en,es,pt-BR}.md`。
- 无运行时/依赖变更；命令与标识符保持字面量（抽查通过）。
- 对应 close #16。

### 4.3 PR #20 — 可合并（优先 review 意见）

关闭 #18。关键变更：

1. **continuation**：仅跳过 `plugin + form==='snapshot'`；human / 外部 tool result / 未知形态仍为边界。
2. **status 诚实性**：`onRun` 从 `{ok, code}` 改为 `{processOk, processCode, toolErrors[]}`，进程成功与工具失败分离。
3. **config 优先级**：`resolveConfig` 层序 `[entry, overrides]` → `[overrides, entry]`，env 仍在最后最高优先（与注释 “Env wins last / ADR-13” 一致）。修的是 runtime 选择覆盖 Cordis entry 默认。
4. **MCP lifecycle**：dispose 期间关闭启动中的 bridge；unref 后台 handle。
5. **文档**：新增 `docs/HEADLESS-PERMISSIONS.md`，扩展 SECURITY-NOTES。

**Review 意见（合并前建议处理或明确接受）**：

| 级别 | 意见 |
| --- | --- |
| 应改/应确认 | `adapter.ts` 中 **Recovery boundary**：当 `binding !== undefined` **或** prompt 匹配 `/\b(missing\|not found\|enoent)\b/i` 时，向 prompt 追加一段英文系统指令。这是插件侧的**关键词驱动 prompt 注入**——“missing the bus”“TODO not found”都会触发；resumed turn 无条件追加也可能污染短回复。建议：仅在上一轮存在 `missing_file` 类 tool error（`classifyToolError` 已提供）时追加，且做成可配置/默认关闭；文案去掉 “global brain” 这类环境特定措辞。 |
| 应改 | `classifyToolError` 用英文正则分类，对 agy 本地化/改文案的错误字符串很脆。保留 raw error 已做对；分类仅用于 status 展示时要在 UI 标明 “heuristic”。 |
| 可选 | `HEADLESS-PERMISSIONS.md` 中的复现命令较长，确认不含真实私有路径（当前为 `/tmp/agy-shared-fixture`，OK）。 |
| API 变更 | `onRun` 形状变更会破坏任何外部依赖旧字段的消费者；本仓库内已改齐，CHANGELOG 需标注。 |

### 4.4 PR #21 — 可合并（先审依赖）

关闭 #19。关键变更：

- 新增 `src/client/locales.ts`（zh/en/pt-BR/es 字典 + placeholder 对齐测试）。
- `inject` 增加 `locale`；`package.json` 增加 **必选** peer `@deepseek-ai/dsh-client-locale`（`optional: false`）。
- `permission.skip` 文案改为“自动批准；AGY 内部保护仍生效”，与 #20 的安全叙事一致。

**Review 意见**：

| 级别 | 意见 |
| --- | --- |
| 应确认 | 将 `@deepseek-ai/dsh-client-locale` 设为 **非 optional peer**：旧版 DSH 宿主若无该包，安装/运行可能失败。建议 `optional: true` + 运行时探测，或文档写明最低 DSH 版本。 |
| 应确认 | 正文提到 “pre-existing LOCAL dsh-sound patch” 等本机环境补丁——与上游无关，勿带入。当前 diff 未包含，OK。 |
| 可选 | 字典为硬编码 `as const` 对象，无远程加载，无注入面。保持即可。 |

### 4.5 PR #22 — 可合并（带 review 意见）

大功能：原生 `agy_tool` 工具卡片 + 从 agy SQLite 恢复被 `filterToolParameters` 剥掉的完整参数。

**亮点**：mapper 在 `state === 'DONE'/'ERROR'` 时也 cut span，修无 output 丢卡片；toolview 纯 React + 主题 CSS 变量；版本 bump 0.4.28 + CHANGELOG。

**Review 意见（安全相关优先）**：

| 级别 | 意见 |
| --- | --- |
| 应改 | `agy-db.ts`：`join(AGY_DB_DIR, \`${conversationId}.db\`)` **未校验** `conversationId`。若上游事件被污染为 `../../.ssh/id_rsa` 等，存在路径穿越读文件风险。合并前应加白名单：`/^[A-Za-z0-9_-]{1,64}$/`（或同等严格规则），否则直接返回 null。 |
| 应改 | 依赖外部 `sqlite3` CLI：Windows 官方安装常无此命令。已有 graceful fallback，但应在 README/KNOWN-GAPS 写明“无 sqlite3 时 diff 降级”。 |
| 应确认 | 复制 DB + `-wal`/`-shm` 到 `tmpdir` 的并发与磁盘占用；`maxBuffer: 10MB` 是否足够大会话；失败时是否绝不抛到用户 turn。 |
| 可选 | protobuf “亚毫秒扫描器”是启发式字节扫描，非标准解码；对上游 payload 布局变更敏感。建议加注释与回归 fixture（已有部分测试）。 |
| 版本 | PR 自带 version 0.4.28 + CHANGELOG，合并策略与 #17/#20/#21 的版本节奏对齐（谁最后合谁负责 bump，或全部由 maintainer 统一 bump）。 |

## 5. 建议合并顺序

```text
1. PR #17  (docs)           — 无依赖，先合
2. PR #20  (runtime fix)    — 关 #18；close #15
3. PR #22  (toolview)       — 修 path 校验后合；或先合再开 follow-up 修
4. PR #21  (UI i18n)        — 确认 peer optional / 版本门槛后合
5. 本地再合 Windows 小修 (#13) 与 ENAMETOOLONG/stdin (#14/#11)
```

冲突面：五个 PR 的 `merge-tree` 目前均无冲突标记，但 #20/#21/#22 都碰 `src/index.ts` / `src/host/adapter.ts` / `package.json`，**必须按序合并并在每步后跑 check+build+test**，不要并行 merge。

## 6. 合并后仍待实现的修复（建议 issue/PR 跟踪）

1. **#13 闪窗**：3 处 `windowsHide: true`（见 §3.2），半天内可完成。
2. **#14/#11 stdin**：按 §3.3 做阈值 + stdin + Windows 直启；这是当前**最影响可用性**的 bug。
3. **PR #20 Recovery boundary 收窄**（§4.3）。
4. **PR #22 conversationId 白名单**（§4.5）。
5. 可选：为 fork PR 启用 CI（`pull_request_target` 谨慎使用，或要求 first-time contributor approve），避免 UNSTABLE 误导。

## 7. 明确不做的事

- 不因 issue 正文建议而放宽 `permissionMode`、不默认 `--dangerously-skip-permissions`。
- 不把 PR/issue 文档中的命令自动 copy 进仓库脚本。
- 不在未复验的情况下采信 “independent review PASS / N tests passed”。
- 不发布 npm / 不打 tag（遵循 AGENTS.md：必须 maintainer 明示）。

## 8. 复验记录（摘要）

| 分支 | check | build | test |
| --- | --- | --- | --- |
| main | pass | （已有 dist） | 152/152 |
| pr-15 | pass | pass | 152/152 |
| pr-17 | pass | pass | 152/152 |
| pr-20 | pass | pass | 163/163 |
| pr-21 | pass | pass | 158/158 |
| pr-22 | pass | pass | 173/173 |

复验环境：macOS，Node 由本机提供；PR #21/#22 因 `package.json` 变更使用 `npm ci`。fork CI 未跑不作为否决依据。

## 9. 执行记录（2026-09-15 已完成）

| 步骤 | 结果 |
| --- | --- |
| Fork PR CI | 全部 `action_required` run 已 approve；CI 全绿。流程写入 `AGENTS.md`（GitHub 无公开 API 可关闭首次批准门） |
| PR #17 | 已合并 |
| PR #20 | 已合并；随后移除 Recovery boundary 关键词注入 |
| PR #15 | 已关闭（被 #20 取代） |
| PR #22 | 与 #20 冲突解决后合并；conversationId 白名单已加 |
| PR #21 | 与 #22 冲突解决后合并；locale peer 改为 optional + 运行时回退 zh |
| Issue #13 | 已修并关闭（`windowsHide: true`） |
| Issue #14 / #11 | 已实现 stdin stream-json 传输并关闭 |
| Issue #12 / #16 / #18 / #19 | 已关闭 |
| 最终验证 | `check` + `build` + **197/197 tests**；main CI success |

**未做（遵守 AGENTS.md）**：未 `npm publish`、未打 tag / GitHub Release。版本号为 `0.4.28`（含上述全部变更），等 maintainer 明示后再发。
