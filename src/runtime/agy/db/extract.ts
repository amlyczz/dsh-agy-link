// Extract thought prose and full tool arguments from protobuf step_payload
// blobs. Pure byte parsing: no disk, no clock.
import { parseChecklistMarkdown, parseChecklistSteps } from '../../../common/checklist.ts'
import type { CachedStep } from './schema.ts'

function readVarint(b: Buffer, offset: number): { val: number; next: number } | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= b.length) return null
  let val = 0
  let shift = 0
  let pos = offset
  while (pos < b.length) {
    const byte = b[pos++]!
    // Bitwise shifts truncate to signed 32 bits and wrap shifts above 31.
    // A negative length can move the protobuf cursor billions of bytes back.
    val += (byte & 0x7f) * 2 ** shift
    if (!Number.isSafeInteger(val)) return null
    shift += 7
    if ((byte & 0x80) === 0) return { val, next: pos }
    if (shift > 35) return null
  }
  return null
}

/**
 * Extract model thought text from a protobuf step_payload.
 *
 * Primary: field 20 -> sub-field 3 (dedicated reasoning/thinking field in agy protobuf).
 * Fallback: toolAction/toolSummary embedded in tool-arg JSON (tool steps often store only those).
 *
 * CRITICAL: Field 20 sub-field 1 is the assistant's final text response (not thoughts).
 * When sub-field 3 is absent, the model did not generate thoughts; never fall back
 * to sub-field 1, otherwise the final answer is erroneously extracted as thoughts and
 * duplicated across the reasoning and text blocks.
 */
export function extractStepThoughts(payload: Buffer): string | null {
  const thoughts: string[] = []
  const actionCandidates: string[] = []

  const onField20Thought = (str: string): void => {
    const t = str.trim()
    if (t.length === 0) return
    // Never treat system prompts / plan templates / ids as thinking prose.
    if (/^SYSTEM ROLE/i.test(t)) return
    if (t.startsWith('/plan ') || t.includes('<PLAN>The user is requesting that you think')) return
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return
    if (/^bot-|^call_/.test(t)) return

    const looksJson = t.startsWith('{') || t.startsWith('[')
    if (looksJson) {
      try {
        const obj = JSON.parse(t) as Record<string, unknown>
        const action = typeof obj.toolAction === 'string' ? obj.toolAction.trim() : ''
        const summary = typeof obj.toolSummary === 'string' ? obj.toolSummary.trim() : ''
        const line = [action, summary].filter((s) => s !== '').join(' — ')
        if (line !== '') actionCandidates.push(line)
      } catch {
        // not a tool-args object
      }
      return
    }

    thoughts.push(t)
  }

  walkProtobuf(payload, 0, onField20Thought)

  if (thoughts.length > 0) {
    const res = thoughts.join('\n').trim()
    if (res !== '') return res
  }

  // Fallback for tool-heavy steps without field 20: toolAction / toolSummary.
  // Fast byte pre-check avoids decoding large step payloads to UTF-8 unnecessarily.
  if (payload.includes('toolAction') || payload.includes('toolSummary')) {
    const full = payload.toString('utf8')
    const act = /"toolAction"\s*:\s*"([^"]{3,200})"/.exec(full)
    const sum = /"toolSummary"\s*:\s*"([^"]{3,200})"/.exec(full)
    if (act || sum) {
      const line = [act?.[1] ?? '', sum?.[1] ?? ''].filter((s) => s !== '').join(' — ')
      if (line !== '') actionCandidates.push(line)
    }
  }

  if (actionCandidates.length > 0) return actionCandidates[0] as string
  return null
}

/**
 * Walk protobuf wire fields, locating field 20 sub-field 3 for model thinking prose.
 * Nested slices up to depth 3 are walked recursively.
 */
