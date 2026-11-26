// Schema vocabulary for the agy conversation DB: the shape of the steps table
// we query, the step types that carry tool/thought evidence, and the cache
// records the reader fills.

/** One tool step: name plus the FULL JSON args recovered from the payload. */
export interface CachedStep {
  name: string
  args: Record<string, unknown>
}

export interface AgyDbCache {
  conversationId: string
  /** stepIndex → parsed tool info (name + args) */
  steps: Map<number, CachedStep>
  /** stepIndex → extracted thought text */
  thoughts: Map<number, string>
  /** stepIndex → rendered tool-result text (field 140.2.1) */
  results: Map<number, string>
  /** Step indices that were present in the database when loaded */
  checkedSteps: Set<number>
  /** Highest step idx observed in the DB for O(1) incremental tail reads. */
  maxSeenIdx: number
  /** Timestamp of the last DB query for this conversation. */
  cacheTime: number
  loaded: boolean
}

export interface AgyDbData {
  steps: Map<number, CachedStep>
  thoughts: Map<number, string>
  results: Map<number, string>
  seenSteps: Set<number>
  maxSeenIdx: number
}

/** Steps whose payload carries full tool parameters (and toolAction prose). */
export const TOOL_STEP_TYPES = new Set([5, 7, 8, 9, 17, 21, 33, 101, 132, 138, 139])

export const MAX_CACHE_AGE_MS = 300_000 // 5 minutes
export const STEP_FILTER_SQL = `(step_type IN (5,7,8,9,14,15,17,21,33,101,132,138,139)) AND length(step_payload) > 20`

/**
 * Query tool-type steps AND text/thinking steps with payload > 20 bytes.
 * step_type 14/15 are agent_response prose; the rest are tool steps.
 */
export const STEP_QUERY_SQL = `SELECT idx, step_type, hex(step_payload) AS payload_hex FROM steps WHERE ${STEP_FILTER_SQL}`
export const STEP_QUERY_RAW_SQL = `SELECT idx, step_type, step_payload FROM steps WHERE ${STEP_FILTER_SQL} AND idx >= ?`
