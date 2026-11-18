// Recover the turn's final assistant reply from agy's own transcript.
//
// The 5s idle reaper ends a turn whose answer was already written to
// `<brainDir>/.system_generated/logs/transcript.jsonl` but had not yet been
// flushed as a stdout step. Synthesizing `response: ''` there made DSH report a
// clean "completed" turn with no reply bubble at all (issues #127, #128).
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findBrainDir } from '../runtime/agy/db/paths.ts'

/**
 * How much of the transcript tail to inspect. The file grows for the lifetime
 * of a conversation, and only the newest turn matters, so a bounded tail read
 * keeps this O(1) regardless of history size.
 */
const TAIL_BYTES = 256 * 1024

interface TranscriptRow {
  type?: unknown
  content?: unknown
  tool_calls?: unknown
}

/**
 * Shown when the idle reaper ended the turn without a recoverable reply.
 *
 * Silently finishing with no text made DSH render "completed" while the user
 * saw no answer at all, which reads as success for work that was never
 * confirmed (issue #127). The turn is still a clean finish — this only explains
 * what happened instead of leaving a blank turn.
 */
export const IDLE_GRACE_NO_REPLY_NOTICE =
  '⚠️ 后台等待已结束，本轮没有收到最终答复；任务结果未确认，部分操作可能已经执行。\n'
  + '⚠️ Background wait ended without a final reply — the task outcome is unconfirmed and some steps may have run.\n'

/**
 * The final assistant reply written during the CURRENT turn, or '' when the
 * transcript does not prove one.
 *
 * "Current turn" = after the last `USER_INPUT` row. A `PLANNER_RESPONSE` still
 * carrying `tool_calls` is an in-flight step, not a final answer, and is
 * skipped. Anything unreadable degrades to '' so the caller keeps its previous
 * behaviour.
 */
export function recoverFinalReply(conversationId: string, accountHome?: string): string {
  const logPath = transcriptPath(conversationId, accountHome)
  if (logPath === null) return ''
  let text: string
  try {
    text = readTail(logPath)
  } catch {
    return ''
  }
  const rows = text.split('\n').filter((line) => line.trim() !== '')
  let lastUserInput = -1
  for (let i = 0; i < rows.length; i++) {
    if (rowType(rows[i]!) === 'USER_INPUT') lastUserInput = i
  }
  for (let i = rows.length - 1; i > lastUserInput; i--) {
    const row = parseRow(rows[i]!)
    if (row === null || row.type !== 'PLANNER_RESPONSE') continue
    if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) continue
    if (typeof row.content !== 'string') continue
    const content = row.content.trim()
    if (content !== '') return row.content
  }
  return ''
}

function transcriptPath(conversationId: string, accountHome?: string): string | null {
  const brainDir = findBrainDir(conversationId, accountHome)
  if (brainDir === null) return null
  const logPath = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl')
  return existsSync(logPath) ? logPath : null
}

function readTail(logPath: string): string {
  const size = statSync(logPath).size
  const start = Math.max(0, size - TAIL_BYTES)
  const length = size - start
  if (length <= 0) return ''
  const buf = Buffer.alloc(length)
  const fd = openSync(logPath, 'r')
  try {
    readSync(fd, buf, 0, length, start)
  } finally {
    closeSync(fd)
  }
  // A tail read can start mid-UTF-8 codepoint; the first partial line is
  // discarded below because it is never the row we are looking for.
  return buf.toString('utf8')
}

function parseRow(line: string): TranscriptRow | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as TranscriptRow) : null
  } catch {
    return null
  }
}

function rowType(line: string): string {
  const row = parseRow(line)
  return row !== null && typeof row.type === 'string' ? row.type : ''
}