function walkProtobuf(
  buf: Buffer,
  depth: number,
  onField20Thought: (str: string) => void,
): void {
  if (depth > 3) return
  let pos = 0
  while (pos < buf.length) {
    const res = readVarint(buf, pos)
    if (res === null) break
    pos = res.next
    const tag = res.val
    const wireType = tag & 0x7
    const fieldNum = tag >>> 3
    if (wireType === 2) {
      const lenRes = readVarint(buf, pos)
      if (lenRes === null) break
      pos = lenRes.next
      const len = lenRes.val
      if (len < 0 || len > buf.length - pos) break
      const slice = buf.subarray(pos, pos + len)
      pos += len
      // Field 20 wraps agent_response fields:
      //   sub-field 1 = final text response (NEVER thoughts)
      //   sub-field 3 = model thinking / reasoning prose
      if (fieldNum === 20) {
        let p20 = 0
        while (p20 < slice.length) {
          const t20Res = readVarint(slice, p20)
          if (t20Res === null) break
          p20 = t20Res.next
          const t20 = t20Res.val
          const w20 = t20 & 0x7
          const f20 = t20 >>> 3
          if (w20 === 2) {
            const l20Res = readVarint(slice, p20)
            if (l20Res === null) break
            p20 = l20Res.next
            const l20 = l20Res.val
            if (l20 < 0 || l20 > slice.length - p20) break
            const s20 = slice.subarray(p20, p20 + l20)
            p20 += l20
            if (f20 === 3) {
              const str = Buffer.from(s20).toString('utf-8')
              if (str.trim() !== '') {
                onField20Thought(str)
              }
            }
          } else if (w20 === 0) {
            const v20Res = readVarint(slice, p20)
            if (v20Res === null) break
            p20 = v20Res.next
          } else if (w20 === 1) {
            p20 += 8
          } else if (w20 === 5) {
            p20 += 4
          } else {
            break
          }
        }
      }
      if (len >= 8 && len < 200_000) walkProtobuf(slice, depth + 1, onField20Thought)
    } else if (wireType === 0) {
      const vRes = readVarint(buf, pos)
      if (vRes === null) break
      pos = vRes.next
    } else if (wireType === 1) {
      pos += 8
    } else if (wireType === 5) {
      pos += 4
    } else {
      break
    }
  }
}

function collectChecklistStrings(buf: Buffer, depth: number, out: string[]): void {
  if (depth > 4) return
  let pos = 0
  while (pos < buf.length) {
    const res = readVarint(buf, pos)
    if (res === null) break
    pos = res.next
    const wireType = res.val & 0x7
    if (wireType === 2) {
      const lenRes = readVarint(buf, pos)
      if (lenRes === null) break
      pos = lenRes.next
      const len = lenRes.val
      if (len < 0 || len > buf.length - pos) break
      const slice = buf.subarray(pos, pos + len)
      pos += len
      if (slice.includes('- [')) {
        out.push(slice.toString('utf8'))
      }
      if (len >= 8 && len < 200_000) collectChecklistStrings(slice, depth + 1, out)
    } else if (wireType === 0) {
      const vRes = readVarint(buf, pos)
      if (vRes === null) break
      pos = vRes.next
    } else if (wireType === 1) {
      pos += 8
    } else if (wireType === 5) {
      pos += 4
    } else {
      break
    }
  }
}

function extractChecklistMarkdownFromPayload(payload: Buffer): string | null {
  if (!payload.includes('- [')) return null
  const candidates: string[] = []
  collectChecklistStrings(payload, 0, candidates)
  for (const c of candidates) {
    if (parseChecklistMarkdown(c).length > 0) return c.trim()
  }
  const text = payload.toString('utf8')
  const m = /(- \[(?: |x|X|>|\/|-|!)\] [^\r\n\u0000-\u0008\u000b-\u001f]+(?:\r?\n- \[(?: |x|X|>|\/|-|!)\] [^\r\n\u0000-\u0008\u000b-\u001f]+)*)/.exec(text)
  return m?.[1]?.trim() ?? null
}

/**
 * Extract tool name and full JSON args from a protobuf step_payload.
 *
 * agy's tool step payload wraps the call in standard protobuf fields:
 *   field 2 (tag 0x12, length-delimited) → tool_name ("write_to_file", ...)
 *   field 3 (tag 0x1a, length-delimited) → args JSON ('{"CodeContent":"...",...}')
 *
 * We scan for this deterministic sequence directly (sub-millisecond, no
 * recursive descent or backtracking) and fall back to scanning for balanced
 * JSON slices containing known parameter keys.
 */
export function extractToolInfo(payload: Buffer): CachedStep | null {
  for (let i = 0; i < payload.length - 8; i++) {
    if (payload[i] === 0x12) {
      const nameLen = payload[i + 1]!
      if (nameLen >= 2 && nameLen <= 64 && i + 2 + nameLen < payload.length) {
        if (payload[i + 2 + nameLen] === 0x1a) {
          const nameStr = payload.subarray(i + 2, i + 2 + nameLen).toString('utf-8')
          if (/^[a-zA-Z0-9_]+$/.test(nameStr)) {
            const lenRes = readVarint(payload, i + 3 + nameLen)
            if (lenRes !== null && lenRes.val > 1 && lenRes.next + lenRes.val <= payload.length) {
              const jsonSlice = payload.subarray(lenRes.next, lenRes.next + lenRes.val)
              if (jsonSlice[0] === 0x7b /* '{' */) {
                try {
                  const obj = JSON.parse(jsonSlice.toString('utf-8')) as unknown
                  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
                    const rec = obj as Record<string, unknown>
                    if (nameStr === 'update_steps' && parseChecklistSteps(rec).length === 0) {
                      const md = extractChecklistMarkdownFromPayload(payload)
                      if (md !== null) {
                        const steps = parseChecklistMarkdown(md)
                        if (steps.length > 0) return { name: nameStr, args: { ...rec, steps, markdown: md } }
                      }
                    }
                    return { name: nameStr, args: rec }
                  }
                } catch {
                  // ignore JSON parse error, keep scanning
                }
              }
            }
          }
        }
      }
    }
  }

  // Fallback: scan for any embedded JSON object containing tool parameter keys
  const fallback = scanFallbackJson(payload)
  if (fallback !== null) return fallback

  if (payload.includes('update_steps')) {
    const md = extractChecklistMarkdownFromPayload(payload)
    if (md !== null) {
      const steps = parseChecklistMarkdown(md)
      if (steps.length > 0) return { name: 'update_steps', args: { steps, markdown: md } }
    }
  }
  return null
}

