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
  const id = top !== undefined ? top.name.replace(/\.db$/, '') : '';
  return { conversationId: id, ambiguous: added.length > 1 };
}
