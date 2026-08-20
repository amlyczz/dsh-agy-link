// AuthHelper (spec ADR-11): in-GUI Google OAuth without a terminal. A tiny
// probe spawn of the real agy binary prints the consent URL (no TTY) and
// waits on stdin for the pasted authorization code; we surface the URL to
// the client panel and pipe the code back. We never read, write, copy, or
// move the OAuth token file itself — the official binary owns credentials.
import { extractAuthUrl, looksLikeAuthFailure } from '../common/types.ts'
import { probeProcess, startAgyProcess, type RunningProcess } from './runner.ts'

export type AuthPhase = 'idle' | 'pending' | 'submitting' | 'ok' | 'failed' | 'signed-out'

export interface AuthStatus {
  phase: AuthPhase;
  url?: string;
  qrDataUrl?: string;
  startedAt?: number;
  /** agy hard-codes a wait for the code; fresh URL after that. */
  expiresAt?: number;
  message?: string;
}

const URL_WAIT_MS = 20_000;
const CODE_SETTLE_MS = 90_000;

export class AuthHelper {
  private state: AuthStatus = { phase: 'idle' };
  private probe: RunningProcess | null = null;
  private capturedUrl: string | null = null;
  private urlWaiter: ((url: string) => void) | null = null;
  private urlTimer: NodeJS.Timeout | null = null;

  private signedInCache: { value: boolean | null; at: number } | null = null
  private signedInFlight: Promise<boolean | null> | null = null

  constructor(private readonly bin: () => string | null) {}

  status(): AuthStatus {
    return { ...this.state };
  }

  /**
   * Ground-truth login probe: `agy models` succeeds only when signed in and
   * prints a sign-in error otherwise. Cached for 60s; in-flight calls share
   * one spawn. Returns true/false, or null when undeterminable (no binary,
   * spawn failure, ambiguous output). While a login flow is active the
   * in-memory phase wins and the probe is skipped.
   */
  async probeSignedIn(force = false): Promise<boolean | null> {
    if (this.state.phase === 'pending' || this.state.phase === 'submitting') return null
    if (this.state.phase === 'ok') return true
    const now = Date.now()
    if (!force && this.signedInCache !== null && now - this.signedInCache.at < 60_000) {
      return this.signedInCache.value
    }
    if (this.signedInFlight !== null) return this.signedInFlight
    const bin = this.bin()
    if (!bin) return null
    this.signedInFlight = (async () => {
      let value: boolean | null = null
      try {
        const out = await probeProcess(bin, ['models'], 15_000)
        const tail = out.stderrTail + '\n' + out.stdout.slice(0, 2000)
        if (out.code === 0 && !looksLikeAuthFailure(out.stdout)) value = true
        else if (out.code !== 0 && looksLikeAuthFailure(tail)) value = false
      } catch {
        value = null
      }
      this.signedInCache = { value, at: Date.now() }
      this.signedInFlight = null
      return value
    })()
    return this.signedInFlight
  }

  /** status() enriched with a lazily probed login state for idle phases. */
  async resolvedStatus(): Promise<AuthStatus> {
    const st = this.status()
    if (st.phase !== 'idle') return st
    const signedIn = await this.probeSignedIn()
    if (signedIn === true) return { phase: 'ok', message: 'signed in (probed via agy models)' }
    if (signedIn === false) return { phase: 'signed-out', message: 'agy is not signed in — run /agy auth' }
    return st
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
    this.state = { phase: 'pending', startedAt, expiresAt: startedAt + 120_000 };
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
    let qrDataUrl: string | undefined
    try {
      const qrcode = (await import('qrcode')) as unknown as { toDataURL: (t: string, o?: { width?: number; margin?: number }) => Promise<string> }
      qrDataUrl = await qrcode.toDataURL(url, { width: 220, margin: 1 })
    } catch {
      // ignore qr generation error
    }
    this.state = { phase: 'pending', url, qrDataUrl, startedAt, expiresAt: startedAt + 120_000 };
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
      this.signedInCache = { value: true, at: Date.now() };
      this.state = { phase: 'ok', message: 'authenticated' };
    } else {
      this.signedInCache = { value: false, at: Date.now() };
      this.state = { phase: 'failed', message: outcome.stderrTail.trim() || 'authorization code rejected' };
    }
    this.probe = null;
    return this.status();
  }

  cancelAuth(): AuthStatus {
    this.cancel();
    this.state = { phase: 'signed-out', message: 'login cancelled' };
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
