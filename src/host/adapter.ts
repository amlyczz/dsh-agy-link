// AgyAdapter — the LlmAdapter implementation at the heart of the plugin
// (spec section 3). Translates one DSH model call into a short-lived
// `agy -p --output-format stream-json` child process, maps the NDJSON event
// stream onto StreamChunks, and binds DSH sessions to agy conversations for
// multi-turn continuity (ADR-4). Only the trailing user messages become the
// prompt; earlier context rides agy-native history plus a digest prefix on
// first bind (ADR-7).
import { join } from 'node:path'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Err, looksLikeAuthFailure, looksLikeEligibilityFailure, looksLikeHardRateLimit, looksLikeRateLimit, shouldMarkAuthRequired, ELIGIBILITY_ERROR_HINT, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { modelFamilyOf } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { diffConversations, snapshotConversations } from './discovery.ts'
import { EventMapper } from './mapper.ts'
import { parseMirrorCallId, type RunRecording, type RunRegistry } from './recording.ts'
import { defaultEffortFor, findEntry, ModelCatalog, resolveModelSlug } from './models.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, stageImages, type ImageRefLike } from './media.ts'
import { ensureIsolatedKeychain, isolatedHomeEnv, proxyEnvFor, startAgyProcess, buildStreamInputLine, shouldUsePromptStdin } from './runner.ts'
import { stateDir } from '../common/config.ts'
import type { SessionStore } from './sessions.ts'
import { readFullToolArgs, readStepThoughts, clearAgyDbCache } from './agy-db.ts'
import { getGitHeadContent } from './mirror-tool.ts'

type ForeignSource = { source?: { kind?: string; provider?: string; callId?: string } }

/** Loose content-block view spanning dsh-llm schema revisions. */
type UnknownBlock = {
  type?: string
  text?: string
  content?: readonly unknown[]
  toolCallId?: unknown
  attachment?: unknown
  attachmentId?: unknown
}

/**
 * True for a tool-result message across dsh-llm schema revisions.
 *
 * 0.1.x: `role: 'user'` + `source: { kind: 'tool', callId }` and a sole
 * `tool-result` content block. 0.1.7+ promotes tool results to
 * `role: 'tool'` with `toolCallId` on the message itself. A call that only
 * looks at `role === 'user'` drops the whole trailing span after the first
 * tool round-trip (issues #34 / #35).
 */
function isToolResultMessage(m: Message): boolean {
  const role = (m as { role?: string }).role
  if (role === 'tool') return true
  const src = (m as unknown as ForeignSource).source
  if (src?.kind === 'tool') return true
  const content = m.content
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b) => (b as UnknownBlock | undefined)?.type === 'tool-result')
  )
}

/**
 * Correlation id of a tool-result message. Accepts `message.toolCallId`
 * (0.1.7+), `source.callId` (0.1.x), and nested `tool-result` blocks.
 */
export function toolCallIdOf(m: Message): string | null {
  const direct = (m as { toolCallId?: unknown }).toolCallId
  if (typeof direct === 'string' && direct !== '') return direct
  const src = (m as unknown as ForeignSource).source
  if (typeof src?.callId === 'string' && src.callId !== '') return src.callId
  for (const raw of (m.content as readonly UnknownBlock[] | undefined) ?? []) {
    const b = raw as UnknownBlock | undefined
    if (b?.type === 'tool-result' && typeof b.toolCallId === 'string' && b.toolCallId !== '') {
      return b.toolCallId
    }
  }
  return null
}

/** Flatten visible text, including nested tool-result payloads. */
function textOf(m: Message): string {
  const parts: string[] = []
  const walk = (blocks: readonly unknown[] | undefined): void => {
    for (const raw of blocks ?? []) {
      const b = raw as UnknownBlock | undefined
      if (b === undefined) continue
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content)
    }
  }
  walk(m.content as readonly unknown[] | undefined)
  return parts.filter((s) => s !== '').join('\n')
}

function isForeignAssistant(m: Message): boolean {
  if (m.role !== 'assistant') return false
  const src = (m as unknown as ForeignSource).source
  return !src || src.provider !== PROVIDER_ID
}

/**
 * Latest real human turn (not a tool result, not assistant). This is the
 * live task; a digest or tool-result-only trailing span must never drop it
 * (issue #35: "续跑提示词里没有任务").
 */
export function latestUserTaskText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role === 'system' || m.role === 'assistant') continue
    if (isToolResultMessage(m)) continue
    const text = textOf(m)
    if (text !== '') return text
  }
  return ''
}

/** Collect image refs from a message, walking nested tool-result payloads. */
function collectImageRefs(m: Message, out: ImageRefLike[]): void {
  const walk = (blocks: readonly unknown[] | undefined): void => {
    for (const raw of blocks ?? []) {
      const b = raw as UnknownBlock | undefined
      if (b === undefined) continue
      if (b.type === 'image') {
        if (b.attachment && typeof b.attachment === 'object') {
          out.push(b.attachment as ImageRefLike)
        } else if (typeof b.attachmentId === 'string') {
          out.push(b as unknown as ImageRefLike)
        }
      } else if (b.type === 'tool-result' && Array.isArray(b.content)) {
        walk(b.content)
      }
    }
  }
  walk(m.content as readonly unknown[] | undefined)
}

function digestLabel(m: Message): string {
  if (isToolResultMessage(m)) return 'Tool result: '
  return m.role === 'user' ? 'User: ' : 'Assistant: '
}

/**
 * Rolling digest of turns this agy conversation has not seen (ADR-7).
 *
 * Budget policy (issue #35): the latest real user task is reserved first so
 * a wall of tool-result text can never truncate the question away. Remaining
 * budget is filled from the newest other turns.
 */
