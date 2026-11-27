// Media URL + file-type helpers for local image, video, and audio display.
//
// Split out of src/client/images.ts; stays free of React so plain-ESM tests
// can import it without a React/require shim.
import { timedSignal, WRITE_TIMEOUT_MS } from '../api.ts';
import { translateOr } from '../i18n-bridge.ts';

let builtInMediaPreviewOnlyFlag = false;

export function setBuiltInMediaPreviewOnly(enabled: boolean): void {
  builtInMediaPreviewOnlyFlag = enabled === true;
}

export function isBuiltInMediaPreviewOnly(): boolean {
  return builtInMediaPreviewOnlyFlag;
}

/**
 * True when the DSH client is loaded in a remote browser (e.g. Cloudflare
 * Tunnel or LAN host) rather than the local desktop app / loopback origin.
 */
export function isRemoteClient(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const protocol = (window.location.protocol || '').toLowerCase();
  if (
    protocol === 'file:' ||
    protocol === 'dsh-app:' ||
    protocol === 'app:' ||
    protocol === 'vscode-webview:'
  ) {
    return false;
  }
  const host = (window.location.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return false;
  }
  return true;
}

/**
 * True when media previews must stay entirely inside DSH (no host OS Open /
 * Reveal launches). Automatically enforced for remote browsers and optionally
 * toggled on locally via `builtInMediaPreviewOnly`.
 */
export function shouldUseBuiltInMediaOnly(): boolean {
  return isRemoteClient() || builtInMediaPreviewOnlyFlag;
}

export function getOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    const o = window.location.origin;
    if (o === 'null' || o === 'file://') {
      return '';
    }
    return o;
  }
  return '';
}

/** Check if a string is a remote web URL */
export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

export interface MediaUrlOptions {
  /** Request server-side browser-compatible remux/transcode (e.g. H.264/yuv420p MP4). */
  compat?: boolean;
  /** Request Content-Disposition: attachment so the browser downloads the original file. */
  download?: boolean;
  /** Bypass compatibility transcoding and stream raw source bytes. */
  raw?: boolean;
}

/** Build media URL from path */
export function buildMediaUrl(rawPath: string, opts?: MediaUrlOptions): string {
  const p = rawPath.trim();
  if (isRemoteUrl(p)) return p;
  const origin = getOrigin();
  const params = [`path=${encodeURIComponent(p)}`];
  if (opts?.compat) params.push('compat=1');
  if (opts?.download) params.push('download=1');
  if (opts?.raw) params.push('raw=1');
  return `${origin}/plugins/agy-link/media?${params.join('&')}`;
}

/** Check if a URL or path is an image */
export function isImageFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif|tiff?|heic|heif)$/i.test(clean);
}

/** Check if a URL or path is a video */
export function isVideoFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(mp4|m4v|webm|mov|mkv|ogv|avi|flv|wmv)$/i.test(clean);
}

/** Check if a URL or path is an audio file */
export function isAudioFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(clean);
}

/** Check if a URL or path is visual media (image or video) */
export function isMediaFile(pathOrUrl: string): boolean {
  return isImageFile(pathOrUrl) || isVideoFile(pathOrUrl) || isAudioFile(pathOrUrl);
}

/** Check if a URL or path represents a local file or relative path */
export function isLocalFilePath(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const trimmed = pathOrUrl.trim();
  if (trimmed.startsWith('file://')) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('\\\\')) return true;
  if (isRemoteUrl(trimmed) || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('javascript:')) {
    return false;
  }
  const clean = trimmed.split(/[?#]/)[0] ?? '';
  return /\.[a-zA-Z0-9]{1,8}$/.test(clean);
}

/** Trigger a browser download of the original file (safe in both local & remote browsers). */
export function triggerBrowserDownload(rawPath: string, fileName?: string): void {
  if (typeof document === 'undefined' || !rawPath.trim()) return;
  const a = document.createElement('a');
  a.href = buildMediaUrl(rawPath, { download: true });
  const inferred = fileName || rawPath.split(/[?#]/)[0]?.split(/[/\\]/).pop() || 'download';
  a.download = inferred;
  a.rel = 'noopener';
  a.style.display = 'none';
  (document.body ?? document.documentElement)?.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Probe why a `<video>`, `<audio>`, or `<img>` element failed to load by issuing
 * a lightweight HEAD request and translating the HTTP status or codec cause.
 */
export async function probeMediaError(url: string): Promise<string> {
  const fallback = translateOr(
    'lightbox.unavailableHint',
    'The file may still be generating, may have moved, or needs an external app.',
  );
  if (typeof fetch !== 'function' || !url) return fallback;
  try {
    const signal = timedSignal(WRITE_TIMEOUT_MS) as AbortSignal | undefined;
    const res = await fetch(url, { method: 'HEAD', ...(signal ? { signal } : {}) });
    if (res.status === 401) {
      return translateOr('lightbox.errAuth', 'Authentication required (HTTP 401): reload DSH and sign in again.');
    }
    if (res.status === 403) {
      return translateOr(
        'lightbox.errForbidden',
        'Access denied (HTTP 403): path is outside allowed workspace roots or blocked by origin policy.',
      );
    }
    if (res.status === 404) {
      return translateOr('lightbox.errNotFound', 'File not found (HTTP 404): it may still be generating or was moved.');
    }
    if (res.status >= 500) {
      return translateOr(
        'lightbox.errServer',
        'Server failed to read or transcode the media (HTTP {status}).',
        { status: res.status },
      );
    }
    if (res.ok) {
      return translateOr(
        'lightbox.errCodec',
        'This browser cannot decode the video codec directly. Try downloading the original file.',
      );
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** Open a file in the host OS default app or reveal in Finder / Explorer */
export async function openInSystem(
  rawPath: string,
  reveal = false,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const origin = getOrigin();
    const url = `${origin}/plugins/agy-link/open?path=${encodeURIComponent(rawPath.trim())}${reveal ? '&reveal=1' : ''}`;
    const signal = timedSignal(WRITE_TIMEOUT_MS) as AbortSignal | undefined;
    const res = await fetch(url, { method: 'POST', ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: (data as { error?: string })?.error ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { ok: boolean; path?: string; error?: string };
    return data;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

