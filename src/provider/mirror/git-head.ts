// Committed HEAD content for full-file write diffs.
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h).
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_ROOT_CACHE = 128
const gitRootCache = new Map<string, { root: string | null; at: number }>()
const ROOT_CACHE_TTL_MS = 60_000

function getCachedRoot(dir: string): string | null | undefined {
  const hit = gitRootCache.get(dir)
  if (!hit) return undefined
  if (Date.now() - hit.at > ROOT_CACHE_TTL_MS) {
    gitRootCache.delete(dir)
    return undefined
  }
  return hit.root
}

function setCachedRoot(dir: string, root: string | null): void {
  if (gitRootCache.size >= MAX_ROOT_CACHE) {
    const oldest = gitRootCache.keys().next()
    if (!oldest.done) gitRootCache.delete(oldest.value)
  }
  gitRootCache.set(dir, { root, at: Date.now() })
}

/**
 * Retrieve the committed HEAD content of a file via git, for computing
 * line diffs on full-file writes. Pure & safe: catches all failures (not in git,
 * untracked, git missing, binary) and returns null in <=500ms.
 */
export function getGitHeadContent(filePath: string, execFn = execFileSync): string | null {
  if (!filePath || typeof filePath !== 'string' || filePath === 'file') return null
  try {
    const resolved = path.resolve(filePath)
    const dir = path.dirname(resolved)
    let root = execFn === execFileSync ? getCachedRoot(dir) : undefined
    if (root === undefined) {
      const toplevel = execFn('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 500,
        windowsHide: true,
      })
      root = typeof toplevel === 'string' && toplevel.trim() !== '' ? toplevel.trim() : null
      if (execFn === execFileSync) setCachedRoot(dir, root)
    }
    if (!root) return null
    const relPath = path.relative(root, resolved).replace(/\\/g, '/')
    if (relPath.startsWith('..')) return null
    const content = execFn('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      windowsHide: true,
    })
    const str = typeof content === 'string' ? content : ''
    if (str.includes('\u0000')) return null
    return str
  } catch {
    return null
  }
}

export type AsyncExecFileFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; encoding: 'utf-8'; timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>

/**
 * Non-blocking version of {@link getGitHeadContent} for async span processing.
 * Caches git toplevel resolution per parent directory so repeated writes do
 * not spawn redundant `git rev-parse` calls or block the Node event loop.
 */
export async function getGitHeadContentAsync(
  filePath: string,
  execFn: AsyncExecFileFn = execFileAsync as unknown as AsyncExecFileFn,
): Promise<string | null> {
  if (!filePath || typeof filePath !== 'string' || filePath === 'file') return null
  try {
    const resolved = path.resolve(filePath)
    const dir = path.dirname(resolved)
    let root = execFn === (execFileAsync as unknown as AsyncExecFileFn) ? getCachedRoot(dir) : undefined
    if (root === undefined) {
      const res = await execFn('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 500,
        windowsHide: true,
      })
      root = typeof res.stdout === 'string' && res.stdout.trim() !== '' ? res.stdout.trim() : null
      if (execFn === (execFileAsync as unknown as AsyncExecFileFn)) setCachedRoot(dir, root)
    }
    if (!root) return null
    const relPath = path.relative(root, resolved).replace(/\\/g, '/')
    if (relPath.startsWith('..')) return null
    const contentRes = await execFn('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 500,
      windowsHide: true,
    })
    const str = typeof contentRes.stdout === 'string' ? contentRes.stdout : ''
    if (str.includes('\u0000')) return null
    return str
  } catch {
    return null
  }
}