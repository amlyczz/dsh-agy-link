// Process runner (spec ADR-3): every request spawns a short-lived
// `agy -p` process as its own process group; abort and watchdog kill the
// whole tree (agy re-spawns exec children). stderr is captured as a tail
// for error attribution; stdout is streamed line-by-line to the caller.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { PluginConfig } from '../common/types.ts'

const IS_WIN = process.platform === 'win32'

/** Executable candidates for one PATH entry, per-platform. Exported for tests. */
export function binCandidates(dir: string, platform: string = process.platform): string[] {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  return exts.map((e) => join(dir, 'agy' + e))
}

/** True when the resolved bin is a Windows cmd shim (needs shell wrapping). */
export function isCmdShim(bin: string): boolean {
  return /\.(cmd|bat)$/i.test(bin)
}

/** cmd.exe argument quoting (cross-spawn rules). Exported for tests. */
export function windowsQuote(arg: string): string {
  if (/[ \t\n\v"]/.test(arg) === false) return arg
  let escaped = arg.replace(/(\\+)\"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  escaped = '"' + escaped.replace(/"/g, '\\"') + '"'
  return escaped
}

export const MIN_AGY_VERSION = '1.1.8'

export function resolveAgyBin(cfg: PluginConfig): string | null {
  const candidates: string[] = [];
  if (cfg.agyBin !== '') candidates.push(cfg.agyBin);
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir !== '') candidates.push(...binCandidates(dir))
  }
  // Per-platform default install locations (agy ships as a native binary).
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? ''
    if (local !== '') candidates.push(join(local, 'Programs', 'agy', 'agy.exe'))
    candidates.push(join(homedir(), '.local', 'bin', 'agy.exe'))
    candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'agy.cmd'))
  } else {
    candidates.push(join(homedir(), '.local', 'bin', 'agy'))
    candidates.push('/usr/local/bin/agy')
    candidates.push('/opt/homebrew/bin/agy')
  }
  // Prefer a real executable over a cmd shim: keep the first hit of each
  // PATH dir but rank .exe/extensionless before .cmd/.bat.
  const hits: string[] = [];
  for (const c of candidates) {
    try {
      accessSync(c, constants.F_OK);
      hits.push(c);
    } catch {
      continue;
    }
  }
  return hits.find((h) => !isCmdShim(h)) ?? hits[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/\./).map(Number);
  const pb = b.split(/\./).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;

}

export function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

export interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderrTail: string;
  durationMs: number;
}

export interface RunOptions {
  bin: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  /** stdin stays writable (auth code injection). */
  keepStdin?: boolean;
}

export interface RunningProcess {
  child: ChildProcess;
  outcome: Promise<RunOutcome>;
  kill(reason: 'timeout' | 'abort'): void;
}

const GRACE_MS = 5000;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WIN) {
    // No Unix process groups on Windows: kill the whole tree via taskkill.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone'
    }
  }
}

export function startAgyProcess(opts: RunOptions): RunningProcess {
  const started = Date.now();
  const viaCmd = IS_WIN && isCmdShim(opts.bin)
  const child = viaCmd
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...opts.args].map(windowsQuote).join(' ')], {
        cwd: opts.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: process.env,
        detached: !IS_WIN,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const watchdog =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs)
      : null;

  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  if (child.stdout) child.stdout.setEncoding('utf8');
  if (child.stderr) child.stderr.setEncoding('utf8');
  let pending = '';
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      opts.onLine?.(line);
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });

  const outcome = new Promise<RunOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', onAbort);
      if (pending !== '') {
        opts.onLine?.(pending);
        pending = '';
      }
      if (!opts.keepStdin) {
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
      }
      resolve({
        code,
        signal,
        timedOut,
        aborted,
        stdout,
        stderrTail: stderr,
        durationMs: Date.now() - started,
      });
    };
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', (err) => {
      stderr = (stderr + String(err)).slice(-4096);
      finish(null, null);
    });
  });

  return {
    child,
    outcome,
    kill: (reason) => {
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      killTree(child);
    },
  };
}

/** Simple one-shot helper for --version / models probes. */
export async function probeProcess(
  bin: string,
  args: readonly string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const p = startAgyProcess({ bin, args, timeoutMs, signal });
  return p.outcome;
}
