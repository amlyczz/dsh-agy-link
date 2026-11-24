// Shared step-checklist parser, markdown formatter, summary calculator and
// DSH native `todo/write` mapper. Leaf module under src/common/ so both host
// (runtime/provider) and client (toolview) share identical behavior.

export type ChecklistStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed'

export interface ChecklistStepItem {
  title: string
  status: ChecklistStepStatus
}

export interface ChecklistSummary {
  done: number
  total: number
  inProgress: number
  pending: number
  skipped: number
  failed: number
  activeTitle: string
}

export interface DshTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Normalize agy / markdown / JSON status variants onto the 5 canonical step states. */
export function normalizeChecklistStatus(raw: unknown): ChecklistStepStatus {
  if (typeof raw !== 'string') return 'pending'
  const s = raw.trim().toLowerCase()
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'x') return 'done'
  if (s === 'in_progress' || s === 'in-progress' || s === 'in progress' || s === 'active' || s === 'running' || s === '>' || s === '/') {
    return 'in_progress'
  }
  if (s === 'skipped' || s === 'skip' || s === 'canceled' || s === 'cancelled' || s === '-') return 'skipped'
  if (s === 'failed' || s === 'fail' || s === 'error' || s === '!') return 'failed'
  return 'pending'
}

const CHECKLIST_LINE_RE = /^\s*-\s*\[( |x|X|>|\/|-|!)\]\s+(.+?)\s*$/

/** Parse Antigravity checklist markdown (`- [ ]`, `- [>]`, `- [/]`, `- [x]`, `- [-]`, `- [!]`). */
export function parseChecklistMarkdown(md: string): ChecklistStepItem[] {
  if (typeof md !== 'string' || md.trim() === '') return []
  const items: ChecklistStepItem[] = []
  for (const line of md.split(/\r?\n/)) {
    const m = CHECKLIST_LINE_RE.exec(line)
    if (!m) continue
    const title = m[2]!.trim()
    if (title === '') continue
    items.push({ title, status: normalizeChecklistStatus(m[1]) })
  }
  return items
}

function parseStepEntry(entry: unknown): ChecklistStepItem | null {
  if (typeof entry === 'string') {
    const parsed = parseChecklistMarkdown(entry)
    if (parsed.length > 0) return parsed[0]!
    const trimmed = entry.trim()
    return trimmed !== '' ? { title: trimmed, status: 'pending' } : null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const rec = entry as Record<string, unknown>
  const rawTitle = rec.title ?? rec.Title ?? rec.content ?? rec.Content ?? rec.text ?? rec.name
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (title === '') return null
  return {
    title,
    status: normalizeChecklistStatus(rec.status ?? rec.Status ?? rec.state),
  }
}

/**
 * Extract structured checklist items from `update_steps` / `todo_write` args
 * (`steps` / `Steps` / `todos`), falling back to markdown checklists in
 * `input.markdown`, `input.output`, or `fallbackText`.
 */
export function parseChecklistSteps(input: unknown, fallbackText?: string): ChecklistStepItem[] {
  if (Array.isArray(input)) {
    const items = input.map(parseStepEntry).filter((x): x is ChecklistStepItem => x !== null)
    if (items.length > 0) return items
  }
  if (typeof input === 'object' && input !== null) {
    const rec = input as Record<string, unknown>
    for (const key of ['steps', 'Steps', 'todos', 'items'] as const) {
      const candidate = rec[key]
      if (Array.isArray(candidate)) {
        const items = candidate.map(parseStepEntry).filter((x): x is ChecklistStepItem => x !== null)
        if (items.length > 0) return items
      }
    }
    for (const key of ['markdown', 'Markdown', 'output', 'Output'] as const) {
      const candidate = rec[key]
      if (typeof candidate === 'string') {
        const items = parseChecklistMarkdown(candidate)
        if (items.length > 0) return items
      }
    }
  }
  if (typeof fallbackText === 'string') {
    const items = parseChecklistMarkdown(fallbackText)
    if (items.length > 0) return items
  }
  return []
}

function markdownBoxFor(status: ChecklistStepStatus): string {
  switch (status) {
    case 'done': return '[x]'
    case 'in_progress': return '[>]'
    case 'skipped': return '[-]'
    case 'failed': return '[!]'
    default: return '[ ]'
  }
}

/** Format checklist steps using Antigravity's canonical `- [box] title` syntax. */
export function formatChecklistMarkdown(steps: readonly ChecklistStepItem[]): string {
  return steps.map((s) => `- ${markdownBoxFor(s.status)} ${s.title}`).join('\n')
}

/** Compute step counts and active step title matching Antigravity's `stepTray`. */
export function summarizeChecklist(steps: readonly ChecklistStepItem[]): ChecklistSummary {
  let done = 0
  let inProgress = 0
  let pending = 0
  let skipped = 0
  let failed = 0
  let activeTitle = ''
  for (const s of steps) {
    if (s.status === 'done') done++
    else if (s.status === 'in_progress') {
      inProgress++
      if (activeTitle === '') activeTitle = s.title
    } else if (s.status === 'skipped') skipped++
    else if (s.status === 'failed') failed++
    else pending++
  }
  return { done, total: steps.length, inProgress, pending, skipped, failed, activeTitle }
}

/**
 * Project Antigravity 5-state steps onto DSH's 3-state `todo/write` schema
 * (`pending | in_progress | completed`), guaranteeing unique non-empty content.
 */
export function checklistToDshTodos(steps: readonly ChecklistStepItem[]): DshTodoItem[] {
  const seen = new Set<string>()
  const out: DshTodoItem[] = []
  for (const s of steps) {
    let base = s.title.trim()
    if (base === '') continue
    let status: DshTodoItem['status']
    if (s.status === 'done') {
      status = 'completed'
    } else if (s.status === 'skipped') {
      status = 'completed'
      if (!/\(skipped\)$/i.test(base)) base = `${base} (skipped)`
    } else if (s.status === 'in_progress') {
      status = 'in_progress'
    } else if (s.status === 'failed') {
      status = 'pending'
      if (!base.startsWith('[!] ')) base = `[!] ${base}`
    } else {
      status = 'pending'
    }
    let content = base
    let n = 2
    while (seen.has(content)) {
      content = `${base} (#${n++})`
    }
    seen.add(content)
    out.push({ content, status })
  }
  return out
}
