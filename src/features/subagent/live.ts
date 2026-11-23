// Live subagent registry.
//
// `SubagentTracker` instances are created per attempt inside the provider/ACP
// layers and were previously invisible to anything outside that attempt: the
// only trace of a running agy-internal subagent was a scrolling reasoning line.
// The header badge needs an aggregate view ("how many are running, and what is
// each one doing"), so each tracker registers itself here for the life of its
// run and the status route reads a snapshot.
//
// Keyed by DSH session id so a session's header only reports its OWN subagents.
export interface SubagentSnapshotItem {
  conversationId: string
  role: string
  typeName: string
  state?: string
  running: boolean
  lastAction: string
  startedAt: number
  lastAt: number
}

export interface SubagentSnapshot {
  total: number
  running: number
  items: SubagentSnapshotItem[]
}

export interface SessionSubagentSnapshot extends SubagentSnapshot {
  session: string
}

export interface SubagentTrackable {
  snapshot(): SubagentSnapshot
}

const live = new Map<string, SubagentTrackable[]>()

export function attachSubagentTracker(sessionKey: string, tracker: SubagentTrackable): void {
  if (sessionKey === '') return
  const list = live.get(sessionKey) ?? []
  if (!list.includes(tracker)) list.push(tracker)
  live.set(sessionKey, list)
}

export function detachSubagentTracker(sessionKey: string, tracker: SubagentTrackable): void {
  if (sessionKey === '') return
  const list = live.get(sessionKey)
  if (list === undefined) return
  const next = list.filter((t) => t !== tracker)
  if (next.length === 0) live.delete(sessionKey)
  else live.set(sessionKey, next)
}

/** Every session that currently has at least one tracked subagent. */
export function snapshotSubagents(): SessionSubagentSnapshot[] {
  const out: SessionSubagentSnapshot[] = []
  for (const [session, trackers] of live) {
    const items: SubagentSnapshotItem[] = []
    for (const tr of trackers) items.push(...tr.snapshot().items)
    if (items.length === 0) continue
    out.push({
      session,
      total: items.length,
      running: items.filter((i) => i.running).length,
      items,
    })
  }
  return out
}
