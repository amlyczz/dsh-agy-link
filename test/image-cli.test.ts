// Integration tests for `dsh-agy-image` (src/cli/image.ts).
//
// The CLI is exercised through its injection seam: `runImageCli(argv, io)` with
// a fake ImageServiceLike, so no agy process, account pool or filesystem state
// is touched. `runViaAdapter` gets a stub adapter that plays agy events back
// through `agyOnEvent` — also without spawning anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  createDefaultImageService,
  createImageAdapter,
  packageVersion,
  parseImageCliArgs,
  runImageCli,
  runViaAdapter,
  type AdapterLike,
  type ImageCliArgs,
  type ImageServiceLike,
} from '../src/cli/image.ts'
import type {
  AgyEvent,
} from '../src/common/types.ts'
import { resolveConfig } from '../src/common/config.ts'
import type {
  ImageAgentCall,
  ImageFailureCode,
  ImageRequest,
  ImageResult,
} from '../src/host/image.ts'

// ---- fixtures -------------------------------------------------------------

function okResult(over: Partial<ImageResult> = {}): ImageResult {
  return {
    ok: true,
    path: '/tmp/agy-image.png',
    uri: 'file:///tmp/agy-image.png',
    mime: 'image/png',
    width: 1024,
    height: 1024,
    aspectRatio: '1:1',
    bytes: 2048,
    name: 'agy-image-1',
    prompt: 'a dog',
    model: 'gemini-3.8-flash',
    effort: 'low',
    durationMs: 1234,
    attempts: 1,
    ...over,
  }
}

function failResult(code: ImageFailureCode, over: Partial<ImageResult> = {}): ImageResult {
  return okResult({ ok: false, code, error: 'boom', ...over })
}

function capture() {
  let out = ''
  let err = ''
  return {
    stdout: (t: string) => { out += t },
    stderr: (t: string) => { err += t },
    out: () => out,
    err: () => err,
  }
}

interface RunOptions {
  result?: ImageResult
  service?: ImageServiceLike
  onService?: (args: ImageCliArgs, req: ImageRequest) => void
}

async function run(argv: readonly string[], opts: RunOptions = {}) {
  const cap = capture()
  const code = await runImageCli(argv, {
    stdout: cap.stdout,
    stderr: cap.stderr,
    ...(opts.result === undefined && opts.service === undefined
      ? {}
      : {
          createService: (args: ImageCliArgs, req: ImageRequest) => {
            opts.onService?.(args, req)
            return opts.service ?? { generate: async () => opts.result! }
          },
        }),
  })
  return { code, out: cap.out(), err: cap.err() }
}

// ---- usage / argument errors ---------------------------------------------

test('--help prints usage to stdout and exits 0', async () => {
  const r = await run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /dsh-agy-image/)
  assert.match(r.out, /--dry-run/)
  assert.equal(r.err, '')
})

test('--version prints the package version and exits 0', async () => {
  const r = await run(['--version'])
  assert.equal(r.code, 0)
  assert.equal(r.out, packageVersion() + '\n')
})

test('missing --prompt exits 2 and explains the flag', async () => {
  const r = await run(['--json'])
  assert.equal(r.code, 2)
  assert.match(r.err, /missing --prompt/)
  assert.equal(r.out, '')
})

test('a --prompt with only whitespace is treated as missing', async () => {
  const r = await run(['-p', '   '])
  assert.equal(r.code, 2)
  assert.match(r.err, /missing --prompt/)
})

test('an unknown flag exits 2 with the usage text', async () => {
  const r = await run(['-p', 'x', '--nope'])
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown argument: --nope/)
  assert.match(r.err, /用法/)
})

test('a flag missing its value degrades to an empty prompt (exit 2)', async () => {
  // `next()` refuses to swallow the following flag, so `-p --json` has no prompt.
  const r = await run(['-p', '--json'])
  assert.equal(r.code, 2)
  assert.match(r.err, /missing --prompt/)
})

// ---- dry run --------------------------------------------------------------

test('--dry-run prints the bridge prompt and never builds a service', async () => {
  const r = await run(['-p', '一只柴犬', '-a', '16:9', '-i', './ref.png', '--dry-run'])
  assert.equal(r.code, 0)
  assert.match(r.out, /generate_image/)
  assert.match(r.out, /一只柴犬/)
  assert.match(r.out, /16:9/)
  assert.match(r.out, /ref\.png/)
  // Nothing was dispatched.
  assert.doesNotMatch(r.err, /\[image\]/)
})

