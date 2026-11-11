<h1 align="center">🛰️ dsh-agy-link</h1>

<p align="center">
  <b>DeepSeek Harness × Google Antigravity</b> — 多账号智能池化与官方 agy CLI 驱动桥接 / Multi-Account Pool & Native agy CLI Bridge for DSH
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-agy-link"><img src="https://img.shields.io/npm/v/dsh-agy-link?color=cb3837&label=npm&logo=npm" alt="npm"/></a>
  <a href="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml"><img src="https://github.com/amlyczz/dsh-agy-link/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%3E%3D24-green" alt="node"/>
  <img src="https://img.shields.io/badge/agy-v0.5.1-purple" alt="agy v0.5.1"/>
</p>

<p align="center">
  <b>🌐 语言：</b>
  <a href="./docs/README.en.md">English</a> ·
  <a href="./docs/CONFIGURATION.md">完整配置文档</a>
</p>

---

# 中文

把 **Google Antigravity 模型接入 DeepSeek Harness（DSH）** —— 支持**多账号智能池化轮换**、**官方多 Bucket 配额监控（5小时滚动 + 7天周额度 + Argon 独立周池）**、**浏览器免粘贴一键登录**与**浅色/深色主题高对比度自适应**，由官方未修改的 `agy` CLI 驱动，完整支持流式输出、思考折叠（thinking）、原生工具卡片与精确 token 用量。

<p align="center">
  <img src="./docs/assets/console.png" alt="Antigravity 管理控制台 - 多账号池化与配额监控" width="760" />
</p>
<p align="center">
  <img src="./docs/assets/model-picker.png" alt="DSH 模型选择器中的 Antigravity 模型列表" width="280" />
  &nbsp;&nbsp;
  <img src="./docs/assets/settings.png" alt="DSH 设置 → 插件中的 Antigravity 设置面板" width="540" />
</p>
<p align="center">
  <img src="./docs/assets/token-usage.png" alt="原生上下文缓存与 Token 用量统计" width="340" />
  &nbsp;&nbsp;
  <img src="./docs/assets/context-metering.png" alt="1M 物理上下文负载精确计量" width="340" />
</p>

---

> 🚨 **【国内用户核心前置：必须开启系统代理 / TUN 模式！】**
>
> Google Antigravity 服务及 OAuth 登录需要直连 Google 海外官方服务器（`oauth2.googleapis.com`、`cloudcode-pa.googleapis.com` 等）。
>
> 1. **推荐方式（最稳妥）**：开启代理工具（Clash / Surge / v2rayA / Sing-box / Loon 等）的 **TUN 虚拟网卡模式（或系统代理全局接管）**，确保终端命令、后台 Node.js 进程及浏览器均能顺畅访问 Google 网络。
> 2. **终端代理环境变量**：若终端未被代理自动接管，启动 DSH 或运行命令前请在终端中执行：
>    ```bash
>    export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 ALL_PROXY=socks5://127.0.0.1:7890
>    ```
>    *(注：端口 `7890` 请替换为你本地代理软件的实际端口)*
> 3. **GUI 单账号独立代理**：进入 DSH「设置 → Antigravity」或点击顶部 `AGY` 徽标，点击卡片上的「🌐 代理」按钮，可为特定账号单独配置专属代理 URL（如 `http://127.0.0.1:7890`），实现多账号不同 IP 出口隔离。

---

## 🌟 核心亮点：多账号池化与智能轮换

你拥有多个 Google Antigravity / Gemini 账号？**dsh-agy-link 让多账号管理变得极致简单与自动化**：

