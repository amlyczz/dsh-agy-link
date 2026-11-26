// Open and read the agy SQLite conversation DB: node:sqlite first, the
// sqlite3 CLI as the fallback reader, with failure backoff so a missing
// reader cannot turn every step event into a process spawn.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { extractStepThoughts, extractToolInfo, extractToolResultText } from './extract.ts'
import { findConversationDb, isSafeConversationId } from './paths.ts'
import {
  MAX_CACHE_AGE_MS,
  STEP_QUERY_RAW_SQL,
  STEP_QUERY_SQL,
  TOOL_STEP_TYPES,
  type AgyDbData,
  type CachedStep,
} from './schema.ts'

const execFileAsync = promisify(execFile)

interface RawStepRow {
  idx: number
  stepType: number
  payload: Buffer
}

/**
 * node:sqlite reader (Node >= 22.5, REQUIRED node >= 24 for this plugin).
 * Preferred over the sqlite3 CLI: GUI/desktop hosts often lack the CLI on
 * PATH (macOS GUI apps do not inherit the shell PATH; Windows never ships
 * one), which is exactly the "thinking/tool args invisible on desktop"
 * report (issue #43). `undefined` = not probed yet, `null` = unavailable.
 */
let nodeSqliteQuery: ((dbPath: string, sql: string) => Promise<string[]>) | null | undefined
let nodeSqliteRawQuery: ((dbPath: string, minIdx: number) => Promise<RawStepRow[]>) | null | undefined

/**
 * TEST-ONLY injection: override the node:sqlite reader function.
 * Pass null to simulate node:sqlite missing (forcing sqlite3 CLI fallback),
 * or undefined to reset back to automatic probing.
 */
export function __setNodeSqliteQueryForTest(
  fn: ((dbPath: string, sql: string) => Promise<string[]>) | null | undefined,
): void {
  nodeSqliteQuery = fn
  if (fn !== undefined) nodeSqliteRawQuery = null
  else nodeSqliteRawQuery = undefined
}

