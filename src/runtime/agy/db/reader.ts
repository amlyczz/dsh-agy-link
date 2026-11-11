// Open and read the agy SQLite conversation DB: node:sqlite first, the
// sqlite3 CLI as the fallback reader, with failure backoff so a missing
// reader cannot turn every step event into a process spawn.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { extractStepThoughts, extractToolInfo } from './extract.ts'
import { findConversationDb, isSafeConversationId } from './paths.ts'
import {
  MAX_CACHE_AGE_MS,
  STEP_QUERY_SQL,
  TOOL_STEP_TYPES,
  type AgyDbData,
  type CachedStep,
} from './schema.ts'

const execFileAsync = promisify(execFile)

/**
 * node:sqlite reader (Node >= 22.5, REQUIRED node >= 24 for this plugin).
 * Preferred over the sqlite3 CLI: GUI/desktop hosts often lack the CLI on
 * PATH (macOS GUI apps do not inherit the shell PATH; Windows never ships
 * one), which is exactly the "thinking/tool args invisible on desktop"
 * report (issue #43). `undefined` = not probed yet, `null` = unavailable.
 */
let nodeSqliteQuery: ((dbPath: string, sql: string) => Promise<string[]>) | null | undefined

/**
 * TEST-ONLY injection: override the node:sqlite reader function.
 * Pass null to simulate node:sqlite missing (forcing sqlite3 CLI fallback),
 * or undefined to reset back to automatic probing.
 */
export function __setNodeSqliteQueryForTest(
  fn: ((dbPath: string, sql: string) => Promise<string[]>) | null | undefined,
): void {
  nodeSqliteQuery = fn
}

async function queryViaNodeSqlite(dbPath: string, sql: string): Promise<string[]> {
  if (nodeSqliteQuery === null) throw new Error('node:sqlite unavailable')
  if (nodeSqliteQuery === undefined) {
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
      nodeSqliteQuery = async (p, q) => {
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
          const rows = db.prepare(q).all() as Array<{ idx?: unknown; step_type?: unknown; payload_hex?: unknown }>
          return rows.map((r) => `${String(r.idx)}|${String(r.step_type)}|${typeof r.payload_hex === 'string' ? r.payload_hex : ''}`)
        } finally {
          db.close()
        }
      }
    } catch (err) {
      nodeSqliteQuery = null
      throw err instanceof Error ? err : new Error(String(err))
    }
  }
  return nodeSqliteQuery(dbPath, sql)
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
export async function loadAgyDbData(conversationId: string, accountHome?: string): Promise<AgyDbData> {
  const steps = new Map<number, CachedStep>()
  const thoughts = new Map<number, string>()
  const seenSteps = new Set<number>()
  if (!isSafeConversationId(conversationId)) return { steps, thoughts, seenSteps }
  const dbPath = findConversationDb(conversationId, accountHome)
  if (dbPath === null) return { steps, thoughts, seenSteps }

  try {
    const st = await stat(dbPath)
    if (st.size === 0) return { steps, thoughts, seenSteps }
  } catch {
    return { steps, thoughts, seenSteps }
  }

  try {
    // node:sqlite first (no external binary — desktop hosts, issue #43);
    // the sqlite3 CLI stays as the fallback for runtimes without node:sqlite.
    let lines: string[] | null = null
    try {
      lines = await queryViaNodeSqlite(dbPath, STEP_QUERY_SQL)
    } catch {
      try {
        const { stdout } = await execFileAsync('sqlite3', [
          '-cmd', '.timeout 2000',
          '-cmd', 'PRAGMA query_only = ON;',
          dbPath,
          STEP_QUERY_SQL,
        ], {
          timeout: 5_000,
          encoding: 'utf-8',
          maxBuffer: 25 * 1024 * 1024,
        })
        lines = stdout.split('\n')
      } catch {
        lines = null
      }
    }
    if (lines === null) {
      throw new Error('no sqlite reader available (node:sqlite and sqlite3 CLI both failed)')
    }

    for (const line of lines) {
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

  return { steps, thoughts, seenSteps }
}