- 👥 **多账号池化管理 (Account Pool)**：在 DSH 内添加任意数量的 Google 账号（主账号 + 备用账号群），每个账号拥有独立的 HOME 目录沙箱与凭证隔离。
- 🔄 **顺序耗尽故障转移 (Sequential Drain)**：当前账号额度用尽（触发 429 限流或 5h / 周额度耗尽）时，系统**自动平滑接力至下一个可用账号**，对话完全不中断！
- 🕰 **额度到期优先轮换 (Quota-Expiry-First)**：多个账号可用时，优先切换到**重置窗口最早到期**的账号，把"还剩很久才重置"的额度留给后面，整体池化利用率最大化。
- 🧠 **网络抖动智能甄别 (Jitter-Safe Auth)**：代理抖动导致的 keyring 鉴权超时会被自动识别为**可重试的网络错误**而非"登录失效"——基于 agy 本次运行日志的 `keyringAuth` 传输证据精准分类，且粘性"需重新登录"隔离需二次确认，健康账号绝不会被误标。
- 📊 **官方多 Bucket 配额监控 (Multi-Bucket Quota)**：直接调用 Antigravity 官方专用的 `v1internal:retrieveUserQuotaSummary` 接口，同时展示 **5小时滚动额度** 与 **7天周额度**。agy 1.5.5 起 Argon 与新增的 Gemini 4 Carbon 都并入普通 Gemini 池（`/usage` 只返回 Gemini / Claude & GPT 两组），因此不再单独显示 Argon 行；只有服务端仍上报 `Gemini 4 Argon` 独立组时（旧版后端或特定套餐）才额外显示该周额度池。
- 🔀 **手动切换当前账号 (Manual Switch-Active)**：控制台卡片一键「设为当前使用」，即刻把调度指针钉到指定账号。
- 🔑 **GUI 内浏览器免粘贴登录 (In-GUI Zero-Paste OAuth)**：点击「➕ 添加账号」自动调起系统浏览器，本地回环监听自动捕获授权凭证，**全程无需手动复制粘贴授权码**。
- 🎨 **多主题高对比度自适应 (Light & Dark Themes)**：原生适配 DSH 浅色/深色主题，告别发暗发灰与看不清文字，UI 视觉清晰锐利。
- 📱 **手机 Web 端响应式自适应 (Mobile Web)**：控制台在屏幕宽度小于 680px 时自动变为全屏抽屉面板（`100dvh`），标签与开关控件折行重排，配额条独占单行，操作按钮等宽网格分布，并在多尺寸设备（360×800、390×844、768×1024）实测无横向溢出。
- 🗣 **DSH 原生大白话翻译卡片 (`/tsl`)**：卡片沿用 DSH 自己的观感（0.5px 细描边、markdown 代码块底色、12px 圆角、横幅表头），只用一枚单色 Gemini 星标 + 「Gemini 译文」标签标明出处，深浅主题全由 DSH 令牌决定，不再是一块品牌渐变横幅；每个 DSH 会话绑定独立翻译会话（`<sessionId>#tsl`），仅首轮注入人格，后续仅传指令行，共享主号池与故障转移。
- 🧠 **思考强度自适应学习 (Effort Learning)**：当模型拒绝 `--effort` 参数时，自动无 effort 原样重放确保轮次完成，持久化记录至本地文件并自动收回该机型的档位声明，避免后续重复报错。
- 🌐 **独立账号网络代理 (Per-Account Proxy)**：支持为每个账号独立绑定 HTTP(S) / SOCKS 代理，避免多账号同 IP 引起风控；未显式配置时自动探测系统代理（macOS `scutil` / Windows 注册表 / Linux gsettings）。
- ⚡ **分模型族独立冷却 (Family-Scoped Cooldown)**：Gemini、Claude、GPT-OSS 与 Argon 的速率限制独立计算，某个模型族受限不影响其他模型族正常调用。

---

## ✨ 全功能特性一览

