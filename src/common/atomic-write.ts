// Atomic file replacement with a UNIQUE per-write temp name.
//
// Several DSH host processes (web + headless) share one state file such as
// sessions.json. The old writer used a deterministic "<file>.tmp", so two
// processes writing at the same time could interleave into the same temp file
// and then race the rename — corrupting the store or failing one writer with
// ENOENT. A pid + monotonic sequence + random suffix makes every temp unique,
// so concurrent writers never share one, while rename still gives atomic swap.
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

let seq = 0

/** Unique temp path beside `file` (same directory, so rename stays atomic). */
export function atomicTmpPath(file: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return file + '.' + process.pid + '.' + (seq++).toString(36) + '.' + rand + '.tmp'
}

/** Write `data` to `file` atomically; on any failure remove the temp file. */
export function writeFileAtomicSync(file: string, data: string): void {
  const tmp = atomicTmpPath(file)
  try {
    writeFileSync(tmp, data, 'utf8')
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
