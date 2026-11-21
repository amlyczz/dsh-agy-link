// Gate 2: which account did this `agy acp` process actually authenticate as?
//
// The Windows credential slot (`gemini:antigravity`) is machine-wide and agy
// reads it once at startup. Another agy process refreshing the slot at its own
// hourly mark can therefore hand THIS process a different account than the one
// we dispatched, and nothing in the JSON-RPC stream says so. agy does record
// the resolved identity in its own `--log-file`, which is the only offline
// proof available: `applyAuthResult: email=<addr>, authMethod=consumer` a few
// seconds after start.
import { readLogSlice } from '../../host/agy-log.ts'

/** How long to wait for agy to print its resolved identity into the log. */
export const IDENTITY_PROBE_MS = 8_000

/** Identity recorded in the process log, or null while it is not there yet. */
export function readAuthEmailFromLog(logFile: string | null): string | null {
  if (logFile === null) return null
  let text = ''
  try {
    text = readLogSlice(logFile, 0)
  } catch {
    return null
  }
  const m = /applyAuthResult:\s*email=([^\s,;]+)/i.exec(text) ??
    /authenticated successfully as\s+([^\s,;]+)/i.exec(text)
  const email = m?.[1]?.trim() ?? ''
  if (email === '' || !email.includes('@')) return null
  return email.toLowerCase()
}

/**
 * Poll the process log for its identity. The line lands ~4.7s after spawn, so a
 * bounded wait keeps a slow start from turning every turn into a false mismatch.
 * A log that never names an identity is NOT proof of a mismatch (a build may not
 * print it); only a DIFFERENT identity is actionable.
 */
export async function awaitAuthEmail(
  logFile: string | null,
  isAlive: () => boolean,
  probeMs = IDENTITY_PROBE_MS,
): Promise<string | null> {
  const deadline = Date.now() + probeMs
  let actual = readAuthEmailFromLog(logFile)
  while (actual === null && isAlive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    actual = readAuthEmailFromLog(logFile)
  }
  return actual
}
