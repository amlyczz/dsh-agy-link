# dsh-agy-link

把 Google Antigravity 接入 DeepSeek Harness（DSH）。插件驱动官方未修改的 `agy` CLI，提供多账号池自动轮换、官方多 Bucket 配额监控、原生流式与工具卡片，以及 `/tsl` 大白话翻译。

[![npm](https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm)](https://www.npmjs.com/package/dsh-agy-link)
[![CI](https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg)](https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](./LICENSE)

[中文](#中文) · [English](#english) · [Português (Brasil)](./docs/README.pt-BR.md) · [Español](./docs/README.es.md) · [English (standalone)](./docs/README.en.md)

```bash
dsh plugin --profile web add dsh-agy-link
```

> 受限网络需要能连 Google：开代理的 TUN 模式，或在启动 DSH 前导出 `HTTPS_PROXY`，配置见[前置要求](#前置要求)。
> Behind a restricted network you need to reach Google: enable TUN mode in your proxy client, or export `HTTPS_PROXY` before starting DSH — see [Prerequisites](#prerequisites).

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

DSH 原生模型列表主要面向 DeepSeek 系列模型。通过本插件，Google Antigravity 支持的 Gemini、Claude 与 GPT-OSS 等模型以 `antigravity` 提供方挂载至 `/model` 选择器，直接复用已有的 Google 账号订阅额度。

插件并非网络代理转发层，而是按轮次在本地拉起官方原版 `agy` CLI 进程，监听解析 NDJSON 事件流，并转换为 DSH 原生的流式文本、思考折叠块、工具调用卡片与 token 计量。多账号轮转、额度监控、鉴权自愈与失败重试均在插件内闭环，DSH 仅感知标准模型交互。

- 多账号按序接力：账号遭遇限流或额度耗尽时自动接力，保持会话连续。
- 官方多 Bucket 监控：直连官方端点，5 小时滚动窗口、7 天周额度与 Argon 独立周池独立计量。
- 深度 UI 集成：思考链折叠、终端执行、inline diff 代码对比、MCP 元工具拆包与 Mermaid 图表原生渲染。
- `/tsl` 大白话翻译：把专业、冗长的回复重写成通俗口语，以 Gemini 专属卡片锚定在回复下方。

## 核心能力

### 多账号池化与调度

- **池化管理**：主账号沿用系统默认环境；备用账号在插件专属数据目录建立独立 HOME 沙箱与 OAuth 凭证隔离，多账号配置互不覆写。
- **顺序耗尽故障转移 (Sequential Drain)**：当前账号触发 429 限流或 5 小时/周额度耗尽时，调度器自动标记当前模型族进入冷却，平滑轮换至池内下一个可用账号继续执行，保障对话不中断。
- **额度到期优先轮换 (Quota-Expiry-First)**：池内存在多个可用账号时，优先调度重置窗口最早到期的账号，保留重置剩余时间较长的额度，最大化全池利用率。
- **抖动安全鉴权 (Jitter-Safe Auth)**：网络代理抖动造成的 keyring 鉴权超时自动判定为可重试网络错误。插件基于 agy 运行日志中的 `keyringAuth` 传输证据精确分类，针对粘性“需重新登录”状态引入二次确认机制，防止健康账号被误标记失效。
- **手动切换当前账号**：控制台卡片支持一键「设为当前使用」，调度指针立即锁定至选定账号，顶栏徽标实时同步当前生效账号。
- **独立账号代理**：支持为单个账号配置独立的 HTTP(S) / SOCKS 代理 URL，实现出口 IP 隔离；未显式配置时自动探测操作系统代理（macOS `scutil`、Windows 注册表、Linux gsettings）。
- **副账号并发租约**：Windows 上 agy 凭据存放于系统凭据管理器（`gemini:antigravity`）。插件引入身份级引用计数租约：同账号多会话并发运行共享租约，跨账号身份切换时串行交接，并由最后一个持有者自动还原主账号凭据。
- **模型族独立冷却**：Gemini、Claude、GPT-OSS 与 Argon 各自独立计算速率限制与冷却周期，单一模型族限流不影响其他模型族正常调用。

### 官方配额监控

直接调用 Antigravity 官方端点 `v1internal:retrieveUserQuotaSummary`，按账号精确呈现三类配额桶：

| 配额桶 | 监控维度与说明 |
| --- | --- |
| 5 小时滚动额度 | 短周期动态削峰水位，带重置倒计时 |
| 7 天周额度 | 账号级阶梯周用量上限 |
| Argon 独立周池 | Google Pro / Ultra 订阅专属的 Gemini 4 Argon 独立周额度，不占用通用 Gemini 池 |

配额条下方可展开查看 Claude 与 GPT-OSS 的单模型明细，在配额耗尽前提供清晰的水位预警。

### 控制台与设置面板

控制台提供双向入口：顶部导航栏的 `AGY` 徽标（有在用账号时显示 `AGY · 别名`，否则显示 `AGY (账号数)`）与 DSH「设置 → 插件 → Antigravity」，点击均可唤起完整控制台。

- **账号卡片**：展示别名、邮箱与当前使用标记；提供启用/停用、配额同步、一键预热、独立代理配置与删除账号功能；支持展开单模型配额详情。
- **运行方式**：权限模式固定为 `skip`（无人值守执行，agy 内置安全规则保持生效），面板展示说明且不开放切换；如需使用 `plan` 或 `accept-edits`，可通过配置项或环境变量 `DSH_AGY_MODE` 指定。
- **号池调度策略**：支持 `顺序耗尽`（单账号用尽后切入下一个）与 `轮询均衡`（请求平摊到可用账号）两种调度算法。
- **7 天周额度自动预热**：开 / 关。当周额度到达重置窗口或插件冷启动时，自动向官方端点发送极小探活请求，提前激活 7 天计时器周期（直连 Google 内部接口，可按需启用）。
- **自动翻译**：开 / 关（默认关闭 `autoTranslate: false`）。启用后每个回合结束自动调用 `/tsl` 生成翻译卡片。
- **默认思考强度**：可选 `auto` / `low` / `medium` / `high`（默认 `high`），设定会话模型下拉菜单的初始档位，会话内仍可按模型单独覆盖。
- **模型显示管理**：支持点选隐藏或恢复特定模型，隐藏仅作用于 `/model` 选择器，不干扰正在运行的会话。
- **模型分组**：在 DSH 模型选择器中以 `Antigravity (agy CLI)` 分组展示，机型包含 Gemini 3.8 / 3.7 / 3.6 / 3.5 Flash、Gemini 4 Argon（Pro/Ultra 专属周池）、Claude Sonnet 4.6、Claude Opus 4.6 (Thinking)、GPT-OSS 120B (Medium) 等。

### 手机 Web 端自适应

针对窄屏移动设备与平板进行响应式重构：
- **断点自适应**：屏幕宽度小于 680px 时，控制台弹窗自动变为占满视口的全屏面板（`100dvh`），适配触控滚动与移动端 safe-area 边距。
- **控件折行重排**：表单行中的标签与开关控件拆分为上下两行，配额进度条独占单行，操作按钮采用等宽网格分布。
- **多尺寸实测**：已在 360×800、390×844 与 768×1024 视口下验证，在 360px 宽度下无横向滚动条溢出或内容被裁切；桌面与平板维持居中卡片布局。

### DSH 原生集成

- **模型路由**：注册 `antigravity` 原生适配器，全系模型支持在 `/model` 菜单中即选即用。
- **流式传输与思考折叠**：文本块与 thinking 思考过程无损映射至 DSH 流协议，呈现为原生思考折叠面板。
- **原生工具卡片与 MCP 拆包**：`run_command` 渲染为 Terminal 卡片（含执行命令、工作目录、退出码与超时时长），文件编辑渲染为 inline diff 对比；通过 Antigravity MCP 元工具（`call_mcp_tool`）发起的外部调用会自动拆包，终端类渲染为 Terminal 卡片，检索类渲染为 Search 卡片，其余呈现为 `<server>: <tool>`，剔除重复的原始 JSON 外壳。
- **Mermaid 串行渲染**：回复中的 mermaid 图表在流式结束后自动渲染为 SVG 矢量图；多个图表通过 Promise 队列串行渲染，避免并发 DOM 操作破坏图表生成。
- **会话持久绑定**：DSH 会话与 agy 原生会话（`--conversation`）建立 1:1 映射，上下文由 agy 管理，每轮仅交互增量；支持长任务的 goal 与 plan 上下文透传。
- **Token 精确计量**：输入、输出、思考以及 Google 原生上下文缓存读取（`cache_read_tokens`）完整纳入计量，深度适配 1M 上下文窗口。
- **思考强度自适应学习**：若模型拒绝 `--effort` 参数，插件通过正则提取报错中的模型标识，立即自动重放一次不带该参数的请求保障对话成功；同时将该模型写入 `~/.dsh/agy-link/effort-unsupported.json`，并收回该模型的档位声明，避免后续重复报错。状态可在 `/agy status`（`effortUnsupported`）与 `/agy doctor` 报告中查阅。
- **多模态图像支持**：上传图像暂存至本地媒体目录，并通过 `--add-dir` 参数授权给 agy 进程直接读取。
- **`agy_ask` 辅助委托工具**：允许任意 DSH 模型将独立子任务委托给 Antigravity 模型协同处理。

### `/tsl` 大白话翻译

`/tsl` 针对专业、冗长或机器腔较重的回复，通过 Gemini（默认 `gemini-3.8-flash` · `high`）将其改写为通俗、口语化的大白话。

- **三处调用入口**：
  1. 命令调用：在输入框执行 `/tsl`（支持指定轮次或文本）。
  2. 设置面板：开启「自动翻译」开关，每轮对话完成后自动翻译。
  3. 回复快捷按钮：每条回复下方均提供「译成人话」动作按钮，支持对历史任一轮次按需发起翻译。
- **Gemini 品牌化翻译卡片**：
  - 翻译结果持久化存储于 `plugin:agy-link/translation` 会话记录中，渲染为锚定在被翻译回复正下方的专属卡片；刷新页面或切换会话后不丢失，原文支持一键展开折叠，且卡片内容不进入模型可见历史。
  - 卡片遵循 Google Gemini 品牌视觉规范：官方四点星标、品牌渐变（`#4285F4 → #9B72CB → #D96570`）、渐变字标、品牌细边框与右上柔光，底部带 `Translated by Gemini` 署名字样；颜色采用 rgba 叠加与 DSH 主题令牌，浅色与深色主题均呈现高对比视觉。
  - 悬浮提示采用 DSH 原生 Tooltip 规范（`--dsw-alias-tooltip-bg`），通过 body 级 portal 节点定位，避免被输入区域遮挡。
- **会话级 1:1 绑定复用 (`translateBindConversation`)**：每个 DSH 会话对应一条独立的 agy 翻译会话（`<sessionKey>#tsl`）。首次调用注入翻译员身份、DSH 会话 ID、工作区与原始日志路径；后续翻译复用该会话，每轮仅发送「当前这一轮回复」指令行加原文，避免模型拿上下文中的早期答复作答，同时显著降低提示词传输开销。
- **调度通道与容错机制**：
  - 翻译请求走插件辅助通道，共享主账号池与冷却机制：若当前账号额度耗尽，自动记录冷却并切换至下一个可用账号重试。
  - 模型返回空内容时按 `EMPTY_RESPONSE` 状态码自动退避重试（退避间隔约 0.9 秒），不直接判定失败。
  - 自动翻译默认关闭（`autoTranslate: false`），防止无预期消耗额度。

## 快速开始

### 前置要求

| 前置项 | 验证命令与要求 | 说明 |
| --- | --- | --- |
| 网络连接 | 直连 Google 服务端点 | 能够连通 `oauth2.googleapis.com` 与 `cloudcode-pa.googleapis.com` |
| DeepSeek Harness | `dsh --version` | DSH 主程序 |
| Node.js | `node --version` | 版本要求 ≥ 24 |
| Google Antigravity CLI | `agy --version` | 官方原版 CLI，参考 [官方安装文档](https://antigravity.google/docs/cli/install) 安装 |

受限网络环境下，建议开启代理客户端（如 Clash、Surge、Sing-box 等）的 TUN 虚拟网卡模式接管全局流量。若终端环境未继承系统代理，可在启动 DSH 前配置环境变量：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```
*(注：请将端口 `7890` 替换为你本地代理软件的实际端口)*

亦可在控制台卡片中点击「代理」按钮，为各个账号分别指定专属代理 URL（如 `http://127.0.0.1:7890`），实现多账号独立 IP 出口。

### 安装与登录

```bash
# 1. 安装插件（官方 npm 发布包，无需本地编译）
dsh plugin --profile web add dsh-agy-link

# 升级至最新版本
dsh plugin --profile web add dsh-agy-link@latest

# 2. 启动 DSH Web 并检查插件状态
# /agy status
```

账号登录可通过以下两种方式完成：
- **浏览器一键免粘贴登录**：点击顶部导航栏 `AGY (n)` 徽标或进入「设置 → 插件 → Antigravity」，点击「添加账号」，系统自动唤起默认浏览器完成 Google OAuth 授权，本地回环自动捕获凭据，无需手动复制粘贴授权码。
- **命令行登录**：在 DSH 输入框中执行 `/agy auth`，为主账号发起登录流程。

插件安装无需预先登录 `agy`，可在安装后直接通过控制台引导登录。登录成功后，在 `/model` 选择器中选择 Antigravity 模型即可发起对话。

## 使用与配置

### `/agy` 命令列表

| 命令 | 说明 |
| --- | --- |
| `/agy status` | 输出二进制路径、版本、鉴权状态、权限模式、可用模型目录与会话绑定详情 |
| `/agy pool` / `/agy accounts` | 查看账号池列表、各账号实时配额百分比、有效状态与冷却倒计时 |
| `/agy auth` / `/agy auth-code` | 发起 Google OAuth 授权 / 通过授权码或回调 URL 完成登录 |
| `/agy add-account` / `/agy remove-account` | 新建账号槽位（并调起登录） / 从账号池中移除指定账号 |
| `/agy enable-account` / `/agy disable-account` | 启用或禁用指定账号槽位 |
| `/agy refresh-quota` / `/agy clear-cooldown` | 立即强制刷新全池账号配额 / 手动清除当前所有账号的冷却状态 |
| `/agy models` | 打印当前账号支持的模型清单与能力声明 |
| `/agy mode` | 查看或临时切换权限模式：`skip` / `plan` / `accept-edits` |
| `/agy effort` | 查看或设置思考强度档位：`low` / `medium` / `high` / `default` |
| `/agy dispatch` / `/agy dispatch-retries` / `/agy parallel` / `/agy max-concurrent` | 查看或调整调度超时阈值、重试次数、同账号并发开关与最大并发数 |
| `/agy workspace` | 查看或重新指定 agy 工作区根目录 |
| `/agy goal` | 查看或管理 DSH 目标状态（子命令：`status` / `complete` / `pause` / `resume` / `clear`） |
| `/agy session` | 查看当前 DSH 会话与 agy 内部会话的映射绑定关系 |
| `/agy clear` | 解除并重置当前会话的 agy 会话绑定 |
| `/agy doctor` | 执行系统诊断，生成并返回脱敏后的诊断报告路径 |

### 常用配置

配置优先级顺序由高到低依次为：环境变量 `DSH_AGY_*` → `/agy` 写入的运行时覆盖文件（`.dsh/agy-link/runtime-overrides.json`） → DSH 插件配置文件 → 默认值。

以下为常用配置项，完整键名、环境变量及高级选项参见 [配置文档 (CONFIGURATION.md)](./docs/CONFIGURATION.md)。

| 键名 | 环境变量 | 默认值 | 作用说明 |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | 插件主开关 |
| `agyBin` | `DSH_AGY_BIN` | 自动探测 | `agy` 可执行文件的绝对路径 |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | 权限模式：`skip`（静默执行）/ `plan` / `accept-edits`；设置面板固定为 `skip`，仅能通过配置或环境变量覆盖 |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | `(agy 默认)` | 初始默认模型标识 |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | 思考预算初始档位（`auto` / `low` / `medium` / `high`），仅作为模型选择器的初始值，可在会话内覆盖 |
| `hiddenModels` | `DSH_AGY_HIDDEN_MODELS` | `[]` | 从 `/model` 选择器中隐藏的模型标识列表（黑名单机制，新增模型默认可见） |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | 单轮对话活跃看门狗超时时间（毫秒，默认 10 分钟） |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | 存在活动工具调用时的空闲超时预算（分钟）；设为 `0` 则维持 `timeoutMs`，使卡死工具快速失败 |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | 会话 cwd | 传递给 agy 的工作区根目录 |
| `proxyUrl` | `DSH_AGY_PROXY_URL` | 空字符串 | 全局网络代理 URL；若在控制台中为账号单独配置了代理，优先使用账号独立代理 |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | Windows `true`，其他平台 `false` | 每次调用前刷新 agy 更新检查时间戳，拦截 `--bg-updater` 子进程链，根治 Windows 闪窗 |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | 7 天周额度自动预热开关：到达重置时间或冷启动时发送极小探活请求提前激活计时器；每 5 分钟巡检一次 |
| `warmupModels` | `DSH_AGY_WARMUP_MODELS` | `gemini-3.8-flash,claude-sonnet-4-6` | 预热探活使用的模型列表（逗号分隔） |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | 回合完成自动翻译开关；可在会话中通过 `/tsl auto on` 动态开启 |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | `/tsl` 翻译模型，缺失时按目录回退 |
| `translateEffort` | `DSH_AGY_TRANSLATE_EFFORT` | `high` | 翻译模型的思考强度档位 |
| `translateTargetLanguage` | `DSH_AGY_TRANSLATE_LANG` | `中文（简体）` | 翻译提示词中指定的目标语言 |
| `translateBindConversation` | — | `true` | 每个 DSH 会话绑定一条独立的 agy 翻译会话，人格仅发送一次，后续轮次仅传请求行与原文 |
| `askTool` | — | `false` | 是否向 DSH 暴露 `agy_ask` 委托工具 |
| `mcpBridge` | `DSH_AGY_MCP_BRIDGE` | `false` | 是否将 DSH 侧配置的 MCP 服务器桥接至 agy |

### `/tsl` 命令用法

```bash
/tsl                       # 翻译上一轮已完成的回复
/tsl 3                     # 翻译指定第 3 轮回复
/tsl --full                # 连同该轮中间的工具执行叙述一并翻译
/tsl --text 任意待翻译文本  # 纯文本翻译模式（不生成卡片）
/tsl --model claude-sonnet-4-6 --effort medium  # 临时指定翻译模型与思考强度
/tsl --print               # 在命令执行输出中同步回显译文正文
/tsl auto on|off|status    # 针对当前会话开启、关闭或查看自动翻译状态
```

## 工作原理

1. **短生命周期进程驱动**：每个对话轮次启动一次独立的 `agy -p --output-format stream-json` 进程，逐行消费 NDJSON 输出流并实时映射为 DSH 事件。
2. **账号沙箱与凭据租约**：主账号沿用系统默认环境；各备用账号在插件专属私有目录分配独立 HOME 目录，维护标准 OAuth 凭据文件。针对 Windows 凭据管理器（`gemini:antigravity`）机器级单槽位限制，插件通过身份级引用计数租约管理该槽位：同账号多会话共享租约并发执行，跨账号切换身份时安全串行交接，并由最后一个持有者自动还原主账号凭据。
3. **后台配额轮询与状态机**：后台定时静默调用官方 `v1internal:retrieveUserQuotaSummary` 端点，维护每个账号的 5 小时滚动削峰水位、7 天阶梯周用量及 Argon 专属池的水位与重置时间。
4. **精确错误分类与自愈**：错误按 AUTH / NETWORK / RATE_LIMIT / ELIGIBILITY / TIMEOUT 等精确分类。结合 agy 单次运行日志中的 `keyringAuth` 传输证据将鉴权网络抖动识别为可重试错误；针对真登出状态引入粘性二次确认，杜绝误伤健康账号。
5. **辅助通道隔离**：`/tsl` 翻译、会话标题生成、任务目标推导等辅助操作均运行于专用辅助通道（`purpose: 'translation'` 等），共享账号池与冷却机制，但不占用主会话绑定、不暴露工具权限、不消耗主任务并发配额。

## 常见问题 (FAQ)

### Windows 平台开始对话时为什么会短暂弹出黑色命令行窗口？

**原因分析**：DSH 基于 Electron 开发（GUI 进程）。发起对话时，插件需要通过底层调用校验当前账号在 Windows 凭据管理器中的 OAuth 凭据，并启动 `agy.exe` 控制台子进程建立流式通信。在 Windows 11 下，若系统默认终端为「Windows 终端 (Windows Terminal)」，Windows Terminal 会拦截后台控制台子进程的句柄分配并短暂闪现窗口（OpenConsole 委托机制）。

**解决方式**：
1. 打开 Windows 终端「设置」→「启动」（或进入 Windows「设置」→「系统」→「开发者选项」）。
2. 将 **默认终端应用程序 (Default terminal application)** 从「让 Windows 决定」或「Windows 终端」更改为 **「Windows 控制台主机 (Windows Console Host)」**。
3. 保存设置，并**完全退出并重启 DSH** 即可彻底消除黑框闪烁。

### agy 自身的自动更新子进程闪窗如何处理？

`agy` CLI 内部会在距上次更新检查超过 15 分钟后，派生 `--bg-updater` → `agy --version` 的后台检查子进程链。该链条由 agy 内部原生创建并分配可见控制台，常规父进程隐藏参数无法直接拦截。

插件从 0.4.66 版本起，在每次拉起 agy 进程前，均自动将 agy 更新检查时间戳（`<agy home>/last_check.timestamp`）刷新为当前系统时间。agy 检查到时间间隔小于 15 分钟便会直接跳过检查，从源头阻断该子进程链的创建。该机制由配置项 `suppressAgyAutoUpdate` 控制（Windows 默认开启，其他平台默认关闭）。手动执行 `agy update` 完全不受影响。

### 某个模型选定思考强度后提示 `--effort is not supported`？

部分模型（例如 Gemini Flash 系列或特定版本）并不支持 `--effort` 思考强度参数。插件具备自适应学习机制：当检测到模型拒绝 `--effort` 时，插件自动从拒绝报错中提取模型标识，立即原样重放一次不带 `--effort` 的请求，确保当前轮次对话顺利完成；同时将该模型写入 `~/.dsh/agy-link/effort-unsupported.json` 本地记录，并在后续运行时收回该模型宣称的思考强度档位，前端选择器自动隐藏该选项。学习记录可通过 `/agy status` 中的 `effortUnsupported` 字段及 `/agy doctor` 报告查阅。

### 配额进度条未及时更新？

配额信息由后台定时轮询（默认每小时轮询一次，可通过 `quotaPollIntervalMs` 调整）。如需即时刷新，可在控制台卡片中点击「刷新额度」，或在输入框执行 `/agy refresh-quota`。

## 文档导航

| 文档 | 主要内容 |
| --- | --- |
| [CONFIGURATION.md](./docs/CONFIGURATION.md) | 全部配置项、环境变量与默认值完整参考 |
| [HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md) | 无头运行模式下的权限控制、最小权限验证与验收标准 |
| [SECURITY-NOTES.md](./docs/SECURITY-NOTES.md) | 凭据沙箱隔离、静态资源边界与敏感诊断脱敏规范 |
| [KNOWN-GAPS.md](./docs/KNOWN-GAPS.md) | 已知边界与架构设计上暂不涵盖的场景说明 |
| [spec-account-pool.md](./docs/spec-account-pool.md) · [adr-012-account-pool.md](./docs/adr-012-account-pool.md) | 多账号池规格说明与架构设计决策记录 (ADR) |
| [CHANGELOG.md](./CHANGELOG.md) | 版本逐次更新日志与演进记录 |

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：Antigravity 公开 OAuth 客户端与本地回环回调登录范式参考
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)：opencode 平台的多账号隔离实践
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute)：Antigravity 官方端点分发与配额语义模型
- [pi-mono](https://github.com/badlogic/pi-mono)：多账号调度轮换与桥接设计参考

## 免责声明与许可证

本插件仅通过调用本地已安装的官方未修改 `agy` CLI 进程进行交互。使用本插件需严格遵循 Google Antigravity 服务条款。

本项目遵循 [MIT License](./LICENSE) 开源。

---

# English

## Overview

DeepSeek Harness (DSH) by default surfaces models within the DeepSeek family. With `dsh-agy-link`, Google Antigravity models (Gemini, Claude, GPT-OSS) are registered under the `antigravity` provider in the `/model` picker, allowing you to use your existing Google subscription quotas directly inside DSH.

The plugin does not function as an external network proxy. Instead, it drives the official unmodified `agy` CLI locally per turn, parsing its NDJSON event stream and mapping events losslessly into native DSH text, folded thinking turns, tool execution cards, and token metering. Account pool failover, official quota inspection, credential jitter self-healing, and retry handling are contained within the plugin; DSH observes a standard, reliable model interaction.

- Sequential drain failover: Multi-account rotation handles rate limits or quota depletion without interrupting ongoing conversations.
- Official multi-bucket quota tracking: Direct integration with official endpoints monitors the 5-hour rolling limit, 7-day weekly cap, and dedicated Argon weekly pool.
- Deep UI integration: Native thinking fold blocks, Terminal cards, inline file diffs, MCP meta-tool unwrapping, and serialized Mermaid diagram rendering.
- `/tsl` plain-language translation: Rewrites complex or jargon-heavy responses into natural spoken language, anchored as dedicated Gemini-branded cards directly beneath replies.

## Core Capabilities

### Multi-Account Pool & Scheduling

- **Pool Sandboxing**: The primary account utilizes the standard system environment. Secondary accounts operate within private directory sandboxes with isolated HOME paths and OAuth credentials, preventing cross-account contamination.
- **Sequential Drain Failover**: When an active account encounters HTTP 429 rate limits or runs out of its 5-hour or weekly quota, the scheduler cools down that model family on the current account and fails over to the next available account in the pool, continuing the turn seamlessly.
- **Quota-Expiry-First Scheduling**: When multiple accounts are available, the scheduler prioritizes the account whose reset window expires soonest. This preserves accounts with longer remaining reset windows, maximizing overall pool capacity.
- **Jitter-Safe Authentication**: Keyring authentication timeouts caused by proxy jitter are recognized as retryable network errors. Transport evidence (`keyringAuth`) in agy's execution logs ensures accurate classification. Sticky "needs re-login" states require a second confirmation, protecting healthy accounts from false quarantine.
- **Manual Active Account Switch**: The console card allows pinning the scheduling pointer to a specific account via "Set active", with the top bar badge immediately reflecting the actively scheduled account.
- **Per-Account Proxy Configuration**: Each account can bind a dedicated HTTP(S) or SOCKS proxy URL to isolate egress IPs. When unconfigured, the plugin automatically detects system proxy settings (macOS `scutil`, Windows Registry, Linux gsettings).
- **Secondary Account Parallel Leases**: On Windows, agy credentials reside in Credential Manager (`gemini:antigravity`). The plugin coordinates access via an identity-scoped reference-counted lease: multiple sessions on the same account run concurrently sharing the lease, serializing only when switching account identities, and restoring the primary credential upon exit of the last session holder.
- **Family-Scoped Cooldowns**: Rate limits and cooldown timers are calculated independently across Gemini, Claude, GPT-OSS, and Argon families. A limit reached in one model family does not stall other families.

### Official Quota Tracking

The plugin interfaces directly with Antigravity's official endpoint `v1internal:retrieveUserQuotaSummary`, providing progress bars and reset countdowns across three quota buckets:

| Quota Bucket | Scope and Description |
| --- | --- |
| 5-Hour Rolling Limit | Short-window burst quota with a dynamic reset countdown |
| 7-Day Weekly Limit | Account-level weekly quota cap |
| Argon Weekly Pool | Dedicated weekly pool for Gemini 4 Argon on paid Pro / Ultra plans, isolated from the general Gemini quota |

Per-model breakdowns for Claude and GPT-OSS expand below the quota bars, providing early visibility into remaining capacity before HTTP 429 errors occur.

### Console and Settings Panel

The console is accessible through two entry points: the `AGY` badge in the top header (it reads `AGY · <alias>` while an account is serving, otherwise `AGY (n)` with the pool size) and DSH "Settings → Plugins → Antigravity".

- **Account Cards**: Display account alias, email address, and active status marker. Provide controls to enable/disable, sync quotas, trigger one-click warmup, configure dedicated proxy URLs, and delete accounts, with expandable per-model usage details.
- **Permission Mode**: Fixed to `skip` (unattended execution, with agy's internal guardrails preserved) with a static descriptive note in the UI. Can be overridden for headless runs via configuration or the `DSH_AGY_MODE` environment variable.
- **Pool Scheduling Strategy**: Configurable between `Sequential drain` (exhausting each account before advancing) and `Round robin` (distributing requests evenly across available accounts).
- **7-Day Auto-Warmup**: On / Off toggle. Sends a minimal probe request upon reaching the weekly reset window or during cold start to activate the 7-day countdown timer early.
- **Auto-Translate**: On / Off toggle (defaults to disabled: `autoTranslate: false`). When enabled, automatically generates a `/tsl` card upon completion of each conversation turn.
- **Default Thinking Effort**: Selectable between `auto`, `low`, `medium`, and `high` (defaults to `high`). Sets the initial effort level in the session model picker; can be overridden per model inside the session.
- **Model Visibility**: Allows toggling visibility of individual models. Hiding a model only affects the `/model` dropdown list and does not impact running sessions.
- **Model Lineup**: Models appear in the DSH picker under the `Antigravity (agy CLI)` group, including Gemini 3.8 / 3.7 / 3.6 / 3.5 Flash, Gemini 4 Argon (Pro/Ultra weekly pool), Claude Sonnet 4.6, Claude Opus 4.6 (Thinking), GPT-OSS 120B (Medium), and more.

### Mobile Web Responsiveness

The console interface is responsive for mobile and tablet browsers:
- **Responsive Drawer (<680px)**: When the viewport width is below 680px, the console modal transitions to a full-height drawer panel (`100dvh`), accommodating touch interaction and device safe-area insets.
- **Reflow and Wrapping**: Form label rows wrap controls below labels, quota progress bars occupy full rows, and action buttons arrange in equal-width grids.
- **Cross-Viewport Testing**: Verified across 360×800, 390×844, and 768×1024 viewports with zero horizontal overflow or clipping down to 360px widths, while maintaining centered modal layouts on desktop.

### Native DSH Integration

- **Model Routing**: Registers the `antigravity` provider to expose the full model catalog in `/model`.
- **Streaming and Thinking Turn Folds**: Text chunks and reasoning tokens map to the native DSH streaming protocol, rendering thoughts in collapsible panels.
- **Native Tool Cards and MCP Unwrapping**: `run_command` calls render as native Terminal cards (displaying command, working directory, exit code, and timeout), and file edits render as inline diffs. Calls via Antigravity's MCP meta-tools (`call_mcp_tool`) are unwrapped: terminal commands render as Terminal cards, search queries as Search cards, and external tools as `<server>: <tool>`, eliminating raw JSON wrappers.
- **Serialized Mermaid Diagrams**: Mermaid blocks render into SVG diagrams once streaming settles. Renders are queued serially through a Promise chain, preventing DOM concurrency race conditions that cause fallback to raw text code blocks.
- **Session Continuity**: DSH sessions map 1:1 to native agy conversations (`--conversation`). Context history is retained by agy, transmitting only conversational increments per turn, while forwarding DSH goal and plan states.
- **Token Metering**: Prompt, completion, reasoning, and Google native prompt cache reads (`cache_read_tokens`) are recorded, fully supporting 1M context windows.
- **Effort Learning Mechanism**: If a model rejects `--effort`, the plugin parses the model identifier from the refusal, replays the request once without `--effort` to guarantee turn completion, persists the refusal to `~/.dsh/agy-link/effort-unsupported.json`, and withdraws effort declarations for that model in future sessions. Status is visible in `/agy status` (`effortUnsupported`) and `/agy doctor`.
- **Multimodal Images**: Images stage to a local media directory and are made accessible to agy via `--add-dir`.
- **`agy_ask` Delegation Tool**: Enables any DSH model to delegate modular tasks to an Antigravity model during agent execution.

### Plain-Language Translation (`/tsl`)

`/tsl` uses Gemini (default `gemini-3.8-flash` · `high`) to translate technical, verbose, or dense model outputs into accessible, conversational explanations.

- **Three Entry Points**:
  1. Slash Command: Run `/tsl` in chat (supports targeting specific turns or arbitrary text).
  2. Settings Toggle: Enable "Auto translate" to trigger translation automatically on turn completion.
  3. Per-Reply Button: Click the "translate into plain language" action (labelled 译成人话 in the Chinese UI) below any completed reply to translate historical turns on demand.
- **Gemini-Branded Translation Card**:
  - Results persist in session storage under `plugin:agy-link/translation` and render as a branded card pinned directly beneath the corresponding reply. Cards survive reloads, allow toggling the original text, and do not pollute model-visible history.
  - Features official Google Gemini branding: four-point spark glyph, brand gradient (`#4285F4 → #9B72CB → #D96570`), gradient wordmark, subtle hairline border glow, and a `Translated by Gemini` signature. Colors use rgba overlays and DSH tokens to maintain high contrast in light and dark themes.
  - Hover tooltips use DSH native tooltip tokens (`--dsw-alias-tooltip-bg`) rendered via a body portal, preventing clipping near composer edges.
- **1:1 Conversation Binding (`translateBindConversation`)**: Each DSH session binds to one agy translation conversation (`<sessionKey>#tsl`). The translation persona (translator role, session ID, workspace, raw log path) is sent on the initial turn; subsequent turns send only the request instruction line alongside the current reply. This prevents the model from quoting earlier turns while minimizing prompt token overhead.
- **Routing and Fault Tolerance**:
  - Translation calls operate over an auxiliary channel sharing the account pool and cooldown states: exhausted accounts cool down and retry on the next available account automatically.
  - Empty model responses are categorized as `EMPTY_RESPONSE` and retried with a ~0.9s backoff rather than failing immediately.
  - Auto-translate is disabled by default (`autoTranslate: false`) to prevent unintentional quota consumption.

## Quick Start

### Prerequisites

| Requirement | Command / Check | Description |
| --- | --- | --- |
| Network Access | Connectivity to Google APIs | Reachable `oauth2.googleapis.com` and `cloudcode-pa.googleapis.com` |
| DeepSeek Harness | `dsh --version` | DSH client application |
| Node.js | `node --version` | Version ≥ 24 required |
| Google Antigravity CLI | `agy --version` | Official unmodified CLI installed per the [official guide](https://antigravity.google/docs/cli/install) |

In restricted network environments, enable TUN mode in your proxy client (Clash, Surge, Sing-box, etc.). If your terminal does not inherit system proxies, export environment variables before starting DSH:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
```
*(Replace `7890` with your local proxy port)*

Alternatively, configure a dedicated proxy URL per account in the console card (e.g. `http://127.0.0.1:7890`) for isolated egress routing.

### Installation and Authentication

```bash
# 1. Install plugin (official npm package, no build required)
dsh plugin --profile web add dsh-agy-link

# Upgrade to latest
dsh plugin --profile web add dsh-agy-link@latest

# 2. Start DSH Web and check status
# /agy status
```

Authentication can be completed using either method:
- **Zero-Paste Browser Login**: Click the `AGY (n)` header badge or navigate to "Settings → Plugins → Antigravity" and click "Add account". The system opens your default browser for Google OAuth, capturing tokens via local loopback without manual code copying.
- **Command-Line Login**: Run `/agy auth` in the DSH input box to initiate login for the primary account.

You do not need an active `agy` login prior to installing the plugin; the plugin provides the authentication workflow. Once logged in, pick an Antigravity model in `/model` and begin.

## Usage and Configuration

### `/agy` Commands

| Command | Description |
| --- | --- |
| `/agy status` | Show CLI path, version, auth status, permission mode, model catalog, and session bindings |
| `/agy pool` / `/agy accounts` | Display account pool status, quota percentages, enabled state, and cooldowns |
| `/agy auth` / `/agy auth-code` | Initiate Google OAuth login / complete login via code or callback URL |
| `/agy add-account` / `/agy remove-account` | Add account slot (initiates login) / remove account from pool |
| `/agy enable-account` / `/agy disable-account` | Enable or disable specified account |
| `/agy refresh-quota` / `/agy clear-cooldown` | Force refresh quotas immediately / clear active cooldowns |
| `/agy models` | List available models and capability declarations |
| `/agy mode` | View or override permission mode: `skip` / `plan` / `accept-edits` |
| `/agy effort` | View or set reasoning effort: `low` / `medium` / `high` / `default` |
| `/agy dispatch` / `/agy dispatch-retries` / `/agy parallel` / `/agy max-concurrent` | Inspect or configure dispatch timeouts, retries, same-account parallelism, and concurrency limits |
| `/agy workspace` | View or rebind agy workspace root |
| `/agy goal` | Inspect or control DSH goal state (`status` / `complete` / `pause` / `resume` / `clear`) |
| `/agy session` | View active session binding details between DSH and agy |
| `/agy clear` | Clear current agy session binding |
| `/agy doctor` | Run diagnostic sweep and output path to redacted report |

### Common Configuration

Configuration precedence (highest to lowest): `DSH_AGY_*` environment variables → runtime overrides (`.dsh/agy-link/runtime-overrides.json`) → DSH plugin configuration → defaults.

The table below lists common configuration keys. For complete descriptions, environment variables, and advanced options, see [Configuration Reference (docs/CONFIGURATION.md)](./docs/CONFIGURATION.md).

| Key | Environment Variable | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `DSH_AGY_ENABLED` | `true` | Master switch |
| `agyBin` | `DSH_AGY_BIN` | auto-detected | Path to the `agy` executable |
| `permissionMode` | `DSH_AGY_MODE` | `skip` | `skip` (unattended execution) / `plan` / `accept-edits`; fixed to `skip` in settings panel, overridable via config or env |
| `defaultModel` | `DSH_AGY_DEFAULT_MODEL` | `(agy default)` | Initial model slug |
| `defaultEffort` | `DSH_AGY_DEFAULT_EFFORT` | `high` | Initial reasoning effort (`auto` / `low` / `medium` / `high`); seeds model dropdown, overridable per model |
| `hiddenModels` | `DSH_AGY_HIDDEN_MODELS` | `[]` | Slugs hidden from the `/model` dropdown (deny-list; newly added models remain visible) |
| `timeoutMs` | `DSH_AGY_TIMEOUT_MS` | `600000` | Activity watchdog timeout per turn in milliseconds |
| `longToolIdleMinutes` | `DSH_AGY_LONG_TOOL_IDLE_MINUTES` | `240` | Idle timeout budget while a tool call is active (minutes); set to `0` to keep `timeoutMs` for fast failure |
| `workspaceRoot` | `DSH_AGY_WORKSPACE_ROOT` | session cwd | agy workspace root |
| `proxyUrl` | `DSH_AGY_PROXY_URL` | empty string | Global proxy URL; per-account proxies configured in console take precedence |
| `suppressAgyAutoUpdate` | `DSH_AGY_SUPPRESS_AUTOUPDATE` | `true` on Windows, `false` elsewhere | Refreshes update check timestamp before spawn to block the `--bg-updater` console flash chain |
| `autoWarmup` | `DSH_AGY_AUTO_WARMUP` | `false` | Opt-in 7-day weekly quota warmup: probes endpoint on reset or cold start to activate 7-day timer |
| `warmupModels` | `DSH_AGY_WARMUP_MODELS` | `gemini-3.8-flash,claude-sonnet-4-6` | Models used for warmup probes (comma-separated) |
| `autoTranslate` | `DSH_AGY_AUTO_TRANSLATE` | `false` | Automatically translate completed turns; overridable per session via `/tsl auto on` |
| `translateModel` | `DSH_AGY_TRANSLATE_MODEL` | `gemini-3.8-flash` | Model for `/tsl` translation with catalog fallback |
| `translateEffort` | `DSH_AGY_TRANSLATE_EFFORT` | `high` | Reasoning effort for the translation model |
| `translateTargetLanguage` | `DSH_AGY_TRANSLATE_LANG` | `中文（简体）` | Target language specified in translation prompt |
| `translateBindConversation` | — | `true` | Binds 1:1 agy translation conversation per DSH session; persona sent once, subsequent turns send request line |
| `askTool` | — | `false` | Expose `agy_ask` delegation tool to DSH |
| `mcpBridge` | `DSH_AGY_MCP_BRIDGE` | `false` | Bridge DSH MCP servers into agy |

### `/tsl` Syntax & Usage

```bash
/tsl                       # Translate the last completed reply
/tsl 3                     # Translate turn 3
/tsl --full                # Include intermediate execution narration in translation
/tsl --text "Sample text"  # Translate arbitrary text (no card generated)
/tsl --model claude-sonnet-4-6 --effort medium  # Override model and effort
/tsl --print               # Echo translated body directly in command output
/tsl auto on|off|status    # Toggle or inspect auto-translate for current session
```

## Architecture & How It Works

1. **Per-Turn Process Invocation**: Each turn spawns an independent `agy -p --output-format stream-json` process, parsing NDJSON chunks into native DSH events.
2. **Sandboxing & Credential Leases**: Primary account uses standard system credentials; secondary accounts reside in private directory sandboxes with independent HOME paths and OAuth tokens. On Windows, Credential Manager (`gemini:antigravity`) slot contention is managed via identity-scoped reference-counted leases: concurrent sessions on the same account share leases, serializing only during cross-account identity switches, and restoring primary credentials upon exit.
3. **Background Quota Polling**: Silent background polling queries `v1internal:retrieveUserQuotaSummary`, tracking 5-hour rolling, 7-day weekly, and Argon pool quotas and reset countdowns.
4. **Failure Classification & Recovery**: Errors are classified into AUTH, NETWORK, RATE_LIMIT, ELIGIBILITY, and TIMEOUT. Transport logs (`keyringAuth`) disambiguate network jitter from genuine sign-outs, using secondary verification to prevent false quarantine.
5. **Auxiliary Channel Isolation**: `/tsl`, session title generation, and goal derivation run over dedicated auxiliary channels (`purpose: 'translation'`), sharing the account pool and cooldown states without binding conversation history, exposing tools, or consuming concurrency slots.

## Troubleshooting & FAQ

### Why does a black terminal window momentarily flash when starting a turn on Windows?

**Root Cause**: DSH is an Electron desktop app (GUI process). When initiating a turn, the plugin verifies Google credentials in Windows Credential Manager and spawns `agy.exe` as a console child process. On Windows 11, if the system default terminal is set to "Windows Terminal", Windows Terminal intercepts the background console allocation and momentarily displays an empty window (OpenConsole delegation).

**Resolution**:
1. Open Windows Terminal "Settings" → "Startup" (or Windows "Settings" → "System" → "For developers").
2. Change **Default terminal application** from "Let Windows decide" or "Windows Terminal" to **"Windows Console Host"**.
3. Save settings, then **fully quit and restart DSH** to apply the change.

### How does the plugin prevent flashing from agy's auto-updater?

`agy` spawns an internal `--bg-updater` → `agy --version` child process chain when its update check timestamp is older than 15 minutes. This internal chain allocates a visible console window that bypasses parent process hide flags.

Starting in v0.4.66, the plugin updates `<agy home>/last_check.timestamp` to the current time prior to each agy invocation. Seeing a fresh timestamp, agy skips its internal check and avoids spawning the updater chain. Controlled by `suppressAgyAutoUpdate` (defaults to `true` on Windows, `false` elsewhere). Manual `agy update` commands remain fully functional.

### What happens when a model rejects `--effort` with `--effort is not supported`?

Certain models do not support the `--effort` parameter. The plugin automatically detects this refusal, parses the model slug from the error envelope, and replays the turn once without `--effort` so that execution succeeds seamlessly. It then writes the model slug to `~/.dsh/agy-link/effort-unsupported.json` and withdraws the model's effort level declarations, hiding the option in the UI for subsequent sessions. Learned records can be inspected via `/agy status` (`effortUnsupported`) or `/agy doctor`.

### Why are quota bars not updating?

Quotas update via periodic background polling (defaulting to once per hour, tunable via `quotaPollIntervalMs`). For immediate updates, click "Refresh Quota" on the console card or run `/agy refresh-quota` in the chat input.

## Documentation

| Document | Contents |
| --- | --- |
| [CONFIGURATION.md](./docs/CONFIGURATION.md) | Complete reference of configuration keys, environment variables, and defaults |
| [HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md) | Permission modes in headless runs, least-privilege checks, and validation |
| [SECURITY-NOTES.md](./docs/SECURITY-NOTES.md) | Credential sandbox boundaries, static assets, and diagnostic redaction |
| [KNOWN-GAPS.md](./docs/KNOWN-GAPS.md) | Known architecture boundaries and out-of-scope scenarios |
| [spec-account-pool.md](./docs/spec-account-pool.md) · [adr-012-account-pool.md](./docs/adr-012-account-pool.md) | Account pool specification and architectural decision record (ADR) |
| [CHANGELOG.md](./CHANGELOG.md) | Release-by-release changelog |

## Credits

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI): Public Antigravity OAuth client and loopback callback pattern reference
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth): Multi-account sandbox practices on opencode
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute): Antigravity endpoint dispatch and quota semantics
- [pi-mono](https://github.com/badlogic/pi-mono): Multi-account scheduler rotation and bridge design reference

## Disclaimer and License

This plugin interacts strictly by executing the locally installed, unmodified official `agy` CLI binary. Usage must comply with Google Antigravity's Terms of Service.

Licensed under the [MIT License](./LICENSE).
