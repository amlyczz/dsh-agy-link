// Request-deadline vocabulary — the ONE place the plugin's timeouts live.
//
// Client and host both need these and must agree on their ORDER: a status poll
// is snappier than a write, a write gives up before the host's hard deadline,
// and the host deadline is long enough for `agy /usage` (itself capped at 20s).
//
// Why they exist at all: every console action sets a busy flag and clears it in
// `finally`. Before these bounds, a host route that threw (bare async IIFE, no
// .catch) or a quota refresh waiting on a 20s CLI spawn left the HTTP response
// open forever — so the browser fetch never settled and "同步中" spun forever.

/** Status poll: keep the console responsive, never stack polls. */
export const STATUS_TIMEOUT_MS = 5_000

/** A write (sync / config / auth): the busy flag must always clear. */
export const WRITE_TIMEOUT_MS = 20_000

/** Manual CLI warmup across one or more accounts (up to 45s per CLI probe). */
export const WARMUP_WRITE_TIMEOUT_MS = 90_000

/** Host-side hard deadline for any plugin route; the last line of defence. */
export const ROUTE_TIMEOUT_MS = 30_000

/** Slack above a job's own deadline before its route may give up. */
export const ROUTE_DEADLINE_SLACK_MS = 15_000

/**
 * Deadline for a route that fronts a genuinely long job (a translation is a
 * full agy turn: `translateTimeoutMs` defaults to 120s and medium effort
 * typically takes 20–45s). The general 30s route deadline would answer 504
 * first, and because `sendJson` is exactly-once the real 200 would then be
 * discarded — every slow translation would look like a failure.
 */
export function longRouteTimeout(jobTimeoutMs: number): number {
  const budget = Number.isFinite(jobTimeoutMs) && jobTimeoutMs > 0 ? jobTimeoutMs : ROUTE_TIMEOUT_MS
  return Math.max(ROUTE_TIMEOUT_MS, budget + ROUTE_DEADLINE_SLACK_MS)
}

/** How long a manual quota refresh keeps its dedupe entry when work never settles. */
export const QUOTA_REFRESH_DEDUP_MS = 90_000

/**
 * How long an endpoint that just failed keeps its "try me LAST" memory.
 *
 * Measured 2026-11-19: retrieveUserQuotaSummary on
 * daily-cloudcode-pa.googleapis.com resets the connection after 5-8s for every
 * account, while the sandbox endpoint answers. The endpoint list is walked from
 * the same end on every refresh, so without this memory each account pays that
 * timeout first — including the hourly background sweep. Short enough that a
 * recovered endpoint returns on its own.
 */
export const QUOTA_ENDPOINT_DOWN_MS = 10 * 60_000

/**
 * How long a "no valid licence" verdict (403 from the quota summary) keeps the
 * UNATTENDED probe away from that account. An explicit user refresh ignores it,
 * so a restored licence is picked up the moment the user asks for it.
 */
export const QUOTA_LICENSE_RETRY_MS = 6 * 3600_000

/**
 * How long a free-tier account's refused summary call stays suppressed.
 * Aligned with the weekly quota window: the verdict only changes when the
 * account's entitlement does, which cannot happen within hours (#137).
 */
export const QUOTA_FREE_TIER_RETRY_MS = 7 * 24 * 3600_000

/**
 * How long a refused summary stays suppressed for an account that has ALREADY
 * reported a 5-hour window.
 *
 * `no_summary_access` is the *shape* of a free-tier refusal (no 5h bucket), not
 * proof of a free plan. A paid account can still get 403 PERMISSION_DENIED
 * transiently, and freezing it for a week left its Gemini/Claude rows stuck on
 * a multi-day-old snapshot while Argon kept advancing — the mixed-age card
 * reported 2026-11-23. Re-probe hourly instead; one extra request per hour per
 * refused account is far below the anti-ban budget this module protects.
 */
export const QUOTA_SUMMARY_REFUSED_RETRY_MS = 1 * 3600_000

/**
 * Same-egress parallelism for a user-initiated pool sweep. Antigravity's risk
 * control correlates accounts by source IP, so this stays deliberately small;
 * the scheduler still spaces every account start by the organic jitter, and the
 * unattended sweep always uses 1.
 */
export const QUOTA_FORCE_CONCURRENCY = 2

/**
 * Grace the idle watchdog grants before killing a quiet child. libuv runs the
 * timers phase BEFORE the poll phase: when the DSH host's event loop is blocked
 * (a large parse, many parallel workers), an expired watchdog can fire before
 * queued stdout/stderr from a still-active child is delivered. One short grace
 * lets that output arrive instead of killing a healthy run. Capped at the run's
 * own idle budget so short-budget tests and genuine idle kills stay prompt.
 */
export const WATCHDOG_GRACE_MS = 5_000

/**
 * Grace after agy reports `root agent idle; waiting ... for background task(s)`.
 * The prompt turn's answer is already streamed; a stuck GUI dialog / background
 * child would otherwise keep print mode alive for hours (issue #119). Short and
 * fixed so the turn settles promptly instead of hanging DSH's event stream.
 */
export const IDLE_BACKGROUND_GRACE_MS = 5_000
