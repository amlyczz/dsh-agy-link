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

