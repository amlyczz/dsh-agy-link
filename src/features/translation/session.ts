// Pure session-log reading for translations: turn discovery, answer extraction,
// durable-record lookup and the bounded setup digest. No I/O beyond the passed
// event list.
import {
  TRANSLATION_RECORD_TYPE,
  type SessionEventLike,
  type TranslationSessionLike,
  type TurnAnswer,
} from './types.ts'

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
