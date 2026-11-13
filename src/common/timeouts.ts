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

/** A write (sync / warmup / config / auth): the busy flag must always clear. */
export const WRITE_TIMEOUT_MS = 20_000

/** Host-side hard deadline for any plugin route; the last line of defence. */
export const ROUTE_TIMEOUT_MS = 30_000

/**
 * Grace the idle watchdog grants before killing a quiet child. libuv runs the
 * timers phase BEFORE the poll phase: when the DSH host's event loop is blocked
 * (a large parse, many parallel workers), an expired watchdog can fire before
 * queued stdout/stderr from a still-active child is delivered. One short grace
 * lets that output arrive instead of killing a healthy run. Capped at the run's
 * own idle budget so short-budget tests and genuine idle kills stay prompt.
 */
export const WATCHDOG_GRACE_MS = 5_000