| 能力 | 说明 |
| ---- | ---- |
| 🎨 **官方专属矢量 Logo** | 36×36 高质感纯矢量微标（`assets/icon.svg`），透明底自适应深浅主题；设置左侧导航菜单（`[role="dialog"] nav`）动态替换系统齿轮，呈现专属品牌标识 |
| 🧩 **设置与插件面板统一** | 在 DSH「设置 → 插件」详情页直接内嵌 Antigravity 完整控制台，账号池、配额监控与代理配置一站式操作，列表保持轻量整洁 |
| 🚀 **副账号并发租约** | Windows 凭据槽支持同一副账号多会话共享租约并发运行，消除单账号多任务排队饥饿；仅在跨账号身份切换时串行交接 |
| ⚡ **原生上下文缓存与真实计量** | 完整映射 Google Gemini 原生上下文缓存协议（`cache_read_tokens`），精准追踪缓存读取与物理上下文占用，深度适配 1M 超长上下文 |
| 👥 **多账号池化轮换** | 支持主账号 + 多个备用账号；遇到 429 或配额耗尽自动平滑切换，模型族独立冷却，额度到期早的账号优先接班 |
| 🧠 **抖动安全鉴权 (Jitter-Safe Auth)** | 基于 agy 运行日志的 keyring 传输证据区分"网络抖动"与"真登出"，抖动自动按可重试网络错误处理；粘性隔离需二次确认，杜绝误标"需重新登录" |
| 📊 **官方多 Bucket 配额监控** | 实时拉取官方端点，同时呈现 **5h 滚动额度**、**7d 周额度**与 **Argon 独立周池**（付费 Pro/Ultra）多进度条与倒计时，单模型明细可展开 |
| 🔑 **浏览器一键登录** | 点击添加账号自动唤起 Google 授权页，本地回环自动捕获，全程无需复制粘贴任何代码 |
| 🔀 **手动切换当前账号** | 控制台「设为当前使用」按钮即刻钉住调度指针；顶部徽标始终显示服务器实际调度的账号 |
| 🎨 **多主题高对比 UI** | 浅色、深色主题自适应变色，纯矢量 SVG 图标（无 Emoji），字迹清晰不发暗 |
| 📱 **手机 Web 端自适应** | 屏幕宽度 < 680px 时控制台自动转为全屏抽屉面板（`100dvh`），标签开关折行重排，操作按钮等宽网格分布，全面适配触屏滚动 |
| 🌐 **独立账号代理** | 每个账号支持独立配置 HTTP(S) 代理，隔离 IP 出口；亦可自动探测系统代理 |
| 🔌 **原生模型路由** | 在 DSH 模型配置中注册 `antigravity` 提供方，`/model` 选择器以 `Antigravity (agy CLI)` 分组随心切换 Gemini / Claude / GPT-OSS / Argon |
| 🌊 **完整流式映射** | 文本、思考过程（thinking turn）与工具活动均无损映射到 DSH 原生流协议 |
| 🃏 **原生工具卡片** | agy 执行的终端命令（`run_command`）、文件修改（inline diff）均以 DSH 原生卡片渲染；MCP 元工具（`call_mcp_tool`）自动拆包为 Terminal/Search 卡片 |
| 🔗 **会话上下文保真** | DSH 会话与 agy 原生会话绑定（`--conversation`），由 agy 管理完整历史，每轮仅发送增量 |
| 🎯 **DSH 目标与计划集成** | 长任务自动携带 DSH goal / plan 上下文，工具续跑不丢任务状态 |
| 📊 **精确 Token 统计** | 输入 / 输出 / 思考 / 缓存读取 token 完整计入 DSH 用量统计，全面适配 1M 上下文 |
| 🎛 **顶部控制台徽标** | 顶部栏 `AGY · 别名` / `AGY (n)` 徽标一键弹出控制台，直观查看账号池、配额进度条与代理状态 |
| 🖼 **图片多模态** | 支持多模态图片传入，自动落盘本地媒体目录并通过 `--add-dir` 安全授权给 agy 查看 |
| 🤝 **`agy_ask` 辅助工具** | 允许任意 DSH 模型把单次任务委托给 Antigravity 模型（AskAntigravity 协作模式） |
| 🧠 **思考强度自适应学习** | 模型若拒绝 `--effort`，自动无 effort 原样重放并记录至本地，后续自动收回档位声明，杜绝重复报错 |
| 🎨 **生图（`generate_image` 桥接）** | `dsh-agy-image` CLI；直接复用真实 `AgyAdapter`（`purpose:'image'`）与账号池，额度/地区失败自动换号；固定 Prompt/ImageName/AspectRatio/ImagePaths 参数，产物按魔数+宽高+比例强校验 |
| 🗣 **`/tsl` 大白话翻译** | DSH 原生卡片锚定在回复下方，会话 1:1 独立绑定复用；支持 `/tsl` 命令、自动翻译开关（设置页同一行可选**翻译模型**与**思考档**下拉框）及回复快捷按钮「译成人话」 |
| ⌨️ **`/agy` 快捷命令族** | `status` / `pool` / `auth` / `models` / `mode` / `effort` / `workspace` / `goal` / `session` / `enable-account` / `disable-account` / `clear` / `doctor` / `help` |

