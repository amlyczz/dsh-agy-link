// Browser-compatible video/image preparation and bounded disk cache using FFmpeg/FFprobe.
//
// Why this exists: browsers reject many valid local recordings — MP4s encoded
// with `yuvj420p`/`yuv444p`/10-bit pixel formats (common from OpenCV, Python,
// FFmpeg defaults), non-faststart MP4s with `moov` at EOF, HEVC/MPEG-4/AVI/MOV
// containers, or TIFF/HEIC images. We inspect metadata with `ffprobe` (cached
// per file+size+mtime), pass standard H.264/yuv420p+faststart MP4 and WebM
// through with zero overhead, losslessly remux container/moov mismatches, and
// transcode incompatible encodings into a bounded disk cache on demand.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'

export type VideoCompatPlan = 'passthrough' | 'remux' | 'transcode'

export interface ProbeVideoSummary {
  videoCodec: string
  pixFmt: string
  audioCodec: string
  faststart: boolean
}

export interface MediaTranscodeDeps {
  findBinaries?: () => { ffmpeg: string | null; ffprobe: string | null }
  runProbe?: (ffprobeBin: string, filePath: string) => Promise<ProbeVideoSummary | null>
  runFfmpeg?: (ffmpegBin: string, args: readonly string[], timeoutMs: number) => Promise<{ ok: boolean; stderr: string }>
}

export interface PreparedMedia {
  filePath: string
  contentType: string
  size: number
  mtimeMs: number
  transcoded: boolean
  mode: 'original' | 'remux' | 'transcode' | 'image-compat' | 'fallback'
  cacheTag?: string
}

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv', '.avi', '.flv', '.wmv'])
const IMAGE_COMPAT_EXTS = new Set(['.tif', '.tiff', '.heic', '.heif'])
const BROWSER_COMPAT_MP4_AUDIO = new Set(['', 'aac', 'mp3', 'opus'])
const BROWSER_COMPAT_WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1'])
const BROWSER_COMPAT_WEBM_AUDIO = new Set(['', 'opus', 'vorbis'])

const MAX_PROBE_CACHE = 512
const DEFAULT_TRANSCODE_TIMEOUT_MS = 120_000
const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 3_600_000

const probeCache = new Map<string, ProbeVideoSummary | null>()
const inFlightJobs = new Map<string, Promise<PreparedMedia | null>>()
let cachedBins: { ffmpeg: string | null; ffprobe: string | null } | null = null

export function isTranscodableVideoExt(ext: string): boolean {
  return VIDEO_EXTS.has(ext.toLowerCase())
}

export function isCompatImageExt(ext: string): boolean {
  return IMAGE_COMPAT_EXTS.has(ext.toLowerCase())
}

function testExecutable(cmd: string): boolean {
  try {
    const res = spawnSync(cmd, ['-version'], { timeout: 3000, windowsHide: true, stdio: 'ignore' })
    return res.status === 0
  } catch {
    return false
  }
}

function findWinGetFfmpegBinary(name: 'ffmpeg.exe' | 'ffprobe.exe'): string | null {
  if (process.platform !== 'win32') return null
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const pkgRoot = join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    try {
      if (existsSync(pkgRoot)) {
        for (const pkg of readdirSync(pkgRoot)) {
          if (!/ffmpeg/i.test(pkg)) continue
          const pkgDir = join(pkgRoot, pkg)
          const direct = join(pkgDir, 'bin', name)
          if (existsSync(direct)) return direct
          for (const sub of readdirSync(pkgDir)) {
            const nested = join(pkgDir, sub, 'bin', name)
            if (existsSync(nested)) return nested
          }
        }
      }
    } catch {
      // ignore WinGet scan errors
    }
  }
  const fallback = join('C:\\ffmpeg\\bin', name)
  return existsSync(fallback) ? fallback : null
}

export function findFfmpegBinaries(): { ffmpeg: string | null; ffprobe: string | null } {
  if (cachedBins !== null) return cachedBins
  const ffmpeg = testExecutable('ffmpeg')
    ? 'ffmpeg'
    : (process.platform === 'win32' ? findWinGetFfmpegBinary('ffmpeg.exe') : null)
  const ffprobe = testExecutable('ffprobe')
    ? 'ffprobe'
    : (process.platform === 'win32' ? findWinGetFfmpegBinary('ffprobe.exe') : null)
  cachedBins = { ffmpeg, ffprobe }
  return cachedBins
}

/**
 * Inspect top-level ISO BMFF (MP4/MOV) boxes to verify whether `moov` appears
 * before `mdat` (faststart). Reads only 8/16-byte box headers.
 */
