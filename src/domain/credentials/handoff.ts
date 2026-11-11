// Startup-read slot hand-off controller.
//
// MOVED VERBATIM from src/host/credential-slot.ts (Phase 5g): releasing the
// machine-wide slot as soon as agy has read its credential, with the same
// timeout, idempotence and log lines.
//
// MEASURED 2026-10-22 (agy 1.4.3, live 14-minute run):
//   I ... 23:02:35.889 printmode.go:403  Print mode: not authenticated, trying silent auth
//   I ... 23:02:38.617 printmode.go:405  Print mode: silent auth succeeded
//   ... 14 minutes of streamGenerateContent with ZERO further token/auth lines.
// In print mode agy resolves its credential ONCE at startup and keeps it in
// memory afterwards. Holding the machine-wide slot for the whole run is
// therefore unnecessary serialization.

/** Default ceiling for holding the slot while waiting for the first event. */
export const SLOT_HANDOFF_TIMEOUT_MS = 45_000

export interface SlotHandoff {
  /** The run produced its first event: agy has read the credential. */
  onFirstEvent(): void
  /** The run ended (or was abandoned) before the first event. */
  dispose(): void
  /** True once the lease was handed back. */
  released(): boolean
  /** True when the timeout (not the first event) triggered the hand-off. */
  timedOut(): boolean
}

/**
 * Arrange for a credential-slot lease to be released after the startup read.
 *
 * Correctness rests on the caller's spawn ordering, which does not change: the
 * identity is installed UNDER the mutex immediately before the spawn, so
 * whatever a later switcher does cannot affect a run that is already past its
 * read. The residual exposure is a mid-run 401 forcing a re-auth (agy would
 * then read whatever identity is installed at that moment); the hand-off logs
 * when it fires so that case is diagnosable instead of silent.
 */
export function armSlotHandoff(opts: {
  release: () => void
  timeoutMs?: number
  log?: (msg: string) => void
}): SlotHandoff {
  const timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : SLOT_HANDOFF_TIMEOUT_MS
  const log = opts.log ?? ((): void => {})
  let done = false
  let byTimeout = false
  let timer: NodeJS.Timeout | null = null
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const fire = (reason: 'first-event' | 'timeout' | 'run-end'): void => {
    if (done) return
    done = true
    clear()
    try {
      opts.release()
    } catch {
      // best effort — the lease is refcounted and its release is idempotent
    }
    if (reason !== 'first-event') {
      log('[agy-link] credential slot handed back at ' + reason + ' (no first event yet)')
    }
  }
  timer = setTimeout(() => {
    timer = null
    if (done) return
    byTimeout = true
    log(
      '[agy-link] credential slot held for ' + Math.round(timeoutMs / 1000) +
      's without a first event — handing it back so other sessions are not blocked',
    )
    fire('timeout')
  }, timeoutMs)
  timer.unref?.()
  return {
    onFirstEvent: (): void => fire('first-event'),
    dispose: (): void => fire('run-end'),
    released: (): boolean => done,
    timedOut: (): boolean => byTimeout,
  }
}