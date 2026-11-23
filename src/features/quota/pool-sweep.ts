// Pool-wide quota sweeps and the auth-flag self-heal pass.
//
// Extracted from QuotaService (file budget) but kept I/O-injected like the rest
// of features/quota: the service supplies its own `refreshAccountQuota`, proxy
// lookup and credential-store readers.
//
// Two passes live here:
//   `sweepPoolQuotas`        — the hourly/global poll (background gate, identity
//                              reconciliation, egress-bounded force sweep);
//   `reverifyFlaggedAccounts` — the 2-minute self-heal for 需重新登录 flags.
import {
  authReverifyDelayMs,
  isTerminalAuthError,
  needsAuthReverify,
  shouldPollAccount,
  type ManagedAccount,
} from '../../common/pool-types.ts'
import { QUOTA_FORCE_CONCURRENCY } from '../../common/timeouts.ts'
import { staggerJitterMs } from '../../domain/quota/identity.ts'
import { sweepAccountsByEgress } from './sweep.ts'

/** The pool surface these passes need. */
export interface PoolSweepPool {
  readonly dir: string
  getAccounts(): readonly ManagedAccount[]
  getAccount(id: string): ManagedAccount | undefined
  healAuthFlagsFromQuota(): string[]
  noteAuthReverifyAttempt(id: string): void
  resetAccountIdentity(id: string, email: string): void
}

export interface PoolSweepDeps {
  pool: PoolSweepPool
  /** Refresh one account's quotas (the caller's pipeline; `force` = user action). */
  refreshAccountQuota(account: ManagedAccount, force: boolean): Promise<unknown>
  proxyOf(account: ManagedAccount): string | undefined
  detectEmailFromLogs(home: string): string | undefined
  /** Email of the durable primary credential record (Windows only; else undefined). */
  readStoredPrimaryEmail(): string | undefined
  /** The real HOME the primary account shares with the system `agy`. */
  systemHome(): string
  forceStaggerMs?: () => number
  forceConcurrency?: () => number
  now?: () => number
}

/**
 * Refresh quota statistics for all accounts in the pool.
 *
 * Automatic polling (force=false) skips restricted accounts (disabled /
 * auth-quarantined / in cooldown) so the poller never keeps knocking on Google
 * endpoints for accounts already known to be limited. Manual force refresh from
 * the UI refreshes everything.
 *
 * Before gating, a ZERO-NETWORK identity reconciliation runs for flagged slots:
 * an external `agy logout` + re-login writes the new email into the newest CLI
 * logs, and detecting that locally lets us reset the stale quarantine/cooldowns
 * so the slot rejoins polling — no extra request to Google is made for this
 * check (risk-control neutral).
 */
export async function sweepPoolQuotas(deps: PoolSweepDeps, force = false): Promise<void> {
  let accounts = deps.pool.getAccounts()
  if (!force) {
    const now = deps.now?.() ?? Date.now()
    for (const acc of accounts) {
      const flagged = acc.authRequired || Object.values(acc.cooldowns ?? {}).some((cd) => cd && cd.cooldownUntil > now)
      if (!acc.systemHome || !flagged) continue
      const home = acc.systemHome || !acc.dir ? deps.systemHome() : acc.dir
      let detected: string | undefined
      if (process.platform === 'win32') {
        detected = deps.readStoredPrimaryEmail()
      }
      if (!detected) {
        const fromLogs = deps.detectEmailFromLogs(home)
        const siblingEmails = new Set(
          deps.pool
            .getAccounts()
            .filter((a) => a.id !== acc.id && a.email)
            .map((a) => a.email!),
        )
        if (fromLogs && !siblingEmails.has(fromLogs)) {
          detected = fromLogs
        }
      }
      if (detected && detected !== acc.email) {
        deps.pool.resetAccountIdentity(acc.id, detected)
      }
    }
    // Auth-flagged accounts re-enter the poll once their flag is stale
    // enough: one token-endpoint verification either clears the flag (the
    // common transient false positive) or re-stamps it. This is what makes
    // "needs re-login" self-heal without a manual quota refresh.
    accounts = accounts.filter((acc) => shouldPollAccount(acc) || needsAuthReverify(acc))
    // Background sweeps stay sequential with a 2-second gap. Only the
    // credential-store owner can spawn a CLI now (see readCliUsageFamilies),
    // so this is no longer about CLI contention — it keeps the unattended,
    // hourly REST burst gentle instead. An hourly sweep has no latency budget
    // worth trading that safety margin for; explicit user refreshes below run
    // fully concurrently.
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]!
      await deps.refreshAccountQuota(acc, false).catch(() => null)
      if (i < accounts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, staggerJitterMs()))
      }
    }
    // Any quota row newer than a flag already proves the login works, whoever
    // wrote it (web + CLI share pool.json). Cheap, zero-network reconciliation.
    deps.pool.healAuthFlagsFromQuota()
    return
  }
  // Even on manual force refresh, never touch disabled or terminally TOS-banned
  // accounts: knocking on a banned account from the same proxy egress risks
  // correlating sibling accounts.
  accounts = accounts.filter((acc) => acc.enabled && !isTerminalAuthError(acc.authError))
  const nextForceGapMs = (): number =>
    deps.forceStaggerMs?.() ??
    (process.env.NODE_TEST_CONTEXT !== undefined ? 0 : 400 + Math.floor(Math.random() * 450))

  // Isolated accounts run pure REST calls and never touch the Windows OS
  // Credential Manager slot; only the single `systemHome` account uses
  // `credentialSlotMutex` inside `readCliUsageFamilies`. Keep bounded
  // per-egress concurrency across all platforms to avoid slow serial sweeps.
  const concurrency = Math.max(1, Math.floor(deps.forceConcurrency?.() ?? QUOTA_FORCE_CONCURRENCY))
  await sweepAccountsByEgress(accounts, {
    egressOf: (acc) => deps.proxyOf(acc) || '__direct__',
    run: async (acc) => {
      await deps.refreshAccountQuota(acc, force).catch(() => null)
    },
    staggerMs: nextForceGapMs,
    concurrency,
  })
  deps.pool.healAuthFlagsFromQuota()
}

/**
 * Fast self-heal for quarantined accounts.
 *
 * The background pool poll is hourly, so a transient misfire used to leave a red
 * 需重新登录 badge (and the account out of rotation) for up to ~70 minutes
 * although nothing was wrong with the login. This pass runs on a short timer and
 * only touches accounts whose flag has outlived its own back-off:
 *   - a false positive clears on the first attempt (one quota request),
 *   - a genuinely dead login backs off (2m → 4m → 8m → 16m → 30m) instead of
 *     knocking on Google every two minutes.
 * The zero-network reconciliation runs first: a quota snapshot newer than the
 * flag already disproves it.
 */
export async function reverifyFlaggedAccounts(deps: PoolSweepDeps): Promise<void> {
  deps.pool.healAuthFlagsFromQuota()
  const now = deps.now?.() ?? Date.now()
  const targets = deps.pool
    .getAccounts()
    .filter((acc) => needsAuthReverify(acc, now, authReverifyDelayMs(acc.authReverifyAttempts ?? 0)))
  for (let i = 0; i < targets.length; i++) {
    const acc = targets[i]!
    await deps.refreshAccountQuota(acc, false).catch(() => null)
    // Still flagged ⇒ the login really is unusable: back off before the next try.
    if (deps.pool.getAccount(acc.id)?.authRequired) deps.pool.noteAuthReverifyAttempt(acc.id)
    if (i < targets.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, staggerJitterMs()))
    }
  }
}
