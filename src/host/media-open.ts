// Local OS file opener (`POST /plugins/agy-link/open`), strictly loopback/desktop-gated
// and workspace-confined so remote browsers can never pop up host OS windows.
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  isRemoteOpenBlocked,
  type ConnectionTrustLike,
  type HttpRequestLike,
  type HttpResponseLike,
} from './media-http.ts'

export interface OpenFileDeps {
  resolveLocalMediaPath: (rawPath: string, workspaceRoots?: string | readonly string[]) => string | null
  isConfinementAllowed: (filePath: string, workspaceRoots?: string | readonly string[]) => boolean
}

const DANGEROUS_OPEN_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.msix', '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.scr', '.pif', '.hta',
  '.cpl', '.lnk', '.url', '.reg', '.sh', '.bash', '.zsh', '.command', '.app',
  '.action', '.workflow', '.apk', '.jar', '.dll', '.sys', '.drv',
])

/**
 * Launch one detached OS opener without letting a launch failure kill the host.
 *
 * `spawn()` reports a missing (ENOENT) or non-executable (EACCES) target
 * asynchronously as an `error` event, so a surrounding try/catch never sees it:
 * with no listener Node raises an `uncaughtException` and the whole dsh process
 * exits. On a headless Linux host every "open in app" click therefore killed the
 * server (systemd then restarted it), because `xdg-open` is not installed.
 *
 * The listener is the entire point of this helper: it turns a launch failure
 * into a silent no-op instead of a process-killing exception. A synchronous
 * throw still reports `false` so callers can answer with an error.
 *
 * @param command executable path or PATH name.
 * @param args argv (never a shell string).
 * @param spawnImpl injection seam for tests.
 * @returns true when the child was started, false when spawn threw synchronously.
 */
export function spawnDetachedOpener(
  command: string,
  args: readonly string[],
  spawnImpl: typeof spawn = spawn,
): boolean {
  try {
    const child = spawnImpl(command, [...args], { detached: true, stdio: 'ignore' })
    // Must be attached before the first tick: the error is emitted asynchronously.
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * Open `targetPath` with the platform handler, or reveal it in the file manager.
 *
 * A path that no longer exists must never reach the OS opener: on Windows,
 * `explorer.exe /select,<missing>` does not fail, it silently opens the Desktop
 * folder instead, so a stale click looks like the plugin randomly opening the
 * user's Desktop. Fail fast and let the route answer with a real error.
 *
 * @param opener injection seam for tests: a unit test must never launch a real
 *   Explorer / Finder / xdg-open on the developer's machine.
 */
export function executeOpenInSystem(
  targetPath: string,
  reveal = false,
  opener: typeof spawnDetachedOpener = spawnDetachedOpener,
): { ok: boolean; error?: string } {
  try {
    if (!existsSync(targetPath)) {
      return { ok: false, error: 'target does not exist: ' + targetPath }
    }
    if (process.platform === 'darwin') {
      if (!opener('open', reveal ? ['-R', targetPath] : [targetPath])) {
        return { ok: false, error: 'failed to launch the system opener' }
      }
      return { ok: true }
    }
    if (process.platform === 'win32') {
      if (reveal) {
        if (!opener('explorer.exe', [`/select,${targetPath}`])) {
          return { ok: false, error: 'failed to launch explorer.exe' }
        }
        return { ok: true }
      }

      // Pass path via environment variable ($env:AGY_OPEN_TARGET) with -LiteralPath
      // so `$()` / backticks / quotes in filenames can NEVER execute PowerShell code.
      try {
        const res = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -LiteralPath $env:AGY_OPEN_TARGET -ErrorAction Stop'],
          {
            timeout: 4000,
            encoding: 'utf-8',
            windowsHide: true,
            env: { ...process.env, AGY_OPEN_TARGET: targetPath },
          },
        )
        if (res.status === 0) return { ok: true }
      } catch {
        // Fall back below
      }

      const ext = extname(targetPath).toLowerCase()
      if (['.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.ts', '.js', '.py', '.gd', '.log'].includes(ext)) {
        if (opener('notepad.exe', [targetPath])) return { ok: true }
      }

      if (!opener('explorer.exe', [`/select,${targetPath}`])) {
        return { ok: false, error: 'failed to launch explorer.exe' }
      }
      return { ok: true }
    }
    if (!opener('xdg-open', [targetPath])) {
      return { ok: false, error: 'failed to launch xdg-open' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Handle POST /plugins/agy-link/open?path=...&reveal=1
 * Strictly POST-only, loopback/desktop-only, and workspace-confined.
 */
export function handleOpenFileWithDeps(
  req: HttpRequestLike,
  res: HttpResponseLike,
  deps: OpenFileDeps,
  opts: { workspaceRoots?: string | readonly string[]; connection?: ConnectionTrustLike } = {},
): void {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'POST only' }))
    return
  }
  const authRejection = opts.connection?.requestRejection({ headers: req.headers ?? {} })
  if (authRejection !== undefined) {
    res.writeHead(authRejection, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: authRejection === 401 ? 'authentication required' : 'cross-origin open denied' }))
    return
  }
  if (isRemoteOpenBlocked(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'cross-origin or remote open denied: host desktop launch is disabled for remote browsers' }))
    return
  }

  let targetPath = ''
  let reveal = false
  try {
    const u = new URL(req.url ?? '', 'http://localhost')
    targetPath = u.searchParams.get('path') ?? u.searchParams.get('url') ?? ''
    reveal = u.searchParams.get('reveal') === '1' || u.searchParams.get('reveal') === 'true'
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'invalid url' }))
    return
  }

  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'missing path query parameter' }))
    return
  }

  const filePath = deps.resolveLocalMediaPath(targetPath, opts.workspaceRoots)
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'file not found' }))
    return
  }
  if (!deps.isConfinementAllowed(filePath, opts.workspaceRoots)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'access denied: path outside allowed workspace roots' }))
    return
  }

  if (!reveal && DANGEROUS_OPEN_EXTS.has(extname(filePath).toLowerCase())) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'access denied: executable file type requires reveal=1' }))
    return
  }

  const result = executeOpenInSystem(filePath, reveal)
  if (!result.ok) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: result.error }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, path: filePath, revealed: reveal }))
}
