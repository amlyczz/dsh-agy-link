// Pure resolution of "what kind of call is this?".
//
// This used to be the first ~100 lines of AgyAdapter.streamAttempt: purpose
// booleans, aux gate, permission mode, session/workspace fallback, tool mode.
// Keeping it pure makes the matrix testable without spawning agy.
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AgyGenerateOptions, AgyTranslateSession } from '../common/protocol.ts'
import { Err, type PermissionMode, type PluginConfig } from '../common/types.ts'

export type CallPurpose = 'chat' | 'compaction' | 'session-title' | 'translation' | 'image'

export interface CallContext {
  cfg: PluginConfig
  bin: string
  purpose: CallPurpose
  isReview: boolean
  isTitle: boolean
  isCompaction: boolean
  isTranslate: boolean
  isImage: boolean
  isAux: boolean
  translateSession: AgyTranslateSession | null
  isTranslateSession: boolean
  permissionMode: PermissionMode
  sessionKey: string
  workspaceRoot: string
  isCodeMode: boolean
  hasToolSupport: boolean
}

export interface CallContextInput {
  options: AgyGenerateOptions
  cfg: PluginConfig
  bin: string | null
  sessionCwd?: (sessionKey: string) => string | undefined
  warnOnce: (key: string, message: string) => void
  /** Process cwd override for tests; defaults to process.cwd(). */
  cwd?: string
}

export function resolveCallContext(input: CallContextInput): CallContext {
  const { options, cfg, bin } = input
  if (!bin) {
    throw new LlmError(
      'agy binary not found on PATH — install it via https://antigravity.google/docs/cli/install',
      Err.AGY_NOT_INSTALLED,
    )
  }

  const isReview = typeof options.system === 'string' && options.system.includes('REVIEW_POLICY')
  const purpose: CallPurpose = options.purpose ?? 'chat'
  const isTitle = purpose === 'session-title'
  const isCompaction = purpose === 'compaction'
  const isTranslate = purpose === 'translation'
  const isImage = purpose === 'image'
  // Title calls are aux, but must not be forced into plan mode (that drops the
  // length/format constraints).
  const isAux = isCompaction || isTitle || isReview || isTranslate || isImage

  // Image may override the configured mode for one call (headless `skip`).
  // Everything else keeps the historical rules: aux runs are read-only plan
  // mode; titles keep the configured mode.
  const imageMode = isImage ? options.agyPermissionMode : undefined
  const permissionMode: PermissionMode =
    imageMode === 'skip' || imageMode === 'plan' || imageMode === 'accept-edits'
      ? imageMode
      : isAux && !isTitle && !isImage
        ? 'plan'
        : cfg.permissionMode

  // Translation with its OWN agy conversation: setup is sent once, text every
  // later call. Bound under `${sessionKey}#tsl`.
  const rawTranslate = isTranslate ? options.agyTranslateSession : undefined
  const translateSession: AgyTranslateSession | null =
    rawTranslate === undefined
      ? null
      : { setup: String(rawTranslate.setup ?? ''), text: String(rawTranslate.text ?? '') }
  const isTranslateSession = translateSession !== null

  if (isAux && !isReview && !isTranslate && !isImage && !cfg.allowAuxiliary) {
    throw new LlmError('auxiliary calls are disabled for the antigravity route (allowAuxiliary: false)', Err.AUX_DISABLED)
  }

  const toolNames = new Set((options.tools ?? []).map((t) => t.name))
  const isCodeMode = toolNames.has('run_code') && !toolNames.has('agy_tool')
  const hasToolSupport = options.tools === undefined || toolNames.has('agy_tool') || toolNames.has('run_code')
  const sessionKey = options.sessionId !== undefined ? String(options.sessionId) : ''

  // cwd precedence: explicit config > the DSH session's own workspace >
  // the host process cwd. The last fallback can land agy in an UNRELATED
  // directory, so warn loudly once per session instead of failing the turn.
  let workspaceRoot = cfg.workspaceRoot
  if (workspaceRoot === '') {
    const fromSession = sessionKey !== '' ? input.sessionCwd?.(sessionKey) : undefined
    if (fromSession !== undefined && fromSession !== '') {
      workspaceRoot = fromSession
    } else {
      workspaceRoot = input.cwd ?? process.cwd()
      input.warnOnce(
        'cwd:' + (sessionKey || 'anon'),
        'session workspace unresolved (sessionId=' + (sessionKey || 'none') + ') — running agy in the DSH process cwd: ' + workspaceRoot,
      )
    }
  }

  return {
    cfg,
    bin,
    purpose,
    isReview,
    isTitle,
    isCompaction,
    isTranslate,
    isImage,
    isAux,
    translateSession,
    isTranslateSession,
    permissionMode,
    sessionKey,
    workspaceRoot,
    isCodeMode,
    hasToolSupport,
  }
}
