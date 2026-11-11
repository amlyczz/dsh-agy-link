// Failover / rate-limit / network-streak bookkeeping.
//
// Extracted verbatim from AgyAdapter (claimFailover, noteNetworkFailure,
// clearNetworkStreak and their Maps). Bounding retries by pool depth lives here
// so the adapter only owns the decision to consult it. All windows and limits
// are unchanged.
import { Err, isAccountScopedFailure } from '../common/types.ts'

export interface FailoverContext {
  /** Number of enabled pool accounts (drives the spare-hop budget). */
  enabledAccounts: () => number
  /** True when every account leaves through the same proxy/window. */
  sharesSingleEgress: () => boolean
}

/**
 * sessionKey -> account failovers claimed inside the current window.
 *
 * A settled recording that died of an ACCOUNT-scoped failure is retried on
 * another account instead of being replayed (post-tool quota exhaustion used
 * to dead-end the turn). That retry happens inside one DSH step, so DSH's own
 * retry budget cannot bound it: without this counter a soft capacity refusal
 * (which cools nothing) would rotate A→B→C→A…, re-running the user's tools on
 * every cycle.
 */
export class FailoverBudget {
  private static readonly FAILOVER_WINDOW_MS = 120_000
  /**
   * Same shape, but for HARD rate-limit hops only. A hard 429 gives the failed
   * account a cooldown of at least the server-quoted reset (default 10m), so
   * each claim provably makes progress and cannot loop. The generic 120s/2-hop
   * budget above exists to stop SOFT failures (which cool nothing) from
   * rotating forever — but a long-running turn's quota failures arrive spread
   * over minutes (observed live: 429 at 20:28 with "Resets in 11m", further
   * hops at 20:28:43 and 20:29:17), so the tight window spent itself while a
   * full-quota account sat idle and the turn dead-ended (2026-10-10 20:29).
   */
  private static readonly RATE_LIMIT_FAILOVER_WINDOW_MS = 600_000
  /**
   * The streak drives the 5s/15s/30s retry delay handed to DSH. A success (or
   * any non-transport failure) clears it, and a gap longer than the window
   * treats the next failure as a fresh streak: a user who retries a turn ten
   * minutes after an outage must not start by waiting 30 seconds.
   */
  private static readonly NETWORK_STREAK_WINDOW_MS = 600_000

  private readonly failover = new Map<string, { count: number; firstAt: number }>()
  private readonly rateLimit = new Map<string, { count: number; firstAt: number }>()
  private readonly network = new Map<string, { count: number; at: number }>()

  /**
   * Claim one account failover for a session, bounded by the pool's spare
   * depth ((enabled accounts - 1) inside a short window). Returns false when
   * the failure is not account-scoped or the budget is spent — the caller then
   * replays the recorded failure so the turn ends with the real error.
   */
  claim(sessionKey: string, code: string | undefined, ctx: FailoverContext): boolean {
    if (!isAccountScopedFailure(code)) return false
    // A transport failure on a SHARED egress is account-scoped in name only:
    // the step must still be re-run (the settled recording would otherwise be
    // replayed verbatim), but nothing is wrong with the account, so no rotation
    // budget is spent and the sticky pointer stays put. DSH's own retry budget
    // (three hops for NETWORK) still bounds the re-runs.
    if (code === Err.NETWORK && ctx.sharesSingleEgress()) return true
    const max = Math.max(1, ctx.enabledAccounts() - 1)
    const now = Date.now()
    // HARD rate limits are tracked separately: every claim cools the failed
    // account for the server-quoted reset, so hops are self-bounding by pool
    // depth — they must not starve the tiny soft-failure budget.
    if (code === Err.RATE_LIMIT) {
      const prevRl = this.rateLimit.get(sessionKey)
      const freshRl = prevRl === undefined || now - prevRl.firstAt > FailoverBudget.RATE_LIMIT_FAILOVER_WINDOW_MS
      const countRl = freshRl ? 0 : prevRl.count
      if (countRl >= max) return false
      this.rateLimit.set(sessionKey, { count: countRl + 1, firstAt: freshRl ? now : prevRl.firstAt })
      return true
    }
    const prev = this.failover.get(sessionKey)
    const fresh = prev === undefined || now - prev.firstAt > FailoverBudget.FAILOVER_WINDOW_MS
    const count = fresh ? 0 : prev.count
    if (count >= max) return false
    this.failover.set(sessionKey, { count: count + 1, firstAt: fresh ? now : prev.firstAt })
    return true
  }

  dropBudget(sessionKey: string): void {
    this.failover.delete(sessionKey)
  }

  clearRateLimit(sessionKey: string): void {
    this.rateLimit.delete(sessionKey)
  }

  /**
   * Record one transport failure and return the streak position (1-based).
   * Position drives the delay requested from DSH.
   */
  noteNetworkFailure(sessionKey: string): number {
    if (sessionKey === '') return 1
    const now = Date.now()
    const prev = this.network.get(sessionKey)
    const fresh = prev === undefined || now - prev.at > FailoverBudget.NETWORK_STREAK_WINDOW_MS
    const count = (fresh ? 0 : prev.count) + 1
    this.network.set(sessionKey, { count, at: now })
    return count
  }

  /** Drop the transport streak: the session reached Google (or failed another way). */
  clearNetworkStreak(sessionKey: string): void {
    if (sessionKey === '') return
    this.network.delete(sessionKey)
  }
}