---

## 📋 前置要求

在安装本插件前，请确保具备以下环境：

| 前置项 | 说明 / 验证方式 |
| --- | --- |
| **1. 系统网络代理** | **【必须开启】**（推荐开启 Clash / Surge / v2rayA / Sing-box 的 TUN 模式或设置 `HTTPS_PROXY` 环境变量，确保可流畅连接 Google 服务） |
| **2. DeepSeek Harness (DSH)** | 你正在使用的 DSH 客户端；`dsh --version` 可验证 |
| **3. Node.js ≥ 24** | DSH 依赖环境；`node --version` 验证 |
| **4. Google Antigravity `agy` CLI** | 按 [Google 官方安装文档](https://antigravity.google/docs/cli/install) 安装（支持 macOS / Linux / Windows）。`agy --version` 能输出版本号即表示安装成功 |

> 💡 **提示**：即使你的 agy 尚未登录，也可以直接安装插件！在 DSH 界面顶部点击 `AGY` 徽标或进入「设置 → Antigravity」，点击「➕ 添加账号」即可直接在浏览器中完成登录。

---

## 🚀 快速上手

```bash
# 0. 确保系统代理 / TUN 模式已开启（国内网络必需）：
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890

# 1. 安装插件（npm 官方包，无需编译构建）：
dsh plugin --profile web add dsh-agy-link

# 升级到最新版：
# dsh plugin --profile web add dsh-agy-link@latest --registry https://registry.npmjs.org

# 2. 启动 DSH Web GUI，在输入框中检查状态：
#   /agy status

# 3. 登录与添加账号：
#   方式 A：点击顶部导航栏的 "AGY (n)" 徽标，点击 "➕ 添加账号"，浏览器一键登录；
#   方式 B：输入框执行 /agy auth 为主账号发起登录；执行 /agy pool 查看账号 ID，
#           再用 /agy auth <账号 ID> 重新登录已有的备用账号（也支持完整别名或邮箱）。
#           授权后 30 秒内执行 /agy auth-status 查看最终登录结果。

# 4. 在 /model 选择器中挑选 Antigravity 模型，立即开启对话！
```

> 无头运行（`dsh headless`）的权限预设与目录白名单见 [docs/HEADLESS-PERMISSIONS.md](./docs/HEADLESS-PERMISSIONS.md)。

---

## ⚙️ 配置说明

所有配置键、环境变量、默认值与高级选项**只维护一份**：[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)。

常用入口：`/plugin`、设置面板（Antigravity）、`DSH_AGY_*` 环境变量，以及 `~/.dsh/agy-link/runtime-overrides.json`（设置面板的写入位置）。

---

## 🗣 /tsl 大白话翻译

模型输出往往偏专业、冗长或充满机器腔。`/tsl` 命令调用 Gemini 模型（默认 `gemini-3.8-flash` · `medium`）将当前会话的回复重写为通俗、口语化的大白话。

```bash
/tsl                       # 翻译上一轮已完成的回复
/tsl 3                     # 翻译指定第 3 轮回复
/tsl --full                # 连同中间工具调用的叙述一并翻译
/tsl --text 任意文本…       # 纯文本翻译模式（在终端直接输出，不生成卡片）
/tsl --model claude-sonnet-5-5 --effort medium  # 临时指定翻译模型与思考强度
/tsl --print               # 在命令执行输出中同步回显译文
/tsl auto on|off|status    # 针对当前会话开启、关闭或查看自动翻译状态
```

- **DSH 原生翻译卡片**：翻译结果持久化存储于 `plugin:agy-link/translation` 会话记录中，渲染为锚定在被翻译回复正下方的原生卡片（只靠一枚单色星标 + 「Gemini 译文」标签标明出处）；刷新页面或切换会话后不丢失，原文支持一键展开折叠，且卡片内容不进入模型可见历史。
- **快捷动作**：每条回复下方均提供「译成人话」快捷操作按钮，历史任一轮次均可按需一键翻译。
- **会话 1:1 独立绑定 (`translateBindConversation`)**：每个 DSH 会话对应一条独立的 agy 翻译会话（`<sessionKey>#tsl`）。首次调用注入翻译员身份、工作区与日志路径；后续翻译复用该会话，每轮仅发送指令行与原文，显著降低 Token 开销。
- **共享号池与自愈容错**：翻译调用走插件辅助通道，共享主账号池与冷却机制，账号额度耗尽自动故障转移至下一个可用账号；遇到空返回（`EMPTY_RESPONSE`）自动退避重试。
- **严格遵循用户授权**：自动翻译默认关闭（`autoTranslate: false`），可在「设置 → Antigravity」中全局开启，或在会话中通过 `/tsl auto on` 动态开启。同一行右侧的两个下拉框可分别改**翻译模型**（默认自动挑 Gemini Flash）与**翻译思考档**（默认跟随「默认思考强度」），改完即写配置、下一轮翻译生效。


---

## 🎨 生图（`generate_image` 桥接 + `dsh-agy-image`）

agy 内置 `generate_image`（文生图 / 改图，产物写入会话 artifacts）。插件把它接成 headless 可用的 CLI，**不新增 HTTP API**：CLI 直接实例化插件真实的 `AgyAdapter`（`purpose:'image'`），所以选号、额度冷却、**额度/地区失败自动换号**、代理、失败分类全部复用主流程那一套，而不是另写一份 spawn / 选号逻辑。

```bash
# 安装插件后即可用；无需交互式会话
dsh-agy-image -p "一只戴墨镜的柴犬，扁平插画风" -a 16:9 -o ./dog.jpg
dsh-agy-image -p "把背景换成夜晚" -i ./day.png -n night_scene --json
```

- **与主流程共用同一套号池**：每次尝试都走 `AccountPoolManager.selectAccount()`；额度耗尽会冷却当前账号并换下一个；`User location is not supported`（地区/资格）也会前移指针换号重试。实测：主号被地区拒绝后，CLI 自动落到支持地区的备用号并成功出图（`accountId` 会写进 JSON）。
- **参数固定**：`Prompt`、`ImageName`、`AspectRatio`（`1:1` / `2:3` / `3:2` / `3:4` / `4:3` / `4:5` / `5:4` / `9:16` / `16:9` / `21:9` / `1:8` / `8:1` / `1:4` / `4:1`）、`ImagePaths`（参考图 / 改图源）。
- **强校验**：产物必须存在、按魔数确认为 PNG/JPEG/WebP/GIF/BMP、能解析出宽高、不超过 `imageMaxBytes`；指定了 `AspectRatio` 时按 3% 容差核对比例。
- **返回结构**（`--json`）：`{ok, path, mime, width, height, aspectRatio, bytes, model, effort, durationMs, attempts, accountId?, conversationId?}`。失败带稳定 `code`：`BAD_PARAMS` / `EMPTY_PROMPT` / `IMAGE_NOT_FOUND` / `IMAGE_INVALID` / `IMAGE_ASPECT_MISMATCH` / `IMAGE_REGION_UNSUPPORTED` / `NO_ACCOUNT` / `TIMEOUT` …
- **退出码**：`0` 成功 · `2` 参数错误 · `3` 找不到 agy · `4` 生成失败 · `5` 产物校验失败 · `6` 账号/地区不可用。
- **已知限制**：agy 的图片模型只按比例出图，不接受任意像素尺寸（1:1 实测 1024×1024，16:9 实测 1376×768）；部分网络出口地区会被 Google 拒绝（`User location is not supported for the API use.`），此时换号/换代理即可。真实生成通常 20–60 秒。

---

## 🧩 架构与工作原理

> 分层、依赖方向与各模块职责见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)；开发与重构门禁见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

