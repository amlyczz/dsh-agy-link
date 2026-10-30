// Process runner (spec ADR-3): every request spawns a short-lived
// `agy -p` process as its own process group; abort and watchdog kill the
// whole tree (agy re-spawns exec children). stderr is captured as a tail
// for error attribution; stdout is streamed line-by-line to the caller.
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { PluginConfig } from '../common/types.ts'
import { preemptAgyAutoUpdate } from './auto-updater.ts'

const IS_WIN = process.platform === 'win32'

/**
 * Windows pipes carry bytes in the CHILD's console code page: agy captures
 * pwsh tool output as CP936 (GBK) bytes on a zh-CN Windows, so decoding them
 * as UTF-8 mangles every non-ASCII character - and the mangled text is what
 * agy stores in its conversation database, so it can never be repaired later
 * (issue #37: the Chinese refusal text arrives mangled).
 */
const OEM_ENCODINGS: Record<number, string> = {
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  65001: 'utf-8',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
}

let consoleEncoding: string | null = null

/**
 * Console/OEM code page of this process as a TextDecoder label ('utf-8' off
 * Windows). Probed once; the child inherits our console, so its tool output is
 * written in this page.
 */
export function consoleOutputEncoding(platform: string = process.platform): string {
  if (platform !== 'win32') return 'utf-8'
  if (consoleEncoding !== null) return consoleEncoding
  consoleEncoding = 'utf-8'
  try {
    const out = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'chcp'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    })
    const m = /([0-9]{3,5})/.exec(out)
    const cp = m ? Number(m[1]) : Number.NaN
    const mapped = OEM_ENCODINGS[cp]
    if (mapped !== undefined) consoleEncoding = mapped
  } catch {
    // keep utf-8
  }
  return consoleEncoding
}

/**
 * Decode one LINE of child output: UTF-8 first, and when that produces
 * replacement characters re-decode those bytes with the console code page.
 * Lines (not raw chunks) are the unit on purpose - a multi-byte character can
 * straddle a chunk boundary but never a newline, in UTF-8 or the OEM pages.
 */
export function decodeConsoleLine(bytes: Buffer, encoding: string = consoleOutputEncoding()): string {
  const text = bytes.toString('utf8')
  if (encoding === 'utf-8' || !text.includes('\uFFFD')) return text
  try {
    const alt = new TextDecoder(encoding).decode(bytes)
    return alt.includes('\uFFFD') ? text : alt
  } catch {
    return text
  }
}

/** Byte stream to decoded line text, holding an unterminated tail back. */
function makeLineDecoder(encoding: string): { push: (chunk: Buffer) => string; flush: () => string } {
  let rest: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): string {
      rest = rest.length === 0 ? chunk : Buffer.concat([rest, chunk])
      let out = ''
      let nl: number
      while ((nl = rest.indexOf(0x0a)) >= 0) {
        out += decodeConsoleLine(rest.subarray(0, nl + 1), encoding)
        rest = rest.subarray(nl + 1)
      }
      return out
    },
    flush(): string {
      if (rest.length === 0) return ''
      const out = decodeConsoleLine(rest, encoding)
      rest = Buffer.alloc(0)
      return out
    },
  }
}

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
  const geminiDir = join(dir, '.gemini')
  const env: Record<string, string> = {
    HOME: dir,
    GEMINI_CLI_HOME: geminiDir,
    ANTIGRAVITY_GEMINI_DIR: geminiDir,
    ANTIGRAVITY_APP_DATA_DIR: join(geminiDir, 'antigravity-cli'),
  }
  if (IS_WIN) {
    env.USERPROFILE = dir
    const m = dir.match(/^([A-Za-z]:)(.*)$/)
    if (m) {
      env.HOMEDRIVE = m[1] as string
      env.HOMEPATH = m[2] as string
    }
  } else if (process.platform === 'linux') {
    // Linux/Unix: block the user-wide D-Bus Secret Service session bus so agy
    // is forced to read the isolated per-account token file instead of falling
    // through to the desktop's gnome-keyring / secret-tool (which holds the primary).
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/nonexistent-agy-bus'
  }
  return env
}

/**
 * Standard proxy env block for one proxy URL. agy is a Go binary and only
 * honors HTTP(S)_PROXY / ALL_PROXY; GUI hosts don't inherit shell proxy
 * env, so the plugin injects this explicitly (global config or per-account).
 * Exported for tests.
 */
