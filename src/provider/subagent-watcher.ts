// Subagent watcher: discovers background/boost subagents via conversation_summaries.db
// and streams incremental progress from brain/<subagent_id>/.system_generated/logs/transcript.jsonl
// into the parent RunRecording, keeping the idle watchdog alive and rendering
// subagent actions live in the DSH reasoning block.
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import type { AgyEvent } from '../common/types.ts'
import { findSummariesDb, findTranscriptPath } from '../runtime/agy/db/paths.ts'

export interface SubagentSummaryRecord {
  conversation_id: string
  parent_conversation_id: string
  agent_name: string
  nesting_depth: number
  status: string
  step_count: number
}

export function unquoteArg(val: unknown): string {
  if (typeof val === 'string') {
    let trimmed = val.trim()
    while (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      try {
        const parsed = JSON.parse(trimmed)
        if (typeof parsed === 'string') {
          trimmed = parsed.trim()
        } else if (parsed !== null && parsed !== undefined) {
          return JSON.stringify(parsed)
        } else {
          break
        }
      } catch {
        break
      }
    }
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed)
        return JSON.stringify(parsed)
      } catch {
        // ignore
      }
    }
    return trimmed
  }
  if (val === null || val === undefined) return ''
  return String(val)
}

/** Pure step formatter turning a transcript.jsonl step into a compact markdown line. */
export function formatSubagentStep(agentName: string, rawJsonLine: string): string | null {
  let step: {
    step_index?: number
    source?: string
    type?: string
    status?: string
    thinking?: string
    tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>
    content?: string
  }
  try {
    step = JSON.parse(rawJsonLine)
  } catch {
    return null
  }

  // Skip system reminders, internal SDK instructions, and raw system messages
  if (step.source === 'SYSTEM_SDK' || step.type === 'SYSTEM_MESSAGE') return null

  const results: string[] = []
  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
    for (const tc of step.tool_calls) {
      const name = tc.name || 'tool'
      const args = tc.args || {}
      if (name === 'run_command') {
        const summary = unquoteArg(args.toolSummary || args.Description || '')
        const cmd = unquoteArg(args.CommandLine || '')
        const shortCmd = cmd.length > 70 ? cmd.slice(0, 67) + '...' : cmd
        if (summary) {
          results.push(`• [${agentName}] 🛠️ run_command: ${summary} (\`${shortCmd}\`)`)
        } else if (shortCmd) {
          results.push(`• [${agentName}] 🛠️ run_command: \`${shortCmd}\``)
        } else {
          results.push(`• [${agentName}] 🛠️ run_command`)
        }
      } else if (name === 'read_file') {
        const p = unquoteArg(args.Path || args.path || '')
        const start = args.StartLine ? ` (L${args.StartLine}-${args.EndLine || ''})` : ''
        results.push(`• [${agentName}] 📖 read_file: \`${p}\`${start}`)
      } else if (name === 'edit_file') {
        const p = unquoteArg(args.Path || args.path || '')
        results.push(`• [${agentName}] ✏️ edit_file: \`${p}\``)
      } else if (name === 'write_file') {
        const p = unquoteArg(args.Path || args.path || '')
        results.push(`• [${agentName}] 📝 write_file: \`${p}\``)
      } else if (name === 'search_web') {
        const q = unquoteArg(args.query || args.Query || '')
        results.push(`• [${agentName}] 🔍 search_web: "${q}"`)
      } else if (name === 'invoke_subagent') {
        const role = unquoteArg(args.Role || args.TypeName || '')
        results.push(`• [${agentName}] 🤖 invoke_subagent: ${role || 'subagent'}`)
      } else if (name === 'manage_task') {
        const action = unquoteArg(args.Action || args.action || '')
        const taskId = unquoteArg(args.TaskId || args.taskId || '')
        results.push(`• [${agentName}] ⚙️ manage_task: ${action}${taskId ? ' ' + taskId : ''}`)
      } else if (name === 'send_message') {
        const recipient = unquoteArg(args.Recipient || args.recipient || '')
        results.push(`• [${agentName}] 💬 send_message: ${recipient}`)
      } else {
        results.push(`• [${agentName}] 🛠️ ${name}`)
      }
    }
  } else if (typeof step.thinking === 'string' && step.thinking.trim() !== '') {
    const firstLine = step.thinking
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('#'))[0]
    if (firstLine) {
      const shortThought = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
      results.push(`• [${agentName}] 💭 ${shortThought}`)
    }
  }

  return results.length > 0 ? results.join('\n') : null
}

