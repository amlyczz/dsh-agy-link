// Readers for the ACP `session/update` kinds the bridge used to drop.
//
// `acpUpdateToAgyEvents` maps only text/thought/usage/tool frames; agy 1.5.x also
// emits `plan`, `current_mode_update` and `session_info_update` (they are in the
// binary's string table and appear in real sessions). They carry no assistant
// content, so instead of faking events they feed the Orchestration ledger and
// the right-sidebar 编排 page: the agent's checklist, the live mode, the title.
import type { OrchestrationTodoState } from './live.ts'

export interface AcpPlanEntry {
  text: string
  state: OrchestrationTodoState
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function todoState(raw: unknown): OrchestrationTodoState {
  const s = str(raw).trim().toLowerCase()
  if (s === 'completed' || s === 'done' || s === 'complete') return 'done'
  if (s === 'in_progress' || s === 'in-progress' || s === 'active' || s === 'running') return 'in_progress'
  return 'pending'
}

/** `plan`: the agent's own checklist (`entries[].content` + `status`). */
export function readPlanUpdate(update: Record<string, unknown>): AcpPlanEntry[] | null {
  if (update.sessionUpdate !== 'plan') return null
  const raw = update.entries ?? update.plan
  if (!Array.isArray(raw)) return null
  const out: AcpPlanEntry[] = []
  for (const item of raw) {
    const o = asObj(item)
    const text = (str(o?.content) || str(o?.text) || str(o?.title)).trim()
    if (text === '') continue
    out.push({ text, state: todoState(o?.status) })
  }
  return out.length > 0 ? out : null
}

/** `current_mode_update`: which agy mode is in force (plan / fast / …). */
export function readModeUpdate(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== 'current_mode_update') return null
  const id = (str(update.currentModeId) || str(update.modeId) || str(update.current_mode_id)).trim()
  return id === '' ? null : id
}

/** `session_info_update`: agy's own session title, when it revises it. */
export function readSessionInfoTitle(update: Record<string, unknown>): string | null {
  if (update.sessionUpdate !== 'session_info_update') return null
  const title = (str(update.title) || str(asObj(update.info)?.title)).trim()
  return title === '' ? null : title
}

/** `usage_update`: `{ used, size }` — occupancy and the REAL context window. */
export function readUsageWindow(update: Record<string, unknown>): { used?: number; size?: number } | null {
  if (update.sessionUpdate !== 'usage_update') return null
  const used = typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : undefined
  const size = typeof update.size === 'number' && Number.isFinite(update.size) ? update.size : undefined
  if (used === undefined && size === undefined) return null
  return { ...(used !== undefined ? { used } : {}), ...(size !== undefined ? { size } : {}) }
}

/**
 * The planner's plan text from an agy `exit_plan_mode` tool call: the plan rides
 * in the call's own arguments (`{ plan: "# Goal…" }`), which ACP delivers as
 * `rawInput` once the call completes.
 */
export function readToolPlan(update: Record<string, unknown>, toolName: string): string | null {
  if (toolName !== 'exit_plan_mode' && toolName !== 'exit_plan') return null
  const input = asObj(update.rawInput) ?? asObj(update.args)
  if (input === null) return null
  const plan = input.plan ?? input.Plan ?? input.text ?? input.markdown
  const text = str(plan).trim()
  return text === '' ? null : text
}