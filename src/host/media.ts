// Multimodal staging (v0.2): DSH image blocks are written to a local
// media directory and referenced by absolute path in the agy prompt —
// agy (an IDE agent) reads them with its own file/vision tools. This is
// the same approach the pi extension uses: stage to tmp, reference by
// path, sweep on a TTL. No bytes ever leave the machine except through
// agy itself.

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
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

export type MediaKind = 'image' | 'pdf' | 'audio' | 'video'

/** Generalized attachment reference covering image, PDF, audio, and video. */
export interface MediaRefLike {
  attachmentId: string
  mediaType: string
  bytes?: number
  width?: number
  height?: number
  name?: string
  path?: string
  data?: Uint8Array | string
}

/** Byte reader seam — index.ts injects ctx.attachments.readImage / readAttachment. */
export type ImageReader = (ref: ImageRefLike) => Promise<Uint8Array | null>
export type MediaReader = (ref: MediaRefLike) => Promise<Uint8Array | null>

export interface StagedImage {
  path: string
  name: string
  width: number
  height: number
  bytes: number
  attachmentId: string
  kind?: MediaKind
  mediaType?: string
}

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
}

const EXT_BY_MIME: Record<string, { ext: string; kind: MediaKind }> = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/bmp': { ext: 'bmp', kind: 'image' },
  'image/avif': { ext: 'avif', kind: 'image' },
  'application/pdf': { ext: 'pdf', kind: 'pdf' },
  'audio/mpeg': { ext: 'mp3', kind: 'audio' },
  'audio/wav': { ext: 'wav', kind: 'audio' },
  'audio/mp4': { ext: 'm4a', kind: 'audio' },
  'audio/aac': { ext: 'aac', kind: 'audio' },
  'audio/flac': { ext: 'flac', kind: 'audio' },
  'audio/opus': { ext: 'opus', kind: 'audio' },
  'audio/ogg': { ext: 'ogg', kind: 'audio' },
  'audio/webm': { ext: 'webm', kind: 'audio' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/x-matroska': { ext: 'mkv', kind: 'video' },
  'video/ogg': { ext: 'ogv', kind: 'video' },
}

/** Normalize parameterized MIME types (e.g. `audio/webm; codecs=opus`) and aliases. */
export function normalizeMediaType(raw: string): string {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_ALIASES[base] ?? base
}

export function mediaKindFor(mediaType: string): MediaKind | null {
  return EXT_BY_MIME[normalizeMediaType(mediaType)]?.kind ?? null
}

function mediaExtFor(mediaType: string): string {
  return EXT_BY_MIME[normalizeMediaType(mediaType)]?.ext ?? 'bin'
}

export interface StageResult {
  /** Lines appended to the prompt (empty string when nothing staged). */
  promptSuffix: string
  staged: StagedImage[]
  /** Attachment ids that were actually written (not skipped/unreadable). */
  stagedIds: string[]
  /** Number of images skipped (over cap, over size, unreadable). */
  skipped: number
}

/**
 * Sanitize an attachment id into a stable filename fragment. Ids whose
 * sanitized form collides (e.g. "a/b" vs "a_b") get a short raw-id hash
 * suffix so distinct attachments never overwrite each other's files.
 */
function idFragment(attachmentId: string): string {
  const cleaned = attachmentId.replace(/[^a-zA-Z0-9_-]+/g, '_')
  if (cleaned === '') return 'img'
  if (cleaned === attachmentId) return cleaned.slice(0, 80)
  let h = 0
  for (let i = 0; i < attachmentId.length; i++) h = ((h * 31) + attachmentId.charCodeAt(i)) | 0
  return (cleaned.slice(0, 40) + '-' + (h >>> 0).toString(36)).slice(0, 80)
}

/**
 * Deterministic staged path keyed by the attachment id (not the call index):
 * the same picture always lands on the same file, so a continuation that
 * legitimately re-references it overwrites instead of accumulating copies.
 */
export function stagedPath(dir: string, key: string, attachmentId: string, mediaType: string): string {
  const ext = mediaExtFor(mediaType)
  return join(dir, key + '-' + idFragment(attachmentId) + '.' + ext)
}

