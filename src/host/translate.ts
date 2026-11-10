// Plain-language translation service (spec: .spec/translation.md).
//
// One unified entry for "turn the latest agent answer into 人话": the /tsl
// command, the automatic post-turn hook and the per-message button all call
// TranslationService. The model call rides this plugin's own adapter through
// the auxiliary `purpose:'translation'` route, so account selection, quota
// cooldowns, per-account proxy/HOME and failure classification are exactly the
// ones real turns use — a quota-exhausted account is cooled down by the
// adapter and the next attempt naturally lands on a different account.
//
// This module stays host-pure: it never spawns processes and never imports a
// DSH runtime package beyond the shared vocabulary. The actual model call and
// the durable record append are injected by `index.ts`, which keeps the
// rotation/account logic in the adapter and makes every branch unit-testable.
import { createHash } from 'node:crypto'
import { Err, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { defaultEffortFor, findEntry, resolveModelSlug, type Catalog } from './models.ts'

/** Durable record type written to the session log (grammar: `plugin:` + lowercase segments). */
export const TRANSLATION_RECORD_TYPE = 'plugin:agy-link/translation'

/** Bounded in-memory cache: one entry per (model, effort, language, source text). */
const MAX_CACHE_ENTRIES = 200

/** Reasonable lower bound for a translated answer; keeps a runaway model from filling the card. */
const MIN_TEXT_LIMIT = 200

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

/** Minimal session shape this service reads: the durable event log plus its id. */
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

/**
 * The block agy receives ONCE, when its translation conversation is created:
 * who it is, which DSH session it serves, where that session's history lives and
 * how to read it, plus a bounded digest so the first translation already has
 * context. Later translations send only the source text (see the adapter's
 * `agyTranslateSession` handling).
 */
export function buildTranslationSetup(input: TranslationSetupInput): string {
  const lang = input.targetLanguage.trim() === '' ? '中文（简体）' : input.targetLanguage.trim()
  const lines = [
    '你是「人话翻译器」，长期服务于 DSH 的一个会话。以后我只把需要翻译的原文发给你，你直接把它讲成人话。',
    '',
    '- DSH 会话 id：' + (input.sessionId === '' ? '(未知)' : input.sessionId),
  ]
  if (input.cwd !== undefined && input.cwd !== '') lines.push('- 该会话的工作目录：' + input.cwd)
  if (input.digest !== undefined && input.digest.trim() !== '') {
    lines.push('', '该会话到目前为止的摘要（供你理解上下文，不必翻译它）：', '', '<digest>', input.digest.trim(), '</digest>')
  }
  if (input.logPath !== undefined && input.logPath !== '') {
    lines.push(
      '',
      '需要完整历史时可以自己读：原始日志在 ' + input.logPath + '（zstd 压缩的 JSONL，每行一个事件）。读取示例：',
      "  zstd -dc '" + input.logPath + "' | jq -c 'select(.type==\"assistant/message\") | {turn:.data.turn, text:([.data.message.content[]?.text] | join(\"\"))}' | tail -40",
      '没有 jq 就用 python3 逐行 json.loads 过滤；不要修改这些文件。',
    )
  }
  lines.push(
    '',
    '规则：',
    '1. 每次我只发来「当前这一条」AI 回复的原文：只讲这一条，别去翻历史里的其它回答来顶替它。',
    '2. 说' + lang + '的大白话，像当面给同事解释：口语、短句、怎么顺口怎么来；不要标题，不要分点罗列，不要写成报告。',
    '3. 别用行话、缩写和「首先 / 其次 / 综上 / 因此 / 旨在 / 该方案」这类书面词；遇到术语先用日常说法讲清它大概是干什么的。',
    '4. 原文说了多少就讲多少：结论、条件、谁做了什么都要留着，别为了短把细节吞掉，也别替它下结论。',
    '5. 只输出讲解本身，不要前言、不要复述我发的内容、不要反问我。',
  )
  return lines.join('\n')
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

interface TurnAnswer {
  text: string
  anchorSeq: number
  messageId?: string
  sourceModel?: string
}

/** Read the event log whichever shape the host exposes. */
export function sessionEvents(session: TranslationSessionLike | undefined): readonly SessionEventLike[] {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const list = session.snapshotEvents()
      if (Array.isArray(list) && list.length > 0) return list
    } catch {
      // degraded
    }
  }
  if (typeof session.ownEvents === 'function') {
    try {
      const list = session.ownEvents()
      if (Array.isArray(list) && list.length > 0) return list
    } catch {
      // degraded
    }
  }
  if (Array.isArray(session.log) && session.log.length > 0) return session.log
  if (Array.isArray(session.events) && session.events.length > 0) return session.events
  if (Array.isArray(session.log)) return session.log
  if (Array.isArray(session.events)) return session.events
  return []
}

