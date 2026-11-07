// DSH Goal & Plan Protocol Bridge (ADR-14)
// Translates Google Antigravity (agy CLI) agent completions into DSH
// goal-state lifecycle transitions (update_goal / exit_plan_mode).
//
// In DSH, /goal runs a multi-round state machine (up to 256 rounds).
// The harness continues driving <goal_round> until the agent explicitly
// marks the goal complete via the `update_goal` tool. Because agy is an
// isolated agent with its own native tools (run_command, view_file, etc.),
// it never calls DSH's external host tools directly. Without this bridge,
// agy would report "Goal achieved" and exit, but DSH would consider the goal
// still active and drive Round 2, Round 3... in an infinite loop.
import type { Message, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as dshLlm from '@deepseek-ai/dsh-llm'

export const toToolCallId: (id: string) => ToolCallId =
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).ToolCallId ??
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).CallId ??
  ((id: string) => id as unknown as ToolCallId)

export interface GoalContext {
  goalId?: string
  revision?: number
  round?: number
  maxRounds?: number
  objective?: string
}

function extractText(m: Message): string {
  const content = m.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object') {
        const blk = b as { type?: string; text?: unknown }
        if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

function parseGoalRoundText(text: string): { goalId?: string; revision?: number; round?: number; maxRounds?: number; objective?: string } | null {
  if (!text.includes('<goal_round>')) return null
  const roundMatch = text.match(/Round:\s*(\d+)(?:\/(\d+))?/)
  const round = roundMatch ? parseInt(roundMatch[1]!, 10) : undefined
  const maxRounds = roundMatch && roundMatch[2] ? parseInt(roundMatch[2]!, 10) : undefined
  const objMatch = text.match(/Objective:\s*(?:"([^"]*)"|'([^']*)'|([^\n]+))/)
  const objective = objMatch ? (objMatch[1] || objMatch[2] || objMatch[3])?.trim() : undefined
  // Never guess an id from loose prose: DSH's round prompt contains the words
  // "goal-tool policy" and the token <goal_round>, so a generic /goal-[A-Za-z0-9_-]+/
  // scan once synthesized update_goal calls against the literal id "goal-tool"
  // (always missing → CAS failure → the driver queued round after round). Real
  // DSH goal ids are UUID-shaped ("goal-3fe686a1-0298-4a5a-88dd-670562821182");
  // accept only that shape or an explicit `id:`-prefixed value, and otherwise
  // leave goalId undefined so the host-side sessionGoal fallback supplies the
  // authoritative id.
  const idMatch = text.match(/goal-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
    ?? text.match(/\bid:\s*["']?([a-zA-Z0-9_-]+)["']?/)
  const goalId = idMatch ? (idMatch[1] ?? idMatch[0]) : undefined
  return { goalId, round, maxRounds, objective }
}

/**
 * Harness-injected user-role source kinds. They are metadata, not instructions,
 * and must stay transparent to the trailing-span scans.
 */
const HARNESS_USER_SOURCE_KINDS = new Set([
  'time-context',
  'skill-catalog',
  'runtime-context',
  'model-selection',
  'system-reminder',
  'dsh-session-title-llm',
  'tool-goal',
  'synthetic',
])

/** Whether this user-role message was injected by the harness, not typed by a human. */
function isHarnessInjectedMessage(m: Message): boolean {
  const src = (m as unknown as { source?: { kind?: string; form?: string } }).source
  if (!src || typeof src !== 'object') return false
  if (typeof src.kind === 'string' && HARNESS_USER_SOURCE_KINDS.has(src.kind)) return true
  return src.kind === 'plugin' && src.form === 'snapshot'
}

/**
 * A genuine human instruction (the current turn's task). Goal-round prompts
 * (`source.kind === 'goal'`) and harness metadata are not human instructions.
 */
function isGenuineUserMessage(m: Message): boolean {
  if (m.role !== 'user') return false
  const src = (m as unknown as { source?: { kind?: string } }).source
  if (src && typeof src === 'object' && src.kind === 'goal') return false
  if (isHarnessInjectedMessage(m)) return false
  const text = extractText(m)
  if (text.trim() === '') return false
  return !isHarnessInjectedUserText(text)
}

/**
 * Detect whether the incoming request is part of a DSH <goal_round> continuation.
 * Extracts goalId, revision, round, and objective if available.
 *
 * The scan stops at the newest genuine human message: goal markers BEFORE it
 * belong to an earlier (possibly already completed) goal and must not leak into
 * this turn's request. Without that stop every later turn in a session that had
 * ever run a goal re-synthesized `update_goal(complete)` for the stale goal —
 * with a deterministic call id, so the transcript accumulated identical
 * `tool_call` ids and HTTP providers rejected it with
 * `400 Duplicate 'call_id'` (2026-11-07 incident).
 */
export function detectGoalContext(messages: readonly Message[]): GoalContext | null {
  let goalId: string | undefined
  let revision: number | undefined
  let round: number | undefined
  let maxRounds: number | undefined
  let objective: string | undefined
  let isGoal = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const src = (m as unknown as { source?: { kind?: string; goalId?: unknown; revision?: unknown; round?: unknown } }).source
    if (src && typeof src === 'object' && src.kind === 'goal') {
      isGoal = true
      if (!goalId && typeof src.goalId === 'string') goalId = src.goalId
      if (revision === undefined && typeof src.revision === 'number') revision = src.revision
      if (round === undefined && typeof src.round === 'number') round = src.round
    }
    const text = extractText(m)
    if (text.includes('<goal_round>')) {
      isGoal = true
      const parsed = parseGoalRoundText(text)
      if (parsed) {
        if (!goalId && parsed.goalId) goalId = parsed.goalId
        if (revision === undefined && parsed.revision !== undefined) revision = parsed.revision
        if (round === undefined && parsed.round !== undefined) round = parsed.round
        if (maxRounds === undefined && parsed.maxRounds !== undefined) maxRounds = parsed.maxRounds
        if (!objective && parsed.objective) objective = parsed.objective
      }
    }
    // A new human instruction ends the current turn's goal span.
    if (isGenuineUserMessage(m)) break
  }

  if (isGoal) {
    return {
      goalId,
      revision: revision ?? 1,
      round,
      maxRounds,
      objective,
    }
  }
  return null
}

/** Live, authoritative goal reference from the host's goal service. */
export interface LiveGoalRef {
  goalId: string
  revision: number
}

/**
 * Resolve the goal context that a turn may complete.
 *
 * - `live === null`: the host's goal service says there is no active, armed
 *   goal — never synthesize a completion (this is what prevents stale history
 *   from marking an already-completed goal again).
 * - `live === undefined`: the live goal service is unavailable; fall back to
 *   history detection for that host.
 * - Otherwise the live view supplies the authoritative id/revision, and a
 *   completion is only emitted for a goal round — a direct human turn must not
 *   silently complete an armed goal.
 */
export function resolveGoalContext(
  messages: readonly Message[],
  live: LiveGoalRef | null | undefined,
): GoalContext | null {
  const round = detectGoalContext(messages)
  if (live === null) return null
  if (live === undefined) return round
  if (round === null) return null
  return { goalId: live.goalId, revision: live.revision }
}

/**
 * Detect whether DSH is in Plan Mode.
 * DSH plan-mode injects "You are in plan mode" into the runtime context prompt.
 */
export function isPlanMode(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    const text = extractText(m)
    if (text.includes('You are in plan mode')) return true
  }
  return false
}

/**
 * Harness-injected user-role texts (turn-preparation time samples, system
 * reminders, runtime context) are NOT user instructions: they must not break
 * the completion-hop scan, while a genuine instruction must.
 */
function isHarnessInjectedUserText(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('Time sampled while preparing') ||
    t.startsWith('Current runtime context') ||
    t.includes('<system-reminder>')
  )
}

/**
 * Check if the trailing span represents completion of a bridge-emitted `update_goal` call.
 * This covers both the direct tool-result message and DSH's deferred `<goal_complete>` notice.
 *
 * The markers only mean "synthetic completion hop" while they are the TRAILING
 * content. A genuine user message appearing before any marker is a fresh
 * instruction that must reach agy — scanning a fixed window for markers
 * "anywhere" swallowed exactly that: a message sent right after a goal
 * completed was finished as an empty turn without spawning agy
 * (2026-10-17, "把相关的经验整理到agents.md" × 2).
 */
export function isGoalToolContinuation(messages: readonly Message[]): boolean {
  if (messages.length === 0) return false
  const spanStart = Math.max(0, messages.length - 8)
  for (let i = messages.length - 1; i >= spanStart; i--) {
    const m = messages[i]
    if (!m) continue
    const callId = (m as unknown as { toolCallId?: unknown; source?: { callId?: unknown } }).toolCallId
      ?? (m as unknown as { source?: { callId?: unknown } }).source?.callId
    if (typeof callId === 'string' && callId.startsWith('agytc-bridge-goal-')) {
      return true
    }
    const src = (m as unknown as { source?: { kind?: string } }).source
    if (src && typeof src === 'object' && src.kind === 'tool-goal') {
      return true
    }
    const text = extractText(m)
    if (text.includes('<goal_complete>')) {
      return true
    }
    // A genuine user message with no marker ends the scan: the completion hop
    // is over — whatever the user said must be driven normally.
    if (m.role === 'user' && text.trim() !== '' && !isHarnessInjectedUserText(text)) {
      return false
    }
  }
  return false
}

/**
 * Check if the trailing message is the tool result of a bridge-emitted `exit_plan_mode` call.
 */
export function isPlanToolContinuation(messages: readonly Message[]): boolean {
  if (messages.length === 0) return false
  const last = messages[messages.length - 1]
  if (!last) return false
  const callId = (last as unknown as { toolCallId?: unknown; source?: { callId?: unknown } }).toolCallId
    ?? (last as unknown as { source?: { callId?: unknown } }).source?.callId
  if (typeof callId === 'string' && callId.startsWith('agytc-bridge-plan-')) {
    return true
  }
  return false
}

// Monotonic per-process counter used together with Date.now() to keep every
// synthetic completion id unique. A deterministic `goalId-revision` id meant a
// second emission (repeated turn, retry, forked transcript) produced a
// duplicate tool_call id in one request, which providers reject with
// `400 Duplicate 'call_id'` (2026-11-07 incident). The `agytc-bridge-goal-`
// prefix is part of the continuation protocol; only the suffix changes.
let goalCallSeq = 0

/** Mint a unique id for one synthetic goal-completion tool call. */
function nextGoalCallId(goalId: string, revision: number): ToolCallId {
  goalCallSeq += 1
  return toToolCallId(`agytc-bridge-goal-${goalId}-${revision}-${Date.now().toString(36)}-${goalCallSeq.toString(36)}`)
}

/**
 * Build the synthetic `update_goal` tool-call chunk that marks the goal complete on DSH.
 */
export function buildGoalCompleteToolCallBlock(goalContext: GoalContext, blockIdx: number): StreamChunk[] {
  const goalId = goalContext.goalId || 'active-goal'
  const revision = goalContext.revision ?? 1
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        id: nextGoalCallId(goalId, revision),
        name: 'update_goal',
        arguments: JSON.stringify({
          goal_id: goalId,
          revision,
          action: 'complete',
        }),
      },
    },
  ]
}

/**
 * Build the synthetic `exit_plan_mode` tool-call chunk that presents the generated plan to DSH.
 */
export function buildPlanExitToolCallBlock(planMarkdown: string, blockIdx: number): StreamChunk[] {
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        id: toToolCallId(`agytc-bridge-plan-${Date.now()}`),
        name: 'exit_plan_mode',
        arguments: JSON.stringify({
          plan: planMarkdown.trim() !== '' ? planMarkdown : '# Plan Completed\n\nPlan generated and ready for review.',
        }),
      },
    },
  ]
}