/** Reads new complete lines from a transcript file starting at byte offset. */
export function readIncrementalTranscript(
  filePath: string,
  startOffset: number,
): { lines: string[]; newOffset: number } {
  try {
    if (!existsSync(filePath)) return { lines: [], newOffset: startOffset }
    const fd = openSync(filePath, 'r')
    try {
      const stat = fstatSync(fd)
      if (stat.size <= startOffset) return { lines: [], newOffset: startOffset }
      const readLength = stat.size - startOffset
      const buf = Buffer.alloc(readLength)
      const bytesRead = readSync(fd, buf, 0, readLength, startOffset)
      if (bytesRead <= 0) return { lines: [], newOffset: startOffset }

      // Find the last complete newline byte (0x0A)
      const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (lastNewline === -1) {
        // Line is incomplete, wait for next tick
        return { lines: [], newOffset: startOffset }
      }

      const validBytes = buf.subarray(0, lastNewline + 1)
      const text = validBytes.toString('utf8')
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
      return { lines, newOffset: startOffset + validBytes.length }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { lines: [], newOffset: startOffset }
  }
}

/** Query recursive subagents from conversation_summaries.db. */
export async function querySubagentsFromDb(
  dbPath: string,
  rootConversationId: string,
): Promise<SubagentSummaryRecord[]> {
  try {
    const mod = (await import('node:sqlite')) as {
      DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => {
        exec(sql: string): unknown
        prepare(sql: string): { all(...params: unknown[]): unknown[] }
        close(): void
      }
    }
    if (typeof mod.DatabaseSync === 'function') {
      const Database = mod.DatabaseSync
      let db: {
        exec(sql: string): unknown
        prepare(sql: string): { all(...params: unknown[]): unknown[] }
        close(): void
      }
      try {
        db = new Database(dbPath, { readOnly: true })
      } catch {
        db = new Database(dbPath)
      }
      try {
        try { db.exec('PRAGMA busy_timeout = 2000;') } catch { /* ignore */ }
        try { db.exec('PRAGMA query_only = ON;') } catch { /* ignore */ }
        const sql = `
WITH RECURSIVE subagents AS (
  SELECT conversation_id, parent_conversation_id, agent_name, nesting_depth, status, step_count
  FROM conversation_summaries
  WHERE parent_conversation_id = ?
  UNION ALL
  SELECT c.conversation_id, c.parent_conversation_id, c.agent_name, c.nesting_depth, c.status, c.step_count
  FROM conversation_summaries c
  JOIN subagents s ON c.parent_conversation_id = s.conversation_id
) SELECT conversation_id, parent_conversation_id, agent_name, nesting_depth, status, step_count FROM subagents;
`
        const rows = db.prepare(sql).all(rootConversationId) as Array<{
          conversation_id?: unknown
          parent_conversation_id?: unknown
          agent_name?: unknown
          nesting_depth?: unknown
          status?: unknown
          step_count?: unknown
        }>
        return rows.map((r) => ({
          conversation_id: String(r.conversation_id ?? ''),
          parent_conversation_id: String(r.parent_conversation_id ?? ''),
          agent_name: String(r.agent_name ?? ''),
          nesting_depth: typeof r.nesting_depth === 'number' ? r.nesting_depth : 0,
          status: String(r.status ?? ''),
          step_count: typeof r.step_count === 'number' ? r.step_count : 0,
        }))
      } finally {
        db.close()
      }
    }
  } catch {
    // node:sqlite fallback to sqlite3 CLI
  }

  // Fallback to sqlite3 CLI
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const sql = `
WITH RECURSIVE subagents AS (
  SELECT conversation_id, parent_conversation_id, agent_name, nesting_depth, status, step_count
  FROM conversation_summaries
  WHERE parent_conversation_id = '${rootConversationId.replace(/'/g, "''")}'
  UNION ALL
  SELECT c.conversation_id, c.parent_conversation_id, c.agent_name, c.nesting_depth, c.status, c.step_count
  FROM conversation_summaries c
  JOIN subagents s ON c.parent_conversation_id = s.conversation_id
) SELECT conversation_id || '|' || parent_conversation_id || '|' || agent_name || '|' || nesting_depth || '|' || status || '|' || step_count FROM subagents;
`
    const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], {
      timeout: 3000,
      encoding: 'utf8',
    })
    const lines = stdout.split('\n').filter((l) => l.trim() !== '')
    return lines.map((l) => {
      const parts = l.split('|')
      return {
        conversation_id: parts[0] || '',
        parent_conversation_id: parts[1] || '',
        agent_name: parts[2] || '',
        nesting_depth: parseInt(parts[3] || '0', 10) || 0,
        status: parts[4] || '',
        step_count: parseInt(parts[5] || '0', 10) || 0,
      }
    })
  } catch {
    return []
  }
}

export interface SubagentWatcherOptions {
  getRootConversationId: () => string | null
  accountHome?: string
  onEvent: (ev: AgyEvent) => void
  onActivity?: () => void
  pollIntervalMs?: number
  log?: (msg: string) => void
  // Testing injection hooks
  _findDb?: (accountHome?: string) => string | null
  _findTranscript?: (cid: string, accountHome?: string) => string | null
  _queryDb?: (dbPath: string, rootCid: string) => Promise<SubagentSummaryRecord[]>
}

