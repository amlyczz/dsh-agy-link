# dsh-agy-link 综合设计 Spec（v1）

> 把 Google Antigravity 的 `agy` CLI 模型接入 DeepSeek Harness（DSH）：模型进 DSH 的 model 配置与 `/model` 选择器，chat 全量支持文本输出、思考过程、工具调用呈现与用量统计——全面对标并超越 pi 生态的 `@estebanforge/pi-antigravity-bridge`，发布到 DSH 插件市场（awesome-dsh-plugin）。
>
> 状态：待用户评审 ｜ 工作目录：`/home/zand/proj/dsh-agy` ｜ 日期：2026-08-18

---

## 0. 摘要

**做什么**：一个 DSH 插件（npm 包 `dsh-agy-link`，已确认可注册），核心是一个 `LlmAdapter`——把 DSH 的 `ctx.llm` 流式调用翻译为本地 `agy -p --output-format stream-json` 子进程，解析官方 NDJSON 事件流回填 DSH 的 `StreamChunk` 协议（text/reasoning/usage/finish），并把 DSH 会话与 agy conversation 持久绑定实现多轮续聊。配套：模型自动发现（`agy models --output-format json`）、GUI 内 OAuth 登录助手、`/agy` 命令族、设置卡片、`agy_ask` 委托工具、诊断包、CI/发布/市场上架工程。

**为什么是现在**：本机 agy 1.1.13 已提供官方机器可读输出（`--output-format stream-json`，1.1.8 引入、1.1.12 扩展到 models/agents 子命令），pi 桥赖以生存的 SQLite+protobuf 逆向轮询可以被**官方稳定接口**取代——我们继承它的会话绑定/流式增量/回退目录等工程精华，抛弃它的逆向脆弱性与宿主打补丁。

**成功的样子**：`dsh plugin --profile web add dsh-agy-link` → 重启 → GUI 里 `/agy auth` 点链接登录一次 → `/model` 出现 antigravity 分组 → 选中 Gemini 3.x Pro，聊天流式输出、思考过程折叠可见、agy 的工具活动实时呈现、token 用量正确入账。

---

## 1. 调研结论汇总（spec 的事实基础）

### 1.1 agy CLI（本机 v1.1.13 实测 + 官方仓库）

