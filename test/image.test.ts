import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ImageService,
  SUPPORTED_ASPECT_RATIOS,
  aspectMatches,
  buildImageAgentPrompt,
  extractImagePaths,
  normalizeAspectRatio,
  normalizeImageName,
  parseImageReply,
  simplifyRatio,
  sniffImage,
  type ImageAgentCall,
  type ImageAgentResult,
} from '../src/host/image.ts'
import { defaultConfig } from '../src/common/types.ts'
import { parseImageCliArgs } from '../src/cli/image.ts'

// ---- image header fixtures (only the bytes sniffImage reads) --------------

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

function gifHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(13)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

function webpHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'ascii')
  b.write('VP8X', 12, 'ascii')
  b.writeUInt32LE(10, 16)
  const w = width - 1
  const h = height - 1
  b[24] = w & 0xff
  b[25] = (w >> 8) & 0xff
  b[26] = (w >> 16) & 0xff
  b[27] = h & 0xff
  b[28] = (h >> 8) & 0xff
  b[29] = (h >> 16) & 0xff
  return b
}

// ---- pure helpers ---------------------------------------------------------

test('normalizeAspectRatio accepts the supported spellings and rejects others', () => {
  assert.equal(normalizeAspectRatio('16:9'), '16:9')
  assert.equal(normalizeAspectRatio('16x9'), '16:9')
  assert.equal(normalizeAspectRatio('16 / 9'), '16:9')
  assert.equal(normalizeAspectRatio(' 1:1 '), '1:1')
  assert.equal(normalizeAspectRatio('7:3'), null, 'not in the agy enum')
  assert.equal(normalizeAspectRatio('square'), null)
  assert.equal(normalizeAspectRatio(''), null)
  assert.ok(SUPPORTED_ASPECT_RATIOS.includes('21:9'))
})

test('normalizeImageName keeps a safe ASCII stem', () => {
  assert.equal(normalizeImageName('My Dog!', 1), 'My_Dog')
  assert.equal(normalizeImageName('../../etc/passwd', 1), 'etc_passwd')
  assert.equal(normalizeImageName('   ', 123), 'agy-image-123')
  assert.equal(normalizeImageName('柴犬', 123), 'agy-image-123')
  assert.ok(normalizeImageName('x'.repeat(200), 1).length <= 80)
})

test('buildImageAgentPrompt pins every argument and the reply contract', () => {
  const p = buildImageAgentPrompt({
    prompt: '一只戴墨镜的柴犬',
    name: 'shiba',
    aspectRatio: '16:9',
    imagePaths: ['/tmp/ref.png'],
  })
  assert.match(p, /generate_image/)
  assert.ok(p.includes('- Prompt: "一只戴墨镜的柴犬"'))
  assert.ok(p.includes('- ImageName: "shiba"'))
  assert.ok(p.includes('- AspectRatio: "16:9"'))
  assert.ok(p.includes('- ImagePaths: ["/tmp/ref.png"]'))
  assert.match(p, /VERBATIM/)
  assert.match(p, /IMAGE_PATH=/)
  assert.match(p, /IMAGE_ERROR=/)
  // Without optional arguments the lines are absent, not empty.
  const bare = buildImageAgentPrompt({ prompt: 'x', name: 'n' })
  assert.doesNotMatch(bare, /AspectRatio:/)
  assert.doesNotMatch(bare, /ImagePaths:/)
})

test('parseImageReply reads IMAGE_PATH / IMAGE_ERROR and ignores prose', () => {
  assert.deepEqual(parseImageReply('IMAGE_PATH=/a/b.png'), { path: '/a/b.png' })
  assert.deepEqual(parseImageReply('`IMAGE_PATH=/a/b.png`'), { path: '/a/b.png' })
  assert.deepEqual(parseImageReply('IMAGE_ERROR=User location is not supported'), { error: 'User location is not supported' })
  assert.deepEqual(parseImageReply('done, all good'), {})
})

