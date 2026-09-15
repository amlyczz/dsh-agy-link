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
import { readFile, unlink, copyFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
let AGY_DB_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')

interface CachedStep {
  name: string
  args: Record<string, unknown>
}

interface AgyDbCache {
  conversationId: string
  /** stepIndex → parsed tool info (name + args) */
  steps: Map<number, CachedStep>
  loaded: boolean
}

const MAX_CACHE_AGE_MS = 300_000 // 5 minutes
let cache: AgyDbCache | null = null
let cacheTime = 0

/** agy conversation ids are path-safe tokens; reject anything else before join(). */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeConversationId(id: string): boolean {
  return SAFE_CONVERSATION_ID.test(id)
}

/**
 * Copy the agy SQLite DB to a temp path (avoiding WAL lock issues), then
 * query tool step payloads via sqlite3 CLI. Returns a Map of stepIndex →
 * {name, args} for every tool step found.
 */
async function loadToolSteps(conversationId: string): Promise<Map<number, CachedStep>> {
  const result = new Map<number, CachedStep>()
  if (!isSafeConversationId(conversationId)) return result
  const dbPath = join(AGY_DB_DIR, `${conversationId}.db`)

  try {
    const st = await stat(dbPath)
    if (st.size === 0) return result
  } catch {
    return result // DB doesn't exist
  }

  // Copy to temp to avoid WAL/shared-lock issues. Also copy -wal and -shm so
  // recent writes in WAL mode are visible.
  const tmpDb = join(tmpdir(), `agy-db-${conversationId.slice(0, 8)}-${Date.now()}.db`)
  try {
    await copyFile(dbPath, tmpDb)
    try { await copyFile(dbPath + '-wal', tmpDb + '-wal') } catch { /* ignore */ }
    try { await copyFile(dbPath + '-shm', tmpDb + '-shm') } catch { /* ignore */ }

    // Query all tool-type steps (step_type in {5,7,8,9,17,21,33,101,132})
    // that have a non-empty step_payload containing a JSON string.
    const sql = `SELECT idx, hex(step_payload) FROM steps WHERE step_type IN (5,7,8,9,17,21,33,101,132) AND length(step_payload) > 20`
    const { stdout } = await execFileAsync('sqlite3', [tmpDb, sql], {
      timeout: 5_000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })

    for (const line of stdout.split('\n')) {
      const pipeIdx = line.indexOf('|')
      if (pipeIdx < 0) continue
      const idx = parseInt(line.slice(0, pipeIdx), 10)
      if (!Number.isFinite(idx)) continue
      const hexPayload = line.slice(pipeIdx + 1).trim()
      if (hexPayload === '' || hexPayload === 'NULL') continue

      const payload = Buffer.from(hexPayload, 'hex')
      const info = extractToolInfo(payload)
      if (info !== null) {
        result.set(idx, info)
      }
    }
  } catch {
    // DB locked, sqlite3 missing, or parse error — graceful fallback
  } finally {
    try { await unlink(tmpDb) } catch { /* ignore cleanup errors */ }
    try { await unlink(tmpDb + '-wal') } catch { /* ignore */ }
    try { await unlink(tmpDb + '-shm') } catch { /* ignore */ }
  }

  return result
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
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  if (!isSafeConversationId(conversationId)) return null

  const now = Date.now()
  if (cache?.conversationId === conversationId && cache.loaded && (now - cacheTime) < MAX_CACHE_AGE_MS) {
    const cached = cache.steps.get(stepIndex)
    if (cached !== undefined) return cached
  }

  // Load (or reload) the full tool step map
  const steps = await loadToolSteps(conversationId)
  cache = { conversationId, steps, loaded: true }
  cacheTime = now

  return steps.get(stepIndex) ?? null
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
