/**
 * Type contract for scripts/publish-retry.mjs (plain JS, injectable for tests).
 * Keeping it here is what lets the TDD test suite type-check under tsc.
 */
export interface PublishRunResult {
  status: number
  stdout: string
  stderr: string
}

export interface PublishOptions {
  pkg?: { name: string; version: string }
  run?: (bin: string, args: string[]) => PublishRunResult
  sleep?: (ms: number) => Promise<void>
  attempts?: number
  delays?: number[]
  verifyAttempts?: number
  verifyDelayMs?: number
  strictVerify?: boolean
  log?: (msg: string) => void
}

export interface PublishOutcome {
  published: boolean
  attempts: number
  verified?: boolean
}

export function isTransientPublishError(text: string): boolean
export function publishWithRetry(options?: PublishOptions): Promise<PublishOutcome>