test('extractImagePaths finds absolute and file:// paths in free text', () => {
  const text = 'saved to /Users/x/brain/c/solid_red_square_1.jpg and file:///tmp/a.webp, ignore http://x/y.png?q=1'
  const paths = extractImagePaths(text)
  assert.ok(paths.includes('/Users/x/brain/c/solid_red_square_1.jpg'))
  assert.ok(paths.includes('/tmp/a.webp'))
  assert.equal(paths.length, 2, 'URL query strings must not be picked up as local paths')
})

test('sniffImage parses png / jpeg / gif / webp headers', () => {
  assert.deepEqual(sniffImage(pngHeader(1024, 1024)), { mime: 'image/png', ext: '.png', width: 1024, height: 1024 })
  assert.deepEqual(sniffImage(jpegHeader(1344, 768)), { mime: 'image/jpeg', ext: '.jpg', width: 1344, height: 768 })
  assert.deepEqual(sniffImage(gifHeader(64, 32)), { mime: 'image/gif', ext: '.gif', width: 64, height: 32 })
  assert.deepEqual(sniffImage(webpHeader(800, 600)), { mime: 'image/webp', ext: '.webp', width: 800, height: 600 })
  assert.equal(sniffImage(Buffer.from('not an image at all, just text')), null)
})

test('aspectMatches tolerates agy rounding but not a wrong ratio', () => {
  assert.equal(aspectMatches(1024, 1024, '1:1'), true)
  assert.equal(aspectMatches(1344, 768, '16:9'), true)
  assert.equal(aspectMatches(1024, 1024, '16:9'), false)
  assert.equal(aspectMatches(1024, 1024, undefined), true)
})

test('simplifyRatio reports the natural ratio', () => {
  assert.equal(simplifyRatio(1024, 1024), '1:1')
  assert.equal(simplifyRatio(1344, 768), '7:4')
})

// ---- service --------------------------------------------------------------

function makeCfg(overrides: Partial<ReturnType<typeof defaultConfig>> = {}) {
  return { ...defaultConfig(), imageRetries: 1, imageMaxBytes: 5 * 1024 * 1024, ...overrides }
}

function serviceWith(
  run: (call: ImageAgentCall) => Promise<ImageAgentResult>,
  cfg = makeCfg(),
): ImageService {
  return new ImageService({ cfg: () => cfg, bin: () => '/fake/agy', run })
}

const okRun = (patch: Partial<ImageAgentResult>): ((call: ImageAgentCall) => Promise<ImageAgentResult>) => async () => ({
  ok: true,
  text: '',
  toolCalls: [],
  subagents: [],
  durationMs: 5,
  ...patch,
})

test('service accepts an artifact discovered in the brain directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-img-'))
  const conv = 'conv-1'
  const dir = join(root, '.gemini', 'antigravity-cli', 'brain', conv)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'shiba_123.png'), pngHeader(1024, 1024))
  const service = serviceWith(okRun({ conversationId: conv, home: root }))
  const res = await service.generate({ prompt: 'a shiba', name: 'shiba', aspectRatio: '1:1' })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.width, 1024)
  assert.equal(res.height, 1024)
  assert.equal(res.mime, 'image/png')
  assert.ok(res.path.endsWith('shiba_123.png'))
})

test('service prefers an explicit IMAGE_PATH even without a brain scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-img-'))
  const file = join(root, 'direct.jpg')
  await writeFile(file, jpegHeader(1344, 768))
  const service = serviceWith(okRun({ text: 'IMAGE_PATH=' + file }))
  const res = await service.generate({ prompt: 'a shiba', aspectRatio: '16:9' })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.path, file)
  assert.equal(res.mime, 'image/jpeg')
  assert.equal(res.width, 1344)
})

test('service copies the artifact to --out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-img-'))
  const source = join(root, 'a.png')
  await writeFile(source, pngHeader(512, 512))
  const outDir = join(root, 'out')
  const service = serviceWith(okRun({ text: 'IMAGE_PATH=' + source }))
  const res = await service.generate({ prompt: 'x', outPath: join(outDir, 'final.png') })
  assert.equal(res.ok, true, res.error)
  assert.equal(res.path, join(outDir, 'final.png'))
  assert.equal(res.sourcePath, source)
  assert.ok((await readFile(res.path)).length > 0)
})