1. **短生命周期进程驱动**：每一轮 DSH 对话启动一个独立的官方 `agy -p --output-format stream-json` 进程，解析 NDJSON 事件流。
2. **多账号沙箱机制**：除主账号沿用系统默认 Keychain / HOME 外，所有备用账号在插件私有目录下建立专属 HOME 隔离区，独立写入 agy 格式的标准 OAuth 凭证。Windows 上 agy 的凭据实际存放在机器级 Credential Manager（`gemini:antigravity`），插件因此以「身份级引用计数租约」接管该槽：**同一授权的多个会话并行运行**，只有账号**身份切换**才串行，且由最后一个持有者还原主账号凭据。
   备用账号的凭据会在同目录保存 `.bak`；原文件缺失时自动恢复。备份包含敏感 OAuth 凭据，应保护账号目录的访问权限；撤销授权或权限不足时仍需重新登录。主账号继续使用系统凭据机制。
3. **多 Bucket 官方配额汇总**：插件定时后台静默轮询官方 `v1internal:retrieveUserQuotaSummary`，精准掌控每个账号的 5h 滚动削峰水位与 7d 账号阶梯周额度。服务端上报 `Gemini 4 Argon` 独立组时亦同步展示 Argon 独立周池。
4. **会话级无缝故障转移**：当遭遇 HTTP 429、额度耗尽或凭证异常时，号池调度器自动标记当前账号家族进入冷却（或按额度到期时间择优轮换），并无缝将后续请求路由到池内下一个有效账号。
5. **失败分类与自愈**：错误按 AUTH / NETWORK / RATE_LIMIT / ELIGIBILITY 等精确分类；网络抖动借由 agy 运行日志自动甄别为可重试故障，绝不误伤健康账号的登录状态。
6. **辅助通道隔离**：`/tsl` 翻译、会话标题生成、任务目标推导等通过独立专用辅助通道执行，共享号池与冷却机制，不占主会话绑定与工具权限。

