// Sweep scheduling for the account pool.
//
// WHY: a manual "刷新额度" walks every enabled account. Before this module the
// force path grouped accounts by egress and then awaited them strictly one by
// one, so a five-account pool on one proxy (the common case: every account
// inherits the same system proxy) took the SUM of every account's network
// cascade — measured ~55s on 2026-11-19, with zero progress feedback.
//
// The pool must still never fire a simultaneous multi-account burst at one
// egress (anti-ban rule), so this scheduler:
//   • keeps different egresses fully parallel (they never share an IP),
//   • bounds same-egress concurrency (default 2 for a user-initiated sweep),
//   • spaces every account START by the caller's jitter even while concurrent,
//     which keeps the burst profile "staggered" rather than "simultaneous".
// The unattended background sweep passes concurrency 1 and therefore stays
// exactly as serial as before.
export interface SweepOptions<T> {
  /** Accounts sharing a key share an upstream egress and are scheduled together. */
  egressOf: (account: T) => string
  run: (account: T) => Promise<void>
  /** Organic jitter applied between account STARTS (not between completions). */
  staggerMs: () => number
  /** Max accounts refreshing at once within one egress (default 1 = serial). */
  concurrency?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Run `items` with at most `limit` in flight, never starting two within `staggerMs`. */
export async function runStaggered<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
  staggerMs: () => number,
): Promise<void> {
  const queue = [...items]
  if (queue.length === 0) return
  const width = Math.max(1, Math.min(Math.floor(limit), queue.length))
  let starting = 0
  let lastStart = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      if (starting > 0) {
        const gap = staggerMs()
        if (gap > 0) {
          const wait = lastStart + gap - Date.now()
          if (wait > 0) await sleep(wait)
        }
      }
      starting++
      lastStart = Date.now()
      await run(item)
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
}

/**
 * Sweep accounts grouped by egress.
 *
 * Errors never abort the sweep (one broken account must not silence the pool),
 * matching the previous `.catch(() => null)` semantics at the call site.
 */
export async function sweepAccountsByEgress<T>(
  accounts: readonly T[],
  options: SweepOptions<T>,
): Promise<void> {
  const groups = new Map<string, T[]>()
  for (const account of accounts) {
    const egress = options.egressOf(account)
    const group = groups.get(egress)
    if (group === undefined) groups.set(egress, [account])
    else group.push(account)
  }

  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
  await Promise.allSettled(
    [...groups.values()].map((group) =>
      runStaggered(group, concurrency, options.run, options.staggerMs),
    ),
  )
}
