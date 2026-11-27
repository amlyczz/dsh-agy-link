// Polling store behind the 编排 panel.
//
// One fetch per tick of `/plugins/agy-link/orchestration`, shared by everything
// on screen: the panel body and the header chip read the same snapshot, so a
// live turn costs one request per tick, not one per component.
import { getJson } from '../api.ts'
import { useEffect, useState } from '../react.ts'
import type { OrchestrationResponse, OrchestrationSnapshot } from './types.ts'

/** Fast enough to feel live while a turn streams, cheap because it is one GET. */
const LIVE_POLL_MS = 1200
const IDLE_POLL_MS = 5000
/**
 * Consecutive failed reads (no snapshot ever seen) before the page stops
 * spinning and says why. A host that predates the route answers 404 forever —
 * typically a DSH process started before the plugin was updated, so the
 * browser runs the new client against the old in-memory host bundle.
 */
export const UNAVAILABLE_AFTER_FAILURES = 3

export interface OrchestrationState {
  snapshot: OrchestrationSnapshot | null
  loaded: boolean
  /** True once the first load failed `UNAVAILABLE_AFTER_FAILURES` times in a row. */
  unavailable: boolean
}

let state: OrchestrationState = { snapshot: null, loaded: false, unavailable: false }
const listeners = new Set<() => void>()
let currentSession = ''
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let failures = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function schedule(ms: number): void {
  if (timer !== null) clearTimeout(timer)
  const handle = setTimeout(() => {
    timer = null
    void poll()
  }, ms)
  // Node timers have unref(); browser timers do not.
  ;(handle as unknown as { unref?: () => void }).unref?.()
  timer = handle
}

function noteFailure(): void {
  failures += 1
  // Keep the previous snapshot on screen: the host may be mid-restart. Only a
  // page that has never loaded turns its spinner into an explanation.
  if (state.snapshot === null && failures >= UNAVAILABLE_AFTER_FAILURES && !state.unavailable) {
    state = { ...state, unavailable: true }
    emit()
  }
}

async function poll(): Promise<void> {
  if (inFlight || currentSession === '') return
  const session = currentSession
  inFlight = true
  try {
    const res = await getJson<OrchestrationResponse>(
      `/plugins/agy-link/orchestration?session=${encodeURIComponent(session)}`,
    )
    if (currentSession !== session) return
    if (res !== null && res.orchestration !== undefined) {
      failures = 0
      state = { snapshot: res.orchestration, loaded: true, unavailable: false }
      emit()
      return
    }
    noteFailure()
  } catch {
    noteFailure()
  } finally {
    inFlight = false
    if (currentSession !== '' && listeners.size > 0) {
      schedule(state.snapshot?.live === true ? LIVE_POLL_MS : IDLE_POLL_MS)
    }
  }
}

/**
 * Subscribe to one session's orchestration snapshot.
 * @param sessionId - the conversation's DSH session id; `''` means "not connected".
 * @returns the snapshot (null until the first answer), whether the first load
 *   has given up, and a manual refresh.
 */
export function useOrchestration(sessionId: string): {
  snapshot: OrchestrationSnapshot | null
  loaded: boolean
  unavailable: boolean
  refresh: () => void
} {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = (): void => setTick((n) => n + 1)
    listeners.add(listener)
    if (sessionId !== '' && sessionId !== currentSession) {
      currentSession = sessionId
      failures = 0
      state = { snapshot: null, loaded: false, unavailable: false }
      emit()
    }
    if (sessionId !== '' && sessionId === currentSession && !inFlight) void poll()
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        currentSession = ''
        failures = 0
        state = { snapshot: null, loaded: false, unavailable: false }
      }
    }
  }, [sessionId])
  return {
    snapshot: state.snapshot,
    loaded: state.loaded,
    unavailable: state.unavailable,
    refresh: () => {
      failures = 0
      if (state.unavailable) {
        state = { ...state, unavailable: false }
        emit()
      }
      void poll()
    },
  }
}

/** Test-only: drop the shared cache. */
export function resetOrchestrationDataForTests(): void {
  state = { snapshot: null, loaded: false, unavailable: false }
  currentSession = ''
  failures = 0
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  listeners.clear()
  inFlight = false
}
