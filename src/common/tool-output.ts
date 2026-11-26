// Presentational cleaning of the raw tool-result text agy emits.
//
// agy wraps EVERY tool result in the same status envelope, e.g.
//
//   Created At: 2026-11-26T19:35:10+08:00
//   Completed At: 2026-11-26T19:35:16+08:00
//   Command exited with code 1.
//
//   Command output:
//   fatal: not a git repository ...
//
// and prefixes results it truncated with a "find the full output in a file at
// file:///..." paragraph. File reads additionally carry a "Showing lines 1-177
// of 177" header and a "1: " line-number gutter in front of every line.
//
// None of that is useful in a card: the envelope made the collapsed preview say
// "Created At: ..." instead of the command's real first output line, and the
// read gutter turned file content into line-numbered noise. This module strips
// it for DISPLAY only — the model still receives the untouched text.
//
// Pure string work: no disk, no clock, safe in both the host and the client
// bundle (that is why it lives in `common/`).

/** Tools whose result body is a numbered file excerpt. */
const READ_TOOLS = new Set(['read_file', 'view_file', 'read', 'open_file', 'view_image', 'read_image'])

export interface CleanedToolOutput {
  /** Result body to render (status envelope, gutter and header removed). */
  body: string
  /** Command exit code recovered from the envelope, when present. */
  exitCode?: number
  /** True when agy truncated the recorded output to a preview. */
  truncated: boolean
  /** file:// URI of the full output file agy wrote for a truncated result. */
  fullOutputPath?: string
}

const STATUS_LINE = /^(?:created|completed|updated|started|queued|finished)\s+at:\s*\S/i
const EXIT_LINE = /^command exited with code\s+(\d+)\s*\.?$/i
const TIMEOUT_LINE = /^command timed out\b.*$/i
const TRUNCATED_LINE = /^the tool'?s output was truncated due to being too long/i
const TRUNCATED_PATH = /file:\/\/[^\s)]+/i
const PREVIEW_LINE = /^here is a preview\b.*$/i
const OUTPUT_LABEL = /^command output:\s*$/i
const READ_RANGE = /^showing lines?\s+\d+(?:\s*[-–]\s*\d+)?\s+of\s+\d+\s*$/i
const READ_GUTTER = /^(\d+): ?(.*)$/

/**
 * Strip agy's status envelope from a tool result.
 *
 * `tool` selects the read-specific cleanup (line-range header + gutter); pass
 * an empty string when the tool name is unknown.
 */
export function cleanToolOutput(tool: string, text: string): CleanedToolOutput {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  let exitCode: number | undefined
  let truncated = false
  let fullOutputPath: string | undefined

  let i = 0
  // Header lines are only stripped while they are still the leading content:
  // a command whose own output contains "Created At: ..." keeps it.
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (STATUS_LINE.test(trimmed)) continue
    const exit = EXIT_LINE.exec(trimmed)
    if (exit !== null) {
      exitCode = Number.parseInt(exit[1] ?? '', 10)
      if (!Number.isFinite(exitCode)) exitCode = undefined
      continue
    }
    if (TIMEOUT_LINE.test(trimmed)) {
      exitCode = exitCode ?? 1
      continue
    }
    if (TRUNCATED_LINE.test(trimmed)) {
      truncated = true
      const path = TRUNCATED_PATH.exec(trimmed)
      if (path !== null) fullOutputPath = path[0]
      continue
    }
    if (PREVIEW_LINE.test(trimmed)) continue
    if (OUTPUT_LABEL.test(trimmed)) continue
    if (READ_TOOLS.has(tool) && READ_RANGE.test(trimmed)) continue
    break
  }

  let body = lines.slice(i).join('\n')
  if (READ_TOOLS.has(tool)) body = stripReadGutter(body)
  body = body.replace(/^[\n]+/, '').replace(/[\s\n]+$/, '')

  const notes: string[] = []
  if (exitCode !== undefined && exitCode !== 0) notes.push('[exit code ' + exitCode + ']')
  if (truncated) {
    const where = fullOutputPath !== undefined ? shortenFullOutputPath(fullOutputPath) : ''
    notes.push(where !== '' ? '[output truncated · full log: ' + where + ']' : '[output truncated]')
  }
  if (notes.length > 0) body = body === '' ? notes.join('\n') : body + '\n\n' + notes.join('\n')

  return {
    body,
    ...(exitCode !== undefined ? { exitCode } : {}),
    truncated,
    ...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
  }
}

/** Keep only the tail of the truncation path: it is a 200-char temp path. */
function shortenFullOutputPath(uri: string): string {
  // The URI sits inside a sentence, so agy ends it with a period.
  const bare = uri.replace(/^file:\/\/\/?/, '').replace(/[.,;:]+$/, '')
  const steps = /\.system_generated[\\/](.+)$/i.exec(bare)
  if (steps !== null && steps[1] !== undefined) return steps[1].replace(/\\/g, '/')
  const parts = bare.split(/[\\/]/)
  return parts.slice(-2).join('/')
}

/**
 * Remove agy's `N: ` line-number gutter from a read result.
 *
 * Only applied when the numbering is actually consecutive: the first non-blank
 * line must start the sequence and every following match must continue it, so a
 * file that merely contains `12: foo` lines is left untouched.
 */
export function stripReadGutter(body: string): string {
  const lines = body.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') {
      start = i
      break
    }
  }
  if (start < 0) return body
  const first = READ_GUTTER.exec(lines[start] ?? '')
  if (first === null) return body
  let expect = Number.parseInt(first[1] ?? '', 10)
  if (!Number.isFinite(expect) || expect < 1) return body

  const out = lines.slice()
  let stripped = 0
  for (let i = start; i < out.length; i++) {
    const line = out[i] ?? ''
    if (line.trim() === '') continue
    const m = READ_GUTTER.exec(line)
    if (m === null || Number.parseInt(m[1] ?? '', 10) !== expect) break
    out[i] = m[2] ?? ''
    expect += 1
    stripped += 1
  }
  return stripped >= 3 ? out.join('\n') : body
}

/** True when the text is only agy's envelope (nothing to show). */
export function isEnvelopeOnly(text: string): boolean {
  return cleanToolOutput('', text).body === ''
}
