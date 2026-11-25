# dsh-agy-link spec 索引（唯一事实源）

本目录是 `dsh-agy-link` 的唯一规格真相源。每个维度文件只回答一类正交问题，随代码改动在同一提交原地演进，不在别处维护第二份，也不建日期快照。

| 文件 | 维度职责 | 何时阅读 |
| --- | --- | --- |
| [domain-model.md](domain-model.md) | **统一语言**：账号池、配额族/模型桶、族冷却 vs 模型暂停、粘性指针、局部轮换、能力域与 UI 映射 | 改动调度/配额/UI 前先读；跨模块命名有疑问时 |
| [quota-and-risk-control.md](quota-and-risk-control.md) | 风控防封号第一原则、CLI 优先配额采集与预热、消费级单一端点、Proto3 零值解析与 `TOS_VIOLATION` 熔断 | 修改预热、配额轮询、OAuth/HTTP 请求头、号池风控与封号保护时 |
| [credential-lifecycle.md](credential-lifecycle.md) | OAuth 凭据唯一写入器、跨平台钥匙串同步、零误判 `authRequired` 规则、结构化异常态与外部进程凭据租约 | 修改登录、导入、token 续期、Windows 凭据槽、外部租约或鉴权失败分类时 |
| [model-capabilities.md](model-capabilities.md) | 模型与档位唯一定义、`agy models` 发现与防伪兜底、切号后 DSH 会话模型选择器实时同步与档位自愈 | 修改模型目录、Argon 权限判定、账号切换、选择器广播或 `--effort` 逻辑时 |
| [security-hardening.md](security-hardening.md) | MCP 反向桥接、HTTP 路由体上限、外部租约路由校验、本地媒体/文件打开路由边界、日志脱敏、Plan 模式只读与 Protobuf 解析边界 | 修改 HTTP 路由、文件/终端打开、MCP 桥、诊断脱敏或二进制解析时 |
| [process-lifecycle.md](process-lifecycle.md) | `agy` 子进程活动看门狗、后台任务 idle 收敛、轮次上限与 Windows 自更新闪窗抢占 | 修改 `agy` 进程启动、超时看门狗、stderr 过滤或无头权限诊断时 |
| [http-request-deadlines.md](http-request-deadlines.md) | 客户端与宿主路由超时常量体系、非阻塞同步与长任务 deadline 对齐 | 修改客户端 API 调用、UI busy 状态或宿主异步路由包装时 |
| [context-budget.md](context-budget.md) | 发给 `agy` 的上下文预算：四条投递路径、字节上限与 8:2 掐头去尾策略 | 修改 prompt 组装、历史摘要或大消息截断时 |
| [cache-and-usage.md](cache-and-usage.md) | ACP 缓存命中/上下文占用的计算口径、agy 1.5.x usage 形状、冷启动归因与每轮缓存日志 | 修改 usage 上报、上下文圆环、辅助调用工作区、切模型或换号策略时 |
| [translation.md](translation.md) | 人话翻译：`/tsl` 入口、译文持久记录卡片、自动后处理与额度切号 | 修改翻译服务、`/tsl` 命令或客户端译文条时 |
| [btw.md](btw.md) | 旁路提问：`/atw` 顶级快捷命令、非阻塞只读问答流、工具步骤、追问线程与输入框上方 `BtwDock` 卡片 | 修改 `/atw` 服务、命令、HTTP 流路由或 `BtwDock` UI 时 |
| [image.md](image.md) | 生图：`generate_image` 桥接、`dsh-agy-image` CLI、产物魔数/比例校验与失败分类 | 修改生图服务或 `dsh-agy-image` CLI 时 |
| [subagent-activity.md](subagent-activity.md) | 子代理活动镜像：`transcript.jsonl` 增量 tail、去重与看门狗保活 | 修改 `SubagentTracker` 或子代理思考流展示时 |
| [client-scanner.md](client-scanner.md) | 客户端 DOM 扫描预算、流式指纹可恢复性与全屏控制台浮层防闪屏契约 | 修改前端 DOM 扫描器、图片增强、样式或控制台弹层时 |
| [ui-visibility.md](ui-visibility.md) | UI 可见性开关：会话头徽标与单条翻译按钮的 opt-out 语义及窄屏降级 | 修改顶栏状态胶囊或设置页界面开关时 |
| [testing.md](testing.md) | **测试策略**：两级双环节奏、领域目录划分规则、单文件预算与门禁命令 | 改测试结构、加目录、调 CI 门禁或改 `test:fast` 映射时 |
