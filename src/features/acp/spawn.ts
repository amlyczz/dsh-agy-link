// Spawning the `agy acp` child process.
//
// Split out of client.ts (which is at its module budget) and, more importantly,
// because the spawn flags are a kill-semantics decision: on POSIX the server must
// lead its OWN process group so `killTree()` can reach agy's helpers (MCP
// servers, task shells) with a single group signal. See ./strays.ts for the
// reconciliation that catches anything that still slips through.
import { spawn, type ChildProcess } from 'node:child_process'
import { isCmdShim, windowsQuote } from '../../runtime/agy/bin.ts'
import { nodeScriptEnv } from '../../runtime/agy/env.ts'

export interface AcpSpawnOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
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
