// Shared vocabulary for dsh-agy-link: plugin config, provider-route ids,
// stable error codes, and the normalized event stream produced by the
// stream-json parser and consumed by the StreamChunk mapper.

export const PROVIDER_ID = 'antigravity'
export const PLUGIN_ID = 'agy-link'
export const PKG_NAME = 'dsh-agy-link'

export type PermissionMode = 'skip' | 'plan' | 'accept-edits'

export interface FallbackModelDef {
  id: string
  name: string
  /** Selectable reasoning efforts; omit for fixed-thinking models. */
  efforts?: readonly string[]
}

export interface PluginConfig {
  enabled: boolean
  /** Absolute path to the agy binary; empty string = resolve from PATH. */
  agyBin: string
  /** Extra argv appended to every spawn (escape hatch). */
  extraArgs: readonly string[]
  permissionMode: PermissionMode
  defaultModel: string
  defaultEffort: string
  /** Watchdog for one full agy -p run. */
  timeoutMs: number
  maxConcurrent: number
  contextWindowDefault: number
  maxTokensDefault: number
  forwardSystemPrompt: boolean
  digestMaxChars: number
  modelsCacheTtlMs: number
  /** Allow compaction / session-title auxiliary calls to spawn agy. */
  allowAuxiliary: boolean
  /** Hard character cap for compaction prompts built from history. */
  compactionMaxChars: number
  /** Lock the working directory for agy spawns; empty string = process.cwd(). */
  workspaceRoot: string
  fallbackModels: readonly FallbackModelDef[]
  askTool: boolean
  /** Directory where inbound images are staged for agy (path-based multimodal). */
  mediaDir: string
  /** Images older than this are swept from mediaDir. */
  mediaTtlMs: number
  /** Per-image byte cap for staging; larger images are skipped with a note. */
  mediaMaxBytes: number
  /** Max images staged per model call. */
  mediaMaxImages: number
  /** Experimental: expose DSH tools to agy over a local MCP bridge. */
  mcpBridge: boolean
  /** Comma-separated tool-name allowlist for the MCP bridge (empty = all non-internal). */
  mcpToolAllowlist: string
}

export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-3-6-flash', name: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
]

export function defaultConfig(): PluginConfig {
  return {
    enabled: true,
    agyBin: '',
    extraArgs: [],
    permissionMode: 'skip',
    defaultModel: '',
    defaultEffort: '',
    timeoutMs: 600_000,
    maxConcurrent: 3,
    contextWindowDefault: 1_048_576,
    maxTokensDefault: 65_536,
    forwardSystemPrompt: false,
    digestMaxChars: 8_000,
    modelsCacheTtlMs: 300_000,
    allowAuxiliary: true,
    compactionMaxChars: 800_000,
    workspaceRoot: '',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    askTool: false,
    mediaDir: '',
    mediaTtlMs: 86_400_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxImages: 8,
    mcpBridge: false,
    mcpToolAllowlist: '',
  }
}

// Stable LlmError codes surfaced by the adapter (spec error table).
export const Err = {
  AUTH: 'AUTH',
  AGY_NOT_INSTALLED: 'AGY_NOT_INSTALLED',
  AGY_VERSION_UNSUPPORTED: 'AGY_VERSION_UNSUPPORTED',
  AGY_ERROR: 'AGY_ERROR',
  TIMEOUT: 'TIMEOUT',
  PROCESS_EXIT: 'PROCESS_EXIT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT',
  AUX_DISABLED: 'AUX_DISABLED',
  BUSY: 'BUSY',
} as const

// Raw usage object as emitted by agy stream-json (snake_case).
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  total_tokens?: number
}

export type AgyStepKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'title'
  | 'subagent'
  | 'user-input'
  | 'unknown'

export interface AgyToolInfo {
  name: string
  /** Raw arguments: JSON string when agy serializes them, else object. */
  args?: unknown
  output?: unknown
}

export type AgyEvent =
  | { kind: 'init'; conversationId?: string; model?: string; raw: unknown }
  | {
      kind: 'step'
      stepKey: string
      stepKind: AgyStepKind
      text: string
      tool?: AgyToolInfo
      raw: unknown
    }
  | {
      kind: 'result'
      conversationId: string
      ok: boolean
      response: string
      error?: string
      usage: RawUsage
      raw: unknown
    }
  | { kind: 'garbage'; line: string }

// Auth-failure sniffing shared by the runner tail, parser output and the
// result envelope (observed on agy 1.1.13: an authentication-required
// banner plus result.error text).
export function looksLikeAuthFailure(text: string): boolean {
  return /authentication required|authentication failed|please sign in|not signed in|timed out waiting for authentication/i.test(
    text,
  )
}

// Google OAuth consent URL pattern; trailing punctuation is trimmed.
export function extractAuthUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/accounts\.google\.com\/\S+/)
  if (!m) return undefined
  return m[0].replace(/[)\]>.,;\x27\x22]+$/, '')
}
