/**
 * Parse agy's background-wait line.
 *
 * While a turn is finishing, agy prints
 * `root agent idle; waiting for N background task(s)` — and N is its OWN count
 * of work it launched and is still waiting on (a build, an integration test, a
 * Docker job). That count is authoritative: as long as N > 0 the wait is
 * legitimate, so no grace period can make terminating the tree correct
 * (issue #144 — the reaper used a hard-coded 5 s and killed those turns).
 *
 * Returns `null` when the text carries no count (older agy builds, or a chunk
 * boundary cut the line), which keeps the conservative "arm the grace" path.
 */
export function backgroundTasksFrom(text: string): number | null {
  const match = /root agent idle;\s*waiting\s+for\s+(\d+)\s+background/i.exec(text)
  if (match === null) return null
  const count = Number(match[1])
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}
