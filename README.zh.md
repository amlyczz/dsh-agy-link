# dsh-agy-link（简体中文）

把 **Google Antigravity 模型接入 [DeepSeek Harness (DSH)]** —— 由官方
`agy` CLI 驱动，完整支持对话输出、思考（thinking）、工具活动与 token
用量，全部走你的 Antigravity 订阅。

[English](README.md) | 简体中文

## 你能得到什么

- **模型路由而非代理** —— 在 DSH 模型配置里注册 `antigravity` 提供方，
  `/model` 选择器里直接挑任意 Antigravity 模型。
- **完整流式输出** —— 文本、思考、agy 工具活动（注记为 reasoning 块），
  全部映射到 DSH 原生流协议。
- **会话连续性** —— 每个 DSH 会话绑定原生 agy 会话（`--conversation`），
  多轮上下文由 agy 自己的历史承载，不重发全量。
- **token 用量** —— 输入/输出/思考/缓存 token 全部进入 DSH 用量统计。
- **GUI 内 Google 登录** —— `/agy auth` 打印授权 URL；侧栏面板提供
  二维码 + 授权码粘贴框。
- **`agy_ask` 工具** —— 任何 DSH 模型都可以把一次性任务委托给
  Antigravity 模型（AskAntigravity 模式）。
- **`/agy` 命令族** —— `status` / `auth` / `auth-code` / `models` /
  `mode` / `effort` / `clear` / `doctor` / `help`。
- **休眠安全** —— 没装 agy？没登录？插件照常加载并告诉你怎么修。

## 环境要求

- DSH（DeepSeek Harness）web profile
- Node.js >= 24
- 官方 `agy` CLI >= 1.1.8，已安装并在 `PATH` 上

## 安装

```bash
dsh plugin --profile web add dsh-agy-link
```

重启 DSH，在 GUI 里执行 `/agy status`。

## 登录（一次性）

1. `/agy auth` —— 打印 Google 授权 URL。
2. 打开链接、批准访问、复制授权码。
3. `/agy auth-code <授权码>` —— 或用侧栏面板（二维码 + 粘贴框）。

插件绝不读取/复制/移动
`~/.gemini/antigravity-cli/antigravity-oauth-token`；登录完全通过官方
CLI 自己的流程完成。

## 配置

配置在 `agy-link` 插件条目里（`/plugin` 或 profile patch 层编辑）。
环境变量优先于文件：

| 键 | 环境变量 | 默认值 | 含义 |
| --- | --- | --- | --- |
| enabled | `DSH_AGY_ENABLED` | `true` | 总开关 |
| agyBin | `DSH_AGY_BIN` | 自动 | 显式 agy 路径 |
| permissionMode | `DSH_AGY_MODE` | `skip` | `skip` / `plan` / `accept-edits`（见下） |
| defaultModel | `DSH_AGY_DEFAULT_MODEL` | `(agy 默认)` | 模型 slug |
| defaultEffort | `DSH_AGY_DEFAULT_EFFORT` | `(模型默认)` | `low` / `medium` / `high` |
| timeoutMs | `DSH_AGY_TIMEOUT_MS` | `600000` | 单轮看门狗 |
| extraArgs | `DSH_AGY_EXTRA_ARGS` | — | 附加 agy 参数（空格分隔） |

### 权限模式 —— 必读

agy 有**自己的**工具循环，会自己做文件编辑和 shell 执行。桥接层映射为
三种模式：

- **plan** —— 只读，体验桥接的安全默认。
- **accept-edits** —— agy 可以不经询问改文件。
- **skip** —— `--dangerously-skip-permissions`：agy **所有**工具免审批。
  非交互 DSH 轮次需要它（或 plan），因为 agy 的权限提示会卡死 print
  模式；但这意味着真实的无人值守 写/执行 权限。设置面板里这个按钮是
  红色的。

DSH 侧的工具与权限不受影响 —— 这里只约束 agy 子进程在自己工作区能做什么。

## 工作原理

一次 DSH 模型调用 = 一个短生命周期 `agy -p --output-format stream-json`
进程。NDJSON 事件流被解析、归一化并映射为 DSH StreamChunk：思考 →
reasoning 块，文本 → text 块，工具活动 → 注记 reasoning 块，结果信封 →
usage + finish。会话 id 优先取自流本身，conversations 目录快照对比作为
兜底。不逆向数据库、不解码 protobuf、不碰 token 文件。

## 已知差距

见 [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md)。要点：图片不转发（agy print
模式纯文本）；DSH 工具不暴露给 agy（MCP 反向桥接是后续工作）。

## 免责与风险提示

本插件只启动**官方未修改**的 `agy` 二进制并消费其公开 print 输出，
不解码内部数据库、不触碰 OAuth token。自动化订阅 CLI 仍可能与提供方
服务条款冲突（Google Antigravity ToS §6 语境）；风险自负，被要求停止时
请停止。

## 许可证

MIT
