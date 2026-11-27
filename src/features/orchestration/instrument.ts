// What the ACP transport has to tell the orchestration ledger, in one place.
//
// run-attempt.ts owns exactly one thing: driving agy through the turn. Every
// hook below appears there as a single line, so the transport stays readable and
// the ledger logic can be tested without spawning a process.
//
// The hooks are deliberately thin wrappers: `usage_update`, `plan`,
// `current_mode_update` and `session_info_update` are the session updates the
// event mapper drops (they carry no assistant text), and they are precisely the
// orchestration signal.

import { parseChecklistSteps } from '../../common/checklist.ts'
import type { AgyEvent, RawUsage } from '../../common/types/events.ts'
import { backgroundLogOf } from '../subagent/task-activity.ts';
import { readModeUpdate, readPlanUpdate, readSessionInfoTitle, readToolPlan, readUsageWindow } from './acp-updates.ts'

/** One ACP `session/update` payload, as the transport hands it over. */
type AcpUpdate = Record<string, unknown>
import { attachOrchestration, type OrchestrationLedger } from './live.ts'

/** One turn's transport-to-ledger wiring. */
export interface TurnInstrumentation {
  /** The ledger for this turn, or null on auxiliary calls. */
  readonly ledger: OrchestrationLedger | null
  /** Mark the turn live again (the ledger keeps the previous turn's data). */
  resume(): void
  /**
   * Append one transport event to the transcript.
   *
   * Detached background-task logs are NOT conversation content: agy tails them
   * 20 lines at a time, and appending them as steps used to fill the reasoning
   * block with `[后台任务 · task-4] …` lines and — worse — cut the assistant's
   * text block at every burst, which split its Markdown mid-sentence. They go
   * to the ledger, where the panel renders them as a task list.
   */
  onEvent(ev: AgyEvent): void
  /** Read the session updates that only the orchestration page cares about. */
  noteUpdate(update: AcpUpdate): void
  /** Stamp one tool step with its seat and feed plan/checklist updates. */
  noteStep(ev: AgyEvent, update: AcpUpdate): void
  /** Fold one transcript.jsonl usage sample (which carries the seat's model). */
  noteTranscriptSample(sample: { model?: string; usage: RawUsage }): void
  /** Freeze the snapshot for the round; the page keeps the last turn readable. */
  settle(): void
}

export interface InstrumentTurnOptions {
  isAux: boolean
  sessionKey: string
  conversationId: string
  /** Model driving this turn; stamped onto tool steps for seat attribution. */
  activeModel: string
  append: (ev: AgyEvent) => void
  /** Learn the model's real context window from `usage_update.size` (feature #2). */
  learnWindow: (model: string, size: number | undefined) => void
}

/** Build this turn's instrumentation. Never throws: attribution is cosmetic. */
export function instrumentTurn(opts: InstrumentTurnOptions): TurnInstrumentation {
  const ledger = !opts.isAux && opts.sessionKey !== ''
    ? attachOrchestration(opts.sessionKey, opts.conversationId)
    : null
  return {
    ledger,
    resume() {
      ledger?.resume()
    },
    onEvent(ev) {
      const taskLog = backgroundLogOf(ev as Parameters<typeof backgroundLogOf>[0])
      if (taskLog !== null) {
        ledger?.noteBackground(taskLog.taskId, taskLog.lines, taskLog.skipped)
        return
      }
      opts.append(ev)
    },
    noteUpdate(update) {
      const window = readUsageWindow(update)
      if (window !== null) {
        // Learn the REAL window for this model, so the host's context
        // denominator stops being one global guess. Every turn, not only
        // orchestrated ones.
        opts.learnWindow(opts.activeModel, window.size)
        ledger?.noteContext(window.used, window.size)
      }
      const planEntries = readPlanUpdate(update)
      if (planEntries !== null) ledger?.notePlanEntries(planEntries)
      const modeId = readModeUpdate(update)
      if (modeId !== null) ledger?.noteMode(modeId)
      const title = readSessionInfoTitle(update)
      if (title !== null) ledger?.noteTitle(title)
    },
    noteStep(ev, update) {
      if (ledger === null || ev.kind !== 'step' || ev.stepKind !== 'tool' || ev.tool === undefined) return
      const tool = ev.tool
      const seatModel = ledger.currentModel
      if (seatModel !== '') ev.model = seatModel
      ledger.noteTool({ callId: ev.stepKey, tool: tool.name, args: tool.args, state: ev.state })
      const planText = readToolPlan(update, tool.name)
      if (planText !== null) ledger.notePlan(planText)
      if (tool.name === 'update_steps' || tool.name === 'todo_write' || tool.name === 'write_todos') {
        const args = (tool.args ?? {}) as Record<string, unknown>
        ledger.noteStepsTodos(parseChecklistSteps(args, typeof tool.output === 'string' ? tool.output : ''))
      }
    },
    noteTranscriptSample(sample) {
      ledger?.noteTranscriptSample(sample.model ?? '', sample.usage)
    },
    settle() {
      ledger?.settle()
    },
  }
}

/**
 * Append one transport event to the transcript, dropping detached task logs.
 *
 * The CLI path has no ledger, so it simply drops them (see task-activity.ts for
 * why they must not become reasoning content).
 */
export function appendConversationEvent(target: { append(ev: unknown): void }, ev: AgyEvent): void {
  if (backgroundLogOf(ev as Parameters<typeof backgroundLogOf>[0]) !== null) return
  target.append(ev)
}
/** Start a fresh orchestration turn for one DSH turn (clears the previous round). */
export function beginOrchestrationTurn(isAux: boolean, sessionKey: string, conversationId: string): void {
  if (isAux || sessionKey === '') return
  attachOrchestration(sessionKey, conversationId).beginTurn()
}
