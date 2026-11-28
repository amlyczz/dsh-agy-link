// Tool-card seat badges: `(run, step)` → which seat (planner / executor) ran it.
//
// The host resolves the attribution while a step is replayed (its recording knows
// which model was driving then); the card only knows its own `{ run, step }`
// arguments, so this fetches the run's small table once and shares it between
// every card in the transcript.
//
// Deliberately React-free: the tool-card modules run under plain ESM in tests,
// where `require('react')` does not exist. Cards subscribe with their own lazy
// `react()` handle (see toolview/runtime.ts).
import { getJson } from '../api.ts'
import type { ToolSeatEntry, ToolSeatsResponse } from './types.ts'

const runs = new Map<string, Record<string, ToolSeatEntry>>()
const fetchedAt = new Map<string, number>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
/** A live turn keeps adding steps; refetch this often while a card misses. */
const REFETCH_MS = 3000
/**
 * Tables kept in memory: the same number of runs the host keeps attribution
 * for (`MAX_RUNS` in features/orchestration/tool-seats.ts). A long session runs
 * hundreds of turns, and an older table could never be refreshed anyway; an
 * evicted run is simply fetched again when one of its cards asks.
 */
const MAX_CACHED_RUNS = 16

function emit(): void {
  for (const listener of listeners) listener()
}

function fetchRun(run: string): void {
  if (run === '' || inFlight.has(run)) return
  inFlight.add(run)
  void (async () => {
    try {
      const res = await getJson<ToolSeatsResponse>(`/plugins/agy-link/tool-seats?run=${encodeURIComponent(run)}`)
      if (res !== null && res.seats !== undefined) {
        runs.set(run, res.seats)
        fetchedAt.set(run, Date.now())
        while (runs.size > MAX_CACHED_RUNS) {
          const oldest = runs.keys().next().value
          if (oldest === undefined) break
          runs.delete(oldest)
          fetchedAt.delete(oldest)
        }
        emit()
      }
    } catch {
      // Badges are cosmetic; a missed fetch only means no chip on the card.
    } finally {
      inFlight.delete(run)
    }
  })()
}

/**
 * The seat entry for one card, fetching the run's table on first use.
 * @param run - mirror run id from the card's arguments; `''` when absent.
 * @param step - agy step index; `-1` when absent.
 */
export function toolSeatFor(run: string, step: number): ToolSeatEntry | undefined {
  if (run === '' || step < 0) return undefined
  const table = runs.get(run)
  const entry = table?.[String(step)]
  if (entry !== undefined) return entry
  if (table === undefined) {
    fetchRun(run)
    return undefined
  }
  const at = fetchedAt.get(run) ?? 0
  if (Date.now() - at > REFETCH_MS) fetchRun(run)
  return undefined
}

/** Subscribe to any table update (cards re-render their badge). */
export function subscribeToolSeats(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop every cached table. */
export function resetToolSeatsClientForTests(): void {
  runs.clear()
  fetchedAt.clear()
  inFlight.clear()
  listeners.clear()
}