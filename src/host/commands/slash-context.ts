// Pure session history, live-run progress, workspace resolution, and JSON payload
// extraction helpers shared by `/agy` slash-command bridges.
import type { CommandContext, CommandDeps } from './shared.ts'

export interface SessionEventLike {
  type?: string
  data?: unknown
}

export interface SessionLike {
  header?: { cwd?: string }
  log?: readonly SessionEventLike[]
  events?: readonly SessionEventLike[]
  snapshotEvents?: () => readonly SessionEventLike[]
  ownEvents?: () => readonly SessionEventLike[]
}

const MAX_CONTEXT_CHARS = 16_000

function tryParseObj(raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function messageTextFromEvent(ev: SessionEventLike): string {
  const d = ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : {}
  const msg = d.message && typeof d.message === 'object' ? (d.message as Record<string, unknown>) : d
  const content = msg.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const blk of content) {
      if (blk && typeof blk === 'object') {
        const b = blk as { type?: unknown; text?: unknown }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
          parts.push(b.text.trim())
        }
      }
    }
    return parts.join('\n')
  }
  return typeof d.text === 'string' ? d.text.trim() : ''
}

function summarizeToolTarget(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const a = args as Record<string, unknown>
  for (const key of [
    'Path', 'TargetFile', 'File', 'AbsolutePath', 'SearchPath', 'DirectoryPath',
    'CommandLine', 'Pattern', 'Query', 'Url', 'path', 'file', 'command',
    'Prompt', 'prompt', 'Role', 'role',
  ]) {
    const v = a[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const flat = v.trim().replace(/\s+/g, ' ')
      return flat.length > 90 ? flat.slice(0, 90) + '…' : flat
    }
  }
  return ''
}

function formatToolCallEvent(ev: SessionEventLike): string {
  const d = ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : {}
  const toolObj =
    d.tool && typeof d.tool === 'object'
      ? (d.tool as Record<string, unknown>)
      : (d.call && typeof d.call === 'object' ? (d.call as Record<string, unknown>) : d)
  let name = typeof toolObj.toolName === 'string'
    ? toolObj.toolName
    : (typeof toolObj.name === 'string' ? toolObj.name : '')
  const rawArgs = toolObj.arguments ?? toolObj.args ?? toolObj.argsRaw
  let args: unknown = typeof rawArgs === 'string' ? (tryParseObj(rawArgs) ?? rawArgs) : rawArgs
  if (name === 'agy_tool' && args && typeof args === 'object' && !Array.isArray(args)) {
    const inner = args as Record<string, unknown>
    if (typeof inner.tool === 'string' && inner.tool !== '') name = inner.tool
    else if (typeof inner.toolName === 'string' && inner.toolName !== '') name = inner.toolName
    else if (typeof inner.name === 'string' && inner.name !== '') name = inner.name
    const unwrappedArgs = inner.input !== undefined ? inner.input : inner.args
    if (unwrappedArgs !== undefined) {
      args = typeof unwrappedArgs === 'string' ? (tryParseObj(unwrappedArgs) ?? unwrappedArgs) : unwrappedArgs
    }
  }
  if (!name) return ''
  const target = summarizeToolTarget(args)
  return target ? `Tool: ${name}(${target})` : `Tool: ${name}`
}

export function extractRecentHistory(session: SessionLike | undefined): string {
  if (!session) return ''
  const events = session.snapshotEvents?.() ?? session.ownEvents?.() ?? session.log ?? session.events
  if (!Array.isArray(events) || events.length === 0) return ''
  let goalLine = ''
  const lines: string[] = []
  const toolLines: string[] = []
  for (const ev of events) {
    if (!ev) continue
    if (ev.type === 'goal/change' && ev.data && typeof ev.data === 'object') {
      const d = ev.data as { operation?: string; goal?: { objective?: string; phase?: string }; roundsStarted?: number }
      if (d.operation === 'clear') goalLine = ''
      else if (d.goal?.objective) {
        const roundNote = typeof d.roundsStarted === 'number' ? `, round ${d.roundsStarted}` : ''
        goalLine = `Active Goal (${d.goal.phase || 'active'}${roundNote}): ${d.goal.objective}`
      }
      continue
    }
    if (ev.type === 'tool/call') {
      const formatted = formatToolCallEvent(ev)
      if (formatted) {
        toolLines.push(formatted)
        if (toolLines.length > 15) toolLines.shift()
      }
      continue
    }
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const text = messageTextFromEvent(ev)
    if (text === '' || text.startsWith('<system-reminder>') || text.startsWith('Time sampled while preparing')) continue
    const role = ev.type === 'user/message' ? 'User' : 'Assistant'
    const clipped = text.length > 2_000 ? text.slice(0, 2_000) + '…' : text
    lines.push(`${role}: ${clipped}`)
  }
  if (toolLines.length > 0) {
    lines.push(`Recent Tools (${toolLines.length}):\n` + toolLines.join('\n'))
  }
  const budget = goalLine ? MAX_CONTEXT_CHARS - goalLine.length - 2 : MAX_CONTEXT_CHARS
  let acc = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = lines[i]! + (acc === '' ? '' : '\n\n' + acc)
    if (next.length > budget) break
    acc = next
  }
  if (goalLine) return acc ? `${goalLine}\n\n${acc}` : goalLine
  return acc
}

