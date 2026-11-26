// Pure helpers for RunRecording: tool-error classification, mirror callId
// encoding/decoding, usage breakdown predicates, and per-span usage merging.
import { isNonConsumableResultError, type AgyEvent, type RawUsage } from '../common/types.ts'

/** Status guidance only: retain the original tool error for replay and logs. */
export type ToolErrorKind = 'missing_file' | 'system_protection' | 'approval' | 'tool_error'

export function classifyToolError(error: string): ToolErrorKind {
  if (/\b(no such file|file not found|cannot find (?:the )?file|enoent)\b/i.test(error)) return 'missing_file'
  if (/\b(system protection|protected by (?:the )?system|hardcoded.*protection|cannot bypass.*protection)\b/i.test(error)) return 'system_protection'
  if (/\b(permission|denied|denial|approval)\b/i.test(error)) return 'approval'
  return 'tool_error'
}

export function isConsumableResult(ev: { ok: boolean; response: string; error?: string }): boolean {
  return (ev.ok || ev.response !== '') && !isNonConsumableResultError(ev.ok, ev.error, ev.response)
}

export function isFinishableEvent(ev: AgyEvent, cutOnTool: boolean): boolean {
  if (ev.kind === 'result' && isConsumableResult(ev)) return true
  return Boolean(
    cutOnTool
      && ev.kind === 'step'
      && ev.stepKind === 'tool'
      && ev.tool !== undefined
      && (ev.state === 'DONE' || ev.state === 'ERROR' || ev.state === 'CANCELED' || ev.state === 'CANCELLED' || ev.state === 'RUNNING'
        || (ev.state === undefined && (ev.tool.output !== undefined || ev.tool.error !== undefined))),
  )
}

export function selectSpanUsage(
  pending: RawUsage | null,
  resultRaw: RawUsage | undefined,
  anyUsageEmitted: boolean,
): RawUsage | null {
  if (pending !== null && (hasUsageBreakdown(pending) || !resultRaw || Object.keys(resultRaw).length === 0)) {
    return pending
  }
  if (resultRaw !== undefined && Object.keys(resultRaw).length > 0 && !anyUsageEmitted) {
    return resultRaw
  }
  return null
}

/**
 * True when a usage sample carries a token breakdown rather than a bare input
 * count. Only such samples may stand in for the result envelope's usage; see
 * `RunRecording.finalUsage` and issue #158.
 */
export function hasUsageBreakdown(raw: RawUsage): boolean {
  const positive = (v: number | undefined): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0
  return positive(raw.output_tokens) || positive(raw.cache_read_tokens) ||
    positive(raw.cache_write_tokens) || positive(raw.thinking_tokens) ||
    positive(raw.total_tokens)
}

export interface EmittedUsageBuckets {
  cacheRead: boolean
  cacheWrite: boolean
}

export function usageBucketsOf(raw: RawUsage): EmittedUsageBuckets {
  return {
    cacheRead: raw.cache_read_tokens !== undefined,
    cacheWrite: raw.cache_write_tokens !== undefined,
  }
}

export function buildZeroDeltaUsage(buckets: EmittedUsageBuckets | null): RawUsage | null {
  if (buckets === null) return null
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    ...(buckets.cacheRead ? { cache_read_tokens: 0 } : {}),
    ...(buckets.cacheWrite ? { cache_write_tokens: 0 } : {}),
  }
}

/**
 * Single-span multi-call usage merge (issue #161): prompt-side fields take the
 * latest call so `contextPressure` never doubles, while generation-side fields
 * sum across distinct stepKeys (replacing if the same stepKey updates).
 */
export function mergeSpanUsage(
  cur: RawUsage | null,
  raw: RawUsage,
  prevGen: { output: number; thinking: number } | undefined,
  nextOut: number,
  nextThink: number,
): RawUsage {
  if (cur === null) return { ...raw }
  const merged: RawUsage = { ...cur }
  if (raw.input_tokens !== undefined) merged.input_tokens = raw.input_tokens
  if (raw.cache_read_tokens !== undefined) merged.cache_read_tokens = raw.cache_read_tokens
  if (raw.cache_write_tokens !== undefined) merged.cache_write_tokens = raw.cache_write_tokens
  if (raw.total_tokens !== undefined) merged.total_tokens = raw.total_tokens
  if (raw.output_tokens !== undefined || cur.output_tokens !== undefined) {
    merged.output_tokens = Math.max(0, (cur.output_tokens ?? 0) - (prevGen?.output ?? 0) + nextOut)
  }
  if (raw.thinking_tokens !== undefined || cur.thinking_tokens !== undefined) {
    merged.thinking_tokens = Math.max(0, (cur.thinking_tokens ?? 0) - (prevGen?.thinking ?? 0) + nextThink)
  }
  return merged
}

/** Prefix every mirrored agy tool callId carries; continuation detection key. */
export const AGY_CALL_PREFIX = 'agytc-'

/** Mint the callId for one recorded tool event. */
export function mirrorCallId(runId: string, eventIndex: number): string {
  return AGY_CALL_PREFIX + runId + '-' + String(eventIndex)
}

/** Parse a callId back into its run coordinates; null when not ours. */
export function parseMirrorCallId(callId: string): { runId: string; eventIndex: number } | null {
  if (!callId.startsWith(AGY_CALL_PREFIX)) return null
  const rest = callId.slice(AGY_CALL_PREFIX.length)
  // Bridge lifecycle calls (agytc-bridge-goal-..., agytc-bridge-plan-...) are
  // never mirror tool steps even when their trailing suffix happens to be numeric.
  if (rest.startsWith('bridge-')) return null
  // Strip any collision-disambiguation suffix (#toolName) before extracting coordinates
  const hashIdx = rest.indexOf('#')
  const baseRest = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest
  // runId is a uuid (hyphens included), so split from the RIGHT: the last
  // hyphen separates the event index.
  const idx = baseRest.lastIndexOf('-')
  if (idx <= 0) return null
  const runId = baseRest.slice(0, idx)
  const n = Number(baseRest.slice(idx + 1))
  if (!Number.isSafeInteger(n) || n < 0) return null
  return { runId, eventIndex: n }
}
