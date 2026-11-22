// Deferred, best-effort housekeeping that must NOT run on the plugin-load path.
//
// Everything here used to run inline from runBootHygiene(): sweeping staging
// dirs, pruning old logs, mirroring the whole ecosystem into every isolated
// account home, and (implicitly) leaving agy's per-conversation presence locks
// and orphaned MCP servers behind. On a pool of 8 accounts that is a few
// hundred file stats plus a full ecosystem copy before the first frame, and the
// leftovers accumulate on every start.
//
// The rule now: at boot, only do what a turn immediately depends on
// (credentials, store hygiene). Everything else waits for an idle moment, runs
// once, and reports a single summary line.
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import type { ManagedAccount } from '../common/pool-types.ts'

/** Presence locks older than this are certainly from finished conversations. */
export const PRESENCE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MIN_ORPHAN_AGE_MS = 5 * 60 * 1000

/**
 * agy writes a zero-byte `<conversation-id>.lock` into
 * `<account>/.gemini/antigravity-cli/presence/` for every conversation and never
 * removes it. Hundreds of them pile up across a pool; they are pure noise once
 * the conversation is a day old (agy recreates one on demand).
 *
 * Returns the number of files removed. Never throws.
 */
export function sweepStalePresenceLocks(accountDir: string, now = Date.now(), maxAgeMs = PRESENCE_LOCK_MAX_AGE_MS): number {
  const dir = join(accountDir, '.gemini', 'antigravity-cli', 'presence')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue
      rmSync(full, { force: true })
      removed++
    } catch {
      // a lock another process is holding: leave it
    }
  }
  return removed
}

export interface ProcessRow {
  pid: number
  parentPid: number
  /** Creation time in epoch ms, when the platform reports one. */
  startedAtMs: number
  commandLine: string
}

/** Markers of MCP servers we consider safe to reap once orphaned. */
const MCP_MARKERS = ['mcp', 'godot-mcp', 'blender-mcp', 'computer-use-mcp', 'chrome-devtools-mcp'] as const

function looksLikeMcpServer(commandLine: string): boolean {
  const cmd = commandLine.toLowerCase()
  return MCP_MARKERS.some((m) => cmd.includes(m))
}

/**
 * Orphans worth killing: an MCP-server-looking process whose parent is gone and
 * which has been running long enough that it cannot be a server booting for a
 * live agy process. Pure so tests can drive it with a fake process table.
 *
 * A row with an UNKNOWN start time is never killed: `ConvertTo-Json` renders CIM
 * `CreationDate` as `/Date(…)/`, and a parse failure must degrade to "leave it
 * alone", not to "age 0, kill it".
 */
export function pickOrphanMcpProcesses(
  rows: readonly ProcessRow[],
  isAlive: (pid: number) => boolean,
  now = Date.now(),
  minAgeMs = MIN_ORPHAN_AGE_MS,
): number[] {
  const pids = new Set(rows.map((r) => r.pid))
  const out: number[] = []
  for (const row of rows) {
    if (row.pid <= 0 || row.pid === process.pid) continue
    if (row.parentPid === 0) continue
    // A live parent inside the table is not orphaned even if kill(0) lies.
    if (pids.has(row.parentPid)) continue
    if (isAlive(row.parentPid)) continue
    if (!looksLikeMcpServer(row.commandLine)) continue
    if (row.startedAtMs <= 0) continue
    if (now - row.startedAtMs < minAgeMs) continue
    out.push(row.pid)
  }
  return out
}