function dataOf(ev: SessionEventLike): Record<string, unknown> {
  const data = ev.data
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Turns that finished with a normal `completed` reason, ascending. */
export function completedTurns(events: readonly SessionEventLike[]): number[] {
  const turns: number[] = []
  for (const ev of events) {
    if (ev.type !== 'turn/end') continue
    const d = dataOf(ev)
    const reason = d.reason !== null && typeof d.reason === 'object' ? (d.reason as Record<string, unknown>) : {}
    if (reason.kind !== 'completed') continue
    const turn = num(d.turn)
    if (turn !== undefined) turns.push(turn)
  }
  return turns
}

export function lastCompletedTurn(events: readonly SessionEventLike[]): number | null {
  const turns = completedTurns(events)
  return turns.length === 0 ? null : turns[turns.length - 1]!
}

/** True when `turn` has no `turn/end` yet (its agent loop is still running). */
export function isTurnRunning(events: readonly SessionEventLike[], turn: number): boolean {
  let started = false
  for (const ev of events) {
    const d = dataOf(ev)
    if (ev.type === 'turn/start' && num(d.turn) === turn) started = true
    if (ev.type === 'turn/end' && num(d.turn) === turn) return false
  }
  return started
}

function textOfAssistant(ev: SessionEventLike): string {
  const d = dataOf(ev)
  const message = d.message !== null && typeof d.message === 'object' ? (d.message as Record<string, unknown>) : {}
  const content = Array.isArray(message.content) ? message.content : []
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

function sourceModelOf(ev: SessionEventLike): string | undefined {
  const d = dataOf(ev)
  const message = d.message !== null && typeof d.message === 'object' ? (d.message as Record<string, unknown>) : {}
  const source = message.source !== null && typeof message.source === 'object' ? (message.source as Record<string, unknown>) : {}
  return typeof source.model === 'string' && source.model !== '' ? source.model : undefined
}

function messageIdOf(ev: SessionEventLike): string | undefined {
  const d = dataOf(ev)
  const message = d.message !== null && typeof d.message === 'object' ? (d.message as Record<string, unknown>) : {}
  if (typeof message.id === 'string' && message.id !== '') return message.id
  if (typeof d.id === 'string' && d.id !== '') return d.id
  if (typeof d.messageId === 'string' && d.messageId !== '') return d.messageId
  const raw = ev as unknown as Record<string, unknown>
  return typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined
}

/**
 * The turn's final answer: the last assistant message with non-empty text.
 * Intermediate steps that only emit tool calls carry no text, so they are
 * skipped — translating them would bury the real answer in noise.
 */
export function finalAnswerOfTurn(events: readonly SessionEventLike[], turn: number): TurnAnswer | null {
  let found: TurnAnswer | null = null
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const d = dataOf(ev)
    if (num(d.turn) !== turn) continue
    const text = textOfAssistant(ev)
    if (text === '') continue
    found = {
      text,
      anchorSeq: num(ev.seq) ?? 0,
      ...(messageIdOf(ev) === undefined ? {} : { messageId: messageIdOf(ev) }),
      ...(sourceModelOf(ev) === undefined ? {} : { sourceModel: sourceModelOf(ev) }),
    }
  }
  return found
}

/** Every assistant text block of a turn, in order (for `/tsl --full`). */
export function allTextOfTurn(events: readonly SessionEventLike[], turn: number): TurnAnswer | null {
  const parts: string[] = []
  let anchorSeq = 0
  let messageId: string | undefined
  let sourceModel: string | undefined
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const d = dataOf(ev)
    if (num(d.turn) !== turn) continue
    const text = textOfAssistant(ev)
    if (text === '') continue
    parts.push(text)
    anchorSeq = num(ev.seq) ?? anchorSeq
    messageId = messageIdOf(ev) ?? messageId
    sourceModel = sourceModelOf(ev) ?? sourceModel
  }
  if (parts.length === 0) return null
  return {
    text: parts.join('\n\n'),
    anchorSeq,
    ...(messageId === undefined ? {} : { messageId }),
    ...(sourceModel === undefined ? {} : { sourceModel }),
  }
}

