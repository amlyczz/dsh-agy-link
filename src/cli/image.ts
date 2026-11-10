// `dsh-agy-image` — generate an image through agy's built-in `generate_image`
// tool without an interactive DSH session (headless-friendly). Spec:
// .spec/image.md.
//
// Architecture: this CLI does NOT spawn agy on its own. It instantiates the
// plugin's real `AgyAdapter` with `purpose:'image'`, which is the same route a
// normal turn uses — account pool selection, quota cooldown/rotation, proxy,
// failure classification, model/effort resolution and the retry-on-effort
// refusal all come from that one implementation. The adapter hands raw agy
// events back through `agyOnEvent`; the shared `ImageService` turns them into a
// validated artifact.
import { readFileSync, realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig, stateDir } from '../common/config.ts'
import { PROVIDER_ID, type AgyEvent, type PermissionMode } from '../common/types.ts'
import {
  ImageService,
  buildImageAgentPrompt,
  imageSummary,
  normalizeImageName,
  type ImageAgentCall,
  type ImageAgentResult,
  type ImageAgentToolCall,
  type ImageRequest,
  type ImageResult,
} from '../host/image.ts'
import { AgyAdapter } from '../host/adapter.ts'
import { ModelCatalog } from '../host/models.ts'
import { AccountPoolManager } from '../host/pool.ts'
import { RunRegistry } from '../host/recording.ts'
import { SessionStore } from '../host/sessions.ts'
import { resolveAgyBin } from '../host/runner.ts'

const USAGE = `dsh-agy-image — 用 agy 内置的 generate_image 生成图片（无需交互式会话）

用法：
  dsh-agy-image -p "<画面描述>" [选项]

必填：
  -p, --prompt <text>        画面描述（原样传给 generate_image.Prompt）

可选：
  -n, --name <stem>          产物文件名主干（默认 agy-image-<时间戳>）
  -a, --aspect-ratio <w:h>   1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 4:5 | 5:4 | 9:16 | 16:9 | 21:9 | 1:8 | 8:1 | 1:4 | 4:1
  -i, --image, --ref <path>  参考图/源图（可重复；用于改图）
  -o, --out <path>           把成图复制到该路径（或目录）
      --model <id>           驱动调用的模型（默认跟随插件配置）
      --effort <level>       思考档（默认 low）
      --timeout <seconds>    整次生成超时（默认 240）
      --permission-mode <m>  skip | plan | accept-edits（默认跟随插件配置）
      --max-bytes <n>        接受的最大产物字节数（默认 20MiB）
      --json                 输出结构化 JSON（含 ok/path/width/height/mime/...）
      --force                忽略本进程内的结果缓存，重新生成
      --dry-run              只打印将要发给 agy 的桥接提示词
      --quiet                不打印附加信息
  -h, --help                 本说明
  -V, --version              版本

示例：
  dsh-agy-image -p "一只戴墨镜的柴犬，扁平插画风" -a 16:9 -o ./dog.jpg
  dsh-agy-image -p "把背景换成夜晚" -i ./day.png -n night_scene --json

账号池：与 DSH 主流程共用 ~/.dsh/agy-accounts/pool.json。额度耗尽/地区拒绝
会在重试时自动换号（与真实对话完全同一套逻辑）。

退出码：
  0 成功 · 2 参数错误 · 3 找不到 agy · 4 生成失败
  5 产物校验失败 · 6 账号/地区不可用
`

export interface ImageCliArgs {
  prompt?: string
  name?: string
  aspectRatio?: string
  imagePaths: string[]
  outPath?: string
  model?: string
  effort?: string
  timeoutSeconds?: number
  permissionMode?: PermissionMode
  maxBytes?: number
  json: boolean
  force: boolean
  dryRun: boolean
  quiet: boolean
  help: boolean
  version: boolean
}

const MODES: readonly PermissionMode[] = ['skip', 'plan', 'accept-edits']

