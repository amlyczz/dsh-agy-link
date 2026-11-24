// Maps a shared `agy acp` child process (`DSH_MCP_PROC`) to its active (or
// most recently settled) DSH session key so bridged MCP calls never route to
// the stale `DSH_MCP_SESSION` inherited when the process first spawned (issue #200).
import { randomUUID } from 'node:crypto'

interface ProcSessionEntry {
  active: Array<{ turnId: number; sessionKey: string }>
  lastSessionKey: string
}

const procSessions = new Map<string, ProcSessionEntry>()
let nextTurnId = 1

export function nextMcpProcId(): string {
  return `acp-${randomUUID()}`
}

/**
 * Mark `sessionKey` as actively running on `procId`. Returns an idempotent
 * release callback that ends the active turn while retaining `lastSessionKey`
 * for any trailing post-turn MCP callbacks until the process exits.
 */
export function beginProcSessionTurn(procId: string, sessionKey: string): () => void {
  if (procId === '' || sessionKey === '') return () => {}
  let entry = procSessions.get(procId)
  if (!entry) {
    entry = { active: [], lastSessionKey: sessionKey }
    procSessions.set(procId, entry)
  } else {
    entry.lastSessionKey = sessionKey
  }
  const turnId = nextTurnId++
  entry.active.push({ turnId, sessionKey })
  let released = false
  return () => {
    if (released) return
    released = true
    const cur = procSessions.get(procId)
    if (!cur) return
    const idx = cur.active.findIndex((t) => t.turnId === turnId)
    if (idx >= 0) cur.active.splice(idx, 1)
  }
}

/** Resolve the active (or most recent) DSH session key for `procId`. */
export function resolveProcSession(procId: string): string | undefined {
  if (procId === '') return undefined
  const entry = procSessions.get(procId)
  if (!entry) return undefined
  if (entry.active.length > 0) return entry.active[entry.active.length - 1]!.sessionKey
  return entry.lastSessionKey !== '' ? entry.lastSessionKey : undefined
}

/** Drop all session state for a terminated ACP process. */
export function clearProcSessions(procId: string): void {
  if (procId !== '') procSessions.delete(procId)
}
