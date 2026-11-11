// Cross-process slot lock with process-liveness probing.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g). File path,
// stale window, poll interval, lock payload and error types are unchanged.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AbortedWaitError, WaitTimeoutError } from './errors.ts'

/**
 * Detect whether an external process by PID is currently running.
 * Uses process.kill(pid, 0) which tests for process existence without sending a signal.
 * - Returns true if the process exists (including EPERM when owned by another user).
 * - Returns false if ESRCH (process does not exist / exited), or if the PID is invalid.
 */
export function isProcessAlive(pid: number | undefined | null): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return true
    return false
  }
}

export const SLOT_LOCK_NAME = '.credential-slot.lock'
export const SLOT_LOCK_STALE_MS = 45_000

export function slotLockFilePath(baseDir: string): string {
  return join(baseDir, SLOT_LOCK_NAME)
}

export interface SlotLockData {
  pid: number
  acquiredAt: number
  holder?: string
}

/**
 * Acquire a cross-process lock for the Windows credential slot.
 * Inspects any existing lock's PID via `process.kill(pid, 0)`.
 * If the recorded holder process has crashed/exited, the dead lock is reclaimed
 * immediately instead of stalling for timeout.
 */
export async function acquireCrossProcessSlotLock(
  baseDir: string,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
    signal?: AbortSignal
    log?: (msg: string) => void
    holder?: string
  } = {},
): Promise<() => void> {
  const lockFile = slotLockFilePath(baseDir)
  const timeoutMs = options.timeoutMs ?? 15_000
  const pollMs = options.pollIntervalMs ?? 50
  const log = options.log ?? ((): void => {})
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0

  try {
    mkdirSync(baseDir, { recursive: true })
  } catch {
    // ignore
  }

  for (;;) {
    if (options.signal?.aborted) {
      throw new AbortedWaitError('aborted while waiting for cross-process slot lock')
    }

    if (existsSync(lockFile)) {
      let isStale = false
      let holderPid: number | undefined
      try {
        const content = readFileSync(lockFile, 'utf8')
        const parsed = JSON.parse(content) as SlotLockData
        holderPid = parsed.pid
        if (typeof holderPid === 'number') {
          if (!isProcessAlive(holderPid)) {
            isStale = true
            log(`[agy-link] removing stale slot lock from dead process ${holderPid} (instant self-heal)`)
          } else if (Date.now() - (parsed.acquiredAt || 0) > SLOT_LOCK_STALE_MS) {
            isStale = true
            log(`[agy-link] removing stale slot lock exceeding ${SLOT_LOCK_STALE_MS}ms timeout`)
          }
        } else {
          isStale = true
        }
      } catch {
        isStale = true
      }

      if (isStale) {
        try {
          unlinkSync(lockFile)
        } catch {
          // ignore
        }
      }
    }

    // Try atomic write of temporary file and rename
    const payload: SlotLockData = {
      pid: process.pid,
      acquiredAt: Date.now(),
      holder: options.holder,
    }
    const tempFile = lockFile + '.tmp-' + process.pid + '-' + Date.now()
    try {
      writeFileSync(tempFile, JSON.stringify(payload), { flag: 'wx', encoding: 'utf8' })
      renameSync(tempFile, lockFile)
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          if (existsSync(lockFile)) {
            const raw = readFileSync(lockFile, 'utf8')
            const parsed = JSON.parse(raw) as SlotLockData
            if (parsed.pid === process.pid) {
              unlinkSync(lockFile)
            }
          }
        } catch {
          // best-effort cleanup
        }
      }
    } catch {
      try {
        unlinkSync(tempFile)
      } catch {
        // ignore
      }
    }

    if (deadline > 0 && Date.now() >= deadline) {
      throw new WaitTimeoutError('timed out waiting for cross-process slot lock')
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }
}