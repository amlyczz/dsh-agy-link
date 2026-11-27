// conversation-id fallback discovery (spec ADR-5): when the stream-json
// events do not carry a conversation id, diff the agy conversations
// directory across the spawn window. The same approach is used by
// pi-antigravity-bridge, agy-acp and antigravity-acp.
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function defaultConversationsDir(): string {
  return process.env.DSH_AGY_CONVERSATIONS_DIR ?? join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
}

/**
 * Conversations directory for one run's HOME. Secondary pool accounts run
 * under an isolated HOME, so the fallback discovery must watch THEIR
 * conversations dir — snapshotting the system HOME silently never saw those
 * conversation databases (agy-db.ts fixed the same class of bug for its DB
 * readers; this aligns discovery with it).
 */
export function conversationsDirFor(accountHome?: string): string {
  if (accountHome !== undefined && accountHome !== '') {
    return join(accountHome, '.gemini', 'antigravity-cli', 'conversations')
  }
  return defaultConversationsDir()
}

export interface DirSnapshot {
  dir: string;
  /** name -> mtimeMs */
  files: Map<string, number>
}

export function snapshotConversations(dir = defaultConversationsDir()): DirSnapshot {
  const files = new Map<string, number>();
  try {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.db')) continue;
        try {
          files.set(name, statSync(join(dir, name)).mtimeMs);
        } catch {
          // raced deletion: skip
        }
      }
    }
  } catch {
    // unreadable dir: empty snapshot
  }
  return { dir, files };
}

export interface DiffOutcome {
  /** The one new conversation db, or null when none or more than one appeared. */
  conversationId: string | null;
  /** more than one new db appeared: the conversation cannot be attributed, so nothing is picked. */
  ambiguous: boolean;
}

/**
 * Diff two snapshots of the conversations dir. Exactly one new db names the
 * conversation this run created. Two or more new dbs (concurrent sessions
 * sharing a HOME) cannot be attributed — picking the newest by mtime bound a
 * session to a neighbour's conversation (issue #215) — so the id stays null and
 * the caller falls back to its other discovery paths.
 */
export function diffConversations(before: DirSnapshot, dir = defaultConversationsDir()): DiffOutcome {
  const after = snapshotConversations(dir);
  const added: Array<{ name: string; mtime: number }> = [];
  for (const [name, mtime] of after.files) {
    if (!before.files.has(name)) added.push({ name, mtime });
  }
  if (added.length === 0) return { conversationId: null, ambiguous: false };
  if (added.length > 1) return { conversationId: null, ambiguous: true };
  return { conversationId: added[0]!.name.replace(/\.db$/, ''), ambiguous: false };
}
