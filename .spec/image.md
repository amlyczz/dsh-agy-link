# 生图（agy `generate_image` 桥接：`dsh-agy-image` CLI）

> 维度：**生图**。只回答这一件事：插件如何把 agy 内置的 `generate_image` 变成 headless 可用的 CLI，以及如何复用现有 Adapter/号池、校验产物、分类失败。

## 1. 目标与边界

- 目标：
  1. headless 用户不进交互式会话，也能用 `dsh-agy-image` 生成图片，并拿到**经过校验**的产物与元数据；
  2. 对话内通过 `agy_image` DSH 工具（受 `imageTool` 开关控制）与 `/agy image`（别名 `/agy img`）斜杠命令提供同等生图/改图能力，并适配新版 `image-generator` 子代理卡片预览（`src/client/toolview/card-model.ts`）。
- **不提供 HTTP API**：不再另开 `/plugins/agy-link/image` 路由；CLI（`dsh-agy-image`）、工具（`agy_image`）与斜杠命令（`/agy image`）全部共享同一个 `ImageService`。
- **不另写 spawn/选号**：全部通过 `ImageService` + `runViaAdapter`（`src/features/image/adapter-runner.ts`）驱动真实的 `AgyAdapter`（`purpose:'image'`），账号选择、额度冷却、换号、代理、失败分类、`--effort` 被拒重放全部复用主流程。
- 形态：agy CLI 没有「直接调某个工具」的 RPC，只能**桥接 + 提示词**让模型调用 `generate_image`；提示词负责“让工具被调用且参数不被改写”，代码负责“产物必须真的是图、尺寸能读、比例对得上”。
- 不做：文生视频 / 音乐 / 音频（agy 无内置工具）；像素级尺寸（图片模型只按比例出图）。

## 2. CLI `dsh-agy-image`

安装插件即随包安装（`package.json` 的 `bin`）。单文件 ESM，内置打包 `@deepseek-ai/dsh-llm`，因此能在 DSH 进程外驱动同一个 Adapter。

```
-p, --prompt <text>          必填，原样传给 generate_image.Prompt
-n, --name <stem>            产物文件名主干（默认 agy-image-<ts>）
-a, --aspect-ratio <w:h>     1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 4:5 | 5:4 | 9:16 | 16:9 | 21:9 | 1:8 | 8:1 | 1:4 | 4:1
-i, --image/--ref <path>     参考图 / 改图源（可重复）
-o, --out <path>             把成图复制到该路径（或目录）
    --model / --effort       覆盖驱动模型 / 思考档
    --timeout <seconds>      整次生成超时（默认 240）
    --permission-mode <m>    skip | plan | accept-edits
    --max-bytes <n>          接受的最大产物字节数
    --json / --force / --dry-run / --quiet
    -h / -V
```

退出码：`0` 成功 · `2` 参数错误 · `3` 找不到 agy · `4` 生成失败 · `5` 产物校验失败 · `6` 账号/地区不可用。

## 3. 参数与约束

- 工具实参（来自 agy `generate_image` 调用记录）：`Prompt`、`ImageName`、`AspectRatio`、`ImagePaths`。**没有像素尺寸参数**：1:1 实测 1024×1024，16:9 实测 1376×768。
- `AspectRatio` 只接受 §2 那 14 个值（agy cortex `AspectRatio` 枚举）；`normalizeAspectRatio` 兼容 `16x9` / `16/9`。
- `ImageName` 规整为安全 ASCII 主干（`[A-Za-z0-9._-]`，≤80）；CJK 被替换，避免跨平台产物名不可寻。
- `ImagePaths` 必须存在；Adapter 侧照常把目录加入 `--add-dir`。

## 4. 桥接提示词（`buildImageAgentPrompt`）

