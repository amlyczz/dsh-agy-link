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
import { toolCallIdOf } from '../provider/continuation.ts'
import { isSyntheticHarnessMessage, isToolResultMessage, textOf } from '../provider/prompt-text.ts'

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
  // (always missing -> CAS failure -> the driver queued round after round). Real
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
 * A genuine human instruction (the current turn's task). Goal-round prompts
 * (`source.kind === 'goal'`), tool results, and harness metadata are not human instructions.
 */
function isGenuineHumanMessage(m: Message): boolean {
  if (m.role !== 'user') return false
  const src = (m as unknown as { source?: { kind?: string } }).source
  if (src && typeof src === 'object' && src.kind === 'goal') return false
  if (isToolResultMessage(m)) return false
  if (isSyntheticHarnessMessage(m)) return false
  return textOf(m).trim() !== ''
}

/**
 * Detect whether the incoming request is part of a DSH <goal_round> continuation.
 * Extracts goalId, revision, round, and objective if available.
 *
 * The scan stops at the newest genuine human message: goal markers BEFORE it
 * belong to an earlier (possibly already completed) goal and must not leak into
 * this turn's request.
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
    const text = textOf(m)
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
    if (isGenuineHumanMessage(m)) break
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

/** Find the newest non-harness-metadata message in the trailing span. */
function trailingNonSyntheticMessage(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'user' && isSyntheticHarnessMessage(m)) continue
    return m
  }
  return undefined
}

/**
 * Detect whether DSH is in Plan Mode.
 *
 * DSH (`@deepseek-ai/dsh-plan-mode`) exposes `ctx.planMode` on the host AND
 * injects the `plan:policy` section ("You are in plan mode...") into
 * `options.system` (NOT `messages`). We also support the current-turn message
 * signal for tests / older hosts, while still honoring a decisive rejection
 * (`exit_plan_mode is only available in plan mode`) or an approved
 * `exit_plan_mode` result in the trailing span.
 */
export function isPlanMode(
  messages: readonly Message[],
  systemPrompt?: string,
  livePlanMode?: boolean,
): boolean {
  const trailing = trailingNonSyntheticMessage(messages)
  if (trailing) {
    const text = textOf(trailing)
    // DSH rejecting a synthesized exit_plan_mode is DECISIVE: whatever the
    // history or prompt says, this session is not planning (issue #136).
    if (/exit_plan_mode is only available in plan mode/i.test(text)) return false
    // An approved exit_plan_mode result means plan mode just exited so the
    // next step must execute the plan in the user's configured mode.
    const callId = toolCallIdOf(trailing)
    if (callId !== null && callId.startsWith('agytc-bridge-plan-') && isPlanApprovedResult(text)) {
      return false
    }
  }

  if (livePlanMode !== undefined) return livePlanMode

  if (typeof systemPrompt === 'string' && systemPrompt.includes('You are in plan mode')) {
    return true
  }

  const last = messages[messages.length - 1]
  if (!last) return false
  if (last.role !== 'user' && last.role !== 'system') return false
  return textOf(last).includes('You are in plan mode')
}

function isPlanApprovedResult(text: string): boolean {
  return /"approved"\s*:\s*true\b/i.test(text) || /plan approved\b/i.test(text)
}

function isPlanDismissedResult(text: string): boolean {
  return /"approved"\s*:\s*false\b/i.test(text) || /plan review(?: was)? dismissed|dismissed the plan/i.test(text)
}

/**
 * Check if the trailing span represents completion of a bridge-emitted `update_goal` call.
 * This covers both the direct tool-result message and DSH's deferred `<goal_complete>` /
 * `<goal_blocked>` wrap-up notice.
 */
export function isGoalToolContinuation(messages: readonly Message[]): boolean {
  if (messages.length === 0) return false
  const spanStart = Math.max(0, messages.length - 8)
  for (let i = messages.length - 1; i >= spanStart; i--) {
    const m = messages[i]
    if (!m) continue
    const callId = toolCallIdOf(m)
    if (callId !== null && callId.startsWith('agytc-bridge-goal-')) {
      return true
    }
    const src = (m as unknown as { source?: { kind?: string } }).source
    if (src && typeof src === 'object' && src.kind === 'tool-goal') {
      return true
    }
    // A `<goal_round>` AFTER the previous completion starts a new goal (a
    // second /goal with no chat message in between): scanning past it matched
    // the previous goal's completion and short-circuited the new goal's first
    // rounds as empty turns (issue #233).
    if (src && typeof src === 'object' && src.kind === 'goal') {
      return false
    }
    const text = textOf(m)
    // Only a user-role message can be DSH's deferred notice; a tool result or an
    // assistant transcript merely *quoting* the marker must not short-circuit.
    if (m.role === 'user' && (text.includes('<goal_complete>') || text.includes('<goal_blocked>'))) {
      return true
    }
    // A genuine user message with no marker ends the scan: the completion hop
    // is over — whatever the user said must be driven normally.
    if (isGenuineHumanMessage(m)) {
      return false
    }
  }
  return false
}

/** How a host tool can be reached from a model-facing tool call in this deployment. */
export type HostToolAccess = 'direct' | 'run_code' | 'unavailable'

/**
 * What the event mapper receives: `false` when the tool cannot be reached at
 * all, `true` / `'direct'` for a direct call, `'run_code'` under PTC.
 */
export type HostToolSupport = boolean | Exclude<HostToolAccess, 'unavailable'>

/**
 * True when the PTC tools SDK names `toolName` (issue #233).
 *
 * DSH's PTC preset exposes ONE direct tool, `run_code`; everything else is
 * declared in the TypeScript SDK it renders into the system prompt
 * (`renderToolsSdk`), where every tool is a key of `interface ToolArgsMap`.
 * Looking for the key inside that block — and only there — is what keeps a
 * tool that the prompt merely MENTIONS from counting as available.
 */
