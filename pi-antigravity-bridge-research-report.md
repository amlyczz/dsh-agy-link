# 调研报告：pi 扩展 @estebanforge/pi-antigravity-bridge

> 调研目标：为 DeepSeek Harness（DSH，@deepseek-ai/dsh）编写把 Google Antigravity agy CLI 模型接入的插件提供最完整的参考。
> 调研方式：npm registry 元数据 + 下载 npm tarball 直接阅读全部源码（19 个文件）+ GitHub API + 官方文档镜像 + 关联项目交叉验证。所有关键论断附来源 URL。

---

## 1. 包与仓库基本信息

| 项 | 值 | 来源 |
|---|---|---|
| 包名 | @estebanforge/pi-antigravity-bridge | [npm](https://www.npmjs.com/package/@estebanforge/pi-antigravity-bridge) |
| 最新版本 | 1.2.4（2026-08-13 发布） | [registry 元数据](https://registry.npmjs.org/@estebanforge/pi-antigravity-bridge) |
| 版本史 | 1.0.0（2026-07-29）→ 1.1.0 → 1.1.1 → 1.1.2 → 1.2.3 → 1.2.4 | 包内 CHANGELOG.md（npm tarball 解包） |
| GitHub 仓库 | https://github.com/EstebanForge/pi-antigravity-bridge（public，2026-07-26 创建，2026-08-14 最后推送，2 stars / 0 forks，377 KB） | [GitHub API](https://api.github.com/repos/EstebanForge/pi-antigravity-bridge) |
| 作者 | EstebanForge（esteban@attitude.cl，actitud.xyz） | [npm 元数据](https://registry.npmjs.org/@estebanforge/pi-antigravity-bridge) |
| 许可证 | MIT | 同上 |
| 一句话定位 | Streaming Gemini provider for pi, built on the agy CLI. Registers antigravity/* models in pi's /model picker via SQLite polling + protobuf decode of agy's conversation DBs.（为 pi 提供的流式 Gemini provider，基于 agy CLI；通过 SQLite 轮询 + 对 agy 会话数据库的 protobuf 解码，把 antigravity/* 模型注册进 pi 的 /model 选择器） | [npm 元数据](https://registry.npmjs.org/@estebanforge/pi-antigravity-bridge)、[pi.dev](https://pi.dev/packages/@estebanforge/pi-antigravity-bridge) |
| pi.dev 页面数据 | Type: extension；Pi manifest: {"extensions":["./extensions"]}；1 dependency + 1 peer；222.3 KB；下载 313/mo | [pi.dev](https://pi.dev/packages/@estebanforge/pi-antigravity-bridge) |
| npm 下载量 | 最近一月 673 次（2026-07-17 ~ 08-15） | [npm API](https://api.npmjs.org/downloads/point/last-month/@estebanforge/pi-antigravity-bridge) |
| 依赖 | 运行时仅 @modelcontextprotocol/sdk ^1.29.0（MCP 工具桥）；devDeps：@earendil-works/pi-ai / pi-tui / pi-coding-agent ^0.84.0、typebox、tsx、vitest、typescript；peerDeps：@earendil-works/pi-coding-agent（optional） | [npm 元数据](https://registry.npmjs.org/@estebanforge/pi-antigravity-bridge) |
| 要求 | Node >= 22.5（用内置 node:sqlite）、agy CLI 已安装且已登录、pi | 包内 README.md |

关联项目（作者生态）：
- @estebanforge/pi-ask-antigravity：AskAntigravity 委托工具的独立版本（桥的前身，现被桥吸收，双装时自动退让）— https://github.com/EstebanForge/pi-ask-antigravity
- EstebanForge/construct-cli：作者自制的 AI agent 沙箱（README 推荐配合使用）— https://github.com/EstebanForge/construct-cli

---

## 2. README 全部要点（逐条）

来源：包内 README.md，与 GitHub 仓库 README 完全一致（https://github.com/EstebanForge/pi-antigravity-bridge）。

1. 定位：同时是"流式 Gemini 模型 provider"和"AskAntigravity 委托工具"，形态对标 pi-claude-bridge。
2. 核心机制：在 /model 选择器选 Gemini 模型 → pi 每轮走该 provider → provider 在工作区 spawn 'agy -p'，边跑边轮询 agy 写入的 SQLite 库，解码 protobuf 步骤负载，把 agent 文本逐 token 流回 pi。
3. 多轮对话：pi 会话 ↔ agy conversation id 绑定，持久化在 ~/.pi/agent/antigravity-bridge/sessions.json，下一轮用 '--conversation <id>' 恢复；agy 自带历史，所以每轮只发最新一条用户消息。
4. 做不到的事（硬限制）：
   - agy 跑自己封闭的工具循环（read_file/write_file/edit_file/run_command，作用于 --add-dir），pi 自带的 read/write/edit/bash 不会触发；agy 的编辑直接落盘，pi 的内联 diff 审阅不参与（作者自研了 diff 渲染补偿，见后）。
   - agy 命令无逐操作审批（与 pi 其他工具一致）。
   - 无 token 用量/成本统计（agy 不暴露 token 数，usage 恒为 0）。
5. MCP 工具桥（agy 用 pi 的工具）：在 pi 进程内起 localhost MCP server；tools/list 返回 pi 已注册工具（内置文件/shell 工具和 AskAntigravity 被过滤），tools/call 经 pi.invokeTool() 执行；agy 通过桥写入的 ~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/.agents/mcp_config.json 发现服务，provider spawn agy 时把该目录作为额外 --add-dir 传入；用户全局 agy 配置（~/.gemini/config/mcp_config.json）从不改动。
   - 能力门槛：pi.invokeTool() 目前不是 pi 上游 API，首次加载时扩展会问一次是否给已安装的 pi dist/ 打本地补丁（可 /agy patch restore 还原；pi 更新后 dist/ 被清，下次启动自动重打）。不打补丁则 MCP 桥关闭，其余功能照常。
   - 递归安全：只有 provider 的 agy 拿到额外 --add-dir；AskAntigravity 工具的 agy 只带工作区，且 AskAntigravity 从暴露的工具列表里过滤掉。
   - 成本扇出：所有注册的 pi 工具（含 AskClaude/AskCodex 等委托工具）都会暴露给 agy，agy 可经桥再链到别的模型——新的成本/时间扇出向量。
   - 安全：只绑 127.0.0.1，要求每会话共享密钥头 x-bridge-token（防浏览器 CSRF），请求体大小封顶；仅适合单用户开发机（同用户进程都能读到 token）。
6. 安装：'pi install npm:@estebanforge/pi-antigravity-bridge'；要求 agy CLI（官方安装指南 https://antigravity.google/docs/cli/install）+ 先跑一次 agy 完成 Google OAuth；agy 二进制解析自 $PATH 或 AGY_BIN。
7. 用法：/model 选 antigravity/* 模型，或 '/model antigravity/gemini-3-6-flash-medium'；模型 id 由 'agy models' 输出 slug 化（"Gemini 3.6 Flash (Medium)" → gemini-3-6-flash-medium）；加载时发现一次，'agy update' 后 /reload 刷新；agy models 失败时用硬编码回退目录保证选择器不空。
8. /agy 命令：status、mode plan|accept-edits、permissions on|off、model flash|pro|gemini、thinking low|medium|high、patch status|apply|restore、clear；配置持久化到 ~/.pi/agent/antigravity-bridge/config.json，下一轮生效。
9. 权限警告：pi 本身没有审批门；agy -p 非交互模式无法回答 y/n 提示，所以默认传 '--dangerously-skip-permissions'（否则 run_command 会永久挂起，上游 issue google-antigravity/antigravity-cli#318）；'--sandbox' 不要与 skip-permissions 同用（issue #36）。想完全只读用 /agy mode plan。
10. 环境变量：AGY_BIN、AGY_EXTRA_ARGS、AGY_CONVERSATIONS_DIR、AGY_MODE、AGY_SKIP_PERMISSIONS、AGY_DEFAULT_MODEL、AGY_DEFAULT_THINKING（优先级高于配置文件）。
11. ToS 灰色地带：Google Antigravity ToS 第 6 条禁止"用非 Google 产品访问服务"，举的例子是 Hermes/OpenClaw 复用 OAuth token；本扩展不这么做——它 spawn 官方未修改的 agy 二进制，agy 自己完成 OAuth 和调用 Google，扩展只读本地 SQLite 文件，从 Google 侧看与终端里直接跑 agy 无差别；2026 年 2 月的封号针对的是 token 复用工具。作者结论：实际风险低但非零，纯工程分析非法律建议。来源：https://antigravity.google/terms、包内 README.md。

---

## 3. 源码结构（模块地图，全部 19 个文件）

来源：npm tarball 解包；架构图见包内 docs/ARCHITECTURE.md。

\`\`\`
extensions/index.ts      扩展入口：registerProvider + 模型发现 + /agy 命令 + 补丁决策 + MCP 桥生命周期（482 行）
src/provider.ts          streamSimple：pi Context → agy 一轮 → pi 事件流（550 行）
src/runner.ts            spawn agy -p + 250ms 并发轮询 + abort/timeout + 事件发射（390 行）
src/poller.ts            只读 node:sqlite 句柄（PRAGMA data_version 合并，开一个会话 DB）
src/protobuf.ts          手写 varint 行走器 + 提取器（field 20.1=文本，5.4=工具调用，30.4=标题）
src/discovery.ts         快照/差分绑定 conversation id（含 /proc/<pid>/fd 进程树消歧）
src/models.ts            agy models → pi Model 投影（含 slug 化、effort 折叠、回退目录、TTL 缓存）
src/sessions.ts          原子 JSON 存储：pi session → agy conversation + last step idx
src/config.ts            持久化运行配置（mode/permissions/model/thinking 默认值）
src/ask-tool.ts          AskAntigravity 一次性委托工具（797 行，含 renderCall/renderResult、includeContext）
src/mcp-server.ts        MCP 工具桥：Streamable HTTP，暴露 pi 工具给 agy（443 行）
src/patcher.ts           pi.invokeTool 本地补丁自应用器（6 处插入点，571 行）
src/diff-render.ts       agy 文件编辑的 git 来源 diff 渲染（进 thinking 流）
docs/ARCHITECTURE.md     架构文档（解码管线/轮询/会话发现）
docs/DEVELOPMENT.md      构建/测试/调试（decode-db、run-agy、test-provider、smoke:pi 脚本）
docs/PI-BRIDGE-GAPS.md   能力缺口清单（G1 流式进度/G2 UI 原语/G3 事件订阅 + 废弃点子墓地）
docs/PI-INVOKETOOL-PATCH.md  pi.invokeTool 补丁的 6 处修改点详细说明
CHANGELOG.md / LICENSE(MIT) / package.json
\`\`\`

技术亮点：无生成式 protobuf 代码、无原生 SQLite 依赖（node:sqlite）、测试完备（protobuf 纯函数测试、fake-agy 流式/中止回归测试、MCP 桥端到端安全测试）。

---

## 4. 完整功能清单（每个功能的细节）

### A. 流式 Gemini Provider（模型接入）
1. 模型自动发现：加载时 spawn 'agy models'，解析两列输出（slug + 显示名），把 Gemini 系折叠成 base slug + 思考档位（gemini-3.6-flash → efforts low/medium/high；gemini-3.1-pro → low/high，Pro 无 medium）；Claude/GPT-OSS 保持 agy 原始 slug、无思考切换（agy 对它们拒绝 --effort）。验证过 agy 1.1.9 行为。来源：src/models.ts。
2. 发现失败回退：FALLBACK_MODELS 硬编码（gemini-3.6-flash / gemini-3.1-pro / claude-sonnet-4-6），保证 /model 不空。来源：src/models.ts。
3. 发现缓存：~/.pi/agent/antigravity-bridge/models-cache.json，5 分钟 TTL；过期时先返回旧缓存、后台刷新（pi 的 provider 模型列表是静态注册的，刷新只影响下次加载）。来源：src/models.ts。
4. 模型元数据投影：reasoning 只在 effort 驱动时 true（pi 显示思考切换）；thinkingLevelMap 只列该 base 支持的档位；input 只标 text（agy -p 纯文本，图片块被静默丢弃）；contextWindow 写死 1M（Gemini 上限）、maxTokens 65536；cost 全 0。来源：src/models.ts。
5. 多轮会话绑定：sessions.json 原子写（temp+rename），dirty-key 合并支持多进程并发；key 用 options.sessionId 或 cwd 兜底。来源：src/sessions.ts。
6. 跨轮上下文连续（G1 已闭合）：每轮构造"delta digest"——最近的 pi 压缩摘要 + watermark 之后其他 provider/工具轮的文本，拼进 prompt 前缀（自己 provider 的轮次跳过，避免重复）；默认 8000 字符软上限、从新往旧截断。来源：src/provider.ts。
7. 编辑 diff 渲染（G8 已闭合）：解析 agy 工具调用的 inputJson（按 key 名泛化匹配 file/content），用 git（HEAD 版本，按 toplevel 解析嵌套仓库）计算带行号的 diff，流进 pi 的 thinking 面板；二进制/非仓库/未变化文件降级为摘要。来源：src/diff-render.ts。

### B. AskAntigravity 委托工具
1. 一次性 'agy -p' 子进程委托，stdout 作为 partial 输出流式回显，返回最终文本 + conversationId（footer 提示可续聊）。来源：src/ask-tool.ts。
2. 参数（typebox schema）：prompt、cwd、model（别名/精确 id）、mode（plan|accept-edits）、digest（紧凑输出，plan 默认开）、conversationId（续聊）、timeoutMinutes、includeContext（1.2.4 新增：把当前 pi 对话导出为 markdown 到 ~/.pi/extensions-data/estebanforge/pi-antigravity-bridge/ 临时文件，--add-dir 给 agy 读，跑完删除）。
3. 模型别名解析：flash / pro / gemini / "3.5 flash" / "flash high" / 精确 slug；支持版本排序取最新；档位就近匹配（Pro 无 medium 就近）；静态别名叠加层 sonnet/opus/gpt-oss。来源：src/ask-tool.ts。
4. 循环委托防护：当前 provider 已是 antigravity 时拒绝执行。来源：src/ask-tool.ts。
5. UI 呈现：renderCall 显示解析后的 model/thinking/mode 标签 + prompt 预览（≤1000 字符、6 行）；renderResult 显示 ✓/✗、耗时、可展开 body；运行中每秒 onUpdate 尾部输出。来源：src/ask-tool.ts。

### C. MCP 工具桥（agy 调用 pi 的工具）
1. 进程内起 Streamable HTTP MCP server（随机端口，127.0.0.1）；tools/list 过滤 builtin 工具和 AskAntigravity；tools/call 经 pi.invokeTool 执行。来源：src/mcp-server.ts。
2. 每进程独立配置目录 agy-mcp-<pid>（并发 pi 会话不串扰）；启动时清扫僵尸目录；SIGINT/SIGTERM/exit 清理。来源：src/mcp-server.ts。
3. 安全：共享密钥头 x-bridge-token（crypto.randomUUID，timingSafeEqual 比较）、1MB body 上限、每请求 AbortController（agy 断连即取消工具调用）、全 handler try/catch 防 pi 崩溃。来源：src/mcp-server.ts。
4. MCP 协议版本钳制：agy 协商 2026-07-28 的新协议版本，SDK 只支持到 2025-11-25，桥把不支持的 MCP-Protocol-Version 头改写为 LATEST（含 rawHeaders，兼容 Hono 转换）。来源：src/mcp-server.ts + CHANGELOG。
5. pi.invokeTool 本地补丁：6 处插入点（agent-session.js 实现 + bindCore actions + runner runtime 拷贝 + runner 委托方法 + loader.js 门面 + types.d.ts 类型），两阶段（先全部校验锚点再写）、门面最后写（写一半时 hasInvokeTool 仍为 false 安全降级）、带版本戳备份、跨版本拒绝 restore、EACCES 给出 sudo 安装修复指引。来源：src/patcher.ts + docs/PI-INVOKETOOL-PATCH.md。

### D. /agy 斜杠命令
- /agy（无参，TUI 下打开设置选择器：mode/permissions/model/thinking）
- /agy status、/agy mode plan|accept-edits、/agy permissions on|off、/agy model flash|pro|gemini、/agy thinking low|medium|high、/agy patch status|apply|restore、/agy clear。来源：extensions/index.ts。

### E. 其他
- 跨扩展冲突避免：globalThis Symbol("pi-antigravity-bridge:active") 标志 + package.json 探测，pi-ask-antigravity 双装时自动退让。来源：extensions/index.ts。
- 生命周期日志路由：MCP 桥事件经 ctx.ui.notify（toast）而非 stderr（pi TUI 会把 stderr 钉在输入框上方整场不消失），无 UI 时落 stderr。来源：extensions/index.ts + CHANGELOG。

---

## 5. 架构：与 agy CLI 的集成方式（核心）

**总体答案：不是解析 stdout，也不是走 HTTP API；是 spawn 官方 agy 二进制 + 轮询它自己写的 SQLite 会话库 + 手写 protobuf 解码。** 来源：包内 README / ARCHITECTURE.md。

### 5.1 spawn 命令构造（src/runner.ts）
\`\`\`
agy --add-dir <cwd> [--add-dir <mcp-config-dir>] [--model <slug>] [--effort <low|medium|high>]
    --mode <accept-edits|plan> [--dangerously-skip-permissions]
    [--conversation <id>] --print-timeout <N>m -p <prompt>
\`\`\`
- '-p' = print 模式（非交互），prompt 作为位置参数（Hermes 文档确认 agy -p / --print 是一次性非交互模式：https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli）
- detached: true + 进程组 SIGTERM→5s→SIGKILL 杀树（agy 会再 spawn exec 子进程）
- stdio：stdin/stdout ignore（文本不来自 stdout！），只收 stderr 作错误信息
- 自建 watchdog 强制超时（agy --print-timeout 只是建议性）
- 轮询循环 250ms 与进程并发跑；退出后 3×100ms trailing polls 补尾部 flush；中止时跳过 trailing 立即收尾
- 请求取消：AbortSignal → 杀进程组

### 5.2 轮询（src/poller.ts）
- 打开 ~/.gemini/antigravity-cli/conversations/<uuid>.db（AGY_CONVERSATIONS_DIR 可覆盖），readOnly 模式
- 每 tick 先查 'PRAGMA data_version'（agy 未提交时跳过 SELECT，agy 思考期间零行读）
- 'SELECT idx, step_type, status, step_payload FROM steps WHERE idx > ? ORDER BY idx' 增量读
- agy 会原地扩展正在写的 step（同一 idx 文本变长），所以每次 tick 还要 re-read 最后一个 text/thinking step 发射增长后缀
- 撕裂读（agy 写一半）抛 RangeError → 丢弃该步，下个 tick 重试，不中断整轮

### 5.3 protobuf 解码（src/protobuf.ts）——纯逆向工程
- step_payload 是 protobuf blob，无公开 schema；字段号是逆向事实（对照 shindgew/agy-acp、shubzkothekar/antigravity-acp 两个解码器 + 真实库验证，agy 1.1.7）
- 关键布局：field 20.1 = agentText；field 5.4 = toolCall（name@2/9，inputJson@3）；field 30.4 = title
- step_type 表：15=agent text、14=thinking、23=title、{5,7,8,9,17,21,33,101,132,138}=tool run；status 3=完成
- 手写 varint 行走器（32 位精度够用；10 字节上限防 DoS），未知字段按 wire rules 跳过 → 对 agy 加字段前向兼容
- 不引入 @bufbuild/protobuf，不生成代码

### 5.4 会话 id 发现（src/discovery.ts）——agy 不打印 id
- 新会话：spawn 前快照 conversations 目录 *.db 集合，spawn 后差分；恰好 1 个新文件 = 我们的；0 个 = 拒绝绑定（报错而非猜）；多个 = 歧义
- 歧义消解：把 spawn 的 pid 传进去，扫描 '/proc/<pid>/fd' 进程树，找出我们 agy 实际打开的那个 .db（Linux only）；找不到就 fail-safe 返回 null 拒绝绑定
- 同一模式被 pi-ask-antigravity、agy-acp、antigravity-acp 三家采用（README 明说 borrowed from antigravity-acp scan.ts）

### 5.5 事件映射到 pi 流（src/provider.ts）
- agy text → pi text block（text_start/text_delta/text_end）
- agy thinking → pi thinking block
- agy tool → pi thinking block，标签 "[agy tool: <name>]"；若解析出编辑工具则 "[agy edit: <file>]" + git diff
- 刻意不发 toolCall block：agy 自己跑封闭工具循环，没有 toolUse stopReason、没有结果回传路径
- close-on-switch：同一时刻最多一个 content block 打开（对齐 pi-claude-bridge 生命周期）
- 失败路径：start 失败/超时/非 0 退出/发现 miss → error 事件带消息；成功但无文本 → 发空 text block 保证 assistant turn 形态完整
- usage 全 0（zeroUsage）

### 5.6 会话持久化与多轮
- 每轮结束把 {conversationId, lastStepIdx, lastMessageCount} 存 sessions.json；下一轮带 --conversation + baseStepIdx，poller 从 baseStepIdx 之后开始读，不重放历史

### 5.7 MCP 桥接入点
- agy 从 --add-dir 目录读 '.agents/mcp_config.json'（验证过，不是 cwd）；桥把 mcp_config.json 写进自己的 per-pid 目录，spawn 时加 --add-dir；全局 ~/.gemini/config/mcp_config.json 不动

---

## 6. 模型 / Provider 配置方式（全清单）

| 层面 | 机制 | 详情 | 来源 |
|---|---|---|---|
| 模型发现 | 'agy models' 子进程 | 加载时 spawn 一次；输出 '<slug>  <label>' 两列；Gemini 系折叠 + 档位映射 | src/models.ts |
| 模型注册 | pi.registerProvider("antigravity", {...}) | api: "agy-bridge"（自定义哨兵，不撞内置 provider）、baseUrl "agy-bridge://antigravity"、streamSimple 回调 | extensions/index.ts |
| 模型选择 | pi 的 /model 选择器 | 模型 id 形如 antigravity/gemini-3-6-flash；思考档位用 pi 的 thinking toggle | 包内 README |
| 运行配置 | ~/.pi/agent/antigravity-bridge/config.json | mode(accept-edits/plan)、skipPermissions(bool)、defaultModel(flash/pro/gemini)、defaultThinking(low/medium/high)、invokeToolPatchDeclined | src/config.ts |
| 环境变量 | 7 个 AGY_* | AGY_BIN / AGY_EXTRA_ARGS / AGY_CONVERSATIONS_DIR / AGY_MODE / AGY_SKIP_PERMISSIONS / AGY_DEFAULT_MODEL / AGY_DEFAULT_THINKING；优先级 env > 配置文件 > 默认值 | src/config.ts |
| 会话状态 | ~/.pi/agent/antigravity-bridge/sessions.json | pi session → agy conversation + step idx + message watermark | src/sessions.ts |
| 模型缓存 | ~/.pi/agent/antigravity-bridge/models-cache.json | TTL 5min | src/models.ts |
| 补丁备份 | ~/.pi/agent/antigravity-bridge/pi-patch-backup/ | pi.invokeTool 补丁的原文件备份 | src/patcher.ts |
| agy 侧配置 | 从不修改 | agy 全局配置在 ~/.gemini/antigravity-cli/settings.json、~/.gemini/config/mcp_config.json（中文官方文档：https://www.antigravityide.cn/docs/cli/cli-using） | README / src/mcp-server.ts |

---

## 7. 流式输出、工具调用、思考过程处理

- 流式输出：真流式——不是等 agy 退出回放，而是 250ms 轮询 DB 并发发射；agy 原地增长文本用 re-read 增量发射（delta）；退出后 3×100ms trailing polls 捕获最后 flush。事件映射：text → text block（start/delta/end）。来源：src/runner.ts、src/provider.ts。
- 工具调用：agy 的工具循环对 pi 是"黑盒"——不发 toolCall block；工具活动以 thinking 块形式可见（"[agy tool: run_command]"）；文件编辑额外渲染 git diff（"[agy edit: foo.ts]" + 行号 diff，≤100 行截断）。反向打通靠 MCP 桥（agy 调 pi 的工具）。来源：src/provider.ts、src/diff-render.ts。
- 思考过程（thinking/reasoning）：step_type 14 的 thinking 步骤 → pi thinking block（同一时刻只开一个 block，切换时 close-on-switch）；模型侧思考档位映射为 agy --effort（Gemini base 必须带 effort，Pro 无 medium 会被隐藏/就近）；固定思考模型（Claude/GPT-OSS）无 toggle。来源：src/runner.ts、src/models.ts、src/provider.ts。
- 标题：step_type 23 title 解码但不流给用户（元数据）。来源：src/runner.ts。

---

## 8. 暴露给用户的命令 / 快捷键 / 设置项

- 命令：/agy（+ 子命令 status/mode/permissions/model/thinking/patch/clear）；/model（选 antigravity/*）；/reload（刷新模型列表）。来源：extensions/index.ts、README。
- TUI 设置选择器：/agy 无参在 TUI 下打开 SettingsList（Execution mode / Permissions / Tool default model / Tool default thinking 四行）。来源：extensions/index.ts。
- UI 呈现：AskAntigravity 工具调用行显示 [model=…, thinking=…, mode=…, digest, continue, context=full] 标签 + prompt 预览；结果行 ✓ AskAntigravity 12.3s + 可展开 body；运行中每秒进度更新。来源：src/ask-tool.ts。
- 环境变量：见第 6 节（7 个）。
- 无自定义快捷键/flag 注册（未用到 registerShortcut/registerFlag）。

---

## 9. 安装与分发方式（pi 扩展机制）

- 包名约定：npm 包 + keywords 含 "pi-package"、"pi-extension"；scope 自选（@estebanforge/）。
- 入口声明：package.json 里 "pi": {"extensions": ["./extensions"]} —— 指向目录，pi 按目录规则解析（package.json 的 pi.extensions → index.ts → index.js → 扫描一层 *.ts/*.js）。来源：[pi.dev 页面展示的 manifest](https://pi.dev/packages/@estebanforge/pi-antigravity-bridge)、[oh-my-pi extension-loading.md](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)。
- 入口形态：'export default async function (pi: ExtensionAPI): Promise<void>'——默认导出工厂，接收 pi 扩展 API。来源：extensions/index.ts、[pi 官方扩展文档](https://mintlify.wiki/pt-act/pi-mono/concepts/extensions)。
- 安装：'pi install npm:@estebanforge/pi-antigravity-bridge'（pi 内置包管理器，从 npm 拉取并按 manifest 加载）。来源：README、pi.dev。
- 注册 API 面：registerProvider（自定义 provider + streamSimple）、registerTool（typebox/arktype schema + execute + renderCall/renderResult）、registerCommand、on(event, handler)（session_start/session_shutdown/tool_call/tool_result/turn_start/turn_end 等生命周期）、sendMessage/sendUserMessage、setModel/setThinkingLevel、getAllTools 等。来源：[pi 官方扩展文档](https://mintlify.wiki/pt-act/pi-mono/concepts/extensions)、[oh-my-pi extensions.md](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md)。
- 数据/状态目录约定：~/.pi/agent/<extension-name>/（配置、会话、缓存）；~/.pi/extensions-data/<author>/<extension>/（扩展数据）。来源：源码各处。
- 版本兼容策略：peerDependencies @earendil-works/pi-coding-agent: *（optional）；devDeps 钉 ^0.84.0 做编译期审计。
- 发布管线：prepublishOnly = tsc --noEmit + vitest；files 白名单（extensions/src/docs/README/CHANGELOG）。

---

## 10. agy CLI 本身是什么、有哪些能力

- 身份：Google Antigravity 的官方终端 agent CLI，仓库 google-antigravity/antigravity-cli（2026-05-13 创建，1941 stars，README 描述 "Antigravity CLI brings the reasoning, execution, and orchestration capabilities of Antigravity agent harness directly into your terminal"）。来源：[GitHub](https://github.com/google-antigravity/antigravity-cli)、[GitHub API](https://api.github.com/repos/google-antigravity/antigravity-cli)。
- 定位：替代旧的 Gemini CLI（Gemini CLI 的继任者）；与 Antigravity 2.0 GUI 共享同一 Agent Engine（核心引擎共用，改进双端同步）。来源：[官方 README](https://github.com/google-antigravity/antigravity-cli)、[Flutter 文档](https://docs.flutter.dev/ai/antigravity-cli)。
- 交互模式：TUI（agy 或 agy -i）；非交互一次性的 print 模式（agy -p / --print '<prompt>'，输出纯文本）；'--prompt-interactive' 变体。来源：[Hermes 技能文档](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli)。
- 关键 flag：--add-dir（可重复，附加上下文根）、--model（选模型，值来自 agy models）、--conversation <id>（恢复会话）、--continue（恢复最近）、--mode plan|accept-edits（执行模式）、--effort low|medium|high（推理强度，≥1.1.5）、--dangerously-skip-permissions、--sandbox、--print-timeout（默认 5m）、--max-turns 不存在（Hermes 文档明说无 --max-turns、无 --output-format json、无结果信封）。来源：[Hermes 技能文档](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli)、[atomr-agents vendored 源码](https://docs.rs/atomr-agents-coding-cli-vendor-antigravity/latest/src/atomr_agents_coding_cli_vendor_antigravity/command.rs.html)、[桥源码](https://github.com/EstebanForge/pi-antigravity-bridge)。
- 模型列表：'agy models' 子命令，输出 "<slug>  <显示名>" 两列（如 gemini-3.6-flash-high / Gemini 3.6 Flash (High)、claude-sonnet-4-6 / Claude Sonnet 4.6 (Thinking)、gpt-oss-120b-medium）。来源：src/models.ts（实测）、[Hermes 技能文档](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli)。
- 配置/数据文件位置：~/.gemini/antigravity-cli/settings.json（配置）、keybindings.json、log/cli-*.log、conversations/（SQLite 会话库，每会话一个 <uuid>.db）、brain/、history.jsonl、plugins/；MCP 配置 ~/.gemini/config/mcp_config.json（或 ~/.antigravity/mcp_config.json 新位置，Flutter 文档提到）。来源：[Hermes 技能文档](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli)、[Flutter 文档](https://docs.flutter.dev/ai/antigravity-cli)、[中文官方文档](https://www.antigravityide.cn/docs/cli/cli-using)。
- 认证：系统 keyring，无活跃会话时回退 Google Sign-In（本地自动开浏览器；SSH/远程打印授权 URL）；/logout 清除。来源：[官方 README](https://github.com/google-antigravity/antigravity-cli)。
- 安装：curl -fsSL https://antigravity.google/cli/install.sh | bash（macOS/Linux）、PowerShell/CMD 脚本、winget、Homebrew（brew install antigravity-cli）。来源：[官方 README](https://github.com/google-antigravity/antigravity-cli)、[agy-acp README](https://github.com/shindgew/agy-acp)。
- 会话内斜杠命令：/config /settings /permissions /model /keybindings /statusline /tasks /skills /mcp /open /usage /logout /agents /resume /switch /rewind /undo /rename /clear /fork /reset /new。来源：[Hermes 技能文档](https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli)。
- wrapper 命令：agy help / install / update / changelog / plugin（list/install/uninstall/enable/disable/import/validate/link）。来源：同上。
- 工作区规则：.agents/skills/、AGENTS.md、向后兼容 GEMINI.md。来源：[Flutter 文档](https://docs.flutter.dev/ai/antigravity-cli)。
- 关键外部事实（对桥很重要）：print 模式不打印 conversation id（需快照差分发现）；steps 存在 SQLite（structured protobuf records，非 stdout）——agy-acp 也是这么做的（"Steps come from agy's conversation SQLite DB (structured protobuf records), not stdout"）。来源：[agy-acp README](https://github.com/shindgew/agy-acp)、[pi-ask-antigravity README](https://github.com/EstebanForge/pi-ask-antigravity)。

---

## 11. 优缺点点评（取其精华去其糟粕）

### 优点（DSH 插件应抄的）
1. 不碰认证、不碰后端：spawn 官方 agy 二进制，OAuth/token 完全交给 agy，只读本地 SQLite——ToS 风险最低、实现最简单、无 token 泄露面。这是整个方案的灵魂。
2. 真流式：并发轮询 + data_version 合并 + 原地增长增量发射 + trailing polls，工程细节扎实，避免"等退出再回放"的假流式。
3. 不依赖解析 stdout：print 模式 stdout 只有最终文本（没有结构化事件），从 SQLite 拿结构化 step 才有 thinking/tool/文本分开的能力——这是"chat 支持输出、工具调用、思考过程"的关键决策，DSH 必须照搬。
4. 多轮/会话绑定设计：sessions.json 原子写 + dirty-key 合并（多进程安全）、lastStepIdx 续读防重放、message watermark 算 pi 侧 delta digest——多轮一致性考虑周全。
5. 模型发现与投影：agy models 动态发现 + 回退目录 + TTL 缓存 + slug 化 + effort 折叠映射，用户无感。
6. 权限与安全默认值：--dangerously-skip-permissions 是实测必需的（否则挂死），但文档明确警告、提供 plan 模式、提供 construct-cli 沙箱建议；MCP 桥的 token/CSRF/body cap/进程树清理/补丁原子性都很讲究。
7. 诚实文档：明确写"做不到什么"（无 diff 审阅、无 token 计数、ToS 灰色）、GAPS 文档列出开放缺口和废弃点子，避免后续者踩坑。
8. 工程化：无原生依赖（node:sqlite）、手写 protobuf 前向兼容、测试覆盖流式与中止回归、补丁可审计可回滚。

### 缺点 / 糟粕（DSH 应规避或改进）
1. 逆向工程脆弱性：protobuf 字段号、step_type 枚举、SQLite 路径全是 agy 内部实现事实，agy 一升级就可能碎（作者自己也说字段号 load-bearing）。DSH 侧要建 agy 版本探针 + 优雅降级 + 把解码器做成可替换模块。
2. 需要打 pi 的本地补丁（pi.invokeTool）才能启用 MCP 桥：侵入全局安装的 dist/、需要整进程重启、pi 更新后要重打。对 DSH 的启示：如果 DSH 是自家内核，应直接把 invokeTool 这类能力做成正式 API，避免打补丁。
3. 安全模型：默认 --dangerously-skip-permissions 意味着 agy 可无审阅跑任意命令；MCP 桥的 token 在同用户进程间可读。作者自己承认只适合单用户开发机。
4. 无 token/成本统计：usage 恒 0，用户无法做成本核算（agy 不暴露，无解，但 DSH 要意识到）。
5. 体验割裂：agy 的编辑不经过 pi 的 diff 审阅（自研 diff 只是 thinking 流里的文本补丁）；工具调用只显示名字看不到参数细节；长工具调用无进度（G1 未闭合，卡在 pi 补丁上）。
6. 发现延迟/并发歧义：会话 id 靠快照差分 + /proc fd 扫描，多 agy 并发时可能拒绝绑定导致整轮失败（fail-safe 但体验差）；Linux-only 消歧。
7. 生态幼小：2 stars、0 forks、下载量小、作者单人维护（actitud.xyz 个人项目），风险自担。
8. 跨扩展"接管"：与 pi-ask-antigravity 的冲突靠 Symbol 标志 + 包探测这种脆弱的隐式协议解决。

### 对 DSH 插件的落地建议（基于以上全部事实）
- 复用同一集成形态：spawn agy + 轮询 ~/.gemini/antigravity-cli/conversations/<id>.db + 解码 step_payload（15=文本/14=thinking/工具类型集/23=标题），事件映射到 DSH 的流协议（text/thinking/tool 三通道）。
- 把会话绑定、baseStepIdx 续读、delta digest、diff 渲染这些"多轮一致性"方案照搬。
- 把补丁问题内化：DSH 的 model 配置若能直接声明"自定义 provider 脚本"就不需要打补丁；工具桥用官方 MCP server 能力（DSH 若有 MCP 支持则天然打通，不需要 invokeTool 补丁）。
- 默认权限策略做成显式三态（plan/approve/skip）并加沙箱提示；提供 usage 估算兜底。
- 建立 agy 版本检测 + 解码失败降级（fallback 目录 + 明确报错）。

---

## 12. 参考资料（URL 汇总）

**主对象**
- 包页面：https://pi.dev/packages/@estebanforge/pi-antigravity-bridge
- npm：https://www.npmjs.com/package/@estebanforge/pi-antigravity-bridge
- npm 元数据：https://registry.npmjs.org/@estebanforge/pi-antigravity-bridge
- GitHub 仓库：https://github.com/EstebanForge/pi-antigravity-bridge
- 源码（npm tarball 解包阅读）：https://registry.npmjs.org/@estebanforge/pi-antigravity-bridge/-/pi-antigravity-bridge-1.2.4.tgz

**关联扩展**
- pi-ask-antigravity：https://github.com/EstebanForge/pi-ask-antigravity 、https://pi.dev/packages/@estebanforge/pi-ask-antigravity
- construct-cli：https://github.com/EstebanForge/construct-cli
- pi（宿主）：https://github.com/earendil-works/pi
- pi 扩展官方文档：https://mintlify.wiki/pt-act/pi-mono/concepts/extensions
- pi 扩展加载机制（第三方）：https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md 、https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md

**agy CLI**
- 官方仓库：https://github.com/google-antigravity/antigravity-cli
- 官方 README：https://github.com/google-antigravity/antigravity-cli/blob/main/README.md
- 官方文档（Getting Started / Install / Headless）：https://antigravity.google/docs/cli/getting-started 、https://antigravity.google/docs/cli/install 、https://www.antigravity.google/docs/cli/headless
- Flutter 镜像文档：https://docs.flutter.dev/ai/antigravity-cli
- 中文镜像（配置/键位/命令）：https://www.antigravityide.cn/docs/cli/cli-using
- Hermes 技能文档（非交互模式最全）：https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli
- agy-acp（ACP 适配器，同款 SQLite 方案）：https://github.com/shindgew/agy-acp 、npm https://www.npmjs.com/package/agy-acp
- antigravity-acp：https://github.com/shubzkothekar/antigravity-acp
- 上游 issues：#318（-p 模式权限提示挂起）https://github.com/google-antigravity/antigravity-cli/issues/318 、#36（sandbox+skip-permissions）https://github.com/google-antigravity/antigravity-cli/issues/36
- ToS：https://antigravity.google/terms
- 第三方 vendored 源码（命令参数）：https://docs.rs/atomr-agents-coding-cli-vendor-antigravity/latest/src/atomr_agents_coding_cli_vendor_antigravity/command.rs.html

**社区**
- awesome-pi-coding-agent：https://github.com/shaftoe/awesome-pi-coding-agent

---

*报告完。调研基于 npm 1.2.4 tarball 全量源码精读 + 官方/第三方文档交叉验证；源码级论断（函数名/字段号/文件路径）均可在 GitHub 仓库对应文件复核。*