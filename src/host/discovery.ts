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
  conversationId: string | null;
  /** more than one new db appeared; picked newest by mtime. */
  ambiguous: boolean;
}

export function diffConversations(before: DirSnapshot, dir = defaultConversationsDir()): DiffOutcome {
  const after = snapshotConversations(dir);
  const added: Array<{ name: string; mtime: number }> = [];
  for (const [name, mtime] of after.files) {
    if (!before.files.has(name)) added.push({ name, mtime });
  }
  if (added.length === 0) return { conversationId: null, ambiguous: false };
  added.sort((a, b) => b.mtime - a.mtime);
  const top = added[0];
  // Several conversations appeared while this run was live: the newest one is
  // not provably ours (concurrent children share one account HOME). Report no
  // id so no binding is written, instead of binding every sibling to one
  // thread — that is what made four parallel teams answer the same prompt.
  const ambiguous = added.length > 1;
  if (ambiguous) return { conversationId: null, ambiguous };
  const id = top !== undefined ? top.name.replace(/\.db$/, '') : '';
  return { conversationId: id, ambiguous };
}