export function inspectMp4Faststart(filePath: string): boolean {
  let fd: number | null = null
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size < 16) return true
    fd = openSync(filePath, 'r')
    const header = Buffer.allocUnsafe(16)
    let offset = 0
    let seenMdat = false
    for (let i = 0; i < 64 && offset + 8 <= st.size; i++) {
      const read = readSync(fd, header, 0, Math.min(16, st.size - offset), offset)
      if (read < 8) break
      let boxSize = header.readUInt32BE(0)
      const boxType = header.toString('ascii', 4, 8)
      if (boxSize === 1) {
        if (read < 16) break
        const hi = header.readUInt32BE(8)
        const lo = header.readUInt32BE(12)
        boxSize = hi * 0x100000000 + lo
      } else if (boxSize === 0) {
        boxSize = st.size - offset
      }
      if (boxType === 'moov') return !seenMdat
      if (boxType === 'mdat') seenMdat = true
      if (boxSize < 8) break
      offset += boxSize
    }
    return !seenMdat
  } catch {
    return true
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** Classify whether a probed video can pass through, losslessly remux, or must transcode. */
export function classifyVideoCompat(ext: string, probe: ProbeVideoSummary | null, forceCompat: boolean): VideoCompatPlan {
  if (forceCompat) return 'transcode'
  const lower = ext.toLowerCase()
  if (probe === null) {
    // Without probe metadata, trust native MP4/WebM/OGV and transcode exotic containers.
    return lower === '.mp4' || lower === '.webm' || lower === '.ogv' ? 'passthrough' : 'transcode'
  }
  const vCodec = probe.videoCodec.toLowerCase()
  const pixFmt = probe.pixFmt.toLowerCase()
  const aCodec = probe.audioCodec.toLowerCase()

  if (lower === '.webm') {
    if (BROWSER_COMPAT_WEBM_VIDEO.has(vCodec) && pixFmt === 'yuv420p' && BROWSER_COMPAT_WEBM_AUDIO.has(aCodec)) {
      return 'passthrough'
    }
    return 'transcode'
  }

  const h264Safe = vCodec === 'h264' && pixFmt === 'yuv420p'
  const audioMp4Safe = BROWSER_COMPAT_MP4_AUDIO.has(aCodec)
  if (h264Safe && audioMp4Safe) {
    if ((lower === '.mp4' || lower === '.m4v') && probe.faststart) return 'passthrough'
    return 'remux'
  }
  return 'transcode'
}

function defaultRunProbe(ffprobeBin: string, filePath: string): Promise<ProbeVideoSummary | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (value: ProbeVideoSummary | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(
        ffprobeBin,
        ['-v', 'error', '-print_format', 'json', '-show_streams', filePath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      done(null)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      done(null)
    }, 10_000)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 256_000) stdout += chunk.toString('utf8')
    })
    child.on('error', () => { clearTimeout(timer); done(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || stdout.trim() === '') {
        done(null)
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string }> }
        const streams = Array.isArray(parsed.streams) ? parsed.streams : []
        const video = streams.find((s) => s.codec_type === 'video')
        const audio = streams.find((s) => s.codec_type === 'audio')
        if (!video) {
          done(null)
          return
        }
        done({
          videoCodec: String(video.codec_name ?? ''),
          pixFmt: String(video.pix_fmt ?? ''),
          audioCodec: String(audio?.codec_name ?? ''),
          faststart: inspectMp4Faststart(filePath),
        })
      } catch {
        done(null)
      }
    })
  })
}

function defaultRunFfmpeg(
  ffmpegBin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve({ ok, stderr })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(ffmpegBin, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      stderr = String(err)
      done(false)
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      stderr += '\nffmpeg timed out'
      done(false)
    }, timeoutMs)
    timer.unref?.()
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      stderr += '\n' + String(err)
      done(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0)
    })
  })
}

function setProbeCache(key: string, value: ProbeVideoSummary | null): void {
  if (probeCache.size >= MAX_PROBE_CACHE) {
    const oldest = probeCache.keys().next().value
    if (oldest !== undefined) probeCache.delete(oldest)
  }
  probeCache.set(key, value)
}

export function clearMediaTranscodeCachesForTest(): void {
  probeCache.clear()
  inFlightJobs.clear()
  cachedBins = null
}

/**
 * Prepare a browser-playable copy of a video or compat-needing image when
 * needed. Original files that are already browser-compatible pass straight
 * through with zero transcode latency.
 */
