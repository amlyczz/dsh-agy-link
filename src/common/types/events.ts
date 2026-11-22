// Normalized event stream produced by the stream-json parser and consumed by
// the StreamChunk mapper.

// Raw usage object as emitted by agy stream-json (snake_case).
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  total_tokens?: number
}

export type AgyStepKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'title'
  | 'subagent'
  | 'user-input'
  | 'unknown'

export interface AgyToolInfo {
  name: string
  /** Raw arguments: JSON string when agy serializes them, else object. */
  args?: unknown
  output?: unknown
  /** Tool-side failure text (agy 1.1.15: tool_info.error.message on state=ERROR). */
  error?: string
}

export type AgyEvent =
  | { kind: 'init'; conversationId?: string; model?: string; raw: unknown }
  | {
      kind: 'step'
      stepKey: string
      stepKind: AgyStepKind
      text: string
      /** text is a sequential fragment to append, not a cumulative snapshot (agy ≥1.1.15 text_delta). */
      fragment?: boolean
      tool?: AgyToolInfo
      /** Step lifecycle as reported by agy: ACTIVE / DONE / ERROR. */
      state?: string
      /**
       * Raw transport-level status, lowercased, when the transport reports one
       * (ACP: pending / in_progress / completed / failed / cancelled). Kept
       * because `state` collapses pending and in_progress into ACTIVE, while
       * background-task detection needs to tell "never started" apart from
       * "still running".
       */
      rawStatus?: string
      /** Per-step usage (agy ≥1.1.15 reports usage on agent_response steps). */
      usage?: RawUsage
      /** Conversation id carried directly on step_update when init hasn't been seen yet. */
      conversationId?: string
      raw?: unknown
    }
  | {
      kind: 'result'
      conversationId: string
      ok: boolean
      response: string
      error?: string
      usage: RawUsage
      raw: unknown
    }
  | { kind: 'garbage'; line: string }
