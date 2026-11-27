// Live Orchestration ledger: who planned, who executed, what ran, and how much
// each seat cost.
//
// An agy Orchestrator session runs a planner seat and an executor seat inside
// ONE conversation, so DSH's own model/usage reporting cannot separate them: it
// sees one model and one usage envelope. agy writes the truth per step —
// `model` + token counters on each `PLANNER_RESPONSE` in
// `<brain>/.system_generated/logs/transcript.jsonl`, and a `plan`/mode/title
// sessionUpdate over ACP — so this ledger aggregates both streams per DSH
// session and the client renders the right-sidebar 编排 page from it.
//
// Keyed by DSH session id (same convention as features/subagent/live.ts) so two
// sessions sharing one account never see each other's seats.
import type { RawUsage } from '../../common/types.ts'
import type { ChecklistStepItem } from '../../common/checklist.ts'
import { seatForModel, shortModelName, type SeatRole } from '../../common/seat.ts'
import { toolStepBrief } from '../../provider/mirror/brief.ts'
import { snapshotSessionSubagents, type SubagentSnapshotItem } from '../subagent/live.ts'

/** Tool steps kept for the panel's flow list; older ones fall off. */
const MAX_STEPS = 120
/** Sessions whose last turn stays readable after it settled. */
const MAX_SESSIONS = 8
/** Planner plans can be long; the panel shows a summary and a full-text toggle. */
const MAX_PLAN_CHARS = 12_000
/** Keep tool one-liners short enough for a single row. */
const MAX_BRIEF_CHARS = 120

export type OrchestrationTodoState = 'pending' | 'in_progress' | 'done'

export type OrchestrationStepState = 'ACTIVE' | 'DONE' | 'ERROR' | 'CANCELED'

/** Normalize a transport-reported tool state (ACP pending/completed/… or agy ACTIVE/DONE). */
function stepState(raw: unknown): OrchestrationStepState {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  if (s === '' || s === 'ACTIVE' || s === 'PENDING' || s === 'IN_PROGRESS' || s === 'RUNNING') return 'ACTIVE'
  if (s === 'ERROR' || s === 'FAILED' || s === 'FAILURE') return 'ERROR'
  if (s === 'CANCELED' || s === 'CANCELLED') return 'CANCELED'
  return 'DONE'
}

export interface OrchestrationTodo {
  text: string
  state: OrchestrationTodoState
}

export interface OrchestrationSeat {
  role: SeatRole
  model: string
  /** Short chip name (`hydrogen`, `orchestrator neon`). */
  short: string
  /** Completed calls attributed to this seat in the current turn. */
  calls: number
  /** Prompt-side tokens of the LAST call: what that seat just read. */
  contextTokens?: number
  /** Cached prompt tokens of the last call (subset of contextTokens). */
  cacheReadTokens?: number
  /** Turn sums. */
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
  state: OrchestrationStepState
  startedAt: number
  endedAt?: number
}

export interface OrchestrationContext {
  /** agy's `usage_update.used`: context occupancy it reported. */
  used?: number
  /** agy's `usage_update.size`: the model's REAL window. */
  size?: number
  at: number
}

export interface OrchestrationSnapshot {
  session: string
  conversationId: string
  /** True while a turn is streaming on this session. */
  live: boolean
  seats: OrchestrationSeat[]
  steps: OrchestrationStep[]
  todos: OrchestrationTodo[]
  plan?: { text: string; at: number }
  mode?: string
  title?: string
  context: OrchestrationContext
  subagents: SubagentSnapshotItem[]
  updatedAt: number
}

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function briefFor(tool: string, args: unknown): string {
  if (tool === '') return ''
  try {
    const s = toolStepBrief(tool, args)
    return s.length > MAX_BRIEF_CHARS ? s.slice(0, MAX_BRIEF_CHARS) + '…' : s
  } catch {
    return tool
  }
}

