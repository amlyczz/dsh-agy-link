import { chmodSync, existsSync, linkSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicTmpPath } from '../common/atomic-write.ts'

function refreshToken(raw: string): string | undefined {
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>
    const token = doc?.token && typeof doc.token === 'object' ? doc.token as Record<string, unknown> : doc
    const value = token?.refresh_token ?? token?.refreshToken
    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function writeAtomic(file: string, raw: string): void {
  const tmp = atomicTmpPath(file)
  try {
    writeFileSync(tmp, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch { /* Windows */ }
  } finally {
    try { unlinkSync(tmp) } catch { /* already renamed */ }
  }
}

/**
 * Serialize plugin credential mutations across host processes. agy itself does
 * not take this lock; restore therefore also uses an exclusive hard link.
 */
export function withCredentialFileLock<T>(file: string, action: () => T): T | undefined {
  const lock = file + '.backup-lock'
  try {
    mkdirSync(lock)
  } catch {
    // A crash between mkdir and writing the owner is also recoverable.
    try {
      if (Date.now() - statSync(lock).mtimeMs < 60_000) return undefined
      const owner = Number(read(join(lock, 'owner')) ?? 0)
      if (owner > 0) {
        try {
          process.kill(owner, 0)
          return undefined
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return undefined
        }
      }
      try { unlinkSync(join(lock, 'owner')) } catch { /* no owner */ }
      rmdirSync(lock)
      mkdirSync(lock)
    } catch {
      return undefined
    }
  }
  try {
    writeFileSync(join(lock, 'owner'), String(process.pid), { encoding: 'utf8', mode: 0o600 })
    return action()
  } finally {
    try { unlinkSync(join(lock, 'owner')) } catch { /* best effort */ }
    try { rmdirSync(lock) } catch { /* best effort */ }
  }
}

/** Call only while holding this file's lock. Never back up an unidentifiable grant. */
export function saveCredentialBackup(file: string, raw: string): boolean {
  if (!refreshToken(raw)) return false
  writeAtomic(file + '.bak', raw)
  try { unlinkSync(file + '.bak-conflict') } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return true
}

/** Update only the same grant, including a refresh-token rotation. */
export function updateCredentialBackup(file: string, raw: string, previousRaw: string): boolean {
  const backup = read(file + '.bak')
  if (existsSync(file + '.bak-conflict')) return false
  if (backup && refreshToken(backup) !== refreshToken(previousRaw)) {
    writeFileSync(file + '.bak-conflict', '', { mode: 0o600 })
    return false
  }
  return saveCredentialBackup(file, raw)
}

/**
 * Preserve existing files, including malformed ones. Only restore a missing
 * file from a backup with a refresh token; never overwrite a concurrent login.
 */
export function readAccountCredential(file: string, log: (message: string) => void = () => {}): string | null {
  try {
    const result = withCredentialFileLock(file, () => {
      const current = read(file)
      if (current !== null) {
        const grant = refreshToken(current)
        if (grant) {
          const backup = read(file + '.bak')
          if (backup !== current) updateCredentialBackup(file, current, current)
        }
        return current
      }
      // Read failures other than ENOENT must not trigger recovery.
      try {
        statSync(file)
        return null
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null
      }
      const backup = read(file + '.bak')
      if (existsSync(file + '.bak-conflict') || !backup || !refreshToken(backup)) return null
      const tmp = atomicTmpPath(file)
      try {
        const fd = openSync(tmp, 'wx', 0o600)
        try { writeFileSync(fd, backup, 'utf8') } finally { closeSync(fd) }
        linkSync(tmp, file)
        log('[agy-link] restored a missing account credential from its backup')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      } finally {
        try { unlinkSync(tmp) } catch { /* best effort */ }
      }
      return read(file)
    })
    return result === undefined ? read(file) : result
  } catch {
    log('[agy-link] credential backup or restore failed; check account directory permissions')
    return read(file)
  }
}
