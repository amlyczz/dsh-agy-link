// Temp-directory cleanup for tests.
//
// On Windows a child process that has just been killed can keep a handle on its
// temp directory for a few seconds (observed: the ACP kill-tree suite flaked
// once under full-suite concurrency with EPERM on `rmSync` after a 1 s retry
// budget). Ten seconds absorbs the dying process tree without hiding a real
// leak: a directory that is still locked after that still fails the test.
import { rmSync } from 'node:fs'

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 })
}