/** One session's orchestration state for the current turn. */
export class OrchestrationLedger {
  private readonly seats = new Map<string, OrchestrationSeat>()
  private readonly steps: OrchestrationStep[] = []
  private readonly openSteps = new Map<string, OrchestrationStep>()
  private seq = 0
  private todos: OrchestrationTodo[] = []
  private plan?: { text: string; at: number }
  private mode: string | undefined
  private title: string | undefined
  private context: OrchestrationContext = { at: 0 }
  private lastModel = ''
  private touchedAt = Date.now()
  live = false

  constructor(readonly session: string, public conversationId: string) {}

  /** Reset everything a new turn must not inherit (seats/steps/sums). */
  beginTurn(): void {
    this.seats.clear()
    this.steps.length = 0
    this.openSteps.clear()
    this.todos = []
    this.plan = undefined
    this.seq = 0
    this.lastModel = ''
    this.live = true
    this.touch()
  }

  /** A further prompt on the same turn (self-heal, continuation) keeps it live. */
  resume(): void {
    this.live = true
    this.touch()
  }

  /** The turn is over: keep the last turn readable, stop calling it live. */
  settle(): void {
    for (const step of this.openSteps.values()) step.state = 'DONE'
    this.openSteps.clear()
    this.live = false
    this.touch()
  }

  private touch(): void {
    this.touchedAt = Date.now()
  }

  get idleSince(): number {
    return this.touchedAt
  }

  private seatFor(model: string, at: number): OrchestrationSeat {
    const role = seatForModel(model)
    const key = model === '' ? role : model
    let seat = this.seats.get(key)
    if (seat === undefined) {
      seat = {
        role,
        model,
        short: shortModelName(model) || role,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastAt: at,
      }
      this.seats.set(key, seat)
    }
    return seat
  }

  /**
   * One `PLANNER_RESPONSE` from the transcript: the model that ran it, and its
   * per-call counters. This is the ONLY place the seat split comes from.
   */
  noteTranscriptSample(model: string, usage: RawUsage): void {
    const at = Date.now()
    if (model !== '') this.lastModel = model
    if (model === '') return
    const seat = this.seatFor(model, at)
    seat.calls += 1
    seat.lastAt = at
    const input = numOf(usage.input_tokens) ?? 0
    const cacheRead = numOf(usage.cache_read_tokens) ?? 0
    const output = numOf(usage.output_tokens) ?? 0
    seat.inputTokens += input
    seat.outputTokens += output
    if (input > 0 || cacheRead > 0) seat.contextTokens = input + cacheRead
    if (cacheRead > 0) seat.cacheReadTokens = cacheRead
    this.touch()
  }

  /** Model currently driving the conversation (last sampled planner response). */
  get currentModel(): string {
    return this.lastModel
  }

  noteContext(used: number | undefined, size: number | undefined): void {
    if (used === undefined && size === undefined) return
    this.context = {
      ...(used !== undefined ? { used } : this.context.used !== undefined ? { used: this.context.used } : {}),
      ...(size !== undefined ? { size } : this.context.size !== undefined ? { size: this.context.size } : {}),
      at: Date.now(),
    }
    this.touch()
  }

