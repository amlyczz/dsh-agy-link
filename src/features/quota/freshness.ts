// Throttled per-account quota refresh.
//
// "Refresh the account we are actually using" is the cheapest way to keep the
// quota panel honest: a full-pool sweep every hour leaves a long window in which
// the account burning quota shows an hour-old number. Hitting ONE account right
// after it served a turn fixes exactly that, at one request per account per gap.
//
// The throttle is load-bearing: the routing hooks fire on every turn, and an
// unthrottled refresh would hammer Google's quota endpoint (the same anti-ban
// budget the sweeper protects). Kept dependency-free and injectable for tests.
// 5 minutes, not 1: an opportunistic refresh may spawn `agy -p /usage` for the
// credential-slot owner, so the gap bounds both Google API churn and process
// spawns. Still 12x fresher than the hourly full sweep for the account in use.
export const QUOTA_ACCOUNT_REFRESH_MIN_GAP_MS = 5 * 60_000

export class AccountQuotaRefresher {
  private readonly lastAttemptAt = new Map<string, number>()

  constructor(
    private readonly refresh: (accountId: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly minGapMs: number = QUOTA_ACCOUNT_REFRESH_MIN_GAP_MS,
  ) {}

  /** True when the throttle window has elapsed for this account. */
  canRefresh(accountId: string): boolean {
    const last = this.lastAttemptAt.get(accountId)
    return last === undefined || this.now() - last >= this.minGapMs
  }

  /**
   * Fire-and-forget refresh, throttled per account. Returns whether it started.
   * A throwing refresh is swallowed: quota data is advisory, never a reason to
   * break a turn.
   */
  trigger(accountId: string): boolean {
    if (!this.canRefresh(accountId)) return false
    this.lastAttemptAt.set(accountId, this.now())
    void this.refresh(accountId).catch(() => undefined)
    return true
  }

  /**
   * Await one refresh only when the cached row is older than `maxAgeMs` and the
   * throttle allows it. Used where acting on stale data is worse than a short
   * delay. Returns whether a refresh ran.
   */
  async refreshIfStale(accountId: string, updatedAt: number | undefined, maxAgeMs: number): Promise<boolean> {
    const age = updatedAt === undefined ? Number.POSITIVE_INFINITY : this.now() - updatedAt
    if (age <= maxAgeMs) return false
    if (!this.canRefresh(accountId)) return false
    this.lastAttemptAt.set(accountId, this.now())
    try {
      await this.refresh(accountId)
    } catch {
      // keep the stale snapshot; the next poll will try again
    }
    return true
  }
}
