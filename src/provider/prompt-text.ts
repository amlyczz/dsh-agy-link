// Pure prompt-text helpers: message flattening, harness-message sniffing,
// image-ref collection, UTF-8 budget arithmetic and the ADR-7 history digest.
//
// These lived in src/host/adapter.ts next to the prompt-assembly block. They
// are moved here verbatim (no behaviour change) so the prompt planner in
// ./prompt.ts can use them without importing the adapter (which imports the
// planner — that would be a cycle). The adapter re-exports them unchanged so
// existing call sites and tests keep importing from the same module.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Message } from '@deepseek-ai/dsh-llm'
import { PROVIDER_ID } from '../common/types.ts'
import { stateDir } from '../common/config.ts'
import { stripNulBytes } from '../host/runner.ts'
import { sweepDir, type ImageRefLike } from '../host/media.ts'

export type ForeignSource = { source?: { kind?: string; provider?: string; callId?: string; replayState?: unknown } }

/** Loose content-block view spanning dsh-llm schema revisions. */
export type UnknownBlock = {
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
export function isToolResultMessage(m: Message): boolean {
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

/** Flatten visible text, including nested tool-result payloads. */
export function textOf(m: Message): string {
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

export function isForeignAssistant(m: Message, currentConvId?: string): boolean {
  if (m.role !== 'assistant') return false
  const src = (m as unknown as ForeignSource).source
  if (!src || src.provider !== PROVIDER_ID) return true
  if (currentConvId) {
    const replayConvId = src.replayState && typeof src.replayState === 'object'
      ? (src.replayState as { response?: { conversationId?: unknown } }).response?.conversationId
      : undefined
    if (typeof replayConvId === 'string' && replayConvId !== '' && replayConvId !== currentConvId) {
      return true
    }
  }
  return false
}

/**
 * Detect synthetic harness messages injected by DSH.
 *
 * DSH injects runtime telemetry and reminder blocks with `role: 'user'`, such as:
 * - time-context: "Time sampled while preparing turn X, step Y: ..."
 * - skill-catalog: "<system-reminder>\nA skill is a reusable set..."
 * - runtime-context: "Current runtime context. This snapshot supersedes..."
 * - model-selection: "[model changed: ...]"
 * - system-reminder: "<system-reminder>..."
 *
 * These are harness infrastructure, NEVER real human user tasks. If treated
 * as a user task, they overwrite the user's actual instruction with a timestamp
 * or reminder block, causing agy to completely ignore the user's latest input
 * (e.g. session-c65a826e where 42 time samples were appended).
 */
export function isSyntheticHarnessMessage(m: Message): boolean {
  if (isToolResultMessage(m)) return false
  const src = (m as unknown as ForeignSource).source
  const kind = src?.kind
  if (kind !== undefined && kind !== '' && kind !== 'user') {
    if (
      kind === 'time-context' ||
      kind === 'skill-catalog' ||
      kind === 'runtime-context' ||
      kind === 'model-selection' ||
      kind === 'system-reminder' ||
      kind === 'dsh-session-title-llm' ||
      kind === 'tool-goal' ||
      kind === 'synthetic'
    ) {
      return true
    }
    if (kind === 'plugin' && (src as { form?: string }).form === 'snapshot') {
      return true
    }
  }
  const text = textOf(m).trim()
  if (
    text.startsWith('Time sampled while preparing') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('Current runtime context') ||
    text.startsWith('[model changed:') ||
    text.startsWith('[conversation so far]') ||
    text.startsWith('<goal_complete>') ||
    text.startsWith('A skill is a reusable set of task-specific instructions')
  ) {
    return true
  }
  return false
}

/** True for a real human user turn (not a tool result, not a synthetic harness snapshot). */
export function isRealUserMessage(m: Message): boolean {
  const role = (m as { role?: string }).role
  if (role !== 'user') return false
  if (isToolResultMessage(m)) return false
  if (isSyntheticHarnessMessage(m)) return false
  return textOf(m).trim() !== ''
}

/**
 * Latest real human turn (not a tool result, not assistant, not harness metadata).
 * This is the live task; a digest or tool-result-only trailing span must never drop it
 * (issue #35: "续跑提示词里没有任务").
 */
export function latestUserTaskText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined) continue
    if (isSyntheticHarnessMessage(m)) continue
    if (isToolResultMessage(m) || m.role === 'assistant' || m.role === 'system') continue
    if (m.role === 'user') {
      return textOf(m).trim()
    }
  }
  return ''
}

