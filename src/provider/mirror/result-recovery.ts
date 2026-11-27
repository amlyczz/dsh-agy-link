// Recover the result text of a mirrored agy tool step from agy's conversation
// database.
//
// Why this exists: agy's stream envelope is not the record of what a tool did.
// `read_file` reports an EMPTY result on stdout (the file body only lives in the
// conversation DB), and long `run_command` output arrives as a middle-truncated
// preview. The mirror therefore used to hand DSH nothing to show for a read, and
// the card rendered "(no output)".
//
// The recovered text is cleaned (agy's status envelope and read gutter removed)
// and capped, because it becomes the mirror's tool result — the model reads it
// too, and a 40 KB file body per step would be pure context waste.
import { cleanToolOutput } from '../../common/tool-output.ts'
import { readFullToolResult } from '../../host/agy-db.ts'
import type { RunRecording } from '../../host/recording.ts'
import { isSensitivePath } from '../../common/sensitive-paths.ts'
import { readFile, stat } from 'node:fs/promises'

/**
 * Hard cap on the recovered text. A card clips at 16 KB anyway; the point of
 * recovery is "show the file/command body", not to replay megabytes.
 */
const MAX_RECOVERED_CHARS = 12_000

/** Tools whose stream result is always empty but whose DB result is not. */
const RECOVERY_TOOLS = new Set([
  'read_file',
  'view_file',
  'read',
  'open_file',
  'view_image',
  'read_image',
  'list_dir',
  'ls',
  'find_by_name',
  'glob',
  'search_file_content',
  'grep_search',
  'read_url_content',
])

/**
 * True when a step's result should be looked up in the DB: the stream carried
 * nothing usable AND the tool is one agy is known to strip (or the step simply
 * has no result at all, which the DB read answers cheaply from the cache).
 */
export function shouldRecoverResult(tool: string, output: string): boolean {
  if (output.trim() !== '') return false
  return RECOVERY_TOOLS.has(tool) || tool === ''
}

/** Tools whose result IS the file body, and whose args carry its path. */
const FILE_READ_TOOLS = new Set(['read_file', 'view_file', 'open_file', 'read'])

/** True when a tool call names a file this plugin must never copy into a result. */
export function isSensitiveReadPath(args: unknown): boolean {
  const path = pathFromArgs(args)
  return path !== null && isSensitivePath(path)
}

/** True when a step of \	ool\ can be answered by reading the file it names. */
export function canRecoverFromFile(tool: string): boolean {
  return FILE_READ_TOOLS.has(tool)
}

/** Largest file we are willing to pull in as a tool result (bytes). */
const MAX_FILE_BYTES = 2 * 1024 * 1024

function pathFromArgs(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  for (const key of ['Path', 'path', 'File', 'file', 'file_path', 'filePath', 'TargetFile', 'target_file', 'AbsolutePath']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/**
 * Last-resort body for a file read whose result agy never streamed AND whose
 * conversation DB is gone (agy prunes conversations, and ACP sessions do not
 * always leave one behind). The model was shown this file's text by agy itself,
 * so showing it in the card restores information instead of inventing any; the
 * cap keeps a 10 MB source file out of both the card and the context.
 */
export async function recoverFromFile(tool: string, input: unknown): Promise<string | null> {
  if (!FILE_READ_TOOLS.has(tool)) return null
  const path = pathFromArgs(input)
  if (path === null) return null
  if (isSensitivePath(path)) return null
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  } catch {
    return null
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  if (text.includes('\u0000')) return null
  if (text.trim() === '') return null
  const body = text.replace(/\s+$/, '')
  return body.length > MAX_RECOVERED_CHARS
    ? body.slice(0, MAX_RECOVERED_CHARS) + '\n… (+' + (body.length - MAX_RECOVERED_CHARS) + ' chars)'
    : body
}

/**
 * Look up and clean the recorded result for `step` (a recording event index).
 * Returns null when the DB is unavailable, the step is not a tool step, or agy
 * recorded no result text for it.
 */
export async function recoverRecordedResult(
  rec: RunRecording,
  step: number,
  tool: string,
): Promise<string | null> {
  const conversationId = rec.conversationId
  if (conversationId === null || conversationId === '') return null
  const ev = rec.eventAt(step)
  if (ev === undefined || ev.kind !== 'step') return null
  const stepIdx = Number.parseInt(ev.stepKey, 10)
  if (!Number.isFinite(stepIdx) || stepIdx < 0) return null
  let text: string | null = null
  try {
    text = await readFullToolResult(conversationId, stepIdx, rec.accountHome)
  } catch {
    return null
  }
  if (text === null || text.trim() === '') return null
  const body = cleanToolOutput(tool, text).body
  if (body === '') return null
  return body.length > MAX_RECOVERED_CHARS
    ? body.slice(0, MAX_RECOVERED_CHARS) + '\n… (+' + (body.length - MAX_RECOVERED_CHARS) + ' chars)'
    : body
}

/**
 * Best-effort output for one recorded step: keep what the transport sent,
 * otherwise read it back from the agy conversation DB, otherwise — for a file
 * read — show the file agy itself read.
 */
export async function recoverStepOutput(
  rec: RunRecording,
  step: number,
  tool: string,
  args: unknown,
  current: string,
): Promise<string> {
  if (current.trim() !== '') return current
  // Before either recovery path: agy reading a credential file is agy's
  // business, but a recovered result lands in DSH's session log, which a later
  // model switch can replay to another vendor. The card stays empty instead.
  if (isSensitiveReadPath(args)) return current
  const recovered = await recoverRecordedResult(rec, step, tool)
  if (recovered !== null) return recovered
  if (!canRecoverFromFile(tool)) return current
  return (await recoverFromFile(tool, args)) ?? current
}
