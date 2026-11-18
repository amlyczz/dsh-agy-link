// Pure quota burn-rate & pacing math shared by the scheduler (domain) and UI
// quota bars (client). Lives in common/ so client/* stays 100% host-free.

export const FIVE_HOUR_WINDOW_MS = 5 * 3_600_000
export const WEEKLY_WINDOW_MS = 7 * 24 * 3_600_000

export type QuotaPaceStatus =
  | 'unknown'
  | 'unactivated'
  | 'reset'
  | 'surplus'
  | 'on_track'
  | 'burning_fast'

export interface QuotaPacing {
  status: QuotaPaceStatus
  /** Remaining window time as a fraction in [0, 1]. */
  timeRemainingFraction: number
  /** Elapsed window time as a fraction in [0, 1]. */
  elapsedFraction: number
  /** `remainingFraction - timeRemainingFraction`: >0 means ahead of clock (surplus). */
  surplus: number
  /** Consumption speed vs uniform linear burn (`1.0` = sustainable). */
  burnMultiplier: number
}

/**
 * Compare remaining quota fraction against remaining reset window fraction.
 *
 * For example, 80% remaining with 1h left in a 5h window (20% time left) has
 * `surplus = +0.60` ('surplus' — use freely before rollover), whereas 25%
 * remaining with 6d left in a 7d window (85.7% time left) has `surplus = -0.61`
 * ('burning_fast' — will exhaust early at current pace).
 */
export function computeQuotaPacing(
  remainingFraction: number | undefined,
  resetTimeIso: string | undefined,
  windowMs: number,
  now = Date.now(),
): QuotaPacing {
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction) || windowMs <= 0) {
    return { status: 'unknown', timeRemainingFraction: 1, elapsedFraction: 0, surplus: 0, burnMultiplier: 1 }
  }
  const clampedQuota = Math.max(0, Math.min(1, remainingFraction))
  if (!resetTimeIso) {
    return {
      status: clampedQuota >= 0.999 ? 'unactivated' : 'unknown',
      timeRemainingFraction: 1,
      elapsedFraction: 0,
      surplus: 0,
      burnMultiplier: 1,
    }
  }
  const resetMs = Date.parse(resetTimeIso)
  if (Number.isNaN(resetMs)) {
    return { status: 'unknown', timeRemainingFraction: 1, elapsedFraction: 0, surplus: 0, burnMultiplier: 1 }
  }
  const diffMs = resetMs - now
  if (diffMs <= 0) {
    return { status: 'reset', timeRemainingFraction: 0, elapsedFraction: 1, surplus: clampedQuota, burnMultiplier: 0 }
  }
  const timeRemainingFraction = Math.max(0, Math.min(1, diffMs / windowMs))
  const elapsedFraction = 1 - timeRemainingFraction
  const surplus = clampedQuota - timeRemainingFraction
  const usedFraction = Math.max(0, 1 - clampedQuota)
  const burnMultiplier = elapsedFraction >= 0.02 ? usedFraction / elapsedFraction : 1

  let status: QuotaPaceStatus = 'on_track'
  if (elapsedFraction >= 0.04 && surplus <= -0.15) {
    status = 'burning_fast'
  } else if (surplus >= 0.15) {
    status = 'surplus'
  }
  return { status, timeRemainingFraction, elapsedFraction, surplus, burnMultiplier }
}
