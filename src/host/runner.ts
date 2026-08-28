// Process runner (spec ADR-3): every request spawns a short-lived
// `agy -p` process as its own process group; abort and watchdog kill the
// whole tree (agy re-spawns exec children). stderr is captured as a tail
// for error attribution; stdout is streamed line-by-line to the caller.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
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

/**
 * Environment that relocates the agy home directory for account isolation.
 * On Unix, HOME suffices. On Windows, libuv (Node) and Go both resolve the
 * home directory from USERPROFILE / HOMEDRIVE+HOMEPATH and IGNORE $HOME, so
 * omitting them silently breaks account isolation (every account would share
 * the real user profile). GEMINI_CLI_HOME is honored by the agy CLI on all
 * platforms for its .gemini dir.
 */
export function isolatedHomeEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: dir,
    GEMINI_CLI_HOME: join(dir, '.gemini'),
  }
  if (IS_WIN) {
    env.USERPROFILE = dir
    const m = dir.match(/^([A-Za-z]:)(.*)$/)
    if (m) {
      env.HOMEDRIVE = m[1] as string
      env.HOMEPATH = m[2] as string
    }
  }
  return env
}

export const MIN_AGY_VERSION = '1.1.8'

export function resolveAgyBin(cfg: PluginConfig): string | null {
  const candidates: string[] = [];
  if (cfg.agyBin !== '') candidates.push(cfg.agyBin);
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir !== '') candidates.push(...binCandidates(dir))
  }
  // Per-platform default install locations (GUI apps lack user shell PATH).
  const home = homedir()
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? ''
    const appData = process.env.APPDATA ?? ''
    if (local !== '') {
      candidates.push(join(local, 'Programs', 'agy', 'agy.exe'))
      candidates.push(join(local, 'pnpm', 'agy.cmd'))
      candidates.push(join(local, 'pnpm', 'agy.exe'))
    }
    if (appData !== '') {
      candidates.push(join(appData, 'npm', 'agy.cmd'))
      candidates.push(join(appData, 'Roaming', 'npm', 'agy.cmd'))
    }
    candidates.push(join(home, '.local', 'bin', 'agy.exe'))
    candidates.push(join(home, '.local', 'bin', 'agy.cmd'))
    candidates.push(join(home, '.bun', 'bin', 'agy.exe'))
    candidates.push(join(home, '.cargo', 'bin', 'agy.exe'))
    candidates.push(join(home, 'scoop', 'shims', 'agy.exe'))
  } else {
    // macOS / Linux standard system and package manager paths
    candidates.push(join(home, '.local', 'bin', 'agy'))
    candidates.push('/usr/local/bin/agy')
    candidates.push('/opt/homebrew/bin/agy')
    candidates.push('/opt/homebrew/sbin/agy')
    candidates.push('/home/linuxbrew/.linuxbrew/bin/agy')
    candidates.push(join(home, '.bun', 'bin', 'agy'))
    candidates.push(join(home, '.cargo', 'bin', 'agy'))
    candidates.push(join(home, '.local', 'share', 'pnpm', 'agy'))
    candidates.push(join(home, 'Library', 'pnpm', 'agy'))
    candidates.push(join(home, '.yarn', 'bin', 'agy'))
    candidates.push(join(home, '.npm-global', 'bin', 'agy'))
    candidates.push(join(home, '.volta', 'bin', 'agy'))
    candidates.push(join(home, '.asdf', 'shims', 'agy'))
    candidates.push(join(home, '.nix-profile', 'bin', 'agy'))
    candidates.push('/run/current-system/sw/bin/agy')

    // NVM version directories (~/.nvm/versions/node/*/bin/agy)
    try {
      const nvmNodeDir = join(home, '.nvm', 'versions', 'node')
      if (existsSync(nvmNodeDir)) {
        for (const v of readdirSync(nvmNodeDir)) {
          candidates.push(join(nvmNodeDir, v, 'bin', 'agy'))
        }
      }
    } catch {
      // ignore
    }

    // FNM version directories
    candidates.push(join(home, '.local', 'share', 'fnm', 'current', 'bin', 'agy'))
    candidates.push(join(home, '.fnm', 'current', 'bin', 'agy'))
    candidates.push(join(home, 'Library', 'Application Support', 'fnm', 'current', 'bin', 'agy'))
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
  env?: NodeJS.ProcessEnv;
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
  const env = opts.env ?? process.env
  const child = viaCmd
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...opts.args].map(windowsQuote).join(' ')], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env,
        detached: !IS_WIN,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let settled = false;

  // agy reads stdin when it is a pipe and never sees EOF (observed on
  // 1.1.15: `agy models` hangs forever with an open pipe stdin, which is
  // why model discovery silently timed out). Close stdin immediately for
  // every spawn that does not explicitly need to write to it.
  if (!opts.keepStdin) {
    try {
      child.stdin?.end();
    } catch {
      // ignore — child may have exited already
    }
  }

  let watchdog: NodeJS.Timeout | null = null;
  const refreshWatchdog = () => {
    if (!opts.timeoutMs || opts.timeoutMs <= 0 || settled) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
  };
  refreshWatchdog();

  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  if (child.stdout) child.stdout.setEncoding('utf8');
  if (child.stderr) child.stderr.setEncoding('utf8');
  let pending = '';
  child.stdout?.on('data', (chunk: string) => {
    refreshWatchdog();
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
    refreshWatchdog();
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
      if (watchdog) clearTimeout(watchdog);
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
  env?: NodeJS.ProcessEnv,
): Promise<RunOutcome> {
  const p = startAgyProcess({ bin, args, timeoutMs, signal, env });
  return p.outcome;
}