| 事实 | 证据 |
|---|---|
| 身份：Google Antigravity 官方终端 agent CLI，与 Antigravity 2.0 GUI 共享 Agent Engine | [google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli) |
| 非交互模式：`agy -p '<prompt>'`；`--output-format text\|json\|stream-json`（1.1.8+） | 本机 `agy --help` 实测；[changelog 1.1.8](https://github.com/google-antigravity/antigravity-cli) |
| stream-json 是强类型 NDJSON：`init` / `step_update` / 终态 `result`，closed-vocabulary `step_type` 判别器；每工具调用带 `tool_info`（canonical name/parameters/output）；子代理带 `subagent_info`（conversation_id、log_uri） | changelog 1.1.8 原文 |
| `result` 信封实测样本（本机未登录触发）：`{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}` | 本机 `agy -p hi --output-format stream-json` 实测 |
| usage 含 `thinking_tokens`、`cache_read_tokens`（1.1.8+）→ 可完整映射 DSH `TokenUsage` | changelog 1.1.8 |
| `agy models --output-format json`（1.1.12+，错误与 spinner 移出 stdout）；未登录报 "Please sign in" | changelog 1.1.12；本机实测 |
| 关键 flag：`--model` `--effort low|medium|high`（1.1.5+）`--mode plan|accept-edits` `--conversation <id>` `--continue` `--add-dir`（可重复）`--dangerously-skip-permissions` `--sandbox` `--print-timeout`（默认 5m）`--json-schema` | 本机 `agy --help` |
| print 模式免 quota 只读命令：`-p "/model" "/effort" "/usage" "/quota" "/permissions" "/config"` 等直接结构化应答（1.1.11/1.1.12） | changelog 1.1.11/1.1.12 |
| 认证：Google OAuth，token 落 `~/.gemini/antigravity-cli/antigravity-oauth-token`；无 TTY 时打印授权 URL 并等 code 粘贴（60s 超时） | 本机实测（URL + "Or, paste the authorization code here"） |
| 数据目录：`~/.gemini/antigravity-cli/`（settings.json、conversations/*.db、log/、bin/agy-node） | 本机实测 |
| 权限：`-p` 非交互无法答 y/n，社区桥接默认必须 `--dangerously-skip-permissions`（否则 run_command 挂死，上游 [issue #318](https://github.com/google-antigravity/antigravity-cli/issues/318)）；`--sandbox` 勿与 skip-permissions 同用（[issue #36](https://github.com/google-antigravity/antigravity-cli/issues/36)） | pi 桥 README + 上游 issue |
| headless 下模型遇到提问会自行决断而不是挂住（1.1.12） | changelog 1.1.12 |
| 1.1.13 新增 `GEMINI_API_KEY` 直连 Gemini API 通道（`modelProvider: "gemini"`） | changelog 1.1.13（本插件不依赖，记为开放问题） |

### 1.2 pi-antigravity-bridge 全功能清单（对标基线）

来源：[@estebanforge/pi-antigravity-bridge](https://github.com/EstebanForge/pi-antigravity-bridge) v1.2.4 npm tarball 全量源码精读（调研报告见 `pi-antigravity-bridge-research-report.md`）。

**A. 流式模型 provider**
1. 加载时 spawn `agy models` 发现模型；slug 化 + effort 折叠（Gemini base + low/medium/high 档位；Pro 无 medium；Claude/GPT-OSS 固定无档位）
2. 发现失败 → 硬编码回退目录（gemini-3-6-flash / gemini-3-1-pro / claude-sonnet-4-6）；5 分钟 TTL 缓存（过期先返旧值后台刷新）
3. 模型元数据：contextWindow 写死 1M、maxTokens 65536、cost 全 0、input 仅 text（图片块静默丢弃）
4. 会话绑定：pi session → agy conversation id + lastStepIdx，原子 JSON + dirty-key 合并（多进程安全）；每轮只发最新用户消息，agy 自带历史
5. 跨轮上下文 digest：切 provider / 其他工具轮之后，把 watermark 后的其他 provider 文本轮文本压缩成 ≤8000 字符 digest 注入 prompt
6. 编辑 diff 渲染：解析 agy 工具 inputJson，git HEAD 算带行号 diff 流进 thinking 面板

**B. AskAntigravity 委托工具**：一次性 `agy -p` 委托；参数 prompt/cwd/model（flash/pro/gemini 别名 + 精确 slug + 档位就近匹配）/mode/digest/conversationId（续聊）/timeoutMinutes/includeContext（导出当前对话 markdown 给 agy 读）；防递归（当前 provider 是 antigravity 时拒绝）；renderCall/renderResult UI。

**C. MCP 工具桥**（agy 反调 pi 工具）：进程内 127.0.0.1 Streamable HTTP MCP server；tools/list 暴露 pi 工具（过滤内置+AskAntigravity）；tools/call 经 `pi.invokeTool()`——**pi 无此 API，需给 pi dist/ 打本地补丁**（6 处插入点、可回滚、pi 升级自动重打）；agy 经 `--add-dir <agy-mcp-<pid>>` 内的 `.agents/mcp_config.json` 发现；x-bridge-token 防护、1MB body 上限、MCP 协议版本钳制。

**D. /agy 命令**：status / mode plan|accept-edits / permissions on|off / model / thinking / patch status|apply|restore / clear；配置持久化 config.json，下一轮生效。

**E. 工程**：7 个 AGY_* 环境变量（env > 文件 > 默认）；跨扩展冲突 Symbol 标志退让；ToS 风险说明（spawn 官方未修改二进制 + 只读本地数据，Google 视角等同终端直跑）。

**它的集成机制**（我们**不抄**的部分）：spawn agy 后**不读 stdout 文本**，而是 250ms 并发轮询 `~/.gemini/antigravity-cli/conversations/<uuid>.db`（node:sqlite 只读句柄 + `PRAGMA data_version` 合并）+ 手写 protobuf varint 解码 step_payload（field 20.1=文本、5.4=工具调用、30.4=标题；step_type 15=agent text/14=thinking/23=title/{5,7,8,9,17,21,33,101,132,138}=tool run）+ 新会话 id 靠 conversations 目录快照差分 + `/proc/<pid>/fd` 进程树消歧。**原因**：它适配的 agy ≤1.1.9 时代 print 模式 stdout 只有最终纯文本；1.1.8+ 的 stream-json 已提供官方结构化流，逆向层可以整体退役（保留为 P2 降级预案，见 ADR-1）。

### 1.3 DSH 插件体系（0.1.0-rc.6，本地 checkout + 官方 docs）

| 事实 | 用途 |
|---|---|
| 插件 = Cordis 插件（`export function apply(ctx)` + `inject` 声明依赖），一切注册是 effect，卸载自动回滚 | 整体形态 |
| 分发：package.json `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`；用户 `dsh plugin --profile web add <pkg>`（pnpm 转发 + 自动并入 `dsh.profile.bundles`） | 打包与安装 |
| **模型接入点**：`ctx.llm.registerAdapter(['antigravity'], adapter)`，`LlmAdapter` 抽象类只需实现 `stream(options): AsyncIterable<StreamChunk>`；可选 `providerInfo/listModels/resolveModel/providerRetryPolicy` | 本插件核心 |
| `StreamChunk` 协议：`block-start{index,blockType}` / `text-delta` / `reasoning-delta` / `tool-call-delta{id,name,argumentsDelta}` / `block-end{block}` / `usage{TokenUsage}` / `finish{reason,replayState?}`；**usage 先于 finish，finish 后不再发**；工具 arguments 全程原始 JSON 字符串；失败只有两条路（抛 `LlmError` 带稳定 code，或 `finish{kind:'error'/'aborted'}`）；必须遵守 `options.signal` | adapter 契约（dsh-llm/lib/types/types.d.ts 实读） |
| `GenerateOptions`：provider/model/reasoningEffort/messages/system/tools/temperature/maxTokens/stop/signal/sessionId/purpose | 请求词汇 |
| `TokenUsage`（不相交）：inputTokens（未缓存输入）/outputTokens/cacheReadTokens?/cacheWriteTokens?/reasoningTokens? | usage 映射目标 |
| 注册后模型自动进入 GUI `/model` 选择器与模型设置页（`listModels` + `resolveModel` 元数据；`registerConfigurableProviders` 让设置页在 dormant 时也能显示） | 原生 WebUI 适配，零额外开发 |
| 命令：`ctx.commands.register({name,description,handler})`，不经模型直接执行 | /agy 命令族 |
| 工具：`ctx.tools.register(defineTool({name,description,parameters,output,execute,presentCall,presentResult}))` | agy_ask |
| 设置：`ctx.settings.register(ns, schema)` 热加载；密钥走 `ctx.credentials`（本插件**不需要**——agy 自管 token） | 配置 |
| client plugin：`"dsh":{"client":{"inject":["slots"],"platform":"web"}}` + `exports["./client"]`；`ctx.slots.inject('settings.plugin.item'|'sidebar.footer.action'|'shell.overlay', ...)` 注入 UI；tsdown clientBundle 产物（预设未发布，需自行复刻 lazy-CJS factory 格式，参考 dshmarket/dsh-lark-link 现成 tsdown 配置） | GUI 卡片/面板 |
| 持久 KV：`ctx.storage.domain`（zod 表 + JSON/SQLite 后端）——比裸 JSON 文件更 DSH 原生；pi 桥的原子 JSON 也可保留作低依赖路径 | 会话绑定存储 |
| 事件：`llm/stream` waterfall 可拦截每次调用；`llm/adapters-updated` 拓扑通知 | 可选 |
| 环境变量：`DSH_` 前缀是 boot 保留（.env 不得设置）；`ctx.subprocess.spawn` 会剥掉 DSH_* 与密钥 env——**插件自己用 node:child_process spawn agy，不受此限**，但要注意我们 spawn 的 agy 继承宿主 env（含 DSH_*，agy 不认识，无害） | env 设计 |
| profile 组合：bundles patch 顺序叠加 → profile cordis.patch.yml → home patch → --patch；`dsh --profile web --dump-config` 检查 | 调试 |

### 1.4 插件市场（上架路径）

- **无官方市场仓库**；官方可发现机制 = GitHub topic `dsh-plugin`（[deepseek-harness README](https://github.com/deepseek-ai/deepseek-harness)）。
- 用户本地装的 market = [dshmarket](https://github.com/dsh-market/dsh-market)（npm `dshmarket`，数据源 [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)）。
- **上架 = 给 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR**：
  ```yaml
  # data/plugins/<owner>__dsh-agy-link.yml
  url: https://github.com/<owner>/dsh-agy-link
  name: <owner>/dsh-agy-link
  category: model            # 「模型与账号接入」分类（29 个现存竞品在此）
  description:
    en: One-line description ending with a period.
    zh: 一句话描述，以句号结尾。
  ```
  加 `node scripts/generate-readme.mjs` 重新生成的 README 一并提交。
- **CI 硬性要求**：package.json 声明 `dsh.bundle`（仅有 dsh.client 会被拒）；仓库 ≥1 天且 ≥10 commits；带 `dsh-plugin` topic。合并后 1–2 天自动同步进市场，无人工审核。
- dshmarket 安装侧安全：只装 registry 收录来源；npm tarball 优先（先发 npm 再上架，安装秒级且免 allowBuilds）。
- 竞品 radar 教训（dsh-lark-link 的 ISSUE 实录）：仓库命名避免歧义、star/verdict 来自自动扫描——**README 首屏写清包名与安装命令**，防占位 URL 误判。

### 1.5 竞品与"取其精华去其糟粕"

model 分类下 29 个竞品中最相关的对标（registry snapshot 实读）：

| 插件 | 借鉴 | 规避 |
|---|---|---|
| [dsh-codex-auth](https://github.com/nicobailon/dsh-codex-auth)（★7） | 复用 CLI 登录态注册 `openai-codex` 路由 + Web 设置卡 | — |
| dsh-codex-connect（★11）/ dsh-plugin-codex（★2） | 订阅桥的 session 复用、原生 action trace 呈现 | — |
| dsh-claude-cli（★0） | 同为"CLI 当模型后端"形态 | 星低说明易用性是生死线 |
| dsh-everything-oauth（★1） | 导入本地已登录 CLI 凭据 + GUI 勾选启用 | — |
| dsh-github-login（★6） | **可视化设备流登录**（窗口内完成，不碰终端）——我们的 /agy auth 直接对标 | — |
| dsh-llm-ollama / dsh-llm-newapi | 非 HTTP 后端的 NDJSON 直译 + 模型发现带 contextWindow | — |
| dsh-usage-meter / dsh-model-sync | 用量/配额展示钩子 | — |
| pi-antigravity-bridge（本命参考） | 会话绑定、增量发射、回退目录、TTL 缓存、防递归、ToS 论述、诚实文档 | SQLite+protobuf 逆向（换官方 stream-json）、宿主打补丁（DSH ctx.tools 原生可调，P2 无需 patch）、usage 恒 0（我们有真 usage）、工具活动只有名字（我们带 tool_info 参数/输出） |

**易用性设计原则**（竞品共同教训）：零配置自动检测 agy；登录前 dormant 不报错刷屏；一条命令完成认证；模型选择器原生出现；所有故障路径给出"下一步做什么"的可执行提示。

---

## 2. 目标与非目标

### 2.1 目标（P0）

1. **模型接入**：`agy models` 的模型（Gemini 3.x / Claude / GPT-OSS 系）以 `antigravity/<slug>` 形式出现在 DSH `/model` 选择器与模型设置页；effort 档位映射为 DSH reasoning efforts（`--effort`）。
2. **chat 全体验**：文本与思考过程**流式**呈现；agy 工具调用以带参数摘要与输出的呈现块可见；token 用量（input/output/thinking/cache_read）正确入账 DSH token meter；中断（abort）即时生效。
3. **多轮续聊**：DSH 会话 ↔ agy conversation 持久绑定；重启 DSH 后继续原 agy 会话。
4. **GUI 登录闭环**：`/agy auth` 在 Web GUI 内完成 Google OAuth（显示链接+二维码，粘贴 code），无需终端。
5. **命令族**：`/agy status|auth|models|mode|effort|doctor|clear`。
6. **发布**：npm 包 + GitHub 仓库（topic `dsh-plugin`）+ awesome-dsh-plugin PR（category: model）+ CI/Release 工作流 + issue/PR 模板 + 双语 README。

### 2.2 P1

- `agy_ask` 委托工具（AskAntigravity 等价，防递归 + includeContext 导出）。
- 设置卡片（settings.plugin.item）：状态/默认模型/模式/档位热改。
- 侧栏状态灯（sidebar.footer.action）。
- `agy /usage /quota` 免 quota 查询入 `/agy status`。

### 2.3 P2 / 非目标（v1 明确不做）

- **MCP 反向桥**（agy 调 DSH 工具）：设计预留（见 §5.7），实现推 P2——DSH 侧 `ctx.tools` 原生可调用，不需要 pi 那样的 dist 补丁，但要解决工具 schema 翻译与递归防护，值得独立一个 minor 版本。
- SQLite+protobuf 轮询降级路径（agy <1.1.8 支持）：只做版本探针 + 升级引导，不做双实现。
- 图片输入桥接（agy 模型多模态但 print 模式 prompt 是纯文本；等 agy 结构化附件通道）。
- 修改用户全局 agy 配置（`~/.gemini/**` 只读不写，除登录流程本身由 agy 官方二进制完成）。
- GEMINI_API_KEY 直连通道（与"复用订阅登录"定位不同，用户可直接用内置 llm-pi-ai 配 Gemini API）。

---

## 3. 总体架构

### 3.1 架构图

```
DSH Web GUI / CLI
   │  /model 选 antigravity/gemini-3-1-pro   /agy * 命令
   ▼
DSH agent loop ── GenerateOptions ──▶ ctx.llm (LlmRuntime)
                                        │ provider='antigravity'
                                        ▼
                        ┌──────────────────────────────┐
                        │ AgyBridgePlugin (Cordis)      │
                        │  ├ AgyAdapter extends LlmAdapter
                        │  │   stream(): 组装 spawn 参数 │
                        │  ├ ModelCatalog（发现/缓存/回退）│
                        │  ├ SessionBinder（持久绑定）    │
                        │  ├ StreamJsonParser（NDJSON→事件）│
                        │  ├ EventMapper（事件→StreamChunk）│
                        │  ├ AuthHelper（OAuth URL 捕获） │
                        │  └ ProcessRunner（进程组管理）   │
                        └──────┬───────────────┬───────┘
                 node:child_process              ctx.remote → client plugin
                               ▼                        ▼
               agy -p "<最新用户消息>"           设置卡 / auth 面板 / 状态灯
                 --model <slug> --effort <lvl>
                 [--conversation <id>] [--mode …]
                 [--dangerously-skip-permissions]
                 --output-format stream-json
                 --print-timeout <N>m
                               │ NDJSON (init/step_update*/result)
                               ▼
                        StreamChunk 流回 ctx.llm → GUI 原生渲染
