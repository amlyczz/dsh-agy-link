// Browser-side shape of the host's orchestration snapshot.
//
// Mirrors `src/features/orchestration/live.ts` (which the browser cannot import:
// it reaches into the host's subagent registry). Keep the two in step — the
// panel is a pure projection of this document.

export type SeatRole = 'planner' | 'executor' | 'unknown'

export interface OrchestrationSeat {
  role: SeatRole
  model: string
  short: string
  calls: number
  contextTokens?: number
  cacheReadTokens?: number
  inputTokens: number
  outputTokens: number
  lastAt: number
}

export interface OrchestrationStep {
  seq: number
  tool: string
  brief: string
  seat: SeatRole
  model?: string
  state: 'ACTIVE' | 'DONE' | 'ERROR' | 'CANCELED'
  startedAt: number
  endedAt?: number
}

export interface OrchestrationTodo {
  text: string
  state: 'pending' | 'in_progress' | 'done'
}

export interface OrchestrationContext {
  used?: number
  size?: number
  at: number
}

export interface SubagentItem {
  conversationId: string
  role: string
  typeName: string
  state?: string
  running: boolean
  lastAction: string
  startedAt: number
  lastAt: number
}

export interface OrchestrationSnapshot {
  session: string
  conversationId: string
  live: boolean
  seats: OrchestrationSeat[]
  steps: OrchestrationStep[]
  todos: OrchestrationTodo[]
  plan?: { text: string; at: number }
  mode?: string
  title?: string
  context: OrchestrationContext
  subagents: SubagentItem[]
  updatedAt: number
}

export interface OrchestrationResponse {
  ok?: boolean
  orchestration: OrchestrationSnapshot | null
}

export interface ToolSeatEntry {
  seat: SeatRole
  model?: string
  short?: string
  tool: string
  at: number
}

export interface ToolSeatsResponse {
  ok?: boolean
  seats: Record<string, ToolSeatEntry>
}