/** Parse argv (without node/script). Unknown flags are a usage error. */
export function parseImageCliArgs(argv: readonly string[]): ImageCliArgs {
  const out: ImageCliArgs = { imagePaths: [], json: false, force: false, dryRun: false, quiet: false, help: false, version: false }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    const next = (): string | undefined => {
      const v = argv[++i]
      return v === undefined || v.startsWith('-') ? undefined : v
    }
    switch (tok) {
      case '-p':
      case '--prompt':
        out.prompt = next()
        break
      case '-n':
      case '--name':
        out.name = next()
        break
      case '-a':
      case '--aspect-ratio':
      case '--ratio':
        out.aspectRatio = next()
        break
      case '-i':
      case '--image':
      case '--ref':
      case '--reference': {
        const v = next()
        if (v !== undefined) out.imagePaths.push(v)
        break
      }
      case '-o':
      case '--out':
      case '--output':
        out.outPath = next()
        break
      case '--model':
        out.model = next()
        break
      case '--effort':
        out.effort = next()
        break
      case '--timeout': {
        const v = Number(next())
        if (Number.isFinite(v) && v > 0) out.timeoutSeconds = v
        break
      }
      case '--permission-mode': {
        const v = next()
        if (v !== undefined && (MODES as readonly string[]).includes(v)) out.permissionMode = v as PermissionMode
        break
      }
      case '--max-bytes': {
        const v = Number(next())
        if (Number.isFinite(v) && v > 0) out.maxBytes = v
        break
      }
      case '--json':
        out.json = true
        break
      case '--force':
        out.force = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--quiet':
      case '-q':
        out.quiet = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '-V':
      case '--version':
        out.version = true
        break
      default:
        throw new Error('unknown argument: ' + tok)
    }
  }
  return out
}

function toRequest(args: ImageCliArgs): ImageRequest {
  return {
    prompt: args.prompt ?? '',
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.aspectRatio === undefined ? {} : { aspectRatio: args.aspectRatio }),
    ...(args.imagePaths.length === 0 ? {} : { imagePaths: args.imagePaths }),
    ...(args.outPath === undefined ? {} : { outPath: args.outPath }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.timeoutSeconds === undefined ? {} : { timeoutMs: Math.round(args.timeoutSeconds * 1000) }),
    ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
    ...(args.maxBytes === undefined ? {} : { maxBytes: args.maxBytes }),
    ...(args.force ? { force: true } : {}),
  }
}

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** One JSON line the CLI always prints, so scripts never parse prose. */
export function jsonOf(res: ImageResult): string {
  return JSON.stringify(res)
}

function exitCodeFor(res: ImageResult): number {
  switch (res.code) {
    case undefined:
      return res.ok ? 0 : 4
    case 'BAD_PARAMS':
    case 'EMPTY_PROMPT':
      return 2
    case 'AGY_NOT_INSTALLED':
      return 3
    case 'IMAGE_INVALID':
    case 'IMAGE_NOT_FOUND':
    case 'IMAGE_ASPECT_MISMATCH':
      return 5
    case 'NO_ACCOUNT':
    case 'IMAGE_REGION_UNSUPPORTED':
    case 'AGY_AUTH':
      return 6
    default:
      return 4
  }
}