export function extractLiveRunProgress(deps: CommandDeps, sessionId?: string): string {
  if (!sessionId) return ''
  const run = deps.activeRun?.(sessionId)
  if (!run || run.isSettled || run.length === 0) return ''
  const start = Math.max(0, run.length - 80)
  const items: string[] = []
  let textTail = ''
  for (let i = start; i < run.length; i++) {
    const ev = run.eventAt(i)
    if (!ev || ev.kind !== 'step') continue
    if (ev.stepKind === 'tool' && ev.tool) {
      const target = summarizeToolTarget(ev.tool.args)
      const st = ev.state ? ` [${ev.state}]` : ''
      const errNote = ev.tool.error ? ` error=${ev.tool.error.slice(0, 120)}` : ''
      items.push(`- ${ev.tool.name}${target ? `(${target})` : ''}${st}${errNote}`)
    } else if (ev.stepKind === 'subagent' && ev.text.trim() !== '') {
      items.push(`- [subagent] ${ev.text.trim().slice(0, 200)}`)
    } else if (ev.stepKind === 'text' && ev.text !== '') {
      textTail = (textTail + ev.text).slice(-600)
    }
  }
  const recentItems = items.slice(-20)
  const parts: string[] = []
  if (run.conversationId) parts.push(`Live agy conversation: ${run.conversationId}`)
  if (recentItems.length > 0) parts.push('Recent in-flight steps:\n' + recentItems.join('\n'))
  if (textTail.trim() !== '') parts.push('Latest partial output:\n' + textTail.trim())
  const joined = parts.join('\n\n')
  return joined.length > 3_500 ? joined.slice(-3_500) : joined
}

/** Resolve explicit `cfg().workspaceRoot`, falling back to session `header.cwd` (undefined when neither is set). */
export function resolveSessionWorkspace(deps: CommandDeps, ctx: CommandContext): string | undefined {
  const cfgRoot = deps.cfg().workspaceRoot.trim()
  if (cfgRoot !== '') return cfgRoot
  const sessionId = ctx.invocation?.agent?.id ? String(ctx.invocation.agent.id) : undefined
  const session = (ctx.invocation?.agent?.session as SessionLike | undefined)
    ?? (deps.sessions?.() && sessionId ? (deps.sessions()!.get(sessionId) as SessionLike | undefined) : undefined)
  const sessionCwd = typeof session?.header?.cwd === 'string' ? session.header.cwd.trim() : ''
  return sessionCwd !== '' ? sessionCwd : undefined
}

export function resolveSessionContext(deps: CommandDeps, ctx: CommandContext): {
  sessionId?: string
  session?: SessionLike
  workspaceRoot: string
  historyText: string
} {
  const sessionId = ctx.invocation?.agent?.id ? String(ctx.invocation.agent.id) : undefined
  const session = (ctx.invocation?.agent?.session as SessionLike | undefined)
    ?? (deps.sessions?.() && sessionId ? (deps.sessions()!.get(sessionId) as SessionLike | undefined) : undefined)
  const workspaceRoot = resolveSessionWorkspace(deps, ctx) || process.cwd()
  const historyText = extractRecentHistory(session)
  return { sessionId, session, workspaceRoot, historyText }
}

function extractLastJsonObject(text: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null
  let i = 0
  while (i < text.length) {
    if (text[i] !== '{') {
      i++
      continue
    }
    let depth = 0
    let inStr = false
    let esc = false
    let closed = false
    let j = i
    for (; j < text.length; j++) {
      const ch = text[j]!
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          closed = true
          const parsed = tryParseObj(text.slice(i, j + 1))
          if (parsed) found = parsed
          break
        }
      }
    }
    i = closed ? j + 1 : i + 1
  }
  return found
}

export function parseJsonPayload(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const direct = tryParseObj(trimmed)
  if (direct) return direct

  const jsonFences = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)]
  for (let k = jsonFences.length - 1; k >= 0; k--) {
    const parsed = tryParseObj((jsonFences[k]?.[1] ?? '').trim())
    if (parsed) return parsed
  }

  const embedded = extractLastJsonObject(trimmed)
  if (embedded) return embedded

  const bareFence = trimmed.match(/```\s*(\{[\s\S]*?\})\s*```/)
  return bareFence?.[1] ? tryParseObj(bareFence[1].trim()) : null
}
