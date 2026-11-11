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
  /** Step indices that were present in the database when loaded */
  checkedSteps: Set<number>
  loaded: boolean
}

export interface AgyDbData {
  steps: Map<number, CachedStep>
  thoughts: Map<number, string>
  seenSteps: Set<number>
}

/** Steps whose payload carries full tool parameters (and toolAction prose). */
export const TOOL_STEP_TYPES = new Set([5, 7, 8, 9, 17, 21, 33, 101, 132, 138, 139])

export const MAX_CACHE_AGE_MS = 300_000 // 5 minutes

/**
 * Query tool-type steps AND text/thinking steps with payload > 20 bytes.
 * step_type 14/15 are agent_response prose; the rest are tool steps.
 */
export const STEP_QUERY_SQL = `SELECT idx, step_type, hex(step_payload) AS payload_hex FROM steps WHERE (step_type IN (5,7,8,9,14,15,17,21,33,101,132,138,139)) AND length(step_payload) > 20`