- JSON 原样列出实参，明确 **VERBATIM**：不许改写/翻译/润色 Prompt。
- 允许委派：agy 会把生图交给内置 `image-generator` 子代理，提示词要求“若必须委派，原样传参”。
- 机器可读回执：成功 `IMAGE_PATH=<绝对路径>`，失败 `IMAGE_ERROR=<错误信息>`。
- 提示词只是“让工具被调用”的手段；**可信度来自产物校验**，不来自这段文字。

## 5. 执行：复用 Adapter（关键）

`src/cli/image.ts` 构造与宿主相同的依赖（`AccountPoolManager`、`ModelCatalog`、`SessionStore`、`RunRegistry`、`resolveAgyBin`），调用：

```ts
adapter.stream({
  purpose: 'image',
  model, reasoningEffort, signal,
  messages: [user(call.prompt)],
  agyImagePrompt: bridgePrompt,      // 原样作为 agy prompt
  agyOnAccount: ({ id, home }) => …, // 用于定位该账号 HOME 下的 brain 目录
  agyOnEvent: (ev) => …,             // 收集 tool/subagent/result 证据
})
```

Adapter 新增的 `purpose:'image'` 分支（`src/host/adapter.ts`）：

- 与 `translation` 一样走 **aux 通道**（共享号池、冷却、代理、失败分类），不受 `allowAuxiliary` 限制；
- **不强制 plan 模式**（`generate_image` 是写 artifact 的工具），使用配置的 `permissionMode`；
- `agyImagePrompt` 原样作为 prompt，不混入会话上下文/工具 digest；
- `agyOnEvent` 在每个解析事件后回调；`agyOnAccount` 在选号完成后回调 `{id, home}`；
- 不做会话绑定（`isAux` 且非 translateSession），每次生图都是新 conversation。

因此：

- **额度耗尽**：Adapter 内部 `recordFailure` + 冷却 + `advanceAccount`，服务层下一次重试自然落到下一个账号。
- **地区/资格拒绝**（`ELIGIBILITY`）：Adapter `advanceAccount`，重试换号（实测主号被拒 → 自动落到支持地区的备用号成功）。
- **`--effort` 被拒**：Adapter 外层 `stream()` 已有「学到的模型 + 去掉 flag 重放一次」，CLI 不再重复实现。

服务层只保留 `imageRetries`（默认 1，最多 2 次）作为**跨调用重试**：每次 `adapter.stream` 重新选号，因此重试=换号。

## 6. 产物定位（不猜路径）

agy 1.5.4 把生成图写到：

```
<agy home>/.gemini/antigravity-cli/brain/<主会话 conversation_id>/<ImageName>_<ts>.<ext>
```

`agyOnEvent` 从 `init` 事件拿 `conversation_id`；`agyOnAccount` 给出本次使用的 HOME（主账号=系统 HOME，隔离账号=`account.dir`）。候选顺序：

1. 回复里的 `IMAGE_PATH=`
2. 文本 / 工具输出中提取的绝对图片路径（含 POSIX `/`、`~/`、Windows `C:\...`、WSL `\\wsl...` 及 `file://`，支持 `.png/.jpg/.jpeg/.webp/.gif/.bmp`）
3. 扫描上述 brain 目录中本次运行开始后新增的图片（`mtime >= start - 2s`），按时间倒序

逐个校验，第一个通过者胜出（`copyArtifact` 在 `source === target` 时保持幂等）。

## 7. 产物校验（硬门槛）

| 检查 | 失败 code |
| --- | --- |
| 文件存在且是普通文件、非空 | `IMAGE_NOT_FOUND` / `IMAGE_INVALID` |
| 大小 ≤ `imageMaxBytes`（默认 20 MiB） | `IMAGE_INVALID` |
| 魔数识别 PNG / JPEG / WebP / GIF / BMP（自实现，不引依赖） | `IMAGE_INVALID` |
| 宽高 > 0（PNG IHDR / JPEG SOF / GIF / WebP VP8/VP8L/VP8X / BMP） | `IMAGE_INVALID` |
| 请求了 `AspectRatio` 时，`w/h` 与目标比例误差 ≤ 3% | `IMAGE_ASPECT_MISMATCH` |

