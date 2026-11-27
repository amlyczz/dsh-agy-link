// Incremental UTF-8 line reader for live JSONL transcript files.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

export interface TranscriptCursor {
  /** Bytes of `transcript.jsonl` already consumed. */
  offset: number
  /** Incremental UTF-8 decoder so split multi-byte characters never corrupt. */
  decoder: StringDecoder
  /** Trailing partial line from the last read (the file ends without a newline). */
  rest: string
}

export function createTranscriptCursor(offset = 0): TranscriptCursor {
  return { offset, decoder: new StringDecoder('utf8'), rest: '' }
}

export function fileSizeOrZero(logPath: string): number {
  try {
    const st = statSync(logPath)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

export function readTranscriptDelta(logPath: string, cursor: TranscriptCursor): string[] {
  let size: number
  try {
    const st = statSync(logPath)
    if (!st.isFile()) return []
    size = st.size
  } catch {
    return []
  }
  if (size < cursor.offset) {
    cursor.offset = 0
    cursor.decoder = new StringDecoder('utf8')
    cursor.rest = ''
  }
  if (size === cursor.offset) return []

  const length = size - cursor.offset
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  try {
    const fd = openSync(logPath, 'r')
    try {
      bytesRead = readSync(fd, buffer, 0, length, cursor.offset)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  if (bytesRead <= 0) return []
  cursor.offset += bytesRead

  const chunk = cursor.rest + cursor.decoder.write(buffer.subarray(0, bytesRead))
  const parts = chunk.split('\n')
  cursor.rest = parts.pop() ?? ''
  return parts.filter((line) => line.trim() !== '')
}
