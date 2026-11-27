// Pre-stream ACP authentication detection & single-retry credential healing.
//
// Applies uniformly to BOTH primary and isolated pool accounts: when a resident
// `agy acp` process fails `session/resume`/`session/load`/`session/new` with an
// auth error (`auth_required`, `invalid_grant`, "not logged into Antigravity"),
// the process has latched onto an unauthenticated backend state and must be
// discarded, refreshed once on disk / Credential Manager, and respawned cleanly.
import type { ManagedAccount } from '../../common/pool-types.ts'
import { looksLikeAuthFailure } from '../../common/types.ts'
import type { AttemptDeps } from '../../provider/attempt.ts'

const ACP_AUTH_ERROR_RE =
  /\bauth_required\b|authentication required|invalid_grant|not logged into antigravity|silent sign-in failed/i

/** True when a pre-stream ACP JSON-RPC error indicates unauthenticated or revoked credentials. */
export function isAcpPreStreamAuthError(message: string): boolean {
  return looksLikeAuthFailure(message) || ACP_AUTH_ERROR_RE.test(message)
}

/**
 * Refresh the account's OAuth credential (and re-assert the Windows credential
 * slot / primary disk token file when applicable) before retrying a fresh ACP process.
 */
export async function healAcpAuthOnce(opts: {
  deps: AttemptDeps
  account: ManagedAccount
  usesSharedSlot: boolean
}): Promise<boolean> {
  const { deps, account, usesSharedSlot } = opts
  const refreshed = deps.ensureFreshToken
    ? await deps.ensureFreshToken(account).catch(() => false)
    : false
  if (
    process.platform === 'win32' &&
    deps.reinstallCredentialSlot &&
    (usesSharedSlot || account.systemHome || !account.dir)
  ) {
    const reinstalled = deps.reinstallCredentialSlot(account)
    return refreshed || reinstalled
  }
  return refreshed
}
