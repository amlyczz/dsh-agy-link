// agy per-run log access (dsh-agy-link).
//
// agy writes one log per invocation under
//   <home>/.gemini/antigravity-cli/log/cli-<YYYYMMDD_HHMMSS>.log
// where <home> is the account's isolated HOME (secondary accounts) or the real
// system HOME (primary / systemHome account) — the same resolution
// `isolatedHomeEnv` applies at spawn time.
//
// Why the adapter needs this: when agy's silent auth fails it prints a stderr
// banner that is byte-identical for a genuine sign-out and for a stored
// credential that could not be validated over the network (keyring auth missed
// its hard 10s window). Classifying both as AUTH sticky-quarantined three
// healthy accounts during one afternoon of proxy jitter (2026-10-16). The log
// is the only per-run signal that separates the two — see
// `looksLikeAuthVerificationJitter` in common/types.ts for the marker set.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ManagedAccount } from '../common/pool-types.ts'

export type AgyLogSnapshot = ReadonlyMap<string, number> | ReadonlySet<string>

/** Same home resolution quota.ts uses for per-account credential access. */
export function agyHomeDirFor(account: ManagedAccount | undefined): string {
  return account?.systemHome || !account?.dir ? homedir() : account.dir
}

export function agyLogDir(homeDir: string): string {
  return join(homeDir, '.gemini', 'antigravity-cli', 'log')
}

/**
 * Byte-size snapshot of `cli-*.log` files present right now.
 * Recording byte offsets (instead of filenames alone) ensures two `agy` spawns
 * within the same wall-clock second (`cli-YYYYMMDD_HHMMSS.log`) still capture
 * the second invocation's appended log lines.
 */
export function snapshotAgyLogs(homeDir: string): Map<string, number> {
  const dir = agyLogDir(homeDir)
  const out = new Map<string, number>()
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('cli-') || !f.endsWith('.log')) continue
      try {
        out.set(f, statSync(join(dir, f)).size)
      } catch {
        out.set(f, 0)
      }
    }
  } catch {
    // missing log dir is normal before first agy run
  }
  return out
}

/** Upper bound so one pathological log cannot balloon the failure path. */
const MAX_LOG_BYTES = 256 * 1024
const MAX_LOG_FILES = 3

function readFileTailFromOffset(filePath: string, offset: number, maxBytes: number): string {
  const size = statSync(filePath).size
  if (size <= offset || maxBytes <= 0) return ''
  if (offset === 0 && size <= maxBytes) {
    return readFileSync(filePath, 'utf8')
  }
  const available = size - offset
  const length = Math.min(available, maxBytes)
  const start = size - length
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    const read = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * Concatenated text of the log bytes THIS run created (new files or bytes
 * appended past `before`), newest first. Returns '' when the run wrote no
 * readable log — callers must treat that as "no evidence", never as proof
 * either way.
 */
export function readAgyRunLogText(homeDir: string, before: AgyLogSnapshot): string {
  const dir = agyLogDir(homeDir)
  let entries: Array<{ f: string; m: number; offset: number }>
  try {
    if (!existsSync(dir)) return ''
    entries = readdirSync(dir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.log'))
      .flatMap((f) => {
        try {
          const st = statSync(join(dir, f))
          if (before instanceof Set) {
            return before.has(f) ? [] : [{ f, m: st.mtimeMs, offset: 0 }]
          }
          const prevSize = (before as ReadonlyMap<string, number>).get(f)
          if (prevSize === undefined) return [{ f, m: st.mtimeMs, offset: 0 }]
          if (st.size > prevSize) return [{ f, m: st.mtimeMs, offset: prevSize }]
          return []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, MAX_LOG_FILES)
  } catch {
    return ''
  }
  const parts: string[] = []
  let budget = MAX_LOG_BYTES
  for (const entry of entries) {
    if (budget <= 0) break
    try {
      const slice = readFileTailFromOffset(join(dir, entry.f), entry.offset, budget)
      if (slice !== '') {
        parts.push(slice)
        budget -= Buffer.byteLength(slice, 'utf8')
      }
    } catch {
      // A log that vanished mid-read contributes nothing.
    }
  }
  return parts.join('\n')
}
