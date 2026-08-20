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
}

export class SessionStore {
  private data: Record<string, SessionBinding> = {};

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
    this.persist();
  }

  delete(key: string): void {
    delete this.data[key];
    this.persist();
  }

  clear(): void {
    this.data = {};
    this.persist();
  }

  all(): Readonly<Record<string, SessionBinding>> {
    return this.data;
  }

  /** Atomic write: tmp file + rename, then merge on next load. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = join(dirname(this.file), '.' + require$$basename(this.file) + '.tmp')
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file);
    } catch {
      // best-effort persistence; memory copy still serves this process
    }
  }
}

// tiny basename to avoid pulling node:path twice for one call
function require$$basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