/** Locate the turn that owns one assistant message id. */
export function turnOfMessage(
  events: readonly SessionEventLike[],
  messageId: string,
): (TurnAnswer & { turn: number }) | null {
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    if (messageIdOf(ev) !== messageId) continue
    const d = dataOf(ev)
    const turn = num(d.turn)
    if (turn === undefined) return null
    return {
      text: textOfAssistant(ev),
      anchorSeq: num(ev.seq) ?? 0,
      turn,
      ...(messageIdOf(ev) === undefined ? {} : { messageId: messageIdOf(ev) }),
      ...(sourceModelOf(ev) === undefined ? {} : { sourceModel: sourceModelOf(ev) }),
    }
  }
  return null
}

/**
 * The newest durable translation record for one turn (optionally narrowed to an
 * exact model/effort recipe and to ONE assistant message). Used to dedupe
 * repeated requests so clicking the per-turn affordance twice can never stack
 * two identical cards.
 *
 * `messageId` is what makes the per-reply button correct: a turn can contain
 * several text messages (a preamble, then the real answer), and a turn-level
 * record must never be handed back for a sibling message — that is exactly the
 * "I clicked message A but got the translation of message B" bug. Records
 * written by older builds carry no `messageId`; they are honoured as a legacy
 * turn-level fallback only while the turn has no message-scoped record at all.
 */
export function findTranslationRecord(
  events: readonly SessionEventLike[],
  turn: number,
  model?: string,
  effort?: string,
  messageId?: string,
): { seq: number; text: string; model: string; effort: string } | null {
  const scoped = messageId !== undefined && messageId !== ''
  let exact: { seq: number; text: string; model: string; effort: string } | null = null
  let legacy: { seq: number; text: string; model: string; effort: string } | null = null
  let sawScoped = false
  for (const ev of events) {
    if (ev.type !== TRANSLATION_RECORD_TYPE) continue
    const d = dataOf(ev)
    const recordTurn = num(d.turn)
    if (recordTurn !== turn) continue
    const recordModel = typeof d.model === 'string' ? d.model : ''
    const recordEffort = typeof d.effort === 'string' ? d.effort : ''
    if (model !== undefined && model !== '' && recordModel !== model) continue
    if (effort !== undefined && recordEffort !== effort) continue
    const text = typeof d.text === 'string' ? d.text : ''
    if (text.trim() === '') continue
    const hit = { seq: num(ev.seq) ?? 0, text, model: recordModel, effort: recordEffort }
    const recordMessage = typeof d.messageId === 'string' && d.messageId !== '' ? d.messageId : null
    if (recordMessage !== null) sawScoped = true
    if (!scoped) {
      exact = hit
      continue
    }
    if (recordMessage === messageId) exact = hit
    else if (recordMessage === null) legacy = hit
  }
  if (exact !== null) return exact
  return scoped && !sawScoped ? legacy : null
}

/** Text of one `user/message` event (the asks that carry the thread). */
function userTextOf(ev: SessionEventLike): string {
  const d = dataOf(ev)
  const message = d.message !== null && typeof d.message === 'object' ? (d.message as Record<string, unknown>) : {}
  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('\n')
}

/**
 * A bounded "what happened so far" digest for the setup block: the session's asks
 * and final answers, newest kept, each clipped. The full log stays on disk for
 * agy to read itself when it wants more.
 */
export function sessionDigest(events: readonly SessionEventLike[], maxChars: number): string {
  const cap = Math.max(200, Math.round(maxChars / 4))
  // One pass collects each turn's LAST text answer. The old version called
  // `finalAnswerOfTurn` once per assistant message, i.e. rescanned the whole
  // event log for every turn (O(n²)) — harmless in tests, a real cost in a
  // 5000-event session, and the digest is rebuilt on every translation call.
  const answers = new Map<number, string>()
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const turn = num(dataOf(ev).turn)
    if (turn === undefined) continue
    const text = textOfAssistant(ev)
    if (text !== '') answers.set(turn, text)
  }
  const parts: string[] = []
  const done = new Set<number>()
  for (const ev of events) {
    if (ev.type === 'user/message') {
      const text = userTextOf(ev).trim()
      if (text !== '') parts.push('用户：' + clip(text, 400))
      continue
    }
    if (ev.type !== 'assistant/message') continue
    const turn = num(dataOf(ev).turn)
    if (turn === undefined || done.has(turn)) continue
    const answer = answers.get(turn)
    if (answer === undefined || answer.trim() === '') continue
    done.add(turn)
    parts.push('回复：' + clip(answer, 900))
  }
  let kept = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = parts[i]! + '\n' + kept
    if (next.length > cap) break
    kept = next
  }
  return kept.trim()
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max) + '…'
}