```

### 3.2 ADR 表（关键决策）

| # | 决策 | 理由 |
|---|---|---|
| **ADR-1** | **官方 `--output-format stream-json` 为唯一数据源**；不实现 SQLite+protobuf 轮询（pi 桥的逆向层整体退役）；版本探针要求 agy ≥1.1.8，否则报错并引导 `agy update` | 官方接口 vs 逆向内部实现（字段号 load-bearing，agy 升级即碎）；parser 对未知 `step_type` 前向兼容（忽略+debug 日志）。本机 1.1.13 已验证接口存在 |
| **ADR-2** | 包名/仓库名统一为 **`dsh-agy-link`**（用户决策 2026-08-18，与 dsh-lark-link 命名一脉相承）；provider 路由 id = `antigravity` | npm 已核实 `dsh-agy-link` 可注册（`dsh-agy` 已被占用）；与 pi 桥 `antigravity/*` 模型命名兼容，用户迁移零成本 |
| **ADR-3** | 每次请求 spawn 短生命周期 `agy -p` 进程（detached 进程组，SIGTERM→5s→SIGKILL），不常驻 agy | print 模式即为此设计；无僵尸进程面；abort 语义干净 |
| **ADR-4** | 会话绑定：DSH sessionId → {conversationId, resultSeq} 存 `ctx.storage.domain` KV 表（fallback：`<DSH_HOME>/agy-bridge/sessions.json` 原子写 tmp+rename）；续轮 `--conversation <id>` 只发最新用户消息 | 继承 pi 桥验证过的多轮方案；agy 自带历史，避免逐轮重放整个 DSH 历史 |
| **ADR-5** | conversation_id 获取：优先 `init`/首个事件的 conversation_id 字段；**fallback = conversations 目录快照差分**（pi 桥/agy-acp 同款）；0 新库→本轮不绑定（仍返回结果），>1 个→按 mtime 最新且报 debug | 实测未登录时 result.conversation_id 为空串——登录后需实测确认字段位置；差分是兜底保险 |
| **ADR-6** | **不发 DSH tool-call 块**：agy 跑自己封闭工具循环（作用 workspace），DSH 工具 schema 不下发给 agy；agy 工具活动映射为 **reasoning 块**（`[agy tool: <name>] <参数摘要>`）+ `result.tool_info.output` 尾注；文件编辑类工具额外渲染 git diff（采 pi 桥 diff-render，≤100 行截断） | 与 pi 桥同判断：没有 toolUse stopReason、没有结果回传路径；DSSH `tool-call-delta` 语义要求模型主动调 DSH 工具，agy 做不到；P2 MCP 桥才打通反向 |
| **ADR-7** | **DSH system prompt 与 tools 不发送**（可配置 `forwardSystemPrompt: false`）；新建 agy 会话时若 DSH 历史含其他 provider 的轮次，注入 ≤8000 字符历史 digest 前缀（从新到旧截断） | DSH system prompt 描述的是 DSH 工具集，发给 agy 只会误导；digest 继承 pi 桥 G1 方案解决切模型/混用场景 |
| **ADR-8** | 权限三态配置：`permissionMode: skip（默认）\| plan \| accept-edits` → `--dangerously-skip-permissions` / `--mode plan` / `--mode accept-edits`；README+设置卡红字警告 skip 的含义与上游 issue #318/#36 | 非交互无法应答审批是硬约束；plan 模式给只读用户安全选项 |
| **ADR-9** | usage 映射：`input_tokens→inputTokens`、`output_tokens→outputTokens`、`thinking_tokens→reasoningTokens`、`cache_read_tokens→cacheReadTokens`；失败时 usage 全 0 照发（协议要求 usage 先于 finish） | 字段名一一对应（实测样本 + changelog） |
| **ADR-10** | 模型发现：`agy models --output-format json`（TTL 5min，过期先返旧值后台刷新；失败用硬编码回退目录保证选择器不空）；slug 折叠：`gemini-3-6-flash-medium` → model `gemini-3-6-flash` + efforts {low,medium,high}；Claude/GPT-OSS 无 effort；contextWindow 默认 1,048,576 / maxTokens 65,536（config 可覆盖 per-model） | 继承 pi 桥成熟方案；DSH `LlmModelReasoningInfo` 原生支持 effort 目录 |
| **ADR-11** | 认证：不读/写/搬 token 文件；检测认证失败特征（stdout "Authentication required" / result.error 含 authentication）→ `LlmError('AUTH')` + 捕获 OAuth URL 存 pending 状态；`/agy auth` spawn 短超时探测进程，捕获 URL → GUI 显示可点链接+二维码（host 侧 qrcode 生成 dataURL 经 remote 传）→ 用户粘贴 code → 写子进程 stdin → 等结果 | 完整对标 dsh-github-login 的窗口内设备流体验；备选提示"终端跑一次 agy" |
| **ADR-12** | 并发：同 conversation 严格串行（per-session promise 链）；跨会话并发上限默认 3（队列排队）；全局 spawn 互斥锁防 models 发现与请求互相干扰 | agy 后端是订阅配额，防自我 DoS |
| **ADR-13** | env 约定：插件配置 env 用 `DSH_AGY_*`（`DSH_AGY_BIN`/`DSH_AGY_EXTRA_ARGS`/`DSH_AGY_CONVERSATIONS_DIR`/`DSH_AGY_MODE`/`DSH_AGY_SKIP_PERMISSIONS`/`DSH_AGY_DEFAULT_MODEL`/`DSH_AGY_DEFAULT_EFFORT`，对齐 pi 桥 7 变量语义）；优先级 env > settings > 默认 | 遵守 DSH `DSH_` 保留前缀规则（不写 .env，只从进程环境读）；cordis.patch.yml 用 `!!js "process.env.DSH_AGY_… ?? '默认'"` 插值 |
| **ADR-14** | 诊断：`/agy doctor` 输出 markdown 诊断文件（agy 版本/登录态/models 摘要/最近一次 stream-json 原始事件日志（URL 与 code 脱敏）/配置快照/绑定表），文件路径返回给用户贴 issue | 对标 lark-link /doctor 的实战价值；issue 模板直接引导 |
| **ADR-15** | 插件 dormant 语义：apply 时探测 agy 二进制（PATH + `DSH_AGY_BIN`）；找不到→dormant（注册 configurableProviders 目录但不注册活路由，日志一条安装指引）；找到→注册路由 + 后台发现模型 | 易用性：装了插件但没装 agy 的用户不被报错轰炸 |

### 3.3 stream-json → StreamChunk 映射表（核心翻译层）

| agy 事件 | 条件 | StreamChunk | 说明 |
|---|---|---|---|
| `init` | — | （内部）记录 conversation_id（若有）、工具集；不外发 | 字段待实测（OQ-1） |
| `step_update` | step_type=agent text | `block-start{text}` → `text-delta`* → `block-end` | payload 若为全量快照则后缀差分出 delta（pi 桥增量发射技术） |
| `step_update` | step_type=thinking | `block-start{reasoning}` → `reasoning-delta`* → `block-end` | 同上 |
| `step_update` | step_type=tool run | reasoning 块内追加 `[agy tool: <name>] <参数摘要>`；完成时追加输出摘要（≤2KB） | tool_info.name/parameters/output；edit 类工具追加 git diff |
| `step_update` | step_type=title / subagent | subagent → reasoning 块 `[agy subagent: …]`；title 忽略 | 前向兼容：未知 step_type 忽略+debug |
| `result` | status 成功 | `usage{…}` → `finish{kind:'stop', replayState:{conversationId,resultSeq}}` | replayState 存绑定增量 |
| `result` | status=ERROR 且 error 含 auth 特征 | `usage{0}` → `finish{kind:'error', failure:{code:'AUTH', message}}` | 触发 pending-auth 状态 |
| `result` | status=ERROR 其他 | `usage{0}` → `finish{kind:'error', failure:{code:'AGY_ERROR', message:error}}` | |
| 进程非 0 退出 / watchdog 超时 | — | `finish{kind:'error', failure:{code:'TIMEOUT'/'PROCESS_EXIT'}}` | watchdog 默认 10m（config 可调），`--print-timeout` 同步放大 |
| `options.signal` abort | — | 杀进程组 → `finish{kind:'aborted', failure:{code:'ABORTED'}}` | 用户点停止即时生效 |

错误 code 稳定表（`LlmError`）：`AUTH` / `AGY_NOT_INSTALLED` / `AGY_VERSION_UNSUPPORTED` / `AGY_ERROR` / `TIMEOUT` / `PROCESS_EXIT` / `INVALID_OUTPUT`（NDJSON 解析持续失败）。

---

## 4. pi-antigravity-bridge 功能对照表（全覆盖声明）

| pi 桥功能 | 本插件 | 层级 |
|---|---|---|
| 流式 Gemini provider（/model 注册） | ✅ `antigravity/*` 经 ctx.llm 注册，GUI 原生选择器 | P0 |
| 模型自动发现 + slug 化 + effort 折叠 | ✅ 同款算法，数据源升级为官方 `--output-format json` | P0 |
| 发现失败回退目录 + TTL 缓存 | ✅ 同款（回退目录按本机 1.1.13 校准） | P0 |
| 多轮会话绑定 + 原子持久化 | ✅ storage.domain KV（升级自裸 JSON） | P0 |
| 跨轮上下文 digest（切 provider/混用） | ✅ ≤8000 字符 digest 前缀 | P0 |
| 思考过程流式呈现 | ✅ reasoning-delta | P0 |
| 工具活动呈现 | ✅ **增强**：reasoning 块 + tool_info 参数/输出摘要（pi 只有名字） | P0 |
| 编辑 diff 渲染（git 来源） | ✅ 采 pi 桥 diff-render | P1 |
| token 用量 | ✅ **超越**：真 usage 四字段映射（pi 恒 0） | P0 |
| 中止/超时 | ✅ 进程组杀树 + watchdog | P0 |
| /agy status/mode/permissions/model/thinking/clear | ✅ 映射为 /agy status/mode/permission/model/effort/clear（DSH 侧语义） | P0/P1 |
| AskAntigravity 委托工具 | ✅ `agy_ask`（防递归 + includeContext + 别名解析） | P1 |
| MCP 工具桥（agy 调宿主工具） | ⏸ P2（DSH 无需打补丁，架构占位 §5.7） | P2 |
| pi dist 补丁器（patcher） | ❌ 不需要（DSH ctx.tools 原生可调用） | — |
| SQLite 轮询 + protobuf 解码 | ❌ 退役（ADR-1）；差分发现保留为 conversation_id 兜底 | — |
| 7 个 AGY_* 环境变量 | ✅ 对齐为 DSH_AGY_*（ADR-13） | P0 |
| 跨扩展冲突退让 | ✅ 简化为 registerAdapter 冲突检测（DSH 原生 all-or-nothing 抛错） | P0 |
| ToS 风险论述 | ✅ README 原样传承（spawn 官方未修改二进制 + 不碰 token） | P0 |
| GAPS 诚实文档 | ✅ docs/KNOWN-GAPS.md | P0 |

---

## 5. 模块设计

```
dsh-agy-link/
├── package.json              # dsh.bundle + dsh.client + exports（§8.1）
├── cordis.patch.yml          # - insert: [{id: agy-bridge, name: 'dsh-agy-link', config: …}]
├── tsconfig.json / tsdown.config.ts
├── .github/
│   ├── workflows/ci.yml      # check+test+build+pack（§12）
│   ├── workflows/publish.yml # release published → npm
│   ├── ISSUE_TEMPLATE/bug.md · feature.md
│   └── PULL_REQUEST_TEMPLATE.md
├── docs/KNOWN-GAPS.md · AUTH.md · SECURITY-NOTES.md
├── assets/mascot.png · preview.svg
├── scripts/dev-link.mjs      # 符号链接本地 DSH checkout（沿袭 lark-link）
├── src/
│   ├── index.ts              # 薄装配：探测 agy → 注册 adapter/命令/工具/remote；<300 行
│   ├── adapter.ts            # AgyAdapter extends LlmAdapter（stream/providerInfo/listModels/resolveModel/providerRetryPolicy）
│   ├── runner.ts             # ProcessRunner：spawn 进程组、watchdog、abort、stderr 收集
│   ├── parser.ts             # StreamJsonParser：NDJSON 行缓冲（撕裂行拼接）→ 类型化事件；前向兼容
│   ├── mapper.ts             # EventMapper：事件 → StreamChunk（§3.3 表）；全量→增量后缀差分
│   ├── discovery.ts          # conversation_id 兜底：目录快照差分（+ /proc fd 消歧，Linux）
│   ├── models.ts             # ModelCatalog：agy models json → 折叠/回退/TTL 缓存
│   ├── sessions.ts           # SessionBinder：storage.domain KV + 降级 JSON；digest 生成
│   ├── auth.ts               # AuthHelper：探测 spawn、URL 捕获、code 注入、pending 状态机
│   ├── config.ts             # Schema（Schemastery）+ env 合并（env > settings > 默认）
│   ├── diff-render.ts        # edit 工具 git diff（P1）
│   ├── ask-tool.ts           # agy_ask defineTool（P1）
│   └── client/index.ts       # client plugin：设置卡 + auth 面板 + 状态灯（P1）
└── test/
    ├── parser.test.ts        # 录制的真实 NDJSON 夹具回放（含撕裂行/未知 step_type）
    ├── mapper.test.ts        # 映射表全覆盖 + usage/finish 顺序断言
    ├── models.test.ts        # slug 折叠矩阵（Gemini/Claude/GPT-OSS）
    ├── sessions.test.ts      # 绑定/恢复/provider 切换 digest
    ├── fake-agy.mjs          # 测试替身：按脚本输出 stream-json 事件序列
    └── adapter.test.ts       # 端到端：fake-agy → StreamChunk 断言 + abort/timeout
```

### 5.1 adapter.ts 契约要点

- `stream(options)`：校验 model 在目录（未列出→`UNKNOWN_MODEL`）；解析 conversationId（SessionBinder）→ runner.spawn → parser/mapper 流；finally 更新绑定（replayState 或 discovery 兜底）。
- `listModels()`：catalog 快照（dormant 时空数组）；`resolveModel()`：contextWindow/maxTokens/reasoning efforts。
- `providerRetryPolicy()`：默认 normal（maxRetries 2、指数退避）——agy 失败多为认证/配额，重试意义有限，auth 错误不重试（code 白名单）。

#### 5.1.1 agy 单条消息 192,000 字节上限与上下文注入策略（2026-10-29 实测）

**事实（agy 1.4.9 实测，非 Gemini 上下文窗口）**：agy 在发送前会把**单条用户消息**截断到 **192,000 UTF-8 字节**，并**从尾部**切除，随后插入 `<truncated N bytes>` + NOTE 说明。

| 输入 | agy 实际保留 |
|---|---|
| 纯 ASCII 300,047 B | 192,000 B |
| 中文 490,864 B | 191,998 B（字符边界少 2B） |
| 真实会话首包 143,650 字符 / 192,158 B | 头部保留，尾部（含 `[end of conversation so far]` 与当前提问）被砍 |

- 与传输方式无关：`--input-format stream-json`（NDJSON 行）与 `--input-format text`（整段 stdin）截断结果一致 → 是 agy 内部限制，不是管道/argv 限制。
- 没有任何可调参数：`agy --help` 无相关 flag；`agy changelog` 仅有 per-step token limit / 大消息反复 compact 的修复记录；配置 schema 只有响应侧 `max_tokens_per_step` / `max_input_tokens`。
- 1M 上下文只对**多消息历史**生效；单条巨型 prompt 无效。

**注入策略（本插件的对策）**：

1. **live 前置**：`wrapLiveRequest()` 把当前用户请求包成 `[CURRENT REQUEST …][/CURRENT REQUEST]` 放在 prompt **最头部**，背景历史一律排在其后 → 即使再被尾截断，砍掉的只是背景。
2. **字节预算**：`buildDigest(..., { maxBytes, maxLineBytes, includeTaskLine })` 按 **UTF-8 字节**裁剪（旧→新保留，先丢最老的），单条消息另有 40KB 上限，避免一条巨型工具输出吃光预算。
3. **大历史走文件**：digest 超过 `contextTransferFileAboveBytes` 时写入 `<stateDir>/context-transfer/<session>-<ts>.md`，prompt 只保留路径并用 `--add-dir` 暴露该目录，让 agy 用 `read_file` 分页读取 → 真正吃满 1M 上下文（实测：368KB 的 .md 文件由 agy 读取后正确回答，prompt 仅 300 B）。
4. **兜底**：发送前若 prompt > `AGY_PROMPT_SAFE_BYTES`(180,000 B) 则裁剪尾部并记日志，确保永不触发 agy 的静默截断。

**历史教训**：此前「首条 prompt = 全量 digest + 当前提问」的拼法，在 192KB 上限下会整段吃掉当前提问，模型只剩历史、把上一轮指令当新任务重做（promo-tcn 与 bst-leanring 两次事故同一死法）。

### 5.2 runner.ts 要点

- `spawn`：`detached: true`（进程组组长）；stdio: stdin pipe（auth 用）/ stdout pipe / stderr pipe；`cwd` = DSH 会话工作区（`process.cwd()`，config 可锁）。
- 杀树：`SIGTERM` 进程组 → 5s → `SIGKILL`；abort signal 即刻触发。
- watchdog：默认 600s（`DSH_AGY_TIMEOUT_S` 可调），到点杀树并报 `TIMEOUT`。

### 5.3 parser.ts 前向兼容规则

- 行不完整（无 `\n` 且进程未退出）→ 缓冲拼接；JSON.parse 失败且进程已退出 → 计入 `INVALID_OUTPUT`（连续 5 行才升级为错误，否则跳过+debug）。
- 未知 `event` / `step_type` / 字段 → 忽略 + debug 日志（agy 加字段的升级不碎）。
- 事件日志环形缓冲（最近 2000 行）供 /agy doctor 导出。

### 5.4 sessions.ts 绑定键

- 键：DSH `sessionId`（GenerateOptions.sessionId）；无 sessionId 的辅助调用（purpose=compaction/session-title）→ 一次性会话不复用不绑定（且默认拒绝——compaction 走 antigravity 无意义，返回明确错误提示换 provider；可配置放行）。

### 5.5 auth.ts 状态机

`unknown → probing → pending-auth(url) → code-submitted → ok | failed`；状态经 ctx.remote 暴露给 client；URL 含 `accounts.google.com` 特征校验；code 写入后 60s 等待；全程不落盘 code/URL 到日志（doctor 导出脱敏）。

### 5.6 client plugin（P1）

- `settings.plugin.item` 卡片：状态行（版本/登录/默认模型/模式）、热改下拉（mode/effort/默认模型）、auth 按钮。
- auth 面板（卡片内展开）：URL 链接 + 二维码图 + code 输入框 + 等待动画。
- `sidebar.footer.action`：状态灯（绿=ok 黄=pending-auth 红=error 灰=dormant）。

### 5.7 MCP 反向桥（P2 占位）

DSH 侧起 127.0.0.1 Streamable HTTP MCP server（`@modelcontextprotocol/sdk`，运行时依赖 +1），`tools/list` 暴露 `ctx.tools` 注册表（过滤 agy_ask 自身防递归 + 危险工具黑名单），`tools/call` 直调 `ctx.tools` 执行管线（享受 DSH 审批/沙箱策略——**比 pi 桥打补丁更强**：审批策略天然生效）；`--add-dir <tmpdir>/`.agents/mcp_config.json` 注入。x-bridge-token + body cap 照抄 pi 桥安全设计。

---

## 6. 命令体系

| 命令 | 行为 | 层级 |
|---|---|---|
| `/agy status` | agy 路径/版本/登录态/当前模式/effort/绑定会话数/最近错误 | P0 |
| `/agy auth` | 启动 GUI 登录流（client 面板）；CLI 环境打印 URL 与指引 | P0 |
| `/agy models` | 刷新并显示模型目录（标注缓存/回退来源） | P0 |
| `/agy mode <skip\|plan\|accept-edits>` | 权限三态热改（下轮生效，持久化 settings） | P0 |
| `/agy effort <low\|medium\|high\|default>` | 默认 effort 档热改 | P1 |
| `/agy clear` | 清当前 DSH 会话的 agy 绑定（下次新开 agy 会话） | P0 |
| `/agy doctor` | 生成 markdown 诊断文件并返回路径 | P0 |
| `/agy update` | 检查并提示 `agy update`（不代跑，展示命令） | P1 |

命令 handler 直接执行不经模型（`CommandResult{kind:'success',text}`）；全部命令输出为可在 GUI 渲染的 markdown 文本。

---

## 7. 配置体系

### 7.1 三层合并：env（DSH_AGY_*）> settings（`agy-bridge:` 命名空间，热加载）> cordis.patch.yml config > 默认

### 7.2 配置项（Schemastery schema）

| 键 | 默认 | 说明 |
|---|---|---|
| enabled | true | 总开关（false=dormant） |
| agyBin | '' | 空=PATH 解析；否则绝对路径 |
| extraArgs | [] | 追加到 spawn 尾部（escape hatch） |
| permissionMode | 'skip' | skip / plan / accept-edits（ADR-8） |
| defaultModel | '' | 空=agy 默认（settings.json 的 model） |
| defaultEffort | '' | 空=模型默认档 |
| timeoutMs | 600000 | watchdog |
| maxConcurrent | 3 | 跨会话并发上限 |
| contextWindowDefault | 1048576 | 未披露模型的回退 |
| maxTokensDefault | 65536 | 同上 |
| forwardSystemPrompt | false | ADR-7 |
| digestMaxChars | 8000 | 历史折叠上限 |
| contextTransferMaxChars | 660000 | 首次接触重播的字符预算（能力上限） |
| contextTransferMaxBytes | 150000 | 内联 digest 的字节预算（必须 < agy 的 192,000 B 单条上限） |
| contextTransferFileAboveBytes | 55000 | 超过该字节数改走文件引用，不再内联 |
| contextTransferFileMaxBytes | 2000000 | 文件模式 digest 的字节上限（不受单条消息限制） |
| modelsCacheTtlMs | 300000 | 目录缓存 |
| fallbackModels | [内置表] | 发现失败回退目录 |
| tools.askTool | false | P1 agy_ask 开关 |

### 7.3 cordis.patch.yml（成品）

```yaml
# dsh-agy-link bundle patch — 插入 antigravity provider 插件行。
# 安装：dsh plugin --profile web add dsh-agy-link
- insert:
    - id: agy-bridge
      name: 'dsh-agy-link'
      config:
        enabled: !!js "process.env.DSH_AGY_ENABLED ?? 'true'"
        agyBin: !!js "process.env.DSH_AGY_BIN ?? ''"
        permissionMode: !!js "process.env.DSH_AGY_MODE ?? 'skip'"
        defaultModel: !!js "process.env.DSH_AGY_DEFAULT_MODEL ?? ''"
        defaultEffort: !!js "process.env.DSH_AGY_DEFAULT_EFFORT ?? ''"
```

---

## 8. 打包与依赖

### 8.1 package.json 骨架

```json
{
  "name": "dsh-agy-link",
  "version": "0.1.0",
  "description": "Google Antigravity (agy CLI) models for DeepSeek Harness — stream Gemini/Claude/GPT-OSS subscriptions into DSH with thinking, tool activity, usage and GUI OAuth login.",
  "type": "module",
  "license": "MIT",
  "keywords": ["dsh-plugin", "dsh", "deepseek-harness", "antigravity", "agy", "gemini"],
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./client": "./dist/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dependencies": { "qrcode": "^1.5.4" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-commands": "*", "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-storage-domain": "*", "@deepseek-ai/dsh-agent-tools": "*",
    "react": "^18.0.0"
  },
  "peerDependenciesMeta": { "react": { "optional": true } },
  "devDependencies": { /* @deepseek-ai/* 0.1.0-rc.6 对照组 + tsdown + typescript + @types/node */ },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": ["slots"], "platform": "web" }
  },
  "files": ["dist", "cordis.patch.yml", "README.md", "README.zh.md", "LICENSE", "CHANGELOG.md"],
  "scripts": {
    "build": "tsdown",
    "check": "tsc --noEmit",
    "test": "node --experimental-strip-types --test \"test/**/*.test.ts\"",
    "dev:link": "node scripts/dev-link.mjs",
    "prepack": "npm run build"
  },
  "engines": { "node": ">=24.0.0" }
}
```

依赖纪律：运行时依赖仅 `qrcode`（auth 二维码）；MCP SDK 待 P2 再加；DSH 包全部 peer（宿主提供）；零 native 依赖（node:child_process 即够，无需 node:sqlite——ADR-1 的红利）。

---

## 9. 可靠性矩阵（故障模式 → 对策）

| 故障 | 对策 | 来源 |
|---|---|---|
| agy 未安装 / 不在 PATH | dormant + 设置卡/命令给出官方安装命令 | 易用性原则 |
| agy <1.1.8（无 stream-json） | 版本探针报 `AGY_VERSION_UNSUPPORTED` + `agy update` 指引 | ADR-1 |
| OAuth 过期（最常见） | AUTH 错误 + pending-auth 状态 + GUI 一键重登 | 本机实测（token 8/18 过期） |
| 登录探测进程挂起 | 探测 spawn 自带 90s 超时杀树 | runner |
| NDJSON 撕裂/半行 | 行缓冲 + 退出后 flush；连续 5 行坏行才报错 | parser |
| agy 升级加字段/事件 | 未知字段忽略 + debug；环形日志可诊断 | pi 桥前向兼容 |
| conversation_id 缺失 | 快照差分兜底；0 新库→不绑定仍出结果；多库→最新+debug | pi 桥 discovery |
| 同会话并发请求 | per-session promise 链串行 | ADR-12 |
| 进程僵死 | watchdog 杀树 + `PROCESS_EXIT`/ `TIMEOUT` 归因 | runner |
| 用户 abort | signal → 杀组 → aborted finish（DSH GUI 停止按钮即时） | mapper |
| 多宿主并发（web+headless） | storage.domain 天然并发安全；JSON 降级路径 tmp+rename 原子写 | ADR-4 |
| compaction/title 走到本 provider | 默认拒绝并提示（辅助调用应走 API 型 provider）；可配置放行 | §5.4 |
| spawn 目录无权限/trustedWorkspaces | agy 首跑新 workspace 会写 trust 记录；错误透传 + 文档 FAQ（agy settings.json trustedWorkspaces） | 本机 settings.json 实测 |

---

## 10. 安全设计

1. **不碰凭据**：不读/写/复制 `antigravity-oauth-token`；登录由官方 agy 二进制自身完成；插件只做 URL 展示与 code 传递（code 不落日志）。
2. **ToS 立场**（README 原样传承 pi 桥论述）：spawn 官方未修改二进制，OAuth 由 agy 自己完成，从 Google 视角与终端直跑无异；不做 token 复用/Hermes 类操作；附 [ToS](https://antigravity.google/terms) 第 6 条引用与"风险低但非零"结论。
3. **权限警告**：`skip` 模式（默认）= agy 可无审批执行命令（上游非交互硬约束，issue #318）；README/设置卡/首次使用 notice 三处红字；`plan` 模式给只读用户。
4. **诊断脱敏**：doctor 导出对 URL 参数、code、token 形状做掩码。
5. **本地面**：无监听端口（v1 无 MCP 桥）；P2 的 MCP server 仅 127.0.0.1 + token + body cap。
6. **子进程环境**：agy 继承宿主 env（DSH_* 对 agy 无意义无害）；不向 agy 注入任何密钥。

---

## 11. 测试策略（TDD first）

- 框架：`node:test` + `tsc --noEmit`（零额外 dev 框架，沿袭 lark-link）；`npm run dev:link` 链接本地 DSH checkout 提供类型。
- **夹具驱动**：登录恢复后第一时间录制真实 stream-json 会话（文本/思考/工具/多轮/错误各一）存 `test/fixtures/*.ndjson`；此后全部测试离线回放，不打真后端。
- `fake-agy.mjs`：测试替身按脚本吐事件序列 + 模拟挂起/非零退出/半行输出，覆盖 runner 边界。
- 覆盖矩阵：parser（撕裂/未知/乱序）、mapper（§3.3 全表 + usage<finish 顺序断言）、models 折叠、sessions 绑定/恢复/digest、adapter 端到端、auth 状态机、abort/timeout、命令 handler。
- 手工验收矩阵：真机 agy 登录 → GUI 全流程（M1-M6 逐条）。

---

## 12. 仓库与发布工程（沿袭 dsh-lark-link 实战模板）

### 12.1 Git workflow

- `main` 受保护（PR only，CI 绿才可并）；feature 分支 `feat/*` `fix/*` `docs/*`。
- Conventional Commits（`feat:` `fix:` `docs:` `chore(release):`），每次发版 `chore(release): x.y.z` 提交 + tag `vx.y.z` + GitHub Release（notes 取 CHANGELOG 当节）。
- CHANGELOG.md 手动维护，格式沿袭 lark-link（每版本一节，Fix/New/Docs + 根因说明）。

### 12.2 CI（`.github/workflows/ci.yml`，照抄 lark-link 骨架）

push/PR → node 24 → `npm ci` → `npm run check` → `npm test` → `npm run build` → `npm pack --dry-run`（files 白名单校验）。

### 12.3 Publish（`.github/workflows/publish.yml`）

`on: release: published` → node 24 + npm registry → ci/check/test/build → `npm publish --access public`（`NODE_AUTH_TOKEN`，environment: npm）。**先发 npm 再提交市场 PR**（dshmarket 安装走 npm tarball 最快且免 allowBuilds）。

### 12.4 Issue / PR 模板

- `.github/ISSUE_TEMPLATE/bug.md`：现象 / 复现步骤 /` **`/agy doctor` 诊断文件内容**（置顶引导）/ agy 版本 / DSH 版本 / OS。
- `.github/ISSUE_TEMPLATE/feature.md`：动机 / 期望行为 / 是否愿意提 PR。
- `.github/PULL_REQUEST_TEMPLATE.md`：改动摘要 / 关联 issue / 自测清单（check+test+build / 真机手工项 / CHANGELOG 已更新）。

### 12.5 README（双语，推广主战场）

- 首屏：mascot 图（**绝对 URL**，JSDelivr CDN——lark-link 0.3.2 教训：npm 不解析相对路径）+ badges（npm/CI/license/node）+ 一句话价值。
- 中文版按 lark-link 风格：为什么 / 能力表 / 快速开始（3 条命令）/ 命令表 / 配置表 / 权限与 ToS 红字 / FAQ（登录过期、未安装、慢、配额）/ 诊断指引。
- 安装命令显式带 `--profile web`；对比表（vs 直接用 agy / vs pi 桥）。
- topics：`dsh-plugin` `antigravity` `gemini` `deepseek-harness` `agy`（`dsh-plugin` 为市场硬性要求）。

### 12.6 市场上架（awesome-dsh-plugin PR）

```yaml
# data/plugins/<owner>__dsh-agy-link.yml
url: https://github.com/<owner>/dsh-agy-link
name: <owner>/dsh-agy-link
category: model
description:
  en: Use Google Antigravity (agy CLI) Gemini/Claude/GPT-OSS models in DeepSeek Harness, with streaming output, thinking, tool activity, token usage and in-GUI Google OAuth login.
  zh: 在 DeepSeek Harness 中使用 Google Antigravity（agy CLI）的 Gemini/Claude/GPT-OSS 订阅模型：流式输出、思考过程、工具活动、用量统计与 GUI 内谷歌登录。
```
+ `node scripts/generate-readme.mjs` 产物一并提交。**提交前置清单**：npm 已发布 ✓ / `dsh.bundle` 已声明 ✓ / 仓库 ≥1 天 + ≥10 commits（开发期攒够再提）/ topic `dsh-plugin` ✓ / 本机 `dshmarket` 能搜到并一键安装（用户本地已装 market，直接当验收环境）。合并后 1–2 天进市场。

---

## 13. 里程碑（每步 TDD 全绿才推进）

| M | 内容 | 验收 |
|---|---|---|
| M1 骨架+契约 | 仓库脚手架 + dev-link + fake-agy + parser/mapper 离线全绿 + dormant 探测 | `npm test` 绿；无 agy 机器装插件不报错 |
| M2 provider 打通 | adapter + runner + sessions；真机登录后 `/model` 选 antigravity 出流式回复 | GUI 流式显示；多轮续聊；abort 即停 |
| M3 全体验 | thinking 流式 + 工具活动块 + usage 入账 + 错误码全表 + watchdog | 思考折叠可见；token meter 显示四项；拔网线/杀进程归因正确 |
| M4 认证+命令 | /agy status/auth/models/mode/clear/doctor + GUI auth 面板（URL+二维码+code） | 过期后 GUI 内 60s 重登成功；doctor 文件可直接贴 issue |
| M5 设置卡+热改 | client 设置卡（状态/热改）+ settings 命名空间 + sidebar 状态灯 | GUI 改 mode/effort 下轮生效 |
| M6 发布闭环 | README 双语 + CI/publish 工作流 + issue/PR 模板 + npm 发布 + awesome PR + 本机 market 验收 | 市场可搜可装；release→npm 自动发布 |
| M7（P1 追加） | agy_ask 工具 + diff 渲染 + /agy effort/update | 模型可委托 agy 一次性任务 |

---

## 14. Success Criteria

1. `dsh plugin --profile web add dsh-agy-link && dsh web` 后，设置→模型出现 antigravity 分组（含回退目录至少 3 模型），`/agy auth` GUI 内完成 Google 登录。
2. 选 antigravity 模型对话：**文本流式逐字、思考过程折叠块、agy 工具活动行（名称+参数摘要+输出摘要）、用量四字段入 token meter**；点停止即时中断且无僵尸 agy 进程。
3. 同一会话第二轮正确续用 agy conversation（agy 侧不重放历史）；重启 DSH 后继续；`/agy clear` 后新开。
4. OAuth 过期后的下一次请求返回明确 AUTH 错误 + 状态灯变黄 + GUI 一键重登恢复。
5. 未装 agy / agy 过旧两种环境下插件 dormant 或给出可执行升级指引，无报错刷屏。
6. `npm test` 全绿（夹具回放，不打真后端）；`tsc --noEmit` 干净；`npm pack` 产物最小。
7. 发布链路验收：GitHub Release → npm 自动发布；awesome PR 合并后本机 dshmarket 搜索"dsh-agy-link"一键安装成功。
8. pi 桥功能对照表（§4）P0 行全数落地，文档 KNOWN-GAPS 列明 P1/P2 缺口。

---

## 15. Boundaries

**Always**：改任何行为先改本 spec 再实现；每个里程碑 TDD 全绿推进；错误路径必须给"下一步做什么"；新依赖进 runtime 前先问。
**Ask first**：MCP 反向桥（P2）与任何 MCP SDK 依赖；修改用户 agy 全局配置；自动写用户 `agent-default-model`；发 npm / 提市场 PR / 打 tag。
**Never**：读取/复制/移动 agy OAuth token 文件；在 agy 之上再套 token 复用（ToS 红线）；提交任何密钥/完整 URL 到日志与诊断包；绕过 DSH 的 `ctx.llm` 私改模型注册表。

---

## 16. 开放问题（需实测/用户决策）

| # | 问题 | 当前假设 | 解决路径 |
|---|---|---|---|
| OQ-1 | stream-json `init` 事件是否携带 conversation_id（登录后未实测） | result.conversation_id 可用；否则快照差分兜底 | M2 首日录制真实会话确认，spec 随改 |
| OQ-2 | step_update payload 是增量 delta 还是全量快照 | parser 兼容两种（全量→后缀差分） | 同上 |
| OQ-3 | ~~npm scope~~ **已决策（2026-08-18）**：裸名 `dsh-agy-link`，npm 已核实可注册 | — | 已关闭 |
| OQ-4 | GitHub owner/仓库名 | 待用户给定 | 建 repo 时定 |
| OQ-5 | `agy models --output-format json` 的确切 JSON 形状（字段名） | 兼容 {slug,label} 与 [{name,display}] 两形 | M2 实测 |
| OQ-6 | settings 命名空间名（`agy-bridge`）与模型设置页 dormant 展示深度 | `agy-bridge` + configurableProviders 最小集成 | M5 依 GUI 实况调 |
| OQ-7 | **辅助调用**（auxiliary calls）= DSH 在后台自动发起的两类非对话 LLM 请求：① **compaction 压缩**——会话历史过长时把旧上下文总结成摘要（`purpose:'compaction'`）；② **会话标题**——用模型根据首条消息给会话起名（`purpose:'session-title'`）。问题：若用户唯一 provider 是 antigravity，这两类后台调用也会 spawn agy 子进程（慢、烧订阅配额、且 agy 的 agent 形态不适合做摘要任务）——默认拒绝是否太严？ | 默认拒绝 + 明确报错提示"为 compaction/标题配置一个 API 型 provider"；config `allowAuxiliary: true` 放行（放行时标题用 defaultModel、compaction 用短超时一次性会话） | 用户决策 |

---

## 附 A：本机环境快照（2026-08-18）

- agy 1.1.13（`/home/zand/.local/bin/agy`，ELF 单文件 206MB）；token 已过期（8/18 00:02 最后刷新）；settings.json：model "Gemini 3.1 Pro (High)"。
- DSH 0.1.0-rc.6；`~/.dsh` web profile：bundles = dsh-base + dsh-web-app + dsh-lark-link + dsh-at-file + **dshmarket** + dsh-fetch-timeouts。
- 参考仓库本地可读：`/home/zand/proj/dsh-lark-link`（含 .spec、CI/publish workflows、issue 模板、推广文案）、`/home/zand/proj/dsh-fetch-timeouts`（最小 bundle 样板）。
- 调研报告：`pi-antigravity-bridge-research-report.md`（本目录）。

## 附 B：调研来源索引

- agy CLI：[官方仓库](https://github.com/google-antigravity/antigravity-cli) · [安装](https://antigravity.google/docs/cli/install) · [Headless](https://www.antigravity.google/docs/cli/headless) · [ToS](https://antigravity.google/terms) · [issue #318](https://github.com/google-antigravity/antigravity-cli/issues/318) · [issue #36](https://github.com/google-antigravity/antigravity-cli/issues/36)
- pi 桥：[GitHub](https://github.com/EstebanForge/pi-antigravity-bridge) · [npm](https://www.npmjs.com/package/@estebanforge/pi-antigravity-bridge) · [pi.dev](https://pi.dev/packages/@estebanforge/pi-antigravity-bridge) · [pi-ask-antigravity](https://github.com/EstebanForge/pi-ask-antigravity)
- DSH：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · [docs/user/guide/providers](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/docs/user/guide/providers.zh.md) · [docs/cookbook/adding-an-llm-adapter](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/docs/cookbook/adding-an-llm-adapter.zh.md) · [docs/user/develop/basic/publish](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/docs/user/develop/basic/publish.zh.md) · [dsh-llm README](https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/packages/llm/llm/README.md)
- 市场：[dshmarket](https://github.com/dsh-market/dsh-market) · [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) · [topic dsh-plugin](https://github.com/topics/dsh-plugin)
- 竞品：[dsh-codex-auth](https://github.com/nicobailon/dsh-codex-auth) · dsh-codex-connect · dsh-everything-oauth · dsh-github-login · dsh-claude-cli · dsh-llm-ollama（registry snapshot 实读）
- 本地一手证据：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm{,-pi-ai}/`（类型与 README 原文）、`~/.gemini/antigravity-cli/`（auth/settings 实况）、`/home/zand/proj/dsh-lark-link/`（工程模板）、dshmarket registry-snapshot.json（839 插件实况）
