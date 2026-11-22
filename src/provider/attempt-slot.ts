// Credential/concurrency slot handle for one agy attempt (extracted from attempt.ts).
import { acquireCredentialSlot, armSlotHandoff, type SlotHandoff } from '../host/credential-slot.ts'

export interface AttemptSlot {
  /** Release the concurrency slot + credential lease exactly once. */
  releaseOnce: () => void
  /** Arm the narrow credential hand-off (no-op without a lease). */
  armHandoff: () => SlotHandoff | null
}

export function createAttemptSlot(
  concurrencyRelease: (() => void) | null,
  credentialLease: Awaited<ReturnType<typeof acquireCredentialSlot>>,
  log: ((msg: string) => void) | undefined,
): AttemptSlot {
  let release = concurrencyRelease
  let released = false
  let handoff: SlotHandoff | null = null
  const releaseOnce = (): void => {
    if (released) return
    released = true
    if (handoff !== null) {
      handoff.dispose()
    } else {
      try {
        credentialLease?.release()
      } catch {
        // best-effort
      }
    }
    release?.()
    release = null
  }
  return {
    releaseOnce,
    armHandoff: () => {
      if (credentialLease === undefined) return null
      handoff = armSlotHandoff({
        release: () => {
          try {
            credentialLease?.release()
          } catch {
            // best-effort
          }
        },
        log,
      })
      return handoff
    },
  }
}
