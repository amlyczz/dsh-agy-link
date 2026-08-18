// Edit-tool diff rendering (spec P1, pi-bridge diff-render adapted): when
// agy edits a file, annotate the tool activity in the reasoning stream with
// a git-sourced diff so the user sees what changed without leaving DSH.
import { execFileSync } from 'node:child_process'

const FILE_KEYS = ['file_path', 'filePath', 'path', 'file', 'filename', 'target_file', 'absolute_path']

function pickFile(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const o = args as Record<string, unknown>
  for (const k of FILE_KEYS) {
    const v = o[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

function looksLikeEditTool(name: string): boolean {
  const n = name.toLowerCase()
  return n.includes('write') || n.includes('edit') || n.includes('replace') || n.includes('str_replace')
}

export function renderToolActivity(
  name: string,
  args: unknown,
  output: unknown,
  cwd: string,
): string | null {
  const parts: string[] = []
  if (looksLikeEditTool(name)) {
    const file = pickFile(args)
    if (file) {
      const diff = gitDiff(file, cwd)
      if (diff !== null) parts.push('[agy edit: ' + file + ']\n' + diff)
    }
  }
  if (output !== undefined && output !== null) {
    let s: string
    try {
      s = typeof output === 'string' ? output : JSON.stringify(output)
    } catch {
      s = String(output)
    }
    if (s !== '') parts.push('-> ' + (s.length > 2048 ? s.slice(0, 2048) + '...' : s))
  }
  return parts.length === 0 ? null : parts.join('\n') + '\n'
}

function gitDiff(file: string, cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'diff', 'HEAD', '--', file], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_000_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (out.trim() === '') return null
    const lines = out.split('\n').slice(0, 100)
    return lines.join('\n')
  } catch {
    return null
  }
}
