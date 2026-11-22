// Reset countdowns and old-log sweeping for AccountPoolManager.
// Extracted so pure countdown queries and filesystem log retention stay
// self-contained and keep AccountPoolManager well within the file budget.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ManagedAccount, ModelFamily } from '../../common/pool-types.ts'
import { LOW_QUOTA_5H, LOW_QUOTA_WEEKLY, nextQuotaResetAt } from './selection.ts'

/** Get countdown in milliseconds until the earliest account in cooldown resets. */
export function earliestResetCountdown(
  accounts: readonly ManagedAccount[],
  family: ModelFamily,
  now = Date.now(),
): number | null {
  let earliest: number | null = null
  for (const acc of accounts) {
    if (!acc.enabled) continue
    const cd = acc.cooldowns?.[family]
    if (cd && cd.cooldownUntil > now && (earliest === null || cd.cooldownUntil < earliest)) {
      earliest = cd.cooldownUntil
    }
  }
  return earliest !== null ? Math.max(0, earliest - now) : null
}

/**
 * Earliest moment ANY enabled account could serve `family` again: the sooner
 * of a cooldown expiry and a quota-window reset.
 */
export function earliestAvailableCountdown(
  accounts: readonly ManagedAccount[],
  family: ModelFamily,
  now = Date.now(),
): number | null {
  let earliest: number | null = null
  const bump = (at: number | null): void => {
    if (at === null || Number.isNaN(at) || at <= now) return
    if (earliest === null || at < earliest) earliest = at
  }
  for (const acc of accounts) {
    if (!acc.enabled || acc.authRequired) continue
    const cd = acc.cooldowns?.[family]
    if (cd && cd.cooldownUntil > now) bump(cd.cooldownUntil)
    const quota = acc.quotas?.[family]
    if (quota === undefined) continue
    const clearedAt = acc.quotaGateClearedAt?.[family]
    if (clearedAt !== undefined && (quota.updatedAt ?? 0) <= clearedAt) continue
    const drained5h = typeof quota.remainingFraction === 'number' && quota.remainingFraction <= LOW_QUOTA_5H
      && typeof quota.resetTime === 'string' && Date.parse(quota.resetTime) > now
    const drainedWeekly = typeof quota.weeklyFraction === 'number' && quota.weeklyFraction <= LOW_QUOTA_WEEKLY
      && typeof quota.weeklyResetTime === 'string' && Date.parse(quota.weeklyResetTime) > now
    if (drained5h || drainedWeekly) bump(nextQuotaResetAt(acc, family))
  }
  return earliest !== null ? Math.max(0, (earliest as number) - now) : null
}

/**
 * Sweep `cli-*.log` files older than `maxDays` across managed account homes
 * plus the system `~/.gemini/antigravity-cli/log` directory.
 *
 * `extraLogDirs` carries directories outside those homes — the plugin's own
 * `logs/` directory holding the `acp-*.log` files the ACP transport asks agy
 * to write (`--log-file`). They follow the same retention window so a long
 * lived persistent session cannot accumulate logs forever.
 */
export function sweepOldAgyLogs(
  accounts: readonly ManagedAccount[],
  systemHome: string,
  maxDays = 7,
  now = Date.now(),
  extraLogDirs: readonly string[] = [],
): number {
  const maxAgeMs = Math.max(1, maxDays) * 86_400_000
  let removed = 0
  const targetLogDirs = [join(systemHome, '.gemini', 'antigravity-cli', 'log')]
  for (const acc of accounts) {
    if (acc.dir) {
      targetLogDirs.push(join(acc.dir, '.gemini', 'antigravity-cli', 'log'))
    }
  }
  for (const extra of extraLogDirs) targetLogDirs.push(extra)
  for (const logDir of targetLogDirs) {
    if (!existsSync(logDir)) continue
    try {
      for (const f of readdirSync(logDir)) {
        if (!f.endsWith('.log')) continue
        if (!f.startsWith('cli-') && !f.startsWith('acp-')) continue
        const fp = join(logDir, f)
        try {
          const st = statSync(fp)
          if (now - st.mtimeMs > maxAgeMs) {
            rmSync(fp, { force: true })
            removed++
          }
        } catch {
          // Ignore file error
        }
      }
    } catch {
      // Ignore dir error
    }
  }
  return removed
}
