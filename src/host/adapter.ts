// AgyAdapter — the LlmAdapter implementation at the heart of the plugin
// (spec section 3). Translates one DSH model call into a short-lived
// `agy -p --output-format stream-json` child process, maps the NDJSON event
// stream onto StreamChunks, and binds DSH sessions to agy conversations for
// multi-turn continuity (ADR-4). Only the trailing user messages become the
// prompt; earlier context rides agy-native history plus a digest prefix on
// first bind (ADR-7).
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Err, looksLikeAuthFailure, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { diffConversations, snapshotConversations } from './discovery.ts'
import { EventMapper } from './mapper.ts'
import { parseMirrorCallId, type RunRecording, type RunRegistry } from './recording.ts'
import { defaultEffortFor, findEntry, ModelCatalog } from './models.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, stageImages, type ImageRefLike } from './media.ts'
import { startAgyProcess } from './runner.ts'
import { stateDir } from '../common/config.ts'
import type { SessionStore } from './sessions.ts'

type ForeignSource = { source?: { kind?: string; provider?: string } }

function textOf(m: Message): string {
  const parts: string[] = []
  for (const b of m.content) {
    if (b.type === 'text') parts.push(b.text)
  }
  return parts.filter((s) => s !== '').join('\n')
}

function isForeignAssistant(m: Message): boolean {
  if (m.role !== 'assistant') return false
  const src = (m as unknown as ForeignSource).source
  return !src || src.provider !== PROVIDER_ID
}

/** Rolling digest of turns this agy conversation has not seen (ADR-7). */
export function buildDigest(messages: readonly Message[], fromIdx: number, maxChars: number): string {
  const parts: string[] = []
  let budget = maxChars
  for (let i = messages.length - 1; i >= fromIdx; i--) {
    const m = messages[i]
    if (m === undefined || m.role === 'system') continue
    const text = textOf(m)
    if (text === '') continue
    const line = (m.role === 'user' ? 'User: ' : 'Assistant: ') + text
    if (line.length > budget) {
      parts.unshift(line.slice(0, Math.max(0, budget)))
      break
    }
    budget -= line.length
    parts.unshift(line)
  }
  if (parts.length === 0) return ''
  return '[conversation so far]\n' + parts.join('\n\n') + '\n[end of conversation so far]\n\n'
}

