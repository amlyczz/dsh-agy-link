// Media URL + file-type helpers for local image display.
//
// Split out of src/client/images.ts; logic is unchanged.
export function getOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
}

/** Build media URL from path */
export function buildMediaUrl(rawPath: string): string {
  const origin = getOrigin();
  return `${origin}/plugins/agy-link/media?path=${encodeURIComponent(rawPath.trim())}`;
}

/** Check if a URL or path is an image */
export function isImageFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i.test(clean);
}