// ---- option pass-through --------------------------------------------------

test('all options are translated into the service request', async () => {
  let seenArgs: ImageCliArgs | undefined
  let seenReq: ImageRequest | undefined
  const r = await run(
    [
      '-p', 'draw it', '-n', 'night', '-a', '3:2', '-i', 'a.png', '--image', 'b.png',
      '-o', './out.png', '--model', 'gemini-3.8-flash', '--effort', 'high',
      '--timeout', '12', '--permission-mode', 'skip', '--max-bytes', '9000',
      '--force', '--json', '--quiet',
    ],
    {
      result: okResult(),
      onService: (args, req) => { seenArgs = args; seenReq = req },
    },
  )
  assert.equal(r.code, 0)
  assert.ok(seenArgs)
  assert.equal(seenArgs!.quiet, true)
  assert.equal(seenArgs!.force, true)
  assert.ok(seenReq)
  assert.deepEqual(seenReq, {
    prompt: 'draw it',
    name: 'night',
    aspectRatio: '3:2',
    imagePaths: ['a.png', 'b.png'],
    outPath: './out.png',
    model: 'gemini-3.8-flash',
    effort: 'high',
    timeoutMs: 12_000,
    permissionMode: 'skip',
    maxBytes: 9000,
    force: true,
  })
})

test('an invalid --permission-mode is ignored rather than passed through', async () => {
  const args = parseImageCliArgs(['-p', 'x', '--permission-mode', 'yolo'])
  assert.equal(args.permissionMode, undefined)
})

test('non-numeric --timeout / --max-bytes fall back to defaults', async () => {
  const args = parseImageCliArgs(['-p', 'x', '--timeout', 'nope', '--max-bytes', '-5'])
  assert.equal(args.timeoutSeconds, undefined)
  assert.equal(args.maxBytes, undefined)
})

// ---- JSON output + exit-code matrix --------------------------------------

test('JSON success prints exactly one {ok:true,path} line and exits 0', async () => {
  const r = await run(['-p', 'a dog', '--json'], { result: okResult() })
  assert.equal(r.code, 0)
  const lines = r.out.trimEnd().split('\n')
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0]!) as { ok: boolean; path: string; width: number }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.path, '/tmp/agy-image.png')
  assert.equal(parsed.width, 1024)
  assert.equal(r.err, '')
})

const EXIT_MATRIX: Array<[ImageFailureCode | undefined, number]> = [
  [undefined, 4], // ok:false with no code is a generic failure
  ['BAD_PARAMS', 2],
  ['EMPTY_PROMPT', 2],
  ['AGY_NOT_INSTALLED', 3],
  ['IMAGE_INVALID', 5],
  ['IMAGE_NOT_FOUND', 5],
  ['IMAGE_ASPECT_MISMATCH', 5],
  ['NO_ACCOUNT', 6],
  ['IMAGE_REGION_UNSUPPORTED', 6],
  ['AGY_AUTH', 6],
  ['TIMEOUT', 4],
  ['IMAGE_TOOL_ERROR', 4],
  ['AGY_ERROR', 4],
]

for (const [code, expected] of EXIT_MATRIX) {
  test(`JSON failure ${code ?? '(no code)'} → exit ${expected}`, async () => {
    const res = code === undefined ? okResult({ ok: false, error: 'boom' }) : failResult(code)
    const r = await run(['-p', 'x', '--json'], { result: res })
    assert.equal(r.code, expected)
    const parsed = JSON.parse(r.out.trim()) as { ok: boolean; code?: string }
    assert.equal(parsed.ok, false)
    if (code !== undefined) assert.equal(parsed.code, code)
  })
}

test('a thrown service error in JSON mode becomes AGY_ERROR / exit 4', async () => {
  const r = await run(['-p', 'x', '--json'], {
    service: { generate: async () => { throw new Error('adapter exploded') } },
  })
  assert.equal(r.code, 4)
  const parsed = JSON.parse(r.out.trim()) as { ok: boolean; code: string; error: string; prompt: string }
  assert.deepEqual(parsed, { ok: false, code: 'AGY_ERROR', error: 'adapter exploded', prompt: 'x' })
})

test('a thrown service error in text mode is reported on stderr / exit 4', async () => {
  const r = await run(['-p', 'x'], {
    service: { generate: async () => { throw new Error('adapter exploded') } },
  })
  assert.equal(r.code, 4)
  assert.equal(r.out, '')
  assert.match(r.err, /image generation failed: adapter exploded/)
})

