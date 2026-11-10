import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const start = Date.now()
    while (Date.now() - start < ms) { /* busy wait fallback */ }
  }
}

/**
 * Relaxed read with retry backoff for Windows sharing violations.
 * Uses shared read mode and handles transient EBUSY/EPERM/EACCES errors.
 */
export function readRelaxed(file: string): string | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(file, 'r')
      return readFileSync(fd, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      if (attempt < 2 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
        sleepMs(50)
        continue
      }
      return null
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best effort */ }
      }
    }
  }
  return null
}

function writeAtomic(file: string, raw: string): void {
  const tmp = atomicTmpPath(file)
  try {
    writeFileSync(tmp, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(tmp, file)
        try { chmodSync(file, 0o600) } catch { /* Windows */ }
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt < 2 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
          sleepMs(50)
          continue
        }
        throw err
      }
    }
  } finally {
    try { unlinkSync(tmp) } catch { /* already renamed */ }
  }
}

/**
 * Restores a missing file from backup using exclusive creation ('wx') to avoid
 * overwriting concurrent writers, with retry backoff for Windows file locking.
 */
function restoreBackup(file: string, backup: string, log: (message: string) => void): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined
    try {
      fd = openSync(file, 'wx', 0o600)
      writeFileSync(fd, backup, 'utf8')
      try { chmodSync(file, 0o600) } catch { /* Windows */ }
      log('[agy-link] restored a missing account credential from its backup')
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        // Concurrently created or restored by another process
        return true
      }
      if (attempt < 2 && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
        sleepMs(50)
        continue
      }
      return false
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best effort */ }
      }
    }
  }
  return false
}

/**
 * Serialize plugin credential mutations across host processes.
 */
export function withCredentialFileLock<T>(file: string, action: () => T): T | undefined {
  const lock = file + '.backup-lock'
  try {
    mkdirSync(lock)
  } catch {
    // A crash between mkdir and writing the owner is also recoverable.
    try {
      if (Date.now() - statSync(lock).mtimeMs < 60_000) return undefined
      const owner = Number(readRelaxed(join(lock, 'owner')) ?? 0)
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
  const backup = readRelaxed(file + '.bak')
  if (existsSync(file + '.bak-conflict')) return false
  if (backup && refreshToken(backup) !== refreshToken(previousRaw)) {
    try { writeFileSync(file + '.bak-conflict', '', { mode: 0o600 }) } catch { /* best effort */ }
    return false
  }
  return saveCredentialBackup(file, raw)
}

/** Ensure an initial backup exists for the account. No-op if .bak already exists. */
export function ensureCredentialBackup(file: string, currentRaw?: string): boolean {
  if (existsSync(file + '.bak')) return false
  const raw = currentRaw ?? readRelaxed(file)
  if (!raw || !refreshToken(raw)) return false
  return withCredentialFileLock(file, () => {
    if (existsSync(file + '.bak')) return false
    return saveCredentialBackup(file, raw)
  }) ?? false
}

/**
 * Fast, lock-free read for account credentials. Only missing files trigger
 * backup restoration under a cross-process lock. Ordinary reads never take
 * locks or write backups.
 */
export function readAccountCredential(file: string, log: (message: string) => void = () => {}): string | null {
  // Fast path: pure lock-free, read-only access.
  const current = readRelaxed(file)
  if (current !== null) {
    if (!existsSync(file + '.bak')) {
      ensureCredentialBackup(file, current)
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

  const backup = readRelaxed(file + '.bak')
  if (!backup || existsSync(file + '.bak-conflict') || !refreshToken(backup)) {
    return null
  }

  try {
    const result = withCredentialFileLock(file, () => {
      const recheck = readRelaxed(file)
      if (recheck !== null) return recheck

      const freshBackup = readRelaxed(file + '.bak')
      if (!freshBackup || existsSync(file + '.bak-conflict') || !refreshToken(freshBackup)) {
        return null
      }

      restoreBackup(file, freshBackup, log)
      return readRelaxed(file)
    })
    return result === undefined ? readRelaxed(file) : result
  } catch {
    log('[agy-link] credential backup or restore failed; check account directory permissions')
    return readRelaxed(file)
  }
}
