<h1 align="center">🛰️ dsh-agy-link</h1>

<p align="center">
  <b>DeepSeek Harness × Google Antigravity</b> — 用官方 agy CLI 把 Antigravity 模型接进 DSH / bring Google Antigravity models into DSH via the official agy CLI
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-agy-link"><img src="https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <a href="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml"><img src="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
</p>

<p align="center">
  <b>🌐 Language / 语言：</b>
  <a href="#中文">中文</a> ·
  <a href="#english">English</a>
</p>

---

# 中文

> 全网统一昵称：**小斯syzs** · B站 [@小斯syzs](https://space.bilibili.com/390211071) · 抖音 · 小红书 · 快手（全网同名）

把 **Google Antigravity 模型接入 DeepSeek Harness（DSH）** —— 由官方
`agy` CLI 驱动，完整支持对话输出、思考（thinking）、工具活动与 token
用量，全部走你的 Antigravity 订阅。

**它是怎么工作的**：在 `/model` 选择器里挑一个 Antigravity 模型，之后每一轮对话，插件都会在你的工作区启动一个短生命周期的官方 `agy` 进程（`agy -p --output-format stream-json`），解析它输出的 NDJSON 事件流，把文本、思考、工具活动逐块映射回 DSH。多轮对话通过把 DSH 会话绑定到 agy 原生会话（`--conversation`）实现——agy 自己保存历史，每轮只发最新消息。**插件只启动官方未修改的 agy 二进制**：不逆向它的数据库、不解码 protobuf、不碰你的 OAuth token。

## ✨ 你能得到什么

| 能力 | 说明 |
| ---- | ---- |
| 🔌 **模型路由** | 在 DSH 模型配置里注册 `antigravity` 提供方，`/model` 选择器直接挑任意 Antigravity 模型（Gemini / Claude / GPT-OSS） |
| 🌊 **完整流式** | 文本、思考、agy 工具活动（注记为 reasoning 块）全部映射到 DSH 原生流协议 |
| 🔗 **会话连续** | 每个 DSH 会话绑定原生 agy 会话（`--conversation`），多轮上下文由 agy 历史承载，不重发全量 |
| 📊 **token 用量** | 输入/输出/思考/缓存 token 全部进入 DSH 用量统计 |
| ⚙️ **设置页状态** | DSH 设置 → Antigravity 页面显示 agy 连接/登录/工作区/绑定数/最近运行状态 |
| 🔐 **GUI 内 Google 登录** | `/agy auth` 打印授权 URL；设置 → Antigravity 页面提供二维码 + 授权码粘贴框 |
| 🤝 **`agy_ask` 工具** | 任何 DSH 模型都可以把一次性任务委托给 Antigravity 模型（AskAntigravity 模式） |
| ⌨️ **`/agy` 命令族** | `status` / `auth` / `auth-code` / `models` / `mode` / `effort` / `workspace` / `clear` / `doctor` / `help` |
| 🖼 **图片多模态（v0.2）** | 图片落盘到本地媒体目录（TTL 清理），prompt 以绝对路径引用 + `--add-dir` 授权，agy 用自己的工具看图 |
| 📎 **文件内联 + 结构化输出（v0.2）** | `agy_ask` 新增 `readPaths`（文本文件内联）与 `schema`（`--json-schema` 强约束答案） |
| 🌉 **MCP 反向桥（v0.2 实验）** | `mcpBridge: true` 开启后 agy 可直接调 DSH 侧工具（回环 + token 守卫端点 + 零依赖 stdio MCP 服务器，`.mcp.json` 合并写入/禁用还原） |
| 😴 **休眠安全** | 没装 agy？没登录？插件照常加载并告诉你怎么修 |

## 📋 前置要求

装插件**之前**，先把这三样备齐（缺一样插件也能装，但会休眠并提示你补什么）：

| 前置 | 怎么装 / 怎么验证 |
| --- | --- |
| **1. DeepSeek Harness（DSH）** | 你正在用的就是；`dsh --version` 可验证 |
| **2. Node.js ≥ 24** | DSH 本身就要求 Node 24+，通常已满足；`node --version` 验证 |
| **3. Google Antigravity 的 `agy` CLI** | 按 [Google 官方安装指南](https://antigravity.google/docs/cli/install)装（Linux / macOS / Windows 都有），然后**在终端跑一次 `agy`**，按提示完成 Google 登录。`agy --version` 能出版本号、`agy models` 能列模型就算就绪 |

> **什么是 agy？** Google Antigravity 的官方命令行智能体（类似 Claude Code / Gemini CLI）。本插件不替代它，而是驱动它——所以你需要一份有效的 **Antigravity 订阅**（免费额度也行）。
>
> 没登录也能先装：插件自带的 `/agy auth` 会给你授权 URL + 二维码，在 GUI 里完成登录。

## 🚀 快速开始

```bash
# 0. 确认前置要求满足（见上一节）：agy --version 有输出

# 1. 安装插件（npm 官方包，预构建产物，无需构建许可）：
dsh plugin --profile web add dsh-agy-link
#   升级（每次新版本发布后执行；镜像标签可能滞后，指定官方源最稳）：
#   dsh plugin --profile web add dsh-agy-link@latest --registry https://registry.npmjs.org

# 2. 重启 DSH Web GUI，输入框执行：
#   /agy status     ← 应显示 agy 版本号；没装好会告诉你缺什么

# 3. 登录（一次性；终端里已经跑过 agy 登录过的可跳过）：
#   /agy auth               ← 打开授权 URL，批准并复制授权码
#   /agy auth-code <授权码>  ← 或直接用设置 → Antigravity 页面的二维码 + 粘贴框

# 4. /model 选择器里选 antigravity 模型，开聊
```

> 插件绝不读取/复制/移动 `~/.gemini/antigravity-cli/antigravity-oauth-token`；登录完全通过官方 CLI 自己的流程完成。

> 🖥 **跨平台**：Linux / macOS / Windows 均受支持——bin 探测按平台查找 `agy`/`agy.exe`（PATH、`~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`%LOCALAPPDATA%\Programs`，npm `.cmd` shim 自动经 cmd.exe 安全引号包裹启动）；中断/超时杀树在 Windows 走 `taskkill /T /F`；CRLF 输出统一剥离；媒体目录与 MCP 桥路径全部 `fileURLToPath`/`join` 构造。

## ⚙️ 配置

配置在 `agy-link` 插件条目里（`/plugin` 或 profile patch 层编辑），环境变量优先：

| 键 | 环境变量 | 默认值 | 含义 |
| --- | --- | --- | --- |
| enabled | `DSH_AGY_ENABLED` | `true` | 总开关 |
| agyBin | `DSH_AGY_BIN` | 自动 | 显式 agy 路径 |
| permissionMode | `DSH_AGY_MODE` | `skip` | `skip` / `plan` / `accept-edits`（见下） |
| defaultModel | `DSH_AGY_DEFAULT_MODEL` | `(agy 默认)` | 模型 slug |
| defaultEffort | `DSH_AGY_DEFAULT_EFFORT` | `(模型默认)` | `low` / `medium` / `high` |
| timeoutMs | `DSH_AGY_TIMEOUT_MS` | `600000` | 单轮看门狗 |
| extraArgs | `DSH_AGY_EXTRA_ARGS` | — | 附加 agy 参数（空格分隔） |
| workspaceRoot | `DSH_AGY_WORKSPACE_ROOT` | 会话 cwd | agy 工作区；显式配置优先，未设置时自动使用 DSH 会话的 cwd |

### ⚠️ 权限模式——必读

agy 有**自己的**工具循环，会自己做文件编辑和 shell 执行。桥接层映射为三种模式：

- **plan** —— 只读，体验桥接的安全默认。
- **accept-edits** —— agy 可以不经询问改文件。
- **skip** —— `--dangerously-skip-permissions`：agy **所有**工具免审批。非交互 DSH 轮次需要它（或 plan），因为 agy 的权限提示会卡死 print 模式；但这意味着真实的无人值守 写/执行 权限。设置面板里这个按钮是红色的。

DSH 侧的工具与权限不受影响——这里只约束 agy 子进程在自己工作区能做什么。

## 🧩 工作原理

一次 DSH 模型调用 = 一个短生命周期 `agy -p --output-format stream-json` 进程。NDJSON 事件流被解析、归一化并映射为 DSH StreamChunk：文本 → text 块，工具活动 → 注记 reasoning 块（含失败注记），结果信封 → usage + finish。agy 的 print 模式**不输出思考文本**（只有 `thinking_tokens` 计数），因此每个思考轮次以 `[agy thinking turn · N thinking tokens]` 注记呈现，思考 token 也进入用量统计。会话 id 优先取自流本身，conversations 目录快照对比兜底。**不逆向数据库、不解码 protobuf、不碰 token 文件**——只启动官方未修改的 agy 二进制。

## 📋 它做不到什么（诚实清单）

- **图片不是真多模态**——agy 的 print 模式没有图片入参，插件走的是“落盘 + 路径引用”方案（v0.2 起）：图片写进本地媒体目录，prompt 里给绝对路径，agy 用它自己的看图工具查看。能用，但和原生多模态不同。
- **agy 的文件编辑不经过 DSH 审批**——它直接落盘，DSH 的 inline diff 审查不介入（想要只读就 `/agy mode plan`）。
- **DSH 工具默认不暴露给 agy**——agy 跑自己的封闭工具循环；v0.2 的 MCP 反向桥（实验性，`mcpBridge: true`）可以打通，但有递归/扇出成本。
- **结构化输出只在 `agy_ask` 里**——`schema` 参数走 `--json-schema`；DSH 原生工具调用生成还没接（上游没有对应字段）。

完整清单见 [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md)。

## ⚠️ 免责与风险提示

本插件只启动**官方未修改**的 `agy` 二进制并消费其公开 print 输出，不解码内部数据库、不触碰 OAuth token。自动化订阅 CLI 仍可能与提供方服务条款冲突（Google Antigravity ToS §6 语境）；风险自负，被要求停止时请停止。

## 许可证

MIT

---

# English

> Known online as **小斯syzs** — Bilibili [@小斯syzs](https://space.bilibili.com/390211071) · Douyin · Xiaohongshu · Kuaishou (same handle on every platform).

Bring **Google Antigravity models into DeepSeek Harness (DSH)** — chat, thinking, tool activity, and token usage from your Antigravity subscription, driven by the official `agy` CLI.

**How it works**: pick an Antigravity model in the `/model` picker; for every turn the plugin spawns a short-lived, official `agy` process in your workspace (`agy -p --output-format stream-json`), parses its NDJSON event stream, and maps text, thinking, and tool activity back into DSH chunk by chunk. Multi-turn rides a binding between the DSH session and a native agy conversation (`--conversation`) — agy keeps its own history, so only the latest message is sent each turn. **The plugin only ever spawns the official, unmodified agy binary**: no database reverse-engineering, no protobuf decoding, no touching your OAuth token.

## ✨ What you get

| Capability | Description |
| ---- | ---- |
| 🔌 **A model route, not a proxy** | Registers the `antigravity` provider in DSH's model config; pick any Antigravity model (Gemini / Claude / GPT-OSS) from the `/model` picker |
| 🌊 **Full streaming** | Text, thinking (reasoning), and token usage mapped onto DSH's native chunk protocol |
| 🃏 **Native tool cards (v0.3)** | agy's tool activity renders with DSH's own tool-card UI — terminal cards for `run_command`, inline diffs for file writes — via the internal `agy_tool` mirror riding the real agent loop |
| 🔗 **Session continuity** | Each DSH session binds to a native agy conversation (`--conversation`); multi-turn context rides agy history instead of re-sending everything |
| 📊 **Token usage** | Input/output/thinking/cache tokens surface in DSH usage accounting |
| ⚙️ **Settings status** | DSH Settings → Antigravity page shows agy connection/login/workspace/bindings/last-run state |
| 🔐 **In-GUI Google login** | `/agy auth` prints the consent URL; Settings → Antigravity adds a QR code and a paste box for the authorization code |
| 🤝 **`agy_ask` tool** | Let any DSH model delegate a one-shot task to an Antigravity model (the AskAntigravity pattern) |
| ⌨️ **`/agy` commands** | `status`, `auth`, `auth-code`, `models`, `mode`, `effort`, `workspace`, `clear`, `doctor`, `help` |
| 😴 **Dormant-safe** | No agy binary? Not signed in? The plugin loads anyway and tells you what to fix |
| 🖼 **Image multimodal (v0.2)** | image attachments staged to a TTL-swept local dir, referenced by absolute path with `--add-dir`; agy views them with its own tools |
| 📎 **File inlining + structured output (v0.2)** | `agy_ask` gains `readPaths` (inline text files) and `schema` (enforced via `--json-schema`) |
| 🌉 **MCP reverse bridge (v0.2, experimental)** | with `mcpBridge: true`, agy calls DSH-side tools directly (loopback token-guarded endpoint + zero-dep stdio MCP server merged into `.mcp.json`, restored on disable) |

## 📋 Prerequisites

Before installing, have these three ready (the plugin installs fine without them, but stays dormant and tells you what to fix):

| Requirement | How to install / verify |
| --- | --- |
| **1. DeepSeek Harness (DSH)** | You are using it; `dsh --version` verifies |
| **2. Node.js ≥ 24** | DSH already requires Node 24+; `node --version` verifies |
| **3. Google Antigravity's `agy` CLI** | Follow [Google's official install guide](https://antigravity.google/docs/cli/install) (Linux / macOS / Windows), then **run `agy` once in a terminal** and complete the Google login. `agy --version` printing a version and `agy models` listing models means you are ready |

> **What is agy?** Google Antigravity's official command-line agent (think Claude Code / Gemini CLI). This plugin does not replace it — it drives it, so you need an active **Antigravity subscription** (the free tier works).
>
> Not logged in yet? Install anyway: the built-in `/agy auth` gives you a consent URL + QR code to finish login inside the GUI.

## 🚀 Quick start

```bash
# 0. Confirm the prerequisites (previous section): agy --version prints something

# 1. Install (npm, prebuilt — no build approval needed):
dsh plugin --profile web add dsh-agy-link
#   Upgrade (run after every release; mirror tags can lag, so pin the official registry):
#   dsh plugin --profile web add dsh-agy-link@latest --registry https://registry.npmjs.org

# 2. Restart the DSH Web GUI, then in the composer:
#   /agy status     <- should show the agy version; tells you what is missing otherwise

# 3. Login (one time; skip if you already ran agy in a terminal):
#   /agy auth               <- open the consent URL, approve, copy the code
#   /agy auth-code <code>   <- or use Settings -> Antigravity (QR + paste box)

# 4. Pick an antigravity model in /model and chat
```

> The plugin never reads, copies, or moves `~/.gemini/antigravity-cli/antigravity-oauth-token`; login is driven entirely through the official CLI's own flow.

> 🖥 **Cross-platform**: Linux / macOS / Windows — platform-aware binary discovery (`agy` / `agy.exe` across PATH, `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `%LOCALAPPDATA%\Programs`; npm `.cmd` shims spawn through cmd.exe with safe quoting), tree-kill via `taskkill /T /F` on Windows, CRLF output normalized, media and bridge paths built with `fileURLToPath`/`join`.

## ⚙️ Configuration

Config lives in the `agy-link` plugin entry (edit via `/plugin` or the profile patch layer). Environment variables override the file:

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| enabled | `DSH_AGY_ENABLED` | `true` | master switch |
| agyBin | `DSH_AGY_BIN` | auto | explicit agy binary path |
| permissionMode | `DSH_AGY_MODE` | `skip` | `skip` / `plan` / `accept-edits` (below) |
| defaultModel | `DSH_AGY_DEFAULT_MODEL` | `(agy default)` | model slug |
| defaultEffort | `DSH_AGY_DEFAULT_EFFORT` | `(model default)` | `low` / `medium` / `high` |
| timeoutMs | `DSH_AGY_TIMEOUT_MS` | `600000` | per-turn watchdog |
| extraArgs | `DSH_AGY_EXTRA_ARGS` | — | extra agy flags, space-separated |
| workspaceRoot | `DSH_AGY_WORKSPACE_ROOT` | session cwd | agy workspace; explicit config wins, otherwise the DSH session's cwd is used |

### ⚠️ Permission modes — read this

agy runs its **own** tool loop with its own file edits and shell commands. The bridge maps that to one of three modes:

- **plan** — read-only; the safe default for trying the bridge.
- **accept-edits** — agy may edit files without asking.
- **skip** — `--dangerously-skip-permissions`: agy runs **every** tool without approval. Non-interactive DSH turns need this (or plan) because agy permission prompts hang print mode, but it means real unattended write/exec access. The settings panel shows this button in red.

DSH-side tools and permissions are unaffected — this only governs what the spawned agy process may do in its workspace.

## 🧩 How it works

One DSH turn = one short-lived `agy -p --output-format stream-json` process. The NDJSON event stream is parsed, normalized, and recorded. Spans of that recording are mapped to DSH StreamChunks — thinking → reasoning blocks, text → text blocks, result envelope → usage + finish — and each **completed agy tool step cuts the span** with a `tool-calls` finish. The tool-call block addresses `run_code` — the only tool DSH's dispatch policy lets a model call directly — wrapping a generated one-line program that invokes the internal `agy_tool` mirror; the inner dispatch instantly replays the recorded output, writes real `tool/call` + `tool/result` session events, and re-calls the provider to continue the run. Tool activity therefore renders with DSH's **native tool-card UI** (terminal cards, diffs, read/search icons) instead of text annotations, and cards read agy's PascalCase arg keys (`CommandLine`, `AbsolutePath`, …). Conversation ids come from the stream itself, with a conversations-directory snapshot diff as fallback. **No reverse-engineered database scraping, no protobuf decoding, no token-file access** — only the official unmodified agy binary is spawned.

## 📋 What it cannot do (honest list)

- **Images are not true multimodal** — agy print mode has no image input flag; since v0.2 the bridge stages images to a local media directory and references them by absolute path, with agy viewing them via its own tools. Workable, but not native multimodality.
- **agy's file edits bypass DSH review** — they land directly on disk; DSH's inline diff review does not engage (`/agy mode plan` for read-only).
- **DSH tools are not exposed to agy by default** — agy runs its own closed tool loop; the v0.2 MCP reverse bridge (experimental, `mcpBridge: true`) can bridge that, at a recursion/fan-out cost.
- **Structured output only inside `agy_ask`** — the `schema` parameter rides `--json-schema`; DSH-native tool-call generation is not wired (no upstream field to map onto).

Full list in [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md).

## ⚠️ Disclaimer & risk note

This plugin spawns the **official, unmodified** `agy` binary and consumes its public print-mode output. It does not decode internal databases or touch OAuth tokens. Automating a subscription CLI may still conflict with the provider's terms of service (Google Antigravity ToS §6 context); use it at your own risk, and stop if asked to.

## License

MIT
