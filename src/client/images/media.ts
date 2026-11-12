// Media URL + file-type helpers for local image display.
//
// Split out of src/client/images.ts; logic is unchanged.
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

/** Build media URL from path */
export function buildMediaUrl(rawPath: string): string {
  const p = rawPath.trim();
  if (isRemoteUrl(p)) return p;
  const origin = getOrigin();
  return `${origin}/plugins/agy-link/media?path=${encodeURIComponent(p)}`;
}

/** Check if a URL or path is an image */
export function isImageFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i.test(clean);
}

/** Check if a URL or path is a video */
export function isVideoFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(mp4|webm|mov|mkv)$/i.test(clean);
}

/** Check if a URL or path is an audio file */
export function isAudioFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(mp3|wav|ogg|m4a|aac)$/i.test(clean);
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

/** Open a file in the host OS default app or reveal in Finder / Explorer */
export async function openInSystem(
  rawPath: string,
  reveal = false,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const origin = getOrigin();
    const url = `${origin}/plugins/agy-link/open?path=${encodeURIComponent(rawPath.trim())}${reveal ? '&reveal=1' : ''}`;
    const res = await fetch(url);
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