async function resolveMediaBytes(ref: MediaRefLike, readMedia?: MediaReader): Promise<Uint8Array | null> {
  if (ref.data instanceof Uint8Array) return ref.data
  if (typeof ref.data === 'string' && ref.data !== '') {
    try {
      return Buffer.from(ref.data.replace(/^data:[^;]+;base64,/, ''), 'base64')
    } catch {
      return null
    }
  }
  if (readMedia) {
    try {
      const data = await readMedia(ref)
      if (data) return data
    } catch {
      // fall through
    }
  }
  if (typeof ref.path === 'string' && ref.path !== '') {
    try {
      return await readFile(ref.path)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Stage up to `maxItems` (or `maxImages`) attachments (images, PDF, audio,
 * video) into `dir`, returning prompt lines that reference them by absolute path.
 */
export async function stageMedia(opts: {
  dir: string
  key: string
  items: readonly MediaRefLike[]
  readMedia?: MediaReader
  maxItems?: number
  maxImageBytes: number
  maxFileBytes: number
}): Promise<StageResult> {
  const staged: StagedImage[] = []
  const stagedIds: string[] = []
  const lines: string[] = []
  let skipped = 0
  const budget = Math.max(0, opts.maxItems ?? 8)
  if (budget > 0 && opts.items.length > 0) {
    await mkdir(opts.dir, { recursive: true })
    for (const ref of opts.items) {
      if (staged.length >= budget) {
        skipped += opts.items.length - staged.length - skipped
        break
      }
      const normType = normalizeMediaType(ref.mediaType)
      const kind = mediaKindFor(normType)
      const label = ref.name ?? ref.attachmentId
      if (kind === null) {
        skipped++
        lines.push('[attachment skipped: "' + label + '" unsupported type ' + ref.mediaType + ']')
        continue
      }
      const cap = kind === 'image' ? opts.maxImageBytes : opts.maxFileBytes
      const capLabel = kind === 'image' ? 'mediaMaxBytes' : 'mediaMaxFileBytes'
      if (typeof ref.bytes === 'number' && ref.bytes > cap) {
        skipped++
        lines.push('[' + kind + ' skipped: "' + label + '" exceeds ' + capLabel + ']')
        continue
      }
      const data = await resolveMediaBytes(ref, opts.readMedia)
      if (!data) {
        skipped++
        lines.push('[' + kind + ' unavailable: "' + label + '" could not be read from attachment storage]')
        continue
      }
      if (data.byteLength > cap) {
        skipped++
        lines.push('[' + kind + ' skipped: "' + label + '" exceeds ' + capLabel + ']')
        continue
      }
      const path = stagedPath(opts.dir, opts.key, ref.attachmentId, normType)
      await writeFile(path, data)
      const w = ref.width ?? 0
      const h = ref.height ?? 0
      const bytes = ref.bytes ?? data.byteLength
      staged.push({ path, name: label, width: w, height: h, bytes, attachmentId: ref.attachmentId, kind, mediaType: normType })
      stagedIds.push(ref.attachmentId)
      if (kind === 'image') {
        lines.push('[image attached: "' + label + '" — staged at ' + path + ' (' + w + 'x' + h + ', ' + bytes + ' bytes). Inspect it using the view_file tool with AbsolutePath: "' + path + '"]')
      } else {
        lines.push('[' + kind + ' attached: "' + label + '" (' + normType + ', ' + bytes + ' bytes) — staged at ' + path + '. Inspect it using read_file with Path: "' + path + '"]')
      }
    }
  }
  return { promptSuffix: lines.join('\n'), staged, stagedIds, skipped }
}

/**
 * Stage up to `maxImages` images into `dir`, returning prompt lines that
 * reference them by absolute path.
 */
export async function stageImages(opts: {
  dir: string
  key: string
  images: readonly ImageRefLike[]
  readImage: ImageReader
  maxImages: number
  maxBytes: number
}): Promise<StageResult> {
  return stageMedia({
    dir: opts.dir,
    key: opts.key,
    items: opts.images,
    readMedia: (r) => opts.readImage(r as ImageRefLike),
    maxItems: opts.maxImages,
    maxImageBytes: opts.maxBytes,
    maxFileBytes: opts.maxBytes,
  })
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
