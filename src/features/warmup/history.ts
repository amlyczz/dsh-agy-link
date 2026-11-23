// Warmup cooldown history: durable per-key timestamps with write-then-rename
// persistence. Re-reads before deciding so web + headless hosts do not fire the
// same probe twice.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryWriteFileAtomic } from '../../common/atomic-write.ts'
import { stateDir } from '../../common/config.ts'
import { THIRTY_DAYS_MS } from './policy.ts'

export class WarmupHistoryStore {
  private history = new Map<string, number>()
  private filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(stateDir(), 'warmup-history.json')
    this.load()
  }

  load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8')
        const data = JSON.parse(raw) as Record<string, unknown>
        if (data && typeof data === 'object') {
          // Reject non-numeric / NaN timestamps: `now - NaN < cooldown` is
          // false, which would silently bypass every cooldown.
          const next = new Map<string, number>()
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'number' && Number.isFinite(value)) next.set(key, value)
          }
          this.history = next
        }
      }
    } catch {
      // best-effort load
    }
  }

  save(): void {
    this.pruneOldEntries()
    const obj = Object.fromEntries(this.history.entries())
    tryWriteFileAtomic(this.filePath, JSON.stringify(obj, null, 2))
  }

  checkCooldown(key: string, cooldownMs: number, now = Date.now()): boolean {
    // Re-read before deciding so a web host and a headless host sharing
    // pool.json do not each fire the same warmup probe.
    this.load()
    const last = this.history.get(key)
    if (last === undefined) return false
    return now - last < cooldownMs
  }

  /** Latest timestamp for `key`, re-read from disk (cross-host / post-restart). */
  lastRecordedAt(key: string): number | undefined {
    this.load()
    return this.history.get(key)
  }

  record(key: string, now = Date.now()): void {
    this.history.set(key, now)
    this.save()
  }

  pruneOldEntries(now = Date.now()): void {
    const cutoff = now - THIRTY_DAYS_MS
    for (const [k, ts] of this.history.entries()) {
      if (ts < cutoff) {
        this.history.delete(k)
      }
    }
  }

  clear(): void {
    this.history.clear()
    this.save()
  }
}