/** The translator instruction. Kept in the user message (aux calls drop
 * `options.system` unless `forwardSystemPrompt` is on), and deliberately
 * explicit about "never invent facts": a cheerful paraphrase that adds a
 * promise the agent never made is worse than no translation at all.
 */
export function buildTranslationPrompt(text: string, targetLanguage: string, maxChars: number, sessionId?: string): string {
  const lang = targetLanguage.trim() === '' ? '中文（简体）' : targetLanguage.trim()
  const limit = Math.max(MIN_TEXT_LIMIT, Math.round(maxChars))
  // Deliberately a short instruction with NO format mandate. The earlier rule
  // list ("结论先行 / 去黑话 / 输出 Markdown …") made the model write a book
  // report: headings, bullet lists, formal register. What the reader wants is
  // the same thing said out loud, so the constraints only stop it drifting:
  // spoken register, keep the meaning, invent nothing, and answer with the
  // explanation alone. "该长就长" is explicit because the reader asked for the
  // real content volume — a long answer must not be compressed into three
  // bullet conclusions.
  const long = text.length > Math.min(2_000, Math.floor(limit / 4))
  const where = sessionId === undefined || sessionId.trim() === '' ? '' : '（DSH 会话 ' + sessionId.trim() + '）'
  const lines = [
    '把下面这段「当前这一条 AI 回复」的原文，用' + lang + '讲成大白话，就像当面跟同事解释：',
    '说人话、用短句，怎么顺口怎么来；别用行话、缩写和「首先 / 其次 / 综上 / 因此」这类书面词，遇到术语先用日常说法讲清它大概是干什么的。',
    '原文说了多少就讲多少，该长就长、该短就短，别压成几句结论，也别写成标题或分点报告。',
    '只讲这一条回复' + where + '本身，别把历史里别的回复混进来；别改原意，别加原文没有的内容，别替它下结论。',
    ...(long ? ['原文比较长，按它自己的顺序一步步讲完，别漏掉关键条件。'] : []),
    '只输出讲解本身，不要复述我发的内容，不要提问。',
    '',
    '<content>',
    text,
    '</content>',
  ]
  return lines.join('\n')
}

/**
 * Per-turn request for a BOUND translation conversation.
 *
 * The persona (`buildTranslationSetup`) goes out once, when that conversation is
 * created; every later turn receives only this line plus the source. Keeping the
 * request on every turn is what pins the model to the reply it is looking at now
 * instead of translating something it remembers from an earlier turn.
 */
export function buildTranslationRequest(text: string, targetLanguage: string, maxChars: number): string {
  const lang = targetLanguage.trim() === '' ? '中文（简体）' : targetLanguage.trim()
  const long = text.length > Math.min(2_000, Math.floor(Math.max(MIN_TEXT_LIMIT, Math.round(maxChars)) / 4))
  return [
    '把「当前这一条 AI 回复」的下面这段原文，用' + lang + '讲成大白话：说人话、短句，别用行话和书面腔（不要「首先 / 其次 / 综上 / 因此」），术语先用日常说法解释。',
    '原文说了多少就讲多少，按它自己的顺序讲，该长就长，别压成几句结论，也别写成标题或分点报告；别改原意，别加原文没有的内容。',
    ...(long ? ['原文比较长，一步步讲完，别漏掉关键条件。'] : []),
    '只讲这一条，别把前面几轮的内容混进来；只输出讲解本身。',
    '',
    '<content>',
    text,
    '</content>',
  ].join('\n')
}

