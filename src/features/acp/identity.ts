// Gate 2: which account did this `agy acp` process actually authenticate as?
//
// The Windows credential slot (`gemini:antigravity`) is machine-wide and agy
// reads it once at startup. Another agy process refreshing the slot at its own
// hourly mark can therefore hand THIS process a different account than the one
// we dispatched, and nothing in the JSON-RPC stream says so. agy does record
// the resolved identity in its own `--log-file`, which is the only offline
// proof available: `applyAuthResult: email=<addr>, authMethod=consumer` a few
// seconds after start.
import { looksLikeNetworkError } from '../../common/types.ts'
import { readLogSlice } from '../../host/agy-log.ts'

/** How long to wait for agy to print its resolved identity into the log. */
export const IDENTITY_PROBE_MS = 8_000

export interface AuthEvidence {
  /** Parsed identity, or null while the log does not name one. */
  email: string | null
  /** agy authenticated from the machine-wide OS keyring, not an isolated HOME. */
  keyringFallback: boolean
  /** An `applyAuthResult` line was seen at all (even with an empty email). */
  authSeen: boolean
  /**
   * agy's own profile lookup (`keyringAuth: failed to fetch user info`) died on
   * the network, which is WHY the email is empty. A flaky proxy produces the
   * same log shape as a real keyring bleed, so this is the discriminator between
   * "we cannot prove the identity" and "this process is another account".
   */
  userinfoTransportFailure: boolean
}

/** Full auth evidence from the process log (identity + how it authenticated). */
export function readAuthEvidenceFromLog(logFile: string | null): AuthEvidence {
  const empty: AuthEvidence = {
    email: null,
    keyringFallback: false,
    authSeen: false,
    userinfoTransportFailure: false,
  }
  if (logFile === null) return empty
  let text = ''
  try {
    text = readLogSlice(logFile, 0)
  } catch {
    return empty
  }
  const keyringFallback = /ChainedAuth:\s*authenticated via keyring/i.test(text)
  const seen = /applyAuthResult:/i.test(text) || /authenticated successfully as/i.test(text)
  const m = /applyAuthResult:\s*email=([^\s,;]+)/i.exec(text) ??
    /authenticated successfully as\s+([^\s,;]+)/i.exec(text)
  const email = m?.[1]?.trim().toLowerCase() ?? ''
  // Only agy's OWN userinfo lookup counts: the profile fetch is what fills the
  // email field, so its transport failure explains an empty one.
  const userinfoLine = /keyringAuth:\s*failed to fetch user info:[^\n]*/i.exec(text)?.[0]
  return {
    email: email !== '' && email.includes('@') ? email : null,
    keyringFallback,
    authSeen: seen,
    userinfoTransportFailure: userinfoLine !== undefined && looksLikeNetworkError(userinfoLine),
  }
}

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
  return (await awaitAuthEvidence(logFile, isAlive, probeMs)).email
}

/**
 * What the log proves about THIS process's account.
 *
 * `unknown`  — the log names nobody (older build / killed early): inconclusive.
 * `unproven` — agy fell back to the keyring and could not name the account
 *              because its userinfo lookup died on the network: retryable, NOT a
 *              dead login and NOT a wrong-account proof.
 * `mismatch` — the log names a DIFFERENT account, or proves a keyring fallback
 *              without any transport excuse.
 */
export type IdentityVerdict =
  | { kind: 'ok' }
  | { kind: 'unknown' }
  | { kind: 'unproven'; message: string }
  | { kind: 'mismatch'; message: string }

/**
 * Decide whether the resolved auth evidence proves the wrong account.
 *
 * The distinction that matters: a red 需重新登录 badge removes the account from
 * rotation until the next background re-verification, so only evidence that
 * actually names another account may quarantine. "Keyring fallback, identity
 * unproven" on its own — with agy's profile lookup failing on the network — is
 * a transport symptom: rotate/retry the turn, never the account.
 */
export function classifyIdentity(
  evidence: AuthEvidence,
  expected: string,
  expectedIsolated: boolean,
): IdentityVerdict {
  if (evidence.email !== null) {
    if (evidence.email === expected) return { kind: 'ok' }
    return {
      kind: 'mismatch',
      message: `ACP identity mismatch: agy authenticated as ${evidence.email}, expected ${expected}`,
    }
  }
  if (!evidence.keyringFallback) return { kind: 'unknown' }
  // The primary rides the real system keyring by design.
  if (!expectedIsolated) return { kind: 'ok' }
  // A keyring fallback is only dangerous when it cannot PROVE the expected
  // identity: on macOS agy labels the credential source "keyring" even when the
  // plugin pre-seeded the slot for this account and the email is correct.
  if (evidence.userinfoTransportFailure) {
    return {
      kind: 'unproven',
      message:
        'ACP identity unproven: agy fell back to the keyring and could not confirm ' + expected +
        "'s identity because its userinfo lookup failed on the network (EOF / timeout) — retrying instead of quarantining",
    }
  }
  return {
    kind: 'mismatch',
    message:
      'ACP identity mismatch: agy authenticated from the machine-wide keyring without ' +
      'proving ' + expected + "'s identity — refusing to spend another account's quota",
  }
}

/** Wait for the auth evidence; the keyring/empty-email verdict is as important as the address. */
export async function awaitAuthEvidence(
  logFile: string | null,
  isAlive: () => boolean,
  probeMs = IDENTITY_PROBE_MS,
): Promise<AuthEvidence> {
  const deadline = Date.now() + probeMs
  let evidence = readAuthEvidenceFromLog(logFile)
  while (!evidence.authSeen && isAlive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    evidence = readAuthEvidenceFromLog(logFile)
  }
  return evidence
}
