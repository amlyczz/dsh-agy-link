// NDJSON parser for the agy CLI stream-json output (spec ADR-1). Tolerant
// by design: torn lines are buffered across feeds, unknown event/step_type
// vocabulary passes through as unknown, and garbage lines (auth banners,
// progress noise) surface as garbage events so the caller can count them
// without dying. Field-name candidates cover snake_case and camelCase
// spellings observed in the agy binary strings.
import { extractAuthUrl, looksLikeAuthFailure, type AgyEvent, type AgyStepKind, type AgyToolInfo, type RawUsage } from '../common/types.ts'

// agy 1.1.15 stream-json vocabulary (verified against a live binary):
// user_input, checkpoint, agent_response, tool, system_message, title.
// agent_response carries text_delta fragments; usage reports thinking tokens.
const TEXT_STEP_TYPES = new Set(['agent_text', 'agenttext', 'text', 'model_response', 'modelresponse', 'message', 'response_text', 'agent_response', 'agentresponse'])
const THINKING_STEP_TYPES = new Set(['thinking', 'thought', 'reasoning'])
const TOOL_STEP_TYPES = new Set(['tool_call', 'toolcall', 'tool', 'tool_use', 'tooluse', 'tool_run', 'toolrun', 'function_call'])
const TITLE_STEP_TYPES = new Set(['title'])
const SUBAGENT_STEP_TYPES = new Set(['subagent', 'subagent_message', 'subagent_result'])
const USER_INPUT_STEP_TYPES = new Set(['user_input', 'userinput', 'user_message'])
// Numeric step_type values confirmed against real conversation DBs
// (pi-antigravity-bridge map + local agy 1.1.13 data).
const NUMERIC_STEP_TYPES: Record<number, AgyStepKind> = {
  14: 'thinking',
  15: 'text',
  23: 'title',
  5: 'tool',
  7: 'tool',
  8: 'tool',
  9: 'tool',
  17: 'tool',
  21: 'tool',
  33: 'tool',
  101: 'tool',
  132: 'tool',
  138: 'tool',
  139: 'tool',
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

function normalizeStepKind(v: unknown): AgyStepKind {
  if (typeof v === 'number') return NUMERIC_STEP_TYPES[v] ?? 'unknown'
  if (typeof v === 'string') {
    const s = v.toLowerCase()
    if (TEXT_STEP_TYPES.has(s)) return 'text'
    if (THINKING_STEP_TYPES.has(s)) return 'thinking'
    if (TOOL_STEP_TYPES.has(s)) return 'tool'
    if (TITLE_STEP_TYPES.has(s)) return 'title'
    if (SUBAGENT_STEP_TYPES.has(s)) return 'subagent'
    if (USER_INPUT_STEP_TYPES.has(s)) return 'user-input'
  }
  return 'unknown'
}

function extractText(obj: Record<string, unknown>): string {
  const direct = pick(obj, ['text', 'content', 'agent_text', 'agentText', 'output_text', 'payload_text'])
  if (typeof direct === 'string') return direct
  const payload = obj.payload ?? obj.step_payload ?? obj.stepPayload
  if (payload && typeof payload === 'object') {
    const inner = pick(payload as Record<string, unknown>, ['text', 'content', 'agent_text', 'agentText'])
    if (typeof inner === 'string') return inner
  }
  return ''
}

/** agy ≥1.1.15 streams assistant text as `text_delta` fragments. */
function extractTextDelta(obj: Record<string, unknown>): string | undefined {
  const v = obj.text_delta ?? obj.textDelta
  return typeof v === 'string' ? v : undefined
}

function extractTool(obj: Record<string, unknown>): AgyToolInfo | undefined {
  const info = pick(obj, ['tool_info', 'toolInfo', 'tool', 'tool_call', 'toolCall'])
  const src: Record<string, unknown> =
    info && typeof info === 'object' ? (info as Record<string, unknown>) : obj
  const name = pick(src, ['name', 'tool_name', 'toolName', 'canonical_name'])
  if (typeof name !== 'string' || name === '') return undefined
  const args = pick(src, ['parameters', 'params', 'input', 'args', 'input_json', 'inputJson'])
  const output = pick(src, ['output', 'result', 'output_text'])
  // agy 1.1.15: tool_info.error = { type: 'TOOL_ERROR', message: '...' }
  const errObj = src.error
  let error: string | undefined
  if (typeof errObj === 'string') error = errObj
  else if (errObj && typeof errObj === 'object') {
    const msg = (errObj as Record<string, unknown>).message
    if (typeof msg === 'string' && msg !== '') error = msg
  }
  return { name, args, output, ...(error !== undefined ? { error } : {}) }
}

function parseUsage(v: unknown): RawUsage {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
  // Lossless-JSON boundary: never assign undefined-valued properties.
  const out: RawUsage = {}
  const inT = num(o.input_tokens)
  const outT = num(o.output_tokens)
  if (inT !== undefined) out.input_tokens = inT
  if (outT !== undefined) out.output_tokens = outT
  const t = num(o.thinking_tokens)
  if (t !== undefined) out.thinking_tokens = t
  const cr = num(o.cache_read_tokens)
  if (cr !== undefined) out.cache_read_tokens = cr
  const cw = num(o.cache_write_tokens)
  if (cw !== undefined) out.cache_write_tokens = cw
  const tot = num(o.total_tokens)
  if (tot !== undefined) out.total_tokens = tot
  return out
}

/** Parse one decoded JSON object into a typed event; undefined = ignore. */
export function classifyEvent(obj: unknown, seq: number): AgyEvent | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const o = obj as Record<string, unknown>
  const evt = typeof o.event === 'string' ? o.event : typeof o.type === 'string' ? o.type : ''
  if (evt === 'init' || evt === 'initialized') {
    const cid = pick(o, ['conversation_id', 'conversationId', 'session_id', 'sessionId'])
    // agy 1.1.15 nests details: {event:'init', conversation_id, init:{model, cwd, tools}}
    const initObj = o.init
    const initSrc: Record<string, unknown> =
      initObj && typeof initObj === 'object' && !Array.isArray(initObj)
        ? (initObj as Record<string, unknown>)
        : {}
    const model = pick(o, ['model', 'model_name', 'modelName']) ?? pick(initSrc, ['model', 'model_name', 'modelName'])
    let convId: string | undefined = typeof cid === 'string' && cid !== '' ? cid : undefined
    if (convId === undefined) {
      const nested = pick(initSrc, ['conversation_id', 'conversationId'])
      if (typeof nested === 'string' && nested !== '') convId = nested
    }
    return {
      kind: 'init',
      ...(convId !== undefined ? { conversationId: convId } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      raw: o,
    };
  }
  if (evt === 'step_update' || evt === 'step' || evt === 'stepUpdate') {
    // agy ≥1.1.15 nests the payload: {event:'step_update', step_update:{...}}.
    // Read from the nested object first, fall back to flat (older/spec shapes).
    const nested = o.step_update ?? o.stepUpdate ?? o.step
    const su: Record<string, unknown> =
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : {}
    const src: Record<string, unknown> = Object.keys(su).length > 0 ? su : o
    const idxV = pick(src, ['step_index', 'stepIndex', 'idx', 'index', 'step_idx', 'stepIdx', 'id', 'step_id', 'stepId'])
    const keyPart = typeof idxV === 'number' || typeof idxV === 'string' ? String(idxV) : String(seq)
    const stepKey = keyPart
    const stepKind = normalizeStepKind(pick(src, ['step_type', 'stepType', 'type']))
    const toolInfo = stepKind === 'tool' ? extractTool(src) : undefined
    const delta = extractTextDelta(src)
    const text = delta !== undefined ? delta : extractText(src)
    const stateV = pick(src, ['state'])
    const usageRaw = pick(src, ['usage'])
    return {
      kind: 'step',
      stepKey,
      stepKind,
      text,
      ...(delta !== undefined ? { fragment: true } : {}),
      ...(toolInfo !== undefined ? { tool: toolInfo } : {}),
      ...(typeof stateV === 'string' ? { state: stateV } : {}),
      ...(usageRaw && typeof usageRaw === 'object' ? { usage: parseUsage(usageRaw) } : {}),
      raw: o,
    };
  }
  if (evt === 'result' || evt === 'done' || evt === 'final') {
    const r = (o.result ?? o) as Record<string, unknown>
    const inner = r && typeof r === 'object' ? r : {}
    const cid = pick(inner, ['conversation_id', 'conversationId'])
    const status = pick(inner, ['status'])
    const response = pick(inner, ['response', 'text', 'content'])
    const error = pick(inner, ['error', 'error_message', 'errorMessage'])
    const ok = status === undefined ? !error : String(status).toUpperCase() !== 'ERROR'
    return {
      kind: 'result',
      conversationId: typeof cid === 'string' ? cid : '',
      ok,
      response: typeof response === 'string' ? response : '',
      ...(typeof error === 'string' ? { error } : {}),
      usage: parseUsage(inner.usage),
      raw: o,
    };
  }
// Shape inference for schemas without an event discriminator.
  if (o.usage && typeof o.usage === 'object' && (o.status !== undefined || o.response !== undefined)) {
    return classifyEvent({ event: 'result', result: o }, seq)
  }
  if (o.step_type !== undefined || o.stepType !== undefined) {
    return classifyEvent({ event: 'step_update', ...o }, seq)
  }
  // Bare nested payload without an event discriminator (agy ≥1.1.15 shape
  // where a line is just the step_update object).
  if (
    (o.step_update !== undefined || o.stepUpdate !== undefined) &&
    (o.step_update ?? o.stepUpdate) !== null &&
    typeof (o.step_update ?? o.stepUpdate) === 'object'
  ) {
    return classifyEvent({ event: 'step_update', step_update: o.step_update ?? o.stepUpdate }, seq)
  }
  return undefined
}

export interface ParserStats {
  lines: number
  garbage: number
  /** Consecutive garbage lines since the last parsed event. */
  consecutiveGarbage: number
  authUrl: string | undefined
  sawAuthFailure: boolean
  /** Error text from the last result envelope, if any (adapter maps it to AGY_ERROR). */
  lastResultError: string | undefined
}

export class StreamJsonParser {
  private buffer = ''
  private seq = 0
  readonly stats: ParserStats = { lines: 0, garbage: 0, consecutiveGarbage: 0, authUrl: undefined, sawAuthFailure: false, lastResultError: undefined }
  /** Ring buffer of raw stdout lines for /agy doctor export. */
  readonly recentLines: string[] = []
  private readonly maxRecent = 2000

  /** Feed a stdout chunk; returns the events completed by it. */
  feed(chunk: string): AgyEvent[] {
    this.buffer += chunk
    const out: AgyEvent[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      const ev = this.takeLine(line)
      if (ev) out.push(ev)
    }
    return out
  }

  /** Flush a trailing line without a newline (agy killed mid-write). */
  flush(): AgyEvent[] {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim() === '') return []
    const ev = this.takeLine(rest)
    return ev ? [ev] : []
  }

  private takeLine(line: string): AgyEvent | undefined {
    if (line.trim() === '') return undefined
    this.stats.lines++
    this.recentLines.push(line)
    if (this.recentLines.length > this.maxRecent) this.recentLines.splice(0, this.recentLines.length - this.maxRecent)
    if (looksLikeAuthFailure(line)) this.stats.sawAuthFailure = true
    if (this.stats.authUrl === undefined) {
      const u = extractAuthUrl(line)
      if (u) this.stats.authUrl = u
    }
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      this.stats.garbage++
      this.stats.consecutiveGarbage++
      return { kind: 'garbage', line }
    }
    const ev = classifyEvent(obj, this.seq++)
    if (!ev) {
      this.stats.garbage++
      this.stats.consecutiveGarbage++
      return { kind: 'garbage', line }
    }
    if (ev.kind === 'result') {
      this.stats.lastResultError = ev.error ?? undefined
    }
    this.stats.consecutiveGarbage = 0
    return ev
  }
}