export function buildDigest(messages: readonly Message[], fromIdx: number, maxChars: number): string {
  const taskText = latestUserTaskText(messages.slice(fromIdx))
  const taskLine = taskText !== '' ? 'User: ' + taskText : ''
  const otherLines: string[] = []
  for (let i = fromIdx; i < messages.length; i++) {
    const m = messages[i]
    if (m === undefined || m.role === 'system') continue
    const text = textOf(m)
    if (text === '') continue
    if (taskLine !== '' && !isToolResultMessage(m) && m.role === 'user' && text === taskText) continue
    otherLines.push(digestLabel(m) + text)
  }

  let budget = maxChars
  const kept: string[] = []
  if (taskLine !== '') {
    if (taskLine.length > budget) {
      kept.push(taskLine.slice(0, Math.max(0, budget)))
      budget = 0
    } else {
      kept.push(taskLine)
      budget -= taskLine.length
    }
  }
  const keptOther: string[] = []
  for (let i = otherLines.length - 1; i >= 0 && budget > 0; i--) {
    const line = otherLines[i]!
    if (line.length > budget) {
      keptOther.unshift(line.slice(0, Math.max(0, budget)))
      break
    }
    keptOther.unshift(line)
    budget -= line.length
  }
  kept.push(...keptOther)
  if (kept.length === 0) return ''
  return '[conversation so far]\n' + kept.join('\n\n') + '\n[end of conversation so far]\n\n'
}

export interface AgyAdapterDeps {
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: () => Promise<() => void>
  log?: (msg: string) => void
  /** Recordings shared with the agy_tool mirror (native tool-card mirroring). */
  runs: RunRegistry
  /**
   * Resolve the DSH session's working directory. Called with the raw
   * session id; return an absolute path to run agy inside that workspace.
   * Explicit config `workspaceRoot` still wins over this value.
   */
  sessionCwd?: (sessionId: string) => string | undefined
  /** Last-run telemetry surfaced by /agy status. Process completion and tool failures are distinct. */
  onRun?: (info: { processOk: boolean; processCode: string; toolErrors: readonly string[]; durationMs: number; model: string }) => void
  /** Reads image bytes from DSH attachment storage (multimodal staging). */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /** Called with each run's parser so the host can keep the last stdout ring for /agy doctor. */
  onParser?: (parser: StreamJsonParser) => void
}

// ---- stream() -------------------------------------------------------------

class ChunkQueue {
  private chunks: StreamChunk[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(ch: StreamChunk): void {
    this.chunks.push(ch)
    this.wake?.()
    this.wake = null
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = null
  }

  async *drain(): AsyncIterable<StreamChunk> {
    for (;;) {
      while (this.chunks.length > 0) {
        const ch = this.chunks.shift()
        if (ch !== undefined) yield ch
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      });
    }
  }
}

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

function sawAuthFailure(parser: StreamJsonParser, outcome: { stderrTail: string; stdout: string }): boolean {
  if (parser.stats.sawAuthFailure) return true
  return looksLikeAuthFailure(outcome.stderrTail) || looksLikeAuthFailure(outcome.stdout.slice(0, 4000))
}

export class AgyAdapter extends LlmAdapter {
  private readonly warnedKeys = new Set<string>()
  /** sessionKey -> in-flight run, for steer-time preemption. */
  private readonly activeRuns = new Map<string, RunRecording>()
  /**
   * sessionKey -> prompt info for duplicate submission debounce.
   * `inFlight` is true from submit until the run settles (or spawn throws),
   * so a settled failure can never wall a legitimate retry.
   */
  private readonly activeSessionPrompts = new Map<string, { prompt: string; startedAt: number; inFlight: boolean }>()
  /** accountId -> timestamp of last spawn for spacing throttling */
  private readonly lastAccountSpawnTime = new Map<string, number>()
  private readonly minSpawnIntervalMs = 500
  /** Global sliding window timestamps for batch rate-limiting protection */
  private readonly requestTimestamps: number[] = []

  constructor(private readonly deps: AgyAdapterDeps) {
    super()
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return
    this.warnedKeys.add(key)
    this.deps.log?.('WARNING: ' + msg)
  }

  /** Mark a session prompt as no longer in flight so retries are not debounced. */
  private clearInFlightPrompt(sessionKey: string, prompt: string): void {
    if (sessionKey === '') return
    const ap = this.activeSessionPrompts.get(sessionKey)
    if (ap === undefined || ap.prompt !== prompt) return
    this.activeSessionPrompts.set(sessionKey, { ...ap, inFlight: false })
  }