interface AdapterLike {
  stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

function toolCallFrom(ev: AgyEvent): ImageAgentToolCall | null {
  if (ev.kind !== 'step' || ev.tool === undefined) return null
  return {
    name: ev.tool.name,
    ...(ev.tool.args === undefined ? {} : { args: ev.tool.args }),
    ...(ev.tool.output === undefined ? {} : { output: String(ev.tool.output) }),
    ...(ev.tool.error === undefined ? {} : { error: ev.tool.error }),
  }
}

function subagentsFrom(ev: AgyEvent): Array<{ conversationId?: string; logUri?: string }> {
  if (ev.kind !== 'step') return []
  const raw = ev.raw as { subagent_info?: { subagents?: unknown[] } } | undefined
  const list = raw?.subagent_info?.subagents
  if (!Array.isArray(list)) return []
  const out: Array<{ conversationId?: string; logUri?: string }> = []
  for (const d of list) {
    const one = d as { conversation_id?: unknown; log_uri?: unknown }
    out.push({
      ...(typeof one.conversation_id === 'string' ? { conversationId: one.conversation_id } : {}),
      ...(typeof one.log_uri === 'string' ? { logUri: one.log_uri } : {}),
    })
  }
  return out
}

/**
 * One image attempt through the real adapter. This is the only place that
 * knows how to turn an `AgyAdapter` stream into the service's event contract.
 */
async function runViaAdapter(adapter: AdapterLike, call: ImageAgentCall): Promise<ImageAgentResult> {
  const started = Date.now()
  const toolCalls: ImageAgentToolCall[] = []
  const subagents: Array<{ conversationId?: string; logUri?: string }> = []
  const textParts: string[] = []
  let responseText = ''
  let conversationId: string | undefined
  let home: string | undefined
  let accountId: string | undefined
  let failure: { code?: string; message?: string } | null = null
  let timedOut = false
  const controller = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, call.timeoutMs)
  timer.unref?.()
  const signal = call.signal === undefined ? controller.signal : AbortSignal.any([call.signal, controller.signal])

  const options = {
    provider: PROVIDER_ID,
    model: call.model,
    ...(call.effort === '' ? {} : { reasoningEffort: call.effort }),
    // The adapter's image route uses `agyImagePrompt` verbatim; the message is
    // still provided so the shared prompt plumbing has a well-formed shape.
    messages: [{ role: 'user', content: [{ type: 'text', text: call.prompt }], source: { kind: 'user' } }],
    maxTokens: 4096,
    purpose: 'image',
    signal,
    agyImagePrompt: call.prompt,
    agyPermissionMode: call.permissionMode,
    agyOnAccount: (info: { id?: string; home?: string }) => {
      if (typeof info.id === 'string') accountId = info.id
      if (typeof info.home === 'string' && info.home !== '') home = info.home
    },
    agyOnEvent: (ev: AgyEvent) => {
      if (ev.kind === 'init' && ev.conversationId !== undefined) conversationId = ev.conversationId
      if (ev.kind === 'step') {
        if (ev.stepKind === 'text' && ev.text !== '') textParts.push(ev.text)
        const tc = toolCallFrom(ev)
        if (tc !== null) toolCalls.push(tc)
        for (const s of subagentsFrom(ev)) subagents.push(s)
      }
      if (ev.kind === 'result') {
        if (ev.conversationId !== '') conversationId = ev.conversationId
        if (ev.response !== '') responseText = ev.response
        const err = (ev.raw as { result?: { error?: unknown } } | undefined)?.result?.error
        if (typeof err === 'string' && err !== '') failure = { message: err }
      }
    },
  } as unknown as Record<string, unknown>

  try {
    for await (const chunk of adapter.stream(options as unknown as GenerateOptions)) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') textParts.push(chunk.text)
      if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          failure = {
            ...(typeof reason.failure?.code === 'string' ? { code: reason.failure.code } : {}),
            ...(typeof reason.failure?.message === 'string' ? { message: reason.failure.message } : {}),
          }
        }
      }
    }
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown }
    const message = typeof err.message === 'string' ? err.message : String(e)
    // "All Antigravity accounts are unavailable" is a pool state, not a model
    // error: classify it as a quota failure so the CLI reports NO_ACCOUNT.
    const code = typeof err.code === 'string'
      ? err.code
      : /accounts are unavailable|no account/i.test(message)
        ? 'RATE_LIMIT'
        : undefined
    failure = {
      ...(code === undefined ? {} : { code }),
      message,
    }
  } finally {
    clearTimeout(timer)
  }

  const text = (textParts.join('\n').trim() || responseText).trim()
  if (failure !== null) {
    const code = timedOut ? 'TIMEOUT' : (failure.code ?? 'AGY_ERROR')
    return {
      ok: false,
      text,
      toolCalls,
      subagents,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(home === undefined ? {} : { home }),
      ...(accountId === undefined ? {} : { accountId }),
      code,
      error: timedOut ? 'timed out after ' + call.timeoutMs + 'ms' : (failure.message ?? 'image generation failed'),
      durationMs: Date.now() - started,
    }
  }
  return {
    ok: true,
    text,
    toolCalls,
    subagents,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(home === undefined ? {} : { home }),
    ...(accountId === undefined ? {} : { accountId }),
    durationMs: Date.now() - started,
  }
}

