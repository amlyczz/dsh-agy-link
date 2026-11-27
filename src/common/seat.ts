// Which Antigravity seat produced one step.
//
// An Orchestrator session runs TWO seats inside one agy conversation: the
// planner (`gemini-pro-orchestrator*`, decided by Antigravity) hands a plan to
// an executor that does the work. To DSH the whole thing used to look like one
// model talking, so `agy`'s per-step `model` from
// `<brain>/.system_generated/logs/transcript.jsonl` is the only evidence of who
// ran what. Pure string logic, shared by the host (ledger, presenters) and the
// client (card badges), so both name the same seat.

/** One seat of an agy run. */
export type SeatRole = 'planner' | 'executor' | 'unknown'

/**
 * True for the Orchestrator role slugs — `gemini-pro-orchestrator`,
 * `gemini-pro-orchestrator-neon`, `-carbon`, `-argon`, `-g1-pro`. Antigravity
 * decides who plays the planner; any other model in the same conversation is
 * the executor it dispatched to.
 */
export function isPlannerModel(model: string): boolean {
  return /orchestrator/i.test(model)
}

/** Seat that ran one agy model. */
export function seatForModel(model: string): SeatRole {
  const id = model.trim()
  if (id === '') return 'unknown'
  return isPlannerModel(id) ? 'planner' : 'executor'
}

/**
 * Short model name for a chip: `gemini-pro-orchestrator-neon` → `orchestrator
 * neon`, `gemini-flash-worker-agy` → `flash worker`, `gemini-4-hydrogen` →
 * `hydrogen`. Only the family matters on a card; the full id stays in the
 * tooltip.
 */
export function shortModelName(model: string): string {
  const id = model.trim().toLowerCase()
  if (id === '') return ''
  return id
    .replace(/^gemini-/, '')
    .replace(/-agy$/, '')
    .replace(/^pro-orchestrator-?/, 'orchestrator ')
    .replace(/-/g, ' ')
    .trim()
}