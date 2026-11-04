# dsh-agy-link

把 Google Antigravity 接入 DeepSeek Harness（DSH）。插件驱动官方未修改的 `agy` CLI，提供多账号池自动轮换、官方多 Bucket 配额监控、原生流式与工具卡片，以及 `/tsl` 大白话翻译。

[![npm](https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm)](https://www.npmjs.com/package/dsh-agy-link)
[![CI](https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg)](https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](./LICENSE)

[中文](#中文) · [English](#english) · [Português (Brasil)](./docs/README.pt-BR.md) · [Español](./docs/README.es.md) · [English (standalone)](./docs/README.en.md)

```bash
dsh plugin --profile web add dsh-agy-link
```

<p align="center">
  <img src="./docs/assets/console.png" alt="Antigravity 管理控制台：账号池、官方配额进度条与代理状态" width="760">
</p>

<p align="center">
  <img src="./docs/assets/model-picker.png" alt="DSH 模型选择器中的 Antigravity 分组，含 Gemini 3.8 Flash 等最新模型" width="300">
  &nbsp;&nbsp;
  <img src="./docs/assets/settings.png" alt="DSH 设置 → 插件中的 Antigravity 设置：运行方式、号池调度、周额度预热、自动翻译、思考强度与模型显示" width="520">
</p>

<p align="center">
  <img src="./docs/assets/token-usage.png" alt="原生 token 用量统计：缓存命中率、缓存读取与输出" width="300">
  &nbsp;&nbsp;
  <img src="./docs/assets/context-metering.png" alt="1M 上下文的实时占用计量" width="300">
</p>

---

# 中文

## 概述

DSH 的模型列表里通常只有 DeepSeek。装上这个插件后，`agy` 背后的 Gemini、Claude、GPT-OSS 会以 `antigravity` 提供方的身份出现在 `/model` 里，用你已有的 Google 订阅额度工作。

它不是代理转发：插件按轮次启动官方 `agy` 进程，解析 NDJSON 事件流，再映射成 DSH 原生的文本、思考、工具卡片与 token 计量。因此换账号、看配额、断点重试都发生在插件内部，DSH 侧只看到一次正常的模型调用。

- 手上有多份 Google 账号时，额度用完自动接力，对话不中断。
- 配额来自官方接口，5 小时窗口、每周窗口与付费账号的 Argon 池分开显示。
- 思考过程、终端命令、文件改动按 DSH 原生样式呈现，不是一段灰色文本。
- 模型说人话的能力参差，`/tsl` 可以随时把一条回复重写成大白话。

## 核心能力

### 多账号池

- **池化管理**：主账号沿用系统凭据；备用账号各自拥有独立的 HOME 沙箱与 OAuth 凭证，互不覆写。
- **顺序耗尽故障转移**：遇到 429 或额度耗尽，当前账号进入冷却，请求落到池内下一个可用账号，当前回复继续。
- **额度到期优先**：多个账号都可用时，优先用掉最早重置的那一份，把“还能用很久”的额度留到后面，池子整体利用率更高。
- **抖动安全鉴权**：代理抖动引起的 keyring 超时按可重试网络错误处理；判定“需要重新登录”要二次确认，不会因为一次网络抖动把健康账号标死。
- **手动切换**：控制台一键“设为当前使用”，调度指针立即钉到指定账号，顶部徽标同步显示实际调度的账号。
- **独立代理**：每个账号可绑定自己的 HTTP(S) / SOCKS 代理，隔离出口 IP；不配置时自动探测系统代理（macOS `scutil`、Windows 注册表、Linux gsettings）。
- **并发租约**：同一账号的多个会话并行运行共享凭据租约；只有跨账号身份切换才串行交接，避免排队饥饿。
- **按模型族冷却**：Gemini、Claude、GPT-OSS、Argon 的限流独立计算，一个模型族受限不影响其他模型族。

### 官方配额监控

直接调用 Antigravity 官方的 `v1internal:retrieveUserQuotaSummary`，按账号展示三类额度：

| 额度 | 说明 |
| --- | --- |
| 5 小时滚动 | 短窗口削峰额度，带重置倒计时 |
| 7 天周额度 | 账号级周上限 |
| Argon 周池 | Pro / Ultra 账号专属的 Gemini 4 Argon 独立周额度，不占用普通 Gemini 池 |

每个模型族可展开查看明细，额度耗尽前就能看到，不必等 429 才发现。

### 控制台与设置

同一个控制台有两个入口：顶栏的 `AGY (n)` 徽标，以及 DSH「设置 → 插件 → Antigravity」。徽标上的数字是池内账号数，点开就是账号池、额度进度条与代理状态。

- **账号卡片**：别名与邮箱、当前使用标记、启用 / 停用、同步、预热、代理、删除；额度条下方可展开 Claude 与 GPT-OSS 的单模型明细。
- **运行方式**：一行说明权限模式固定为 `skip`（静默执行，agy 内置保护仍然生效）；需要换模式时用配置或 `DSH_AGY_MODE`。
- **号池调度**：`顺序耗尽`（用完一个再换下一个）与 `轮询均衡`（把请求摊平）两种策略。
- **7 天周额度自动预热**：开 / 关。开启后周窗口重置或冷启动时自动探活，提前激活 7 天计时器。
- **自动翻译**：开 / 关，默认关闭；打开后每个回合结束自动生成一张 `/tsl` 翻译卡片。
- **默认思考强度**：`auto` / `low` / `medium` / `high`，决定会话模型下拉框的初始档位，仍可按模型覆盖。
- **模型显示**：点选隐藏或恢复模型；隐藏只影响选择器，不影响进行中的会话。

模型选择器里 Antigravity 以 `Antigravity (agy CLI)` 分组出现，例如 Gemini 3.8 Flash、Claude Sonnet 4.6 (Thinking)、Claude Opus 4.6 (Thinking)、GPT-OSS 120B (Medium)。

### 与 DSH 原生集成

- **模型路由**：注册 `antigravity` 提供方，Gemini、Claude、GPT-OSS、Argon 全族进入 `/model`（分组与模型名单见上节）。
- **完整流式映射**：文本、思考（thinking turn 注记）与工具活动无损映射到 DSH 原生协议。
- **原生工具卡片**：终端命令渲染为 Terminal 卡片（命令、cwd、退出码、超时），文件改动渲染为 inline diff；Antigravity 通过 MCP 元工具（`call_mcp_tool`）发起的调用也会被拆包成终端 / 搜索 / `<server>: <tool>` 卡片，不再是重复的原始 JSON。
- **图表渲染**：回复中的 mermaid 代码块在流式结束后自动渲染为图，多个图表串行渲染互不踩踏。
- **会话延续**：DSH 会话与 agy 原生会话（`--conversation`）绑定，历史由 agy 持有，每轮只发增量。
- **目标与计划透传**：长任务携带 DSH goal / plan 上下文，工具续跑不丢任务状态。
- **token 计量**：输入、输出、思考、缓存读取（`cache_read_tokens`）完整计入 DSH 用量，适配 1M 上下文。
- **思考强度自适应**：模型拒绝 `--effort` 时，插件从报错里认出模型、原样重放一次（这一次不带 `--effort`），并把该模型记进 `~/.dsh/agy-link/effort-unsupported.json`。档位不兼容最多多花一个进程，不会让整轮对话失败。
- **多模态图片**：图片落盘到本地媒体目录，再以 `--add-dir` 授权给 agy 查看。
- **`agy_ask` 委托**：任意 DSH 模型可以把一次独立任务交给 Antigravity 模型处理。

### `/tsl` 大白话翻译

不是每个模型都愿意说人话。`/tsl` 把当前会话的输出交给 Gemini（默认 `gemini-3.8-flash` · `high`），要一份“像跟同事随口解释”的改写。

- **三种入口**：`/tsl` 命令、设置面板里的自动翻译开关、以及每条回复下方的“译成人话”按钮。
- **卡片落在回复下方**：结果以 `plugin:agy-link/translation` 记录持久化，渲染成一张带标记的翻译卡片，锚在被翻译的那条回复下面；刷新页面、切会话后仍在，原文可展开对照，且不会进入模型可见的历史。
- **复用账号池**：翻译走插件自己的辅助通道，账号额度耗尽会冷却并自动在下一个账号重试。
- **一个会话一条翻译会话**：人格设定（身份、DSH 会话 id、工作目录、原始日志路径）只发一次，后续只发请求行，省掉每轮重复的指令开销。
- **默认关闭**：自动翻译每轮都要花额度，因此默认 `autoTranslate: false`，需要时在设置面板或 `/tsl auto on` 显式打开。

## 快速开始

### 前置要求

| 前置项 | 说明 |
| --- | --- |
| 网络 | 能访问 Google（`oauth2.googleapis.com`、`cloudcode-pa.googleapis.com`）。受限网络请开 TUN / 系统代理 |
| DeepSeek Harness | `dsh --version` |
| Node.js | ≥ 24，`node --version` |
| Google Antigravity CLI | 按[官方文档](https://antigravity.google/docs/cli/install)安装，`agy --version` 能输出版本号 |

受限网络下，若终端没有继承代理，启动 DSH 前自行导出：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```

端口换成你本地代理的实际端口。也可以在控制台给单个账号配专属代理。

### 安装与登录

```bash
# 安装（npm 官方包，无需本地编译）
dsh plugin --profile web add dsh-agy-link

# 升级
dsh plugin --profile web add dsh-agy-link@latest

# 启动 DSH Web，检查状态
#   /agy status
```

登录有两种方式：点击顶栏的 `AGY (n)` 徽标 → “添加账号”，浏览器会打开 Google 授权页，本地回环自动收回凭证，不需要复制粘贴授权码；或在输入框执行 `/agy auth` 为主账号发起登录。登录完成后在 `/model` 里选一个 Antigravity 模型即可开始对话。

即使 `agy` 尚未登录也可以先装插件，登录入口由插件提供。

## 使用与配置

### `/agy` 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 二进制、版本、鉴权、权限模式、模型目录、会话绑定 |
| `pool` / `accounts` | 账号池、实时额度百分比、冷却状态 |
| `auth` / `auth-code` | 发起登录 / 用授权码或回调 URL 完成登录 |
| `add-account` / `remove-account` | 新增账号槽位（随后在终端完成登录）/ 删除账号 |
| `enable-account` / `disable-account` | 启用或停用指定账号 |
| `refresh-quota` / `clear-cooldown` | 立即刷新额度 / 清除冷却 |
| `models` | 模型目录 |
| `mode` | 权限模式：`skip` / `plan` / `accept-edits` |
| `effort` | 思考强度：`low` / `medium` / `high` / `default` |
| `dispatch` / `dispatch-retries` / `parallel` / `max-concurrent` | 调度等待上限、重试次数、同账号并行、并发上限 |
| `workspace` | 工作区根目录 |
| `goal` | 查看或控制当前 DSH 目标（`status` / `complete` / `pause` / `resume` / `clear`） |
| `session` | 会话绑定信息 |
| `clear` | 清除当前会话绑定 |
| `doctor` | 生成诊断报告并返回路径（敏感字段自动脱敏） |

### 配置

配置来源优先级：环境变量 `DSH_AGY_*` > 运行时覆盖 > 插件配置 > 默认值。以下是常用项，完整键名与默认值见[配置参考](./docs/CONFIGURATION.md)。

| 键 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | 插件总开关 |
| `agyBin` | `DSH_AGY_BIN` | 自动探测 | `agy` 可执行文件路径 |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip`（无人值守执行）/ `plan` / `accept-edits`；设置面板不再提供切换，仍可由配置或环境变量覆盖 |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | agy 默认 | 默认模型 slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | 默认思考强度，只决定会话模型菜单的初始档位，模型菜单里仍可逐模型覆盖 |
| `hiddenModels` | `DSH_AGY_HIDDEN_MODELS` | `[]` | 在模型选择器中隐藏的 slug 列表（黑名单，新模型默认可见） |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | 单轮活跃看门狗超时（毫秒） |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | 存在未完成工具步骤时的空闲预算（分钟）；`0` 表示维持 `timeoutMs`，卡死的工具快速失败 |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | 会话 cwd | agy 工作区根目录 |
| `proxyUrl` | `DSH_AGY_PROXY_URL` | 空 | 全局代理；单账号代理在控制台里配置，优先于全局值 |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | Windows `true`，其他平台 `false` | 每次 spawn 前刷新 agy 的更新检查时间戳，阻断 `--bg-updater` 子进程链（Windows 闪窗根因） |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | 周额度自动预热（opt-in）：周窗口重置或冷启动时发一次极小探活请求，提前激活 7 天计时器；每 5 分钟巡检一次。该路径直连 Google 内部端点，请自行评估风控 |
| `warmupModels` | `DSH_AGY_WARMUP_MODELS` | `gemini-3.8-flash,claude-sonnet-4-6` | 预热使用的模型列表；空表示不预热 |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | 每个新回合结束后自动翻译，也可用 `/tsl auto on` 按会话覆盖 |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | `/tsl` 与自动翻译使用的模型；目录缺失时按目录回退 |
| `translateEffort` | `DSH_AGY_TRANSLATE_EFFORT` | `high` | 翻译模型的思考强度 |
| `translateTargetLanguage` | `DSH_AGY_TRANSLATE_LANG` | `中文（简体）` | 翻译提示词里的目标语言 |
| `translateBindConversation` | — | `true` | 每个 DSH 会话复用一条 agy 翻译会话：人格只发一次，后续只发请求行 |
| `askTool` | — | `false` | 开放 `agy_ask` 委托工具 |
| `mcpBridge` | `DSH_AGY_MCP_BRIDGE` | `false` | 把 DSH 侧的 MCP 配置桥接给 agy |

### `/tsl` 用法

```
/tsl                       # 翻译上一条已完成回复
/tsl 3                     # 翻译第 3 个回合
/tsl --full                # 连同该回合的中间叙述一起翻译
/tsl --text 任意文本…       # 翻译任意文本（不生成卡片）
/tsl --model claude-sonnet-5-5 --effort medium
/tsl --print               # 同时在命令结果里回显正文
/tsl auto on|off|status    # 按会话开关自动翻译
```

## 工作原理

1. **按轮次驱动进程**：每轮对话启动一次 `agy -p --output-format stream-json`，逐条解析 NDJSON 事件。
2. **账号沙箱**：主账号沿用系统 Keychain / HOME；备用账号在插件私有目录下建立独立 HOME 并写入标准 OAuth 凭证。Windows 上 agy 的凭据实际位于机器级 Credential Manager（`gemini:antigravity`），插件以“身份级引用计数租约”接管该槽位：同一授权的多个会话可并行，只有身份切换串行，并由最后一个持有者还原主账号凭据。
3. **后台配额轮询**：定时静默调用官方配额接口，维护每个账号的三类额度水位与重置时间。
4. **失败分类**：错误按 AUTH / NETWORK / RATE_LIMIT / ELIGIBILITY / TIMEOUT 等分类；网络抖动借 agy 运行日志中的 `keyringAuth` 传输证据甄别为可重试故障。
5. **辅助通道**：`/tsl`、会话标题、目标推导等辅助调用走独立通道（`purpose:'translation'` 等），共享账号池与冷却逻辑，但不进入会话绑定、不暴露工具、不占用并发名额。

## 常见问题

**Windows 下开始对话时会闪一下黑色命令行窗口。**
DSH 是 Electron 桌面应用，每轮对话前插件要同步 Windows 凭据管理器里的 OAuth Token，并启动 `agy.exe` 控制台子进程。Windows 11 若把默认终端设为“Windows 终端”，它会在分配后台控制台时短暂闪窗。把 Windows 终端的默认终端应用改为“Windows 控制台主机”，并完全退出重启 DSH 即可。

**`agy` 自己的自动更新也会闪窗。**
`agy` 在距上次更新检查超过 15 分钟后会派生 `--bg-updater → agy --version` 子进程链，这条链由 agy 内部创建并自行分配可见控制台。插件从 0.4.66 起在每次 spawn 前把 `last_check.timestamp` 刷到当前时间，agy 便直接跳过检查、不再派生子进程。代价是这个 agy home 不再自动检查更新，手动 `agy update` 不受影响；开关是 `suppressAgyAutoUpdate`。

**某个模型选了思考强度后每轮都报 `--effort is not supported`。**
插件会学习这种拒绝：识别模型 id、原样重放一次不带 `--effort` 的调用，并把该模型记入 `~/.dsh/agy-link/effort-unsupported.json`，同时收回它宣称可用的档位。`/agy status` 的 `effortUnsupported` 与 `/agy doctor` 报告里能看到记录。

**额度显示不刷新。**
控制台点“刷新额度”，或执行 `/agy refresh-quota`。后台轮询默认每小时一次，可用 `quotaPollIntervalMs` 调整。

## 文档

| 文档 | 内容 |
| --- | --- |
| [CONFIGURATION.md](./docs/CONFIGURATION.md) | 全部配置键、环境变量与默认值 |
| [HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md) | 无头运行下的权限模式、最小权限验证与验收方法 |
| [SECURITY-NOTES.md](./docs/SECURITY-NOTES.md) | 凭据隔离、静态资源与诊断脱敏的边界 |
| [KNOWN-GAPS.md](./docs/KNOWN-GAPS.md) | 已知缺口与不打算支持的场景 |
| [spec-account-pool.md](./docs/spec-account-pool.md) · [adr-012-account-pool.md](./docs/adr-012-account-pool.md) | 账号池的规格与设计决策 |
| [CHANGELOG.md](./CHANGELOG.md) | 逐版本变更 |

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：Antigravity 公开 OAuth 客户端与回环回调登录范式
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)：opencode 平台的多账号实践
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute)：Antigravity 端点分发与配额语义
- [pi-mono](https://github.com/badlogic/pi-mono)：轮换与桥接设计参考

## 免责声明与许可

插件只调用用户本地安装的官方、未修改的 `agy` CLI 进程，使用需遵守 Google Antigravity 服务条款。代码以 MIT License 发布。

---

# English

Bring Google Antigravity into DeepSeek Harness. The plugin drives the official, unmodified `agy` CLI and adds multi-account pooling, official multi-bucket quota tracking, native streaming and tool cards, and `/tsl` plain-language rewriting.

## Overview

A stock DSH install only lists DeepSeek models. With this plugin, the Gemini, Claude and GPT-OSS models behind `agy` appear in `/model` under the `antigravity` provider and run on your existing Google subscription quota.

This is not a proxy. Each turn spawns the official `agy` process, parses its NDJSON event stream, and maps it to native DSH text, thinking, tool cards and token accounting. Account rotation, quota inspection and retries all happen inside the plugin; DSH only sees a normal model call.

- Multiple Google accounts drain in order, so a conversation survives a quota wall.
- Quotas come from the official endpoint: the 5-hour window, the weekly window and the paid Argon pool are reported separately.
- Thinking, terminal commands and file edits render as native DSH cards, not grey text.
- Not every model writes plainly, so `/tsl` can rewrite any reply in plain language.

## Core capabilities

### Account pool

- **Pooling**: the primary account keeps system credentials; every extra account gets its own HOME sandbox and OAuth credentials, with no cross-writes.
- **Sequential drain**: on HTTP 429 or exhaustion the account cools down and the request moves to the next available account while the turn continues.
- **Quota-expiry first**: among usable accounts the scheduler spends the one that resets soonest, leaving longer-lived quota for later.
- **Jitter-safe auth**: keyring timeouts caused by proxy jitter are treated as retryable network errors; a sticky "needs re-login" verdict requires a second confirmation, so a healthy account is never falsely flagged.
- **Manual switch**: "Set active" pins the scheduler pointer to one account, and the header badge always names the account the server actually schedules.
- **Per-account proxy**: each account can bind its own HTTP(S) / SOCKS proxy to isolate egress IPs; when unset the system proxy is auto-detected (macOS `scutil`, Windows registry, Linux gsettings).
- **Parallel leases**: concurrent sessions on the same account share a credential lease; only cross-account identity switches serialize.
- **Family-scoped cooldown**: Gemini, Claude, GPT-OSS and Argon rate limits are tracked independently.

### Official quota tracking

The plugin calls Antigravity's `v1internal:retrieveUserQuotaSummary` and reports three buckets per account:

| Bucket | Meaning |
| --- | --- |
| 5-hour rolling | Short-window burst quota with reset countdown |
| 7-day weekly | Account-level weekly cap |
| Argon weekly | Separate weekly pool for Gemini 4 Argon on paid Pro / Ultra plans, not shared with the plain Gemini pool |

Per-model detail expands under each bucket, so exhaustion is visible before a 429 arrives.

### Console and settings

The same console opens from two places: the `AGY (n)` badge in the header, and DSH's Settings → Plugins → Antigravity. The badge counts the accounts in the pool; opening it shows the pool, the quota bars and the proxy state.

- **Account card**: alias and mailbox, active marker, enable / disable, sync, warmup, proxy, delete; under the quota bars you can expand the per-model detail for Claude and GPT-OSS.
- **Runtime**: one line stating the permission mode is fixed to `skip` (unattended; agy's own protections still apply). Change it through config or `DSH_AGY_MODE`.
- **Pool scheduling**: `Sequential drain` (exhaust one account, then move on) or `Round robin` (spread the requests evenly).
- **7-day auto-warmup**: on / off. When enabled, a probe fires on the weekly reset or a cold start to activate the 7-day timer early.
- **Auto translate**: on / off, off by default; when on, every completed turn gets a `/tsl` card automatically.
- **Default thinking effort**: `auto` / `low` / `medium` / `high`, seeding the session model menu's initial level and still overridable per model.
- **Model visibility**: click to hide or restore a model. Hiding only affects the picker, never a running conversation.

In the model picker, Antigravity appears as the `Antigravity (agy CLI)` group: Gemini 3.8 Flash, Claude Sonnet 4.6 (Thinking), Claude Opus 4.6 (Thinking), GPT-OSS 120B (Medium), and so on.

### Native DSH integration

- **Model routing**: registers the `antigravity` provider so the Gemini, Claude, GPT-OSS and Argon families all appear in `/model` (group and model names above).
- **Full streaming**: text, thinking annotations and tool activity map losslessly onto the native DSH stream.
- **Native tool cards**: commands render as Terminal cards (command, cwd, exit code, timeout) and edits as inline diffs. Calls made through Antigravity's MCP meta-tool (`call_mcp_tool`) are unwrapped into terminal, search or `<server>: <tool>` cards instead of repeated raw JSON.
- **Diagram rendering**: mermaid blocks render to diagrams once streaming settles, and multiple diagrams render serially without clobbering each other.
- **Session continuity**: DSH sessions bind to native agy conversations (`--conversation`); agy owns the history and each turn sends only the increment.
- **Goal and plan forwarding**: long-running tasks carry DSH goal / plan context so tool continuations keep their state.
- **Token metering**: input, output, thinking and cache-read (`cache_read_tokens`) tokens are all reported, with 1M context support.
- **Effort learning**: when a model rejects `--effort`, the plugin parses the model id from the refusal, replays the call once without the flag, and records the model in `~/.dsh/agy-link/effort-unsupported.json`. A mismatch costs one extra process, never a failed turn.
- **Multimodal images**: images are staged to a local media directory and authorized to agy through `--add-dir`.
- **`agy_ask` delegation**: any DSH model can hand a self-contained task to an Antigravity model.

### `/tsl` plain-language rewriting

`/tsl` sends the current session's output to Gemini (default `gemini-3.8-flash` · `high`) and asks for the explanation you would give a colleague out loud.

- **Three entry points**: the `/tsl` command, an opt-in auto-translate switch in settings, and a per-reply "translate" action.
- **Card anchored under the reply**: results persist as `plugin:agy-link/translation` records and render as a labelled translation card directly under the reply they translate. It survives reloads and session switches, keeps the original behind a toggle, and never enters model-visible history.
- **Same account pool**: translation rides the plugin's auxiliary channel, so a quota-exhausted account cools down and the request retries on the next one.
- **One translation conversation per DSH session**: the persona (identity, DSH session id, workspace, raw-log path) is sent once; later calls send only the request line.
- **Off by default**: auto translation spends quota every turn, so `autoTranslate` stays `false` until you enable it in settings or with `/tsl auto on`.

## Quick start

### Requirements

| Requirement | Details |
| --- | --- |
| Network | Reachable Google endpoints (`oauth2.googleapis.com`, `cloudcode-pa.googleapis.com`). Use a TUN / system proxy where required |
| DeepSeek Harness | `dsh --version` |
| Node.js | ≥ 24, `node --version` |
| Google Antigravity CLI | Installed per the [official guide](https://antigravity.google/docs/cli/install); `agy --version` prints a version |

If your terminal does not inherit the proxy, export it before starting DSH:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```

Replace the port with your local proxy port. A dedicated proxy can also be set per account in the console.

### Install and sign in

```bash
# Install (npm package, no local build)
dsh plugin --profile web add dsh-agy-link

# Upgrade
dsh plugin --profile web add dsh-agy-link@latest

# Start DSH Web, then check status:
#   /agy status
```

To sign in, click the `AGY (n)` badge in the header and choose "Add account": the browser opens Google's consent page and the local loopback captures the credentials, so no authorization code needs copying. Alternatively run `/agy auth` for the primary account. Once signed in, pick an Antigravity model in `/model` and start chatting.

You can install the plugin before `agy` is signed in; the plugin provides the login entry point.

## Usage and configuration

### `/agy` commands

| Command | Purpose |
| --- | --- |
| `status` | Binary, version, auth, permission mode, model catalog, session bindings |
| `pool` / `accounts` | Account pool, live quota percentages, cooldowns |
| `auth` / `auth-code` | Start login / finish login with a code or callback URL |
| `add-account` / `remove-account` | Create an account slot (then finish terminal login) / delete an account |
| `enable-account` / `disable-account` | Enable or disable an account |
| `refresh-quota` / `clear-cooldown` | Refresh quotas now / clear cooldowns |
| `models` | Model catalog |
| `mode` | Permission mode: `skip` / `plan` / `accept-edits` |
| `effort` | Thinking effort: `low` / `medium` / `high` / `default` |
| `dispatch` / `dispatch-retries` / `parallel` / `max-concurrent` | Dispatch wait cap, retries, same-account parallelism, concurrency cap |
| `workspace` | Workspace root |
| `goal` | Inspect or control the DSH goal (`status` / `complete` / `pause` / `resume` / `clear`) |
| `session` | Session binding details |
| `clear` | Clear the current session binding |
| `doctor` | Write a diagnostic report and return its path (secrets redacted) |

### Configuration

Resolution order: `DSH_AGY_*` environment variables > runtime overrides > plugin entry config > defaults. The table below covers the common keys; the complete reference is in [docs/CONFIGURATION.md](./docs/CONFIGURATION.md).

| Key | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Master switch |
| `agyBin` | `DSH_AGY_BIN` | auto-detected | Path to the `agy` binary |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip` (unattended execution) / `plan` / `accept-edits`; not switchable in the settings panel, still overridable by config or env |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | agy default | Default model slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | Seeds the session model menu's initial level; the menu still overrides it per model |
| `hiddenModels` | `DSH_AGY_HIDDEN_MODELS` | `[]` | Slugs hidden from the model picker (deny-list; new models stay visible) |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Activity watchdog timeout in milliseconds |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | Idle budget while a tool step is open; `0` keeps `timeoutMs` so wedged tools fail fast |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | session cwd | agy workspace root |
| `proxyUrl` | `DSH_AGY_PROXY_URL` | empty | Global proxy; per-account proxies set in the console take precedence |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | `true` on Windows, `false` elsewhere | Refreshes agy's update-check timestamp before each spawn so the `--bg-updater` chain (the Windows console flash) never starts |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | Opt-in weekly-quota warmup: a minimal probe when the weekly window resets or is cold, re-checked every 5 minutes. This path talks to Google's internal endpoints, so assess the risk-control tradeoff yourself |
| `warmupModels` | `DSH_AGY_WARMUP_MODELS` | `gemini-3.8-flash,claude-sonnet-4-6` | Models used for warmup; empty disables it |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | Translate every completed turn; `/tsl auto on` overrides per session |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | Model used by `/tsl` and auto mode, with a catalog fallback |
| `translateEffort` | `DSH_AGY_TRANSLATE_EFFORT` | `high` | Reasoning effort for the translate model |
| `translateTargetLanguage` | `DSH_AGY_TRANSLATE_LANG` | `中文（简体）` | Target language in the translator prompt |
| `translateBindConversation` | — | `true` | Reuse one agy translation conversation per DSH session so the persona is sent once |
| `askTool` | — | `false` | Expose the `agy_ask` delegation tool |
| `mcpBridge` | `DSH_AGY_MCP_BRIDGE` | `false` | Bridge DSH-side MCP configuration into agy |

### `/tsl` usage

```
/tsl                       # translate the last completed turn
/tsl 3                     # translate turn 3
/tsl --full                # include the turn's intermediate narration
/tsl --text 任意文本…       # translate arbitrary text (no card)
/tsl --model claude-sonnet-5-5 --effort medium
/tsl --print               # echo the body in the command result
/tsl auto on|off|status    # per-session auto mode
```

## How it works

1. **Per-turn process**: each turn spawns `agy -p --output-format stream-json` and parses the NDJSON events.
2. **Account sandboxes**: the primary account uses the system Keychain / HOME; extra accounts get an isolated HOME under the plugin's private directory with standard OAuth credentials. On Windows, agy's credential lives in the machine-level Credential Manager (`gemini:antigravity`), so the plugin takes that slot over with an identity-scoped reference-counted lease: concurrent sessions on one authorization run in parallel, only identity switches serialize, and the last holder restores the primary credential.
3. **Background quota polling**: a silent timer calls the official quota endpoint and maintains each account's bucket levels and reset times.
4. **Failure classification**: errors are classified as AUTH / NETWORK / RATE_LIMIT / ELIGIBILITY / TIMEOUT and so on; jitter is distinguished from a real sign-out by the `keyringAuth` transport evidence in agy's run log.
5. **Auxiliary channel**: `/tsl`, session titles and goal derivation use a separate channel (`purpose:'translation'` and friends) that shares the account pool and cooldowns but stays out of conversation bindings, tool exposure and concurrency slots.

## FAQ

**A black console window flashes when a turn starts on Windows.**
DSH is an Electron app; before each turn the plugin syncs the OAuth token in the Windows Credential Manager and launches `agy.exe` as a console child. If Windows 11 uses "Windows Terminal" as the default terminal, it briefly flashes while allocating that background console. Set the default terminal application to "Windows Console Host" and restart DSH completely.

**agy's own auto-updater flashes a window too.**
Once its last update check is more than 15 minutes old, agy spawns a `--bg-updater → agy --version` chain that allocates its own visible console. Since 0.4.66 the plugin refreshes `last_check.timestamp` before every spawn, so agy skips the check and never spawns the chain. The cost is that this agy home stops auto-checking for updates; a manual `agy update` still works. The switch is `suppressAgyAutoUpdate`.

**A model keeps failing with `--effort is not supported`.**
The plugin learns the refusal: it identifies the model, replays the call once without `--effort`, records the model in `~/.dsh/agy-link/effort-unsupported.json`, and stops advertising effort levels for it. See `effortUnsupported` in `/agy status` and the `/agy doctor` report.

**Quotas look stale.**
Press "Refresh quota" in the console or run `/agy refresh-quota`. Background polling defaults to once an hour and can be tuned with `quotaPollIntervalMs`.

## Documentation

| Document | Contents |
| --- | --- |
| [CONFIGURATION.md](./docs/CONFIGURATION.md) | Every configuration key, environment variable and default |
| [HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md) | Permission modes in headless runs, least-privilege validation and acceptance checks |
| [SECURITY-NOTES.md](./docs/SECURITY-NOTES.md) | Credential isolation, static assets and diagnostic redaction boundaries |
| [KNOWN-GAPS.md](./docs/KNOWN-GAPS.md) | Known gaps and scenarios that are out of scope |
| [spec-account-pool.md](./docs/spec-account-pool.md) · [adr-012-account-pool.md](./docs/adr-012-account-pool.md) | Account-pool specification and design decision |
| [CHANGELOG.md](./CHANGELOG.md) | Release-by-release changes |

## Credits

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI): public Antigravity OAuth client and loopback callback pattern
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth): multi-account practice on opencode
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute): Antigravity endpoint dispatch and quota semantics
- [pi-mono](https://github.com/badlogic/pi-mono): rotation and bridge design reference

## Disclaimer and license

The plugin only invokes the official, unmodified `agy` CLI installed on the local machine; use is subject to Google Antigravity's Terms of Service. Released under the MIT License.
