// Shared vocabulary for the translation feature: durable record shape, request
// and result types, and the injected service dependencies. Type-only module
// besides the record-type constant and the two size bounds.
import { PROVIDER_ID, type PluginConfig } from '../../common/types.ts'
import type { Catalog } from '../../host/models.ts'

/** Durable record type written to the session log (grammar: `plugin:` + lowercase segments). */
export const TRANSLATION_RECORD_TYPE = 'plugin:agy-link/translation'

/** Bounded in-memory cache: one entry per (model, effort, language, source text). */
export const MAX_CACHE_ENTRIES = 200

/** Reasonable lower bound for a translated answer; keeps a runaway model from filling the card. */
export const MIN_TEXT_LIMIT = 200

export interface TranslationRecord {
  version: 1
  turn: number
  /** seq of the translated assistant message — the client anchors the card just below it. */
  anchorSeq: number
  text: string
  /** Source text this translation was produced from (capped) — the card's "show original". */
  original?: string
  model: string
  effort: string
  provider: typeof PROVIDER_ID
  durationMs: number
  createdAt: number
  messageId?: string
  accountId?: string
  sourceModel?: string
}

export interface TranslateRequest {
  text: string
  /** Originating session, so the auxiliary call resolves the session cwd (never binds). */
  sessionId?: string
  model?: string
  effort?: string
  targetLanguage?: string
  /** Bypass the in-memory cache. */
  force?: boolean
}

export type TranslateFailureCode =
  | 'EMPTY_TEXT'
  | 'NO_ACCOUNT'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'AGY_ERROR'
  | 'AUX_DISABLED'
  | 'SESSION_UNAVAILABLE'
  | 'TURN_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'TRANSIENT'

export interface TranslateResult {
  ok: boolean
  text: string
  model: string
  effort: string
  cached: boolean
  durationMs: number
  /** seq of the appended session record, when the caller asked to persist. */
  recordSeq?: number | null
  /** Turn this result belongs to (set by the turn/message entries). */
  turn?: number
  accountId?: string
  error?: string
  code?: TranslateFailureCode
}

export interface TranslateTarget {
  model: string
  effort: string
}

/** Minimal session shape this feature reads: the durable event log plus its id. */
export interface TranslationSessionLike {
  id?: string
  log?: readonly SessionEventLike[]
  events?: readonly SessionEventLike[]
  snapshotEvents?: (fromSeq?: unknown, toSeqExclusive?: unknown) => readonly SessionEventLike[]
  ownEvents?: () => readonly SessionEventLike[]
}

export interface SessionEventLike {
  type: string
  seq?: number
  data?: unknown
}

/** Persona block for the bound translation conversation (sent once). */
export interface TranslationSetupInput {
  sessionId: string
  cwd?: string
  logPath?: string
  targetLanguage: string
  digest?: string
}

export interface TranslationRunnerRequest {
  prompt: string
  /**
   * The message a BOUND translation conversation receives: the short request line
   * with the source inside it (the persona went out once, when it was created).
   */
  text?: string
  /** Persona block for the bound conversation (sent only when it is created). */
  setup?: string
  sessionId?: string
  model: string
  effort?: string
  maxTokens: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface TranslationRunnerResult {
  ok: boolean
  text: string
  error?: string
  /** LlmError code surfaced by the adapter (RATE_LIMIT, AUTH, NETWORK, ...). */
  code?: string
  accountId?: string
  durationMs?: number
}

export interface TranslationServiceDeps {
  cfg: () => PluginConfig
  catalog: () => Catalog
  /** Execute one translation model call (injected: the real one drives ctx.llm). */
  run: (req: TranslationRunnerRequest) => Promise<TranslationRunnerResult>
  /** Resolve a session's durable log by id. */
  getSession: (id: string) => TranslationSessionLike | undefined
  /** Append the durable translation record; returns its seq when the host supports it. */
  appendRecord?: (sessionId: string, record: TranslationRecord) => number | null | Promise<number | null>
  /** Per-session auto-translate override (set by `/tsl auto on|off`). */
  autoEnabled?: (sessionId: string) => boolean
  /** The DSH session's workspace, handed to agy so its cwd matches the project. */
  sessionCwd?: (sessionId: string) => string | undefined
  /** Absolute path of that session's raw log, so agy can read the history itself. */
  sessionLogPath?: (sessionId: string) => string | undefined
  log?: (msg: string) => void
  now?: () => number
}

export interface TranslateTurnOptions {
  model?: string
  effort?: string
  targetLanguage?: string
  force?: boolean
  /** Translate every assistant text block of the turn instead of the final answer. */
  full?: boolean
  /** Persist the durable card record (default true). */
  persist?: boolean
}

export interface PendingTranslation {
  turn: number
  startedAt: number
}

export interface TurnAnswer {
  text: string
  anchorSeq: number
  messageId?: string
  sourceModel?: string
}