`--out` 在校验通过后复制（目录则拼 basename）；`imageOutputDir` 提供默认复制目录，复制失败时保留原 artifact 路径。

## 8. 失败分类与重试

- Adapter 返回的 finish 码直接映射：`ELIGIBILITY → IMAGE_REGION_UNSUPPORTED`、`RATE_LIMIT/QUOTA → NO_ACCOUNT`、`AUTH → AGY_AUTH`、`TIMEOUT → TIMEOUT`，其余 `AGY_ERROR`。
- 服务层仅对 `IMAGE_NOT_FOUND / TIMEOUT / NO_ACCOUNT / IMAGE_REGION_UNSUPPORTED / AGY_ERROR` 重试；`BAD_PARAMS / IMAGE_INVALID / IMAGE_ASPECT_MISMATCH` 不重试。
- 地区限制是**账号/出口级**的，不是模型 bug：同一个 prompt 在支持地区可用，不支持地区会被 Google 直接 400；换号/换代理即可。

## 9. 配置

| 键 | 默认 | env |
| --- | --- | --- |
| `imageTool` | `true`（注册 `agy_image` 对话工具） | `DSH_AGY_IMAGE_TOOL` |
| `imageModel` | `''`（→ defaultModel → 已发现 `gemini-4-hydrogen` 时优先选它，否则回退 `gemini-3.8-flash`） | `DSH_AGY_IMAGE_MODEL` |
| `imageEffort` | `medium` | `DSH_AGY_IMAGE_EFFORT` |
| `imageTimeoutMs` | `240000` | `DSH_AGY_IMAGE_TIMEOUT_MS` |
| `imageMaxBytes` | `20971520` | `DSH_AGY_IMAGE_MAX_BYTES` |
| `imageOutputDir` | `''` | `DSH_AGY_IMAGE_OUTPUT_DIR` |
| `imageRetries` | `1` | `DSH_AGY_IMAGE_RETRIES` |

## 10. 测试锚点

- `test/features/image/image.test.ts`：比例解析、文件名规整、提示词参数与回执契约、`IMAGE_PATH/IMAGE_ERROR` 解析、文本路径提取（不误抓 URL）、PNG/JPEG/GIF/WebP 头解析、比例容差、brain 目录发现、显式路径优先、`--out` 复制、地区错误→重试→`IMAGE_REGION_UNSUPPORTED`、比例不符、非图片产物、缺产物、参数先校验不 spawn、`--effort` 被拒后降级、CLI argv、`resolveImageTarget` 默认优先 `gemini-4-hydrogen` + `medium`。
- `test/features/image/slash-bridge-and-image-tool.test.ts`：`agy_image` 工具执行与校验失败抛出、`/agy image` 命令引号/参数分词与错误提示。
- `test/provider/adapter-*.test.ts`：`purpose:'image'` 的 prompt 原样、权限模式不被强制 plan、`agyOnEvent/agyOnAccount` 回调。
- 真机：`node dist/cli-image.mjs -p … -a 16:9 -o /tmp/x.jpg`（会花额度）。

## 11. 已知取舍

- 提示词无法 100% 强制模型“原样使用 Prompt”：主 agent 可能委派给 `image-generator` 子代理并由它重写描述。**可验证的是产物结构**（图/宽高/比例/命名/大小），不是“模型是否逐字用了你的描述”。
- 产物落在 agy 的 brain artifacts，不在工作区；需要落项目请用 `--out` 或 `imageOutputDir`。
- 生图通常 20–60 秒；这是 agy 启动 + 图片模型本身的成本。
- CLI 单文件约 1.3 MB：为了在 DSH 进程外复用 Adapter，`@deepseek-ai/dsh-llm` 被内置打包；这是「复用主流程」的代价，优于复制一套选号/重试逻辑。
- 不做进度流：完成后一次性返回。
