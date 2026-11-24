/**
 * Helpers for preserving a leading agy slash command (`/plan`, `/swarm`, etc.)
 * at character index 0 when prompt assembly attaches system instructions or a
 * rolling context digest. Only single-segment `/command` tokens match; POSIX paths
 * (`/etc/hosts`, `/plan/file.ts`) are untouched.
 */
export interface LeadingAgySlash {
  commandLine: string
  rest: string
}

const LEADING_SLASH_RE = /^(\/[a-z][a-z0-9_-]*)(?:[ \t]+([^\r\n]*))?(?:\r?\n([\s\S]*))?$/i

export function extractLeadingAgySlash(prompt: string): LeadingAgySlash | null {
  const trimmed = prompt.trimStart()
  if (!trimmed.startsWith('/')) return null
  const m = LEADING_SLASH_RE.exec(trimmed)
  if (!m) return null
  const cmd = m[1]!
  const inlineArgs = (m[2] ?? '').trim()
  const rest = (m[3] ?? '').trim()
  return {
    commandLine: inlineArgs !== '' ? `${cmd} ${inlineArgs}` : cmd,
    rest,
  }
}

export function formatWithLeadingAgySlash(slash: LeadingAgySlash, contextBody: string): string {
  return [slash.commandLine, slash.rest, contextBody.trim()].filter((s) => s !== '').join('\n\n')
}
