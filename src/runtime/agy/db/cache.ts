// In-memory view of one conversation's steps/thoughts, shared by the tool
// args and thought readers so parallel step events cost ONE DB read.
import { isSafeConversationId, setAgyDbDir } from './paths.ts'
import { isBackingOff, loadAgyDbData, resetReaderState } from './reader.ts'
import { MAX_CACHE_AGE_MS, type AgyDbCache, type AgyDbData } from './schema.ts'

const MAX_CACHE_CONVS = 8
const caches = new Map<string, AgyDbCache>()
/** In-flight loader: parallel readFullToolArgs/readStepThoughts share one query per conv+cursor. */
const inFlightLoads = new Map<string, Promise<void>>()

function cacheKeyFor(conversationId: string, accountHome?: string): string {
  return conversationId + '|' + (accountHome ?? '')
}

function getFreshCache(key: string, now: number): AgyDbCache | undefined {
  const entry = caches.get(key)
  if (!entry || !entry.loaded) return undefined
  if (now - entry.cacheTime >= MAX_CACHE_AGE_MS) {
    caches.delete(key)
    return undefined
  }
  // Touch LRU order
  caches.delete(key)
  caches.set(key, entry)
  return entry
}

/**
 * Shared loader behind readFullToolArgs/readStepThoughts: deduplicates
 * concurrent callers into ONE query, performs O(1) incremental tail reads
 * using `maxSeenIdx`, and honors the failure backoff so a missing/failing
 * sqlite3 cannot turn every step event into a re-spawn.
 */
async function loadCached(conversationId: string, stepIndex: number, accountHome?: string): Promise<AgyDbCache | undefined> {
  const now = Date.now()
  const key = cacheKeyFor(conversationId, accountHome)
  if (isBackingOff(now)) return caches.get(key)

  const existing = getFreshCache(key, now)
  const sinceIdx =
    existing !== undefined && existing.maxSeenIdx >= 0
      ? (stepIndex <= existing.maxSeenIdx ? Math.max(0, stepIndex) : existing.maxSeenIdx + 1)
      : 0

  const flightKey = `${key}|${sinceIdx}`
  const running = inFlightLoads.get(flightKey)
  if (running !== undefined) {
    await running
    return caches.get(key)
  }

  const job = (async () => {
    const data = await loadAgyDbData(conversationId, accountHome, sinceIdx)
    const target: AgyDbCache = existing && sinceIdx > 0
      ? existing
      : {
          conversationId,
          steps: new Map(),
          thoughts: new Map(),
          checkedSteps: new Set(),
          maxSeenIdx: -1,
          cacheTime: now,
          loaded: true,
        }
    for (const [k, v] of data.steps) target.steps.set(k, v)
    for (const [k, v] of data.thoughts) target.thoughts.set(k, v)
    for (const k of data.seenSteps) target.checkedSteps.add(k)
    if (data.maxSeenIdx > target.maxSeenIdx) target.maxSeenIdx = data.maxSeenIdx
    target.cacheTime = Date.now()
    target.loaded = true
    caches.delete(key)
    caches.set(key, target)
    while (caches.size > MAX_CACHE_CONVS) {
      const oldest = caches.keys().next()
      if (oldest.done) break
      caches.delete(oldest.value)
    }
  })().finally(() => {
    if (inFlightLoads.get(flightKey) === job) inFlightLoads.delete(flightKey)
  })
  inFlightLoads.set(flightKey, job)
  await job
  return caches.get(key)
}

/**
 * Read the full tool parameter object for a given step index from the agy
 * conversation database. Returns null when the DB is unavailable or does
 * not contain the requested step.
 *
 * Results are cached in an 8-conversation LRU for up to 5 minutes with O(1)
 * incremental tail queries.
 */
export async function readFullToolArgs(
  conversationId: string,
  stepIndex: number,
  accountHome?: string,
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  if (!isSafeConversationId(conversationId)) return null

  const now = Date.now()
  const key = cacheKeyFor(conversationId, accountHome)
  const entry = getFreshCache(key, now)
  if (entry) {
    const cached = entry.steps.get(stepIndex)
    if (cached !== undefined) return cached
    if (entry.checkedSteps.has(stepIndex) && (now - entry.cacheTime) < 500) return null
  }

  const updated = await loadCached(conversationId, stepIndex, accountHome)
  return updated?.steps.get(stepIndex) ?? null
}

/**
 * Read the full thought/reasoning text for a given step index from the agy
 * conversation database. Returns null when the DB is unavailable or the
 * step does not contain thought text.
 */
export async function readStepThoughts(
  conversationId: string,
  stepIndex: number,
  accountHome?: string,
): Promise<string | null> {
  if (!isSafeConversationId(conversationId)) return null

  const now = Date.now()
  const key = cacheKeyFor(conversationId, accountHome)
  const entry = getFreshCache(key, now)
  if (entry) {
    const cached = entry.thoughts.get(stepIndex)
    if (cached !== undefined) return cached
    if (entry.checkedSteps.has(stepIndex) && (now - entry.cacheTime) < 500) return null
  }

  const updated = await loadCached(conversationId, stepIndex, accountHome)
  return updated?.thoughts.get(stepIndex) ?? null
}

/** Clear the DB cache (e.g. when a run settles). */
export function clearAgyDbCache(): void {
  caches.clear()
  inFlightLoads.clear()
  resetReaderState()
}

/**
 * TEST-ONLY injection: point the module at a custom agy conversations dir.
 * Never call from production code (module-level directory is shared within a
 * process); used only by unit tests to exercise parsing against a temp DB.
 */
export function __setAgyDbDirForTest(dir: string): void {
  setAgyDbDir(dir)
  caches.clear()
  inFlightLoads.clear()
  resetReaderState()
}