export async function prepareCompatibleMedia(opts: {
  filePath: string
  ext: string
  contentType: string
  size: number
  mtimeMs: number
  cacheDir: string
  forceCompat?: boolean
  raw?: boolean
  deps?: MediaTranscodeDeps
}): Promise<PreparedMedia> {
  const { filePath, ext, contentType, size, mtimeMs, cacheDir, forceCompat = false, raw = false, deps } = opts
  const original: PreparedMedia = {
    filePath,
    contentType,
    size,
    mtimeMs,
    transcoded: false,
    mode: 'original',
  }
  if (raw) return original

  const isVideo = isTranscodableVideoExt(ext)
  const isImageCompat = isCompatImageExt(ext)
  if (!isVideo && !isImageCompat) return original

  const bins = (deps?.findBinaries ?? findFfmpegBinaries)()
  if (!bins.ffmpeg) return original

  let targetExt: '.mp4' | '.png'
  let targetMime: string
  let mode: 'remux' | 'transcode' | 'image-compat'

  if (isImageCompat) {
    targetExt = '.png'
    targetMime = 'image/png'
    mode = 'image-compat'
  } else {
    const probeKey = `${filePath}|${size}|${Math.floor(mtimeMs)}`
    let probe: ProbeVideoSummary | null
    if (forceCompat) {
      probe = null
    } else if (probeCache.has(probeKey)) {
      probe = probeCache.get(probeKey) ?? null
    } else {
      probe = bins.ffprobe ? await (deps?.runProbe ?? defaultRunProbe)(bins.ffprobe, filePath) : null
      setProbeCache(probeKey, probe)
    }
    const plan = classifyVideoCompat(ext, probe, forceCompat)
    if (plan === 'passthrough') return original
    targetExt = '.mp4'
    targetMime = 'video/mp4'
    mode = plan
  }

  const hash = createHash('sha256')
    .update(`${filePath}|${size}|${Math.floor(mtimeMs)}|${mode}|v1`)
    .digest('hex')
    .slice(0, 24)
  const outPath = join(cacheDir, `${hash}${targetExt}`)

  if (existsSync(outPath)) {
    try {
      const st = statSync(outPath)
      if (st.isFile() && st.size > 0) {
        try {
          const now = new Date()
          utimesSync(outPath, now, now)
        } catch { /* ignore touch error */ }
        return {
          filePath: outPath,
          contentType: targetMime,
          size: st.size,
          mtimeMs: st.mtimeMs,
          transcoded: true,
          mode,
          cacheTag: hash.slice(0, 10),
        }
      }
    } catch { /* re-generate below */ }
  }

  let job = inFlightJobs.get(hash)
  if (!job) {
    job = (async (): Promise<PreparedMedia | null> => {
      mkdirSync(cacheDir, { recursive: true })
      const tmpPath = join(cacheDir, `.${hash}.${process.pid}.${Date.now()}.tmp${targetExt}`)
      const args: string[] = mode === 'image-compat'
        ? ['-y', '-v', 'error', '-i', filePath, '-frames:v', '1', tmpPath]
        : mode === 'remux'
          ? ['-y', '-v', 'error', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmpPath]
          : [
              '-y', '-v', 'error', '-i', filePath,
              '-map', '0:v:0', '-map', '0:a:0?',
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
              '-pix_fmt', 'yuv420p', '-color_range', 'tv',
              '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
              '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
              '-movflags', '+faststart', '-f', 'mp4', tmpPath,
            ]
      const run = await (deps?.runFfmpeg ?? defaultRunFfmpeg)(bins.ffmpeg!, args, DEFAULT_TRANSCODE_TIMEOUT_MS)
      if (!run.ok || !existsSync(tmpPath)) {
        try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
        return null
      }
      try {
        const tmpStat = statSync(tmpPath)
        if (!tmpStat.isFile() || tmpStat.size <= 0) {
          rmSync(tmpPath, { force: true })
          return null
        }
        try {
          renameSync(tmpPath, outPath)
        } catch {
          // Another process may have materialized the same content-addressed file.
          if (!existsSync(outPath)) throw new Error('rename failed')
          try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
        }
        const finalStat = statSync(outPath)
        return {
          filePath: outPath,
          contentType: targetMime,
          size: finalStat.size,
          mtimeMs: finalStat.mtimeMs,
          transcoded: true,
          mode,
          cacheTag: hash.slice(0, 10),
        }
      } catch {
        try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
        return null
      }
    })().finally(() => {
      if (inFlightJobs.get(hash) === job) inFlightJobs.delete(hash)
    })
    inFlightJobs.set(hash, job)
  }

  const ready = await job
  if (ready !== null) return ready
  return { ...original, mode: 'fallback' }
}

/** Evict stale and oldest transcoded media files to keep disk usage bounded. */
export async function sweepMediaCache(
  cacheDir: string,
  maxBytes = DEFAULT_CACHE_MAX_BYTES,
  ttlMs = DEFAULT_CACHE_TTL_MS,
): Promise<number> {
  if (!existsSync(cacheDir)) return 0
  let removed = 0
  const now = Date.now()
  const entries: Array<{ path: string; size: number; mtimeMs: number }> = []
  try {
    for (const name of readdirSync(cacheDir)) {
      const full = join(cacheDir, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        const isOrphanTmp = name.startsWith('.') && now - st.mtimeMs > 10 * 60_000
        if (isOrphanTmp || (ttlMs > 0 && now - st.mtimeMs > ttlMs)) {
          rmSync(full, { force: true })
          removed++
          continue
        }
        entries.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        // ignore race
      }
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0)
    if (maxBytes > 0 && total > maxBytes) {
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const ent of entries) {
        if (total <= maxBytes) break
        try {
          rmSync(ent.path, { force: true })
          total -= ent.size
          removed++
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore sweep errors
  }
  return removed
}
