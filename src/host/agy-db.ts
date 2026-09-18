// Read full tool parameters from the Antigravity (agy) conversation database.
//
// agy's stream-json output applies `filterToolParameters` which strips large
// content fields (CodeContent, TargetContent, ReplacementContent, etc.) from
// the tool_info parameters to keep the stream compact. Only "metadata" fields
// like TargetFile survive. This means the DSH-side mirror arguments arrive
// incomplete — a replace_file_content step only carries {TargetFile} instead
// of the full {TargetFile, TargetContent, ReplacementContent, ...}.
//
// The agy conversation database (~/.gemini/antigravity-cli/conversations/<id>.db)
// stores the COMPLETE tool arguments as protobuf-encoded step_payload blobs.
// Each tool step's payload contains a JSON string with the full parameter object.
//
// This module lazily reads the agy DB (via sqlite3 CLI, copying to temp to
// avoid WAL locks), extracts full JSON parameters for every tool step, and
// caches them keyed by (conversationId, stepIndex). The mapper then uses
// these to construct accurate agy_tool arguments — enabling diff cards to
// show the real oldText/newText content.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, unlink, copyFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
let AGY_DB_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')

/**
 * Candidate conversations directories for a conversation id.
 * Pool/isolated accounts write agy state under their own HOME
 * (~/.dsh/agy-accounts/<id>/.gemini/...), NOT the system ~/.gemini
 * (issue: thinking/tool-args invisible when using isolated accounts).
 */
export function conversationsDirCandidates(accountHome?: string): string[] {
  const dirs: string[] = []
  const push = (d: string) => { if (!dirs.includes(d)) dirs.push(d) }
  if (accountHome !== undefined && accountHome !== '') {
    push(join(accountHome, '.gemini', 'antigravity-cli', 'conversations'))
  }
  const gch = process.env.GEMINI_CLI_HOME
  if (gch !== undefined && gch !== '') push(join(gch, 'antigravity-cli', 'conversations'))
  push(AGY_DB_DIR)
  push(join(homedir(), '.gemini', 'antigravity-cli', 'conversations'))
  const poolBase = join(homedir(), '.dsh', 'agy-accounts')
  try {
    for (const ent of readdirSync(poolBase)) {
      if (ent.startsWith('.')) continue
      push(join(poolBase, ent, '.gemini', 'antigravity-cli', 'conversations'))
    }
  } catch {
    // pool not installed
  }
  return dirs
}

