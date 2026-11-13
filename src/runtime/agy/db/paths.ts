// Where agy keeps its conversation databases: the system HOME plus every
// isolated pool account home. No DB is opened here — just path resolution.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

let AGY_DB_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')

/** Point the resolver at a custom conversations dir (tests only). */
export function setAgyDbDir(dir: string): void {
  AGY_DB_DIR = dir
}

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
  const realHome = process.env.USERPROFILE || process.env.HOME || homedir()
  const poolBases = [join(homedir(), '.dsh', 'agy-accounts')]
  if (realHome && realHome !== homedir()) poolBases.push(join(realHome, '.dsh', 'agy-accounts'))
  for (const pb of poolBases) {
    try {
      for (const ent of readdirSync(pb)) {
        if (ent.startsWith('.')) continue
        push(join(pb, ent, '.gemini', 'antigravity-cli', 'conversations'))
      }
    } catch {
      // pool not installed
    }
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

/** agy conversation ids are path-safe tokens; reject anything else before join(). */
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeConversationId(id: string): boolean {
  return SAFE_CONVERSATION_ID.test(id)
}

/** Locate an existing conversation_summaries.db across system + pool homes. */
export function findSummariesDb(accountHome?: string): string | null {
  for (const dir of conversationsDirCandidates(accountHome)) {
    const p = join(dirname(dir), 'conversation_summaries.db')
    try {
      if (existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
}

/** Locate a subagent's transcript.jsonl across system + pool homes. */
export function findTranscriptPath(conversationId: string, accountHome?: string): string | null {
  if (!isSafeConversationId(conversationId)) return null
  for (const dir of conversationsDirCandidates(accountHome)) {
    const p = join(dirname(dir), 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
    try {
      if (existsSync(p)) return p
    } catch {
      // ignore
    }
  }
  return null
}