test('service reports a region refusal as IMAGE_REGION_UNSUPPORTED and retries', async () => {
  let calls = 0
  const service = serviceWith(async () => {
    calls++
    return {
      ok: false,
      text: '',
      toolCalls: [],
      subagents: [],
      error: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
      code: 'ELIGIBILITY',
      durationMs: 3,
    }
  })
  const res = await service.generate({ prompt: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'IMAGE_REGION_UNSUPPORTED')
  assert.equal(calls, 2, 'one retry is configured')
  assert.equal(res.attempts, 2)
})

test('service rejects a wrong aspect ratio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-img-'))
  const file = join(root, 'square.png')
  await writeFile(file, pngHeader(1024, 1024))
  const service = serviceWith(okRun({ text: 'IMAGE_PATH=' + file }))
  const res = await service.generate({ prompt: 'x', aspectRatio: '16:9' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'IMAGE_ASPECT_MISMATCH')
  assert.match(res.error ?? '', /1024x1024/)
})

test('service rejects a non-image artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-img-'))
  const file = join(root, 'fake.png')
  await writeFile(file, 'this is not a png')
  const service = serviceWith(okRun({ text: 'IMAGE_PATH=' + file }))
  const res = await service.generate({ prompt: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'IMAGE_INVALID')
})

test('service reports a missing artifact when the agent never produced one', async () => {
  const service = serviceWith(okRun({ text: 'I could not do that.' }))
  const res = await service.generate({ prompt: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'IMAGE_NOT_FOUND')
})

test('service validates parameters before spawning agy', async () => {
  let calls = 0
  const service = serviceWith(async () => {
    calls++
    return { ok: true, text: '', toolCalls: [], subagents: [], durationMs: 1 }
  })
  assert.equal((await service.generate({ prompt: '' })).code, 'EMPTY_PROMPT')
  assert.equal((await service.generate({ prompt: 'x', aspectRatio: '7:3' })).code, 'BAD_PARAMS')
  assert.equal((await service.generate({ prompt: 'x', imagePaths: ['/definitely/missing.png'] })).code, 'BAD_PARAMS')
  assert.equal(calls, 0)
})

// ---- CLI argv -------------------------------------------------------------

test('parseImageCliArgs maps flags and repeats --image', () => {
  const a = parseImageCliArgs(['-p', 'a dog', '-n', 'dog', '-a', '16:9', '-i', 'a.png', '--ref', 'b.png', '-o', 'out.jpg', '--json', '--timeout', '90'])
  assert.equal(a.prompt, 'a dog')
  assert.equal(a.name, 'dog')
  assert.equal(a.aspectRatio, '16:9')
  assert.deepEqual(a.imagePaths, ['a.png', 'b.png'])
  assert.equal(a.outPath, 'out.jpg')
  assert.equal(a.json, true)
  assert.equal(a.timeoutSeconds, 90)
  assert.throws(() => parseImageCliArgs(['--nope']), /unknown argument/)
  assert.equal(parseImageCliArgs(['--help']).help, true)
})

test('service retries once without --effort when the model refuses the flag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-img-'))
  const file = join(root, 'a.png')
  await writeFile(file, pngHeader(512, 512))
  const efforts: string[] = []
  let n = 0
  const service = serviceWith(async (call) => {
    efforts.push(call.effort)
    n++
    if (n === 1) {
      return {
        ok: false,
        text: '',
        toolCalls: [],
        subagents: [],
        error: 'invalid model selection (--model "claude-sonnet-4-6" --effort "low"): --effort is not supported for model "claude-sonnet-4-6"',
        code: 'AGY_ERROR',
        durationMs: 2,
      }
    }
    return { ok: true, text: 'IMAGE_PATH=' + file, toolCalls: [], subagents: [], durationMs: 2 }
  })
  const res = await service.generate({ prompt: 'x', effort: 'low' })
  assert.equal(res.ok, true, res.error)
  assert.deepEqual(efforts, ['low', ''], 'the second attempt drops the refused flag')
  assert.equal(res.effort, '')
  assert.equal(res.attempts, 1, 'the flag fallback is free, not a retry budget')
})
