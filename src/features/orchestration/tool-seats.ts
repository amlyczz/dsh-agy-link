// (run, step) → which seat ran that agy tool step.
//
// The client's tool cards only know `{ run, step }` from their arguments; the
// seat attribution lives here on the host, where the run recording knows which
// model was driving when that step arrived. The panel reads it through the
// orchestration snapshot; the cards read it through `/tool-seats`.

import type { RawUsage } from '../../common/types.ts'
import { seatForModel, shortModelName, type SeatRole } from '../../common/seat.ts'

export interface ToolSeatEntry {
  seat: SeatRole
  model?: string
  short?: string
  tool: string
  at: number
}

/** Runs kept at once (LRU); a DSH session normally has one or two. */
const MAX_RUNS = 16
/** Steps kept per run: a long turn can mirror hundreds. */
const MAX_STEPS_PER_RUN = 4000

const byRun = new Map<string, Map<number, ToolSeatEntry>>()

function touch(runId: string): Map<number, ToolSeatEntry> {
  let steps = byRun.get(runId)
  if (steps === undefined) steps = new Map<number, ToolSeatEntry>()
  else byRun.delete(runId)
  byRun.set(runId, steps)
  while (byRun.size > MAX_RUNS) {
    const oldest = byRun.keys().next()
    if (oldest.done === true) break
    byRun.delete(oldest.value)
  }
  return steps
}

/** Record the model that drove one replayed agy step. */
export function noteToolSeat(runId: string, step: number, tool: string, model: string, usage?: RawUsage): void {
  if (runId === '') return
  const steps = touch(runId)
  void usage
  const clean = typeof model === 'string' ? model.trim() : ''
  steps.set(step, {
    seat: seatForModel(clean),
    ...(clean !== '' ? { model: clean, short: shortModelName(clean) } : {}),
    tool,
    at: Date.now(),
  })
  while (steps.size > MAX_STEPS_PER_RUN) {
    const oldest = steps.keys().next()
    if (oldest.done === true) break
    steps.delete(oldest.value)
  }
}

/** The whole table for one run, shaped for JSON. */
export function toolSeatsForRun(runId: string): Record<string, ToolSeatEntry> {
  const steps = byRun.get(runId)
  if (steps === undefined) return {}
  const out: Record<string, ToolSeatEntry> = {}
  for (const [step, entry] of steps) out[String(step)] = entry
  return out
}

/** Test-only. */
export function resetToolSeatsForTests(): void {
  byRun.clear()
}

/**
 * Record the seat for one step of a recorded run, reading the model the
 * recorder stamped on the event when it arrived.
 *
 * Attribution is cosmetic, so anything unexpected (a missing event, a step
 * that never got a model) must stay quiet rather than fail the tool call.
 */
export function noteToolSeatFromRecording(
  rec: { runId: string; eventAt(step: number): unknown },
  step: number,
  tool: string,
): void {
  try {
    const ev = rec.eventAt(step) as { model?: string } | undefined
    noteToolSeat(rec.runId, step, tool, typeof ev?.model === 'string' ? ev.model : '')
  } catch {
    // cosmetic only
  }
}