/** Parse the shapes `ConvertTo-Json` emits for a CIM DateTime. */
export function parseCimDate(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0
  const ms = /^\/Date\((-?\d+)\)\/$/.exec(value)
  if (ms) {
    const n = Number(ms[1])
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** Read this machine's process table (Windows via CIM, POSIX via ps). Never throws. */
export function readProcessTable(): ProcessRow[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe' OR Name='npx.exe'\" | " +
            'Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', timeout: 8_000, windowsHide: true },
      ).trim()
      if (out === '') return []
      const parsed = JSON.parse(out) as unknown
      const list = Array.isArray(parsed) ? parsed : [parsed]
      const rows: ProcessRow[] = []
      for (const item of list) {
        const rec = item as Record<string, unknown>
        const pid = Number(rec.ProcessId)
        const parentPid = Number(rec.ParentProcessId)
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue
        rows.push({
          pid,
          parentPid,
          startedAtMs: parseCimDate(rec.CreationDate),
          commandLine: typeof rec.CommandLine === 'string' ? rec.CommandLine : '',
        })
      }
      return rows
    }
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 8_000,
    })
    const rows: ProcessRow[] = []
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s(.*)$/)
      if (!m) continue
      const started = Date.parse(m[3]!.trim())
      rows.push({
        pid: Number(m[1]),
        parentPid: Number(m[2]),
        startedAtMs: Number.isFinite(started) ? started : 0,
        commandLine: m[4] ?? '',
      })
    }
    return rows
  } catch {
    return []
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** Kill one orphan MCP process. Windows needs `/T /F`; POSIX escalates. */
export function killOrphan(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

/**
 * Reap orphaned MCP servers left behind by agy processes that exited without
 * killing their children (agy's `models` / `/usage` / `--version` probes do
 * exactly that). Returns the pids killed.
 */
export function reapOrphanedMcpServers(now = Date.now(), minAgeMs = MIN_ORPHAN_AGE_MS): number[] {
  const rows = readProcessTable()
  if (rows.length === 0) return []
  const pids = pickOrphanMcpProcesses(rows, pidAlive, now, minAgeMs)
  for (const pid of pids) killOrphan(pid)
  return pids
}

/** Where the per-account presence locks live (exported for diagnostics). */
export function presenceDirOf(accountDir: string): string {
  return join(accountDir, '.gemini', 'antigravity-cli', 'presence')
}

export interface MaintenanceDeps {
  /** Read lazily: accounts are added and removed while DSH runs. */
  accounts: () => readonly ManagedAccount[]
  sweepStaging: () => number
  sweepLogs: () => number
  syncEcosystem?: () => void
  log: (msg: string) => void
  /** Opt-out for operators who do not want the plugin touching any process. */
  reapOrphans: boolean
  now?: () => number
}

/** One maintenance pass; each step is isolated so a failure cannot skip the rest. */
export function runMaintenancePass(deps: MaintenanceDeps): { presence: number; staging: number; logs: number; reaped: number[] } {
  const now = (deps.now ?? Date.now)()
  let presence = 0
  let accounts: readonly ManagedAccount[] = []
  try {
    accounts = deps.accounts()
  } catch {
    accounts = []
  }
  for (const acc of accounts) {
    if (!acc.dir || acc.systemHome === true) continue
    try {
      presence += sweepStalePresenceLocks(acc.dir, now)
    } catch {
      // ignore
    }
  }
  let staging = 0
  try {
    staging = deps.sweepStaging()
  } catch {
    // ignore
  }
  let logs = 0
  try {
    logs = deps.sweepLogs()
  } catch {
    // ignore
  }
  let reaped: number[] = []
  if (deps.reapOrphans) {
    try {
      reaped = reapOrphanedMcpServers(now)
    } catch {
      reaped = []
    }
  }
  try {
    deps.syncEcosystem?.()
  } catch {
    // ignore
  }
  const parts: string[] = []
  if (presence > 0) parts.push(presence + ' stale presence lock(s)')
  if (staging > 0) parts.push(staging + ' staging dir(s)')
  if (logs > 0) parts.push(logs + ' old log(s)')
  if (reaped.length > 0) parts.push(reaped.length + ' orphaned MCP process(es)')
  if (parts.length > 0) deps.log('[agy-link] maintenance: swept ' + parts.join(', '))
  return { presence, staging, logs, reaped }
}

/**
 * Schedule the deferred pass. Runs once shortly after boot (after the boot
 * probe has had its idle window) and then on a long interval, always unref'd so
 * it can never hold DSH open.
 */
export function scheduleBootMaintenance(
  deps: MaintenanceDeps,
  options: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
  const initial = options.initialDelayMs ?? 12_000
  const interval = options.intervalMs ?? 30 * 60_000
  let stopped = false
  const pass = (): void => {
    if (stopped) return
    try {
      runMaintenancePass(deps)
    } catch {
      // never let housekeeping break the host
    }
  }
  const first = setTimeout(pass, initial)
  first.unref?.()
  const timer = setInterval(pass, interval)
  timer.unref?.()
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
/**
 * Startup-cost lines for `/agy doctor`: what the NEXT agy spawn will pay before
 * it can answer, and what the previous runs left behind.
 *
 * `agy` forks every server in the MCP registry for `models` / `/usage` /
 * `--version`, so a registry entry pinned to `@latest` re-resolves against the
 * npm registry on every single spawn (~1.4 s each) and multiplies by the number
 * of accounts being probed.
 */
export function describeStartupCost(
  registryFile: string,
  accounts: readonly ManagedAccount[],
  now = Date.now(),
): string[] {
  const lines: string[] = []
  const isolated = accounts.filter((a) => a.dir !== undefined && a.dir !== '' && a.systemHome !== true)
  lines.push('- startup cost: ' + accounts.length + ' pool account(s), ' + isolated.length + ' with an isolated home')
  let staleLocks = 0
  for (const acc of isolated) {
    if (!acc.dir) continue
    try {
      const dir = presenceDirOf(acc.dir)
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.lock')) continue
        try {
          if (now - statSync(join(dir, name)).mtimeMs >= PRESENCE_LOCK_MAX_AGE_MS) staleLocks++
        } catch {
          // ignore
        }
      }
    } catch {
      // no presence dir for this account
    }
  }
  if (staleLocks > 0) {
    lines.push('  - ' + staleLocks + ' stale presence lock(s) — swept automatically by the deferred maintenance pass')
  }
  let servers: Array<[string, unknown]> = []
  try {
    const raw = readFileSync(registryFile, 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') servers = Object.entries(parsed.mcpServers)
  } catch {
    return lines
  }
  if (servers.length === 0) return lines
  lines.push('- MCP registry: ' + servers.length + ' server(s) forked by EVERY agy spawn (' + registryFile + ')')
  let unpinned = 0
  for (const [name, entry] of servers) {
    const rec = (entry ?? {}) as { command?: unknown; args?: unknown }
    const argv = [typeof rec.command === 'string' ? rec.command : '', ...(Array.isArray(rec.args) ? rec.args.map((a) => String(a)) : [])]
    const cmdline = argv.join(' ')
    const latest = cmdline.includes("@latest")
    const npx = /(^|[\\/\s])npx(\.cmd)?(\s|$)/i.test(cmdline)
    if (latest) unpinned++
    lines.push('  - ' + name + (latest ? ' — @latest re-resolves on every spawn (~1.4 s), pin a version' : npx ? ' — npx (first run may fetch)' : ''))
  }
  if (unpinned > 0) {
    lines.push('  - ' + unpinned + ' unpinned server(s): each boot probe pays the registry lookup again. Pin versions in ' + registryFile + '.')
  }
  return lines
}
