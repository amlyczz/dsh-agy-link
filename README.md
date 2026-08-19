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

---

# 中文

> 全网统一昵称：**小斯syzs** · B站 [@小斯syzs](https://space.bilibili.com/390211071) · 抖音 · 小红书 · 快手（全网同名）
>
> 💬 **小斯syzs 邀请你加入飞书群** —— [点此一键加入](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)

把 **Google Antigravity 模型接入 DeepSeek Harness（DSH）** —— 由官方
`agy` CLI 驱动，完整支持对话输出、思考（thinking）、工具活动与 token
用量，全部走你的 Antigravity 订阅。

## ✨ 你能得到什么

| 能力 | 说明 |
| ---- | ---- |
| 🔌 **模型路由** | 在 DSH 模型配置里注册 `antigravity` 提供方，`/model` 选择器直接挑任意 Antigravity 模型（Gemini / Claude / GPT-OSS） |
| 🌊 **完整流式** | 文本、思考、agy 工具活动（注记为 reasoning 块）全部映射到 DSH 原生流协议 |
| 🔗 **会话连续** | 每个 DSH 会话绑定原生 agy 会话（`--conversation`），多轮上下文由 agy 历史承载，不重发全量 |
| 📊 **token 用量** | 输入/输出/思考/缓存 token 全部进入 DSH 用量统计 |
| 🔐 **GUI 内 Google 登录** | `/agy auth` 打印授权 URL；侧栏面板提供二维码 + 授权码粘贴框 |
| 🤝 **`agy_ask` 工具** | 任何 DSH 模型都可以把一次性任务委托给 Antigravity 模型（AskAntigravity 模式） |
| ⌨️ **`/agy` 命令族** | `status` / `auth` / `auth-code` / `models` / `mode` / `effort` / `clear` / `doctor` / `help` |
| 😴 **休眠安全** | 没装 agy？没登录？插件照常加载并告诉你怎么修 |

## 🚀 快速开始

```bash
# 1. 安装（npm 官方包，预构建产物，无需构建许可）：
dsh plugin --profile web add dsh-agy-link
#   升级：
#   dsh plugin --profile web update dsh-agy-link --latest

# 2. 重启 DSH Web GUI，输入框执行：
#   /agy status     ← 确认 agy 已被检测到

# 3. 登录（一次性）：
#   /agy auth               ← 打开授权 URL，批准并复制授权码
#   /agy auth-code <授权码>  ← 或直接用侧栏面板的二维码 + 粘贴框

# 4. /model 选择器里选 antigravity 模型，开聊
```

> 插件绝不读取/复制/移动 `~/.gemini/antigravity-cli/antigravity-oauth-token`；登录完全通过官方 CLI 自己的流程完成。

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

### ⚠️ 权限模式——必读

agy 有**自己的**工具循环，会自己做文件编辑和 shell 执行。桥接层映射为三种模式：

- **plan** —— 只读，体验桥接的安全默认。
- **accept-edits** —— agy 可以不经询问改文件。
- **skip** —— `--dangerously-skip-permissions`：agy **所有**工具免审批。非交互 DSH 轮次需要它（或 plan），因为 agy 的权限提示会卡死 print 模式；但这意味着真实的无人值守 写/执行 权限。设置面板里这个按钮是红色的。

DSH 侧的工具与权限不受影响——这里只约束 agy 子进程在自己工作区能做什么。

## 🧩 工作原理

一次 DSH 模型调用 = 一个短生命周期 `agy -p --output-format stream-json` 进程。NDJSON 事件流被解析、归一化并映射为 DSH StreamChunk：思考 → reasoning 块，文本 → text 块，工具活动 → 注记 reasoning 块，结果信封 → usage + finish。会话 id 优先取自流本身，conversations 目录快照对比兜底。**不逆向数据库、不解码 protobuf、不碰 token 文件**——只启动官方未修改的 agy 二进制。

## 📋 已知差距

见 [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md)。要点：图片不转发（agy print 模式纯文本）；DSH 工具不暴露给 agy（MCP 反向桥接是后续工作）。

## ⚠️ 免责与风险提示

本插件只启动**官方未修改**的 `agy` 二进制并消费其公开 print 输出，不解码内部数据库、不触碰 OAuth token。自动化订阅 CLI 仍可能与提供方服务条款冲突（Google Antigravity ToS §6 语境）；风险自负，被要求停止时请停止。

## 许可证

MIT

---

# English

> Known online as **小斯syzs** — Bilibili [@小斯syzs](https://space.bilibili.com/390211071) · Douyin · Xiaohongshu · Kuaishou (same handle on every platform).
>
> 💬 **Join the Feishu community group** hosted by 小斯syzs — [one-click invite](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=553i2f4a-5cc8-487f-95d3-3c4095bec0d9)

Bring **Google Antigravity models into DeepSeek Harness (DSH)** — chat, thinking, tool activity, and token usage from your Antigravity subscription, driven by the official `agy` CLI.

## ✨ What you get

| Capability | Description |
| ---- | ---- |
| 🔌 **A model route, not a proxy** | Registers the `antigravity` provider in DSH's model config; pick any Antigravity model (Gemini / Claude / GPT-OSS) from the `/model` picker |
| 🌊 **Full streaming** | Text, thinking (reasoning), and agy tool activity (annotated reasoning blocks) mapped onto DSH's native chunk protocol |
| 🔗 **Session continuity** | Each DSH session binds to a native agy conversation (`--conversation`); multi-turn context rides agy history instead of re-sending everything |
| 📊 **Token usage** | Input/output/thinking/cache tokens surface in DSH usage accounting |
| 🔐 **In-GUI Google login** | `/agy auth` prints the consent URL; the sidebar panel adds a QR code and a paste box for the authorization code |
| 🤝 **`agy_ask` tool** | Let any DSH model delegate a one-shot task to an Antigravity model (the AskAntigravity pattern) |
| ⌨️ **`/agy` commands** | `status`, `auth`, `auth-code`, `models`, `mode`, `effort`, `clear`, `doctor`, `help` |
| 😴 **Dormant-safe** | No agy binary? Not signed in? The plugin loads anyway and tells you what to fix |

## 🚀 Quick start

```bash
# 1. Install (npm, prebuilt — no build approval needed):
dsh plugin --profile web add dsh-agy-link
#   Upgrade:
#   dsh plugin --profile web update dsh-agy-link --latest

# 2. Restart the DSH Web GUI, then in the composer:
#   /agy status     <- confirm agy was detected

# 3. Login (one time):
#   /agy auth               <- open the consent URL, approve, copy the code
#   /agy auth-code <code>   <- or use the sidebar panel (QR + paste box)

# 4. Pick an antigravity model in /model and chat
```

> The plugin never reads, copies, or moves `~/.gemini/antigravity-cli/antigravity-oauth-token`; login is driven entirely through the official CLI's own flow.

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

### ⚠️ Permission modes — read this

agy runs its **own** tool loop with its own file edits and shell commands. The bridge maps that to one of three modes:

- **plan** — read-only; the safe default for trying the bridge.
- **accept-edits** — agy may edit files without asking.
- **skip** — `--dangerously-skip-permissions`: agy runs **every** tool without approval. Non-interactive DSH turns need this (or plan) because agy permission prompts hang print mode, but it means real unattended write/exec access. The settings panel shows this button in red.

DSH-side tools and permissions are unaffected — this only governs what the spawned agy process may do in its workspace.

## 🧩 How it works

One DSH model call = one short-lived `agy -p --output-format stream-json` process. The NDJSON event stream is parsed, normalized, and mapped to DSH StreamChunks: thinking → reasoning blocks, text → text blocks, tool activity → annotated reasoning blocks, and the result envelope → usage + finish. Conversation ids come from the stream itself, with a conversations-directory snapshot diff as fallback. **No reverse-engineered database scraping, no protobuf decoding, no token-file access** — only the official unmodified agy binary is spawned.

## 📋 Known gaps

See [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md). Notably: images are not forwarded (agy print mode is text-only), and DSH tools are not exposed to agy (its MCP reverse bridge is future work).

## ⚠️ Disclaimer & risk note

This plugin spawns the **official, unmodified** `agy` binary and consumes its public print-mode output. It does not decode internal databases or touch OAuth tokens. Automating a subscription CLI may still conflict with the provider's terms of service (Google Antigravity ToS §6 context); use it at your own risk, and stop if asked to.

## License

MIT
