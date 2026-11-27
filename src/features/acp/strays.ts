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
import { readProcessTable, readProcessTableAsync, terminatePid, type ProcessRow } from '../../runtime/agy/process-table.ts'

/** `agy [.exe] acp <args>` — never a `-p` CLI run and never a `--log-file …/acp-…`. */
const ACP_INVOCATION = /(?:^|[\s"'/\\])agy(?:\.exe)?["']?\s+acp(?:\s|"|$)/i

/** `status()` re-observes the process table at most this often (issue #229). */
export const STRAY_SCAN_OBSERVE_MS = 15_000

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
  /**
   * Asynchronous table read. When present, background sweeps go through it so
   * `powershell.exe Get-CimInstance` (~950 ms on Windows) never blocks the DSH
   * host event loop (issue #229). Absent on test deps, which keep the sync path.
   */
  listAsync?: () => Promise<readonly ProcessRow[]>
  kill: (pid: number) => void
}

/** Real machine deps. Kept out of unit tests so no test ever signals a real pid. */
export function realStrayDeps(): StrayDeps {
  return {
    // 2s is enough for `ps`; a wedged table must not stall a status read.
    list: () => readProcessTable(2_000),
    listAsync: () => readProcessTableAsync(2_000),
    kill: (pid) => { terminatePid(pid) },
  }
}

export interface ReapStrayResult {
  /** Strays seen in this scan. */
  strays: number[]
  /** Pids actually signalled (strays + their descendants). */
  killed: number[]
}

function reapWithRows(
  deps: StrayDeps,
  rows: readonly ProcessRow[],
  input: StrayScanInput,
  kill: boolean,
): ReapStrayResult {
  const strays = selectStrayAcpProcesses(rows, input)
  if (strays.length === 0) return { strays: [], killed: [] }
  if (!kill) return { strays, killed: [] }
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

/**
 * Kill every stray `agy acp` child and its descendants. `kill` is false for
 * the observe-only path used by `status()` so a badge read never has side
 * effects.
 */
export function reapStrayAcpProcesses(
  deps: StrayDeps,
  input: StrayScanInput,
  options: { kill?: boolean } = {},
): ReapStrayResult {
  return reapWithRows(deps, deps.list(), input, options.kill !== false)
}

/**
 * The same reap over an asynchronous table read, so a sweep never blocks the
 * host event loop (issue #229: the synchronous `powershell.exe` read froze the
 * DSH host for ~950 ms every 15 s / 60 s).
 *
 * `input` is a THUNK on purpose: the pool's tracked pids are re-read AFTER the
 * table arrives, so an `agy acp` child spawned while PowerShell was still
 * scanning is already in the pool and can never be mistaken for a stray.
 * `canKill` is consulted after the read as well: a scan that completes after
 * `dispose()` only observes.
 */
export async function reapStrayAcpProcessesAsync(
  deps: StrayDeps,
  input: () => StrayScanInput,
  options: { kill?: boolean; canKill?: () => boolean } = {},
): Promise<ReapStrayResult> {
  const rows = await (deps.listAsync ?? (async () => deps.list()))()
  const kill = options.kill !== false && (options.canKill?.() ?? true)
  return reapWithRows(deps, rows, input(), kill)
}

/**
 * Stray bookkeeping for one pool: the last observation, when it was taken, and
 * the single background scan shared by `status()` (observe) and the eviction
 * timer (kill). With `listAsync` present a sweep runs off the event loop and
 * callers get the previous observation at once; test deps without it keep the
 * synchronous path so assertions see the reap in the same tick.
 */
export class StraySweeper {
  private observed: readonly number[] = []
  private scanAt = 0
  private inFlight: Promise<void> | null = null
  private reaped = 0
  private disposed = false

  constructor(
    private readonly deps: StrayDeps,
    private readonly log: (msg: string) => void,
  ) {}

  /** Strays seen by the last completed scan. */
  lastObserved(): readonly number[] {
    return this.observed
  }

  /** Total strays killed since construction. */
  reapedTotal(): number {
    return this.reaped
  }

  /** After dispose a scan that completes late observes only: no kill, no log. */
  dispose(): void {
    this.disposed = true
  }

  /**
   * Observe for `status()`: at most one scan per `STRAY_SCAN_OBSERVE_MS`; a
   * scan in flight is shared, never duplicated.
   * @param tracked - the pool's live + draining pids, read when the scan lands.
   * @param poolEmpty - strays are only killed from an empty pool.
   */
  observe(now: number, tracked: () => Set<number>, poolEmpty: boolean): readonly number[] {
    if (this.inFlight !== null) return this.observed
    if (this.scanAt !== 0 && now - this.scanAt < STRAY_SCAN_OBSERVE_MS) return this.observed
    if (this.deps.listAsync === undefined) {
      this.runSync(now, tracked, poolEmpty)
      return this.observed
    }
    void this.runAsync(now, tracked, poolEmpty)
    return this.observed
  }

  /**
   * Eviction pass: strays are killed regardless of pool occupancy. Returns the
   * number reaped on the synchronous path; the asynchronous path logs instead,
   * and the count shows up in `reapedTotal()` once the scan lands.
   */
  reap(now: number, tracked: () => Set<number>): number {
    if (this.deps.listAsync === undefined) return this.runSync(now, tracked, true)
    void this.runAsync(now, tracked, true)
    return 0
  }

  private input = (tracked: () => Set<number>): (() => StrayScanInput) =>
    () => ({ parentPid: process.pid, trackedPids: tracked() })

  private runSync(now: number, tracked: () => Set<number>, kill: boolean): number {
    const input = this.input(tracked)()
    const result = reapStrayAcpProcesses(this.deps, input, { kill })
    let observed: readonly number[] = result.strays
    if (kill && result.strays.length > 0) {
      // The badge must not keep showing the graveyard: recount what survived
      // the kill instead of trusting the pre-kill table.
      observed = reapStrayAcpProcesses(this.deps, input, { kill: false }).strays
    }
    return this.finish(now, result, observed)
  }

  private runAsync(now: number, tracked: () => Set<number>, kill: boolean): Promise<void> {
    const input = this.input(tracked)
    const run = (async () => {
      try {
        const result = await reapStrayAcpProcessesAsync(this.deps, input, { kill, canKill: () => !this.disposed })
        let observed: readonly number[] = result.strays
        if (kill && result.strays.length > 0) {
          observed = (await reapStrayAcpProcessesAsync(this.deps, input, { kill: false })).strays
        }
        if (this.disposed) return
        this.finish(now, result, observed)
      } catch {
        // Keep the previous observation: the table read failed mid-sweep.
      }
    })().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private finish(now: number, result: ReapStrayResult, observed: readonly number[]): number {
    if (result.killed.length > 0) {
      this.reaped += result.strays.length
      this.log(`[acp-pool] reaped ${result.strays.length} stray agy acp process(es): ${result.killed.join(',')}`)
    }
    this.observed = observed
    this.scanAt = now
    return result.killed.length > 0 ? result.strays.length : 0
  }
}
