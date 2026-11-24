// Clipboard image writer for the media lightbox.
// Chromium / Electron's Async Clipboard API accepts `image/png` reliably on
// write, while rejecting `image/webp`, `image/jpeg`, `image/svg+xml`, etc.
// PNG payloads pass through untouched; other formats rasterize onto an
// offscreen canvas first so every previewable image can be copied in one step.

export interface CopyImageResult {
  ok: boolean;
  error?: string;
}

function canvasToPngBlob(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Document unavailable'));
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas 2D context unavailable'));
  ctx.drawImage(source, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => {
      if (out) resolve(out);
      else reject(new Error('PNG encoding failed'));
    }, 'image/png');
  });
}

async function rasterizeBlobToPng(blob: Blob, imgEl?: HTMLImageElement | null): Promise<Blob> {
  if (imgEl && imgEl.complete && imgEl.naturalWidth > 0 && imgEl.naturalHeight > 0) {
    try {
      return await canvasToPngBlob(imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
    } catch {
      // Cross-origin tainted <img> falls through to blob decoding below.
    }
  }
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      return await canvasToPngBlob(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close?.();
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Image decoding unavailable');
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const decoded = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image decode failed'));
      el.src = objectUrl;
    });
    const w = decoded.naturalWidth || decoded.width;
    const h = decoded.naturalHeight || decoded.height;
    if (w <= 0 || h <= 0) throw new Error('Empty image dimensions');
    return await canvasToPngBlob(decoded, w, h);
  } finally {
    URL.revokeObjectURL?.(objectUrl);
  }
}

/**
 * Copy an image URL (same-origin media route or remote) to the OS clipboard as
 * `image/png`. Never throws; returns `{ ok, error }` for toast feedback.
 */
export async function copyImageToClipboard(
  src: string,
  imgEl?: HTMLImageElement | null,
): Promise<CopyImageResult> {
  if (
    typeof navigator === 'undefined'
    || typeof navigator.clipboard?.write !== 'function'
    || typeof ClipboardItem === 'undefined'
  ) {
    return { ok: false, error: 'Clipboard image API unavailable' };
  }
  try {
    const res = await fetch(src);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const rawBlob = await res.blob();
    const mime = (rawBlob.type || '').toLowerCase();
    const pngBlob = mime === 'image/png' ? rawBlob : await rasterizeBlobToPng(rawBlob, imgEl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
