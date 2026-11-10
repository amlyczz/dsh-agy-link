// agy image generation, bridged as a first-class plugin feature
// (spec: .spec/image.md).
//
// There is no direct "tool RPC" in agy's CLI: the only way to run the built-in
// `generate_image` tool is to ask the model to call it. So this module is
// deliberately prompt-driven — but everything AROUND the prompt is strict:
//
//   * the arguments are fixed (Prompt / ImageName / AspectRatio / ImagePaths),
//   * the request tells the model not to rewrite them and to report either
//     `IMAGE_PATH=` or `IMAGE_ERROR=`,
//   * the result is accepted only after the artifact is located, its magic
//     bytes prove it is really an image, its dimensions parse, and the aspect
//     ratio matches what was asked for.
//
// The artifact location is not guessed: agy saves generated images into
// `<agy home>/.gemini/antigravity-cli/brain/<main conversation id>/<name>_<ts>.<ext>`
// (verified on agy 1.5.4). We read the conversation id from the `init` event,
// prefer explicit paths found in tool output/text, and fall back to scanning
// that directory for files created during the run.
import { open, copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { Err, type PermissionMode, type PluginConfig } from '../common/types.ts'

/** Aspect ratios the agy image tool advertises (cortex `AspectRatio` enum). */
export const SUPPORTED_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  '1:8',
  '8:1',
  '1:4',
  '4:1',
] as const

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'] as const

/** How many bytes of a file are enough to identify the format and dimensions. */
const HEADER_BYTES = 512 * 1024

export type ImageFailureCode =
  | 'EMPTY_PROMPT'
  | 'BAD_PARAMS'
  | 'AGY_NOT_INSTALLED'
  | 'NO_ACCOUNT'
  | 'IMAGE_REGION_UNSUPPORTED'
  | 'IMAGE_TOOL_ERROR'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_INVALID'
  | 'IMAGE_ASPECT_MISMATCH'
  | 'AGY_AUTH'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'AGY_ERROR'
  | 'HOST_UNAVAILABLE'

export interface ImageRequest {
  /** What to draw. Passed to generate_image verbatim. */
  prompt: string
  /** File name stem for the artifact (defaults to a timestamped name). */
  name?: string
  /** One of {@link SUPPORTED_ASPECT_RATIOS}. Defaults to the model's own choice. */
  aspectRatio?: string
  /** Reference / source images for edit-style requests. */
  imagePaths?: readonly string[]
  /** Copy the finished image here (absolute, or a directory). */
  outPath?: string
  model?: string
  effort?: string
  timeoutMs?: number
  permissionMode?: PermissionMode
  /** Maximum accepted artifact size; defaults to cfg.imageMaxBytes. */
  maxBytes?: number
  /** Bypass the in-memory result cache and generate a fresh image. */
  force?: boolean
}

export interface ImageResult {
  ok: boolean
  /** Absolute path of the returned image (the copy when outPath was given). */
  path: string
  /** Where agy actually wrote it (differs from path only when copied). */
  sourcePath?: string
  uri?: string
  mime: string
  width: number
  height: number
  aspectRatio: string
  bytes: number
  name: string
  prompt: string
  model: string
  effort: string
  durationMs: number
  attempts: number
  conversationId?: string
  accountId?: string
  error?: string
  code?: ImageFailureCode
}

export interface ImageTarget {
  model: string
  effort: string
}

export interface ImageAgentCall {
  /** The fully-built bridge prompt. */
  prompt: string
  model: string
  effort: string
  permissionMode: PermissionMode
  timeoutMs: number
  /** Reference images (the adapter stages/grant access to their directories). */
  imagePaths: readonly string[]
  signal?: AbortSignal
}

export interface ImageAgentToolCall {
  name: string
  args?: unknown
  output?: string
  error?: string
}

