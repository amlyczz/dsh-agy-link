// Stray `agy acp` reaper.
//
// Why this exists: `AcpProcess.close()` can only be trusted as far as the OS is
// concerned, and agy ignores SIGTERM while it installs its shutdown handlers.
// A process the pool has already forgotten therefore keeps running: it holds
// the credential slot's token file, keeps polling `ListExperiments`, keeps its
// MCP children alive, and — worst of all — is invisible to `status()`, so the
// console badge claims "1 进程" while two `agy acp` servers are actually alive
// (observed 2026-11-23: pids 75365 + 95014, badge showed 1).
//
// The reaper reconciles the process table against what the pool tracks. It only
// ever looks at DIRECT children of this host, so a second DSH instance (or an
// `agy` started from a terminal) is never a target.
import { readProcessTable, terminatePid, type ProcessRow } from '../../runtime/agy/process-table.ts'

/** `agy [.exe] acp <args>` — never a `-p` CLI run and never a `--log-file …/acp-…`. */
const ACP_INVOCATION = /(?:^|[\s"'/\\])agy(?:\.exe)?["']?\s+acp(?:\s|"|$)/i

export function isAcpCommandLine(commandLine: string): boolean {
  return ACP_INVOCATION.test(commandLine)
}

export interface StrayScanInput {
  /** This host's pid: only its direct children are candidates. */
  parentPid: number
  /** pids the pool still owns (live or draining) — never touched. */
  trackedPids: ReadonlySet<number>
}

/** Direct `agy acp` children of `parentPid` that the pool no longer knows about. */
export function selectStrayAcpProcesses(rows: readonly ProcessRow[], input: StrayScanInput): number[] {
  const out: number[] = []
  for (const row of rows) {
    if (row.pid <= 0 || row.pid === input.parentPid) continue
    if (row.parentPid !== input.parentPid) continue
    if (input.trackedPids.has(row.pid)) continue
    if (!isAcpCommandLine(row.commandLine)) continue
    out.push(row.pid)
  }
  return out
}

/**
 * Every descendant of `rootPid`, depth-first.
 *
 * A stray `agy acp` is the parent of its MCP servers (blender-mcp, colab-mcp,
 * playwright…). Killing only the root reparents them to launchd, where they sit
 * forever — the very leak `reapOrphanedMcpServers()` cleans up at boot.
 */
export function collectDescendants(rows: readonly ProcessRow[], rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const row of rows) {
    if (row.pid <= 0 || row.parentPid <= 0) continue
    const list = childrenOf.get(row.parentPid)
    if (list === undefined) childrenOf.set(row.parentPid, [row.pid])
    else list.push(row.pid)
  }
  const out: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

export interface StrayDeps {
  list: () => readonly ProcessRow[]
  kill: (pid: number) => void
}

/** Real machine deps. Kept out of unit tests so no test ever signals a real pid. */
export function realStrayDeps(): StrayDeps {
  return {
    // 2s is enough for `ps`; a wedged table must not stall a status read.
    list: () => readProcessTable(2_000),
    kill: (pid) => { terminatePid(pid) },
  }
}

export interface ReapStrayResult {
  /** Strays seen in this scan. */
  strays: number[]
  /** Pids actually signalled (strays + their descendants). */
  killed: number[]
}

/**
 * Kill every stray `agy acp` child and its descendants. `killRoot` is false for
 * the observe-only path used by `status()` so a badge read never has side
 * effects.
 */
export function reapStrayAcpProcesses(
  deps: StrayDeps,
  input: StrayScanInput,
  options: { kill?: boolean } = {},
): ReapStrayResult {
  const rows = deps.list()
  const strays = selectStrayAcpProcesses(rows, input)
  if (strays.length === 0) return { strays: [], killed: [] }
  if (options.kill === false) return { strays, killed: [] }
  const killed: number[] = []
  for (const stray of strays) {
    // Children first: if the root dies first they are reparented and the next
    // table read can no longer attribute them to this stray.
    for (const child of collectDescendants(rows, stray).reverse()) {
      deps.kill(child)
      killed.push(child)
    }
    deps.kill(stray)
    killed.push(stray)
  }
  return { strays, killed }
}
