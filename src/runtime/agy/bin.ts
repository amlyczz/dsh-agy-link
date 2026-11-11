// agy executable discovery, shim handling and version parsing.
//
// MOVED VERBATIM from src/host/runner.ts (Phase 5h). Candidate order and the
// "prefer a real executable over a cmd shim" ranking are unchanged.
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { PluginConfig } from '../../common/types.ts'

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
  const candidates: string[] = []
  if (cfg.agyBin !== '') candidates.push(cfg.agyBin)
  const pathEnv = process.env.PATH ?? ''
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
  const hits: string[] = []
  for (const c of candidates) {
    try {
      accessSync(c, constants.F_OK)
      hits.push(c)
    } catch {
      continue
    }
  }
  return hits.find((h) => !isCmdShim(h)) ?? hits[0] ?? null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/\./).map(Number)
  const pb = b.split(/\./).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

export function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+\.\d+)/)
  return m?.[1] ?? null
}