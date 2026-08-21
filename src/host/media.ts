// Multimodal staging (v0.2): DSH image blocks are written to a local
// media directory and referenced by absolute path in the agy prompt —
// agy (an IDE agent) reads them with its own file/vision tools. This is
// the same approach the pi extension uses: stage to tmp, reference by
// path, sweep on a TTL. No bytes ever leave the machine except through
// agy itself.

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Structural subset of ImageAttachmentRef (no package import needed). */
export interface ImageRefLike {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

/** Byte reader seam — index.ts injects ctx.attachments.readImage. */
export type ImageReader = (ref: ImageRefLike) => Promise<Uint8Array | null>

export interface StagedImage {
  path: string
  name: string
  width: number
  height: number
  bytes: number
}

export interface StageResult {
  /** Lines appended to the prompt (empty string when nothing staged). */
  promptSuffix: string
  staged: StagedImage[]
  /** Number of images skipped (over cap, over size, unreadable). */
  skipped: number
}

const EXT: Record<ImageRefLike['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Deterministic staged path: same session+turn+index reuses the file. */
export function stagedPath(dir: string, key: string, index: number, mediaType: ImageRefLike['mediaType']): string {
  const ext = EXT[mediaType] ?? 'png'
  return join(dir, key + '-' + String(index) + '.' + ext)
}

/**
 * Stage up to `maxImages` images into `dir`, returning prompt lines that
 * reference them by absolute path. Deterministic names mean a retried or
 * replayed turn overwrites the same file instead of accumulating copies.
 */
export async function stageImages(opts: {
  dir: string
  key: string
  images: readonly ImageRefLike[]
  readImage: ImageReader
  maxImages: number
  maxBytes: number
}): Promise<StageResult> {
  const staged: StagedImage[] = []
  const lines: string[] = []
  let skipped = 0
  const budget = Math.max(0, opts.maxImages)
  if (budget > 0 && opts.images.length > 0) {
    await mkdir(opts.dir, { recursive: true })
    let i = 0
    for (const ref of opts.images) {
      if (staged.length >= budget) {
        skipped += opts.images.length - staged.length - skipped
        break
      }
      const label = ref.name ?? ref.attachmentId
      if (ref.bytes > opts.maxBytes) {
        skipped++
        lines.push('[image skipped: "' + label + '" exceeds mediaMaxBytes]')
        i++
        continue
      }
      let data: Uint8Array | null = null;
      try {
        data = await opts.readImage(ref)
      } catch {
        data = null;
      }
      if (!data) {
        skipped++
        lines.push('[image unavailable: "' + label + '" could not be read from attachment storage]')
        i++;
        continue;
      }
      const path = stagedPath(opts.dir, opts.key, i, ref.mediaType)
      await writeFile(path, data);
      staged.push({ path, name: label, width: ref.width, height: ref.height, bytes: ref.bytes });
      lines.push('[image attached: "' + label + '" — staged at ' + path + ' (' + ref.width + 'x' + ref.height + ', ' + ref.bytes + ' bytes). Inspect it using the view_file tool with AbsolutePath: "' + path + '"]');
      i++;
    }
  }
  return { promptSuffix: lines.join('\n'), staged, skipped }
}

/**
 * Delete staged files older than `ttlMs`. Returns the removed count.
 * Never throws: a failed sweep logs nothing and retries on the next pass.
 */
export async function sweepDir(dir: string, ttlMs: number, now = Date.now()): Promise<number> {
  if (ttlMs <= 0) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (st.isFile() && now - st.mtimeMs > ttlMs) {
        await unlink(full);
        removed++;
      }
    } catch {
      // raced or unreadable — leave it for the next pass
    }
  }
  return removed;
}

/** Default media directory: <dsh home>/agy-link/media. */
export function defaultMediaDir(stateDir: string): string {
  return join(stateDir, 'media')
}