export interface AgyAdapterDeps {
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  store: SessionStore
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
  /** Last-run telemetry surfaced by /agy status. */
  onRun?: (info: { ok: boolean; code: string; durationMs: number; model: string }) => void
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
  constructor(private readonly deps: AgyAdapterDeps) {
    super()
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
    return cat.models.map((m) => ({
      provider: PROVIDER_ID,
      id: m.id,
      name: m.name,
      inputModalities: ['text'] as const,
    }))
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const cfg = this.deps.getConfig()
    const cat = this.deps.catalog.get()
    const entry = findEntry(cat, model)
    const name = entry ? entry.name : model
    const resolved: LlmResolvedModelInfo = {
      provider: PROVIDER_ID,
      id: model,
      name,
      inputModalities: ['text'] as const,
      context: { contextWindow: cfg.contextWindowDefault },
      defaultMaxTokens: cfg.maxTokensDefault,
    }
    if (entry && entry.efforts) {
      const def = defaultEffortFor(entry, cfg)
      resolved.reasoning = {
        efforts: entry.efforts.map((e) => ({ id: e as never, name: e })),
        ...(def ? { defaultEffort: def as never } : {}),
      }
    }
    return resolved
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
  }): string[] {
    const args: string[] = ['--output-format', 'stream-json', '--print-timeout', Math.max(1, Math.ceil(opts.timeoutMs / 60_000)) + 'm']
    if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
    else args.push('--mode', opts.permissionMode)
    if (opts.model !== '') args.push('--model', opts.model)
    if (opts.effort && opts.effort !== '') args.push('--effort', opts.effort)
    if (opts.conversationId) args.push('--conversation', opts.conversationId)
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
    args.push(...opts.extraArgs)
    args.push('-p', opts.prompt)
    return args
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.deps.getConfig()
    const bin = this.deps.bin()
    if (!bin) throw new LlmError('agy binary not found on PATH — install it via https://antigravity.google/docs/cli/install', Err.AGY_NOT_INSTALLED)
    const isAux = options.purpose === 'compaction' || options.purpose === 'session-title'
    if (isAux && !cfg.allowAuxiliary) {
      throw new LlmError('auxiliary calls are disabled for the antigravity route (allowAuxiliary: false)', Err.AUX_DISABLED)
    }
    const sessionKey = options.sessionId !== undefined ? String(options.sessionId) : ''
    const workspaceRoot = cfg.workspaceRoot !== '' ? cfg.workspaceRoot : this.deps.sessionCwd?.(sessionKey) || process.cwd()

    // ---- native tool mirroring: continuation spans (v0.3) ----
    // When the previous span cut on a completed agy tool step, DSH dispatched
    // the agy_tool mirror (which replayed the recorded output) and is now
    // calling us again to continue the SAME run. Resume the recording from
    // the cursor encoded in the trailing tool-result callId — no new process,
    // no prompt assembly, no digest.
    const continuation = detectContinuation(options.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec === undefined) {
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'agy run ' + continuation.runId + ' is no longer available (server restarted?) — please resend your message',
              code: Err.AGY_ERROR,
            },
          },
        }
        return
      }
      yield* this.driveSpan(rec, continuation.eventIndex + 1, true)
      return
    }
    const catalog = this.deps.catalog.get()
    const model = options.model
    const entry = findEntry(catalog, model)
    // The catalog is advisory (the fallback list may be stale): accept unknown
    // ids, but validate explicit reasoning efforts against known entries.
    let effort: string | undefined
    if (options.reasoningEffort !== undefined) {
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
    const trailingUser = messages.slice(lastAssistantIdx + 1).filter((m) => m.role === 'user')
    const binding = sessionKey !== '' ? this.deps.store.get(sessionKey) : undefined
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
      prompt = trailingText.join('\n\n')
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
        for (const b of (m as { content?: readonly unknown[] }).content ?? []) {
          const blk = b as { type?: string; attachment?: ImageRefLike }
          if (blk && blk.type === 'image' && blk.attachment) imageRefs.push(blk.attachment)
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
        if (res.promptSuffix !== '') prompt = prompt === '' ? res.promptSuffix : prompt + '\n\n' + res.promptSuffix
        if (res.staged.length > 0) stagedDirs = [dir]
      }
      if (prompt.trim() === '') {
        throw new LlmError('request carries no user text or images to forward to agy', Err.AGY_ERROR)
      }
    } else if (prompt.trim() === '') {
      throw new LlmError('request carries no user text to forward to agy', Err.AGY_ERROR)
    }

    // ---- spawn + record (v0.3: spans consume a shared recording) ----
    const before = snapshotConversations()
    const rec = this.deps.runs.create()
    const parser = new StreamJsonParser()
    this.deps.onParser?.(parser)
    let streamCid: string | null = null
    const args = this.buildArgs({
      prompt,
      model: model === '' ? cfg.defaultModel : model,
      effort,
      conversationId: !isAux && binding !== undefined ? binding.conversationId : undefined,
      permissionMode: isAux ? 'plan' : cfg.permissionMode,
      timeoutMs: cfg.timeoutMs,
      extraArgs: cfg.extraArgs,
      addDirs: stagedDirs,
    })
    const release = await this.deps.acquire()
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      release()
    }
    let proc: ReturnType<typeof startAgyProcess>
    try {
      proc = startAgyProcess({
      bin,
      args,
      cwd: workspaceRoot,
      timeoutMs: cfg.timeoutMs,
      signal: options.signal,
      onLine: (line) => {
        for (const ev of parser.feed(line + '\n')) {
          if (ev.kind === 'init' && ev.conversationId) streamCid = ev.conversationId
          if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
          rec.append(ev)
        }
      },
      })
    } catch (e) {
      releaseOnce()
      throw new LlmError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
    }

    void (async () => {
      const outcome = await proc.outcome
      releaseOnce()
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
      let failure: { kind: 'error' | 'aborted'; code: string; message: string } | null = null
      if (outcome.aborted) {
        failure = { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
      } else if (outcome.timedOut) {
        failure = { kind: 'error', code: Err.TIMEOUT, message: 'agy run exceeded the watchdog budget (' + cfg.timeoutMs + 'ms)' }
      } else if (sawAuthFailure(parser, outcome)) {
        failure = { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login' }
      } else if (!consumable) {
        if (outcome.code !== 0) {
          failure = { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + outcome.code + (outcome.stderrTail !== '' ? ': ' + brief(outcome.stderrTail) : '') }
        } else if (parser.stats.lastResultError) {
          failure = { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + parser.stats.lastResultError }
        } else {
          failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + parser.stats.garbage + ' unparseable lines)' }
        }
      }
      rec.settle(failure)
      if (!isAux && sessionKey !== '' && failure === null) {
        const finalId = binding !== undefined ? binding.conversationId : conversationId
        if (finalId) {
          this.deps.store.set(sessionKey, {
            conversationId: finalId,
            lastMessageCount: messages.length,
            updatedAt: Date.now(),
            model,
          })
        }
      }
      this.deps.onRun?.({
        ok: failure === null,
        code: failure !== null ? failure.code : 'OK',
        durationMs: outcome.durationMs,
        model,
      })
    })().catch((err) => {
      releaseOnce()
      rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
    })

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
    yield* this.driveSpan(rec, 0, !isAux)
  }

  /**
   * Stream one span of a recording: map events from `from` until the mapper
   * finishes (tool-calls cut or result stop), then let the queue drain. When
   * the recording settles without a consumable result, surface its failure
   * as this span's terminal chunk — the turn ends exactly like a native
   * provider error.
   */
  private async *driveSpan(rec: RunRecording, from: number, cutOnTool: boolean): AsyncIterable<StreamChunk> {
    const queue = new ChunkQueue()
    void (async () => {
      const mapper = new EventMapper({
        runId: rec.runId,
        cutOnTool,
        initialSawText: rec.sawTextBefore(from),
      })
      let i = from
      try {
        for await (const ev of rec.eventsFrom(from)) {
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
 */
export function detectContinuation(messages: readonly Message[]): { runId: string; eventIndex: number } | null {
  const last = messages[messages.length - 1]
  if (last === undefined || last.role !== 'user') return null
  const src = (last as unknown as { source?: { kind?: string; callId?: string } }).source
  if (src === undefined || src.kind !== 'tool' || typeof src.callId !== 'string') return null
  return parseMirrorCallId(src.callId)
}