  /**
   * Fail fast on auth and abort; allow one retry for transient process
   * failures (timeout, crash, malformed stream) per ADR-11.
   */
  override providerRetryPolicy(_provider: string) {
    return {
      mode: 'normal' as const,
      maxRetries: 1,
      retryableCodes: [Err.TIMEOUT, Err.PROCESS_EXIT, Err.INVALID_OUTPUT],
      initialDelayMs: 2_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (agy CLI)' }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    void this.deps.catalog.refreshIfNeeded()
    const cat = this.deps.catalog.get()
    // DSH's llm.listModels rejects a provider catalog containing any
    // duplicate model id or invalid id (INVALID_CATALOG) and the model picker then drops
    // the whole Antigravity group — dedupe and sanitize as a final guard over every
    // catalog source (discovered, fallback, user-configured fallbackModels).
    const seen = new Set<string>()
    const models: LlmModelInfo[] = []
    const dropped: string[] = []
    for (const m of cat.models) {
      if (!m || typeof m.id !== 'string') continue
      const id = m.id.trim()
      if (id === '') continue
      if (seen.has(id)) {
        dropped.push(id)
        continue
      }
      seen.add(id)
      const name = (typeof m.name === 'string' && m.name.trim() !== '') ? m.name.trim() : id
      models.push({
        provider: PROVIDER_ID,
        id,
        name,
        inputModalities: ['text', 'image'] as const,
      })
    }
    if (dropped.length > 0) {
      // Observable on purpose: without this the guard silently masks the
      // catalog duplication that would otherwise remove every Antigravity
      // model from the picker (issue #1).
      this.warnOnce(
        'catalog-dupes',
        'model catalog contained duplicate ids [' + dropped.join(', ') + '] — kept first occurrence so DSH does not drop the whole provider group (INVALID_CATALOG)',
      )
    }
    return models
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const cfg = this.deps.getConfig()
    const cat = this.deps.catalog.get()
    const rawModel = typeof model === 'string' ? model.trim() : ''
    const cleanId = rawModel !== '' ? rawModel : cfg.defaultModel
    const entry = findEntry(cat, cleanId)
    const rawName = entry ? entry.name : cleanId
    const name = (typeof rawName === 'string' && rawName.trim() !== '') ? rawName.trim() : cleanId
    const contextWindow = typeof cfg.contextWindowDefault === 'number' && cfg.contextWindowDefault > 0 ? cfg.contextWindowDefault : 200_000
    const resolved: LlmResolvedModelInfo = {
      provider: PROVIDER_ID,
      id: cleanId,
      name,
      inputModalities: ['text', 'image'] as const,
      context: { contextWindow },
      defaultMaxTokens: typeof cfg.maxTokensDefault === 'number' && cfg.maxTokensDefault > 0 ? cfg.maxTokensDefault : 8192,
    }
    if (entry && Array.isArray(entry.efforts) && entry.efforts.length > 0) {
      const cleanEfforts = Array.from(new Set(entry.efforts.filter((e) => typeof e === 'string' && e.trim() !== '')))
      if (cleanEfforts.length > 0) {
        const def = defaultEffortFor({ ...entry, efforts: cleanEfforts }, cfg)
        const validDef = def && cleanEfforts.includes(def) ? def : cleanEfforts[0]
        resolved.reasoning = {
          efforts: cleanEfforts.map((e) => ({ id: e as never, name: e })),
          ...(validDef ? { defaultEffort: validDef as never } : {}),
        }
      }
    }
    return resolved
  }

  /**
   * Bind exact model metadata and dispatch to ONE adapter generation.
   * Required by dsh-llm >= 0.1.1-rc.2: LlmRuntime.prepareCall calls
   * registration.adapter.prepareCall(provider, model, signal) unconditionally,
   * so an adapter compiled against the old base class (no prepareCall) crashed
   * with "registration.adapter.prepareCall is not a function" on new hosts.
   * Implemented explicitly here so both old and new runtimes work: the old
   * runtime never calls it, the new runtime gets the capability-bound handle.
   * Declared without `override`/imported types on purpose: the plugin still
   * typechecks against dsh-llm ^0.1.0-rc.6 (no prepareCall in the base), while
   * the runtime contract matches the 0.1.1-rc.2 PreparedAdapterCall shape
   * { model: LlmResolvedModelInfo; stream(options): AsyncIterable<StreamChunk> }.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }> {
    const modelInfo = await this.resolveModel(provider, model, signal)
    return {
      model: modelInfo,
      stream: (options) => this.stream(options),
    }
  }

  /** Build the agy argv for one call. Exported for tests. */
  buildArgs(opts: {
    prompt: string
    model: string
    effort?: string
    conversationId?: string
    permissionMode: PluginConfig['permissionMode']
    timeoutMs: number
    extraArgs: readonly string[]
    addDirs?: readonly string[]
    printTimeoutMinutes?: number
    /** Omit `-p <prompt>` and add `--input-format stream-json` (prompt rides stdin). */
    promptViaStdin?: boolean
  }): string[] {
    const ptMins = opts.printTimeoutMinutes ?? Math.max(1, Math.ceil(opts.timeoutMs / 60_000))
    const args: string[] = ['--output-format', 'stream-json', '--print-timeout', ptMins + 'm']
    if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
    else args.push('--mode', opts.permissionMode)
    const effectiveModel = resolveModelSlug(opts.model)
    if (effectiveModel !== '') args.push('--model', effectiveModel)
    const isGemini = effectiveModel === '' || effectiveModel.toLowerCase().startsWith('gemini')
    if (isGemini && opts.effort && opts.effort !== '') args.push('--effort', opts.effort)
    if (opts.conversationId) args.push('--conversation', opts.conversationId)
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
    args.push(...opts.extraArgs)
    if (opts.promptViaStdin) {
      args.push('--input-format', 'stream-json')
    } else {
      args.push('-p', opts.prompt)
    }
    return args
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.deps.getConfig()
    const bin = this.deps.bin()
    if (!bin) throw new LlmError('agy binary not found on PATH — install it via https://antigravity.google/docs/cli/install', Err.AGY_NOT_INSTALLED)
    const isReview = typeof options.system === 'string' && options.system.includes('REVIEW_POLICY')
    const isAux = options.purpose === 'compaction' || options.purpose === 'session-title' || isReview
    if (isAux && !isReview && !cfg.allowAuxiliary) {
      throw new LlmError('auxiliary calls are disabled for the antigravity route (allowAuxiliary: false)', Err.AUX_DISABLED)
    }
    // Prefer direct native agy_tool cards when the host registered the mirror
    // tool. Code Mode (`run_code` only) still wraps, because that host rejects
    // non-run_code tool-call blocks — but when agy_tool is callable we emit it
    // so DSH's toolview can render terminal/diff cards instead of "replay agy
    // tool step N · run_command" code rows.
    const toolNames = new Set((options.tools ?? []).map((t) => t.name))
    const isCodeMode = toolNames.has('run_code') && !toolNames.has('agy_tool')
    const hasToolSupport = options.tools === undefined || toolNames.has('agy_tool') || toolNames.has('run_code')
    const sessionKey = options.sessionId !== undefined ? String(options.sessionId) : ''
    // cwd precedence: explicit config > the DSH session's own workspace >
    // the host process cwd. The last fallback can land agy in an UNRELATED
    // directory (wherever the DSH server was started) — with permissionMode
    // 'skip' that is a silent wrong-workspace write path, so log it loudly
    // once per session instead of failing the turn.
    let workspaceRoot = cfg.workspaceRoot
    if (workspaceRoot === '') {
      const fromSession = sessionKey !== '' ? this.deps.sessionCwd?.(sessionKey) : undefined
      if (fromSession) {
        workspaceRoot = fromSession
      } else {
        workspaceRoot = process.cwd()
        this.warnOnce(
          'cwd:' + (sessionKey || 'anon'),
          'session workspace unresolved (sessionId=' + (sessionKey || 'none') + ') — running agy in the DSH process cwd: ' + workspaceRoot,
        )
      }
    }

    // ---- native tool mirroring: continuation spans (v0.3) ----
    // When the previous span cut on a completed agy tool step, DSH dispatched
    // the agy_tool mirror (which replayed the recorded output) and is now
    // calling us again to continue the SAME run. Resume the recording from
    // the cursor encoded in the trailing tool-result callId — no new process,
    // no prompt assembly, no digest.
    const continuation = detectContinuation(options.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec !== undefined) {
        yield* this.driveSpan(rec, continuation.eventIndex + 1, hasToolSupport, isCodeMode)
        return
      }
      this.warnOnce(
        'stale-continuation:' + continuation.runId,
        'agy run ' + continuation.runId + ' is no longer available in memory (server restarted?) — falling back to fresh turn prompt assembly',
      )
    }
    // Session ownership (steer preemption + duplicate debounce) is decided
    // AFTER prompt assembly below, so an identical retry can never abort a
    // live long-running tool (issue #33), while a true steer still can.
    const catalog = this.deps.catalog.get()
    const rawModel = options.model
    const model = resolveModelSlug(rawModel)
    const entry = findEntry(catalog, model)
    const isGemini = (model === '' ? cfg.defaultModel : model).toLowerCase().startsWith('gemini')
    // The catalog is advisory (the fallback list may be stale): accept unknown
    // ids, but validate explicit reasoning efforts against known entries.
    let effort: string | undefined
    if (isGemini) {
      if (isAux) {
        effort = 'low'
      } else if (options.reasoningEffort !== undefined) {
        const wanted = String(options.reasoningEffort)
        if (entry && entry.efforts === null) {
          throw new LlmError('model ' + model + ' has no selectable reasoning efforts', Err.UNSUPPORTED_REASONING_EFFORT)
        }
        if (entry && entry.efforts && !entry.efforts.includes(wanted)) {
          throw new LlmError('reasoning effort ' + wanted + ' is not supported by ' + model, Err.UNSUPPORTED_REASONING_EFFORT)
        }
        effort = wanted
      } else if (entry && entry.efforts) {
        effort = defaultEffortFor(entry, cfg)
      }
    }

    // ---- prompt assembly (ADR-7) ----
    const messages = options.messages
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const mm = messages[i]
      if (mm !== undefined && mm.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    // Include tool-role messages (dsh-llm 0.1.7+) in the trailing span. A
    // post-tool hop's trailing run is otherwise empty and the call is
    // dispatched with no task at all (issue #34).
    const trailingUser = messages.slice(lastAssistantIdx + 1).filter((m) => {
      const role = (m as { role?: string }).role
      return role === 'user' || role === 'tool'
    })

    // Sliding-window rate limit protection per minute (for overnight batch / /goal stability)
    if (!isAux && cfg.rateLimitPerMinute > 0) {
      const now = Date.now()
      const windowStart = now - 60_000
      while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < windowStart) {
        this.requestTimestamps.shift()
      }
      if (this.requestTimestamps.length >= cfg.rateLimitPerMinute) {
        const delayMs = this.requestTimestamps[0]! + 60_000 - now
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
      this.requestTimestamps.push(Date.now())
    }

    let activeModel = model === '' ? cfg.defaultModel : model
    let family = modelFamilyOf(activeModel)
    let account = this.deps.pool ? this.deps.pool.selectAccount(family) : undefined
    if (this.deps.pool && this.deps.pool.getAccounts().length > 0 && !account) {
      if (cfg.autoFallbackModel) {
        const fallbackSlugs = ['gemini-3.5-flash', 'gemini-3.6-flash']
        for (const fb of fallbackSlugs) {
          const fbFam = modelFamilyOf(fb)
          const fbAcc = this.deps.pool.selectAccount(fbFam)
          if (fbAcc) {
            account = fbAcc
            family = fbFam
            activeModel = fb
            break
          }
        }
      }
      if (!account) {
        const countdown = this.deps.pool.getEarliestResetCountdown(family)
        const waitStr = countdown ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)` : ''
        throw new LlmError(`All Antigravity accounts in pool are in cooldown for ${family}${waitStr}. Add an account or wait for reset.`, Err.AGY_ERROR)
      }
    }

    const sessionAccountKey = account ? `${sessionKey}:${account.id}` : sessionKey
    let binding = sessionAccountKey !== '' ? this.deps.store.get(sessionAccountKey) : undefined

    // If a live run already owns this session and has named an agy
    // conversation, adopt it before prompt assembly. A tool-cut or caller
    // abort used to drop that id entirely, so the next hop started a brand
    // new conversation with a digest-only prompt (issue #35).
    if (binding === undefined && !isAux && sessionKey !== '') {
      const live = this.activeRuns.get(sessionKey)
      const liveCid = live !== undefined && !live.isSettled ? live.conversationId : null
      if (liveCid) {
        binding = {
          conversationId: liveCid,
          lastMessageCount: Math.max(0, lastAssistantIdx + 1),
          updatedAt: Date.now(),
          model: activeModel === '' ? cfg.defaultModel : activeModel,
        }
      }
    }

    // Model switch detection: If model changed in the session, drop stale agy conversation binding
    const currentModel = activeModel === '' ? cfg.defaultModel : activeModel
    if (!isAux && binding !== undefined && binding.model && binding.model !== currentModel) {
      if (sessionAccountKey !== '') this.deps.store.delete(sessionAccountKey)
      binding = undefined
    }

    // Compaction detection (ADR-013): If DSH compacted history or cleared earlier turns,
    // messages.length drops below the recorded watermark. Invalidate the stale agy
    // conversation binding so a clean agy session is started and seeded with the compacted summary.
    if (!isAux && binding !== undefined && messages.length < binding.lastMessageCount) {
      if (sessionAccountKey !== '') this.deps.store.delete(sessionAccountKey)
      binding = undefined
    }

    let prompt = ''
    if (isAux && options.purpose === 'compaction') {
      const cap = cfg.compactionMaxChars > 0 ? cfg.compactionMaxChars : 800_000
      const parts: string[] = []
      let used = 0
      for (const m of messages) {
        const text = textOf(m)
        if (text === '') continue
        const line = (m.role === 'user' ? 'User: ' : 'Assistant: ') + text
        parts.push(line)
        used += line.length
        if (used > cap) break
      }
      prompt = '[summarize this conversation for context compaction]\n\n' + parts.join('\n\n') + '\n\nProduce a compact summary that preserves decisions, file paths, and open tasks.'
    } else {
      const trailingText = trailingUser.map(textOf).filter((s) => s !== '')
      // A tool-result-only trailing span used to assemble an empty prompt
      // (or a digest that had already eaten the task). Always re-state the
      // latest real user turn so agy never runs without a question
      // (issues #34 / #35).
      const taskText = latestUserTaskText(messages)
      const trailingJoined = trailingText.join('\n\n')
      if (taskText !== '') {
        prompt = trailingText.includes(taskText) || trailingJoined.includes(taskText)
          ? trailingJoined
          : (trailingJoined === '' ? taskText : taskText + '\n\n' + trailingJoined)
      } else {
        prompt = trailingJoined
      }
      if (binding === undefined && lastAssistantIdx >= 0) {
        // First contact: bring agy up to speed with a bounded digest.
        prompt = buildDigest(messages, 0, cfg.digestMaxChars) + prompt
      } else if (binding !== undefined) {
        // Returning session: digest only the foreign turns since our
        // watermark (the user may have talked to another model in between).
        // Our own agy replies ride the native conversation history, and the
        // trailing user run is already the live prompt below.
        const from = Math.min(binding.lastMessageCount, messages.length)
        const end = Math.max(from, lastAssistantIdx + 1)
        const span = messages
          .slice(from, end)
          .filter((m) => m.role !== 'assistant' || isForeignAssistant(m))
        if (span.some((m) => m.role === 'assistant')) {
          prompt = buildDigest(span, 0, cfg.digestMaxChars) + prompt
        }
      }
    }
    if (cfg.forwardSystemPrompt && options.system) {
      prompt = 'System instructions:\n' + options.system + '\n\n' + prompt;
    }
    // ---- multimodal staging (v0.2): images ride as staged files ----
    let stagedDirs: string[] = []
    if (!isAux) {
      const imageRefs: ImageRefLike[] = []
      for (const m of trailingUser) {
        // Walk nested tool-result payloads too — attachments after a tool
        // hop used to be silently dropped on exactly those calls (issue #34).
        collectImageRefs(m, imageRefs)
      }
      // Also pick up images attached to earlier user turns in this request
      // when the trailing span itself carries none (tool-hop case).
      if (imageRefs.length === 0) {
        for (const m of messages) {
          if (m.role !== 'user' || isToolResultMessage(m)) continue
          collectImageRefs(m, imageRefs)
        }
      }
      if (imageRefs.length > 0 && this.deps.readImage) {
        const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
        const key = (sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon') + '-' + messages.length
        const res = await stageImages({
          dir,
          key,
          images: imageRefs,
          readImage: this.deps.readImage,
          maxImages: cfg.mediaMaxImages,
          maxBytes: cfg.mediaMaxBytes,
        })
        if (res.promptSuffix !== '') {
          prompt = prompt === ''
            ? (res.promptSuffix + '\n\n[Please inspect the attached image(s) using view_file and assist the user.]')
            : (prompt + '\n\n' + res.promptSuffix)
        }
        if (res.staged.length > 0) stagedDirs = [dir]
      }
      if (prompt.trim() === '') {
        throw new LlmError('request carries no user text or images to forward to agy', Err.AGY_ERROR)
      }
    } else if (prompt.trim() === '') {
      throw new LlmError('request carries no user text to forward to agy', Err.AGY_ERROR)
    }
    // Intentionally no prompt-side "recovery boundary" injection: keyword
    // matching on user text (missing/not found/enoent) false-positives and
    // is a plugin-side prompt injection. Guidance for missing_file lives in
    // /agy status via classifyToolError (commands.ts).

    // Session ownership: steer preemption + duplicate-submission debounce.
    //
    // - Identical prompt while a live run owns the session → BUSY. Never
    //   abort it: a mid-maven/compile agy tool is silent on stdout for many
    //   minutes (issue #33), and killing it to "retry" destroys the work.
    // - Different prompt while a live run owns the session → preempt (steer).
    // - Once a run has settled (success / error / abort) a retry of the same
    //   prompt must go through: DSH auto-retries after failures, and a
    //   time-only wall turned every fast agy failure into a BUSY dead-end
    //   (issue #32).
    if (!isAux && sessionKey !== '') {
      const now = Date.now()
      if (this.activeSessionPrompts.size > 100) {
        for (const [k, v] of this.activeSessionPrompts) {
          if (now - v.startedAt >= 30_000) this.activeSessionPrompts.delete(k)
        }
      }
      const prevPrompt = this.activeSessionPrompts.get(sessionKey)
      const liveRun = this.activeRuns.get(sessionKey)
      const runLive = liveRun !== undefined && !liveRun.isSettled
      const samePrompt = prevPrompt !== undefined && prevPrompt.prompt === prompt
      if (runLive && samePrompt) {
        throw new LlmError(
          'Duplicate request ignored: an identical request is already running for this session.',
          Err.BUSY,
        )
      }
      // Pre-spawn race: identical prompt, still marked inFlight, no run
      // record yet. Keep the window tight so a user re-send after a fast
      // failure is never swallowed.
      if (
        samePrompt &&
        prevPrompt !== undefined &&
        prevPrompt.inFlight &&
        liveRun === undefined &&
        now - prevPrompt.startedAt < 2_000
      ) {
        throw new LlmError(
          'Duplicate request ignored: an identical request is already running for this session.',
          Err.BUSY,
        )
      }
      // Steer: a NEW prompt arrives while the previous run is still live.
      // Abort it so two agy processes never append to the same conversation.
      if (runLive && !samePrompt) {
        // Harvest the live conversation id BEFORE aborting: a tool-cut or
        // caller abort used to drop the binding entirely, so the replacement
        // process started a brand-new agy conversation with digest-only
        // prompt (issue #35 root cause ②).
        const liveCid = liveRun.conversationId
        if (
          liveCid !== null &&
          binding === undefined &&
          !isAux &&
          sessionAccountKey !== ''
        ) {
          binding = {
            conversationId: liveCid,
            lastMessageCount: Math.max(0, lastAssistantIdx + 1),
            updatedAt: Date.now(),
            model: currentModel,
          }
        }
        liveRun.requestAbort?.()
      }
      this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: now, inFlight: true })
    }

    // ---- spawn + record (v0.3: spans consume a shared recording) ----
    const before = snapshotConversations()
    const rec = this.deps.runs.create()
    rec.accountHome = account && account.dir ? account.dir : undefined
    const parser = new StreamJsonParser()
    this.deps.onParser?.(parser)
    let streamCid: string | null = null
    // In-progress agy tool steps (ACTIVE without DONE/ERROR). While any is
    // outstanding the child is legitimately silent on stdout (maven compile,
    // language-server build, …) — issue #33. Raise the idle budget to the
    // print-mode ceiling so the watchdog does not kill healthy long tools.
    const openToolKeys = new Set<string>()
    const printTimeoutMinutes = Math.max(240, Math.ceil(cfg.timeoutMs / 60_000))
    const longToolIdleMs = printTimeoutMinutes * 60_000
    let runningProc: ReturnType<typeof startAgyProcess> | null = null
    const applyToolIdleBudget = (): void => {
      runningProc?.noteActivity(openToolKeys.size > 0 ? longToolIdleMs : cfg.timeoutMs)
    }
    const activeModelForArgs = activeModel === '' ? cfg.defaultModel : activeModel
    // agy does not treat process cwd as its Active Workspace — it requires
    // --add-dir. Always attach the resolved workspace root (issue #26).
    const effectiveAddDirs = workspaceRoot !== ''
      ? (stagedDirs.includes(workspaceRoot) ? stagedDirs : [workspaceRoot, ...stagedDirs])
      : stagedDirs
    const argsBase = this.buildArgs({
      prompt,
      model: activeModelForArgs,
      effort,
      conversationId: !isAux && binding !== undefined ? binding.conversationId : undefined,
      permissionMode: isAux ? 'plan' : cfg.permissionMode,
      timeoutMs: cfg.timeoutMs,
      printTimeoutMinutes,
      extraArgs: cfg.extraArgs,
      addDirs: effectiveAddDirs,
    })
    // Decide transport: keep `-p <prompt>` for normal turns; switch to stdin
    // stream-json when the argv would approach the CreateProcess limit.
    const promptViaStdin = shouldUsePromptStdin(argsBase)
    const args = promptViaStdin
      ? this.buildArgs({
          prompt,
          model: activeModelForArgs,
          effort,
          conversationId: !isAux && binding !== undefined ? binding.conversationId : undefined,
          permissionMode: isAux ? 'plan' : cfg.permissionMode,
          timeoutMs: cfg.timeoutMs,
          printTimeoutMinutes,
          extraArgs: cfg.extraArgs,
          addDirs: effectiveAddDirs,
          promptViaStdin: true,
        })
      : argsBase
    const stdinPayload = promptViaStdin ? buildStreamInputLine(prompt) : undefined
    const release = await this.deps.acquire()
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      release()
    }
    // Only SECONDARY pool accounts get an isolated HOME. The primary
    // account rides the real system HOME (agy 1.1.15 keeps credentials in
    // the macOS Keychain); injecting HOME there signs agy out ("Please
    // sign in") and every turn fails with an auth error.
    if (account && account.dir) ensureIsolatedKeychain(account.dir)
    const env = {
      ...process.env,
      ...(cfg.disableTelemetry
        ? {
            DO_NOT_TRACK: '1',
            DISABLE_TELEMETRY: '1',
            GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
            ANTIGRAVITY_DISABLE_TELEMETRY: '1',
          }
        : {}),
      ...(account && account.dir ? isolatedHomeEnv(account.dir) : {}),
      // Dedicated account proxy wins; otherwise the global config proxy.
      ...proxyEnvFor(account?.proxyUrl || cfg.proxyUrl || undefined),
    }

    // Per-account burst spacing throttle with randomized jitter (prevents high-frequency flood to Google endpoints)
    if (account) {
      const lastSpawn = this.lastAccountSpawnTime.get(account.id) ?? 0
      const elapsed = Date.now() - lastSpawn
      const jitter = Math.floor(Math.random() * 300) // 100~400ms organic jitter
      const targetInterval = this.minSpawnIntervalMs + jitter
      if (elapsed < targetInterval) {
        await new Promise((r) => setTimeout(r, targetInterval - elapsed))
      }
      this.lastAccountSpawnTime.set(account.id, Date.now())
    }

    let proc: ReturnType<typeof startAgyProcess>
    try {
      proc = startAgyProcess({
      bin,
      args,
      cwd: workspaceRoot,
      timeoutMs: cfg.timeoutMs,
      signal: options.signal,
      env,
      stdinPayload,
      onLine: (line) => {
        for (const ev of parser.feed(line + '\n')) {
          if (ev.kind === 'init' && ev.conversationId) streamCid = ev.conversationId
          if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
          if (ev.kind === 'step' && ev.stepKind === 'tool' && ev.tool) {
            // Mirror mapper's completion rule: DONE/ERROR state, or legacy
            // events that carry output/error without an explicit state.
            const completed =
              ev.state === 'DONE' ||
              ev.state === 'ERROR' ||
              (ev.state === undefined && (ev.tool.output !== undefined || ev.tool.error !== undefined))
            if (!completed) {
              if (!openToolKeys.has(ev.stepKey)) {
                openToolKeys.add(ev.stepKey)
                applyToolIdleBudget()
              }
            } else if (openToolKeys.delete(ev.stepKey)) {
              applyToolIdleBudget()
            }
          }
          rec.append(ev)
        }
      },
      })
      runningProc = proc
      // stdout can deliver the first lines before this assignment lands —
      // re-apply whatever tool-idle budget those events already requested.
      applyToolIdleBudget()
      if (!isAux && sessionKey !== '') {
        rec.requestAbort = () => proc.kill('abort')
        this.activeRuns.set(sessionKey, rec)
      }
    } catch (e) {
      releaseOnce()
      this.clearInFlightPrompt(sessionKey, prompt)
      throw new LlmError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
    }

    void (async () => {
      const outcome = await proc.outcome
      releaseOnce()
      if (this.activeRuns.get(sessionKey) === rec) this.activeRuns.delete(sessionKey)
      this.clearInFlightPrompt(sessionKey, prompt)
      for (const ev of parser.flush()) {
        if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
        rec.append(ev)
      }
      const diffed = diffConversations(before).conversationId
      const conversationId = streamCid ?? diffed
      // A result envelope the mapper will finish on: ok, or an error that
      // still carries a usable response. Anything else leaves the live span
      // un-finished, so the failure below reaches it through the recording.
      const r = rec.getResultEvent()
      const consumable = r !== null && (r.ok || r.response !== '')
      // Error classification scans ONLY stderr and the result envelope's
      // error field. stdout is model prose + event JSON: a run whose streamed
      // text merely MENTIONED "rate limit"/"quota" (or contained a hash with
      // "429") used to be misclassified as a quota failure, masking the real
      // error and slapping a ghost cooldown on a healthy account.
      const rawErrText = [outcome.stderrTail, parser.stats.lastResultError].filter(Boolean).join(' ')
      const isRateLimit = looksLikeRateLimit(rawErrText)
      let failure: { kind: 'error' | 'aborted'; code: string; message: string } | null = null
      if (outcome.aborted) {
        failure = { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
      } else if (outcome.timedOut) {
        const neverSpoke = outcome.stdout.trim() === ''
        failure = { kind: 'error', code: Err.TIMEOUT, message: 'agy run was idle for ' + cfg.timeoutMs + 'ms without output'
          + (neverSpoke
            ? ' — agy never emitted a single event; it is likely unable to reach Google (check proxy/network). 无法连接 Google，请检查代理或网络配置'
            : '') }
      } else if (sawAuthFailure(parser, outcome)) {
        failure = { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login' }
      } else if (isRateLimit) {
        const bestMsg = parser.stats.lastResultError || (outcome.stderrTail ? brief(outcome.stderrTail) : 'Rate limit or quota reached')
        failure = { kind: 'error', code: Err.AGY_ERROR, message: 'Google Antigravity quota / rate limit reached: ' + bestMsg }
      } else if (looksLikeEligibilityFailure(rawErrText) || looksLikeEligibilityFailure(parser.stats.lastResultError ?? '')) {
        // Region/account eligibility refusal (issue #32): a clear cause, not a
        // generic PROCESS_EXIT. Not retryable from this bridge.
        const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
        failure = {
          kind: 'error',
          code: Err.AGY_ERROR,
          message: ELIGIBILITY_ERROR_HINT + (detail !== '' ? ' (' + detail + ')' : ''),
        }
      } else if (!consumable) {
        if (outcome.code !== 0) {
          // agy reports its failure on STDOUT as a result envelope and often
          // exits 1 with EMPTY stderr; dropping the envelope here used to
          // leave users with a bare "agy exited with code 1" and no cause.
          // Prefer the envelope's error text, then the stderr tail.
          const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
          failure = { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + outcome.code + (detail !== '' ? ': ' + detail : '') }
        } else if (parser.stats.lastResultError) {
          failure = { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + parser.stats.lastResultError }
        } else {
          failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + parser.stats.garbage + ' unparseable lines)' }
        }
      }
      rec.settle(failure)
      if (failure === null) {
        if (account) this.deps.pool?.recordSuccess(account.id, family)
        if (!isAux && sessionAccountKey !== '') {
          const finalId = binding !== undefined ? binding.conversationId : conversationId
          if (finalId) {
            this.deps.store.set(sessionAccountKey, {
              conversationId: finalId,
              lastMessageCount: messages.length,
              updatedAt: Date.now(),
              model: activeModel,
            })
          }
        }
      } else {
        const effectiveRateLimit = isRateLimit || looksLikeRateLimit(failure.message)
        // Cooldown is a costly local penalty (account leaves rotation): only
        // HARD server-issued signatures may trigger it. Soft signals (model
        // overloaded) shape the message above but never cool the account.
        if (account && looksLikeHardRateLimit(rawErrText)) {
          this.deps.pool?.recordFailure(account.id, family, failure.message)
        }
        // Only authoritative auth states may flag an account: the old
        // /auth/i substring matched "oauth2.googleapis.com … i/o timeout"
        // transport noise and quarantined healthy accounts until a manual
        // quota refresh disproved the flag.
        if (account && shouldMarkAuthRequired(failure.code, failure.message)) {
          this.deps.pool?.markAuthRequired(account.id, failure.message)
        }
        const staleConversation =
          failure.code === Err.AUTH ||
          effectiveRateLimit ||
          (failure.message && /conversation.*(not found|invalid|not recognized|expired|does not exist)|session.*(expired|invalid)/i.test(failure.message))
        if (!isAux && sessionAccountKey !== '' && staleConversation) {
          // If auth expired or rate limit hit or conversation rejected, drop stale binding
          this.deps.store.delete(sessionAccountKey)
        } else if (!isAux && sessionAccountKey !== '' && !staleConversation) {
          // Abort / timeout / process-exit still leave a usable agy
          // conversation behind once init or the result envelope named one.
          // Persisting it here is what lets the next hop continue instead of
          // starting a fresh conversation with a digest-only prompt
          // (issue #35 root cause ②: "aborted 分支永远存不下来").
          const finalId = binding !== undefined ? binding.conversationId : conversationId
          if (finalId) {
            this.deps.store.set(sessionAccountKey, {
              conversationId: finalId,
              lastMessageCount: messages.length,
              updatedAt: Date.now(),
              model: activeModel,
            })
          }
        }
      }
      this.deps.onRun?.({
        // A response can be usable even when agy reports an individual tool
        // failure. Keep process health distinct from those raw tool errors:
        // collapsing them into one "ok" bit hid real denials in /agy status.
        processOk: !outcome.aborted && !outcome.timedOut && outcome.code === 0,
        processCode: outcome.aborted
          ? 'ABORTED'
          : outcome.timedOut
            ? Err.TIMEOUT
            : outcome.code === 0
              ? 'OK'
              : 'EXIT_' + String(outcome.code),
        toolErrors: rec.toolErrors(),
        durationMs: outcome.durationMs,
        model,
      })
    })().catch((err) => {
      releaseOnce()
      rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
    })

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
    yield* this.driveSpan(rec, 0, !isAux && hasToolSupport, isCodeMode)
  }

  /**
   * Stream one span of a recording: map events from `from` until the mapper
   * finishes (tool-calls cut or result stop), then let the queue drain. When
   * the recording settles without a consumable result, surface its failure
   * as this span's terminal chunk — the turn ends exactly like a native
   * provider error.
   */
  private async *driveSpan(
    rec: RunRecording,
    from: number,
    cutOnTool: boolean,
    useCodeWrapper: boolean,
  ): AsyncIterable<StreamChunk> {
    const queue = new ChunkQueue()
    void (async () => {
      // Resolve FULL tool args and thoughts from the agy conversation DB (agy's
      // stream output strips CodeContent/TargetContent/ReplacementContent via
      // filterToolParameters, and strips thought text from print mode). We
      // pre-resolve them so diff cards and reasoning blocks render real content.
      const resolved = new Map<number, Record<string, unknown>>()
      const resolvedThoughts = new Map<number, string>()
      const convId = rec.conversationId
      const mapper = new EventMapper({
        runId: rec.runId,
        cutOnTool,
        initialSawText: rec.sawTextBefore(from),
        useCodeWrapper,
        usage: rec,
        resolvedFullArgs: resolved,
        resolvedThoughts,
      })
      let i = from
      try {
        for await (const ev of rec.eventsFrom(from)) {
          const recordedThought = rec.getThoughts(i)
          if (recordedThought !== undefined) {
            resolvedThoughts.set(i, recordedThought)
          } else if (ev.kind === 'step') {
            const rawObj = ev.raw && typeof ev.raw === 'object' ? (ev.raw as Record<string, unknown>) : null
            const stepUpdate = rawObj?.step_update && typeof rawObj.step_update === 'object' ? (rawObj.step_update as Record<string, unknown>) : null
            const activeConvId =
              rec.conversationId ??
              (typeof rawObj?.conversation_id === 'string' ? rawObj.conversation_id : null) ??
              (typeof stepUpdate?.conversation_id === 'string' ? stepUpdate.conversation_id : null)
            const stepIdx = parseInt(ev.stepKey, 10)
            if (activeConvId !== null && Number.isFinite(stepIdx)) {
              try {
                let th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
                if (th === null && (ev.state === 'DONE' || (ev.usage?.thinking_tokens ?? 0) > 0 || ev.stepKind === 'thinking')) {
                  await new Promise((r) => setTimeout(r, 50))
                  th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
                }
                if (th !== null && th.trim() !== '') {
                  resolvedThoughts.set(i, th)
                  rec.setThoughts(i, th)
                }
              } catch {
                // DB read failure is non-fatal; fallback to token annotation.
              }
            }
          }
          if (ev.kind === 'step' && ev.stepKind === 'tool' && ev.tool) {
            const rawObj = ev.raw && typeof ev.raw === 'object' ? (ev.raw as Record<string, unknown>) : null
            const stepUpdate = rawObj?.step_update && typeof rawObj.step_update === 'object' ? (rawObj.step_update as Record<string, unknown>) : null
            const activeConvId =
              rec.conversationId ??
              (typeof rawObj?.conversation_id === 'string' ? rawObj.conversation_id : null) ??
              (typeof stepUpdate?.conversation_id === 'string' ? stepUpdate.conversation_id : null)
            const stepIdx = parseInt(ev.stepKey, 10)
            if (activeConvId !== null && Number.isFinite(stepIdx)) {
              try {
                let full = await readFullToolArgs(activeConvId, stepIdx, rec.accountHome)
                if (full === null) {
                  await new Promise((r) => setTimeout(r, 50))
                  full = await readFullToolArgs(activeConvId, stepIdx, rec.accountHome)
                }
                if (full !== null && full.args !== undefined) {
                  resolved.set(i, full.args)
                  rec.setFullArgs(i, full.args)
                }
              } catch {
                // DB read failure is non-fatal; stream args still render.
              }
            }
            // For write_to_file / create_file: if old content is not already present, resolve from git HEAD
            const toolName = ev.tool.name
            if (toolName === 'write_to_file' || toolName === 'write_file' || toolName === 'create_file') {
              const currentArgs = resolved.get(i) ?? (typeof ev.tool.args === 'object' && ev.tool.args !== null ? (ev.tool.args as Record<string, unknown>) : {})
              const targetFile = (currentArgs.TargetFile ?? currentArgs.target_file ?? currentArgs.path ?? currentArgs.AbsolutePath) as string | undefined
              if (targetFile && typeof targetFile === 'string' && !currentArgs.oldText && !currentArgs.old_string && !currentArgs.TargetContent) {
                const head = getGitHeadContent(targetFile)
                if (head !== null) {
                  const updated = { ...currentArgs, old_string: head }
                  resolved.set(i, updated)
                  rec.setFullArgs(i, updated)
                }
              }
            }
          }
          for (const ch of mapper.map(ev, i)) queue.push(ch)
          i++
          if (mapper.isFinished) break
        }
        if (!mapper.isFinished) {
          const f = rec.failureInfo
          if (f !== null) {
            for (const ch of mapper.emitFailure(f.kind, f.code, f.message)) queue.push(ch)
          } else {
            for (const ch of mapper.emitFailure('error', Err.INVALID_OUTPUT, 'agy stream ended without a result event')) queue.push(ch)
          }
        }
      } catch (err) {
        for (const ch of mapper.emitFailure('error', Err.PROCESS_EXIT, 'internal error: ' + brief(String(err)))) queue.push(ch)
      }
      queue.close()
    })()
    yield* queue.drain()
  }
}

/**
 * Detect a continuation span: the request's LAST message is the tool result
 * of one of our mirrored agy tool calls. Its callId encodes the recording
 * run and the event index to resume after.
 *
 * Accepts both dsh-llm tool-result shapes: `role: 'user'` + `source.callId`
 * (0.1.x) and `role: 'tool'` + `message.toolCallId` (0.1.7+). Rejecting the
 * latter made every post-tool hop spawn a fresh agy process with a
 * digest-only prompt (issues #34 / #35).
 */
export function detectContinuation(messages: readonly Message[]): { runId: string; eventIndex: number } | null {
  // DSH may append plugin-owned snapshots after it stores a tool result.
  // Extend PR #15's backward scan using DSH's explicit snapshot form.
  // Other plugin forms can carry new instructions and must not be skipped.
  // A human message, another provider's tool result, or any unknown
  // boundary must stop the scan: continuing past one could replay a run for
  // the wrong request instead of spawning the requested turn.
  let i = messages.length - 1
  while (i >= 0) {
    const snapshot = messages[i] as unknown as { source?: { kind?: string; form?: string } }
    if (snapshot.source?.kind !== 'plugin' || snapshot.source.form !== 'snapshot') break
    i--
  }
  const last = messages[i]
  if (last === undefined) return null
  const role = (last as { role?: string }).role
  if (role !== 'user' && role !== 'tool') return null
  if (!isToolResultMessage(last)) return null
  const callId = toolCallIdOf(last)
  if (callId === null) return null
  return parseMirrorCallId(callId)
}
