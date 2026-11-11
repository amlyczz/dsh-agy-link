// ImageService: orchestration, caching and retries around one injected `run`.
// Split out of src/host/image.ts; the control flow (validation order, cache,
// effort-refusal fallback, retry classification, artifact acceptance) is
// unchanged, only decomposed into smaller private steps.
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { Err, type PluginConfig } from '../../common/types.ts'
import {
  buildImageAgentPrompt,
  normalizeAspectRatio,
  normalizeImageName,
  parseImageReply,
  resolveImageTarget,
} from './prompt.ts'
import {
  candidateArtifacts,
  copyArtifact,
  simplifyRatio,
  validateArtifact,
  type ValidatedImage,
} from './artifacts.ts'
import {
  SUPPORTED_ASPECT_RATIOS,
  type ImageFailureCode,
  type ImageRequest,
  type ImageResult,
  type ImageServiceDeps,
  type ImageTarget,
} from './types.ts'

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

/** Everything the retry loop needs, produced by {@link ImageService.prepare}. */
interface PreparedInput {
  prompt: string
  aspectRatio?: string
  name: string
  refs: string[]
  maxBytes: number
  maxAttempts: number
  cacheKey: string
  bridgePrompt: string
}

interface AttemptContext extends PreparedInput {
  req: ImageRequest
  cfg: PluginConfig
  target: ImageTarget
  last: ImageResult
}

interface SuccessArgs {
  req: ImageRequest
  cfg: PluginConfig
  validated: ValidatedImage
  finalPath: string
  aspectRatio?: string
  name: string
  prompt: string
  model: string
  effort: string
  durationMs: number
  attempt: number
  conversationId?: string
  accountId?: string
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

  /**
   * Validate the request and build the bridge prompt. Runs before any spawn,
   * so bad parameters never reach agy (same order as the original inline code).
   */
  private prepare(
    req: ImageRequest,
    cfg: PluginConfig,
    target: ImageTarget,
  ): { ok: false; result: ImageResult } | { ok: true; value: PreparedInput } {
    const prompt = req.prompt.trim()
    if (prompt === '') {
      return { ok: false, result: { ...emptyImageResult(req, target.model, target.effort), code: 'EMPTY_PROMPT', error: 'prompt is required' } }
    }

    let aspectRatio: string | undefined
    if (req.aspectRatio !== undefined && req.aspectRatio.trim() !== '') {
      const normalized = normalizeAspectRatio(req.aspectRatio)
      if (normalized === null) {
        return {
          ok: false,
          result: {
            ...emptyImageResult(req, target.model, target.effort),
            code: 'BAD_PARAMS',
            error: 'unsupported aspect ratio "' + req.aspectRatio + '"; supported: ' + SUPPORTED_ASPECT_RATIOS.join(', '),
          },
        }
      }
      aspectRatio = normalized
    }
    const name = normalizeImageName(req.name, this.now())
    const refs: string[] = []
    for (const raw of req.imagePaths ?? []) {
      const abs = isAbsolute(raw) ? raw : resolvePath(raw)
      if (!existsSync(abs)) {
        return { ok: false, result: { ...emptyImageResult(req, target.model, target.effort), code: 'BAD_PARAMS', error: 'reference image not found: ' + raw } }
      }
      refs.push(abs)
    }
    const bin = this.deps.bin()
    if (bin === null || bin === '') {
      return { ok: false, result: { ...emptyImageResult(req, target.model, target.effort), code: 'AGY_NOT_INSTALLED', error: 'agy binary not found — install it via https://antigravity.google/docs/cli/install' } }
    }
    const cacheKey = this.cacheKey({ ...req, prompt }, target)
    const maxBytes = req.maxBytes ?? cfg.imageMaxBytes
    const maxAttempts = Math.max(1, 1 + Math.round(cfg.imageRetries))
    const bridgePrompt = buildImageAgentPrompt({ prompt, name, ...(aspectRatio === undefined ? {} : { aspectRatio }), ...(refs.length === 0 ? {} : { imagePaths: refs }) })
    return { ok: true, value: { prompt, aspectRatio, name, refs, maxBytes, maxAttempts, cacheKey, bridgePrompt } }
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const cfg = this.deps.cfg()
    const target = this.target({ ...(req.model === undefined ? {} : { model: req.model }), ...(req.effort === undefined ? {} : { effort: req.effort }) })
    const prepared = this.prepare(req, cfg, target)
    if (!prepared.ok) return prepared.result
    const input = prepared.value
    const cached = this.cache.get(input.cacheKey)
    if (req.force !== true && cached !== undefined && cached.ok) return { ...cached, durationMs: 0, attempts: 0 }

    const last: ImageResult = { ...emptyImageResult({ ...req, name: input.name, ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }) }, target.model, target.effort) }
    return this.runAttempts({ ...input, req, cfg, target, last }, signal)
  }

  private async runAttempts(ctx: AttemptContext, signal?: AbortSignal): Promise<ImageResult> {
    const { req, cfg, target, prompt, aspectRatio, name, refs, maxBytes, maxAttempts, cacheKey, bridgePrompt } = ctx
    let last = ctx.last
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

      const list = await candidateArtifacts(res, startedAt)
      let validated: ValidatedImage | null = null
      let firstFailure: ImageResult | null = null
      for (const candidate of list) {
        const v = await validateArtifact(candidate, maxBytes, aspectRatio)
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
          finalPath = await copyArtifact(validated.path, req.outPath)
        } catch (e) {
          last = { ...last, ok: false, code: 'HOST_UNAVAILABLE', error: 'failed to copy the image to ' + req.outPath + ': ' + (e instanceof Error ? e.message : String(e)) }
          return last
        }
      }
      const result = await this.successResult({
        req,
        cfg,
        validated,
        finalPath,
        ...(aspectRatio === undefined ? {} : { aspectRatio }),
        name,
        prompt,
        model: target.model,
        effort,
        durationMs: last.durationMs,
        attempt,
        ...(res.conversationId === undefined ? {} : { conversationId: res.conversationId }),
        ...(res.accountId === undefined ? {} : { accountId: res.accountId }),
      })
      this.remember(cacheKey, { ...result })
      return result
    }
    return last
  }

  /** Build the accepted result (incl. the optional default-output-dir copy). */
  private async successResult(args: SuccessArgs): Promise<ImageResult> {
    const { req, cfg, validated, finalPath } = args
    const result: ImageResult = {
      ok: true,
      path: finalPath,
      ...(finalPath === validated.path ? {} : { sourcePath: validated.path }),
      uri: 'file://' + validated.path,
      mime: validated.mime,
      width: validated.width,
      height: validated.height,
      aspectRatio: args.aspectRatio ?? simplifyRatio(validated.width, validated.height),
      bytes: validated.bytes,
      name: args.name,
      prompt: args.prompt,
      model: args.model,
      effort: args.effort,
      durationMs: args.durationMs,
      attempts: args.attempt,
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      ...(args.accountId === undefined ? {} : { accountId: args.accountId }),
    }
    if (req.outPath === undefined || req.outPath.trim() === '') {
      const defaultDir = cfg.imageOutputDir.trim()
      if (defaultDir !== '') {
        try {
          result.path = await copyArtifact(validated.path, defaultDir)
          result.sourcePath = validated.path
        } catch {
          // keep the artifact path when the default copy target is unusable
        }
      }
    }
    return result
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
