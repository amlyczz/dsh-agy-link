import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, utimesSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  authorizePluginRequest,
  isRemoteOpenBlocked,
  parseByteRange,
} from '../../src/host/media-http.ts'
import {
  handleMediaRequest,
  handleMediaRequestAsync,
  handleOpenFile,
} from '../../src/host/media-route.ts'
import {
  classifyVideoCompat,
  findFfmpegBinaries,
  inspectMp4Faststart,
  prepareCompatibleMedia,
  sweepMediaCache,
  type MediaTranscodeDeps,
  type ProbeVideoSummary,
} from '../../src/host/media-transcode.ts'

interface CapturedRes {
  status: number
  headers: Record<string, unknown>
  chunks: Buffer[]
  ended: boolean
  res: EventEmitter & {
    headersSent: boolean
    writeHead: (s: number, h?: Record<string, unknown>) => void
    write: (chunk: Buffer | string) => boolean
    end: (chunk?: Buffer | string) => void
  }
  done: Promise<void>
}

function makeMockRes(): CapturedRes {
  const ee = new EventEmitter() as CapturedRes['res']
  let resolveDone!: () => void
  const done = new Promise<void>((r) => { resolveDone = r })
  const cap: CapturedRes = {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    res: ee,
    done,
  }
  ee.headersSent = false
  ee.writeHead = (s: number, h?: Record<string, unknown>) => {
    cap.status = s
    cap.headers = h ?? {}
    ee.headersSent = true
  }
  ee.write = (chunk: Buffer | string) => {
    cap.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }
  ee.end = (chunk?: Buffer | string) => {
    if (chunk !== undefined) {
      cap.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    cap.ended = true
    ee.emit('finish')
    resolveDone()
  }
  return cap
}

function makeIsoBox(type: string, payloadSize: number): Buffer {
  const size = 8 + payloadSize
  const buf = Buffer.alloc(size)
  buf.writeUInt32BE(size, 0)
  buf.write(type, 4, 4, 'ascii')
  return buf
}

test('media-http: authorizePluginRequest delegates to DSH connection trust and supports same-origin fallback', () => {
  // Delegated DSH connection service allows authenticated Cloudflare Tunnel browser
  const allowConn = { requestRejection: () => undefined }
  assert.equal(
    authorizePluginRequest(
      { headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'cf-connecting-ip': '1.2.3.4' } },
      allowConn,
    ),
    undefined,
  )

  // Delegated DSH connection service rejects unauthenticated or untrusted requests with 401/403
  assert.equal(
    authorizePluginRequest({ headers: { origin: 'https://dsh.example.com' } }, {
      requestRejection: () => 401,
    }),
    401,
  )
  assert.equal(
    authorizePluginRequest({ headers: { origin: 'https://evil.example' } }, {
      requestRejection: () => 403,
    }),
    403,
  )

  // Fallback without connection service allows matching Host / X-Forwarded-Host same-origin
  assert.equal(
    authorizePluginRequest({ headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com' } }),
    undefined,
  )
  assert.equal(
    authorizePluginRequest({
      headers: { origin: 'https://dsh.example.com', host: '127.0.0.1:3000', 'x-forwarded-host': 'dsh.example.com' },
    }),
    undefined,
  )
  // Fallback still rejects cross-site, null, and file:// origins
  assert.equal(
    authorizePluginRequest({ headers: { origin: 'https://evil.example', host: 'dsh.example.com' } }),
    403,
  )
  assert.equal(authorizePluginRequest({ headers: { origin: 'null' } }), 403)
  assert.equal(authorizePluginRequest({ headers: { origin: 'file:///tmp/x.html' } }), 403)
})

test('media-http: isRemoteOpenBlocked & handleOpenFile refuse Cloudflare / remote browser launches', () => {
  assert.equal(isRemoteOpenBlocked({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } }), false)
  assert.equal(isRemoteOpenBlocked({ headers: { origin: 'dsh-app://desktop', host: 'localhost:3000' } }), false)
  assert.equal(isRemoteOpenBlocked({ headers: { 'cf-connecting-ip': '203.0.113.1', host: '127.0.0.1:3000' } }), true)
  assert.equal(isRemoteOpenBlocked({ headers: { 'cf-ray': '8abc123', host: 'localhost:3000' } }), true)
  assert.equal(isRemoteOpenBlocked({ headers: { 'x-forwarded-host': 'dsh.example.com' } }), true)
  assert.equal(isRemoteOpenBlocked({ headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com' } }), true)
  assert.equal(isRemoteOpenBlocked({ headers: { host: '192.168.1.50:3000' } }), true)

  const root = mkdtempSync(join(tmpdir(), 'agy-remote-open-'))
  const doc = join(root, 'note.md')
  writeFileSync(doc, '# hello')
  try {
    const cap = makeMockRes()
    handleOpenFile(
      {
        method: 'POST',
        url: `/plugins/agy-link/open?path=${encodeURIComponent(doc)}`,
        headers: { origin: 'https://dsh.example.com', host: 'dsh.example.com', 'cf-connecting-ip': '203.0.113.9' },
      },
      cap.res as never,
      { workspaceRoots: [root], connection: { requestRejection: () => undefined } },
    )
    assert.equal(cap.status, 403)
    assert.match(Buffer.concat(cap.chunks).toString('utf8'), /remote browser/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('media-http: RFC 9110 Range (suffix, open-ended, clamping, 416), HEAD, ETag/304, and ?download=1', async () => {
  assert.deepEqual(parseByteRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseByteRange('bytes=-500', 100), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=50-9999', 100), { start: 50, end: 99 })
  assert.equal(parseByteRange('bytes=100-110', 100), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=20-10', 100), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=-0', 100), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=0-0', 0), 'unsatisfiable')

  const root = mkdtempSync(join(tmpdir(), 'agy-range-'))
  const sample = join(root, 'clip.mp4')
  const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')
  writeFileSync(sample, payload)

  try {
    // 1. HEAD returns metadata with empty body
    const headCap = makeMockRes()
    handleMediaRequest(
      { method: 'HEAD', url: `/plugins/agy-link/media?path=${encodeURIComponent(sample)}` },
      headCap.res as never,
      { workspaceRoots: [root] },
    )
    await headCap.done
    assert.equal(headCap.status, 200)
    assert.equal(headCap.headers['Content-Length'], payload.length)
    assert.equal(headCap.headers['Accept-Ranges'], 'bytes')
    assert.ok(typeof headCap.headers['ETag'] === 'string' && String(headCap.headers['ETag']).length > 0)
    assert.equal(Buffer.concat(headCap.chunks).length, 0)

    // 2. If-None-Match matching ETag returns 304 Not Modified
    const notModCap = makeMockRes()
    handleMediaRequest(
      {
        method: 'GET',
        url: `/plugins/agy-link/media?path=${encodeURIComponent(sample)}`,
        headers: { 'if-none-match': String(headCap.headers['ETag']) },
      },
      notModCap.res as never,
      { workspaceRoots: [root] },
    )
    await notModCap.done
    assert.equal(notModCap.status, 304)

    // 3. Suffix range bytes=-10 returns exact last 10 bytes
    const suffixCap = makeMockRes()
    handleMediaRequest(
      {
        method: 'GET',
        url: `/plugins/agy-link/media?path=${encodeURIComponent(sample)}`,
        headers: { range: 'bytes=-10' },
      },
      suffixCap.res as never,
      { workspaceRoots: [root] },
    )
    await suffixCap.done
    assert.equal(suffixCap.status, 206)
    assert.equal(suffixCap.headers['Content-Range'], `bytes ${payload.length - 10}-${payload.length - 1}/${payload.length}`)
    assert.equal(Buffer.concat(suffixCap.chunks).toString('utf8'), payload.subarray(-10).toString('utf8'))

    // 4. Unsatisfiable range returns 416 with Content-Range: bytes */total
    const badRangeCap = makeMockRes()
    handleMediaRequest(
      {
        method: 'GET',
        url: `/plugins/agy-link/media?path=${encodeURIComponent(sample)}`,
        headers: { range: 'bytes=9999-10000' },
      },
      badRangeCap.res as never,
      { workspaceRoots: [root] },
    )
    await badRangeCap.done
    assert.equal(badRangeCap.status, 416)
    assert.equal(badRangeCap.headers['Content-Range'], `bytes */${payload.length}`)

    // 5. ?download=1 adds Content-Disposition: attachment
    const dlCap = makeMockRes()
    handleMediaRequest(
      {
        method: 'GET',
        url: `/plugins/agy-link/media?path=${encodeURIComponent(sample)}&download=1`,
      },
      dlCap.res as never,
      { workspaceRoots: [root] },
    )
    await dlCap.done
    assert.equal(dlCap.status, 200)
    assert.match(String(dlCap.headers['Content-Disposition']), /^attachment; filename="clip\.mp4"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('media-transcode: inspectMp4Faststart & classifyVideoCompat cover passthrough, remux, and transcode', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-moov-'))
  try {
    const fastMp4 = join(root, 'fast.mp4')
    writeFileSync(fastMp4, Buffer.concat([makeIsoBox('ftyp', 12), makeIsoBox('moov', 20), makeIsoBox('mdat', 64)]))
    assert.equal(inspectMp4Faststart(fastMp4), true)

    const slowMp4 = join(root, 'slow.mp4')
    writeFileSync(slowMp4, Buffer.concat([makeIsoBox('ftyp', 12), makeIsoBox('mdat', 64), makeIsoBox('moov', 20)]))
    assert.equal(inspectMp4Faststart(slowMp4), false)

    // Standard H.264/yuv420p/aac faststart MP4 -> passthrough
    assert.equal(
      classifyVideoCompat('.mp4', { videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', faststart: true }, false),
      'passthrough',
    )
    // Non-faststart H.264 MP4 or .mov -> lossless remux
    assert.equal(
      classifyVideoCompat('.mp4', { videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', faststart: false }, false),
      'remux',
    )
    assert.equal(
      classifyVideoCompat('.mov', { videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', faststart: true }, false),
      'remux',
    )
    // Incompatible pixel format / codec / container -> transcode
    assert.equal(
      classifyVideoCompat('.mp4', { videoCodec: 'h264', pixFmt: 'yuvj420p', audioCodec: '', faststart: true }, false),
      'transcode',
    )
    assert.equal(
      classifyVideoCompat('.mp4', { videoCodec: 'h264', pixFmt: 'yuv444p', audioCodec: 'aac', faststart: true }, false),
      'transcode',
    )
    assert.equal(
      classifyVideoCompat('.mp4', { videoCodec: 'hevc', pixFmt: 'yuv420p', audioCodec: 'aac', faststart: true }, false),
      'transcode',
    )
    assert.equal(
      classifyVideoCompat('.avi', { videoCodec: 'mpeg4', pixFmt: 'yuv420p', audioCodec: 'mp3', faststart: true }, false),
      'transcode',
    )
    // Explicit forceCompat always transcodes
    assert.equal(
      classifyVideoCompat('.mp4', { videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', faststart: true }, true),
      'transcode',
    )
    // WebM VP9+Opus passes through
    assert.equal(
      classifyVideoCompat('.webm', { videoCodec: 'vp9', pixFmt: 'yuv420p', audioCodec: 'opus', faststart: true }, false),
      'passthrough',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('media-transcode: prepareCompatibleMedia caches, deduplicates in-flight jobs, respects ?raw=1, and sweeps cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-transcode-unit-'))
  const cacheDir = join(root, 'cache')
  const srcVideo = join(root, 'opencv_yuvj.mp4')
  writeFileSync(srcVideo, Buffer.from('RAW_OPENCV_VIDEO_BYTES'))

  try {
    let ffmpegCalls = 0
    const mockProbe: ProbeVideoSummary = {
      videoCodec: 'h264',
      pixFmt: 'yuvj420p',
      audioCodec: '',
      faststart: false,
    }
    const deps: MediaTranscodeDeps = {
      findBinaries: () => ({ ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' }),
      runProbe: async () => mockProbe,
      runFfmpeg: async (_bin, args) => {
        ffmpegCalls++
        const outFile = args[args.length - 1]!
        await new Promise((r) => setTimeout(r, 25))
        writeFileSync(outFile, Buffer.from('COMPAT_H264_YUV420P_MP4'))
        return { ok: true, stderr: '' }
      },
    }

    const srcStat = statSync(srcVideo)
    // Concurrent calls deduplicate into ONE ffmpeg invocation
    const [a, b] = await Promise.all([
      prepareCompatibleMedia({ filePath: srcVideo, ext: '.mp4', contentType: 'video/mp4', size: srcStat.size, mtimeMs: srcStat.mtimeMs, cacheDir, deps }),
      prepareCompatibleMedia({ filePath: srcVideo, ext: '.mp4', contentType: 'video/mp4', size: srcStat.size, mtimeMs: srcStat.mtimeMs, cacheDir, deps }),
    ])
    assert.equal(ffmpegCalls, 1, 'concurrent transcode requests must share one in-flight job')
    assert.equal(a.transcoded, true)
    assert.equal(a.mode, 'transcode')
    assert.equal(a.filePath, b.filePath)
    assert.ok(existsSync(a.filePath))

    // Subsequent call hits disk cache with zero new ffmpeg calls
    const c = await prepareCompatibleMedia({ filePath: srcVideo, ext: '.mp4', contentType: 'video/mp4', size: srcStat.size, mtimeMs: srcStat.mtimeMs, cacheDir, deps })
    assert.equal(ffmpegCalls, 1, 'cached artifact must be reused without invoking ffmpeg again')
    assert.equal(c.filePath, a.filePath)

    // handleMediaRequestAsync serves raw source when ?raw=1 is passed (never invokes transcode)
    const rawCap = makeMockRes()
    await handleMediaRequestAsync(
      { method: 'GET', url: `/plugins/agy-link/media?path=${encodeURIComponent(srcVideo)}&raw=1` },
      rawCap.res as never,
      { workspaceRoots: [root], cacheDir, transcodeDeps: deps },
    )
    await rawCap.done
    assert.equal(rawCap.status, 200)
    assert.equal(Buffer.concat(rawCap.chunks).toString('utf8'), 'RAW_OPENCV_VIDEO_BYTES')

    // handleMediaRequestAsync serves transcoded cache by default with X-Agy-Media-Compat header
    const compatCap = makeMockRes()
    await handleMediaRequestAsync(
      { method: 'GET', url: `/plugins/agy-link/media?path=${encodeURIComponent(srcVideo)}` },
      compatCap.res as never,
      { workspaceRoots: [root], cacheDir, transcodeDeps: deps },
    )
    await compatCap.done
    assert.equal(compatCap.status, 200)
    assert.equal(compatCap.headers['X-Agy-Media-Compat'], 'transcode')
    assert.equal(Buffer.concat(compatCap.chunks).toString('utf8'), 'COMPAT_H264_YUV420P_MP4')

    // sweepMediaCache evicts expired and over-quota entries
    const oldFile = join(cacheDir, 'stale.mp4')
    const newerFile = join(cacheDir, 'recent.mp4')
    writeFileSync(oldFile, Buffer.alloc(64, 1))
    writeFileSync(newerFile, Buffer.alloc(64, 2))
    const oldDate = new Date(Date.now() - 10 * 24 * 3_600_000)
    utimesSync(oldFile, oldDate, oldDate)
    const removedTtl = await sweepMediaCache(cacheDir, 1024 * 1024, 24 * 3_600_000)
    assert.equal(removedTtl, 1)
    assert.equal(existsSync(oldFile), false)
    assert.equal(existsSync(newerFile), true)

    const removedQuota = await sweepMediaCache(cacheDir, 32, 7 * 24 * 3_600_000)
    assert.ok(removedQuota >= 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('media-transcode: real FFmpeg smoke test converts yuvj420p non-faststart MP4 into yuv420p faststart MP4', async (t) => {
  const bins = findFfmpegBinaries()
  if (!bins.ffmpeg || !bins.ffprobe) {
    t.skip('ffmpeg/ffprobe not installed in this environment')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'agy-ffmpeg-real-'))
  const cacheDir = join(root, 'cache')
  const rawMp4 = join(root, 'raw_yuvj.mp4')
  try {
    // Generate a 0.5s synthetic MP4 with yuv444p + odd dimensions + moov-at-end
    // (a classic OpenCV/FFmpeg output that browsers cannot decode directly).
    const gen = spawnSync(
      bins.ffmpeg,
      [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=161x91:rate=10',
        '-c:v', 'libx264', '-pix_fmt', 'yuv444p',
        '-f', 'mp4', rawMp4,
      ],
      { timeout: 30_000, windowsHide: true },
    )
    if (gen.status !== 0 || !existsSync(rawMp4)) {
      t.skip('ffmpeg libx264 encoder unavailable in this build')
      return
    }
    const rawStat = statSync(rawMp4)
    const prepared = await prepareCompatibleMedia({
      filePath: rawMp4,
      ext: '.mp4',
      contentType: 'video/mp4',
      size: rawStat.size,
      mtimeMs: rawStat.mtimeMs,
      cacheDir,
    })
    assert.equal(prepared.transcoded, true)
    assert.equal(prepared.mode, 'transcode')
    assert.equal(inspectMp4Faststart(prepared.filePath), true, 'output MP4 must have moov before mdat (faststart)')
    const probeOut = spawnSync(
      bins.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height', '-of', 'json', prepared.filePath],
      { timeout: 10_000, encoding: 'utf8', windowsHide: true },
    )
    assert.equal(probeOut.status, 0)
    const parsed = JSON.parse(probeOut.stdout) as { streams?: Array<{ codec_name?: string; pix_fmt?: string; width?: number; height?: number }> }
    const stream = parsed.streams?.[0]
    assert.equal(stream?.codec_name, 'h264')
    assert.equal(stream?.pix_fmt, 'yuv420p')
    assert.equal((stream?.width ?? 1) % 2, 0, 'output width must be even')
    assert.equal((stream?.height ?? 1) % 2, 0, 'output height must be even')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