---

## ❓ 常见问题排查 (FAQ)

### 升级到 DSH 0.2.2 后桌面端启动失败（`web boot: 1 entry did not activate` / `locale "es" is already registered`）？
**答：这是 0.4.99 及更早版本的兼容性问题，已在 0.5.5 修复（#70 / `31c99c1`），当前 0.6.x 不受影响。**
- **原因**：0.4.99 的客户端会无条件调用 `locale.addLanguage({ id: 'es' | 'pt-BR' })`。DSH 0.2.2 的宿主 locale 插件可能已先注册这些语言，于是抛出 `locale "es" is already registered`，插件前端条目激活失败并导致整个 web boot 失败（桌面端进不了聊天界面）。
- **处理**：把 `dsh-agy-link` 升级到 **≥ 0.5.5**（推荐当前 0.6.x）。新版注册前会检查宿主语言目录，仅容忍「已注册 / 已有词典」，卸载时也只清理自己拥有的注册项；宿主已注册 `es`/`pt-BR`（含 `ES`/`pt-br` 大小写变体）都可正常共存。
- **临时恢复**：若暂时无法升级，禁用该插件即可进入聊天界面。

### Windows 平台开始对话时为什么会短暂闪一下黑色命令行窗口（黑框）？
**答：这是 Windows 系统的控制台分配机制，完全良性，不会影响对话和模型功能。**
- **原因分析**：DSH 是基于 Electron 的图形桌面应用（GUI 进程），每次发起对话时，插件需要调用底层命令校验并同步当前账号在 Windows 凭据管理器（Credential Manager）中的 OAuth Token，随后启动 `agy.exe` 控制台子进程建立流式通信。在 Windows 11 下，系统默认终端若被设为「Windows 终端 (Windows Terminal)」，Windows Terminal 会拦截后台控制台子进程的句柄分配并闪现弹窗（这是 Windows Terminal 已知的 OpenConsole 委托拦截机制）。
- **解决步骤**：
  1. 打开 **Windows 终端 (Windows Terminal)** 的「设置」→「启动」（或进入 Windows「设置」→「系统」→「开发者选项」）。
  2. 将 **默认终端应用程序 (Default terminal application)** 从「让 Windows 决定」或「Windows 终端」更改为 **「Windows 控制台主机 (Windows Console Host)」**。
  3. 点击右下角 **保存 (Save)**。
  4. **完全退出并重启 DSH**（使新启动的主进程应用更新后的控制台委托注册表），黑框闪烁即可彻底消除。

