// Theoretical Arrival Time (TAT) rate & burst spacing limiter.
//
// Synchronous slot reservation BEFORE `await` eliminates thundering-herd races
// where N concurrent sessions read the same timestamp, sleep identically, and
// spawn at the exact same millisecond. Also enforces minimum cross-account
// spacing when two accounts share the same proxy egress IP.

const MAX_TRACKED_KEYS = 256

export class SpawnLimiter {
  private readonly rateSlots: number[] = []
  private readonly nextAccountAt = new Map<string, number>()
  private readonly nextEgressAt = new Map<string, number>()

  /**
   * Reserve a slot in the global per-minute sliding window.
   * Returns `{ delayMs, slotAt }`; call `cancelRateSlot(slotAt)` on abort.
   */
  reserveRateLimitSlot(limitPerMinute: number, now = Date.now()): { delayMs: number; slotAt: number } {
    if (limitPerMinute <= 0) return { delayMs: 0, slotAt: now }
    const cutoff = now - 60_000
    while (this.rateSlots.length > 0 && this.rateSlots[0]! <= cutoff) {
      this.rateSlots.shift()
    }
    const slotAt =
      this.rateSlots.length >= limitPerMinute
        ? Math.max(now, this.rateSlots[this.rateSlots.length - limitPerMinute]! + 60_000)
        : now
    this.rateSlots.push(slotAt)
    return { delayMs: Math.max(0, slotAt - now), slotAt }
  }

  cancelRateLimitSlot(slotAt: number): void {
    const idx = this.rateSlots.indexOf(slotAt)
    if (idx !== -1) this.rateSlots.splice(idx, 1)
  }

  /**
   * Reserve a spawn timestamp honoring BOTH per-account burst spacing and
   * shared-proxy cross-account spacing. Returns milliseconds to wait (`>= 0`).
   */
  reserveSpawnDelay(
    accountId: string | undefined,
    egressKey: string | undefined,
    minAccountIntervalMs = 500,
    jitterMs = Math.floor(Math.random() * 300),
    now = Date.now(),
  ): number {
    if (!accountId && !egressKey) return 0
    if (minAccountIntervalMs <= 0 && jitterMs <= 0) return 0

    const accReadyAt = accountId ? (this.nextAccountAt.get(accountId) ?? 0) : 0
    const egressReadyAt = egressKey ? (this.nextEgressAt.get(egressKey) ?? 0) : 0
    const slotAt = Math.max(now, accReadyAt, egressReadyAt)

    const accountStep = Math.max(0, minAccountIntervalMs + jitterMs)
    const egressStep = Math.max(350, Math.floor(minAccountIntervalMs * 0.75)) + Math.floor(jitterMs * 0.5)

    if (accountId) {
      if (this.nextAccountAt.size >= MAX_TRACKED_KEYS && !this.nextAccountAt.has(accountId)) {
        const oldest = this.nextAccountAt.keys().next().value
        if (oldest !== undefined) this.nextAccountAt.delete(oldest)
      }
      this.nextAccountAt.set(accountId, slotAt + accountStep)
    }
    if (egressKey) {
      if (this.nextEgressAt.size >= MAX_TRACKED_KEYS && !this.nextEgressAt.has(egressKey)) {
        const oldest = this.nextEgressAt.keys().next().value
        if (oldest !== undefined) this.nextEgressAt.delete(oldest)
      }
      this.nextEgressAt.set(egressKey, slotAt + egressStep)
    }

    return Math.max(0, slotAt - now)
  }
}