export function proxyEnvFor(proxyUrl: string | undefined | null): Record<string, string> {
  const url = proxyUrl?.trim()
  if (!url) return {}
  return {
    ALL_PROXY: url,
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    all_proxy: url,
    https_proxy: url,
    http_proxy: url,
  }
}

/**
 * macOS: an isolated HOME has no login keychain, so the first keyring write
 * makes the Security framework pop the "create login keychain" password
 * dialog (right system.keychain.create.loginkc) on every token refresh.
 * Provisioning a throwaway per-account keychain under that HOME keeps keyring
 * writes silent. Never modifies the user's global default-keychain.
 * No-op on other platforms or when already provisioned. Never throws.
 * Exported for tests.
 */
export function ensureIsolatedKeychain(
  dir: string,
  platform: string = process.platform,
  run: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => unknown = (file, args, env) =>
    execFileSync(file, args, { stdio: 'ignore', env, timeout: 10_000 }),
): boolean {
  if (platform !== 'darwin') return false
  if (dir === '') return false
  const kc = join(dir, 'Library', 'Keychains', 'login.keychain-db')
  if (existsSync(kc)) return false
  try {
    const env = { ...process.env, HOME: dir }
    mkdirSync(join(dir, 'Library', 'Keychains'), { recursive: true })
    run('security', ['create-keychain', '-p', '', kc], env)
    run('security', ['set-keychain-settings', kc], env)
    return true
  } catch {
    return false
  }
}

/**
 * Purge any stale locked keychain from an isolated account HOME directory.
 * Keychains from older versions (v0.4.41-v0.4.44) were provisioned with
 * ephemeral random passwords that cannot be unlocked with an empty password,
 * causing repeated modal password dialogs from macOS SecurityAgent.
 * We test whether the keychain settings can be updated silently without prompt.
 * If setting settings fails, the file is un-unlockable or corrupted, so it is
 * unregistered and purged so ensureIsolatedKeychain can cleanly re-provision it.
 */
export function purgeStaleIsolatedKeychain(
  dir: string,
  platform: string = process.platform,
  run: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => unknown = (file, args, env) =>
    execFileSync(file, args, { stdio: 'ignore', env, timeout: 5000 }),
): boolean {
  if (platform !== 'darwin') return false
  if (dir === '') return false
  const kc = join(dir, 'Library', 'Keychains', 'login.keychain-db')
  if (!existsSync(kc)) return false
  const env = { ...process.env, HOME: dir }
  try {
    // Attempt silent settings update without prompt
    run('security', ['set-keychain-settings', kc], env)
    return false // healthy and accessible, not stale
  } catch {
    // Failed to update settings — locked with unknown passphrase or corrupted
    try {
      run('security', ['delete-keychain', kc], env)
    } catch {
      // ignore
    }
    try {
      rmSync(kc, { force: true })
    } catch {
      // ignore
    }
    return true
  }
}

/**
 * macOS: Repair hijacked user-level keychain configuration.
 *
 * Versions prior to v0.4.49 set `security default-keychain -s <isolated-kc>`,
 * redirecting the user's desktop session default and login keychain into an
 * account-specific folder under ~/.dsh/agy-accounts/.
 *
 * This function detects if default-keychain, login-keychain, or the search list
 * (`list-keychains -d user`) point to any path containing `agy-accounts` or `.dsh`,
 * and restores them to the user's real login keychain (`~/Library/Keychains/login.keychain-db`).
 */
