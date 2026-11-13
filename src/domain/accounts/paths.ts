// Account-pool filesystem paths and the crash-safe atomic JSON writer.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * Write `body` to `file` without ever publishing a torn snapshot: a tmp name
 * unique per writer (pid + random), a JSON round-trip check, then `rename`
 * with retries. Two host processes persisting at once used to collide on one
 * fixed `.pool.json.tmp` and silently truncate the pool (2026-11-04).
 */
export function writeJsonAtomic(file: string, body: string): void {
  const dir = dirname(file)
  const tmp = join(dir, '.' + basename(file) + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp')
  writeFileSync(tmp, body, 'utf8')
  // Never rename a truncated/unparsable snapshot over the real file.
  JSON.parse(readFileSync(tmp, 'utf8'))
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      lastErr = e
    }
  }
  try {
    unlinkSync(tmp)
  } catch {
    // best effort
  }
  throw lastErr
}

export function defaultPoolDir(home?: string): string {
  if (home === undefined && process.env.DSH_STATE_DIR) {
    return join(process.env.DSH_STATE_DIR, 'agy-accounts')
  }
  const effectiveHome = home ?? homedir()
  // Guard against isolated sub-account environments where HOME/USERPROFILE
  // has been redirected into `<dshState>/agy-accounts/<accountId>`.
  const norm = effectiveHome.replace(/\\/g, '/')
  const marker = '/.dsh/agy-accounts/'
  const idx = norm.indexOf(marker)
  if (idx !== -1) {
    const realHome = effectiveHome.slice(0, idx)
    return join(realHome, '.dsh', 'agy-accounts')
  }
  return join(effectiveHome, '.dsh', 'agy-accounts')
}
