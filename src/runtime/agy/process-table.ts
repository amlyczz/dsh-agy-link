// Machine process table + pid helpers shared by boot hygiene and the ACP stray
// reaper (`src/features/acp/strays.ts`).
//
// The readers never throw: a machine where `ps` is unavailable must degrade to
// "no rows" (callers then skip the sweep), never to a crash on the boot path.
import { execFile, execFileSync, spawn } from 'node:child_process'

/** One row of the machine's process table. */
export interface ProcessRow {
  pid: number
  parentPid: number
  /** Wall-clock start time in ms, `0` when the platform did not report one. */
  startedAtMs: number
  commandLine: string
}

/**
 * Windows names queried through CIM. `agy.exe` is included because the ACP
 * stray reaper needs to see agy children; the MCP reaper filters rows by
 * command line afterwards, so the wider query costs nothing.
 */
const WIN_IMAGE_FILTER = "Name='node.exe' OR Name='cmd.exe' OR Name='npx.exe' OR Name='agy.exe' OR Name='agy'"

function winProcessArgs(): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "${WIN_IMAGE_FILTER}" | ` +
      'Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
  ]
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

function parseWinProcessOutput(out: string): ProcessRow[] {
  const trimmed = out.trim()
  if (trimmed === '') return []
  const parsed = JSON.parse(trimmed) as unknown
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

function parsePosixProcessOutput(out: string): ProcessRow[] {
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
}

/** Read this machine's process table (Windows via CIM, POSIX via `ps`). Never throws. */
export function readProcessTable(timeoutMs = 8_000): ProcessRow[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', winProcessArgs(), {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      })
      return parseWinProcessOutput(out)
    }
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    return parsePosixProcessOutput(out)
  } catch {
    return []
  }
}

/** Asynchronous variant of {@link readProcessTable} so background maintenance never blocks the event loop. */
export function readProcessTableAsync(timeoutMs = 8_000): Promise<ProcessRow[]> {
  const isWin = process.platform === 'win32'
  const file = isWin ? 'powershell.exe' : 'ps'
  const args = isWin ? winProcessArgs() : ['-eo', 'pid=,ppid=,lstart=,command=']
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve([])
        return
      }
      try {
        resolve(isWin ? parseWinProcessOutput(stdout) : parsePosixProcessOutput(stdout))
      } catch {
        resolve([])
      }
    })
  })
}

/** Whether `pid` exists and is signalable (EPERM still means alive). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Terminate one pid and make sure it actually goes away.
 *
 * agy installs graceful-shutdown handlers and can ignore SIGTERM for minutes
 * (see `killTree` in `./process.ts`), so a bare SIGTERM is not a termination
 * signal on its own. Windows kills the tree with `/T /F` because agy's helpers
 * would otherwise be orphaned.
 *
 * Returns the escalation timer so callers/tests can await or clear it.
 */
export function terminatePid(pid: number, opts: { escalateMs?: number } = {}): NodeJS.Timeout | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* already gone */
    }
    return null
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return null
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, opts.escalateMs ?? 3_000)
  escalate.unref?.()
  return escalate
}