export interface ImageAgentResult {
  ok: boolean
  text: string
  conversationId?: string
  toolCalls: ImageAgentToolCall[]
  subagents: Array<{ conversationId?: string; logUri?: string }>
  /** HOME the run used; the brain directory hangs off it. */
  home?: string
  error?: string
  /** Retry classification: ELIGIBILITY / RATE_LIMIT / QUOTA / TIMEOUT / AUTH / AGY_ERROR. */
  code?: string
  /** Account the host actually used (injected by the HTTP route). */
  accountId?: string
  durationMs: number
}

export interface ImageServiceDeps {
  cfg: () => PluginConfig
  bin: () => string | null
  run: (call: ImageAgentCall) => Promise<ImageAgentResult>
  log?: (msg: string) => void
  now?: () => number
}

export interface ImageInfo {
  mime: string
  ext: string
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Argument normalisation
// ---------------------------------------------------------------------------

/** Accept `16:9`, `16x9`, `16/9`, `16-9`; return the canonical `w:h` or null. */
export function normalizeAspectRatio(value: string | undefined): string | null {
  const raw = value?.trim()
  if (raw === undefined || raw === '') return null
  const m = /^(\d{1,2})\s*[:x/×-]\s*(\d{1,2})$/.exec(raw)
  if (m === null) return null
  const canonical = m[1] + ':' + m[2]
  return (SUPPORTED_ASPECT_RATIOS as readonly string[]).includes(canonical) ? canonical : null
}

/** Safe artifact stem: `[A-Za-z0-9._-]`, no leading dots, bounded length. */
export function normalizeImageName(value: string | undefined, now: number): string {
  const fallback = 'agy-image-' + now
  const raw = (value ?? '').trim()
  if (raw === '') return fallback
  // Keep CJK? agy sanitises names on disk; an ASCII stem is what survives
  // reliably across platforms and makes the artifact easy to find again.
  const ascii = raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  return ascii === '' ? fallback : ascii
}

export function resolveImageTarget(cfg: PluginConfig, override?: { model?: string; effort?: string }): ImageTarget {
  const model = (override?.model ?? cfg.imageModel ?? '').trim() ||
    (cfg.defaultModel ?? '').trim() ||
    'gemini-3.8-flash'
  const effort = (override?.effort ?? cfg.imageEffort ?? '').trim()
  return { model, effort }
}

/**
 * The bridge prompt. It carries the exact tool arguments as JSON, forbids
 * rewriting them, and defines the two machine-readable reply lines the parser
 * accepts. Everything else (finding/validating the artifact) is code, not
 * trust in this text.
 */
export function buildImageAgentPrompt(spec: {
  prompt: string
  name: string
  aspectRatio?: string
  imagePaths?: readonly string[]
}): string {
  const lines = [
    'Call the `generate_image` tool exactly once to create the image described below.',
    '',
    'Pass these arguments VERBATIM. Do not rewrite, translate, shorten, beautify or "improve" the Prompt:',
    '- Prompt: ' + JSON.stringify(spec.prompt),
    '- ImageName: ' + JSON.stringify(spec.name),
  ]
  if (spec.aspectRatio !== undefined && spec.aspectRatio !== '') {
    lines.push('- AspectRatio: ' + JSON.stringify(spec.aspectRatio))
  }
  if (spec.imagePaths !== undefined && spec.imagePaths.length > 0) {
    lines.push('- ImagePaths: ' + JSON.stringify(spec.imagePaths))
  }
  lines.push(
    '',
    'Use the tool yourself. If your instructions require delegating to the built-in image-generator subagent, hand it these exact arguments unchanged.',
    'Do not use any other tool. Do not edit files. Do not ask follow-up questions.',
    'When the tool returns, reply with exactly one line:',
    'IMAGE_PATH=<absolute path of the generated image>',
    'If the tool fails, reply with exactly one line:',
    'IMAGE_ERROR=<the error message>',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Reply / artifact parsing
// ---------------------------------------------------------------------------

/** `IMAGE_PATH=...` / `IMAGE_ERROR=...` from a model reply. */
export function parseImageReply(text: string): { path?: string; error?: string } {
  const out: { path?: string; error?: string } = {}
  const path = /IMAGE_PATH\s*=\s*(.+)/i.exec(text)
  if (path !== null && path[1] !== undefined) {
    const v = path[1].trim().replace(/^`|`$/g, '')
    if (v !== '') out.path = v
  }
  const error = /IMAGE_ERROR\s*=\s*(.+)/i.exec(text)
  if (error !== null && error[1] !== undefined) {
    const v = error[1].trim()
    if (v !== '') out.error = v
  }
  return out
}

const IMAGE_PATH_RE = /(?<![\w:/])(?:file:\/\/)?(?:\/|~\/)[^\s"'`<>|]+?\.(?:png|jpe?g|webp|gif)\b/gi

/** Every image path mentioned in free text (absolute or `file://`). */
export function extractImagePaths(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    let p = m[0].trim().replace(/^file:\/\//, '')
    if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    if (!isAbsolute(p)) continue
    if (seen.has(p)) continue
    seen.add(p)
    found.push(p)
  }
  return found
}

// ---------------------------------------------------------------------------
// Image sniffing (no dependency: magic bytes + a few header formats)
// ---------------------------------------------------------------------------

function u16be(b: Buffer, o: number): number {
  return b.readUInt16BE(o)
}
function u16le(b: Buffer, o: number): number {
  return b.readUInt16LE(o)
}
function u24le(b: Buffer, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)
}
function u32be(b: Buffer, o: number): number {
  return b.readUInt32BE(o)
}

/** Identify an image from its header bytes. Null = not a supported image. */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png', width: u32be(buf, 16), height: u32be(buf, 20) }
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mime: 'image/gif', ext: '.gif', width: u16le(buf, 6), height: u16le(buf, 8) }
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { mime: 'image/webp', ext: '.webp', width: u24le(buf, 24) + 1, height: u24le(buf, 27) + 1 }
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21)
      return { mime: 'image/webp', ext: '.webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { mime: 'image/webp', ext: '.webp', width: u16le(buf, 26) & 0x3fff, height: u16le(buf, 28) & 0x3fff }
    }
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: 'image/bmp', ext: '.bmp', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  }
  // JPEG: walk the marker chain until a Start-Of-Frame segment (SOF0..SOF15
  // except DHT/JPG/DAC) which carries the dimensions.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = u16be(buf, i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', ext: '.jpg', width: u16be(buf, i + 7), height: u16be(buf, i + 5) }
      }
      if (len < 2) break
      i += 2 + len
    }
  }
  return null
}

