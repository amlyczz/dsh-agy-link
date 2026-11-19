// Process runner facade (spec ADR-3): every request spawns a short-lived
// `agy -p` process as its own process group; abort and watchdog kill the
// whole tree (agy re-spawns exec children). stderr is captured as a tail
// for error attribution; stdout is streamed line-by-line to the caller.
//
// Phase 5h moved the implementation into src/runtime/agy/:
//   console.ts   console code-page decoding
//   bin.ts       executable discovery, cmd shims, version parsing
//   env.ts       isolated HOME / proxy / quiet env
//   keychain.ts  macOS isolated keychains, terminal launcher
//   process.ts   spawn, stdin, watchdog, kill tree, outcome
// The exports and signatures below are unchanged.
import { execFile } from 'node:child_process'
import { ensureIsolatedKeychain } from '../runtime/agy/keychain.ts'

export {
  consoleOutputEncoding,
  decodeConsoleLine,
} from '../runtime/agy/console.ts'
export {
  agyBinCandidates,
  agyBinDiagnostics,
  binCandidates,
  compareVersions,
  isCmdShim,
  MIN_AGY_VERSION,
  parseVersion,
  resolveAgyBin,
  windowsQuote,
  type AgyBinDiagnostics,
} from '../runtime/agy/bin.ts'
export {
  isolatedHomeEnv,
  linuxDbusDisabledEnv,
  nodeScriptEnv,
  proxyEnvFor,
  withAgyQuietEnv,
} from '../runtime/agy/env.ts'
export {
  ensureIsolatedKeychain,
  purgeStaleIsolatedKeychain,
  repairMacSystemKeychain,
} from '../runtime/agy/keychain.ts'
export {
  ARGV_PROMPT_LIMIT,
  buildStreamInputLine,
  probeProcess,
  shouldUsePromptStdin,
  startAgyProcess,
  stripNulBytes,
  type RunOptions,
  type RunOutcome,
  type RunningProcess,
} from '../runtime/agy/process.ts'
/**
 * Open an interactive terminal session inside the given account directory.
 * Supports macOS (Terminal.app via AppleScript), Windows (cmd.exe start),
 * and Linux (xdg-terminal-exec, x-terminal-emulator, gnome-terminal, konsole,
 * xfce4-terminal, alacritty, xterm across distributions).
 * Safe, non-blocking and non-throwing.
 */
function shSingleQuote(val: string): string {
  return `'${val.replace(/'/g, `'\\''`)}'`
}

export function openAccountTerminal(
  accDir: string,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: readonly string[], opts?: { windowsHide?: boolean }) => void = (file, args, opts) =>
    execFile(file, [...args], { windowsHide: opts?.windowsHide }, () => {}),
): boolean {
  if (!accDir || /[\r\n\0]/.test(accDir)) return false

  if (platform === 'darwin') {
    ensureIsolatedKeychain(accDir, platform)
    const shellCmd = `export HOME=${shSingleQuote(accDir)}; agy`
    const escapedApple = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `tell application "Terminal" to activate\ntell application "Terminal" to do script "${escapedApple}"`
    try {
      run('osascript', ['-e', script])
      return true
    } catch {
      return false
    }
  }

  if (platform === 'win32') {
    if (accDir.includes('"')) return false
    try {
      run('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `set "HOME=${accDir}" && set "USERPROFILE=${accDir}" && agy`], { windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  const cmd = `export HOME=${shSingleQuote(accDir)}; agy; exec bash`
  const candidates: Array<{ bin: string; args: string[] }> = [
    { bin: 'xdg-terminal-exec', args: ['bash', '-c', cmd] },
    { bin: 'x-terminal-emulator', args: ['-e', 'sh', '-c', `export HOME=${shSingleQuote(accDir)}; agy; exec sh`] },
    { bin: 'gnome-terminal', args: ['--', 'bash', '-c', cmd] },
    { bin: 'konsole', args: ['-e', 'bash', '-c', cmd] },
    { bin: 'xfce4-terminal', args: ['-x', 'bash', '-c', cmd] },
    { bin: 'alacritty', args: ['-e', 'bash', '-c', cmd] },
    { bin: 'xterm', args: ['-e', 'bash', '-c', cmd] },
  ]

  // If caller injected a custom test runner, keep synchronous candidate check;
  // otherwise walk candidates asynchronously on ENOENT so missing xdg-terminal-exec falls back cleanly.
  if (run !== undefined && run.toString() !== ((file: string, args: readonly string[], opts?: { windowsHide?: boolean }) => execFile(file, [...args], { windowsHide: opts?.windowsHide }, () => {})).toString()) {
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
  const tryAt = (idx: number): void => {
    const c = candidates[idx]
    if (!c) return
    const child = execFile(c.bin, c.args, (err) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        tryAt(idx + 1)
      }
    })
    child.unref?.()
  }
  tryAt(0)
  return true
}
