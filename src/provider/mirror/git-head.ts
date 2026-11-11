// Committed HEAD content for full-file write diffs.
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h).
import { execFileSync } from 'node:child_process'
import path from 'node:path'

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
    const toplevel = execFn('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      windowsHide: true,
    })
    const root = typeof toplevel === 'string' ? toplevel.trim() : ''
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