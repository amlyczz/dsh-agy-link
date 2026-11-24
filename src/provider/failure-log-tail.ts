// Tail of a run's agy CLI log, appended to otherwise unexplained non-zero exits.
//
// A run can end with `agy exited with code N` while the result envelope, stderr
// and raw error text are all empty: agy cancels its own cascade and quits, so
// PROCESS_EXIT carries no detail and the turn failure is undiagnosable. The
// plugin already reads the run's CLI log for transport classification
// (`classifyRun` -> `readAgyRunLogText`), so the tail is free to reuse here.
import { Err } from '../common/types.ts'
import type { AttemptFailure } from './failure.ts'

/** Log lines that carry no diagnostic value for a failed exit. */
const NOISE = /file_watcher\.go|skipping empty or temp file|http_helpers\.go:748\] URL:/

/** The last meaningful lines of an agy CLI log, trimmed for an error message. */
export function agyLogTailText(text: string, maxLines = 12, maxChars = 900): string {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '' && !NOISE.test(line))
  if (lines.length === 0) return ''
  const tail = lines.slice(-maxLines).join(' | ')
  return tail.length > maxChars ? '…' + tail.slice(-maxChars) : tail
}

/**
 * Attach the agy log tail to a silent PROCESS_EXIT failure.
 *
 * Only a failure whose message is exactly `agy exited with code N` is touched:
 * when classification already produced a detail, or the code is something else
 * (timeout / network / rate limit / auth), the message is left untouched.
 */
export function withRunLogTail(
  failure: AttemptFailure | null,
  runLogText: string,
): AttemptFailure | null {
  if (failure === null) return null
  if (failure.code !== Err.PROCESS_EXIT) return failure
  if (!/^agy exited with code -?\d+$/.test(failure.message)) return failure
  const tail = agyLogTailText(runLogText)
  return tail === '' ? failure : { ...failure, message: failure.message + ': [agy log tail] ' + tail }
}
