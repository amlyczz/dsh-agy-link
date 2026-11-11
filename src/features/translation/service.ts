// TranslationService: target resolution, chunking, caching, bounded retry and
// optional durable record. The model call and record append are injected, so
// account selection/rotation stays in the adapter and every branch is testable.
import { Err } from '../../common/types.ts'
import { cacheKey, buildTranslationRecord } from './records.ts'
import {
  buildTranslationPrompt,
  buildTranslationRequest,
  buildTranslationSetup,
  chunkText,
} from './prompt.ts'
import {
  allTextOfTurn,
  finalAnswerOfTurn,
  findTranslationRecord,
  isTurnRunning,
  lastCompletedTurn,
  sessionDigest,
  sessionEvents,
  turnOfMessage,
} from './session.ts'
import { resolveTranslateTarget } from './target.ts'
import {
  MAX_CACHE_ENTRIES,
  TRANSLATION_RECORD_TYPE,
  type PendingTranslation,
  type SessionEventLike,
  type TranslateFailureCode,
  type TranslateRequest,
  type TranslateResult,
  type TranslateTarget,
  type TranslateTurnOptions,
  type TranslationRunnerRequest,
  type TranslationRunnerResult,
  type TranslationServiceDeps,
  type TurnAnswer,
} from './types.ts'

/** Codes worth another attempt on a (probably) different account. */
const RETRYABLE_CODES = new Set<string>([
  Err.RATE_LIMIT,
  Err.QUOTA,
  Err.NETWORK,
  Err.OVERLOADED,
  Err.ELIGIBILITY,
  Err.AUTH,
  Err.TIMEOUT,
  Err.PROCESS_EXIT,
  // Not an account problem and not deterministic either: the model finished
  // without any text (an empty candidate). Re-asking is the only cure, and the
  // second attempt almost always returns prose.
  Err.EMPTY_RESPONSE,
])

function failureText(code: string | undefined, message: string | undefined): string {
  if (message !== undefined && message.trim() !== '') return message
  switch (code) {
    case Err.AGY_NOT_INSTALLED:
      return 'agy binary not found — install it via https://antigravity.google/docs/cli/install'
    case Err.AUTH:
      return 'agy is not signed in — run /agy auth'
    case Err.AUX_DISABLED:
      return 'auxiliary calls are disabled for the antigravity route (allowAuxiliary: false)'
    case Err.RATE_LIMIT:
    case Err.QUOTA:
      return 'Antigravity quota exhausted on every available account'
    case Err.EMPTY_RESPONSE:
      return 'the model returned nothing this time — retry'
    default:
      return 'translation failed'
  }
}

function mapCode(raw: string | undefined): TranslateFailureCode {
  if (raw === Err.RATE_LIMIT || raw === Err.QUOTA) return 'NO_ACCOUNT'
  if (raw === Err.AUTH || raw === Err.NETWORK || raw === Err.ELIGIBILITY) return 'AGY_ERROR'
  if (raw === Err.TIMEOUT) return 'TIMEOUT'
  if (raw === 'ABORTED') return 'ABORTED'
  if (raw === Err.AUX_DISABLED) return 'AUX_DISABLED'
  return 'AGY_ERROR'
}

