// Process-wide serialization for the single Windows credential slot.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g). No behaviour
// change: same FIFO queue, same lost-wakeup poll, same error types.
import { AbortedWaitError, WaitTimeoutError } from './errors.ts'

/**
 * FIFO async mutex. One instance guards the single Windows credential slot;
 * holding it across an entire agy run is what makes the handoff safe.
 *
 * The original implementation chained promises (`tail.then(gate)`), which is
 * FIFO but structurally unable to remove a waiter: a turn abandoned or aborted
 * while queued stayed in the chain forever, and if its gate was never resolved
 * every later waiter wedged with it (the 2026-10-16 cardboard-empire zombie
 * turn: queued 30+ minutes past the slot's release, immune to Stop, because
 * nothing observed the wait). This rewrite keeps an explicit queue so a
 * cancelled or timed-out waiter is REMOVED and the next waiter is woken in its
 * place, and the wait is guarded by a short poll that re-checks liveness — a
 * lost wakeup can no longer park a turn silently.
 */
export class AsyncMutex {
  private holders = 0
  private readonly queue: Array<() => void> = []

  /** Number of holders plus waiters; 0 means the mutex is free. */
  get pending(): number {
    return this.holders + this.queue.length
  }

  /** Waiters currently queued behind the holder(s). */
  get waiting(): number {
    return this.queue.length
  }

  /**
   * Acquire the mutex.
   *
   * @param opts.signal  cancel the wait (the waiter is removed and the next
   *   one is woken); rejects with `AbortedWaitError`
   * @param opts.timeoutMs  bound the wait; rejects with `WaitTimeoutError`
   * @param opts.pollMs  liveness self-check interval while queued (0 = off).
   *   The poll re-checks `shouldProceed` — a hook that lets the caller verify
   *   the wait is still legitimate (e.g. the queue actually advanced). If it
   *   returns true while the mutex appears free, the waiter takes the mutex
   *   directly, healing a lost wakeup within one poll interval instead of
   *   hanging forever.
   */
  async acquire(opts: {
    signal?: AbortSignal
    timeoutMs?: number
    pollMs?: number
    /** Liveness hook consulted by the poll: true = the wait is still wanted. */
    shouldProceed?: () => boolean
  } = {}): Promise<() => void> {
    const signal = opts.signal
    if (signal?.aborted) throw new AbortedWaitError('aborted before mutex acquisition')
    if (this.holders < 1 && this.queue.length === 0) {
      this.holders = 1
      return () => this.releaseOne()
    }

    const pollMs = opts.pollMs ?? 0
    const timeoutMs = opts.timeoutMs
    let onAbort: (() => void) | null = null
    let timer: NodeJS.Timeout | null = null
    let pollTimer: NodeJS.Timeout | null = null

    const result = new Promise<() => void>((resolve, reject) => {
      let settled = false
      let entry: (() => void) | null = null
      let takenDirectly = false

      const cleanup = (): void => {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort)
          onAbort = null
        }
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      const grant = (): void => {
        if (settled) return
        settled = true
        cleanup()
        entry = null
        resolve(() => this.releaseOne())
      }

      const fail = (err: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (entry !== null) {
          // Remove this waiter from the queue. If it was already shifted out
          // by releaseOne(), ownership was handed off to it: pass ownership on.
          const idx = this.queue.indexOf(entry)
          if (idx >= 0) {
            this.queue.splice(idx, 1)
          } else {
            this.releaseOne()
          }
          entry = null
        } else if (takenDirectly) {
          // The poll granted the mutex between a cancel arriving and this
          // failure landing. Honor the grant: the caller released nothing yet.
          this.releaseOne()
        }
        reject(err)
      }

      entry = (): void => grant()
      this.queue.push(entry)

      onAbort = (): void => {
        fail(new AbortedWaitError('aborted while waiting for the mutex'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => fail(new WaitTimeoutError('timed out waiting for the mutex')), timeoutMs)
        timer.unref?.()
      }

      // Lost-wakeup self-heal: while queued, periodically re-check whether the
      // mutex has actually become free. If the wake call was lost (an earlier
      // defect parked a turn 30+ minutes past a released slot), the poll takes
      // the mutex directly instead of waiting forever.
      if (pollMs > 0 && opts.shouldProceed !== undefined) {
        pollTimer = setInterval(() => {
          if (settled) return
          if (this.holders < 1 && this.queue[0] === entry && opts.shouldProceed?.()) {
            const idx = this.queue.indexOf(entry)
            if (idx >= 0) this.queue.splice(idx, 1)
            entry = null
            takenDirectly = true
            this.holders = 1
            grant()
          }
        }, pollMs)
        pollTimer.unref?.()
      }
    })

    return result
  }

  private releaseOne(): void {
    const next = this.queue.shift()
    if (next) {
      // Direct handoff: holders remains 1 so concurrent callers cannot barge.
      queueMicrotask(next)
    } else {
      this.holders = Math.max(0, this.holders - 1)
    }
  }
}

/** The one process-wide instance guarding the credential slot. */
export const credentialSlotMutex = new AsyncMutex()