export function repairMacSystemKeychain(
  userHome: string = homedir(),
  platform: string = process.platform,
  run: (file: string, args: readonly string[], env?: NodeJS.ProcessEnv) => string = (file, args, env) =>
    execFileSync(file, args, { encoding: 'utf8', env: env ?? process.env, timeout: 5000 }),
): boolean {
  if (platform !== 'darwin') return false
  if (!userHome) return false

  let repaired = false
  const realCandidates = [
    join(userHome, 'Library', 'Keychains', 'login.keychain-db'),
    join(userHome, 'Library', 'Keychains', 'login.keychain'),
  ]
  const realKc = realCandidates.find((p) => existsSync(p))
  if (!realKc) return false

  const isIsolatedPath = (p: string) => /[\\/]\.dsh[\\/]agy-accounts[\\/]/i.test(p)
  const env = { ...process.env, HOME: userHome }

  try {
    const def = run('security', ['default-keychain'], env).trim().replace(/^"|"$/g, '')
    if (isIsolatedPath(def)) {
      run('security', ['default-keychain', '-s', realKc], env)
      repaired = true
    }
  } catch {
    // ignore
  }

  try {
    const loginkc = run('security', ['login-keychain'], env).trim().replace(/^"|"$/g, '')
    if (isIsolatedPath(loginkc)) {
      run('security', ['login-keychain', '-s', realKc], env)
      repaired = true
    }
  } catch {
    // ignore
  }

  try {
    const rawList = run('security', ['list-keychains', '-d', 'user'], env)
    const entries = rawList
      .split('\n')
      .map((l) => l.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
    const hasTainted = entries.some(isIsolatedPath)
    const hasReal = entries.includes(realKc)
    if (hasTainted || !hasReal) {
      const cleaned = entries.filter((p) => !isIsolatedPath(p))
      if (!cleaned.includes(realKc)) cleaned.unshift(realKc)
      const sysKc = '/Library/Keychains/System.keychain'
      if (!cleaned.includes(sysKc) && existsSync(sysKc)) {
        cleaned.push(sysKc)
      }
      run('security', ['list-keychains', '-d', 'user', '-s', ...cleaned], env)
      repaired = true
    }
  } catch {
    // ignore
  }

  return repaired
}

/**
 * Open an interactive terminal session inside the given account directory.
 * Supports macOS (Terminal.app via AppleScript), Windows (cmd.exe start),
 * and Linux (xdg-terminal-exec, x-terminal-emulator, gnome-terminal, konsole,
 * xfce4-terminal, alacritty, xterm across distributions).
 * Safe, non-blocking and non-throwing.
 */
export function openAccountTerminal(
  accDir: string,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: readonly string[], opts?: { windowsHide?: boolean }) => void = (file, args, opts) =>
    execFile(file, [...args], { windowsHide: opts?.windowsHide }, () => {}),
): boolean {
  if (!accDir) return false

  if (platform === 'darwin') {
    ensureIsolatedKeychain(accDir, platform)
    const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "export HOME='${accDir}'; agy"`
    try {
      run('osascript', ['-e', script])
      return true
    } catch {
      return false
    }
  }

  if (platform === 'win32') {
    try {
      run('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `set "HOME=${accDir}" && set "USERPROFILE=${accDir}" && agy`], { windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  // Linux: Try candidate terminal emulators across distros (FreeDesktop, Debian, GNOME, KDE, XFCE, etc.)
  const cmd = `export HOME='${accDir}'; agy; exec bash`
  const candidates: Array<{ bin: string; args: string[] }> = [
    { bin: 'xdg-terminal-exec', args: ['bash', '-c', cmd] },
    { bin: 'x-terminal-emulator', args: ['-e', `sh -c "export HOME='${accDir}'; agy; exec sh"`] },
    { bin: 'gnome-terminal', args: ['--', 'bash', '-c', cmd] },
    { bin: 'konsole', args: ['-e', 'bash', '-c', cmd] },
    { bin: 'xfce4-terminal', args: ['-e', `bash -c "${cmd}"`] },
    { bin: 'alacritty', args: ['-e', 'bash', '-c', cmd] },
    { bin: 'xterm', args: ['-e', 'bash', '-c', cmd] },
  ]

  for (const c of candidates) {
    try {
      run(c.bin, c.args)
      return true
    } catch {
      continue
    }
  }
  return false
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
      // Official Google installer default (irm .../install.ps1 | iex) — GH #7
      candidates.push(join(local, 'agy', 'bin', 'agy.exe'))
      candidates.push(join(local, 'agy', 'bin', 'agy.cmd'))
      candidates.push(join(local, 'agy', 'bin', 'agy.bat'))
      candidates.push(join(local, 'agy', 'agy.exe'))
      candidates.push(join(local, 'Programs', 'agy', 'agy.exe'))
      candidates.push(join(local, 'Programs', 'agy', 'bin', 'agy.exe'))
      candidates.push(join(local, 'Microsoft', 'WinGet', 'Links', 'agy.exe'))
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
  /**
   * Write this payload to stdin and close it (long-prompt transport).
   * Takes precedence over the default immediate stdin close; mutually
   * exclusive with keepStdin auth-code flows.
   */
  stdinPayload?: string;
  /**
   * Let stderr activity re-arm the idle watchdog. Off by default: agy logs
   * dial-retry noise to stderr forever when offline, which used to keep a
   * dead run "active" until the 240m print-timeout. Login flows opt in —
   * a browser login is legitimately silent on stdout for minutes.
   */
  stderrKeepalive?: boolean;
  /**
   * Pre-empt agy's own auto-updater before spawn (issue #49). Default true:
   * agy >= 1.4.2 spawns `--bg-updater`, whose `agy --version` grandchild
   * allocates a visible console window on Windows before any env switch can
   * apply. Refreshing `last_check.timestamp` keeps agy on its 15-minute fast
   * path so that chain never starts (see auto-updater.ts).
   */
  preemptAutoUpdate?: boolean;
}

export interface RunningProcess {
  child: ChildProcess;
  outcome: Promise<RunOutcome>;
  kill(reason: 'timeout' | 'abort'): void;
  /**
   * Re-arm the activity watchdog, optionally on a different idle budget.
   * Long-running tools (maven/compile, issue #33) go silent on stdout while
   * they work — the adapter raises the budget when a tool step is ACTIVE and
   * restores the normal budget when the tool completes.
   */
  noteActivity(budgetMs?: number): void;
}

const GRACE_MS = 5000;

/**
 * Windows CreateProcess caps the command line at ~32767 chars. Leave headroom
 * for env, cwd, quoting, and the rest of the argv so a long `-p` prompt does
 * not fail with spawn ENAMETOOLONG (issue #14 / #11). Above this, the prompt
 * rides agy `--input-format stream-json` on stdin instead.
 */
export const ARGV_PROMPT_LIMIT = 24_000;

/** One NDJSON line for agy --input-format stream-json (verified on agy 1.2.x). */
export function buildStreamInputLine(prompt: string): string {
  return JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

/**
 * Remove NUL characters from text destined for a child process.
 *
 * `spawn()` rejects any argv element containing U+0000 with
 * `ERR_INVALID_ARG_VALUE: The argument 'args[N]' must be a string without null
 * bytes`, which aborts the whole turn before agy is even started. NULs reach the
 * assembled prompt through binary tool output (a tool result that quoted a
 * binary file — `.git` objects, packed refs, images, …), so every prompt that
 * can carry tool text passes through here. Other control characters are legal in
 * argv and are left untouched.
 */
export function stripNulBytes(text: string): string {
  return text.includes('\u0000') ? text.split('\u0000').join('') : text;
}

/** Whether the assembled argv (including a trailing `-p <prompt>`) risks ENAMETOOLONG. */
export function shouldUsePromptStdin(argsWithPrompt: readonly string[]): boolean {
  let size = 0;
  for (const a of argsWithPrompt) size += a.length + 1;
  return size > ARGV_PROMPT_LIMIT;
}

/**
 * Quiet env for every agy spawn (issue #23).
 *
 * agy.exe itself creates a visible conhost on Windows — especially via its
 * `--bg-updater` auto-update child chain — even when the parent spawn used
 * `windowsHide: true`. Both switches are present in the official binary.
 * Existing values win so operators can opt out (`=0`).
 */
export function withAgyQuietEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    AGY_CLI_DISABLE_AUTO_UPDATE: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? '1',
    AGY_CLI_INTERACTIVE_HEADLESS: env.AGY_CLI_INTERACTIVE_HEADLESS ?? '1',
    AGY_CLI_NONINTERACTIVE_HEADLESS: env.AGY_CLI_NONINTERACTIVE_HEADLESS ?? '1',
    BROWSER: env.BROWSER ?? 'none',
    CI: env.CI ?? '1',
  };
}

// Children that already have a SIGKILL escalation armed (SIGTERM sent once).
const escalating = new WeakSet<ChildProcess>()

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
    return;
  }
  // agy installs graceful-shutdown handlers; a run wedged in a dial-retry
  // loop (offline) ignores SIGTERM forever, which made the UI Stop button
  // a no-op. Escalate to SIGKILL for the whole group shortly after.
  if (escalating.has(child)) return;
  escalating.add(child);
  const pid = child.pid;
  const escalate = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, 3000);
  escalate.unref?.();
  child.once('exit', () => {
    clearTimeout(escalate);
    escalating.delete(child);
  });
}

/**
 * Environment for spawning a script through `process.execPath`.
 *
 * In the packaged desktop host `process.execPath` is the **Electron binary**,
 * not node: without this flag the child would boot a second GUI instance
 * instead of executing the script. Plain node ignores the variable, so the
 * POSIX/test paths are unaffected.
 */
export function nodeScriptEnv<T extends object>(env: T): T & { ELECTRON_RUN_AS_NODE: string } {
  return { ...env, ELECTRON_RUN_AS_NODE: '1' }
}

export function startAgyProcess(opts: RunOptions): RunningProcess {
  const started = Date.now();
  const viaCmd = IS_WIN && isCmdShim(opts.bin)
  const isNode = IS_WIN && /\.(mjs|js|cjs)$/i.test(opts.bin)
  const env = withAgyQuietEnv(opts.env ?? process.env)
  // Issue #49: the quiet env cannot stop agy's internal `--bg-updater` child
  // (that chain allocates its own console), so pre-empt the update *check*
  // instead. Node-script spawns (the MCP bridge) never touch it.
  if (opts.preemptAutoUpdate !== false && !isNode) preemptAgyAutoUpdate(env)
  const child = viaCmd
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...opts.args].map(windowsQuote).join(' ')], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : isNode
      ? spawn(process.execPath, [opts.bin, ...opts.args], {
          cwd: opts.cwd,
          env: nodeScriptEnv(env),
          stdio: ['pipe', 'pipe', 'pipe'],
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

  // EPIPE on stdin arrives ASYNC as an 'error' event (the try/catch around
  // write/end only guards sync throws). Without a listener Node turns it into
  // an uncaughtException and kills the whole DSH host
  // (crash: WriteWrap.onWriteComplete write EPIPE). Swallow it — a dead child
  // is handled by the exit/close handlers below.
  child.stdin?.on('error', () => {});

  // agy reads stdin when it is a pipe and never sees EOF (observed on
  // 1.1.15: `agy models` hangs forever with an open pipe stdin, which is
  // why model discovery silently timed out). Close stdin immediately for
  // every spawn that does not explicitly need to write to it — unless a
  // stdinPayload was provided (long-prompt stream-json transport).
  if (opts.stdinPayload !== undefined) {
    try {
      child.stdin?.write(opts.stdinPayload);
      child.stdin?.end();
    } catch {
      // ignore — child may have exited already
    }
  } else if (!opts.keepStdin) {
    try {
      child.stdin?.end();
    } catch {
      // ignore — child may have exited already
    }
  }

  let watchdog: NodeJS.Timeout | null = null;
  let idleBudgetMs = opts.timeoutMs;
  const refreshWatchdog = () => {
    if (!idleBudgetMs || idleBudgetMs <= 0 || settled) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, idleBudgetMs);
  };
  refreshWatchdog();

  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  // No setEncoding('utf8') on purpose: the raw bytes are decoded line by line
  // through the console code page so Windows GBK tool output survives (issue #37).
  const stdoutDecoder = makeLineDecoder(consoleOutputEncoding());
  const stderrDecoder = makeLineDecoder(consoleOutputEncoding());
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    refreshWatchdog();
    const text = stdoutDecoder.push(chunk);
    if (text === '') return;
    stdout += text;
    if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      opts.onLine?.(line);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (opts.stderrKeepalive) refreshWatchdog();
    const text = stderrDecoder.push(chunk);
    if (text !== '') stderr = (stderr + text).slice(-4096);
  });

  const outcome = new Promise<RunOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', onAbort);
      // Flush the partial tails before settling: a final line without a
      // trailing newline must still be decoded (and parsed) exactly once.
      const stdoutTail = stdoutDecoder.flush();
      if (stdoutTail !== '') {
        stdout += stdoutTail;
        pending += stdoutTail;
      }
      const stderrTail = stderrDecoder.flush();
      if (stderrTail !== '') stderr = (stderr + stderrTail).slice(-4096);
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
    noteActivity: (budgetMs?: number) => {
      if (budgetMs !== undefined) idleBudgetMs = budgetMs;
      refreshWatchdog();
    },
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
  preemptAutoUpdate?: boolean,
): Promise<RunOutcome> {
  const p = startAgyProcess({ bin, args, timeoutMs, signal, env, preemptAutoUpdate });
  return p.outcome;
}