interface SubagentTrackedState {
  conversationId: string
  parentConversationId: string
  agentName: string
  nestingDepth: number
  status: string
  stepCount: number
  transcriptPath: string | null
  byteOffset: number
  announcedStart: boolean
  announcedFinish: boolean
}

export class SubagentWatcher {
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private dbPath: string | null = null
  private readonly tracked = new Map<string, SubagentTrackedState>()
  private stepSeq = 0

  constructor(private readonly opts: SubagentWatcherOptions) {}

  start(): void {
    if (this.stopped) return
    this.scheduleNext(100)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** Explicitly register a subagent discovered from tool calls or external events. */
  trackExplicitSubagent(conversationId: string, agentName?: string): void {
    if (!conversationId) return
    let state = this.tracked.get(conversationId)
    if (!state) {
      const name = agentName || ('Subagent-' + conversationId.slice(0, 8))
      state = {
        conversationId,
        parentConversationId: this.opts.getRootConversationId() ?? '',
        agentName: name,
        nestingDepth: 1,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 0,
        transcriptPath: null,
        byteOffset: 0,
        announcedStart: false,
        announcedFinish: false,
      }
      this.tracked.set(conversationId, state)
      this.scheduleNext(50)
    }
  }

  private scheduleNext(delayMs?: number): void {
    if (this.stopped) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.tick().catch((err) => {
        this.opts.log?.('[SubagentWatcher] tick error: ' + String(err))
      })
    }, delayMs ?? (this.opts.pollIntervalMs ?? 1000))
    this.timer.unref?.()
  }

  async tick(): Promise<void> {
    if (this.stopped) return

    const rootCid = this.opts.getRootConversationId()
    if (!rootCid) {
      this.scheduleNext()
      return
    }

    if (!this.dbPath) {
      this.dbPath = this.opts._findDb?.(this.opts.accountHome) ?? findSummariesDb(this.opts.accountHome)
    }

    if (this.dbPath) {
      try {
        const records = this.opts._queryDb
          ? await this.opts._queryDb(this.dbPath, rootCid)
          : await querySubagentsFromDb(this.dbPath, rootCid)
        for (const rec of records) {
          let state = this.tracked.get(rec.conversation_id)
          if (!state) {
            const agentName = rec.agent_name || ('Subagent-' + rec.conversation_id.slice(0, 8))
            state = {
              conversationId: rec.conversation_id,
              parentConversationId: rec.parent_conversation_id,
              agentName,
              nestingDepth: rec.nesting_depth,
              status: rec.status,
              stepCount: rec.step_count,
              transcriptPath: null,
              byteOffset: 0,
              announcedStart: false,
              announcedFinish: false,
            }
            this.tracked.set(rec.conversation_id, state)
          } else {
            state.status = rec.status
            state.stepCount = rec.step_count
          }
        }
      } catch {
        // transient read failure / sqlite lock — will retry next tick
      }
    }

    for (const state of this.tracked.values()) {
      // Announce started if not yet announced
      if (!state.announcedStart) {
        state.announcedStart = true
        this.opts.onEvent({
          kind: 'step',
          stepKey: `subagent-start-${state.conversationId}`,
          stepKind: 'subagent',
          text: `\n• [${state.agentName}] 🤖 Subagent started`,
          raw: {},
        })
        this.opts.onActivity?.()
      }

      // Locate transcript path
      if (!state.transcriptPath) {
        state.transcriptPath =
          this.opts._findTranscript?.(state.conversationId, this.opts.accountHome) ??
          findTranscriptPath(state.conversationId, this.opts.accountHome)
      }

      // Read new transcript steps
      if (state.transcriptPath) {
        const { lines, newOffset } = readIncrementalTranscript(state.transcriptPath, state.byteOffset)
        state.byteOffset = newOffset
        for (const line of lines) {
          const formatted = formatSubagentStep(state.agentName, line)
          if (formatted) {
            this.opts.onEvent({
              kind: 'step',
              stepKey: `subagent-step-${state.conversationId}-${++this.stepSeq}`,
              stepKind: 'subagent',
              text: `\n${formatted}`,
              raw: line,
            })
            this.opts.onActivity?.()
          }
        }
      }

      // Announce finish when idle or completed
      const isIdleOrDone =
        state.status === 'CASCADE_RUN_STATUS_IDLE' ||
        state.status === 'DONE' ||
        state.status === 'COMPLETED'
      if (isIdleOrDone && !state.announcedFinish) {
        state.announcedFinish = true
        this.opts.onEvent({
          kind: 'step',
          stepKey: `subagent-finish-${state.conversationId}`,
          stepKind: 'subagent',
          text: `\n• [${state.agentName}] ✅ Finished`,
          raw: {},
        })
        this.opts.onActivity?.()
      }
    }

    this.scheduleNext()
  }
}
