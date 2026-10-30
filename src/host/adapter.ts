// AgyAdapter — the LlmAdapter implementation at the heart of the plugin
// (spec section 3). Translates one DSH model call into a short-lived
// `agy -p --output-format stream-json` child process, maps the NDJSON event
// stream onto StreamChunks, and binds DSH sessions to agy conversations for
// multi-turn continuity (ADR-4). Only the trailing user messages become the
// prompt; earlier context rides agy-native history plus a digest prefix on
// first bind (ADR-7).
import { dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Err, NETWORK_RETRY_DELAYS_MS, accountsShareSingleEgress, isAccountScopedFailure, isAuthoritativeAuthError, looksLikeAuthFailure, looksLikeAuthVerificationJitter, looksLikeContextWindowExceeded, looksLikeEligibilityFailure, looksLikeHardRateLimit, looksLikeNetworkError, looksLikeRateLimit, networkRetryDelayMs, shouldMarkAuthRequired, ELIGIBILITY_ERROR_HINT, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { modelFamilyOf, type ManagedAccount, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { conversationsDirFor, diffConversations, snapshotConversations } from './discovery.ts'
import { EventMapper, toToolCallId } from './mapper.ts'
import { parseMirrorCallId, type RunRecording, type RunRegistry } from './recording.ts'
import { accountHasArgon, defaultEffortFor, findEntry, isArgonModel, ModelCatalog, resolveModelSlug, sanitizeCatalogEntries } from './models.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, stageImages, sweepDir, type ImageRefLike } from './media.ts'
import { ensureIsolatedKeychain, isolatedHomeEnv, proxyEnvFor, startAgyProcess, buildStreamInputLine, shouldUsePromptStdin, stripNulBytes } from './runner.ts'
import { detectSystemProxy } from './wincred.ts'
import { AbortedWaitError, WaitTimeoutError, acquireCredentialSlot, credentialSlotMutex, SlotUnavailableError, armSlotHandoff, type SlotHandoff } from './credential-slot.ts'
import { agyHomeDirFor, readAgyRunLogText, snapshotAgyLogs } from './agy-log.ts'
import { stateDir } from '../common/config.ts'
import { SENT_IMAGE_IDS_MAX, type SessionStore } from './sessions.ts'
import { readFullToolArgs, readStepThoughts, clearAgyDbCache } from './agy-db.ts'
import { getGitHeadContent } from './mirror-tool.ts'
import { detectGoalContext, isGoalToolContinuation, isPlanToolContinuation, isPlanMode, type GoalContext } from './dsh-goal.ts'

type ForeignSource = { source?: { kind?: string; provider?: string; callId?: string; replayState?: unknown } }

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

function isForeignAssistant(m: Message, currentConvId?: string): boolean {
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

/** Merge newly forwarded attachment ids into a bounded, oldest-first list. */
export function mergeSentImageIds(
  existing: readonly string[] | undefined,
  added: readonly string[],
  max = SENT_IMAGE_IDS_MAX,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...(existing ?? []), ...added]) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > max ? out.slice(out.length - max) : out
}

/**
 * Rolling digest of turns this agy conversation has not seen (ADR-7).
 *
 * Budget policy (issue #35): the latest real user task is reserved first so
 * a wall of tool-result text can never truncate the question away. Remaining
 * budget is filled from the newest other turns.
 */
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

/** agy 1.4.x silently truncates a single user message at 192,000 UTF-8 bytes
 * (measured: a 300 KB ASCII prompt kept exactly 192,000 B; a 490 KB CJK prompt
 * kept 191,998 B) and the cut lands on the TAIL. Every prompt we build must
 * stay under that with margin, and the live request must sit at the HEAD. */
export const AGY_SINGLE_MESSAGE_MAX_BYTES = 192_000
export const AGY_PROMPT_SAFE_BYTES = 180_000

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
  /** Include the reserved "User: <latest task>" line (default true). */
  includeTaskLine?: boolean
}

