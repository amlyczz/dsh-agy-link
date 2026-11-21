// /agy slash-command bridges: btw, fork, grill / grill-me, learn, and compact.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { writeFileAtomicSync } from '../../common/atomic-write.ts'
import { stateDir } from '../../common/config.ts'
import { err, ok, type CommandContext, type CommandDeps } from './shared.ts'

interface SessionEventLike {
  type?: string
  data?: unknown
}

interface SessionLike {
  header?: { cwd?: string }
  log?: readonly SessionEventLike[]
  events?: readonly SessionEventLike[]
  snapshotEvents?: () => readonly SessionEventLike[]
  ownEvents?: () => readonly SessionEventLike[]
}

export interface ForkCheckpoint {
  id: string
  conversationId: string
  bindingKey: string
  model?: string
  label?: string
  createdAt: number
}

const MAX_CONTEXT_CHARS = 16_000
const MAX_FORKS_PER_SESSION = 20

const LEARN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'name', 'summary', 'content'],
  properties: {
    kind: { type: 'string', enum: ['skill', 'rule'] },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
    summary: { type: 'string' },
    content: { type: 'string' },
  },
}

function extractAfterSub(ctx: CommandContext, sub: string): string {
  const raw = (ctx.raw ?? '').trim()
  if (raw !== '') {
    const stripped = raw.replace(/^\/agy\s+/i, '').trim()
    const re = new RegExp(`^${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i')
    if (re.test(stripped)) return stripped.replace(re, '').trim()
  }
  return ctx.parts.slice(1).join(' ').trim()
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

function extractRecentHistory(session: SessionLike | undefined): string {
  if (!session) return ''
  const events = session.snapshotEvents?.() ?? session.ownEvents?.() ?? session.log ?? session.events
  if (!Array.isArray(events) || events.length === 0) return ''
  const lines: string[] = []
  for (const ev of events) {
    if (!ev || (ev.type !== 'user/message' && ev.type !== 'assistant/message')) continue
    const text = messageTextFromEvent(ev)
    if (text === '' || text.startsWith('<system-reminder>') || text.startsWith('Time sampled while preparing')) continue
    const role = ev.type === 'user/message' ? 'User' : 'Assistant'
    const clipped = text.length > 2_000 ? text.slice(0, 2_000) + '…' : text
    lines.push(`${role}: ${clipped}`)
  }
  let acc = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = lines[i]! + (acc === '' ? '' : '\n\n' + acc)
    if (next.length > MAX_CONTEXT_CHARS) break
    acc = next
  }
  return acc
}

function resolveSessionContext(deps: CommandDeps, ctx: CommandContext): {
  sessionId?: string
  session?: SessionLike
  workspaceRoot: string
  historyText: string
} {
  const sessionId = ctx.invocation?.agent?.id ? String(ctx.invocation.agent.id) : undefined
  const session = (ctx.invocation?.agent?.session as SessionLike | undefined)
    ?? (deps.sessions?.() && sessionId ? (deps.sessions()!.get(sessionId) as SessionLike | undefined) : undefined)
  const workspaceRoot = session?.header?.cwd || deps.cfg().workspaceRoot || process.cwd()
  const historyText = extractRecentHistory(session)
  return { sessionId, session, workspaceRoot, historyText }
}

function readForkStore(file: string): Record<string, ForkCheckpoint[]> {
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, ForkCheckpoint[]>)
      : {}
  } catch {
    return {}
  }
}

function saveForkCheckpoint(file: string, forksKey: string, cp: ForkCheckpoint): void {
  mkdirSync(dirname(file), { recursive: true })
  const data = readForkStore(file)
  const list = Array.isArray(data[forksKey]) ? [...data[forksKey]!] : []
  list.unshift(cp)
  data[forksKey] = list.slice(0, MAX_FORKS_PER_SESSION)
  writeFileAtomicSync(file, JSON.stringify(data, null, 2))
}

function findSessionBindingEntries(deps: CommandDeps, sessionId?: string): Array<[string, NonNullable<ReturnType<ReturnType<CommandDeps['store']>['get']>>]> {
  const all = deps.store().all()
  const entries = Object.entries(all).filter(([, v]) => v !== undefined)
  if (!sessionId) return entries.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
  return entries
    .filter(([k]) => k === sessionId || k.startsWith(`${sessionId}:`))
    .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0))
}

function dropBindingsForSession(deps: CommandDeps, sessionId?: string): number {
  const store = deps.store()
  const matches = findSessionBindingEntries(deps, sessionId)
  if (!sessionId && matches.length > 0) {
    store.delete(matches[0]![0])
    return 1
  }
  for (const [k] of matches) store.delete(k)
  return matches.length
}

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence && fence[1] ? fence[1].trim() : trimmed
  try {
    const obj = JSON.parse(candidate)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function handleBtw(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const question = extractAfterSub(ctx, 'btw')
  if (!question) return err('Usage: /agy btw <side question>')
  if (!deps.runOnce) return err('One-shot agy runner is not configured in this host.')
  const { historyText } = resolveSessionContext(deps, ctx)
  const prompt = [
    'Answer this quick side question directly and concisely without modifying files or taking over the main task.',
    ...(historyText ? ['<session_context>', historyText, '</session_context>'] : []),
    '<side_question>',
    question,
    '</side_question>',
  ].join('\n\n')
  const res = await deps.runOnce({ prompt, mode: 'plan' })
  if (!res.ok) return err(`Side question failed: ${res.error ?? 'unknown error'}`)
  return ok(`**Side Answer (\`/agy btw\`)**\n\n${res.text}`)
}

async function handleFork(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  const rest = extractAfterSub(ctx, 'fork')
  const { sessionId, historyText } = resolveSessionContext(deps, ctx)
  const forksFile = deps.forksFile ?? join(stateDir(), 'session-forks.json')
  const forksKey = sessionId ?? 'global'

  if (/^list$/i.test(rest)) {
    const list = readForkStore(forksFile)[forksKey] ?? []
    if (list.length === 0) return ok('No fork checkpoints saved for this session.')
    const lines = list.map((cp) =>
      `- \`${cp.id}\` → conv \`${cp.conversationId}\` (${cp.model || 'default'})`
      + (cp.label ? ` · ${cp.label}` : '')
      + ` · ${new Date(cp.createdAt).toLocaleString()}`,
    )
    return ok([`**Session Fork Checkpoints** (${list.length})`, ...lines, 'Restore with `/agy fork restore <id>`.'].join('\n'))
  }

  const restoreMatch = rest.match(/^restore\s+(\S+)$/i)
  if (restoreMatch) {
    const id = restoreMatch[1]!
    const list = readForkStore(forksFile)[forksKey] ?? []
    const cp = list.find((x) => x.id === id)
    if (!cp) return err(`Fork checkpoint \`${id}\` not found. Run \`/agy fork list\` to see saved forks.`)
    const targetKey = cp.bindingKey || sessionId || 'global'
    deps.store().set(targetKey, {
      conversationId: cp.conversationId,
      lastMessageCount: 0,
      updatedAt: Date.now(),
      ...(cp.model ? { model: cp.model } : {}),
    })
    return ok(`Restored fork \`${cp.id}\` → agy conversation \`${cp.conversationId}\`.`)
  }

  const bindings = findSessionBindingEntries(deps, sessionId)
  const latest = bindings[0]
  let baseCheckpoint: ForkCheckpoint | null = null
  if (latest) {
    baseCheckpoint = {
      id: `fork-${randomUUID().slice(0, 8)}`,
      conversationId: latest[1].conversationId,
      bindingKey: latest[0],
      ...(latest[1].model ? { model: latest[1].model } : {}),
      label: rest ? `before: ${rest.slice(0, 50)}` : 'checkpoint',
      createdAt: Date.now(),
    }
    saveForkCheckpoint(forksFile, forksKey, baseCheckpoint)
  }

  if (rest === '') {
    dropBindingsForSession(deps, sessionId)
    if (!baseCheckpoint) {
      return ok('No existing agy binding to snapshot; the next turn will start a fresh conversation branch.')
    }
    return ok(
      `Saved checkpoint \`${baseCheckpoint.id}\` (agy conversation \`${baseCheckpoint.conversationId}\`) and reset the active binding for a new branch.\n`
      + `Run \`/agy fork restore ${baseCheckpoint.id}\` at any time to return.`,
    )
  }

  if (!deps.runOnce) return err('One-shot agy runner is not configured in this host.')
  const prompt = [
    'This is a forked exploration branch of the current session.',
    ...(historyText ? ['<session_context>', historyText, '</session_context>'] : []),
    '<fork_prompt>',
    rest,
    '</fork_prompt>',
  ].join('\n\n')
  const res = await deps.runOnce({ prompt, mode: deps.cfg().permissionMode })
  if (!res.ok) return err(`Fork execution failed: ${res.error ?? 'unknown error'}`)

  const lines = [`**Forked Branch Result**`, '', res.text]
  if (res.conversationId) {
    const forkCp: ForkCheckpoint = {
      id: `fork-${randomUUID().slice(0, 8)}`,
      conversationId: res.conversationId,
      bindingKey: latest?.[0] ?? sessionId ?? 'global',
      model: deps.cfg().defaultModel || undefined,
      label: rest.slice(0, 60),
      createdAt: Date.now(),
    }
    saveForkCheckpoint(forksFile, forksKey, forkCp)
    lines.push('', `- **Branch Checkpoint**: \`${forkCp.id}\` (conv \`${res.conversationId}\`) — switch main session to it with \`/agy fork restore ${forkCp.id}\``)
  }
  if (baseCheckpoint) {
    lines.push(`- **Prior Main Checkpoint**: \`${baseCheckpoint.id}\` (restore anytime with \`/agy fork restore ${baseCheckpoint.id}\`)`)
  }
  return ok(lines.join('\n'))
}

async function handleGrill(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  if (!deps.runOnce) return err('One-shot agy runner is not configured in this host.')
  const topic = extractAfterSub(ctx, ctx.sub)
  const { historyText } = resolveSessionContext(deps, ctx)
  const prompt = [
    'Act as a rigorous engineering interviewer (`/grill-me`). Analyze the context and topic below, then ask 3–5 concrete design-alignment questions.',
    'For each question, provide numbered options, your recommended choice with trade-offs, and keep the questions focused on resolving real ambiguities.',
    'Do NOT edit files or run destructive commands.',
    ...(topic ? [`<focus_topic>\n${topic}\n</focus_topic>`] : []),
    ...(historyText ? ['<session_context>', historyText, '</session_context>'] : []),
  ].join('\n\n')
  const res = await deps.runOnce({ prompt, mode: 'plan' })
  if (!res.ok) return err(`Grill interview failed: ${res.error ?? 'unknown error'}`)
  return ok(`**Design Alignment (\`/agy grill-me\`)**\n\n${res.text}`)
}

async function handleLearn(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  if (!deps.runOnce) return err('One-shot agy runner is not configured in this host.')
  const rawRest = extractAfterSub(ctx, 'learn')
  const apply = /(?:^|\s)--apply(?:\s|$)/i.test(rawRest)
  const focus = rawRest.replace(/(?:^|\s)--apply(?=\s|$)/gi, ' ').trim()
  const { workspaceRoot, historyText } = resolveSessionContext(deps, ctx)
  if (!historyText && !focus) {
    return err('Provide a topic or run inside a session with conversation history: `/agy learn [--apply] [focus]`')
  }

  if (!apply) {
    const prompt = [
      'Distill the reusable workflow, pitfall, or convention from this session into a concise Antigravity Skill (`SKILL.md` with YAML frontmatter `name` & `description`) or Rule (`AGENTS.md` snippet).',
      'Show the proposed file path under `.agents/skills/<name>/SKILL.md` or `.agents/rules/<name>.md` and its markdown content. Do NOT write files yet.',
      ...(focus ? [`<focus>\n${focus}\n</focus>`] : []),
      ...(historyText ? ['<session_context>', historyText, '</session_context>'] : []),
    ].join('\n\n')
    const res = await deps.runOnce({ prompt, mode: 'plan' })
    if (!res.ok) return err(`Learn preview failed: ${res.error ?? 'unknown error'}`)
    return ok(
      `**Extracted Skill / Rule Draft (Preview)**\n\n${res.text}\n\n`
      + `Apply directly into \`.agents/\` with: \`/agy learn --apply${focus ? ' ' + focus : ''}\``,
    )
  }

  const applyPrompt = [
    'Distill a reusable Antigravity Skill (`kind: "skill"`, formatted as full SKILL.md with `---` frontmatter `name` and `description`) or Rule (`kind: "rule"`, Markdown content).',
    'Output strictly valid JSON matching the schema. Use lowercase hyphenated `name` (`^[a-z0-9][a-z0-9-]{0,63}$`).',
    ...(focus ? [`<focus>\n${focus}\n</focus>`] : []),
    ...(historyText ? ['<session_context>', historyText, '</session_context>'] : []),
  ].join('\n\n')
  const res = await deps.runOnce({ prompt: applyPrompt, mode: 'plan', schema: LEARN_SCHEMA })
  if (!res.ok) return err(`Learn --apply failed: ${res.error ?? 'unknown error'}`)

  const parsed = parseJsonPayload(res.text)
  const kind = parsed?.kind
  const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : ''
  const content = typeof parsed?.content === 'string' ? parsed.content : ''
  if ((kind !== 'skill' && kind !== 'rule') || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || content.trim() === '') {
    return err(`Invalid structured output from agy --json-schema: ${res.text.slice(0, 300)}`)
  }

  const agentsRoot = resolve(workspaceRoot, '.agents')
  const targetPath = kind === 'skill'
    ? resolve(agentsRoot, 'skills', name, 'SKILL.md')
    : resolve(agentsRoot, 'rules', `${name}.md`)
  if (!targetPath.startsWith(agentsRoot + sep)) {
    return err('Refused to write learned customization outside `.agents/`.')
  }
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileAtomicSync(targetPath, content)
  return ok(
    `Saved **${kind}** \`${name}\` to \`${targetPath}\``
    + (summary ? `\n\n- **Summary**: ${summary}` : ''),
  )
}

async function handleCompact(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  if (!deps.runOnce) return err('One-shot agy runner is not configured in this host.')
  const focus = extractAfterSub(ctx, 'compact')
  const { sessionId, historyText } = resolveSessionContext(deps, ctx)
  if (!historyText) {
    return err('No conversation history found in this session to compact.')
  }
  const prompt = [
    'Summarize the session history below into a compact, high-signal `<compacted-summary>` block preserving key decisions, modified file paths, verification status, and open tasks.',
    'Do NOT execute any tools or modify files.',
    ...(focus ? [`<compact_focus>\n${focus}\n</compact_focus>`] : []),
    '<session_context>',
    historyText,
    '</session_context>',
  ].join('\n\n')
  const res = await deps.runOnce({ prompt, mode: 'plan' })
  if (!res.ok) return err(`Compaction failed: ${res.error ?? 'unknown error'}`)
  const dropped = dropBindingsForSession(deps, sessionId)
  const summary = /<compacted-summary>/i.test(res.text)
    ? res.text
    : `<compacted-summary>\n${res.text}\n</compacted-summary>`
  return ok(
    `**Session Compacted** (dropped ${dropped} agy conversation binding(s); next turn starts with a clean context)\n\n${summary}`,
  )
}

export async function handleSlashBridge(deps: CommandDeps, ctx: CommandContext): Promise<CommandResult> {
  switch (ctx.sub) {
    case 'btw':
      return handleBtw(deps, ctx)
    case 'fork':
      return handleFork(deps, ctx)
    case 'grill':
    case 'grill-me':
      return handleGrill(deps, ctx)
    case 'learn':
      return handleLearn(deps, ctx)
    case 'compact':
      return handleCompact(deps, ctx)
    default:
      return err(`Unknown slash bridge command \`${ctx.sub}\`.`)
  }
}
