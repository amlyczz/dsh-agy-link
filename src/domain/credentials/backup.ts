import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { constants } from 'node:fs'

/** Extract refresh token to ensure only valid OAuth documents are backed up. */
export function hasRefreshToken(raw: string): boolean {
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>
    const token = doc?.token && typeof doc.token === 'object' ? (doc.token as Record<string, unknown>) : doc
    const value = token?.refresh_token ?? token?.refreshToken
    return typeof value === 'string' && value.length > 0
  } catch {
    return false
  }
}

function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const start = Date.now()
    while (Date.now() - start < ms) {
      /* fallback */
    }
  }
}

/** Read a file with retry backoff for transient Windows sharing violations. */
export function readWithRetry(file: string): string | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return readFileSync(file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      if (attempt < 2 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
        sleepMs(50)
        continue
      }
      return null
    }
  }
  return null
}

/** Back up an account's credential. Never backs up unidentifiable/broken content. */
export function saveCredentialBackup(file: string, raw?: string): boolean {
  try {
    const content = raw ?? readWithRetry(file)
    if (!content || !hasRefreshToken(content)) return false
    writeFileSync(file + '.bak', content, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Compatibility alias for saveCredentialBackup. */
export function updateCredentialBackup(file: string, raw: string, _previousRaw?: string): boolean {
  return saveCredentialBackup(file, raw)
}

/** Pass-through compatibility wrapper (no file locks needed with atomic COPYFILE_EXCL). */
export function withCredentialFileLock<T>(_file: string, action: () => T): T {
  return action()
}

/**
 * Read account credential. If the file was removed by agy, restore it from .bak.
 * Ordinary reads never take locks, create directories, or write to disk.
 */
export function readAccountCredential(file: string, log: (message: string) => void = () => {}): string | null {
  // 1. Normal path: read existing file
  const current = readWithRetry(file)
  if (current !== null) {
    if (!existsSync(file + '.bak') && hasRefreshToken(current)) {
      saveCredentialBackup(file, current)
    }
    return current
  }

  // 2. File does not exist on disk: check if valid backup exists
  const backupFile = file + '.bak'
  const backup = readWithRetry(backupFile)
  if (!backup || !hasRefreshToken(backup)) {
    return null
  }

  // 3. Restore backup atomically without overwriting concurrent writers
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      copyFileSync(backupFile, file, constants.COPYFILE_EXCL)
      log('[agy-link] restored missing account credential from backup')
      return backup
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        // Concurrently created or restored
        return readWithRetry(file)
      }
      if (attempt < 2 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
        sleepMs(50)
        continue
      }
      break
    }
  }
  return readWithRetry(file)
}
