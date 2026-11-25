// One-shot warning gate shared by the adapter and the ACP dispatch path.

/** Emit `message` once per key, keeping the seen-set bounded (oldest evicted). */
export function warnOnce(
  seen: Set<string>,
  key: string,
  message: string,
  log?: (msg: string) => void,
  maxKeys = 512,
): void {
  if (seen.has(key)) return
  if (seen.size >= maxKeys) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  seen.add(key)
  log?.('WARNING: ' + message)
}