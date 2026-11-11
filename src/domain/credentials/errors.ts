// Error types for the credential-slot state machine. Kept in one module so the
// host facade re-exports the SAME class objects: callers rely on `instanceof`
// (adapter catches AbortedWaitError / WaitTimeoutError / SlotUnavailableError).

/** The caller's abort signal fired while queued on the mutex. */
export class AbortedWaitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortedWaitError'
  }
}

/** The bounded wait elapsed before the mutex became available. */
export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaitTimeoutError'
  }
}

/** The slot cannot be handed over safely; the caller must abort the run. */
export class SlotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlotUnavailableError'
  }
}