  /** One ACP `tool_call` / `tool_call_update`, keyed by its toolCallId. */
  noteTool(input: {
    callId: string
    tool: string
    args?: unknown
    /** agy step state as reported by the transport; missing means "started". */
    state?: string
    at?: number
  }): void {
    const at = input.at ?? Date.now()
    const state = stepState(input.state)
    const existing = this.openSteps.get(input.callId)
    if (existing !== undefined) {
      existing.state = state
      if (state !== 'ACTIVE') {
        existing.endedAt = at
        this.openSteps.delete(input.callId)
      }
      if (input.tool !== '') existing.tool = input.tool
      this.touch()
      return
    }
    const step: OrchestrationStep = {
      seq: ++this.seq,
      tool: input.tool,
      brief: briefFor(input.tool, input.args),
      seat: seatForModel(this.lastModel),
      ...(this.lastModel !== '' ? { model: this.lastModel } : {}),
      state,
      startedAt: at,
      ...(state !== 'ACTIVE' ? { endedAt: at } : {}),
    }
    this.steps.push(step)
    if (step.state === 'ACTIVE') this.openSteps.set(input.callId, step)
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS)
    this.touch()
  }

  /** ACP `plan` sessionUpdate: the agent's own checklist. */
  notePlanEntries(entries: Array<{ text: string; state: OrchestrationTodoState }>): void {
    if (entries.length === 0) return
    this.todos = entries
    this.touch()
  }

  /** agy's `update_steps` tool arguments/result checklist. */
  noteStepsTodos(items: readonly ChecklistStepItem[]): void {
    if (items.length === 0) return
    this.todos = items.map((it) => ({
      text: it.title,
      state: it.status === 'done' ? 'done' : it.status === 'in_progress' ? 'in_progress' : 'pending',
    }))
    this.touch()
  }

  /** The planner's plan text (agy `exit_plan_mode`, or a `plan` update body). */
  notePlan(text: string): void {
    const body = text.trim()
    if (body === '') return
    this.plan = {
      text: body.length > MAX_PLAN_CHARS ? body.slice(0, MAX_PLAN_CHARS) + '\n\n…' : body,
      at: Date.now(),
    }
    this.touch()
  }

  noteMode(modeId: string): void {
    if (modeId.trim() === '') return
    this.mode = modeId.trim()
    this.touch()
  }

  noteTitle(title: string): void {
    if (title.trim() === '') return
    this.title = title.trim()
    this.touch()
  }

  snapshot(): OrchestrationSnapshot {
    return {
      session: this.session,
      conversationId: this.conversationId,
      live: this.live,
      seats: [...this.seats.values()].sort((a, b) => a.role.localeCompare(b.role)),
      steps: [...this.steps],
      todos: [...this.todos],
      ...(this.plan !== undefined ? { plan: { ...this.plan } } : {}),
      ...(this.mode !== undefined ? { mode: this.mode } : {}),
      ...(this.title !== undefined ? { title: this.title } : {}),
      context: { ...this.context },
      subagents: snapshotSessionSubagents(this.session),
      updatedAt: this.touchedAt,
    }
  }
}

const ledgers = new Map<string, OrchestrationLedger>()

/** Get (or create) the ledger a turn reports into. */
export function attachOrchestration(sessionKey: string, conversationId: string): OrchestrationLedger {
  if (sessionKey === '') return new OrchestrationLedger('', conversationId)
  let ledger = ledgers.get(sessionKey)
  if (ledger === undefined) {
    ledger = new OrchestrationLedger(sessionKey, conversationId)
    ledgers.set(sessionKey, ledger)
  } else {
    // A resumed/continued conversation can carry a different id than the first
    // attempt of this DSH session; the newest one is what the DB lookups need.
    if (conversationId !== '') ledger.conversationId = conversationId
    // Refresh LRU position.
    ledgers.delete(sessionKey)
    ledgers.set(sessionKey, ledger)
  }
  while (ledgers.size > MAX_SESSIONS) {
    const oldest = ledgers.keys().next()
    if (oldest.done === true) break
    if (oldest.value === sessionKey) break
    ledgers.delete(oldest.value)
  }
  return ledger
}

/** A settled session keeps its ledger; only process exit drops it. */
export function detachOrchestration(ledger: OrchestrationLedger): void {
  ledger.settle()
}

/** Panel read path: one session's orchestration state. */
export function snapshotOrchestration(session: string): OrchestrationSnapshot | null {
  const ledger = ledgers.get(session)
  return ledger === undefined ? null : ledger.snapshot()
}

/** Every session that has produced at least one seat (diagnostics / tests). */
export function orchestrationSessions(): string[] {
  return [...ledgers.keys()]
}

/** Test-only: drop all ledgers between cases. */
export function resetOrchestrationForTests(): void {
  ledgers.clear()
}