function scanFallbackJson(payload: Buffer): CachedStep | null {
  const toolKeys = ['TargetFile', 'TargetContent', 'ReplacementContent', 'CodeContent', 'CommandLine', 'AbsolutePath', 'Query', 'Pattern', 'DirectoryPath', 'steps', 'Steps', 'focus', 'Focus']
  let pos = 0
  let bestObj: Record<string, unknown> | null = null
  let bestKeyCount = 0

  while (pos < payload.length) {
    const nextBrace = payload.indexOf(0x7b, pos)
    if (nextBrace === -1) break
    pos = nextBrace + 1

    const sample = payload.subarray(nextBrace, Math.min(payload.length, nextBrace + 200)).toString('utf-8')
    if (!toolKeys.some((k) => sample.includes(k))) continue

    let brace = 0
    let inStr = false
    let esc = false
    let end = -1
    for (let j = nextBrace; j < Math.min(payload.length, nextBrace + 200_000); j++) {
      const b = payload[j]!
      if (esc) {
        esc = false
        continue
      }
      if (b === 0x5c /* '\' */) {
        esc = true
        continue
      }
      if (b === 0x22 /* '"' */) {
        inStr = !inStr
        continue
      }
      if (!inStr) {
        if (b === 0x7b /* '{' */) brace++
        else if (b === 0x7d /* '}' */) {
          brace--
          if (brace === 0) {
            end = j + 1
            break
          }
        }
      }
    }
    if (end > nextBrace) {
      try {
        const obj = JSON.parse(payload.subarray(nextBrace, end).toString('utf-8')) as unknown
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          const rec = obj as Record<string, unknown>
          const count = Object.keys(rec).length
          if (count > bestKeyCount) {
            bestObj = rec
            bestKeyCount = count
          }
        }
      } catch {
        // ignore
      }
      pos = end
    }
  }

  if (bestObj !== null) {
    const name = typeof bestObj.tool === 'string' ? bestObj.tool : ''
    return { name, args: bestObj }
  }
  return null
}

/** Find one length-delimited field inside a protobuf message (top level only). */
function findDelimitedField(buf: Buffer, target: number): Buffer | null {
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    if (tag === null) return null
    pos = tag.next
    const field = Math.floor(tag.val / 8)
    const wire = tag.val & 0x7
    if (wire === 2) {
      const lenRes = readVarint(buf, pos)
      if (lenRes === null) return null
      pos = lenRes.next
      const len = lenRes.val
      if (len < 0 || len > buf.length - pos) return null
      if (field === target) return buf.subarray(pos, pos + len)
      pos += len
    } else if (wire === 0) {
      const vRes = readVarint(buf, pos)
      if (vRes === null) return null
      pos = vRes.next
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 5) {
      pos += 4
    } else {
      return null
    }
  }
  return null
}

/** Cap on the recovered result text: a single agy step never needs more. */
const MAX_RESULT_TEXT_CHARS = 200_000

/**
 * Extract the RESULT text agy recorded for a tool step.
 *
 * The stream envelope agy prints strips most tool output (a `read_file` step
 * carries an EMPTY result on stdout, so its DSH card rendered "(no output)").
 * The conversation DB keeps the rendered result:
 *
 *   step_payload → field 140 (result container)
 *                → field 2   (ToolResult)
 *                → field 1   (rendered text, e.g. "Created At: …\n1: …")
 *
 * The text still carries agy's own status envelope and read gutter; the display
 * layer (common/tool-output.ts) strips those. Returns null when the payload has
 * no usable result (write/edit steps, interrupted steps).
 */
export function extractToolResultText(payload: Buffer): string | null {
  if (payload.length < 16) return null
  const container = findDelimitedField(payload, 140)
  if (container === null) return null
  const result = findDelimitedField(container, 2)
  if (result === null) return null
  const textBuf = findDelimitedField(result, 1)
  if (textBuf === null || textBuf.length === 0) return null
  const text = textBuf.toString('utf8')
  if (text.trim() === '') return null
  return text.length > MAX_RESULT_TEXT_CHARS ? text.slice(0, MAX_RESULT_TEXT_CHARS) : text
}