export function sdkDeclaresTool(system: string | undefined, toolName: string): boolean {
  if (!system || toolName === '') return false
  const open = system.indexOf('interface ToolArgsMap {')
  if (open < 0) return false
  const end = system.indexOf('\n}', open)
  const body = end < 0 ? system.slice(open) : system.slice(open, end)
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*(?:${escaped}|"${escaped}")\\s*:`, 'm').test(body)
}

/**
 * Decide how the bridge may call a host tool.
 *
 * `direct` when the tool is in the model-facing list. `run_code` when it is
 * not, but the list is PTC's (`run_code` without the `agy_tool` mirror) and
 * the tools SDK declares it: the call then has to travel inside a program.
 * Otherwise `unavailable` — calling anyway would be rejected by the PTC
 * executor ("only run_code is callable directly").
 */
export function resolveHostToolAccess(
  toolName: string,
  tools: readonly { name: string }[] | undefined,
  system: string | undefined,
): HostToolAccess {
  const names = new Set((tools ?? []).map((t) => t.name))
  if (names.has(toolName)) return 'direct'
  if (names.has('run_code') && !names.has('agy_tool') && sdkDeclaresTool(system, toolName)) return 'run_code'
  return 'unavailable'
}

export type PlanToolContinuation = 'none' | 'dismissed' | 'continue'

/**
 * Classify whether the trailing span is a tool result from a bridge-emitted
 * `exit_plan_mode` call:
 * - `'dismissed'`: user cancelled the plan review -> short-circuit cleanly.
 * - `'continue'`: user approved (must carry out the plan) or asked to keep
 *   planning (must revise the plan with feedback) -> drive agy normally.
 * - `'none'`: not a bridge `exit_plan_mode` continuation.
 */
export function classifyPlanToolContinuation(messages: readonly Message[]): PlanToolContinuation {
  const trailing = trailingNonSyntheticMessage(messages)
  if (!trailing) return 'none'
  const callId = toolCallIdOf(trailing)
  if (callId === null || !callId.startsWith('agytc-bridge-plan-')) return 'none'
  return isPlanDismissedResult(textOf(trailing)) ? 'dismissed' : 'continue'
}

/**
 * Check if the trailing message is the tool result of a bridge-emitted `exit_plan_mode` call.
 */
export function isPlanToolContinuation(messages: readonly Message[]): boolean {
  return classifyPlanToolContinuation(messages) !== 'none'
}

// Monotonic per-process counter used together with Date.now() to keep every
// synthetic bridge call id unique (avoids `400 Duplicate 'call_id'`).
let bridgeCallSeq = 0

function nextBridgeCallId(prefix: string): ToolCallId {
  bridgeCallSeq += 1
  return toToolCallId(`${prefix}-${Date.now().toString(36)}-${bridgeCallSeq.toString(36)}`)
}

/**
 * Build the synthetic `update_goal` tool-call chunk that marks the goal complete on DSH.
 */
export function buildGoalCompleteToolCallBlock(
  goalContext: GoalContext,
  blockIdx: number,
  access: Exclude<HostToolAccess, 'unavailable'> = 'direct',
): StreamChunk[] {
  const goalId = goalContext.goalId || 'active-goal'
  const revision = goalContext.revision ?? 1
  const args = { goal_id: goalId, revision, action: 'complete' }
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        // The prefix is the continuation scan's key in BOTH shapes.
        id: nextBridgeCallId(`agytc-bridge-goal-${goalId}-${revision}`),
        ...bridgeCall('update_goal', args, access, `complete goal ${goalId}`),
      },
    },
  ]
}

/**
 * Shape of a bridge-emitted host tool call: the direct call, or a `run_code`
 * program that makes it from inside the tools SDK (issue #233).
 *
 * The program logs the call's JSON result instead of returning it: no
 * top-level `return` (a `vm-script` / `repl` host rejects it, issue #103), and
 * the result lands in the tool-result text, which is where the plan
 * continuation reads `"approved": true|false` from.
 */
function bridgeCall(
  toolName: string,
  args: Record<string, unknown>,
  access: Exclude<HostToolAccess, 'unavailable'>,
  purpose: string,
): { name: string; arguments: string } {
  if (access === 'direct') return { name: toolName, arguments: JSON.stringify(args) }
  return {
    name: 'run_code',
    arguments: JSON.stringify({
      code:
        `// dsh-agy-link bridge: ${purpose} through the tools SDK (only run_code is callable directly)\n`
        + `console.log(JSON.stringify(await tools['${toolName}'](${JSON.stringify(args)})))`,
      description: `${purpose} · ${toolName}`,
    }),
  }
}

/**
 * Build the synthetic `exit_plan_mode` tool-call chunk that presents the generated plan to DSH.
 * DSH's `exit_plan_mode` requires markdown starting with a `#` heading (`/^#\s+\S/`).
 */
export function buildPlanExitToolCallBlock(
  planMarkdown: string,
  blockIdx: number,
  access: Exclude<HostToolAccess, 'unavailable'> = 'direct',
): StreamChunk[] {
  const trimmed = planMarkdown.trim()
  const plan = trimmed === ''
    ? '# Plan Completed\n\nPlan generated and ready for review.'
    : /^#\s+\S/.test(trimmed)
      ? trimmed
      : `# Implementation Plan\n\n${trimmed}`
  return [
    { type: 'block-start', index: blockIdx, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: blockIdx,
      block: {
        type: 'tool-call',
        id: nextBridgeCallId('agytc-bridge-plan'),
        ...bridgeCall('exit_plan_mode', { plan }, access, 'present the plan for review'),
      },
    },
  ]
}
