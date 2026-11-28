// How the bridge calls DSH host tools on agy's behalf.
//
// Three bridges exist — `update_goal` and `exit_plan_mode` (dsh-goal.ts) and
// `ask_user_question` (dsh-ask.ts) — and they share two questions, answered
// here once: CAN a host tool be reached in this deployment, and WHAT does the
// call look like when it can.
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as dshLlm from '@deepseek-ai/dsh-llm'

export const toToolCallId: (id: string) => ToolCallId =
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).ToolCallId ??
  (dshLlm as { ToolCallId?: (id: string) => ToolCallId; CallId?: (id: string) => ToolCallId }).CallId ??
  ((id: string) => id as unknown as ToolCallId)

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

/** A reachable host tool: never `unavailable`, never bare `true`. */
export type ExcludeUnavailable = 'direct' | 'run_code'

/**
 * The host tools one span may call for agy, in the shape the event mapper
 * takes them (`false` = do not synthesise).
 */
export interface BridgeToolSupport {
  /** `update_goal`: completes the active goal when agy finishes a goal round. */
  goalUpdate: HostToolSupport
  /** `exit_plan_mode`: presents the plan when agy finishes a plan-mode turn. */
  planExit: HostToolSupport
  /** `ask_user_question`: presents agy's `ask_question` as the native question card. */
  askUser: HostToolSupport
}

/**
 * Resolve every bridge at once. `planActive` is the caller's: plan mode is a
 * property of the turn (policy, live mode, trailing approval), not of the tool
 * list, so `exit_plan_mode` stays off unless the turn is actually planning.
 */
export function resolveBridgeToolSupport(
  tools: readonly { name: string }[] | undefined,
  system: string | undefined,
  planActive: boolean,
): BridgeToolSupport {
  const goalUpdate = resolveHostToolAccess('update_goal', tools, system)
  const planExit = resolveHostToolAccess('exit_plan_mode', tools, system)
  const askUser = resolveHostToolAccess('ask_user_question', tools, system)
  return {
    goalUpdate: goalUpdate === 'unavailable' ? false : goalUpdate,
    planExit: !planActive || planExit === 'unavailable' ? false : planExit,
    askUser: askUser === 'unavailable' ? false : askUser,
  }
}

// Monotonic per-process counter used together with Date.now() to keep every
// synthetic bridge call id unique (avoids `400 Duplicate 'call_id'`).
let bridgeCallSeq = 0

export function nextBridgeCallId(prefix: string): ToolCallId {
  bridgeCallSeq += 1
  return toToolCallId(`${prefix}-${Date.now().toString(36)}-${bridgeCallSeq.toString(36)}`)
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
export function bridgeCall(
  toolName: string,
  args: Record<string, unknown>,
  access: ExcludeUnavailable,
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