/**
 * Last user message REGARDLESS of the synthetic-looking prefix heuristics,
 * searched only within the TRAILING span (after the last assistant message).
 *
 * The sniffing exists so harness telemetry (time samples, skill catalogs,
 * `<system-reminder>` snapshots) never overwrites a REAL task. But when the
 * synthetic-looking message is the ONLY user content of the turn — the user
 * pasted a reminder block to ask about it — filtering it left the turn with
 * no task at all ("request carries no user text"). Callers fall back to this.
 *
 * The span bound keeps the image-only regression fixed: a trailing
 * image-only turn must NOT rescue an older question from before the last
 * assistant reply, exactly as latestUserTaskText refuses to.
 */
export function latestUserMessageAny(messages: readonly Message[]): string {
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  for (let i = messages.length - 1; i > lastAssistantIdx; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'user' || isToolResultMessage(m)) continue
    const text = textOf(m).trim()
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
 * Images this hop should forward, minus what the current agy conversation
 * has already received. Trailing-span attachments come first (this hop's
 * screenshots), then any user-turn attachments since `fromIdx` that carry
 * unseen ids (tool-hop continuations and foreign-model turns used to fall
 * into a "re-send every historical screenshot" path).
 */
export function collectUnsentImageRefs(
  messages: readonly Message[],
  trailingUser: readonly Message[],
  fromIdx: number,
  sentIds: readonly string[],
): ImageRefLike[] {
  const sent = new Set(sentIds)
  const seen = new Set<string>()
  const out: ImageRefLike[] = []
  const push = (m: Message): void => {
    const refs: ImageRefLike[] = []
    collectImageRefs(m, refs)
    for (const r of refs) {
      const id = r.attachmentId
      if (typeof id !== 'string' || id === '' || sent.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push(r)
    }
  }
  for (const m of trailingUser) push(m)
  const start = Math.max(0, Math.min(fromIdx, messages.length))
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]
    if (m === undefined || m.role !== 'user' || isToolResultMessage(m)) continue
    push(m)
  }
  return out
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * Keep the longest prefix whose UTF-8 encoding fits `maxBytes`, never splitting
 * a multi-byte code point. Appends a short marker unless `note` is false.
 */
export function trimToUtf8Bytes(s: string, maxBytes: number, note = true): string {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(s) <= maxBytes) return s
  const marker = note ? '\n…[truncated]' : ''
  const budget = Math.max(0, maxBytes - utf8Bytes(marker))
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (utf8Bytes(s.slice(0, mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + marker
}

/**
 * Keep the head and the tail of a long payload, dropping the middle. Command
 * output and file dumps put the verdict at one end and the setup at the other,
 * so half the bytes buy nearly all of the signal — the 80/20 cut for tool
 * results inside a history digest.
 *
 * @param text - raw payload.
 * @param capBytes - UTF-8 byte ceiling for the returned text.
 * @returns the payload unchanged when it already fits, else head + marker + tail.
 */
export function elideMiddle(text: string, capBytes: number): string {
  if (capBytes <= 0) return ''
  if (utf8Bytes(text) <= capBytes) return text
  const headBytes = Math.max(1, Math.floor((capBytes - 24) / 2))
  const marker = '\n…[elided ' + (utf8Bytes(text) - capBytes) + 'B]…\n'
  const head = trimToUtf8Bytes(text, headBytes, false)
  // Walk back from the end until the tail fits its own half.
  const tailBytes = headBytes
  let tailStart = text.length
  for (let i = text.length; i >= 0; i--) {
    if (utf8Bytes(text.slice(i)) > tailBytes) break
    tailStart = i
  }
  return head + marker + text.slice(tailStart)
}

/**
 * Put the live request at the very head of the prompt so agy's tail-side
 * truncation can only ever discard background history, never the question.
 */
export function wrapLiveRequest(live: string): string {
  const body = live.trim()
  if (body === '') return ''
  return '[CURRENT REQUEST — answer this and only this; everything after it is background history]\n' +
    body + '\n[/CURRENT REQUEST]\n\n'
}

/** Write a large context digest to a temp .md so agy can read it in pages. */
export async function writeContextTransferFile(sessionKey: string, body: string): Promise<string | null> {
  try {
    const dir = join(stateDir(), 'context-transfer')
    await mkdir(dir, { recursive: true })
    await sweepDir(dir, 86_400_000)
    const key = (sessionKey === '' ? 'anon' : sessionKey).replace(/[^a-zA-Z0-9_-]+/g, '_')
    const file = join(dir, key + '-' + Date.now() + '.md')
    await writeFile(file, body, 'utf8')
    return file
  } catch {
    return null
  }
}

export interface DigestBudget {
  /** Hard UTF-8 byte ceiling for the returned digest. */
  maxBytes?: number
  /** Per-line byte ceiling so one huge tool result cannot eat the budget. */
  maxLineBytes?: number
  /**
   * Per-line byte ceiling for TOOL RESULT lines specifically. Tool results are
   * payloads (file dumps, log tails, search hits), not decisions, and they are
   * what normally eats a history budget: with one cap for everything a couple of
   * `cat`-style outputs crowd out the asks and answers that carry the thread.
   * Defaults to `min(800, maxLineBytes)` — the 80/20 rule: keep the head+tail
   * verdict of every tool call, spend the rest of the budget on prose.
   */
  toolLineBytes?: number
  /** Include the reserved "User: <latest task>" line (default true). */
  includeTaskLine?: boolean
}

/**
 * Rolling digest of turns this agy conversation has not seen (ADR-7).
 *
 * Budget policy (issue #35): the latest real user task is reserved first so
 * a wall of tool-result text can never truncate the question away. Remaining
 * budget is filled from the newest other turns.
 */
export function buildDigest(
  messages: readonly Message[],
  fromIdx: number,
  maxChars: number,
  budgetOpts: DigestBudget = {},
): string {
  const includeTaskLine = budgetOpts.includeTaskLine !== false
  const perLineCap = budgetOpts.maxLineBytes
  const toolLineCap = budgetOpts.toolLineBytes ?? (perLineCap === undefined ? 800 : Math.min(800, perLineCap))
  const capLine = (line: string): string =>
    perLineCap !== undefined && utf8Bytes(line) > perLineCap
      ? trimToUtf8Bytes(line, perLineCap)
      : line
  const taskText = stripNulBytes(latestUserTaskText(messages.slice(fromIdx)))
  const taskLine = includeTaskLine && taskText !== '' ? 'User: ' + taskText : ''
  const otherLines: string[] = []
  for (let i = fromIdx; i < messages.length; i++) {
    const m = messages[i]
    if (m === undefined || m.role === 'system') continue
    if (isSyntheticHarnessMessage(m)) continue
    // Binary tool output (e.g. a quoted .git blob) can carry NUL bytes; they
    // are illegal in argv and would kill the spawn before agy starts.
    const text = stripNulBytes(textOf(m))
    if (text === '') continue
    if (taskLine !== '' && !isToolResultMessage(m) && m.role === 'user' && text === taskText) continue
    otherLines.push(
      isToolResultMessage(m)
        ? capLine(digestLabel(m) + elideMiddle(text, toolLineCap))
        : capLine(digestLabel(m) + text),
    )
  }

  let budget = maxChars
  let taskPart = ''
  if (taskLine !== '') {
    if (taskLine.length > budget) {
      taskPart = taskLine.slice(0, Math.max(0, budget))
      budget = 0
    } else {
      taskPart = taskLine
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
  let kept: string[] = [...keptOther]
  if (taskPart !== '') {
    kept.push(taskPart)
  }
  if (kept.length === 0) return ''

  const header = '[conversation so far]\n'
  const footer = '\n[end of conversation so far]\n\n'
  if (budgetOpts.maxBytes !== undefined) {
    // Byte ceiling (agy owns a 192,000-byte single-message cap). Drop the
    // OLDEST turns first; the reserved task line stays.
    const ceiling = Math.max(0, budgetOpts.maxBytes)
    const overhead = utf8Bytes(header) + utf8Bytes(footer)
    const sizeOf = (lines: readonly string[]): number =>
      overhead + lines.reduce((n, l) => n + utf8Bytes(l), 0) + Math.max(0, lines.length - 1) * 2
    let total = sizeOf(kept)
    while (total > ceiling && kept.length > (taskPart !== '' ? 1 : 0)) {
      const removed = kept.shift()!
      total -= utf8Bytes(removed) + 2
    }
    if (total > ceiling && kept.length > 0) {
      const available = Math.max(0, ceiling - overhead)
      kept = [...kept.slice(0, -1), trimToUtf8Bytes(kept[kept.length - 1]!, available, false)]
    }
  }
  return header + kept.join('\n\n') + footer
}