function emptyResult(model: string, effort: string): TranslateResult {
  return { ok: false, text: '', model, effort, cached: false, durationMs: 0 }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `gemini-3.8-flash` vs a provider-qualified id such as `auto/gemini-3.8-flash`. */
function sameModel(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/^.*\//, '')
  return norm(a) === norm(b)
}

/**
 * Orchestrates translation: target resolution, chunking, caching, bounded
 * retry, optional durable record. Session text extraction lives in session.ts
 * as pure functions so the command, the auto hook and the button share one logic.
 */
export class TranslationService {
  private readonly cache = new Map<string, TranslateResult>()
  private readonly inflight = new Map<string, Promise<TranslateResult>>()
  private readonly pending = new Map<string, PendingTranslation>()
  private readonly lastAutoAt = new Map<string, number>()
  private last: TranslateResult | null = null
  private count = 0
  private cacheHits = 0

  constructor(private readonly deps: TranslationServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  target(override?: { model?: string; effort?: string }): TranslateTarget {
    return resolveTranslateTarget(this.deps.cfg(), this.deps.catalog(), override)
  }

  stats(): { count: number; cacheHits: number; last: TranslateResult | null } {
    return { count: this.count, cacheHits: this.cacheHits, last: this.last }
  }

  pendingFor(sessionId?: string): PendingTranslation[] {
    if (sessionId !== undefined) {
      const one = this.pending.get(sessionId)
      return one === undefined ? [] : [one]
    }
    return [...this.pending.values()]
  }

  /** Translate arbitrary text (the shared code path every entry uses). */
  async translate(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateResult> {
    const text = req.text ?? ''
    const target = this.target({ ...(req.model === undefined ? {} : { model: req.model }), ...(req.effort === undefined ? {} : { effort: req.effort }) })
    if (text.trim() === '') {
      return { ...emptyResult(target.model, target.effort), error: 'nothing to translate', code: 'EMPTY_TEXT' }
    }
    const language = req.targetLanguage ?? this.deps.cfg().translateTargetLanguage
    const key = cacheKey(target.model, target.effort, language, text)
    if (req.force !== true) {
      const hit = this.cache.get(key)
      if (hit !== undefined) {
        this.cacheHits++
        this.last = { ...hit, cached: true }
        return this.last
      }
      const running = this.inflight.get(key)
      if (running !== undefined) return running
    }
    const task = this.runChunked(text, target, language, signal, req.sessionId).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, task)
    return task
  }

  private async runChunked(
    text: string,
    target: TranslateTarget,
    language: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<TranslateResult> {
    const cfg = this.deps.cfg()
    const startedAt = this.now()
    const chunks = chunkText(text, cfg.translateMaxChars)
    const out: string[] = []
    let accountId: string | undefined
    // The persona block is rebuilt per request (pure) but only used by the
    // adapter when the translation conversation is created.
    const setupEvents = sessionId === undefined ? [] : sessionEvents(this.deps.getSession(sessionId))
    for (const chunk of chunks) {
      const res = await this.withRetry(
        {
          // Self-contained prompt: used verbatim when the run is NOT bound to a
          // translation conversation (older host, or the knob turned off). The
          // DSH session id rides along so the model knows which thread this one
          // reply belongs to, without carrying any history in the prompt.
          prompt: buildTranslationPrompt(chunk, language, cfg.translateMaxChars, sessionId),
          // Bound path: the per-turn request line + source, plus the persona that
          // is sent only when that conversation is created.
          text: buildTranslationRequest(chunk, language, cfg.translateMaxChars),
          setup: sessionId === undefined ? undefined : this.setupFor(sessionId, language, setupEvents),
          ...(sessionId === undefined ? {} : { sessionId }),
          model: target.model,
          ...(target.effort === '' ? {} : { effort: target.effort }),
          maxTokens: cfg.translateMaxTokens,
          timeoutMs: cfg.translateTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
        cfg.translateRetries,
        signal,
      )
      if (!res.ok) {
        const result: TranslateResult = {
          ok: false,
          text: out.join('\n\n'),
          model: target.model,
          effort: target.effort,
          cached: false,
          durationMs: this.now() - startedAt,
          error: failureText(res.code, res.error),
          code: mapCode(res.code),
        }
        this.last = result
        return result
      }
      if (res.accountId !== undefined) accountId = res.accountId
      out.push(res.text.trim())
    }
    const result: TranslateResult = {
      ok: true,
      text: out.join('\n\n'),
      model: target.model,
      effort: target.effort,
      cached: false,
      durationMs: this.now() - startedAt,
      ...(accountId === undefined ? {} : { accountId }),
    }
    this.count++
    // Store a COPY: the caller (translateTurn) decorates its result with
    // turn/recordSeq, and those must never leak into a later cache hit.
    this.remember(cacheKey(target.model, target.effort, language, text), { ...result })
    this.last = result
    return result
  }

  private remember(key: string, result: TranslateResult): void {
    this.cache.set(key, result)
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }

  private async withRetry(
    req: TranslationRunnerRequest,
    retries: number,
    signal?: AbortSignal,
  ): Promise<TranslationRunnerResult> {
    const max = Math.max(0, Math.round(retries))
    let last: TranslationRunnerResult = { ok: false, text: '', error: 'translation was never attempted', code: Err.AGY_ERROR }
    for (let attempt = 0; attempt <= max; attempt++) {
      if (signal?.aborted === true) {
        last = { ok: false, text: '', error: 'aborted', code: 'ABORTED' }
        break
      }
      try {
        last = await this.deps.run(req)
      } catch (e) {
        last = { ok: false, text: '', error: e instanceof Error ? e.message : String(e), code: Err.AGY_ERROR }
      }
      if (last.ok) return last
      if (last.code === 'ABORTED' || (last.code !== undefined && !RETRYABLE_CODES.has(last.code))) break
      // An empty candidate is not a queue/account stall, so a token delay would
      // just re-ask into the same flake: give the model a beat before retrying.
      const pause = last.code === Err.EMPTY_RESPONSE ? 900 * (attempt + 1) : 150 * (attempt + 1)
      if (attempt < max) await delay(pause, signal)
    }
    return last
  }

  /**
   * Persona block for one DSH session's translation conversation. Built on every
   * request (pure and cheap) but only USED when that conversation is created, so
   * a conversation that was lost re-seeds itself with fresh context.
   */
  private setupFor(sessionId: string, language: string, events: readonly SessionEventLike[]): string | undefined {
    const cwd = this.deps.sessionCwd?.(sessionId)
    const logPath = this.deps.sessionLogPath?.(sessionId)
    const digest = sessionDigest(events, this.deps.cfg().translateMaxChars)
    return buildTranslationSetup({
      sessionId,
      targetLanguage: language,
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      ...(logPath === undefined || logPath === '' ? {} : { logPath }),
      ...(digest === '' ? {} : { digest }),
    })
  }

  /** Translate one turn of a session and (optionally) persist the card record. */
  async translateTurn(sessionId: string, turn: number, opts: TranslateTurnOptions = {}, signal?: AbortSignal): Promise<TranslateResult> {
    const session = this.deps.getSession(sessionId)
    const events = sessionEvents(session)
    const target = this.target(opts)
    if (session === undefined || events.length === 0) {
      return { ...emptyResult(target.model, target.effort), error: 'session is not available', code: 'SESSION_UNAVAILABLE' }
    }
    if (isTurnRunning(events, turn)) {
      return { ...emptyResult(target.model, target.effort), error: 'the current turn is still running', code: 'TRANSIENT' }
    }
    const answer = opts.full === true ? allTextOfTurn(events, turn) : finalAnswerOfTurn(events, turn)
    if (answer === null || answer.text.trim() === '') {
      return { ...emptyResult(target.model, target.effort), error: 'no assistant text in turn ' + turn, code: 'TURN_NOT_FOUND' }
    }
    return this.translateAnswer(sessionId, turn, answer, opts, signal)
  }

  /**
   * Translate exactly ONE assistant message (the shared body of the turn command
   * and the per-reply button). The button passes the message the reader clicked:
   * a turn can hold several text messages (a preamble, tool narration, then the
   * real answer), and resolving them through "the turn's last answer" made the
   * card show a *different* message than the one that was clicked.
   */
  private async translateAnswer(
    sessionId: string,
    turn: number,
    answer: TurnAnswer,
    opts: TranslateTurnOptions,
    signal?: AbortSignal,
  ): Promise<TranslateResult> {
    const target = this.target(opts)
    const events = sessionEvents(this.deps.getSession(sessionId))
    if (opts.force !== true) {
      const existing = findTranslationRecord(events, turn, target.model, target.effort, answer.messageId)
      if (existing !== null) {
        // Already translated with this exact recipe: hand back the durable card
        // instead of paying for a second identical call. The match is scoped to
        // the message, so a sibling reply in the same turn is NOT reused.
        return {
          ok: true,
          text: existing.text,
          model: existing.model === '' ? target.model : existing.model,
          effort: existing.effort,
          cached: true,
          durationMs: 0,
          recordSeq: existing.seq,
          turn,
        }
      }
    }
    const res = await this.translate(
      {
        text: answer.text,
        sessionId,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.effort === undefined ? {} : { effort: opts.effort }),
        ...(opts.targetLanguage === undefined ? {} : { targetLanguage: opts.targetLanguage }),
        ...(opts.force === undefined ? {} : { force: opts.force }),
      },
      signal,
    )
    res.turn = turn
    if (res.ok && opts.persist !== false) {
      res.recordSeq = await this.appendRecord(sessionId, turn, answer, res)
    }
    return res
  }

  /** Durable translation already stored for one turn (status route / chip). */
  existingTurn(sessionId: string, turn: number, model?: string, effort?: string): { seq: number; text: string; model: string; effort: string } | null {
    const events = sessionEvents(this.deps.getSession(sessionId))
    return findTranslationRecord(events, turn, model, effort)
  }

  /**
   * Durable translation already stored for the turn that owns one assistant
   * message. The per-reply button asks this on mount, so a finished
   * translation still shows as "done" after a remount, a window switch or a
   * page reload — the card lives in the session, so the affordance reads its
   * state from the session too.
   */
  existingMessage(
    sessionId: string,
    messageId: string,
  ): { seq: number; text: string; model: string; effort: string } | null {
    const events = sessionEvents(this.deps.getSession(sessionId))
    for (const ev of events) {
      if (ev.type !== TRANSLATION_RECORD_TYPE) continue
      const d = ev.data !== null && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : {}
      if (d.messageId !== messageId) continue
      const text = typeof d.text === 'string' ? d.text : ''
      if (text.trim() === '') continue
      return {
        seq: typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0,
        text,
        model: typeof d.model === 'string' ? d.model : '',
        effort: typeof d.effort === 'string' ? d.effort : '',
      }
    }
    const located = turnOfMessage(events, messageId)
    if (located === null) return null
    // Legacy records written before `messageId` existed are the last resort, and
    // only while the turn has no message-scoped record at all (see
    // findTranslationRecord) — otherwise message B would show "done" because
    // message A had been translated.
    return findTranslationRecord(events, located.turn, undefined, undefined, messageId)
  }

  /** True while a translation is running for this session. */
  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /** Translate the newest completed turn of a session. */
  async translateLastTurn(sessionId: string, opts: TranslateTurnOptions = {}, signal?: AbortSignal): Promise<TranslateResult> {
    const events = sessionEvents(this.deps.getSession(sessionId))
    const turn = lastCompletedTurn(events)
    if (turn === null) {
      const target = this.target(opts)
      return { ...emptyResult(target.model, target.effort), error: 'no completed turn in this session', code: 'TURN_NOT_FOUND' }
    }
    return this.translateTurn(sessionId, turn, opts, signal)
  }

  /** Translate exactly the assistant message the reader clicked. */
  async translateMessage(sessionId: string, messageId: string, opts: TranslateTurnOptions = {}, signal?: AbortSignal): Promise<TranslateResult> {
    const events = sessionEvents(this.deps.getSession(sessionId))
    const target = this.target(opts)
    if (events.length === 0) {
      return { ...emptyResult(target.model, target.effort), error: 'session is not available', code: 'SESSION_UNAVAILABLE' }
    }
    const located = turnOfMessage(events, messageId)
    if (located === null) {
      const last = lastCompletedTurn(events)
      if (last !== null) {
        return this.translateTurn(sessionId, last, { ...opts, full: false }, signal)
      }
      return { ...emptyResult(target.model, target.effort), error: 'message not found in this session', code: 'MESSAGE_NOT_FOUND' }
    }
    // A message that carries no prose (a tool-only step) cannot be explained;
    // fall back to that turn's real answer instead of failing the click.
    const answer: TurnAnswer | null =
      located.text.trim() === '' ? finalAnswerOfTurn(events, located.turn) : located
    if (answer === null || answer.text.trim() === '') {
      return { ...emptyResult(target.model, target.effort), error: 'that message carries no text to translate', code: 'MESSAGE_NOT_FOUND' }
    }
    // Keep the CLICKED message's id (and anchor) even when its content fell back
    // to the turn answer: the card must land under the reply the reader chose.
    const scoped: TurnAnswer = {
      text: answer.text,
      anchorSeq: located.anchorSeq !== 0 ? located.anchorSeq : answer.anchorSeq,
      messageId,
      ...(answer.sourceModel === undefined ? {} : { sourceModel: answer.sourceModel }),
    }
    return this.translateAnswer(sessionId, located.turn, scoped, { ...opts, full: false }, signal)
  }

  /**
   * Automatic post-turn translation. Returns the result (or null when the
   * guards skip this turn) and never throws: a failed translation must not
   * disturb the agent loop that just finished.
   */
  async autoTranslateTurn(sessionId: string, turn: number): Promise<TranslateResult | null> {
    const cfg = this.deps.cfg()
    const enabled = this.deps.autoEnabled?.(sessionId) ?? cfg.autoTranslate
    if (!enabled) return null
    const events = sessionEvents(this.deps.getSession(sessionId))
    const answer = finalAnswerOfTurn(events, turn)
    if (answer === null) return null
    const target = this.target()
    if (cfg.translateSkipSameModel && answer.sourceModel !== undefined && sameModel(answer.sourceModel, target.model)) return null
    const lastAt = this.lastAutoAt.get(sessionId)
    const now = this.now()
    if (lastAt !== undefined && cfg.translateMinIntervalMs > 0 && now - lastAt < cfg.translateMinIntervalMs) return null
    this.lastAutoAt.set(sessionId, now)
    this.pending.set(sessionId, { turn, startedAt: now })
    try {
      return await this.translateTurn(sessionId, turn, { persist: true })
    } catch (e) {
      this.deps.log?.('auto-translate failed: ' + (e instanceof Error ? e.message : String(e)))
      return null
    } finally {
      this.pending.delete(sessionId)
    }
  }

  private async appendRecord(sessionId: string, turn: number, answer: TurnAnswer, res: TranslateResult): Promise<number | null> {
    if (this.deps.appendRecord === undefined) return null
    const record = buildTranslationRecord({ turn, answer, res, now: this.now() })
    try {
      return await this.deps.appendRecord(sessionId, record)
    } catch (e) {
      this.deps.log?.('failed to persist translation record: ' + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }
}
