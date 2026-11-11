// Shared types and constants for the image feature (spec: .spec/image.md).
// Split out of src/host/image.ts; that file still re-exports the public surface.
import type { PermissionMode, PluginConfig } from '../../common/types.ts'

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
