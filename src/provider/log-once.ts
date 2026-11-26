/** Log once per key, keeping the seen-set bounded (oldest evicted). */
export function logOnce(
  seen: Set<string>,
  key: string,
  emit: () => void,
  maxKeys = 512,
): void {
  if (seen.has(key)) return
  if (seen.size >= maxKeys) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  seen.add(key)
  emit()
}
