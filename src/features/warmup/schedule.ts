// Pure scheduling & Antigravity sliding-idle reset-time detection for WarmupService.
//
// Antigravity's unactivated quota windows slide their `resetTime` forward in
// lockstep with wall-clock time (`resetTime ≈ now + windowDuration`). Comparing
// two consecutive quota observations distinguishes a genuinely active countdown
// (constant `resetTime`) from an idle unactivated window (`ΔresetTime ≈ ΔobservedAt`).

export interface ResetObservation {
  resetTimeIso: string
  observedAtMs: number
  remainingFraction: number
}

const SLIDING_DRIFT_TOLERANCE_MS = 5_000
const MIN_OBSERVATION_GAP_MS = 5_000

/**
 * Return true when two consecutive full-quota observations show `resetTime`
 * sliding forward at the same rate as wall-clock time (within ±5s), proving
 * the quota window is still idle/unactivated.
 */
export function detectSlidingIdleReset(
  prev: ResetObservation | undefined,
  curr: ResetObservation,
): boolean {
  if (!prev) return false
  if (prev.remainingFraction < 0.999 || curr.remainingFraction < 0.999) return false
  const obsDelta = curr.observedAtMs - prev.observedAtMs
  if (obsDelta < MIN_OBSERVATION_GAP_MS) return false
  const r1 = Date.parse(prev.resetTimeIso)
  const r2 = Date.parse(curr.resetTimeIso)
  if (Number.isNaN(r1) || Number.isNaN(r2)) return false
  const resetDelta = r2 - r1
  return resetDelta > 0 && Math.abs(resetDelta - obsDelta) <= SLIDING_DRIFT_TOLERANCE_MS
}

function parseHHMM(raw: string): { hour: number; minute: number } | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hour = Number.parseInt(m[1]!, 10)
  const minute = Number.parseInt(m[2]!, 10)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  return { hour, minute }
}

function localPartsInTimezone(now: number, timezone: string): { dayKey: string; hour: number; minute: number } {
  const date = new Date(now)
  const tz = timezone.trim()
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      ...(tz !== '' ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    const parts = fmt.formatToParts(date)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
    return {
      dayKey: `${get('year')}-${get('month')}-${get('day')}`,
      hour: Number.parseInt(get('hour'), 10) || 0,
      minute: Number.parseInt(get('minute'), 10) || 0,
    }
  } catch {
    // Fallback to system local time if an invalid IANA timezone was supplied.
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return { dayKey: `${y}-${m}-${d}`, hour: date.getHours(), minute: date.getMinutes() }
  }
}

/** The local calendar day key at `now` (used by the durable schedule anchors). */
export function localDayKey(now: number, timezone: string): string {
  return localPartsInTimezone(now, timezone).dayKey
}

/**
 * Extra delay applied to a daily anchor, 0–20 minutes, derived from the day key.
 *
 * A warmup that starts at 08:00:00 every single day is a signature: nothing a
 * human does is that regular. The delay is deterministic per day (two ticks on
 * the same day must agree, or the run would fire twice), but unpredictable
 * across days.
 */
export const DAILY_JITTER_MAX_MINUTES = 20

export function dailyJitterMinutes(dayKey: string): number {
  let hash = 0
  for (let i = 0; i < dayKey.length; i++) {
    hash = (hash * 31 + dayKey.charCodeAt(i)) % 1_000_003
  }
  return hash % (DAILY_JITTER_MAX_MINUTES + 1)
}

/**
 * Check whether a daily scheduled warmup (`HH:MM` in an optional IANA timezone)
 * is due now and has not yet fired for today's date key. The anchor is shifted
 * by `dailyJitterMinutes(dayKey)` and clamped to the end of the day.
 */
export function isDailyScheduleDue(opts: {
  dailyTime: string
  timezone: string
  now: number
  lastFiredDayKey: string | null
}): { due: boolean; dayKey: string } {
  const parsed = parseHHMM(opts.dailyTime)
  if (!parsed) return { due: false, dayKey: '' }
  const cur = localPartsInTimezone(opts.now, opts.timezone)
  if (opts.lastFiredDayKey === cur.dayKey) return { due: false, dayKey: cur.dayKey }
  const curMinutes = cur.hour * 60 + cur.minute
  // Clamp to 23:59: a 23:55 anchor plus jitter must still fire today.
  const targetMinutes = Math.min(24 * 60 - 1, parsed.hour * 60 + parsed.minute + dailyJitterMinutes(cur.dayKey))
  return { due: curMinutes >= targetMinutes, dayKey: cur.dayKey }
}

/**
 * Check whether a fixed-interval warmup (`intervalHours` > 0) is due now.
 */
export function isIntervalScheduleDue(opts: {
  intervalHours: number
  now: number
  lastRunAt: number | null
}): boolean {
  if (!Number.isFinite(opts.intervalHours) || opts.intervalHours <= 0) return false
  if (opts.lastRunAt === null) return true
  return opts.now - opts.lastRunAt >= opts.intervalHours * 3600_000
}