// ---- default (non-JSON) output -------------------------------------------

test('default success prints the path and a summary line', async () => {
  const r = await run(['-p', 'a dog'], { result: okResult({ width: 512, height: 768, bytes: 2048 }) })
  assert.equal(r.code, 0)
  assert.equal(r.out, '/tmp/agy-image.png\n')
  assert.match(r.err, /512x768/)
  assert.match(r.err, /image\/png/)
  assert.match(r.err, /2\.0 KB/)
  assert.match(r.err, /gemini-3\.8-flash/)
})

test('--quiet suppresses the summary but still prints the path', async () => {
  const r = await run(['-p', 'a dog', '--quiet'], { result: okResult() })
  assert.equal(r.code, 0)
  assert.equal(r.out, '/tmp/agy-image.png\n')
  assert.equal(r.err, '')
})

test('default failure prints the error and the failure code', async () => {
  const r = await run(['-p', 'x'], { result: failResult('NO_ACCOUNT') })
  assert.equal(r.code, 6)
  assert.match(r.err, /image generation failed: boom/)
  assert.match(r.err, /code: NO_ACCOUNT/)
  assert.equal(r.out, '')
})

test('--out pass-through: the requested copy path is what gets printed', async () => {
  let seen: ImageRequest | undefined
  const r = await run(['-p', 'x', '-o', '/tmp/copy.png'], {
    result: okResult({ path: '/tmp/copy.png', sourcePath: '/tmp/agy-image.png' }),
    onService: (_args, req) => { seen = req },
  })
  assert.equal(r.code, 0)
  assert.equal(seen?.outPath, '/tmp/copy.png')
  assert.equal(r.out, '/tmp/copy.png\n')
})

// ---- runViaAdapter (event mapping) ---------------------------------------

function stepEvent(partial: Record<string, unknown>): AgyEvent {
  return { kind: 'step', stepKey: 's1', stepKind: 'text', text: '', raw: {}, ...partial } as unknown as AgyEvent
}

function adapterFrom(gen: (options: Record<string, unknown>) => AsyncGenerator<StreamChunk>): AdapterLike {
  return { stream: (options) => gen(options as unknown as Record<string, unknown>) }
}

function call(over: Partial<ImageAgentCall> = {}): ImageAgentCall {
  return {
    prompt: 'draw a red fox',
    model: 'gemini-3.8-flash',
    effort: 'low',
    permissionMode: 'skip',
    timeoutMs: 5_000,
    imagePaths: [],
    ...over,
  }
}

test('runViaAdapter maps init/step/result events and text deltas to a result', async () => {
  const adapter = adapterFrom(async function* (options) {
    const onAccount = options.agyOnAccount as (info: { id?: string; home?: string }) => void
    onAccount({ id: 'acct-1', home: '/home/acct' })
    const onEvent = options.agyOnEvent as (ev: AgyEvent) => void
    onEvent({ kind: 'init', conversationId: 'conv-1', raw: {} } as unknown as AgyEvent)
    onEvent(stepEvent({
      stepKind: 'text',
      text: 'thinking',
      raw: { subagent_info: { subagents: [{ conversation_id: 'sub-1', log_uri: 'file:///sub.log' }, { bad: true }] } },
    }))
    onEvent(stepEvent({
      stepKind: 'tool',
      tool: { name: 'generate_image', args: { Prompt: 'draw a red fox' }, output: '/tmp/out.png' },
    }))
    onEvent({
      kind: 'result',
      conversationId: 'conv-2',
      response: 'IMAGE_PATH=/tmp/out.png',
      raw: {},
    } as unknown as AgyEvent)
    yield { type: 'text-delta', index: 0, text: 'streamed text' } as unknown as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
  })

  // agyOnAccount is part of the options the CLI builds; the adapter stub can't
  // see it through the narrow type, so assert the event-derived fields only.
  const res = await runViaAdapter(adapter, call())
  assert.equal(res.ok, true)
  assert.equal(res.conversationId, 'conv-2')
  assert.deepEqual(res.toolCalls, [{ name: 'generate_image', args: { Prompt: 'draw a red fox' }, output: '/tmp/out.png' }])
  assert.deepEqual(res.subagents, [{ conversationId: 'sub-1', logUri: 'file:///sub.log' }, {}])
  assert.equal(res.text, 'thinking\nstreamed text')
  assert.equal(res.accountId, 'acct-1')
  assert.equal(res.home, '/home/acct')
  assert.ok(res.durationMs >= 0)
})