/** Locate an existing conversation DB across system + pool homes. */
export function findConversationDb(conversationId: string, accountHome?: string): string | null {
  if (!isSafeConversationId(conversationId)) return null
  const name = `${conversationId}.db`
  for (const dir of conversationsDirCandidates(accountHome)) {
    const p = join(dir, name)
    try {
      if (existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
}

interface CachedStep {
  name: string
  args: Record<string, unknown>
}

interface AgyDbCache {
  conversationId: string
  /** stepIndex → parsed tool info (name + args) */
  steps: Map<number, CachedStep>
  /** stepIndex → extracted thought text */
  thoughts: Map<number, string>
  /** Step indices that were present in the database when loaded */
  checkedSteps: Set<number>
  loaded: boolean
}

interface AgyDbData {
  steps: Map<number, CachedStep>
  thoughts: Map<number, string>
  seenSteps: Set<number>
}

const TOOL_STEP_TYPES = new Set([5, 7, 8, 9, 17, 21, 33, 101, 132, 138, 139])

const MAX_CACHE_AGE_MS = 300_000 // 5 minutes
let cache: AgyDbCache | null = null
let cacheTime = 0

/** agy conversation ids are path-safe tokens; reject anything else before join(). */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeConversationId(id: string): boolean {
  return SAFE_CONVERSATION_ID.test(id)
}

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

  const walk = (buf: Buffer, depth: number): void => {
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
                  if (!str.trim().startsWith('{') && str.trim().length >= 24) {
                    proseCandidates.unshift(str.trim())
                  }
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
        if (len >= 8 && len < 200_000) walk(slice, depth + 1)
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

  walk(payload, 0)
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
 * Copy the agy SQLite DB to a temp path (avoiding WAL lock issues), then
 * query tool and thought step payloads via sqlite3 CLI.
 */
async function loadAgyDbData(conversationId: string, accountHome?: string): Promise<AgyDbData> {
  const steps = new Map<number, CachedStep>()
  const thoughts = new Map<number, string>()
  const seenSteps = new Set<number>()
  if (!isSafeConversationId(conversationId)) return { steps, thoughts, seenSteps }
  const dbPath = findConversationDb(conversationId, accountHome)
  if (dbPath === null) return { steps, thoughts, seenSteps }

  // Copy to temp to avoid WAL/shared-lock issues. Also copy -wal and -shm so
  // recent writes in WAL mode are visible.
  const tmpDb = join(tmpdir(), `agy-db-${conversationId.slice(0, 8)}-${Date.now()}.db`)
  try {
    await copyFile(dbPath, tmpDb)
    try { await copyFile(dbPath + '-wal', tmpDb + '-wal') } catch { /* ignore */ }
    try { await copyFile(dbPath + '-shm', tmpDb + '-shm') } catch { /* ignore */ }

    // Query tool-type steps AND text/thinking steps with payload > 20 bytes
    const sql = `SELECT idx, step_type, hex(step_payload) FROM steps WHERE (step_type IN (5,7,8,9,14,15,17,21,33,101,132,138,139)) AND length(step_payload) > 20`
    const { stdout } = await execFileAsync('sqlite3', [tmpDb, sql], {
      timeout: 5_000,
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
    })

    for (const line of stdout.split('\n')) {
      const firstPipe = line.indexOf('|')
      if (firstPipe < 0) continue
      const secondPipe = line.indexOf('|', firstPipe + 1)
      if (secondPipe < 0) continue

      const idx = parseInt(line.slice(0, firstPipe), 10)
      const stepType = parseInt(line.slice(firstPipe + 1, secondPipe), 10)
      if (!Number.isFinite(idx)) continue
      seenSteps.add(idx)
      const hexPayload = line.slice(secondPipe + 1).trim()
      if (hexPayload === '' || hexPayload === 'NULL') continue

      const payload = Buffer.from(hexPayload, 'hex')
      if (TOOL_STEP_TYPES.has(stepType)) {
        const info = extractToolInfo(payload)
        if (info !== null) {
          steps.set(idx, info)
        }
      }
      // Thought/intent prose: agent_response steps, plus tool steps that
      // carry toolAction/toolSummary (common in tool-heavy turns).
      if (stepType === 14 || stepType === 15 || TOOL_STEP_TYPES.has(stepType)) {
        const th = extractStepThoughts(payload)
        if (th !== null && th.trim() !== '' && !/^SYSTEM ROLE/i.test(th.trim())) {
          thoughts.set(idx, th)
        }
      }
    }
  } catch {
    // DB locked, sqlite3 missing, or parse error — graceful fallback
  } finally {
    try { await unlink(tmpDb) } catch { /* ignore cleanup errors */ }
    try { await unlink(tmpDb + '-wal') } catch { /* ignore */ }
    try { await unlink(tmpDb + '-shm') } catch { /* ignore */ }
  }

  return { steps, thoughts, seenSteps }
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
    if (cache.checkedSteps.has(stepIndex)) return null
  }

  // Load (or reload) the full tool step and thought map
  const data = await loadAgyDbData(conversationId, accountHome)
  cache = {
    conversationId,
    steps: data.steps,
    thoughts: data.thoughts,
    checkedSteps: data.seenSteps,
    loaded: true,
  }
  cacheTime = now

  return data.steps.get(stepIndex) ?? null
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
    if (cache.checkedSteps.has(stepIndex)) return null
  }

  // Load (or reload) the full tool step and thought map
  const data = await loadAgyDbData(conversationId, accountHome)
  cache = {
    conversationId,
    steps: data.steps,
    thoughts: data.thoughts,
    checkedSteps: data.seenSteps,
    loaded: true,
  }
  cacheTime = now

  return data.thoughts.get(stepIndex) ?? null
}

/** Clear the DB cache (e.g. when a run settles). */
export function clearAgyDbCache(): void {
  cache = null
}

/**
 * TEST-ONLY injection: point the module at a custom agy conversations dir.
 * Never call from production code (module-level directory is shared within a
 * process); used only by unit tests to exercise parsing against a temp DB.
 */
export function __setAgyDbDirForTest(dir: string): void {
  AGY_DB_DIR = dir
  cache = null
  cacheTime = 0
}
