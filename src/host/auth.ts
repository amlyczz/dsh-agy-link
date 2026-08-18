// AuthHelper (spec ADR-11): in-GUI Google OAuth without a terminal. A tiny
// probe spawn of the real agy binary prints the consent URL (no TTY) and
// waits on stdin for the pasted authorization code; we surface the URL to
// the client panel and pipe the code back. We never read, write, copy, or
// move the OAuth token file itself — the official binary owns credentials.
import { extractAuthUrl, looksLikeAuthFailure } from '../common/types.ts'
import { startAgyProcess, type RunningProcess } from './runner.ts'

export type AuthPhase = 'idle' | 'pending' | 'submitting' | 'ok' | 'failed'

export interface AuthStatus {
  phase: AuthPhase;
  url?: string;
  startedAt?: number;
  /** agy hard-codes a ~60s wait for the code; fresh URL after that. */
  expiresAt?: number;
  message?: string;
}

const URL_WAIT_MS = 15_000;
const CODE_SETTLE_MS = 90_000;

export class AuthHelper {
  private state: AuthStatus = { phase: 'idle' };
  private probe: RunningProcess | null = null;
  private capturedUrl: string | null = null;
  private urlWaiter: ((url: string) => void) | null = null;
  private urlTimer: NodeJS.Timeout | null = null;

  constructor(private readonly bin: () => string | null) {}

  status(): AuthStatus {
    return { ...this.state };
  }

  private startProbe(): RunningProcess | null {
    const bin = this.bin();
    if (!bin) return null;
    this.cancel();
    this.capturedUrl = null;
    const proc = startAgyProcess({
      bin,
      args: ['-p', 'ping', '--output-format', 'stream-json', '--print-timeout', '4m'],
      timeoutMs: 5 * 60_000,
      keepStdin: true,
      onLine: (line) => {
        if (this.capturedUrl) return;
        const url = extractAuthUrl(line);
        if (url) {
          this.capturedUrl = url;
          this.urlWaiter?.(url);
          this.urlWaiter = null;
          if (this.urlTimer) clearTimeout(this.urlTimer);
          this.urlTimer = null;
        }
      },
    });
    proc.child.stderr?.on('data', (chunk: string) => {
      if (this.capturedUrl) return;
      const url = extractAuthUrl(chunk);
      if (url) {
        this.capturedUrl = url;
        this.urlWaiter?.(url);
        this.urlWaiter = null;
        if (this.urlTimer) clearTimeout(this.urlTimer);
        this.urlTimer = null;
      }
    });
    this.probe = proc;
    return proc;
  }

  /** Start (or restart) the login flow; resolves with the consent URL. */
  async begin(): Promise<AuthStatus> {
    const proc = this.startProbe();
    if (!proc) {
      this.state = { phase: 'failed', message: 'agy binary not found' };
      return this.status();
    }
    const startedAt = Date.now();
    this.state = { phase: 'pending', startedAt, expiresAt: startedAt + 55_000 };
    const url = await new Promise<string | null>((resolve) => {
      this.urlWaiter = resolve;
      this.urlTimer = setTimeout(() => {
        this.urlWaiter = null;
        resolve(null);
      }, URL_WAIT_MS);
    });
    if (this.urlTimer) clearTimeout(this.urlTimer);
    this.urlTimer = null;
    if (!url) {
      // No URL within the window: agy is probably already signed in.
      this.state = { phase: 'ok', startedAt, message: 'no login URL produced — already authenticated?' };
      this.cancel();
      return this.status();
    }
    this.state = { phase: 'pending', url, startedAt, expiresAt: startedAt + 55_000 };
    return this.status();
  }

  /** Pipe the pasted authorization code into the waiting probe. */
  async submitCode(code: string): Promise<AuthStatus> {
    if (this.state.phase !== 'pending' || !this.probe) {
      this.state = { phase: 'failed', message: 'no pending login — run /agy auth first' };
      return this.status();
    }
    if (this.state.expiresAt && Date.now() > this.state.expiresAt) {
      this.state = { phase: 'failed', message: 'login window expired — restart with /agy auth' };
      this.cancel();
      return this.status();
    }
    this.state = { ...this.state, phase: 'submitting' };
    const proc = this.probe;
    try {
      proc.child.stdin?.write(code.trim() + '\n');
    } catch {
      this.state = { phase: 'failed', message: 'probe stdin closed' };
      return this.status();
    }
    const outcome = await Promise.race([
      proc.outcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CODE_SETTLE_MS)),
    ]);
    if (outcome === null) {
      this.state = { phase: 'failed', message: 'timed out waiting for agy to finish the exchange' };
      this.cancel();
      return this.status();
    }
    const tail = outcome.stdout + outcome.stderrTail;
    if (outcome.code === 0 && !looksLikeAuthFailure(tail)) {
      this.state = { phase: 'ok', message: 'authenticated' };
    } else {
      this.state = { phase: 'failed', message: outcome.stderrTail.trim() || 'authorization code rejected' };
    }
    this.probe = null;
    return this.status();
  }

  cancel(): void {
    if (this.probe) {
      this.probe.kill('abort');
      this.probe = null;
    }
    if (this.urlTimer) clearTimeout(this.urlTimer);
    this.urlTimer = null;
    this.urlWaiter = null;
  }

  dispose(): void {
    this.cancel();
    this.state = { phase: 'idle' };
  }
}
