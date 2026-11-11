// Artifact discovery (explicit reply paths, then the agy "brain" directory),
// magic-byte/dimension sniffing, validation and copying. Moved verbatim out of
// src/host/image.ts.
import { open, copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  IMAGE_EXTENSIONS,
  type ImageAgentResult,
  type ImageFailureCode,
  type ImageInfo,
} from './types.ts'
import { extractImagePaths, parseImageReply } from './prompt.ts'

/** How many bytes of a file are enough to identify the format and dimensions. */
const HEADER_BYTES = 512 * 1024

// ---------------------------------------------------------------------------
// Image sniffing (no dependency: magic bytes + a few header formats)
// ---------------------------------------------------------------------------

function u16be(b: Buffer, o: number): number {
  return b.readUInt16BE(o)
}
function u16le(b: Buffer, o: number): number {
  return b.readUInt16LE(o)
}
function u24le(b: Buffer, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)
}
function u32be(b: Buffer, o: number): number {
  return b.readUInt32BE(o)
}

/** Identify an image from its header bytes. Null = not a supported image. */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png', width: u32be(buf, 16), height: u32be(buf, 20) }
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mime: 'image/gif', ext: '.gif', width: u16le(buf, 6), height: u16le(buf, 8) }
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { mime: 'image/webp', ext: '.webp', width: u24le(buf, 24) + 1, height: u24le(buf, 27) + 1 }
    }
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21)
      return { mime: 'image/webp', ext: '.webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { mime: 'image/webp', ext: '.webp', width: u16le(buf, 26) & 0x3fff, height: u16le(buf, 28) & 0x3fff }
    }
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: 'image/bmp', ext: '.bmp', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  }
  // JPEG: walk the marker chain until a Start-Of-Frame segment (SOF0..SOF15
  // except DHT/JPG/DAC) which carries the dimensions.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = u16be(buf, i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: 'image/jpeg', ext: '.jpg', width: u16be(buf, i + 7), height: u16be(buf, i + 5) }
      }
      if (len < 2) break
      i += 2 + len
    }
  }
  return null
}

/** Read just enough of a file to identify it, then sniff. */
export async function readImageInfo(path: string): Promise<ImageInfo | null> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0)
    return sniffImage(buf.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
}

function ratioValue(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number)
  return (w ?? 1) / (h ?? 1)
}

/** Requested aspect ratio is satisfied within 3% (agy rounds to its own grid). */
export function aspectMatches(width: number, height: number, requested: string | undefined): boolean {
  if (requested === undefined || requested === '' || width <= 0 || height <= 0) return true
  const want = ratioValue(requested)
  const got = width / height
  return Math.abs(got - want) / want <= 0.03
}

export interface ValidatedImage extends ImageInfo {
  path: string
  bytes: number
}

/** Brain directory for a run, derived from the HOME that run actually used. */
export function artifactDir(res: ImageAgentResult): string | undefined {
  if (res.conversationId === undefined || res.conversationId === '') return undefined
  const home = res.home ?? process.env.HOME ?? homedir()
  return join(home, '.gemini', 'antigravity-cli', 'brain', res.conversationId)
}

  /** Locate candidate artifacts: explicit paths first, then fresh files on disk. */
export async function candidateArtifacts(res: ImageAgentResult, since: number): Promise<string[]> {
    const ordered: string[] = []
    const seen = new Set<string>()
    const push = (p: string): void => {
      const abs = isAbsolute(p) ? p : resolvePath(p)
      if (seen.has(abs)) return
      seen.add(abs)
      ordered.push(abs)
    }
    const reply = parseImageReply(res.text)
    if (reply.path !== undefined) push(reply.path)
    for (const p of extractImagePaths(res.text)) push(p)
    for (const call of res.toolCalls) {
      if (call.output !== undefined) for (const p of extractImagePaths(call.output)) push(p)
    }
    const dir = artifactDir(res)
    if (dir !== undefined && existsSync(dir)) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const fresh: Array<{ path: string; mtime: number }> = []
        for (const e of entries) {
          if (!e.isFile()) continue
          const ext = extname(e.name).toLowerCase()
          if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) continue
          const abs = join(dir, e.name)
          const st = await stat(abs)
          if (st.mtimeMs < since - 2_000) continue
          fresh.push({ path: abs, mtime: st.mtimeMs })
        }
        fresh.sort((a, b) => b.mtime - a.mtime)
        for (const f of fresh) push(f.path)
      } catch {
        // A missing/unreadable brain dir is not fatal: explicit paths still work.
      }
    }
    return ordered
  }

export async function validateArtifact(
  path: string,
  maxBytes: number,
  requestedRatio: string | undefined,
): Promise<{ ok: true; image: ValidatedImage } | { ok: false; code: ImageFailureCode; error: string }> {
    let st
    try {
      st = await stat(path)
    } catch {
      return { ok: false, code: 'IMAGE_NOT_FOUND', error: 'artifact does not exist: ' + path }
    }
    if (!st.isFile()) return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is not a regular file: ' + path }
    if (st.size === 0) return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is empty: ' + path }
    if (st.size > maxBytes) {
      return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is larger than ' + maxBytes + ' bytes: ' + st.size }
    }
    const info = await readImageInfo(path)
    if (info === null) return { ok: false, code: 'IMAGE_INVALID', error: 'artifact is not a supported image (png/jpeg/webp/gif/bmp): ' + path }
    if (info.width <= 0 || info.height <= 0) {
      return { ok: false, code: 'IMAGE_INVALID', error: 'could not read image dimensions: ' + path }
    }
    if (!aspectMatches(info.width, info.height, requestedRatio)) {
      return {
        ok: false,
        code: 'IMAGE_ASPECT_MISMATCH',
        error: 'expected aspect ratio ' + String(requestedRatio) + ', got ' + info.width + 'x' + info.height,
      }
    }
    return { ok: true, image: { ...info, path, bytes: st.size } }
  }

export async function copyArtifact(source: string, outPath: string): Promise<string> {
    const abs = isAbsolute(outPath) ? outPath : resolvePath(outPath)
    let target = abs
    try {
      const st = await stat(abs)
      if (st.isDirectory()) target = join(abs, basename(source))
    } catch {
      // Not an existing path: treat it as the target file name.
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return target
  }

/** `1024x1024` → `1:1` when the numbers simplify cleanly, else `w:h`. */
export function simplifyRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const d = gcd(width, height)
  if (d <= 0) return width + ':' + height
  return width / d + ':' + height / d
}