/** Build the real adapter (same deps as the smoke scripts / host). */
export function createImageAdapter(cfg: ReturnType<typeof resolveConfig>, log?: (m: string) => void): AgyAdapter {
  return new AgyAdapter({
    getConfig: () => cfg,
    // Image generation never needs the model picker; a static catalog keeps the
    // CLI from spawning `agy models` just to validate an explicit model id.
    catalog: new ModelCatalog(async () => {
      throw new Error('model discovery is disabled for the image CLI')
    }, cfg.fallbackModels, 300_000),
    store: new SessionStore(join(stateDir(), 'cli-image-sessions.json')),
    pool: new AccountPoolManager(),
    bin: () => resolveAgyBin(cfg),
    acquire: () => Promise.resolve(() => undefined),
    runs: new RunRegistry(),
    log: (m: string) => log?.(m),
  })
}

export async function runImageCli(argv: readonly string[]): Promise<number> {
  let args: ImageCliArgs
  try {
    args = parseImageCliArgs(argv)
  } catch (e) {
    process.stderr.write(String(e instanceof Error ? e.message : e) + '\n\n' + USAGE)
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.version) {
    process.stdout.write(packageVersion() + '\n')
    return 0
  }
  if (args.prompt === undefined || args.prompt.trim() === '') {
    process.stderr.write('missing --prompt\n\n' + USAGE)
    return 2
  }
  const req = toRequest(args)
  if (args.dryRun) {
    const name = normalizeImageName(args.name, Date.now())
    const refs = (args.imagePaths ?? []).map((p) => resolvePath(p))
    process.stdout.write(
      buildImageAgentPrompt({
        prompt: args.prompt,
        name,
        ...(args.aspectRatio === undefined ? {} : { aspectRatio: args.aspectRatio }),
        ...(refs.length === 0 ? {} : { imagePaths: refs }),
      }) + '\n',
    )
    return 0
  }

  const cfg = resolveConfig(undefined)
  // No DSH session backs the CLI: pin the workspace so the adapter does not
  // warn about an unresolved session cwd and agy runs somewhere predictable.
  if (cfg.workspaceRoot === '') cfg.workspaceRoot = process.cwd()
  const bin = resolveAgyBin(cfg)
  const adapter = createImageAdapter(cfg, args.quiet ? undefined : (m) => process.stderr.write('[agy] ' + m + '\n'))
  const service = new ImageService({
    cfg: () => cfg,
    bin: () => bin,
    run: (call) => runViaAdapter(adapter, call),
    ...(args.quiet ? {} : { log: (m: string) => process.stderr.write('[image] ' + m + '\n') }),
  })

  let res: ImageResult
  try {
    res = await service.generate(req)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'AGY_ERROR', error: message, prompt: req.prompt }) + '\n')
    } else {
      process.stderr.write('image generation failed: ' + message + '\n')
    }
    return 4
  }
  if (args.json) {
    process.stdout.write(jsonOf(res) + '\n')
  } else if (res.ok) {
    process.stdout.write(res.path + '\n')
    if (!args.quiet) {
      process.stderr.write(imageSummary(res).split('\n').slice(1).join('\n') + '\n')
    }
  } else {
    process.stderr.write('image generation failed: ' + (res.error ?? 'unknown error') + '\n')
    if (res.code !== undefined) process.stderr.write('code: ' + res.code + '\n')
  }
  return exitCodeFor(res)
}

/** True when this module is the CLI entry (works through npm bin symlinks). */
function isCliEntry(): boolean {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isCliEntry()) {
  runImageCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + '\n')
      process.exitCode = 1
    })
}
