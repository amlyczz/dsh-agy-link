// Extract thought prose and full tool arguments from protobuf step_payload
// blobs. Pure byte parsing: no disk, no clock.
import type { CachedStep } from './schema.ts'

function readVarint(b: Buffer, offset: number): { val: number; next: number } | null {
  let val = 0
  let shift = 0
  let pos = offset
  while (pos < b.length) {
    const byte = b[pos++]!
    val |= (byte & 0x7f) << shift
    shift += 7
    if ((byte & 0x80) === 0) return { val, next: pos }
    if (shift > 35) return null
  }
  return null
}

/**
 * Extract model thought text from a protobuf step_payload.
 *
 * Primary: field 20 -> sub-field 3 (verified on simple print-mode turns).
 * Fallback: longest non-JSON prose string, then toolAction/toolSummary
 * embedded in tool-arg JSON (tool-heavy agent turns often store only those).
 */
export function extractStepThoughts(payload: Buffer): string | null {
  const proseCandidates: string[] = []
  const actionCandidates: string[] = []

  const consider = (str: string): void => {
    const t = str.trim()
    if (t.length < 8) return
    // Never treat system prompts / plan templates / ids as thinking prose.
    if (/^SYSTEM ROLE/i.test(t)) return
    if (t.startsWith('/plan ') || t.includes('<PLAN>The user is requesting that you think')) return
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return
    if (/^bot-|^call_/.test(t)) return
    // toolAction/toolSummary may sit inside a larger binary-ish blob.
    const act = /"toolAction"\s*:\s*"([^"]{3,200})"/.exec(t)
    const sum = /"toolSummary"\s*:\s*"([^"]{3,200})"/.exec(t)
    if (act || sum) {
      const line = [act?.[1] ?? '', sum?.[1] ?? ''].filter((s) => s !== '').join(' — ')
      if (line !== '') actionCandidates.push(line)
    }
    const looksJson = t.startsWith('{') || t.startsWith('[')
    if (!looksJson && t.length >= 24 && t.length <= 4000 && /[a-zA-Z一-鿿]/.test(t) && !/^[0-9a-f-]{30,}$/i.test(t)) {
      // Must look like sentences, not an opaque id blob.
      if ((t.match(/[.!?]|，|。| /g) ?? []).length >= 2 || /[a-zA-Z]{4,}\s+[a-zA-Z]{3,}/.test(t)) {
        proseCandidates.push(t)
      }
      return
    }
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
    }
  }

  // The preferred field 20.3 push keeps its own ranking rule, so it stays a
  // distinct callback instead of being folded into `consider`.
  const preferProse = (str: string): void => {
    const t = str.trim()
    if (!t.startsWith('{') && t.length >= 24) proseCandidates.unshift(t)
  }

  walkProtobuf(payload, 0, consider, preferProse)

  // Last-resort scan of the raw buffer: toolAction often sits inside a
  // length-delimited blob that protobuf walk splits oddly.
  const full = payload.toString('utf8')
  const act = /"toolAction"\s*:\s*"([^"]{3,200})"/.exec(full)
  const sum = /"toolSummary"\s*:\s*"([^"]{3,200})"/.exec(full)
  if (act || sum) {
    const line = [act?.[1] ?? '', sum?.[1] ?? ''].filter((s) => s !== '').join(' — ')
    if (line !== '') actionCandidates.push(line)
  }
  if (proseCandidates.length > 0) {
    proseCandidates.sort((a, b) => b.length - a.length)
    return proseCandidates[0] as string
  }
  if (actionCandidates.length > 0) return actionCandidates[0] as string
  return null
}

/**
 * Walk protobuf wire fields, reporting every length-delimited string slice to
 * `consider`. Field 20 gets extra attention (2.1/2.2/2.3 sub-fields); each
 * depth-3 slice is then walked recursively.
 */
function walkProtobuf(
  buf: Buffer,
  depth: number,
  consider: (str: string) => void,
  preferProse: (str: string) => void,
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
      if (pos + len > buf.length) break
      const slice = buf.subarray(pos, pos + len)
      pos += len
      // Preferred field 20.3
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
            if (p20 + l20 > slice.length) break
            const s20 = slice.subarray(p20, p20 + l20)
            p20 += l20
            if (f20 === 3) {
              const str = s20.toString('utf-8')
              if (str.trim() !== '') {
                consider(str)
                preferProse(str)
              }
            } else if (f20 === 2 || f20 === 1) {
              consider(s20.toString('utf-8'))
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
      if (len >= 8 && len < 200_000) walkProtobuf(slice, depth + 1, consider, preferProse)
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
            let pos = i + 3 + nameLen
            let jsonLen = 0
            let shift = 0
            while (pos < payload.length) {
              const b = payload[pos]!
              pos++
              jsonLen |= (b & 0x7f) << shift
              shift += 7
              if ((b & 0x80) === 0) break
            }
            if (jsonLen > 1 && pos + jsonLen <= payload.length) {
              const jsonSlice = payload.subarray(pos, pos + jsonLen)
              if (jsonSlice[0] === 0x7b /* '{' */) {
                try {
                  const obj = JSON.parse(jsonSlice.toString('utf-8')) as unknown
                  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
                    return { name: nameStr, args: obj as Record<string, unknown> }
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
  return scanFallbackJson(payload)
}

function scanFallbackJson(payload: Buffer): CachedStep | null {
  const toolKeys = ['TargetFile', 'TargetContent', 'ReplacementContent', 'CodeContent', 'CommandLine', 'AbsolutePath', 'Query', 'Pattern', 'DirectoryPath']
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
