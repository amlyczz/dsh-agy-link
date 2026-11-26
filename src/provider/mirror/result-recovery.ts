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
