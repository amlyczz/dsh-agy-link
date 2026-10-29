// Session binding store (spec ADR-4): DSH session id -> agy conversation.
// Atomic tmp+rename writes with dirty-key merge on reload keep concurrent
// host processes (web + headless) from clobbering each other — the
// pi-bridge-proven JSON layout, adapted to the DSH state directory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SessionBinding {
  conversationId: string
  /** DSH message count at bind/update time (digest watermark). */
  lastMessageCount: number
  updatedAt: number
  model?: string
  /**
   * Attachment ids already forwarded to this agy conversation. Images ride
   * as staged files referenced from the prompt; without this watermark every
   * tool-hop continuation re-attached the whole history's screenshots.
   * Capped (see `SENT_IMAGE_IDS_MAX`) — order is oldest-first.
   */
  sentImageIds?: string[]
  /**
   * The last turn on this conversation was cut mid-flight (Stop button, steer
   * preemption, idle watchdog). agy's server-side turn has no finalized reply,
   * so the next prompt carries an explicit "do not continue that unfinished
   * work" boundary — without it the model answers the interrupted question
   * instead of the newest user message.
   */
  interrupted?: boolean
}

/** Keep the binding file small; the oldest ids are dropped first. */
export const SENT_IMAGE_IDS_MAX = 64

export class SessionStore {
  private data: Record<string, SessionBinding> = {};
  /** Keys written by THIS process since the last persist. */
  private readonly dirty = new Set<string>();
  /** Keys deleted by THIS process since the last persist. */
  private readonly removed = new Set<string>();

  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const v = JSON.parse(readFileSync(this.file, 'utf8'))
      if (v && typeof v === 'object') this.data = v as Record<string, SessionBinding>;
    } catch {
      // corrupted store: start empty rather than crash the plugin
    }
  }

  get(key: string): SessionBinding | undefined {
    return this.data[key]
  }

  set(key: string, b: SessionBinding): void {
    this.data[key] = b;
    this.dirty.add(key);
    this.removed.delete(key);
    this.persist();
  }

  delete(key: string): void {
    delete this.data[key];
    this.dirty.delete(key);
    this.removed.add(key);
    this.persist();
  }

  clear(): void {
    for (const key of Object.keys(this.data)) this.removed.add(key);
    this.data = {};
    this.dirty.clear();
    this.persist();
  }

  all(): Readonly<Record<string, SessionBinding>> {
    return this.data;
  }

  /**
   * Purge bindings associated with accounts that no longer exist in the pool.
   * Prevents deleted account ids from lingering in sessions.json.
   */
  cleanupStaleAccounts(validAccountIds: Set<string>): void {
    let changed = false;
    for (const key of Object.keys(this.data)) {
      // Session ids may themselves contain ':' (composite keys produced by
      // other plugins). The account id is the LAST segment and always has the
      // pool shape `acc_<...>`; split on the last ':' and require that shape so
      // a colon-containing session key is never mistaken for an account id and
      // a LIVE binding is never wrongly purged.
      const colon = key.lastIndexOf(':');
      if (colon >= 0) {
        const accId = key.slice(colon + 1);
        if (/^acc_[A-Za-z0-9_]+$/.test(accId) && !validAccountIds.has(accId)) {
          delete this.data[key];
          this.dirty.delete(key);
          this.removed.add(key);
          changed = true;
        }
      }
    }
    if (changed) {
      this.persist();
    }
  }

  /**
   * Atomic write: tmp file + rename, MERGING with whatever another host
   * process wrote in the meantime (web + headless share this file). Only the
   * keys this process touched are overwritten and only the keys it deleted are
   * dropped, so a concurrent writer's bindings survive instead of being
   * clobbered — which used to cost a session its agy conversation (fresh
   * digest-only prompt, or a binding pointing at the wrong conversation).
   */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      let merged: Record<string, SessionBinding> = {};
      if (this.dirty.size > 0 || this.removed.size > 0) {
        try {
          if (existsSync(this.file)) {
            const onDisk = JSON.parse(readFileSync(this.file, 'utf8'))
            if (onDisk && typeof onDisk === 'object') merged = onDisk as Record<string, SessionBinding>
          }
        } catch {
          // unreadable/partial file: fall back to this process's view
        }
      }
      for (const key of this.removed) delete merged[key];
      for (const key of this.dirty) {
        const b = this.data[key]
        if (b !== undefined) merged[key] = b
      }
      const tmp = join(dirname(this.file), '.' + require$$basename(this.file) + '.tmp')
      writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
      renameSync(tmp, this.file);
      // Adopt the merge so this process sees keys other hosts contributed.
      this.data = merged;
      this.dirty.clear();
      this.removed.clear();
    } catch {
      // best-effort persistence; memory copy still serves this process
    }
  }
}

// tiny basename to avoid pulling node:path twice for one call;
// handles BOTH separators — a Windows path contains no '/' and would
// otherwise turn the tmp filename into garbage (persist silently failed).
function require$$basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
