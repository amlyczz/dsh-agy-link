// Pre-spawn status notices: session-visible "waiting for the credential slot"
// reasoning deltas.
//
// Extracted from src/host/adapter.ts so the attempt machinery
// (provider/attempt.ts) can emit them without importing the adapter, which
// imports it. Logic is byte-for-byte unchanged; the adapter re-exports both
// symbols so existing imports and tests keep working.
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Reserved block index for pre-spawn status notices.
 *
 * Negative on purpose: the mapper's own blocks count up from 0, so a negative
 * index can never be closed by a mapper `block-end` later in the run (the
 * assembler ignores deltas for a closed index). Deltas alone are enough — the
 * assembler explicitly tolerates delta-only protocols — so the notices land as
 * one growing reasoning block at the top of the turn.
 */
export const STATUS_NOTICE_BLOCK_INDEX = -1

/**
 * Session-visible line for a pool-reset wait: the turn is parked until the next
 * quota window / cooldown reset lands, which can be many minutes of otherwise
 * silent `running`. Both languages, like the credential-slot notice below.
 *
 * The remaining time is derived from the pool's cached snapshot, so it is an
 * estimate: a reset that lands late just re-arms the same line.
 */
export function describePoolResetWait(resetInMs: number, capMs: number, waitedMs: number): string {
  const secs = (ms: number): number => Math.max(0, Math.ceil(ms / 1000))
  return `[agy] 号池暂时耗尽：正在等待配额/冷却重置（剩余约 ${secs(resetInMs)}s，最多等 ${secs(capMs)}s，已等 ${secs(waitedMs)}s）。重置后会自动开始，按 Stop 可取消。\n`
    + `[agy] Antigravity pool is drained: waiting for the next quota/cooldown reset (~${secs(resetInMs)}s left, cap ${secs(capMs)}s, waited ${secs(waitedMs)}s). It starts by itself after the reset; press Stop to cancel.`
}

/**
 * Await `work` while periodically yielding a SESSION-VISIBLE notice.
 *
 * Why this exists: Windows has ONE machine-global credential slot, so every
 * session's agy run is serialized behind whichever session got there first.
 * A healthy long run (a 15-minute build, a 240-minute long tool) made the
 * OTHER sessions sit with a completely empty transcript for up to
 * `dispatchTimeoutMinutes` — indistinguishable from a freeze. The console
 * heartbeat was invisible to the user, so the only honest signal was "nothing
 * is happening" (2026-10-22: two sessions looked hung for 15 minutes while
 * another project's agy run held the slot).
 *
 * Resolves with `work`'s value; rejects with `work`'s rejection untouched, so
 * the caller's existing error classification is unchanged.
 */
export async function* awaitWithNotices<T>(
  work: Promise<T>,
  opts: {
    /** Delay before the FIRST notice (and the base for later ones). */
    intervalMs: number
    /** Growth factor between notices (default 1 = constant cadence). */
    escalate?: number
    /** Upper bound for the cadence after escalation. */
    maxIntervalMs?: number
    /** Text for the current wait duration in milliseconds. */
    notice: (elapsedMs: number) => string
  },
): AsyncGenerator<StreamChunk, T, void> {
  const baseInterval = opts.intervalMs > 0 ? opts.intervalMs : 30_000
  const escalate = opts.escalate !== undefined && opts.escalate > 1 ? opts.escalate : 1
  const maxInterval = opts.maxIntervalMs !== undefined && opts.maxIntervalMs > baseInterval ? opts.maxIntervalMs : baseInterval * 100
  let intervalMs = baseInterval
  const startedAt = Date.now()
  type Settled = { ok: true; value: T } | { ok: false; error: unknown }
  let settled: Settled | null = null
  let wake: (() => void) | null = null
  const ping = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }
  void work.then(
    (value) => {
      if (settled === null) {
        settled = { ok: true, value }
        ping()
      }
    },
    (error) => {
      if (settled === null) {
        settled = { ok: false, error }
        ping()
      }
    },
  )
  let pendingNotices = 0
  let timer: NodeJS.Timeout | null = null
  const arm = (): void => {
    if (timer !== null || settled !== null) return
    timer = setTimeout(() => {
      timer = null
      pendingNotices++
      intervalMs = Math.min(Math.round(intervalMs * escalate), maxInterval)
      ping()
    }, intervalMs)
    timer.unref?.()
  }
  try {
    arm()
    for (;;) {
      if (settled !== null) break
      if (pendingNotices > 0) {
        pendingNotices--
        const text = opts.notice(Date.now() - startedAt)
        // A notice that renders nothing must not put a bare newline into the
        // transcript: auxiliary calls and slow self-heals have no pool wait to
        // report, and a `'\n'`-only reasoning delta is a visible empty chunk.
        // Keep the cadence, skip the chunk.
        if (text.trim() !== '') {
          yield { type: 'reasoning-delta', index: STATUS_NOTICE_BLOCK_INDEX, text: text + '\n' }
        }
        // Re-arm AFTER resuming: a generator suspended at the yield must not
        // swallow the next tick (that bug produced exactly one notice and then
        // silence for the rest of the wait).
        arm()
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const done = settled as Settled | null
  if (done === null) throw new Error('awaitWithNotices lost its completion signal')
  if (done.ok) return done.value
  throw done.error
}