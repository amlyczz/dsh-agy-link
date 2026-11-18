// Atomic file replacement with a UNIQUE per-write temp name.
//
// Several DSH host processes (web + headless) share state and credential files.
// A pid + monotonic sequence + random suffix makes every temp unique so
// concurrent writers never share one, while rename gives an atomic swap.
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

let seq = 0

/** Unique temp path beside `file` (same directory, so rename stays atomic). */
export function atomicTmpPath(file: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return file + '.' + process.pid + '.' + (seq++).toString(36) + '.' + rand + '.tmp'
}

/** Write `data` to `file` atomically; on any failure remove the temp file. */
export function writeFileAtomicSync(file: string, data: string, mode = 0o600): void {
  const tmp = atomicTmpPath(file)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, data, { encoding: 'utf8', mode })
    renameSync(tmp, file)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw err
  }
}

/** Best-effort boolean wrapper around `writeFileAtomicSync` (never throws). */
export function tryWriteFileAtomic(file: string, data: string, mode = 0o600): boolean {
  try {
    writeFileAtomicSync(file, data, mode)
    return true
  } catch {
    return false
  }
}
