// Spawning the `agy acp` child process.
//
// Split out of client.ts (which is at its module budget) and, more importantly,
// because the spawn flags are a kill-semantics decision: on POSIX the server must
// lead its OWN process group so `killTree()` can reach agy's helpers (MCP
// servers, task shells) with a single group signal. See ./strays.ts for the
// reconciliation that catches anything that still slips through.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateDir } from '../../common/config.ts'
import type { PermissionMode } from '../../common/types.ts'
import { defaultMediaDir } from '../../host/media.ts'
import { defaultContextTransferDir } from '../../provider/context-delivery.ts'
import { isCmdShim, windowsQuote } from '../../runtime/agy/bin.ts'
import { nodeScriptEnv } from '../../runtime/agy/env.ts'

export interface AcpSpawnOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
}

export interface AcpArgsOptions {
  permissionMode: PermissionMode
  sandbox?: boolean
  agent?: string
  addDirs?: readonly string[]
}

/**
 * Build CLI arguments for spawning a persistent `agy acp` process.
 *
 * Pre-mounts `<state>/context-transfer` and `<state>/media` (plus any custom
 * `addDirs`, e.g. custom `mediaDir`) via `--add-dir` so resumed/loaded ACP
 * sessions in non-`skip` permission modes have the same read access to archive
 * digests and staged media as CLI `-p` runs.
 */
export function buildAcpSpawnArgs(opts: AcpArgsOptions, logFile: string): string[] {
  const args = ['acp', '--disable-telemetry']
  if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
  if (opts.sandbox) args.push('--sandbox')
  if (opts.agent && opts.agent.trim() !== '') args.push('--agent', opts.agent.trim())
  const baseState = stateDir()
  const dirs = new Set<string>([defaultContextTransferDir(baseState), defaultMediaDir(baseState)])
  for (const d of opts.addDirs ?? []) {
    const trimmed = d.trim()
    if (trimmed !== '') dirs.add(trimmed)
  }
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true })
      args.push('--add-dir', dir)
    } catch {
      // Unwritable directory must not block ACP transport startup.
    }
  }
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    args.push('--log-file', logFile)
  } catch {
    // An unwritable log path must not block the transport: the classifier
    // simply gets no log evidence for this process.
  }
  return args
}

/** Compute the per-process `acp-*.log` path under `<state>/logs` unless overridden. */
export function resolveAcpLogFile(explicit?: string, logDir?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const dir = logDir !== undefined && logDir !== '' ? logDir : join(stateDir(), 'logs')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  const rand = Math.random().toString(36).slice(2, 8)
  return join(dir, `acp-${stamp}-${rand}.log`)
}

export function spawnAcpChild(
  opts: AcpSpawnOptions,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const isWin = process.platform === 'win32'
  // Windows has no Unix process groups; `taskkill /T /F` walks the tree instead.
  const detached = !isWin
  if (isWin && isCmdShim(opts.bin)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...args].map(windowsQuote).join(' ')], {
      cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true,
    })
  }
  if (/\.(?:m?js|cjs)$/i.test(opts.bin)) {
    return spawn(process.execPath, [opts.bin, ...args], {
      cwd: opts.cwd, env: nodeScriptEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached,
    })
  }
  return spawn(opts.bin, [...args], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached })
}