async function queryRawViaNodeSqlite(dbPath: string, minIdx: number): Promise<RawStepRow[]> {
  if (nodeSqliteQuery === null) throw new Error('node:sqlite unavailable')
  if (nodeSqliteRawQuery === undefined && nodeSqliteQuery === undefined) {
    try {
      const mod = (await import('node:sqlite')) as {
        DatabaseSync?: new (path: string, options?: { open?: boolean; readOnly?: boolean }) => {
          exec(sql: string): unknown
          prepare(sql: string): { all(...params: unknown[]): unknown[] }
          close(): void
        }
      }
      if (typeof mod.DatabaseSync !== 'function') throw new Error('DatabaseSync missing')
      const Database = mod.DatabaseSync
      nodeSqliteRawQuery = async (p, startIdx) => {
        let db: {
          exec(sql: string): unknown
          prepare(sql: string): { all(...params: unknown[]): unknown[] }
          close(): void
        }
        try {
          db = new Database(p, { readOnly: true })
        } catch {
          db = new Database(p)
        }
        try {
          try { db.exec('PRAGMA busy_timeout = 2000;') } catch { /* ignore */ }
          try { db.exec('PRAGMA query_only = ON;') } catch { /* ignore */ }
          const rows = db.prepare(STEP_QUERY_RAW_SQL).all(startIdx) as Array<{
            idx?: unknown
            step_type?: unknown
            step_payload?: unknown
          }>
          const out: RawStepRow[] = []
          for (const r of rows) {
            const idx = typeof r.idx === 'number' ? r.idx : Number(r.idx)
            const stepType = typeof r.step_type === 'number' ? r.step_type : Number(r.step_type)
            if (!Number.isFinite(idx) || !Number.isFinite(stepType)) continue
            let payload: Buffer
            if (r.step_payload instanceof Uint8Array) {
              payload = Buffer.from(r.step_payload.buffer, r.step_payload.byteOffset, r.step_payload.byteLength)
            } else if (typeof r.step_payload === 'string' && r.step_payload !== '') {
              payload = Buffer.from(r.step_payload, 'utf8')
            } else {
              continue
            }
            out.push({ idx, stepType, payload })
          }
          return out
        } finally {
          db.close()
        }
      }
    } catch (err) {
      nodeSqliteRawQuery = null
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
  if (nodeSqliteRawQuery) {
    return nodeSqliteRawQuery(dbPath, minIdx)
  }
  if (typeof nodeSqliteQuery === 'function') {
    const sql = minIdx > 0 ? `${STEP_QUERY_SQL} AND idx >= ${Math.floor(minIdx)}` : STEP_QUERY_SQL
    return parseHexLines(await nodeSqliteQuery(dbPath, sql))
  }
  throw new Error('node:sqlite unavailable')
}

function parseHexLines(lines: readonly string[]): RawStepRow[] {
  const out: RawStepRow[] = []
  for (const line of lines) {
    const firstPipe = line.indexOf('|')
    if (firstPipe < 0) continue
    const secondPipe = line.indexOf('|', firstPipe + 1)
    if (secondPipe < 0) continue
    const idx = parseInt(line.slice(0, firstPipe), 10)
    const stepType = parseInt(line.slice(firstPipe + 1, secondPipe), 10)
    if (!Number.isFinite(idx) || !Number.isFinite(stepType)) continue
    const hexPayload = line.slice(secondPipe + 1).trim()
    if (hexPayload === '' || hexPayload === 'NULL') continue
    out.push({ idx, stepType, payload: Buffer.from(hexPayload, 'hex') })
  }
  return out
}

/**
 * Failure backoff state. Without it, a missing `sqlite3` binary (or an
 * oversized/locked DB) made EVERY step event re-spawn sqlite3: the empty
 * result was cached as `loaded: true` with empty maps, every new stepIndex
 * missed, and the spawn storm repeated for the whole session with no log.
 *  - ENOENT (binary absent): negative-cache for the full cache window.
 *  - Other failures (lock, maxBuffer, parse): short backoff so the adapter's
 *    deliberate 50-100ms WAL-flush retries still get a fresh chance.
 */
let lastFailureAt = 0
let failureWindowMs = 0
let warnedUnavailable = false

/** True while a failed load should serve the (empty) cached view instead. */
export function isBackingOff(now: number): boolean {
  return lastFailureAt !== 0 && now - lastFailureAt < failureWindowMs
}

/** Forget the backoff/warning state (cache clear, test reset). */
export function resetReaderState(): void {
  lastFailureAt = 0
  failureWindowMs = 0
  warnedUnavailable = false
}

/**
 * Query tool and thought step payloads directly from the agy SQLite DB —
 * node:sqlite first, sqlite3 CLI as the fallback reader.
 *
 * Direct read avoids the file-copy busy loop on macOS (issue #52) where
 * libuv uv_fs_copyfile spins at 100% CPU if an active WAL file is truncated
 * during copy. SQLite WAL mode provides concurrent read MVCC snapshots
 * natively without copying to temp.
 */
export async function loadAgyDbData(conversationId: string, accountHome?: string, sinceIdx = 0): Promise<AgyDbData> {
  const steps = new Map<number, CachedStep>()
  const thoughts = new Map<number, string>()
  const results = new Map<number, string>()
  const seenSteps = new Set<number>()
  let maxSeenIdx = sinceIdx > 0 ? Math.floor(sinceIdx) - 1 : -1
  if (!isSafeConversationId(conversationId)) return { steps, thoughts, results, seenSteps, maxSeenIdx }
  const dbPath = findConversationDb(conversationId, accountHome)
  if (dbPath === null) return { steps, thoughts, results, seenSteps, maxSeenIdx }

  try {
    const st = await stat(dbPath)
    if (st.size === 0) return { steps, thoughts, results, seenSteps, maxSeenIdx }
  } catch {
    return { steps, thoughts, results, seenSteps, maxSeenIdx }
  }

  try {
    const minIdx = Number.isFinite(sinceIdx) && sinceIdx > 0 ? Math.floor(sinceIdx) : 0
    // node:sqlite first (no external binary — desktop hosts, issue #43);
    // the sqlite3 CLI stays as the fallback for runtimes without node:sqlite.
    let rows: RawStepRow[] | null = null
    try {
      rows = await queryRawViaNodeSqlite(dbPath, minIdx)
    } catch {
      try {
        const sql = minIdx > 0 ? `${STEP_QUERY_SQL} AND idx >= ${minIdx}` : STEP_QUERY_SQL
        const { stdout } = await execFileAsync('sqlite3', [
          '-cmd', '.timeout 2000',
          '-cmd', 'PRAGMA query_only = ON;',
          dbPath,
          sql,
        ], {
          timeout: 5_000,
          encoding: 'utf-8',
          maxBuffer: 25 * 1024 * 1024,
        })
        rows = parseHexLines(stdout.split('\n'))
      } catch {
        rows = null
      }
    }
    if (rows === null) {
      throw new Error('no sqlite reader available (node:sqlite and sqlite3 CLI both failed)')
    }

    for (const row of rows) {
      const { idx, stepType, payload } = row
      seenSteps.add(idx)
      if (idx > maxSeenIdx) maxSeenIdx = idx
      if (TOOL_STEP_TYPES.has(stepType)) {
        const info = extractToolInfo(payload)
        if (info !== null) {
          steps.set(idx, info)
        }
        const resultText = extractToolResultText(payload)
        if (resultText !== null) results.set(idx, resultText)
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
    lastFailureAt = 0
    failureWindowMs = 0
  } catch (err) {
    // DB locked, sqlite3 missing, or parse error — graceful fallback, but
    // now BACKED OFF so callers cannot turn this into a spawn storm, and
    // WARNED ONCE so the degradation is visible.
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      // sqlite3 CLI not installed: re-probing per event is pure waste.
      failureWindowMs = MAX_CACHE_AGE_MS
    } else {
      failureWindowMs = 300
    }
    lastFailureAt = Date.now()
    if (!warnedUnavailable) {
      warnedUnavailable = true
      try {
        console.error('[dsh-agy-link] agy conversation DB unavailable (' + String(err) + ') — falling back to stream-carried metadata only' + (code === 'ENOENT' ? '; install the sqlite3 CLI for full tool args and thoughts' : ''))
      } catch {
        // ignore
      }
    }
  }

  return { steps, thoughts, results, seenSteps, maxSeenIdx }
}
