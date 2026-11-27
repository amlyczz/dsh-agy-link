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

interface State {
  snapshot: OrchestrationSnapshot | null
  loaded: boolean
}

let state: State = { snapshot: null, loaded: false }
const listeners = new Set<() => void>()
let currentSession = ''
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight = false

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
      state = { snapshot: res.orchestration, loaded: true }
      emit()
    }
  } catch {
    // Keep the previous snapshot on screen: the host may be mid-restart.
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
 * @returns the snapshot (null until the first answer) plus a manual refresh.
 */
export function useOrchestration(sessionId: string): {
  snapshot: OrchestrationSnapshot | null
  loaded: boolean
  refresh: () => void
} {
  const [, setTick] = useState(0)
  useEffect(() => {
    const listener = (): void => setTick((n) => n + 1)
    listeners.add(listener)
    if (sessionId !== '' && sessionId !== currentSession) {
      currentSession = sessionId
      state = { snapshot: null, loaded: false }
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
        state = { snapshot: null, loaded: false }
      }
    }
  }, [sessionId])
  return {
    snapshot: state.snapshot,
    loaded: state.loaded,
    refresh: () => {
      void poll()
    },
  }
}

/** Test-only: drop the shared cache. */
export function resetOrchestrationDataForTests(): void {
  state = { snapshot: null, loaded: false }
  currentSession = ''
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  listeners.clear()
  inFlight = false
}