### agy 自己的自动更新子进程也会闪窗（0.4.66 修复）
除了上面那种控制台委托导致的闪窗，`agy` **自己**还会在距上次更新检查满 15 分钟后派生一条 `--bg-updater` → `agy --version` 的子进程链，**这条链由 agy 内部创建，会自行分配可见控制台**，父进程的 `windowsHide` 和 `AGY_CLI_DISABLE_AUTO_UPDATE=1` 都来不及生效（这就是 Issue #49 实测确认的结论）。

0.4.66 起的处理方式：每次 spawn agy 之前，插件把 agy 更新检查的 fast-path 时间戳（`<agy home>/last_check.timestamp`）刷新为当前时间。agy 的检查逻辑是「距上次检查 < 15 分钟就直接跳过且不派生子进程」，于是这条可见窗口链根本不会被创建——对话、冷启动探测、模型选择器刷新、登录探测全部覆盖。

- **代价**：插件所使用的那个 agy home 不再自动检查更新；手动 `agy update` 完全不受影响。
- **开关**：`suppressAgyAutoUpdate`（环境变量 `DSH_AGY_SUPPRESS_AUTOUPDATE`）。Windows 上默认开启，其他平台默认关闭；设为 `false` 即回到 agy 原本的自动更新行为。
- **旧版本用户的手动 workaround**：把 `%USERPROFILE%\.gemini\antigravity-cli\updater\update.lock` 设为只读（`attrib +R ...`），agy 拿不到更新锁就会跳过检查。代价是手动 `agy update` 会报 `update already in progress`，需要先 `attrib -R`。

### 某个模型选定思考强度后提示 `--effort is not supported`？
部分模型（例如 Gemini Flash 系列或特定版本）并不支持 `--effort` 参数。插件具备自适应学习机制：当检测到模型拒绝 `--effort` 时，插件自动从拒绝报错中提取模型标识，立即原样重放一次不带 `--effort` 的请求，确保当前轮次对话顺利完成；同时将该模型写入 `~/.dsh/agy-link/effort-unsupported.json` 本地记录，并在后续运行时收回该模型宣称的思考强度档位，前端选择器自动隐藏该选项。学习记录可通过 `/agy status` 中的 `effortUnsupported` 字段及 `/agy doctor` 报告查阅。

### 配额进度条未及时更新？
配额信息由后台定时轮询（默认每小时轮询一次，可通过 `quotaPollIntervalMs` 调整）。如需即时刷新，可在控制台卡片中点击「同步」，或在输入框执行 `/agy refresh-quota`。

---

## 🙏 参考与致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) — Antigravity 公开 OAuth 客户端与回环回调登录范式
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) — opencode 平台的多账号实践
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — Antigravity 端点分发与配额语义
- [pi-mono](https://github.com/badlogic/pi-mono) — Antigravity 轮换与桥接设计参考

---

## ⚠️ 免责声明

本插件仅通过调用用户本地官方安装的未修改 `agy` CLI 进程进行交互。使用本插件需遵循 Google Antigravity 服务条款。

## 许可证

MIT License.
