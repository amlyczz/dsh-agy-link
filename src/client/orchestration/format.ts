// Pure formatters for the 编排 page (no React, so tests can load them).

/** `12,345` → `12.3k`, `997` → `997`, `1_048_576` → `1.0M`. */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

/** `950` → `950ms`, `1234` → `1.2s`, `65_000` → `1m 05s`, `3_600_000` → `1h 00m`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms'
  const s = ms / 1000
  if (s < 60) return (Math.round(s * 10) / 10).toFixed(s < 10 ? 1 : 0) + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return String(m) + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's'
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}

/** Context occupancy as a 0–100 bar width; undefined when the window is unknown. */
export function contextPercent(used: number | undefined, size: number | undefined): number | undefined {
  if (used === undefined || size === undefined || !Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return undefined
  return Math.max(0, Math.min(100, (used / size) * 100))
}