test('runViaAdapter falls back to the result-envelope response when no text streamed', async () => {
  const adapter = adapterFrom(async function* (options) {
    const onEvent = options.agyOnEvent as (ev: AgyEvent) => void
    onEvent({
      kind: 'result',
      conversationId: 'conv-3',
      response: 'IMAGE_PATH=/tmp/only-response.png',
      raw: {},
    } as unknown as AgyEvent)
    yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
  })
  const res = await runViaAdapter(adapter, call())
  assert.equal(res.ok, true)
  assert.equal(res.text, 'IMAGE_PATH=/tmp/only-response.png')
  assert.equal(res.conversationId, 'conv-3')
})

test('runViaAdapter turns an error finish into ok:false with the classified code', async () => {
  const adapter = adapterFrom(async function* () {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'IMAGE_INVALID', message: 'artifact was not an image' } },
    } as unknown as StreamChunk
  })
  const res = await runViaAdapter(adapter, call())
  assert.equal(res.ok, false)
  assert.equal(res.code, 'IMAGE_INVALID')
  assert.equal(res.error, 'artifact was not an image')
})

test('runViaAdapter keeps the result-envelope error text when the stream fails cleanly', async () => {
  const adapter = adapterFrom(async function* (options) {
    const onEvent = options.agyOnEvent as (ev: AgyEvent) => void
    onEvent({
      kind: 'result',
      conversationId: 'conv-9',
      response: '',
      raw: { result: { error: 'generate_image refused the prompt' } },
    } as unknown as AgyEvent)
    yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
  })
  const res = await runViaAdapter(adapter, call())
  assert.equal(res.ok, false)
  assert.equal(res.code, 'AGY_ERROR')
  assert.equal(res.error, 'generate_image refused the prompt')
  assert.equal(res.conversationId, 'conv-9')
})

test('runViaAdapter maps a thrown adapter error with a code', async () => {
  const adapter = adapterFrom(async function* () {
    throw Object.assign(new Error('all accounts are busy'), { code: 'NO_ACCOUNT' })
  })
  const res = await runViaAdapter(adapter, call())
  assert.equal(res.ok, false)
  assert.equal(res.code, 'NO_ACCOUNT')
  assert.equal(res.error, 'all accounts are busy')
})

test('runViaAdapter maps the "accounts are unavailable" prose to RATE_LIMIT', async () => {
  const adapter = adapterFrom(async function* () {
    throw new Error('All Antigravity accounts are unavailable: no account can serve google right now')
  })
  const res = await runViaAdapter(adapter, call())
  assert.equal(res.ok, false)
  assert.equal(res.code, 'RATE_LIMIT')
})

test('runViaAdapter reports TIMEOUT when the attempt outlives timeoutMs', async () => {
  const adapter = adapterFrom(async function* (options) {
    const signal = options.signal as AbortSignal
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  const res = await runViaAdapter(adapter, call({ timeoutMs: 25 }))
  assert.equal(res.ok, false)
  assert.equal(res.code, 'TIMEOUT')
  assert.match(res.error ?? '', /timed out after 25ms/)
})

// ---- composition root (no spawn, isolated state) -------------------------

test('createImageAdapter builds a real adapter without spawning agy', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-image-cli-'))
  const prevHome = process.env.DSH_HOME
  const prevState = process.env.DSH_STATE_DIR
  process.env.DSH_HOME = home
  process.env.DSH_STATE_DIR = home
  try {
    const cfg = resolveConfig(undefined)
    const adapter = createImageAdapter(cfg)
    assert.equal(typeof adapter.providerInfo('agy').id, 'string')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevState === undefined) delete process.env.DSH_STATE_DIR
    else process.env.DSH_STATE_DIR = prevState
    rmSync(home, { recursive: true, force: true })
  }
})


test('createDefaultImageService builds an adapter-backed service with isolated state', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-image-svc-'))
  const prevHome = process.env.DSH_HOME
  const prevState = process.env.DSH_STATE_DIR
  process.env.DSH_HOME = home
  process.env.DSH_STATE_DIR = home
  try {
    const args = parseImageCliArgs(['-p', 'x', '--quiet'])
    const svc = createDefaultImageService(args, { prompt: 'x' }, () => {})
    assert.equal(typeof svc.generate, 'function')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevState === undefined) delete process.env.DSH_STATE_DIR
    else process.env.DSH_STATE_DIR = prevState
    rmSync(home, { recursive: true, force: true })
  }
})