/**
 * Split long answers on paragraph boundaries. A single paragraph longer than
 * the cap is hard-split so one giant code block cannot blow the request limit.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const cap = Math.max(MIN_TEXT_LIMIT, Math.round(maxChars))
  if (text.length <= cap) return [text]
  const chunks: string[] = []
  let current = ''
  for (const para of text.split(/\n{2,}/)) {
    const piece = para.trim()
    if (piece === '') continue
    if (piece.length > cap) {
      if (current !== '') {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < piece.length; i += cap) chunks.push(piece.slice(i, i + cap))
      continue
    }
    const next = current === '' ? piece : current + '\n\n' + piece
    if (next.length > cap) {
      chunks.push(current)
      current = piece
    } else {
      current = next
    }
  }
  if (current !== '') chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}

/**
 * Pick the model/effort for a translation.
 *
 * An explicit request (command flag) is honoured even when the advisory catalog
 * has never listed it — the adapter accepts unknown ids. The DEFAULT goes
 * through a fallback chain so a plan without Gemini 3.8 still translates:
 * `gemini-3.8-flash` → newest `gemini-*-flash` → `defaultModel` → first model.
 */
export function resolveTranslateTarget(
  cfg: PluginConfig,
  catalog: Catalog,
  override?: { model?: string; effort?: string },
): TranslateTarget {
  const requested = (override?.model ?? cfg.translateModel ?? '').trim()
  const models = catalog.models
  let model = ''
  let entry = requested === '' ? undefined : findEntry(catalog, requested)

  if (requested !== '' && entry !== undefined) {
    model = entry.id
  } else if (requested !== '' && override?.model !== undefined) {
    // Explicit per-call override wins even when unlisted (advisory catalog).
    model = resolveModelSlug(requested)
    entry = findEntry(catalog, model)
  } else {
    const candidates: string[] = ['gemini-3.8-flash']
    if (cfg.defaultModel !== '') candidates.push(cfg.defaultModel)
    for (const cand of candidates) {
      const found = findEntry(catalog, cand)
      if (found !== undefined) {
        model = found.id
        entry = found
        break
      }
    }
    if (model === '') {
      const flashes = models
        .filter((m) => /gemini/i.test(m.id) && /flash/i.test(m.id))
        .sort((a, b) => compareNatural(b.id, a.id))
      const newest = flashes[0] ?? models[0]
      if (newest !== undefined) {
        model = newest.id
        entry = newest
      }
    }
  }

  const wanted = (override?.effort ?? cfg.translateEffort ?? '').trim()
  let effort = ''
  if (entry !== undefined && Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    effort =
      wanted !== '' && entry.efforts.includes(wanted)
        ? wanted
        : defaultEffortFor({ ...entry, efforts: entry.efforts }, cfg) ?? ''
  }
  return { model, effort }
}

function compareNatural(a: string, b: string): number {
  const na = a.split(/(\d+)/)
  const nb = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] ?? ''
    const y = nb[i] ?? ''
    const xn = Number(x)
    const yn = Number(y)
    if (Number.isFinite(xn) && Number.isFinite(yn) && x !== '' && y !== '') {
      if (xn !== yn) return xn - yn
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

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

/**
 * Orchestrates translation: target resolution, chunking, caching, bounded
 * retry, optional durable record. Session text extraction lives above as pure
 * functions so the command, the auto hook and the button share one logic.
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
      const d = dataOf(ev)
      if (d.messageId !== messageId) continue
      const text = typeof d.text === 'string' ? d.text : ''
      if (text.trim() === '') continue
      return {
        seq: num(ev.seq) ?? 0,
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
    const record: TranslationRecord = {
      version: 1,
      turn,
      anchorSeq: answer.anchorSeq,
      text: res.text,
      ...(answer.text.trim() === '' ? {} : { original: capOriginal(answer.text) }),
      model: res.model,
      effort: res.effort,
      provider: PROVIDER_ID,
      durationMs: res.durationMs,
      createdAt: this.now(),
    }
    if (answer.messageId !== undefined) record.messageId = answer.messageId
    if (res.accountId !== undefined) record.accountId = res.accountId
    if (answer.sourceModel !== undefined) record.sourceModel = answer.sourceModel
    try {
      return await this.deps.appendRecord(sessionId, record)
    } catch (e) {
      this.deps.log?.('failed to persist translation record: ' + (e instanceof Error ? e.message : String(e)))
      return null
    }
  }
}

/** Keep the durable record bounded: the card only needs the source for a diff-style read. */
function capOriginal(text: string): string {
  return text.length <= 8_000 ? text : text.slice(0, 8_000) + '…'
}

function cacheKey(model: string, effort: string, language: string, text: string): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 32)
  return model + '|' + effort + '|' + language + '|' + hash
}

/** `gemini-3.8-flash` vs a provider-qualified id such as `auto/gemini-3.8-flash`. */
function sameModel(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/^.*\//, '')
  return norm(a) === norm(b)
}
