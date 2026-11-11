// In-memory view of one conversation's steps/thoughts, shared by the tool
// args and thought readers so parallel step events cost ONE DB read.
import { isSafeConversationId, setAgyDbDir } from './paths.ts'
import { isBackingOff, loadAgyDbData, resetReaderState } from './reader.ts'
import { MAX_CACHE_AGE_MS, type AgyDbCache, type AgyDbData } from './schema.ts'

let cache: AgyDbCache | null = null
let cacheTime = 0
/** In-flight loader: parallel readFullToolArgs/readStepThoughts share one spawn. */
let loadInFlight: { key: string; promise: Promise<AgyDbData> } | null = null

/**
 * Shared loader behind readFullToolArgs/readStepThoughts: deduplicates
 * concurrent callers into ONE spawn, and honors the failure backoff so a
 * missing/failing sqlite3 cannot turn every step event into a re-spawn.
 */
async function loadCached(conversationId: string, accountHome?: string): Promise<void> {
  const now = Date.now()
  // Negative-cache window after a failed load: serve the (empty) cached view
  // instead of re-spawning per event.
  if (isBackingOff(now)) return

  const key = conversationId + '|' + (accountHome ?? '')
  if (loadInFlight !== null && loadInFlight.key === key) {
    await loadInFlight.promise
    return
  }
  const promise = loadAgyDbData(conversationId, accountHome)
  loadInFlight = { key, promise }
  try {
    const data = await promise
    cache = {
      conversationId,
      steps: data.steps,
      thoughts: data.thoughts,
      checkedSteps: data.seenSteps,
      loaded: true,
    }
    cacheTime = now
  } finally {
    if (loadInFlight !== null && loadInFlight.promise === promise) loadInFlight = null
  }
}

/**
 * Read the full tool parameter object for a given step index from the agy
 * conversation database. Returns null when the DB is unavailable or does
 * not contain the requested step.
 *
 * Results are cached per conversationId for up to 5 minutes to avoid
 * repeated DB reads within the same session.
 */
export async function readFullToolArgs(
  conversationId: string,
  stepIndex: number,
  accountHome?: string,
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  if (!isSafeConversationId(conversationId)) return null

  const now = Date.now()
  if (cache?.conversationId === conversationId && cache.loaded && (now - cacheTime) < MAX_CACHE_AGE_MS) {
    const cached = cache.steps.get(stepIndex)
    if (cached !== undefined) return cached
    if (cache.checkedSteps.has(stepIndex) && (now - cacheTime) < 500) return null
  }

  await loadCached(conversationId, accountHome)

  return cache?.steps.get(stepIndex) ?? null
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
  if (cache?.conversationId === conversationId && cache.loaded && (now - cacheTime) < MAX_CACHE_AGE_MS) {
    const cached = cache.thoughts.get(stepIndex)
    if (cached !== undefined) return cached
    if (cache.checkedSteps.has(stepIndex) && (now - cacheTime) < 500) return null
  }

  await loadCached(conversationId, accountHome)

  return cache?.thoughts.get(stepIndex) ?? null
}

/** Clear the DB cache (e.g. when a run settles). */
export function clearAgyDbCache(): void {
  cache = null
  resetReaderState()
}

/**
 * TEST-ONLY injection: point the module at a custom agy conversations dir.
 * Never call from production code (module-level directory is shared within a
 * process); used only by unit tests to exercise parsing against a temp DB.
 */
export function __setAgyDbDirForTest(dir: string): void {
  setAgyDbDir(dir)
  cache = null
  cacheTime = 0
  resetReaderState()
}