/** Read just enough of a file to identify it, then sniff. */
export async function readImageInfo(path: string): Promise<ImageInfo | null> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0)
    return sniffImage(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number)
  return (w ?? 1) / (h ?? 1)
}

/** Requested aspect ratio is satisfied within 3% (agy rounds to its own grid). */
export function aspectMatches(width: number, height: number, requested: string | undefined): boolean {
  if (requested === undefined || requested === '' || width <= 0 || height <= 0) return true
  const want = ratioValue(requested)
  const got = width / height
  return Math.abs(got - want) / want <= 0.03
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function emptyImageResult(req: ImageRequest, model: string, effort: string): ImageResult {
  return {
    ok: false,
    path: '',
    mime: '',
    width: 0,
    height: 0,
    aspectRatio: req.aspectRatio ?? '',
    bytes: 0,
    name: req.name ?? '',
    prompt: req.prompt,
    model,
    effort,
    durationMs: 0,
    attempts: 0,
  }
}

interface ValidatedImage extends ImageInfo {
  path: string
  bytes: number
}

/**
 * Generation service. Pure orchestration around one injected `run`, so the
 * CLI, the HTTP route and the tests all exercise the same argument/result
 * contract.
 */
export class ImageService {
  private readonly cache = new Map<string, ImageResult>()

  constructor(private readonly deps: ImageServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  target(override?: { model?: string; effort?: string }): ImageTarget {
    return resolveImageTarget(this.deps.cfg(), override)
  }

  /** Brain directory for a run, derived from the HOME that run actually used. */
  private artifactDir(res: ImageAgentResult): string | undefined {
    if (res.conversationId === undefined || res.conversationId === '') return undefined
    const home = res.home ?? process.env.HOME ?? homedir()
    return join(home, '.gemini', 'antigravity-cli', 'brain', res.conversationId)
  }

  /** Locate candidate artifacts: explicit paths first, then fresh files on disk. */
  private async candidates(res: ImageAgentResult, since: number): Promise<string[]> {
    const ordered: string[] = []
    const seen = new Set<string>()
    const push = (p: string): void => {
      const abs = isAbsolute(p) ? p : resolvePath(p)
      if (seen.has(abs)) return
      seen.add(abs)
      ordered.push(abs)
    }
    const reply = parseImageReply(res.text)
    if (reply.path !== undefined) push(reply.path)
    for (const p of extractImagePaths(res.text)) push(p)
    for (const call of res.toolCalls) {
      if (call.output !== undefined) for (const p of extractImagePaths(call.output)) push(p)
    }
    const dir = this.artifactDir(res)
    if (dir !== undefined && existsSync(dir)) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const fresh: Array<{ path: string; mtime: number }> = []
        for (const e of entries) {
          if (!e.isFile()) continue
          const ext = extname(e.name).toLowerCase()
          if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) continue
          const abs = join(dir, e.name)
          const st = await stat(abs)
          if (st.mtimeMs < since - 2_000) continue
          fresh.push({ path: abs, mtime: st.mtimeMs })
        }
        fresh.sort((a, b) => b.mtime - a.mtime)
        for (const f of fresh) push(f.path)
      } catch {
        // A missing/unreadable brain dir is not fatal: explicit paths still work.
      }
    }
    return ordered
  }

  private async validate(path: string, maxBytes: number, requestedRatio: string | undefined): Promise<{ ok: true; image: ValidatedImage } | { ok: false; code: ImageFailureCode; error: string }> {
    let st
    try {
      st = await stat(path)
    } catch {
      return { ok: false, code: 'IMAGE_NOT_FOUND', error: 'artifact does not exist: ' + path }
    }
    if (!st.isFile()) return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is not a regular file: ' + path }
    if (st.size === 0) return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is empty: ' + path }
    if (st.size > maxBytes) {
      return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is larger than ' + maxBytes + ' bytes: ' + st.size }
    }
    const info = await readImageInfo(path)
    if (info === null) return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is not a supported image (png/jpeg/webp/gif/bmp): ' + path }
    if (info.width <= 0 || info.height <= 0) {
      return { ok: false, code: 'IMAGE_INVALID', error: 'could not read image dimensions: ' + path }
    }
    if (!aspectMatches(info.width, info.height, requestedRatio)) {
      return {
        ok: false,
        code: 'IMAGE_ASPECT_MISMATCH',
        error: 'expected aspect ratio ' + String(requestedRatio) + ', got ' + info.width + 'x' + info.height,
      }
    }
    return { ok: true, image: { ...info, path, bytes: st.size } }
  }

  private async copyOut(source: string, outPath: string): Promise<string> {
    const abs = isAbsolute(outPath) ? outPath : resolvePath(outPath)
    let target = abs
    try {
      const st = await stat(abs)
      if (st.isDirectory()) target = join(abs, basename(source))
    } catch {
      // Not an existing path: treat it as the target file name.
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return target
  }

  private cacheKey(req: ImageRequest, target: ImageTarget): string {
    return JSON.stringify([
      target.model,
      target.effort,
      req.prompt,
      req.name ?? '',
      req.aspectRatio ?? '',
      req.imagePaths ?? [],
      req.outPath ?? '',
    ])
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const cfg = this.deps.cfg()
    const target = this.target({ ...(req.model === undefined ? {} : { model: req.model }), ...(req.effort === undefined ? {} : { effort: req.effort }) })
    const prompt = req.prompt.trim()
    if (prompt === '') return { ...emptyImageResult(req, target.model, target.effort), code: 'EMPTY_PROMPT', error: 'prompt is required' }

    let aspectRatio: string | undefined
    if (req.aspectRatio !== undefined && req.aspectRatio.trim() !== '') {
      const normalized = normalizeAspectRatio(req.aspectRatio)
      if (normalized === null) {
        return {
          ...emptyImageResult(req, target.model, target.effort),
          code: 'BAD_PARAMS',
          error: 'unsupported aspect ratio "' + req.aspectRatio + '"; supported: ' + SUPPORTED_ASPECT_RATIOS.join(', '),
        }
      }
      aspectRatio = normalized
    }
    const name = normalizeImageName(req.name, this.now())
    const refs: string[] = []
    for (const raw of req.imagePaths ?? []) {
      const abs = isAbsolute(raw) ? raw : resolvePath(raw)
      if (!existsSync(abs)) {
        return { ...emptyImageResult(req, target.model, target.effort), code: 'BAD_PARAMS', error: 'reference image not found: ' + raw }
      }
      refs.push(abs)
    }
    const bin = this.deps.bin()
    if (bin === null || bin === '') {
      return { ...emptyImageResult(req, target.model, target.effort), code: 'AGY_NOT_INSTALLED', error: 'agy binary not found — install it via https://antigravity.google/docs/cli/install' }
    }
    const cacheKey = this.cacheKey({ ...req, prompt }, target)
    const cached = this.cache.get(cacheKey)
    if (req.force !== true && cached !== undefined && cached.ok) return { ...cached, durationMs: 0, attempts: 0 }

    const maxBytes = req.maxBytes ?? cfg.imageMaxBytes
    const maxAttempts = Math.max(1, 1 + Math.round(cfg.imageRetries))
    const bridgePrompt = buildImageAgentPrompt({ prompt, name, ...(aspectRatio === undefined ? {} : { aspectRatio }), ...(refs.length === 0 ? {} : { imagePaths: refs }) })

    let last: ImageResult = { ...emptyImageResult({ ...req, name, ...(aspectRatio === undefined ? {} : { aspectRatio }) }, target.model, target.effort) }
    // Some models reject `--effort` outright; the adapter learns that, but this
    // standalone path must fall back once too (otherwise a Claude 4.6 image
    // request dies on a flag instead of generating).
    let effort = target.effort
    let effortFallbackUsed = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = this.now()
      last.effort = effort
      const res = await this.deps.run({
        prompt: bridgePrompt,
        model: target.model,
        effort,
        permissionMode: req.permissionMode ?? cfg.permissionMode,
        timeoutMs: req.timeoutMs ?? cfg.imageTimeoutMs,
        imagePaths: refs,
        ...(signal === undefined ? {} : { signal }),
      })
      last.attempts = attempt
      last.durationMs = this.now() - startedAt
      if (res.conversationId !== undefined) last.conversationId = res.conversationId

      if (!res.ok) {
        const failure = res.error ?? ''
        if (!effortFallbackUsed && effort !== '' && /--effort/i.test(failure) && /not supported/i.test(failure)) {
          // One free retry without the flag; it does not consume an attempt.
          effortFallbackUsed = true
          effort = ''
          attempt--
          continue
        }
        const code = mapAgentCode(res.code)
        last = {
          ...last,
          ok: false,
          code,
          error: res.error ?? 'image generation failed',
        }
        if (this.retryable(code) && attempt < maxAttempts) continue
        return last
      }

      // A tool-level failure can still arrive as a normal stop.
      const toolError = res.toolCalls.find((t) => t.name === 'generate_image' && t.error !== undefined && t.error !== '')
      if (toolError !== undefined) {
        last = { ...last, ok: false, code: 'IMAGE_TOOL_ERROR', error: toolError.error ?? 'generate_image failed' }
        if (attempt < maxAttempts) continue
        return last
      }
      const reply = parseImageReply(res.text)
      if (reply.error !== undefined) {
        last = { ...last, ok: false, code: 'IMAGE_TOOL_ERROR', error: reply.error }
        if (attempt < maxAttempts) continue
        return last
      }

      const list = await this.candidates(res, startedAt)
      let validated: ValidatedImage | null = null
      let firstFailure: ImageResult | null = null
      for (const candidate of list) {
        const v = await this.validate(candidate, maxBytes, aspectRatio)
        if (v.ok) {
          validated = v.image
          break
        }
        if (firstFailure === null && v.code !== 'IMAGE_NOT_FOUND') {
          firstFailure = { ...last, ok: false, code: v.code, error: v.error }
        }
      }
      if (validated === null) {
        last = firstFailure ?? {
          ...last,
          ok: false,
          code: 'IMAGE_NOT_FOUND',
          error: list.length === 0
            ? 'the agent finished but no generated image was found (did it call generate_image?)'
            : 'no valid image artifact among: ' + list.join(', '),
        }
        if (this.retryable(last.code) && attempt < maxAttempts) continue
        return last
      }

      let finalPath = validated.path
      if (req.outPath !== undefined && req.outPath.trim() !== '') {
        try {
          finalPath = await this.copyOut(validated.path, req.outPath)
        } catch (e) {
          last = { ...last, ok: false, code: 'HOST_UNAVAILABLE', error: 'failed to copy the image to ' + req.outPath + ': ' + (e instanceof Error ? e.message : String(e)) }
          return last
        }
      }
      const result: ImageResult = {
        ok: true,
        path: finalPath,
        ...(finalPath === validated.path ? {} : { sourcePath: validated.path }),
        uri: 'file://' + validated.path,
        mime: validated.mime,
        width: validated.width,
        height: validated.height,
        aspectRatio: aspectRatio ?? simplifyRatio(validated.width, validated.height),
        bytes: validated.bytes,
        name,
        prompt,
        model: target.model,
        effort,
        durationMs: last.durationMs,
        attempts: attempt,
        ...(res.conversationId === undefined ? {} : { conversationId: res.conversationId }),
        ...(res.accountId === undefined ? {} : { accountId: res.accountId }),
      }
      if (req.outPath === undefined || req.outPath.trim() === '') {
        const defaultDir = cfg.imageOutputDir.trim()
        if (defaultDir !== '') {
          try {
            result.path = await this.copyOut(validated.path, defaultDir)
            result.sourcePath = validated.path
          } catch {
            // keep the artifact path when the default copy target is unusable
          }
        }
      }
      this.remember(cacheKey, { ...result })
      return result
    }
    return last
  }

  /** Bounded result cache: a long-lived host must not retain every image forever. */
  private remember(key: string, result: ImageResult): void {
    this.cache.set(key, result)
    while (this.cache.size > 50) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }

  private retryable(code: ImageFailureCode | undefined): boolean {
    return code === 'IMAGE_NOT_FOUND' || code === 'TIMEOUT' || code === 'NO_ACCOUNT' || code === 'IMAGE_REGION_UNSUPPORTED' || code === 'AGY_ERROR'
  }
}

function mapAgentCode(code: string | undefined): ImageFailureCode {
  switch (code) {
    case Err.ELIGIBILITY:
      return 'IMAGE_REGION_UNSUPPORTED'
    case Err.RATE_LIMIT:
    case Err.QUOTA:
      return 'NO_ACCOUNT'
    case Err.TIMEOUT:
      return 'TIMEOUT'
    case Err.AUTH:
    case Err.INVALID_CREDENTIAL:
      return 'AGY_AUTH'
    case 'ABORTED':
      return 'ABORTED'
    default:
      return 'AGY_ERROR'
  }
}

/** `1024x1024` → `1:1` when the numbers simplify cleanly, else `w:h`. */
export function simplifyRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const d = gcd(width, height)
  if (d <= 0) return width + ':' + height
  return width / d + ':' + height / d
}

/** Human-readable one-line summary used by the CLI's default output. */
export function imageSummary(res: ImageResult): string {
  if (!res.ok) return 'image generation failed: ' + (res.error ?? 'unknown error')
  return res.path + '\n' + res.width + 'x' + res.height + ' · ' + res.mime + ' · ' + formatBytes(res.bytes) + ' · ' + res.model
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}