export function buildDigest(
  messages: readonly Message[],
  fromIdx: number,
  maxChars: number,
  budgetOpts: DigestBudget = {},
): string {
  const includeTaskLine = budgetOpts.includeTaskLine !== false
  const perLineCap = budgetOpts.maxLineBytes
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
    otherLines.push(capLine(digestLabel(m) + text))
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

export interface AgyAdapterDeps {
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: (signal?: AbortSignal) => Promise<() => void>
  log?: (msg: string) => void
  /** Recordings shared with the agy_tool mirror (native tool-card mirroring). */
  runs: RunRegistry
  /**
   * Resolve the DSH session's working directory. Called with the raw
   * session id; return an absolute path to run agy inside that workspace.
   * Explicit config `workspaceRoot` still wins over this value.
   */
  sessionCwd?: (sessionId: string) => string | undefined
  /**
   * Resolve active goal info (goalId, revision) from session history if not present on messages.
   */
  sessionGoal?: (sessionId: string) => { goalId: string; revision: number } | null
  /** Last-run telemetry surfaced by /agy status. Process completion and tool failures are distinct. */
  onRun?: (info: {
    processOk: boolean
    processCode: string
    toolErrors: readonly string[]
    durationMs: number
    model: string
    /** Output-token speed over this run's generation steps (see RunRecording.speedStats). */
    tokenSpeed: ReturnType<RunRecording['speedStats']>
  }) => void
  /** Reads image bytes from DSH attachment storage (multimodal staging). */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /** Called with each run's parser so the host can keep the last stdout ring for /agy doctor. */
  onParser?: (parser: StreamJsonParser) => void
  /** Base URL of the media route, e.g. http://127.0.0.1:PORT/plugins/agy-link/media */
  getMediaBaseUrl?: () => string | null
  /** Synchronizes active model selection back to DSH input box / session */
  syncSessionModel?: (sessionId: string, model: string, effort?: string) => void
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

/**
 * Reserved block index for pre-spawn status notices.
 *
 * Negative on purpose: the mapper's own blocks count up from 0, so a negative
 * index can never be closed by a mapper `block-end` later in the run (the
 * assembler ignores deltas for a closed index). Deltas alone are enough — the
 * assembler explicitly tolerates delta-only protocols — so the notices land as
 * one growing reasoning block at the top of the turn.
 */
export const STATUS_NOTICE_BLOCK_INDEX = -1

/**
 * Await `work` while periodically yielding a SESSION-VISIBLE notice.
 *
 * Why this exists: Windows has ONE machine-global credential slot, so every
 * session's agy run is serialized behind whichever session got there first.
 * A healthy long run (a 15-minute build, a 240-minute long tool) made the
 * OTHER sessions sit with a completely empty transcript for up to
 * `dispatchTimeoutMinutes` — indistinguishable from a freeze. The console
 * heartbeat was invisible to the user, so the only honest signal was "nothing
 * is happening" (2026-10-22: two sessions looked hung for 15 minutes while
 * another project's agy run held the slot).
 *
 * Resolves with `work`'s value; rejects with `work`'s rejection untouched, so
 * the caller's existing error classification is unchanged.
 */
export async function* awaitWithNotices<T>(
  work: Promise<T>,
  opts: {
    /** Delay before the FIRST notice (and the base for later ones). */
    intervalMs: number
    /** Growth factor between notices (default 1 = constant cadence). */
    escalate?: number
    /** Upper bound for the cadence after escalation. */
    maxIntervalMs?: number
    /** Text for the current wait duration in milliseconds. */
    notice: (elapsedMs: number) => string
  },
): AsyncGenerator<StreamChunk, T, void> {
  const baseInterval = opts.intervalMs > 0 ? opts.intervalMs : 30_000
  const escalate = opts.escalate !== undefined && opts.escalate > 1 ? opts.escalate : 1
  const maxInterval = opts.maxIntervalMs !== undefined && opts.maxIntervalMs > baseInterval ? opts.maxIntervalMs : baseInterval * 100
  let intervalMs = baseInterval
  const startedAt = Date.now()
  type Settled = { ok: true; value: T } | { ok: false; error: unknown }
  let settled: Settled | null = null
  let wake: (() => void) | null = null
  const ping = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }
  void work.then(
    (value) => {
      if (settled === null) {
        settled = { ok: true, value }
        ping()
      }
    },
    (error) => {
      if (settled === null) {
        settled = { ok: false, error }
        ping()
      }
    },
  )
  let pendingNotices = 0
  let timer: NodeJS.Timeout | null = null
  const arm = (): void => {
    if (timer !== null || settled !== null) return
    timer = setTimeout(() => {
      timer = null
      pendingNotices++
      intervalMs = Math.min(Math.round(intervalMs * escalate), maxInterval)
      ping()
    }, intervalMs)
    timer.unref?.()
  }
  try {
    arm()
    for (;;) {
      if (settled !== null) break
      if (pendingNotices > 0) {
        pendingNotices--
        yield {
          type: 'reasoning-delta',
          index: STATUS_NOTICE_BLOCK_INDEX,
          text: opts.notice(Date.now() - startedAt) + '\n',
        }
        // Re-arm AFTER resuming: a generator suspended at the yield must not
        // swallow the next tick (that bug produced exactly one notice and then
        // silence for the rest of the wait).
        arm()
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const done = settled as Settled | null
  if (done === null) throw new Error('awaitWithNotices lost its completion signal')
  if (done.ok) return done.value
  throw done.error
}

function sawAuthFailure(parser: StreamJsonParser, outcome: { stderrTail: string }): boolean {
  if (parser.stats.sawAuthFailure) return true
  if (looksLikeAuthFailure(outcome.stderrTail)) return true
  if (parser.stats.lastResultError && looksLikeAuthFailure(parser.stats.lastResultError)) return true
  return false
}

/**
 * Bounded wait for an aborted run to settle, so a steer replacement never
 * overlaps the process it just killed on the same agy conversation.
 * Returns whether the run actually settled before the deadline.
 */
async function waitForRunSettle(run: { isSettled: boolean }, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (run.isSettled) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return run.isSettled
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
  /**
   * sessionKey -> account failovers claimed inside the current window.
   *
   * A settled recording that died of an ACCOUNT-scoped failure is retried on
   * another account instead of being replayed (post-tool quota exhaustion used
   * to dead-end the turn). That retry happens inside one DSH step, so DSH's own
   * retry budget cannot bound it: without this counter a soft capacity refusal
   * (which cools nothing) would rotate A→B→C→A…, re-running the user's tools on
   * every cycle.
   */
  private readonly failoverBudget = new Map<string, { count: number; firstAt: number }>()
  private static readonly FAILOVER_WINDOW_MS = 120_000
  /**
   * Same shape, but for HARD rate-limit hops only. A hard 429 gives the failed
   * account a cooldown of at least the server-quoted reset (default 10m), so
   * each claim provably makes progress and cannot loop. The generic 120s/2-hop
   * budget above exists to stop SOFT failures (which cool nothing) from
   * rotating forever — but a long-running turn's quota failures arrive spread
   * over minutes (observed live: 429 at 20:28 with "Resets in 11m", further
   * hops at 20:28:43 and 20:29:17), so the tight window spent itself while a
   * full-quota account sat idle and the turn dead-ended (2026-10-10 20:29).
   * Rate-limit hops get their own pool-depth budget over a window as long as
   * the default cooldown, refreshed on every fresh failure.
   */
  private readonly rateLimitFailover = new Map<string, { count: number; firstAt: number }>()
  private static readonly RATE_LIMIT_FAILOVER_WINDOW_MS = 600_000
  /**
   * sessionKey -> consecutive transport failures and when the streak started.
   *
   * The streak drives the 5s/15s/30s retry delay handed to DSH. A success (or
   * any non-transport failure) clears it, and a gap longer than the window
   * treats the next failure as a fresh streak: a user who retries a turn ten
   * minutes after an outage must not start by waiting 30 seconds.
   */
  private readonly networkStreak = new Map<string, { count: number; at: number }>()
  private static readonly NETWORK_STREAK_WINDOW_MS = 600_000

  constructor(private readonly deps: AgyAdapterDeps) {
    super()
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return
    this.warnedKeys.add(key)
    this.deps.log?.('WARNING: ' + msg)
  }

  /**
   * Record one transport failure and return the streak position (1-based).
   * Position drives the delay requested from DSH.
   */
  private noteNetworkFailure(sessionKey: string): number {
    if (sessionKey === '') return 1
    const now = Date.now()
    const prev = this.networkStreak.get(sessionKey)
    const fresh = prev === undefined || now - prev.at > AgyAdapter.NETWORK_STREAK_WINDOW_MS
    const count = (fresh ? 0 : prev.count) + 1
    this.networkStreak.set(sessionKey, { count, at: now })
    return count
  }

  /** Drop the transport streak: the session reached Google (or failed another way). */
  private clearNetworkStreak(sessionKey: string): void {
    if (sessionKey === '') return
    this.networkStreak.delete(sessionKey)
  }

  /**
   * Whether every enabled account leaves through the same proxy.
   *
   * A shared egress makes a transport failure a property of the machine's
   * network, not of the account: rotating the sticky pointer repoints the
   * session for nothing and spends the rotation budget a real quota or
   * eligibility hop needs (live 2026-10-21: one flapping proxy produced EOFs
   * on every account and the turn still rotated the pool).
   */
  private sharesSingleEgress(): boolean {
    // A pool account is seeded with a COPY of the system proxy while the
    // primary account keeps an empty override, so the account comparison needs
    // the same fallback the spawn path uses: config proxy, else detected system.
    const cfg = this.deps.getConfig()
    const fallback = (cfg.proxyUrl ?? '').trim() || (detectSystemProxy() ?? '')
    return accountsShareSingleEgress(this.deps.pool?.getAccounts() ?? [], fallback)
  }

  /** Mark a session prompt as no longer in flight so retries are not debounced. */
  private clearInFlightPrompt(sessionKey: string, prompt: string): void {
    if (sessionKey === '') return
    const ap = this.activeSessionPrompts.get(sessionKey)
    if (ap === undefined || ap.prompt !== prompt) return
    this.activeSessionPrompts.set(sessionKey, { ...ap, inFlight: false })
  }

  /**
   * Claim one account failover for a session, bounded by the pool's spare
   * depth ((enabled accounts - 1) inside a short window). Returns false when
   * the failure is not account-scoped or the budget is spent — the caller then
   * replays the recorded failure so the turn ends with the real error.
   */
  private claimFailover(sessionKey: string, code: string | undefined): boolean {
    if (!isAccountScopedFailure(code)) return false
    // A transport failure on a SHARED egress is account-scoped in name only:
    // the step must still be re-run (the settled recording would otherwise be
    // replayed verbatim), but nothing is wrong with the account, so no rotation
    // budget is spent and the sticky pointer stays put. DSH's own retry budget
    // (three hops for NETWORK) still bounds the re-runs.
    if (code === Err.NETWORK && this.sharesSingleEgress()) return true
    const enabled = (this.deps.pool?.getAccounts() ?? []).filter((a) => a.enabled).length
    const max = Math.max(1, enabled - 1)
    const now = Date.now()
    // HARD rate limits are tracked separately: every claim cools the failed
    // account for the server-quoted reset, so hops are self-bounding by pool
    // depth — they must not starve the tiny soft-failure budget (see the
    // rateLimitFailover field comment for the live incident).
    if (code === Err.RATE_LIMIT) {
      const prevRl = this.rateLimitFailover.get(sessionKey)
      const freshRl = prevRl === undefined || now - prevRl.firstAt > AgyAdapter.RATE_LIMIT_FAILOVER_WINDOW_MS
      const countRl = freshRl ? 0 : prevRl.count
      if (countRl >= max) return false
      this.rateLimitFailover.set(sessionKey, { count: countRl + 1, firstAt: freshRl ? now : prevRl.firstAt })
      return true
    }
    const prev = this.failoverBudget.get(sessionKey)
    const fresh = prev === undefined || now - prev.firstAt > AgyAdapter.FAILOVER_WINDOW_MS
    const count = fresh ? 0 : prev.count
    if (count >= max) return false
    this.failoverBudget.set(sessionKey, { count: count + 1, firstAt: fresh ? now : prev.firstAt })
    return true
  }

  /**
   * Fail fast on auth and abort; allow retries for transient process failures
   * (timeout, crash, malformed stream) per ADR-11.
   *
   * Account-scoped failures (RATE_LIMIT / ELIGIBILITY / NETWORK / OVERLOADED)
   * are retryable on purpose: the failed account was cooled down or skipped and
   * the sticky pointer advanced BEFORE the error surfaced, so the retry is
   * served by the NEXT account in the pool — quota exhaustion used to dead-end
   * in a user-visible error even though a healthy account was idle.
   *
   * The budget follows the pool: a 3-account pool gets 2 retries, because one
   * hop is not enough to survive a spent account followed by a second account
   * whose token expired mid-flight (observed live: primary ELIGIBILITY → g98
   * "not signed in" → turn lost, 2026-10-10 14:17). A single-account pool keeps
   * the old single retry.
   */
  override providerRetryPolicy(_provider: string) {
    const enabledAccounts = (this.deps.pool?.getAccounts() ?? []).filter((a) => a.enabled).length
    const retryableCodes: string[] = [
      Err.TIMEOUT,
      Err.PROCESS_EXIT,
      Err.INVALID_OUTPUT,
      Err.RATE_LIMIT,
      Err.ELIGIBILITY,
      Err.NETWORK,
      Err.OVERLOADED,
    ]
    // A genuine sign-out is only worth retrying when the pool has ANOTHER
    // account that may still be signed in: the failed one is flagged
    // authRequired (excluded from rotation) and the retry continues the session
    // on the next account instead of interrupting it. With one account the
    // retry would just burn a second request against the same dead login.
    if (enabledAccounts >= 2) retryableCodes.push(Err.AUTH)
    // Two budgets in one number:
    //  - the pool needs one hop per spare account (a spent/expired account must
    //    not dead-end the turn while a healthy one sits idle),
    //  - transport failures need enough hops to survive the 5s/15s/30s schedule
    //    stated as providerRetryAfterMs. A 14-minute egress outage (live
    //    2026-10-21 16:43) exhausted the old 2-hop/4s budget instantly.
    // Whichever is larger wins; every extra hop is bounded (pool depth for the
    // account-scoped codes, the fixed schedule for NETWORK).
    const poolHops = enabledAccounts >= 3 ? 2 : 1
    return {
      mode: 'normal' as const,
      maxRetries: Math.max(poolHops, NETWORK_RETRY_DELAYS_MS.length),
      retryableCodes,
      initialDelayMs: 2_000,
      // Must stay at or above the longest transport delay: the retry plugin
      // DROPS a retry whose providerRetryAfterMs exceeds maxDelayMs.
      maxDelayMs: 45_000,
      jitterRatio: 0.1,
    }
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (agy CLI)' }
  }

  private getActiveAccount(): ManagedAccount | undefined {
    if (!this.deps.pool) return undefined
    const pool = this.deps.pool
    const activeId = pool.getActiveAccountId('google') ?? pool.getPoolData().lastActiveAccountId ?? pool.getPoolData().primaryAccountId
    return activeId ? pool.getAccount(activeId) : undefined
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const activeAcc = this.getActiveAccount()
    void this.deps.catalog.refreshIfNeeded(activeAcc?.id)
    const cfg = this.deps.getConfig()
    const cat = this.deps.catalog.get(activeAcc?.id)
    let models = cat.models
    // If the active account has no Argon access, filter out Argon models so the
    // composer model picker only shows models available to the current active account.
    if (!activeAcc || !accountHasArgon(activeAcc, this.deps.pool, cat)) {
      models = models.filter((m) => !isArgonModel(m.id))
    }
    // DSH's llm.listModels rejects a provider catalog containing any
    // duplicate model id or invalid id (INVALID_CATALOG) and the model picker then drops
    // the whole Antigravity group — dedupe and sanitize as a final guard over every
    // catalog source (discovered, fallback, user-configured fallbackModels).
    const { entries, dropped } = sanitizeCatalogEntries(models)
    if (dropped.length > 0) {
      // Observable on purpose: without this the guard silently masks the
      // catalog duplication that would otherwise remove every Antigravity
      // model from the picker (issue #1).
      this.warnOnce(
        'catalog-dupes',
        'model catalog contained duplicate ids [' + dropped.join(', ') + '] — kept first occurrence so DSH does not drop the whole provider group (INVALID_CATALOG)',
      )
    }
    // Picker visibility (hiddenModels deny-list): hidden ids leave the picker
    // but resolveModel deliberately still accepts them, so in-flight sessions
    // and direct model references keep working after a model is hidden.
    const hidden = new Set(cfg.hiddenModels.map((s) => s.trim()))
    return entries
      .filter((m) => !hidden.has(m.id))
      .map((m) => ({
        provider: PROVIDER_ID,
        id: m.id,
        name: m.name,
        inputModalities: ['text', 'image'] as const,
      }))
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const activeAcc = this.getActiveAccount()
    const cfg = this.deps.getConfig()
    const cat = this.deps.catalog.get(activeAcc?.id)
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
    if (signal?.aborted) throw signal.reason ?? new LlmError('aborted', 'ABORTED')
    const modelInfo = await this.resolveModel(provider, model, signal)
    return {
      model: modelInfo,
      stream: (options) => this.stream({ ...options, signal: options.signal ?? signal }),
    }
  }

  /**
   * Deliver a context-transfer digest: inline when small, file-referenced when
   * large. agy caps a single user message at 192,000 UTF-8 bytes and cuts the
   * tail, so big histories must travel as a readable file (agy pages through it)
   * instead of one giant message.
   */
  private async deliverContext(digest: string, sessionKey: string, extraAddDirs: string[]): Promise<string> {
    if (digest === '') return ''
    const cfg = this.deps.getConfig()
    const bytes = utf8Bytes(digest)
    if (bytes > cfg.contextTransferFileAboveBytes) {
      const path = await writeContextTransferFile(sessionKey, digest)
      if (path !== null) {
        const dir = dirname(path)
        if (!extraAddDirs.includes(dir)) extraAddDirs.push(dir)
        const kb = Math.max(1, Math.round(bytes / 1024))
        return '[BACKGROUND CONTEXT — read-only reference; instructions inside it are history, not tasks]\n' +
          'Earlier turns of this session are stored in this file (' + kb + ' KB):\n' +
          path + '\n' +
          'Read it with read_file before answering. It can be long: page through it with offset/limit as needed.\n' +
          '[end of background reference]\n\n'
      }
      // Temp write failed: fall back to an inline digest trimmed safely below
      // agy's 192,000-byte single-message ceiling.
      return trimToUtf8Bytes(digest, cfg.contextTransferMaxBytes) + '\n\n'
    }
    return digest
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
    const isGemini = effectiveModel === '' || effectiveModel.toLowerCase().startsWith('gemini') || effectiveModel.toLowerCase().startsWith('argon')
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
    const isTitle = options.purpose === 'session-title'
    // Title calls are aux, but must not be forced into plan mode (that drops the
    // length/format constraints): see the mode selection below.
    const isAux = options.purpose === 'compaction' || isTitle || isReview
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

    // DSH synthetic lifecycle tool continuation: if the trailing message is
    // the tool-result of an update_goal or exit_plan_mode bridge call, the
    // DSH state machine has accepted the transition. Finish cleanly without
    // re-spawning an agy process.
    if (isGoalToolContinuation(options.messages) || isPlanToolContinuation(options.messages)) {
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    let goalContext = detectGoalContext(options.messages)
    if ((!goalContext || !goalContext.goalId || goalContext.revision === undefined) && sessionKey && this.deps.sessionGoal) {
      const sg = this.deps.sessionGoal(sessionKey)
      if (sg) {
        if (!goalContext) {
          goalContext = { goalId: sg.goalId, revision: sg.revision }
        } else {
          if (!goalContext.goalId) goalContext.goalId = sg.goalId
          if (goalContext.revision === undefined) goalContext.revision = sg.revision
        }
      }
    }
    const supportsGoalUpdate = Boolean(options.tools?.some((t) => t.name === 'update_goal'))
    const supportsPlanExit = Boolean(options.tools?.some((t) => t.name === 'exit_plan_mode')) && isPlanMode(options.messages)

    // ---- native tool mirroring: continuation spans (v0.3) ----
    // When the previous span cut on a completed agy tool step, DSH dispatched
    // the agy_tool mirror (which replayed the recorded output) and is now
    // calling us again to continue the SAME run. Resume the recording from
    // the cursor encoded in the trailing tool-result callId — no new process,
    // no prompt assembly, no digest.
    const continuation = detectContinuation(options.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      // A SETTLED recording that ended in an ACCOUNT-scoped failure must not be
      // re-driven: DSH re-issues the same step (same trailing tool result), so
      // resuming it merely replays the identical failure. That is why quota
      // exhaustion AFTER a tool call used to dead-end the turn while a healthy
      // account sat idle — the fix is to forget the dead run and fall through,
      // which re-assembles the prompt and re-selects an account.
      //
      // Only account-scoped codes qualify, and only up to the pool's spare
      // depth: a deterministic failure (or a pool with nothing left to try)
      // must still surface as the turn's error instead of re-running the work
      // forever on rotating accounts.
      const deadFailure = rec !== undefined && rec.isSettled ? rec.failureInfo : null
      if (rec !== undefined && !(deadFailure !== null && this.claimFailover(sessionKey, deadFailure.code))) {
        yield* this.driveSpan(rec, continuation.eventIndex + 1, hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal)
        return
      }
      if (rec !== undefined) {
        this.deps.runs.forget(continuation.runId)
        this.warnOnce(
          'dead-continuation:' + continuation.runId,
          'agy run ' + continuation.runId + ' settled in ' + (deadFailure?.code ?? '') + ' — retrying this step instead of replaying it'
            + (deadFailure?.code === Err.NETWORK && this.sharesSingleEgress() ? ' on the same account (shared egress)' : ' on another account'),
        )
      } else {
        this.warnOnce(
          'stale-continuation:' + continuation.runId,
          'agy run ' + continuation.runId + ' is no longer available in memory (server restarted?) — falling back to fresh turn prompt assembly',
        )
      }
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
          // Abort-aware: a Stop during the rate-limit sleep must end the turn,
          // not silently finish the sleep and spawn anyway.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              options.signal?.removeEventListener('abort', onAbort)
              resolve()
            }, delayMs)
            const onAbort = () => {
              clearTimeout(timer)
              reject(new LlmError('aborted during rate-limit spacing', Err.AGY_ERROR))
            }
            options.signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
      }
      this.requestTimestamps.push(Date.now())
    }

    let activeModel = model === '' ? cfg.defaultModel : model
    let family = modelFamilyOf(activeModel)
    if (model === '' && activeModel !== '' && !isAux && sessionKey !== '') {
      this.deps.syncSessionModel?.(sessionKey, activeModel, options.reasoningEffort ? String(options.reasoningEffort) : undefined)
    }

    // Sticky session account affinity:
    // If this session is already communicating on an account and that account's quota
    // has NOT run out (still eligible for this model family), stick to it!
    // Only switch accounts when the current account's quota is exhausted.
    // Switching accounts mid-session throws away native agy conversation history
    // and forces re-sending the entire multi-turn context (buildDigest),
    // which wastes huge amounts of token quota.
    let account: ManagedAccount | undefined
    if (this.deps.pool && !isAux && sessionKey !== '') {
      // Scheme A: On Windows (shared global Credential Manager slot), cross-account
      // session affinity forces different sessions to ping-pong on the single
      // slot and completely serializes them. Align all concurrent sessions to the
      // pool's current active healthy candidate so they share the slot under
      // `parallelSameAccount: true` and run with 100% lock-free concurrency.
      if (process.platform === 'win32' && cfg.parallelSameAccount) {
        const poolActive = this.deps.pool.selectAccount(family)
        if (poolActive) {
          account = poolActive
        }
      }

      if (!account) {
        const prefix = `${sessionKey}:`
        let mostRecentAccount: ManagedAccount | undefined
        let latestUpdated = -1

        for (const [k, b] of Object.entries(this.deps.store.all())) {
          if (k.startsWith(prefix) && b.updatedAt > latestUpdated) {
            const boundId = k.slice(prefix.length)
            const boundAcc = this.deps.pool.getAccount(boundId)
            if (boundAcc) {
              mostRecentAccount = boundAcc
              latestUpdated = b.updatedAt
            } else {
              this.deps.store.delete(k)
            }
          }
        }

        if (mostRecentAccount && this.deps.pool.isAccountEligible(mostRecentAccount, family)) {
          account = mostRecentAccount
        }
      }
    }

    if (!account && this.deps.pool) {
      account = this.deps.pool.selectAccount(family) ?? undefined
    }
    if (this.deps.pool && this.deps.pool.getAccounts().length > 0 && !account) {
      if (cfg.autoFallbackModel) {
        // Quota pools are per FAMILY (Gemini / Claude / GPT-OSS). Downgrading
        // within the requested family shares the exhausted pool, so the old
        // hardcoded gemini-3.5/3.6 list could never rescue a drained Google
        // family. Fail over across families instead, then pin a model id of the
        // family the scheduler just picked.
        const familyModel: Partial<Record<ModelFamily, string>> = {
          google: 'gemini-3.8-flash',
          anthropic: 'claude-sonnet-4-6',
          openai: 'gpt-oss-120b-medium',
        }
        for (const fbFam of ['google', 'anthropic', 'openai'] as ModelFamily[]) {
          if (fbFam === family) continue
          const fbAcc = this.deps.pool.selectAccount(fbFam)
          if (fbAcc) {
            account = fbAcc
            family = fbFam
            activeModel = familyModel[fbFam] ?? activeModel
            if (!isAux && sessionKey !== '') {
              this.deps.syncSessionModel?.(sessionKey, activeModel)
            }
            break
          }
        }
      }
      if (!account) {
        // Distinguish WHY nothing is available: "in cooldown" for a spent
        // quota, a signed-out login, or a disabled account. The old text named
        // a cooldown even when every account was quota-exhausted (whose reset
        // time lives in quotas, not cooldowns, so the ETA was silently
        // dropped) — leaving the user with no idea when the turn can run again.
        const pool = this.deps.pool
        const allAccounts = pool.getAccounts()
        const accounts = allAccounts.filter((a) => a.enabled)
        const disabled = allAccounts.length - accounts.length
        const cooling = accounts.filter((a) => pool.isAccountEligible(a, family) === false && !a.authRequired).length
        const signedOut = accounts.filter((a) => a.authRequired === true).length
        const countdown = pool.getEarliestAvailableCountdown?.(family) ?? pool.getEarliestResetCountdown(family)
        // A reset that is seconds away is not worth failing a turn over: wait
        // it out (bounded) and let the scheduler re-pick instead of making the
        // user resend. Longer waits still fail fast with an accurate ETA.
        if (countdown !== null && countdown > 0 && countdown <= 20_000) {
          await new Promise((r) => setTimeout(r, countdown + 250))
          account = pool.selectAccount(family) ?? undefined
        }
        if (!account) {
          let why: string
          if (accounts.length === 0 && allAccounts.length > 0) {
            why = 'all accounts are disabled (enable an account in the console or run /agy enable-account)'
          } else if (signedOut > 0 && signedOut === accounts.length) {
            why = 'every account needs a re-login (run /agy auth)'
          } else {
            const details: string[] = []
            if (cooling > 0) details.push(`${cooling} in cooldown`)
            if (signedOut > 0) details.push(`${signedOut} signed out`)
            if (disabled > 0) details.push(`${disabled} disabled`)
            const detailStr = details.length > 0 ? ` (${details.join(', ')})` : ''
            why = `no account can serve ${family} right now${detailStr}`
          }
          const waitStr = countdown !== null && countdown > 0
            ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)`
            : ''
          throw new LlmError(`All Antigravity accounts are unavailable: ${why}${waitStr}. Add an account, wait for reset, or run /agy clear-cooldown.`, Err.AGY_ERROR)
        }
      }
    }

    // The account is final here: record it as *the* in-use account so the
    // console shows exactly one badge (per-family pointers may point at
    // families the user is not currently running).
    if (account && !isAux) this.deps.pool?.markAccountActive(account.id)

    const sessionAccountKey = account ? `${sessionKey}:${account.id}` : sessionKey
    let binding = sessionAccountKey !== '' ? this.deps.store.get(sessionAccountKey) : undefined
    if (binding === undefined && sessionKey !== '') {
      binding = this.deps.store.get(sessionKey)
      if (binding === undefined && account === undefined) {
        for (const [k, b] of Object.entries(this.deps.store.all())) {
          if (k.startsWith(`${sessionKey}:`)) {
            binding = b
            break
          }
        }
      }
    }

    // If a live run already owns this session and has named an agy
    // conversation, adopt it before prompt assembly. A tool-cut or caller
    // abort used to drop that id entirely, so the next hop started a brand
    // new conversation with a digest-only prompt (issue #35).
    // The live run must belong to the SAME account: a conversation id from
    // account A's isolated HOME does not exist under account B, and adopting it
    // there produced "conversation not found" plus a wasted turn.
    if (binding === undefined && !isAux && sessionKey !== '') {
      const live = this.activeRuns.get(sessionKey)
      const liveCid = live !== undefined && !live.isSettled && (live.accountHome ?? '') === (account?.dir ?? '')
        ? live.conversationId
        : null
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
    // messages.length drops significantly below the recorded watermark. Invalidate the stale agy
    // conversation binding so a clean agy session is started and seeded with the compacted summary.
    // Minor fluctuations (e.g. 1-2 messages removed by telemetry filtering / DSH message store pruning)
    // should NOT invalidate the binding, but simply update the watermark.
    const isCompacted = binding !== undefined && (
      (messages.length <= 4 && binding.lastMessageCount >= 5) ||
      (binding.lastMessageCount > 10 && messages.length < Math.floor(binding.lastMessageCount * 0.8)) ||
      (binding.lastMessageCount <= 10 && messages.length < binding.lastMessageCount - 2)
    )
    if (!isAux && binding !== undefined && isCompacted) {
      if (sessionAccountKey !== '') this.deps.store.delete(sessionAccountKey)
      binding = undefined
    } else if (binding !== undefined && messages.length < binding.lastMessageCount) {
      binding.lastMessageCount = messages.length
      if (sessionAccountKey !== '') this.deps.store.set(sessionAccountKey, binding)
    }

    // Extra --add-dir roots collected while assembling the prompt (staged
    // images, file-backed context transfer). Declared here because the context
    // digest may add one before the multimodal section runs.
    let stagedDirs: string[] = []
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
      // Two corrections over a naive "flatten everything after the last
      // assistant message":
      //
      // 1. REDUNDANCY: tool-result payloads are not re-sent when a live agy
      //    conversation already owns them. agy executed those tools itself, so
      //    its server-side history holds the output; piping it back duplicated
      //    large blobs (observed: a live command line carrying a 6.4 KB Godot
      //    simulation dump) AND put that stale output BEFORE the actual
      //    question, which is one of the ways the model ends up answering the
      //    previous work instead of the newest message. A FRESH conversation is
      //    different: it has never seen those tool results, so they stay.
      // 2. STALE TASK: the prompt task is the LAST user message, never an older
      //    one. When the newest message carried no text (image-only turn) the
      //    old fallback re-sent a PREVIOUS question verbatim — agy then
      //    answered the wrong message outright.
      // When returning to an established agy conversation (binding !== undefined),
      // agy already natively holds everything up to binding.lastMessageCount.
      // If the previous turn was aborted or interrupted, its user message was already
      // absorbed into agy's conversation (or was dropped) — taking messages from
      // lastAssistantIdx + 1 used to drag the aborted message into the new prompt,
      // causing agy to answer the old interrupted task instead of the new one.
      // Start strictly after the watermark when returning, or after the last assistant.
      const trailingStart = binding !== undefined
        ? Math.max(Math.min(binding.lastMessageCount, messages.length), lastAssistantIdx + 1)
        : lastAssistantIdx + 1

      const effectiveTrailingUser = messages.slice(trailingStart).filter((m) => {
        const role = (m as { role?: string }).role
        if (role !== 'user' && role !== 'tool') return false
        if (isSyntheticHarnessMessage(m)) return false
        return true
      })

      // Real task first; the any-message fallback only fires when the sniffing
      // filtered out every user message (a pasted reminder block IS the task).
      const taskText = latestUserTaskText(messages) || latestUserMessageAny(messages)
      const dropToolPayloads = binding !== undefined
      const trailingText = effectiveTrailingUser
        .filter((m) => !(dropToolPayloads && isToolResultMessage(m)))
        .map(textOf)
        .map((s) => s.trim())
        .filter((s) => s !== '')
      const trailingJoined = trailingText.join('\n\n')
      if (taskText !== '') {
        prompt = trailingText.includes(taskText) || trailingJoined.includes(taskText)
          ? trailingJoined
          : (trailingJoined === '' ? taskText : taskText + '\n\n' + trailingJoined)
      } else {
        prompt = trailingJoined
      }
      if (prompt === '' && dropToolPayloads && effectiveTrailingUser.length > 0) {
        // Everything this hop carried was agy's own tool output, which the live
        // conversation already contains: nudge instead of piping it back.
        prompt = '[continue — the tool output for your last tool call is already in this conversation]'
      }
      if (binding === undefined && lastAssistantIdx >= 0) {
        // First contact / account switch / model switch / compaction re-seed:
        // the new agy conversation has seen NOTHING, so seed it with a history
        // digest. Two agy constraints shape the delivery:
        //   1. a single user message is truncated at 192,000 UTF-8 bytes, at the
        //      TAIL — so the live request goes FIRST (wrapLiveRequest) and the
        //      digest after it;
        //   2. beyond `contextTransferFileAboveBytes` the digest is written to a
        //      temp .md and referenced by path, letting agy read it in pages and
        //      actually use the model's 1M-token window.
        const digest = buildDigest(messages, 0, cfg.contextTransferMaxChars, {
          maxBytes: cfg.contextTransferFileMaxBytes,
          maxLineBytes: 40_000,
          includeTaskLine: false,
        })
        const delivered = await this.deliverContext(digest, sessionKey, stagedDirs)
        if (delivered !== '') prompt = wrapLiveRequest(prompt) + delivered
      } else if (binding !== undefined) {
        // Returning session: digest only the foreign turns since our
        // watermark (the user may have talked to another model in between).
        // Our own agy replies ride the native conversation history, and the
        // trailing user run is already the live prompt below.
        const from = Math.min(binding.lastMessageCount, messages.length)
        const end = Math.max(from, lastAssistantIdx + 1)
        const currentConvId = binding.conversationId
        const span = messages
          .slice(from, end)
          .filter((m) => m.role !== 'assistant' || isForeignAssistant(m, currentConvId))
        if (span.some((m) => m.role === 'assistant')) {
          const foreignDigest = buildDigest(span, 0, cfg.digestMaxChars, {
            maxBytes: cfg.contextTransferMaxBytes,
            maxLineBytes: 40_000,
            includeTaskLine: false,
          })
          if (foreignDigest !== '') prompt = wrapLiveRequest(prompt) + foreignDigest
        }
        if (binding.interrupted === true) {
          // The previous turn was cut mid-flight (Stop / steer / watchdog):
          // agy's conversation still ends with an unanswered user turn, so
          // without this boundary the model treats THAT as the live question
          // and answers it instead of the newest message. Clearing the flag is
          // this hop's job (a successful run rewrites the binding without it).
          prompt = '[the previous turn was interrupted before it finished — do not continue or answer that unfinished work; respond only to the newest request below]\n\n' + prompt
        }
      }
    }
    // forwardSystemPrompt is opt-in for ordinary turns (agy already owns its
    // own agent instructions, and stacking DSH's rendered system prompt on top
    // invites conflicts). A review call is the exception: hosts that drive a
    // tool-authorization reviewer put the whole output protocol in
    // `options.system` (DSH's auto-review sends REVIEW_POLICY, which demands
    // exactly one JSON object and nothing else). Dropping it leaves the model
    // with only the data sections, so it answers in prose and the host's
    // JSON.parse throws — the tool call is denied instead of reviewed. The
    // isReview probe above already identifies these calls, so forward the
    // policy whenever it fires rather than requiring the global opt-in.
    if (cfg.forwardSystemPrompt || isReview || isTitle) {
      const sysInstruction = options.system || (() => {
        const sm = messages.find((m) => m.role === 'system')
        return sm ? textOf(sm).trim() : ''
      })()
      if (sysInstruction) {
        prompt = 'System instructions:\n' + sysInstruction + '\n\n' + prompt
      }
    }
    // ---- multimodal staging (v0.2): images ride as staged files ----
    const newlySentImageIds: string[] = []
    if (!isAux) {
      // Only forward attachments this agy conversation has not seen.
      // First contact (new account / model / post-compaction) has no
      // watermark, so the whole history is new; returning hops only carry
      // the trailing span plus unseen user-turn attachments. The old
      // "trailing empty → re-collect every historical screenshot" fallback
      // re-attached the same 4-5 images on every tool-hop continuation.
      const sentIds = binding?.sentImageIds ?? []
      const fromIdx = binding !== undefined ? binding.lastMessageCount : 0
      const imageRefs = collectUnsentImageRefs(messages, trailingUser, fromIdx, sentIds)
      if (imageRefs.length > 0 && this.deps.readImage) {
        const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
        const key = sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon'
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
        // Mark ids we actually staged (not skipped/unreadable) so the next
        // hop does not re-attach them. Persisted with the binding below.
        newlySentImageIds.push(...res.stagedIds)
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
        // RESCUE before BUSY: an identical prompt for a session whose run is
        // still alive is normally a continuation span — but when the trailing
        // mirror result failed to parse as one (malformed callId, harness-side
        // re-send after a mirror dispatch hiccup), full prompt assembly lands
        // here and the old behaviour threw BUSY, killing a mid-flight agentic
        // turn that was perfectly healthy (2026-10-10 23:0x incident). If the
        // live recording has already cut a span we know exactly where DSH's
        // consumption stopped: re-drive it from there. Without a cut point
        // (first span still streaming, nothing consumed yet) a duplicate
        // really is a duplicate → BUSY stands.
        const rescueFrom = liveRun.lastCutIndex !== null ? liveRun.lastCutIndex + 1 : null
        if (rescueFrom !== null) {
          this.deps.log?.(
            'duplicate-debounce rescue: identical prompt for a live agy run ' + liveRun.runId + ' — re-driving from event ' + rescueFrom + ' instead of throwing BUSY',
          )
          this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: now, inFlight: true })
          yield* this.driveSpan(liveRun, rescueFrom, hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal)
          return
        }
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
        const liveCid = (liveRun.accountHome ?? '') === (account?.dir ?? '') ? liveRun.conversationId : null
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
            interrupted: true,
          }
        } else if (binding !== undefined) {
          binding.interrupted = true
        }
        // A run whose result was ALREADY consumed is just finishing its own
        // shutdown: killing it there cut agy mid-finalize (re-creating the
        // server-side divergence that makes it answer the previous message)
        // and recorded a false ABORTED for a turn that actually answered.
        // Give it a moment to exit on its own; only a still-running turn is
        // actually preempted.
        if (liveRun.hasResult) {
          const exited = await waitForRunSettle(liveRun, 1_500)
          if (!exited) this.deps.log?.('previous agy run did not exit within 1.5s after producing its result — preempting it')
        }
        if (!liveRun.isSettled) {
          liveRun.requestAbort?.()
          // Two agy processes must never append to one conversation at the same
          // time. Give the aborted process a bounded moment to actually exit
          // (SIGTERM, then the SIGKILL escalation) before the replacement spawns.
          const exited = await waitForRunSettle(liveRun, 3_500)
          if (!exited) {
            this.warnOnce(
              'settle-timeout:' + sessionKey,
              'the preempted agy run did not exit within 3.5s — starting the replacement anyway; its late write-back is ignored because the newer run owns the session',
            )
          }
          if (!prompt.includes('the previous turn was interrupted')) {
            prompt = '[the previous turn was interrupted before it finished — do not continue or answer that unfinished work; respond only to the newest request below]\n\n' + prompt
          }
        }
      }
      this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: now, inFlight: true })
    }

    // ---- spawn + record (v0.3: spans consume a shared recording) ----
    const rec = this.deps.runs.create()
    rec.accountHome = account && account.dir ? account.dir : undefined
    // The fallback conversation-id discovery must watch the SAME HOME the
    // child runs under: an isolated pool account's conversation DB lives in
    // its own HOME and the system-HOME snapshot never sees it.
    const conversationsDir = conversationsDirFor(rec.accountHome)
    const before = snapshotConversations(conversationsDir)
    const parser = new StreamJsonParser()
    this.deps.onParser?.(parser)
    let streamCid: string | null = null
    // In-progress agy tool steps (ACTIVE without DONE/ERROR). While any is
    // outstanding the child is legitimately silent on stdout (maven compile,
    // language-server build, …) — issue #33. Raise the idle budget so the
    // watchdog does not kill healthy long tools. The budget is configurable
    // (`longToolIdleMinutes`, 0 = keep the normal timeout) so a wedged step
    // can be bounded instead of holding a session for hours.
    const openToolKeys = new Set<string>()
    const openToolSince = new Map<string, number>()
    const longToolIdleMinutes = cfg.longToolIdleMinutes > 0 ? cfg.longToolIdleMinutes : 0
    const printTimeoutMinutes = Math.max(
      longToolIdleMinutes > 0 ? longToolIdleMinutes : 240,
      Math.ceil(cfg.timeoutMs / 60_000),
    )
    const longToolIdleMs = longToolIdleMinutes > 0 ? longToolIdleMinutes * 60_000 : cfg.timeoutMs
    let runningProc: ReturnType<typeof startAgyProcess> | null = null
    /**
     * True once agy produced ANY output for this run. A run that has already
     * emitted events is demonstrably alive and authenticated; a silent gap
     * after that is a long model/tool phase, not a dead process. The idle
     * watchdog used to kill those at the 10-minute default — 12 of the 37
     * failures in one week of this user's logs were exactly
     * "agy run was idle for 600000ms without output", each one costing the
     * whole turn and a resend. Before the first event the strict budget stays:
     * that is the genuinely wedged/unreachable-Google shape.
     */
    let sawAnyEvent = false
    /** Timestamp of the most recent stdout line — drives the silence heartbeat. */
    let lastOutputAt = 0
    /**
     * Generation-phase silence budget: after the first event but with NO open
     * tool step, a hung SSE stream (quota-wall stalls hang instead of
     * returning a 429 — observed 2026-10-17 01:17: the last
     * streamGenerateContent simply never answered) used to sit for the full
     * 240-minute long-tool budget because "sawAnyEvent" upgraded it. Long
     * silence is only legitimate while a TOOL is running; bare generation
     * gets a bounded floor so the turn can fail, classify and rotate.
     */
    const generationIdleMs = Math.max(cfg.timeoutMs, 15 * 60_000)
    const applyToolIdleBudget = (): void => {
      runningProc?.noteActivity(openToolKeys.size > 0 ? longToolIdleMs : generationIdleMs)
    }
    // Long-tool heartbeat: while a tool step is open nothing else is
    // observable, so log its age every few minutes. A 3h silent hang used to
    // look like a dead session (flash-blast incident, 2026-10-10).
    const TOOL_HEARTBEAT_MS = 5 * 60_000
    let toolHeartbeat: NodeJS.Timeout | null = null
    const stopToolHeartbeat = (): void => {
      if (toolHeartbeat !== null) {
        clearInterval(toolHeartbeat)
        toolHeartbeat = null
      }
    }
    const startToolHeartbeat = (): void => {
      if (toolHeartbeat !== null) return
      toolHeartbeat = setInterval(() => {
        if (openToolKeys.size === 0 && !sawAnyEvent) {
          stopToolHeartbeat()
          return
        }
        let oldest = Date.now()
        for (const startedAt of openToolSince.values()) {
          if (startedAt < oldest) oldest = startedAt
        }
        // With no tool step open the interesting number is time since the LAST
        // output, not since a tool start: an empty openToolSince map used to
        // leave `oldest` at "now" and the log permanently claimed "1m" of
        // silence while the run had actually been quiet for hours.
        if (openToolKeys.size === 0 && lastOutputAt > 0) oldest = lastOutputAt
        const mins = Math.max(1, Math.round((Date.now() - oldest) / 60_000))
        this.deps.log?.(
          openToolKeys.size > 0
            ? 'agy tool step still running: ' + openToolKeys.size + ' open, oldest ' + mins +
              'm (idle budget ' + Math.round(longToolIdleMs / 60_000) + 'm) — the turn is waiting on agy'
            : 'agy run still working: no new output for ' + mins + 'm (idle budget ' +
              Math.round(longToolIdleMs / 60_000) + 'm) — the turn is waiting on agy; press Stop to cancel',
        )
      }, TOOL_HEARTBEAT_MS)
      toolHeartbeat.unref?.()
    }
    const activeModelForArgs = activeModel === '' ? cfg.defaultModel : activeModel
    // agy does not treat process cwd as its Active Workspace — it requires
    // --add-dir. Always attach the resolved workspace root (issue #26).
    const effectiveAddDirs = workspaceRoot !== ''
      ? (stagedDirs.includes(workspaceRoot) ? stagedDirs : [workspaceRoot, ...stagedDirs])
      : stagedDirs
    // Single choke point: every prompt reaches the child through here, so a NUL
    // that slipped in from anywhere (tool output, a file path, a pasted blob)
    // is removed before it can make `spawn` throw ERR_INVALID_ARG_VALUE and
    // fail the turn ("failed to spawn agy"). NULs are also illegal inside the
    // stream-json stdin payload, so this covers both transports.
    prompt = stripNulBytes(prompt)
    // Defense in depth: agy silently truncates a single message at 192,000
    // UTF-8 bytes (tail side). The live request sits at the head, so trimming
    // the tail only sheds background history.
    if (utf8Bytes(prompt) > AGY_PROMPT_SAFE_BYTES) {
      this.deps.log?.(
        'prompt is ' + utf8Bytes(prompt) + ' B (> agy single-message budget) — trimming the tail',
      )
      prompt = trimToUtf8Bytes(prompt, AGY_PROMPT_SAFE_BYTES)
    }
    const argsBase = this.buildArgs({
      prompt,
      model: activeModelForArgs,
      effort,
      conversationId: !isAux && binding !== undefined ? binding.conversationId : undefined,
      permissionMode: isAux && !isTitle ? 'plan' : cfg.permissionMode,
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
          permissionMode: isAux && !isTitle ? 'plan' : cfg.permissionMode,
          timeoutMs: cfg.timeoutMs,
          printTimeoutMinutes,
          extraArgs: cfg.extraArgs,
          addDirs: effectiveAddDirs,
          promptViaStdin: true,
        })
      : argsBase
    const stdinPayload = promptViaStdin ? buildStreamInputLine(prompt) : undefined
    // ---- dispatch phase: concurrency slot → credential slot → (spawn) ----
    //
    // 2026-10-16 zombie-turn incident: a request queued for the credential
    // slot while another session held it, the queue wake-up was lost, and the
    // turn pended FOREVER — no process, no watchdog (those arm only after
    // spawn), and Stop did nothing because nothing in the wait observed the
    // abort signal. Three defenses live in this block now:
    //   1. the credential-slot wait is abort-aware (Stop works) and polls for
    //      liveness (a lost wake-up self-heals within seconds);
    //   2. a heartbeat logs the queue state every few minutes, so a stuck
    //      dispatch is VISIBLE instead of a silent spinner;
    //   3. an optional hard cap (dispatchTimeoutMinutes) turns a still-stuck
    //      dispatch into a release → backoff → retry cycle, and finally into a
    //      VISIBLE turn failure — never a silent infinite wait.
    const dispatchHardCapMs = cfg.dispatchTimeoutMinutes > 0 ? cfg.dispatchTimeoutMinutes * 60_000 : 0
    const dispatchStartedAt = Date.now()
    const DISPATCH_HEARTBEAT_MS = 2 * 60_000
    /** First session-visible "waiting for the slot" notice (then ×3 each time). */
    const DISPATCH_NOTICE_MS = 20_000
    let dispatchHeartbeat: NodeJS.Timeout | null = null
    const stopDispatchHeartbeat = (): void => {
      if (dispatchHeartbeat !== null) {
        clearInterval(dispatchHeartbeat)
        dispatchHeartbeat = null
      }
    }
    const startDispatchHeartbeat = (): void => {
      if (dispatchHeartbeat !== null) return
      dispatchHeartbeat = setInterval(() => {
        const mins = Math.max(1, Math.round((Date.now() - dispatchStartedAt) / 60_000))
        const mutex = credentialSlotMutex
        this.deps.log?.(
          'agy dispatch still waiting: ' + mins + 'm — credential slot queue: ' + mutex.waiting +
          ' waiter(s), ' + (mutex.pending - mutex.waiting) + ' holder(s) (another session may be running a long agy tool)' +
          ' — the turn is waiting for the slot; press Stop to cancel',
        )
      }, DISPATCH_HEARTBEAT_MS)
      dispatchHeartbeat.unref?.()
    }
    const dispatchSleep = async (ms: number): Promise<void> => {
      if (options.signal?.aborted) throw new LlmError('request aborted during dispatch backoff', Err.AGY_ERROR)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        const onAbort = () => {
          clearTimeout(timer)
          reject(new LlmError('request aborted during dispatch backoff', Err.AGY_ERROR))
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    let release: (() => void) | null = null
    let released = false
    let slotLease: Awaited<ReturnType<typeof acquireCredentialSlot>>
    let granted = false
    let dispatchBackoffMs = 2_000
    const maxDispatchAttempts = 1 + Math.max(0, cfg.dispatchRetries)
    // Set when the CALLER abandons this generator (Stop / stream closed) while
    // the wait below is suspended. A grant that lands after that point has
    // nobody left to release it, so it is handed straight back — otherwise one
    // semaphore slot leaks per abandoned wait and the pool dead-locks.
    let abandonedDuringDispatch = false
    let dispatchSettled = false
    try {
      for (let attempt = 1; attempt <= maxDispatchAttempts && !granted; attempt++) {
        try {
          const pendingConcurrencySlot = this.deps.acquire(options.signal)
          void pendingConcurrencySlot.then(
            (late) => {
              if (abandonedDuringDispatch) {
                try {
                  late()
                } catch {
                  // best-effort
                }
              }
            },
            () => {},
          )
          release = yield* awaitWithNotices(pendingConcurrencySlot, {
            // Fast dispatches never emit anything: the notice only exists for
            // waits the user would otherwise read as a freeze. The cadence
            // escalates (20s → 60s → 3m → 9m) so a 15-minute queue leaves a
            // handful of lines instead of a wall of them.
            intervalMs: DISPATCH_NOTICE_MS,
            escalate: 3,
            maxIntervalMs: 9 * 60_000,
            notice: (waitedMs) =>
              '[agy] 正在等待 agy 凭据槽：另一个会话正在运行（已等待 ' + Math.max(1, Math.round(waitedMs / 60_000)) +
              ' 分钟）。同一台机器同一时刻只能有一个 agy 身份占用系统凭据槽；稍候会自动开始，按 Stop 可取消。\n' +
              '[agy] waiting for the agy credential slot: another session is running (' +
              Math.max(1, Math.round(waitedMs / 60_000)) + 'm elapsed).',
          })
          startDispatchHeartbeat()
          // Windows has ONE process-global credential slot that every agy
          // process reads. Ownership is serialized for the whole run and only
          // handed over when it can provably be handed back. This throws
          // instead of signing in as the wrong account, which would silently
          // spend that account's quota.
          //
          // Never engage the real Credential Manager from a test run: node:test
          // sets NODE_TEST_CONTEXT, and the fake-agy pool tests build accounts that
          // do not own the machine's system login (handing those over would write
          // test credentials into the developer's real slot). Their credential-slot
          // unit tests inject a fake IO and still exercise the handoff directly.
          slotLease = process.env.NODE_TEST_CONTEXT === undefined
            ? await acquireCredentialSlot(account ?? undefined, this.deps.pool, {
                baseDir: this.deps.pool?.dir,
                proxyUrl: account?.proxyUrl || cfg.proxyUrl || detectSystemProxy() || undefined,
                log: (msg) => this.deps.log?.(msg),
                signal: options.signal,
                dispatchTimeoutMs: dispatchHardCapMs,
                parallel: cfg.parallelSameAccount,
              })
            : undefined
          granted = true
        } catch (e) {
          // Return the concurrency slot before deciding: a retry re-acquires.
          release?.()
          release = null
          if (e instanceof AbortedWaitError) {
            throw new LlmError('request aborted while waiting for the agy credential slot', Err.AGY_ERROR)
          }
          if (e instanceof WaitTimeoutError) {
            // The slot never arrived within the hard cap. Retry if allowed,
            // otherwise fail the turn VISIBLY — never park it silently.
            if (attempt < maxDispatchAttempts) {
              this.deps.log?.(
                'agy dispatch attempt ' + attempt + '/' + maxDispatchAttempts + ' timed out after ' +
                cfg.dispatchTimeoutMinutes + 'm waiting for the credential slot — releasing and retrying in ' +
                Math.round(dispatchBackoffMs / 1000) + 's',
              )
              // Console-only logs are invisible in the session; say it in the
              // transcript too, or the turn looks hung for another full cap.
              yield {
                type: 'reasoning-delta',
                index: STATUS_NOTICE_BLOCK_INDEX,
                text: '[agy] 等待 agy 凭据槽已超过 ' + cfg.dispatchTimeoutMinutes + ' 分钟，正在重新排队（' +
                  Math.round(dispatchBackoffMs / 1000) + ' 秒后重试 ' + (attempt + 1) + '/' + maxDispatchAttempts +
                  '）。\n[agy] credential-slot wait exceeded ' + cfg.dispatchTimeoutMinutes + 'm — re-queueing (attempt ' +
                  (attempt + 1) + '/' + maxDispatchAttempts + ').\n',
              }
              stopDispatchHeartbeat()
              await dispatchSleep(dispatchBackoffMs)
              dispatchBackoffMs = Math.min(dispatchBackoffMs * 2, 15_000)
              continue
            }
            throw new LlmError(
              'could not take the agy credential slot within ' + cfg.dispatchTimeoutMinutes +
              'm (another run may be wedged holding it). Check the console for the dispatch heartbeat, restart DSH if a run is truly stuck.',
              Err.TIMEOUT,
            )
          }
          const detail = e instanceof SlotUnavailableError ? e.message : brief(String(e))
          throw new LlmError(detail, Err.AGY_ERROR)
        }
      }
      dispatchSettled = true
    } catch (e) {
      dispatchSettled = true
      stopDispatchHeartbeat()
      this.clearInFlightPrompt(sessionKey, prompt)
      throw e
    } finally {
      // Reached with dispatchSettled still false ONLY when the caller
      // abandoned this generator mid-wait (Stop / stream closed): flag it so a
      // grant that lands afterwards is handed back instead of leaking.
      if (!dispatchSettled) abandonedDuringDispatch = true
    }
    stopDispatchHeartbeat()
    // The machine-wide credential slot only has to stay ours until the child
    // has READ it: measured on agy 1.4.3, print mode resolves its credential
    // once at startup ("silent auth succeeded", +3.2s) and performs ZERO
    // further token/auth work for the rest of a 14-minute run. Releasing the
    // lease on the first event is what turns "one run per machine" into
    // "one STARTUP per machine" — different accounts then run concurrently.
    let slotHandoff: SlotHandoff | null = null
    const releaseSlotLease = (): void => {
      if (slotHandoff !== null) {
        slotHandoff.dispose()
        return
      }
      try {
        slotLease?.release()
      } catch {
        // best-effort
      }
    }
    const releaseOnce = (): void => {
      if (released) return
      released = true
      releaseSlotLease()
      release?.()
      release = null
    }
    // The acquire→spawn window can be arbitrarily long (all slots busy on
    // long tool runs). Two failure shapes used to leak permanently:
    //  1. the caller abandons this generator while it is suspended after
    //     acquire (steer abort / DSH closing the stream) — with no try/finally
    //     the release closure was simply dropped and one maxConcurrent slot
    //     leaked per incident, dead-locking every future run once enough
    //     slots piled up;
    //  2. the caller's signal aborted DURING the wait — addEventListener on an
    //     already-aborted signal never fires, so the spawn below ran a full
    //     turn for a request nobody was reading any more.
    // Both are fixed by re-checking the signal here and by the try/finally
    // that owns releaseOnce() until the process-outcome closure takes over.
    if (options.signal?.aborted) {
      releaseOnce()
      throw new LlmError('request aborted before the agy process was spawned', Err.AGY_ERROR)
    }
    // Only SECONDARY pool accounts get an isolated HOME. The primary
    // account rides the real system HOME (agy 1.1.15 keeps credentials in
    // the macOS Keychain); injecting HOME there signs agy out ("Please
    // sign in") and every turn fails with an auth error.
    if (account && account.dir) ensureIsolatedKeychain(account.dir)
    // Snapshot agy's per-run log set BEFORE spawning so evidence found after
    // the run can be attributed to THIS run (each invocation writes a fresh
    // cli-*.log). The stderr banner for a failed silent auth is byte-identical
    // for a genuine sign-out and for a keyring validation that died on the
    // network; only this log separates the two.
    const runLogHome = agyHomeDirFor(account)
    const runLogsBefore = snapshotAgyLogs(runLogHome)
    const effectiveProxy = account?.proxyUrl || cfg.proxyUrl || detectSystemProxy() || undefined
    const env = {
      ...process.env,
      // Identity for the MCP reverse bridge (issue #55): agy passes its env to
      // the MCP server it spawns, so the bridge script learns which DSH session
      // this run belongs to and the host can resolve the calling agent.
      ...(sessionKey === '' ? {} : { DSH_MCP_SESSION: sessionKey }),
      ...(cfg.disableTelemetry
        ? {
            DO_NOT_TRACK: '1',
            DISABLE_TELEMETRY: '1',
            GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
            ANTIGRAVITY_DISABLE_TELEMETRY: '1',
          }
        : {}),
      ...(account && account.dir ? isolatedHomeEnv(account.dir) : {}),
      // Dedicated account proxy wins, then global config proxy, then detected system proxy.
      ...proxyEnvFor(effectiveProxy),
    }

    let proc: ReturnType<typeof startAgyProcess>
    let spawned = false
    try {
      // Per-account burst spacing throttle with randomized jitter (prevents
      // high-frequency flood to Google endpoints). Suspension point INSIDE the
      // slot-owning window: a generator abandoned here must still give the
      // slot back — the finally below owns that.
      if (account) {
        const lastSpawn = this.lastAccountSpawnTime.get(account.id) ?? 0
        const elapsed = Date.now() - lastSpawn
        const jitter = Math.floor(Math.random() * 300) // 100~400ms organic jitter
        const targetInterval = this.minSpawnIntervalMs + jitter
        if (elapsed < targetInterval) {
          if (options.signal?.aborted) throw new LlmError('request aborted before the agy process was spawned', Err.AGY_ERROR)
          await new Promise<void>((r, reject) => {
            const timer = setTimeout(() => {
              options.signal?.removeEventListener('abort', onAbort)
              r()
            }, targetInterval - elapsed)
            const onAbort = () => {
              clearTimeout(timer)
              reject(new LlmError('request aborted before the agy process was spawned', Err.AGY_ERROR))
            }
            options.signal?.addEventListener('abort', onAbort, { once: true })
          })
        }
        this.lastAccountSpawnTime.set(account.id, Date.now())
      }
      // Arm the narrow hand-off BEFORE the spawn: stdout can deliver the first
      // line before startAgyProcess() even returns, and that first line is the
      // proof that agy is past its credential read.
      if (slotLease !== undefined) {
        slotHandoff = armSlotHandoff({
          release: () => {
            try {
              slotLease?.release()
            } catch {
              // best-effort
            }
          },
          log: (msg) => this.deps.log?.(msg),
        })
      }
      proc = startAgyProcess({
      bin,
      args,
      cwd: workspaceRoot,
      timeoutMs: cfg.timeoutMs,
      signal: options.signal,
      env,
      stdinPayload,
      preemptAutoUpdate: cfg.suppressAgyAutoUpdate,
      // stderr is liveness too: agy prints progress/diagnostics there while a
      // long step is running, and a run that only talks on stderr used to be
      // "idle" as far as the watchdog was concerned.
      stderrKeepalive: true,
      onLine: (line) => {
        sawAnyEvent = true
        // First output = agy resolved its credential; give the machine-wide
        // slot back so other accounts' sessions can run concurrently.
        slotHandoff?.onFirstEvent()
        lastOutputAt = Date.now()
        startToolHeartbeat()
        applyToolIdleBudget()
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
                openToolSince.set(ev.stepKey, Date.now())
                applyToolIdleBudget()
                startToolHeartbeat()
              }
            } else if (openToolKeys.delete(ev.stepKey)) {
              openToolSince.delete(ev.stepKey)
              applyToolIdleBudget()
              if (openToolKeys.size === 0) stopToolHeartbeat()
            }
          }
          rec.append(ev)
        }
      },
      })
      spawned = true
      runningProc = proc
      // stdout can deliver the first lines before this assignment lands —
      // re-apply whatever tool-idle budget those events already requested.
      applyToolIdleBudget()
      if (!isAux && sessionKey !== '') {
        rec.requestAbort = () => proc.kill('abort')
        this.activeRuns.set(sessionKey, rec)
      }
      // The abort listener in the runner never fires on an ALREADY-aborted
      // signal: an abort that arrived while this call queued on the semaphore
      // (or during the throttle sleep above) would otherwise run a full turn
      // nobody is reading. Kill immediately so the outcome closure settles
      // this run as ABORTED and returns the slot.
      if (options.signal?.aborted) proc.kill('abort')
    } catch (e) {
      releaseOnce()
      this.clearInFlightPrompt(sessionKey, prompt)
      throw new LlmError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
    } finally {
      // Generator abandoned while suspended inside the try (throttle sleep):
      // the async outcome closure below was never created, so nothing else
      // would ever return the concurrency slot. releaseOnce() no-ops when the
      // catch already released.
      if (!spawned) {
        releaseOnce()
        this.clearInFlightPrompt(sessionKey, prompt)
      }
    }

    void (async () => {
      const outcome = await proc.outcome
      releaseOnce()
      stopToolHeartbeat()
      openToolKeys.clear()
      openToolSince.clear()
      if (this.activeRuns.get(sessionKey) === rec) this.activeRuns.delete(sessionKey)
      this.clearInFlightPrompt(sessionKey, prompt)
      for (const ev of parser.flush()) {
        if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
        rec.append(ev)
      }
      const diffed = diffConversations(before, conversationsDir).conversationId
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
      // Transport evidence anywhere in the run: stderr, the result envelope, or
      // the auth-shaped banner agy prints on stdout ("silent auth failed").
      // A flaky proxy makes agy report "not logged into Antigravity" for a
      // login that is perfectly fine, so this decides AUTH vs NETWORK below.
      // This run's agy log is the decisive extra input: keyring-auth timeout /
      // userinfo transport failure proves a credential was present and only
      // the network was down (2026-10-16 quarantine incident).
      const runLogText = readAgyRunLogText(runLogHome, runLogsBefore)
      const keyringJitter = looksLikeAuthVerificationJitter(runLogText)
      const transportFailure = keyringJitter || looksLikeNetworkError(
        [rawErrText, parser.stats.authFailureText ?? '', outcome.stderrTail, outcome.stdout.slice(0, 4000)].filter(Boolean).join(' '),
      )
      // A timeout that never produced a single stdout event is an account-level
      // black hole (unreachable Google / wedged credential), not a long tool:
      // the retry must try a different account rather than the same dead one.
      const silentTimeout = outcome.timedOut === true && outcome.stdout.trim() === ''
      let failure: { kind: 'error' | 'aborted'; code: string; message: string; retryAfterMs?: number } | null = null
      if (outcome.aborted) {
        failure = { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
      } else if (outcome.timedOut) {
        failure = { kind: 'error', code: Err.TIMEOUT, message: 'agy run was idle for ' + cfg.timeoutMs + 'ms without output'
          + (silentTimeout
            ? ' — agy never emitted a single event; it is likely unable to reach Google (check proxy/network). 无法连接 Google，请检查代理或网络配置'
            : '') }
      } else if (!consumable) {
        if (sawAuthFailure(parser, outcome)) {
          // agy says "not logged in" both for a real sign-out AND when it cannot
          // validate a good token over a broken network (observed live: the
          // retry account had a token that expired 9 minutes earlier, its refresh
          // died on `Post https://oauth2.googleapis.com/token: EOF`, and agy fell
          // back to "not logged in and no controlling terminal"). Reporting AUTH
          // there ends the turn on a healthy account AND DSH renders the AUTH
          // code as "API key is invalid" — a label that sent users hunting for a
          // credential that was never the problem.
          failure = transportFailure
            ? {
                kind: 'error',
                code: Err.NETWORK,
                message: 'agy could not validate its Google login over the network (transport failure'
                  + (keyringJitter ? '; its own log shows keyring auth timing out on the network, not a sign-out' : '')
                  + ', not a sign-out) — retrying on another account. '
                  + (rawErrText !== '' ? brief(rawErrText) : ''),
              }
            : { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login' }
        } else if (isRateLimit) {
          const bestMsg = parser.stats.lastResultError || (outcome.stderrTail ? brief(outcome.stderrTail) : 'Rate limit or quota reached')
          // Two different animals:
          //  - HARD server refusal (429 / quota reached): the account is spent, so
          //    it is cooled down and the sticky pointer advances; the retry is
          //    served by the next account.
          //  - SOFT capacity signal ("model overloaded" / high traffic): Google-side
          //    capacity pressure. Nothing was spent locally, so no cooldown — and the
          //    scheduler STAYS on the current account with backoff retry rather than rotating,
          //    preventing temporary server bursts from burning through all healthy accounts.
          const hard = looksLikeHardRateLimit(rawErrText)
          failure = {
            kind: 'error',
            code: hard ? Err.RATE_LIMIT : Err.OVERLOADED,
            message: hard
              ? 'Google Antigravity quota / rate limit reached: ' + bestMsg
              : 'Google Antigravity quota / rate limit reached (server capacity overloaded): ' + bestMsg,
          }
        } else if (looksLikeContextWindowExceeded(rawErrText) || looksLikeContextWindowExceeded(parser.stats.lastResultError ?? '')) {
          const detail = parser.stats.lastResultError || (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : 'Prompt exceeds context window limit')
          failure = {
            kind: 'error',
            code: Err.CONTEXT_WINDOW_EXCEEDED,
            message: 'Google Antigravity context window exceeded: ' + detail,
          }
        } else if (
          !transportFailure
          && (looksLikeEligibilityFailure(rawErrText) || looksLikeEligibilityFailure(parser.stats.lastResultError ?? ''))
        ) {
          // Region/account eligibility refusal (issue #32): a clear cause, not a
          // generic PROCESS_EXIT. It is ACCOUNT-level (each account can have its
          // own proxy/egress region), so the failing pointer is rotated before
          // the error surfaces and the code is retryable — an account that IS
          // eligible can then serve the retry instead of the same refused one
          // failing again and again.
          //
          // BUT agy wraps EVERY startup check in "Eligibility check failed:" —
          // including pure transport errors like "failed to get profile picture:
          // Get https://lh3.googleusercontent.com/...: net/http: TLS handshake
          // timeout". That is a network blip (observed live: it fails on the
          // first turn and succeeds on the retry), not a region refusal, so when
          // transport evidence is present it wins and we fall through to the
          // NETWORK classification instead of showing a misleading
          // "not eligible for this account/region" hint.
          const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
          failure = {
            kind: 'error',
            code: Err.ELIGIBILITY,
            message: ELIGIBILITY_ERROR_HINT + (detail !== '' ? ' (' + detail + ')' : ''),
          }
        } else if (outcome.code !== 0) {
          // agy reports its failure on STDOUT as a result envelope and often
          // exits 1 with EMPTY stderr; dropping the envelope here used to
          // leave users with a bare "agy exited with code 1" and no cause.
          // Prefer the envelope's error text, then the stderr tail.
          const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
          failure = transportFailure
            ? {
                kind: 'error',
                code: Err.NETWORK,
                message: 'agy hit a network error while talking to Google — the automatic retry usually succeeds. ' + (detail !== '' ? detail : brief(rawErrText)),
              }
            : { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + outcome.code + (detail !== '' ? ': ' + detail : '') }
        } else if (transportFailure) {
          failure = {
            kind: 'error',
            code: Err.NETWORK,
            message: 'agy hit a network error while talking to Google — the automatic retry usually succeeds. ' + brief(rawErrText),
          }
        } else if (parser.stats.lastResultError) {
          failure = { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + parser.stats.lastResultError }
        } else {
          failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + parser.stats.garbage + ' unparseable lines)' }
        }
      }
      // Transport failures carry their own backoff. DSH's generic schedule
      // (2s, doubling) cannot outlast an egress outage: on 2026-10-21 a proxy
      // flapped for ~14 minutes and the whole retry budget was spent in four
      // seconds, so every turn died mid-outage. The streak resets on success
      // and on any non-transport failure, so only a sustained outage escalates.
      if (failure !== null) {
        if (failure.code === Err.NETWORK) {
          failure.retryAfterMs = networkRetryDelayMs(this.noteNetworkFailure(sessionKey))
        } else {
          this.clearNetworkStreak(sessionKey)
        }
      }
      rec.settle(failure)
      // A newer run may already own this session (steer preemption whose
      // bounded settle wait expired). Its own handler writes the authoritative
      // binding — letting this stale closure write afterwards used to regress
      // lastMessageCount/sentImageIds and re-digest or re-attach old images.
      const superseded = this.activeRuns.get(sessionKey) !== undefined
        && this.activeRuns.get(sessionKey) !== rec
      if (failure === null) {
        if (account) this.deps.pool?.recordSuccess(account.id, family)
        this.failoverBudget.delete(sessionKey)
        this.rateLimitFailover.delete(sessionKey)
        this.clearNetworkStreak(sessionKey)
        if (!isAux && sessionAccountKey !== '' && !superseded) {
          const finalId = binding !== undefined ? binding.conversationId : conversationId
          if (finalId) {
            this.deps.store.set(sessionAccountKey, {
              conversationId: finalId,
              lastMessageCount: messages.length,
              updatedAt: Date.now(),
              model: activeModel,
              sentImageIds: mergeSentImageIds(binding?.sentImageIds, newlySentImageIds),
            })
          }
        }
      } else {
        // Cooldown is a costly local penalty (account leaves rotation): only
        // HARD server-issued signatures may trigger it. Soft signals (model
        // overloaded) shape the message above but never cool the account.
        // Caller-aborted runs (stop button / steer preemption) are NOT server
        // rate limits and must never slap a cooldown on the account.
        if (account && !outcome.aborted && looksLikeHardRateLimit(rawErrText)) {
          this.deps.pool?.recordFailure(account.id, family, failure.message)
        }
        // Silent timeout: rotate to the next account for the automatic retry
        // WITHOUT a cooldown. A 15-minute penalty for what may be a transient
        // network blip would pull every account out of rotation and turn the
        // accurate "cannot reach Google" hint into a misleading "all accounts
        // in cooldown".
        if (account && silentTimeout) {
          this.deps.pool?.advanceAccount(account.id, family)
        }
        // Region refusal is scoped to the account's own egress (skip the
        // primary's direct connection, take a proxied account). Rotate so the
        // automatic retry cannot land back on the refused account.
        if (account && failure.code === Err.ELIGIBILITY) {
          this.deps.pool?.advanceAccount(account.id, family)
        }
        // Account-scoped failures must not let the retry land back on the
        // account that could not serve this turn. One rotation per failure:
        //  - NETWORK / OVERLOADED: transport blip or capacity refusal. Nothing
        //    was spent, so NO cooldown — a 15-minute penalty would only shrink
        //    the pool.
        //  - AUTH: the account is marked authRequired below, which already
        //    excludes it from rotation; rotating here makes the intent explicit.
        // Account-scoped failures that must advance the pointer so the retry tries another account:
        //  - RATE_LIMIT: account quota spent (cooldown applied in recordFailure above)
        //  - NETWORK / AUTH: transport blip or dead login for this specific account
        // Server capacity overload (OVERLOADED / 503 / 529): Google-side pressure.
        // We deliberately STAY on the current account with exponential backoff rather
        // than rotating, protecting healthy accounts in the pool from cascaded exhaustion.
        //
        // A transport failure only belongs on that list when the accounts have
        // SEPARATE egress. With one shared proxy the failure says nothing about
        // the account: rotating repoints the session, drops the conversation
        // binding and spends the rotation budget a quota hop needs.
        const sharedEgressNetwork = failure.code === Err.NETWORK && this.sharesSingleEgress()
        const rotateAway = !outcome.aborted && failure.code !== Err.RATE_LIMIT
          && failure.code !== Err.OVERLOADED
          && !sharedEgressNetwork
          && (failure.code === Err.NETWORK
            || failure.code === Err.AUTH)
        if (rotateAway && account) this.deps.pool?.advanceAccount(account.id, family)
        // Only authoritative auth states may flag an account: the old
        // /auth/i substring matched "oauth2.googleapis.com … i/o timeout"
        // transport noise and quarantined healthy accounts until a manual
        // quota refresh disproved the flag. NETWORK is not AUTH, and
        // shouldMarkAuthRequired additionally exempts transport-shaped text.
        if (account && shouldMarkAuthRequired(failure.code, failure.message)) {
          // Authoritative OAuth evidence (invalid_grant, revoked…) or the
          // explicit re-login paths quarantine immediately. A bare "not signed
          // in" banner carries no such proof — it is byte-identical for a real
          // sign-out and a keyring validation that lost the network race — so
          // it needs a second independent confirmation before it may take the
          // account out of rotation.
          const authoritative = isAuthoritativeAuthError(rawErrText + ' ' + runLogText)
          if (failure.code === Err.AUTH && !authoritative) {
            this.deps.pool?.noteAuthFailure(account.id, failure.message)
          } else {
            this.deps.pool?.markAuthRequired(account.id, failure.message)
          }
        }
        // A conversation only becomes unusable when the login died or agy
        // itself rejected the id. Rate limits / overload / transport blips do
        // NOT invalidate it: deleting the binding there threw away a resumable
        // native conversation (and its tool history) for a 15-minute cooldown,
        // forcing a fresh 660K-char digest seed on the next turn.
        const staleConversation =
          failure.code === Err.AUTH ||
          (failure.message !== '' && /conversation.*(not found|invalid|not recognized|expired|does not exist)|session.*(expired|invalid)/i.test(failure.message))
        // The run was cut mid-flight (Stop button / steer preemption / idle
        // watchdog) or aborted before it finished. agy's server-side turn has
        // no finalized reply, so the NEXT prompt must say so explicitly —
        // otherwise the model treats the interrupted user turn as the live
        // question and answers it instead of the newest message (the "latest
        // input ignored" bug, reproduced from session-c65a826e turns 17→19).
        const interruptedTurn = failure.kind === 'aborted' || outcome.timedOut === true
        if (!isAux && sessionAccountKey !== '' && staleConversation) {
          // If auth expired or conversation rejected, drop stale binding
          this.deps.store.delete(sessionAccountKey)
        } else if (!isAux && sessionAccountKey !== '' && !superseded) {
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
              // Images are only "delivered" when the run actually consumed
              // them. A killed run used to mark its staged screenshots as sent,
              // so re-sending the same image after a Stop was silently deduped
              // away and an image-only follow-up died with "request carries no
              // user text or images".
              sentImageIds: mergeSentImageIds(binding?.sentImageIds, []),
              ...((interruptedTurn || binding?.interrupted === true) ? { interrupted: true } : {}),
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
        tokenSpeed: rec.speedStats(),
      })
    })().catch((err) => {
      releaseOnce()
      rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
    })

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
    yield* this.driveSpan(rec, 0, !isAux && hasToolSupport, isCodeMode, goalContext, supportsGoalUpdate, supportsPlanExit, options.signal)
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
    goalContext?: GoalContext | null,
    supportsGoalUpdate?: boolean,
    supportsPlanExit?: boolean,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    if (signal?.aborted) {
      rec.requestAbort?.()
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted by caller' } },
      }
      return
    }
    // A span can wait hours for a wedged agy tool step. Pin the recording for
    // its whole lifetime so the shared registry can never evict a run whose
    // mirror calls are still queued behind that cut, and refresh its recency
    // on the way out so the agy_tool dispatch that follows the final cut
    // still resolves (flash-blast incident, 2026-10-10).
    this.deps.runs.remember(rec)
    this.deps.runs.pin(rec.runId)
    try {
      yield* this.driveSpanBody(rec, from, cutOnTool, useCodeWrapper, goalContext, supportsGoalUpdate, supportsPlanExit, signal)
    } finally {
      this.deps.runs.unpin(rec.runId)
      this.deps.runs.remember(rec)
    }
  }

  /** Body of {@link driveSpan}: map recorded events until the span finishes. */
  private async *driveSpanBody(
    rec: RunRecording,
    from: number,
    cutOnTool: boolean,
    useCodeWrapper: boolean,
    goalContext?: GoalContext | null,
    supportsGoalUpdate?: boolean,
    supportsPlanExit?: boolean,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const queue = new ChunkQueue()
    let abortedLocally = false
    const onAbort = () => {
      abortedLocally = true
      rec.requestAbort?.()
      queue.push({
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted by caller' } },
      })
      queue.close()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

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
        mediaBaseUrl: this.deps.getMediaBaseUrl?.() ?? undefined,
        goalContext,
        supportsGoalUpdate,
        supportsPlanExit,
      })
      let i = from
      try {
        for await (const ev of rec.eventsFrom(from)) {
          if (abortedLocally || signal?.aborted) break
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
                  await new Promise((r) => setTimeout(r, 60))
                  th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
                  if (th === null) {
                    await new Promise((r) => setTimeout(r, 100))
                    th = await readStepThoughts(activeConvId, stepIdx, rec.accountHome)
                  }
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
          if (mapper.isFinished) {
            // Remember where the span stopped so a duplicate-debounce rescue
            // can re-drive this recording from exactly the cut point without
            // a parseable mirror callId (see RunRecording.lastCutIndex).
            rec.lastCutIndex = i - 1
            break
          }
        }
        if (!mapper.isFinished && !abortedLocally && !signal?.aborted) {
          const f = rec.failureInfo
          if (f !== null) {
            for (const ch of mapper.emitFailure(f.kind, f.code, f.message, f.retryAfterMs)) queue.push(ch)
          } else {
            for (const ch of mapper.emitFailure('error', Err.INVALID_OUTPUT, 'agy stream ended without a result event')) queue.push(ch)
          }
        }
      } catch (err) {
        if (!abortedLocally && !signal?.aborted) {
          for (const ch of mapper.emitFailure('error', Err.PROCESS_EXIT, 'internal error: ' + brief(String(err)))) queue.push(ch)
        }
      }
      queue.close()
    })()
    try {
      yield* queue.drain()
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
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
