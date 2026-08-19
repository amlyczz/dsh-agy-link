// End-to-end adapter tests against the fake agy binary. Covers the chunk
// protocol, conversation binding reuse, auth-failure mapping, aux-call gate,
// and argv assembly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, buildDigest } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err, type PluginConfig } from '../src/common/types.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'agy-adapter-'))
process.env.DSH_AGY_CONVERSATIONS_DIR = join(workDir, 'convs')

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as unknown as Message
}

function makeAdapter(cfgOverrides: Partial<PluginConfig> = {}) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const store = new SessionStore(join(workDir, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const argsFile = join(workDir, 'args.json')
  const adapter = new AgyAdapter({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => fakeBin,
    acquire: () => Promise.resolve(() => {}),
  })
  return { adapter, store, argsFile }
}

function opts(messages: Message[], extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3.7-flash',
    messages,
    ...extra,
  } as GenerateOptions
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

test('ok run streams the full protocol and persists the binding', async () => {
  const { adapter, store, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const chunks = await collect(adapter.stream(opts([msg('user', 'hello there')], { sessionId: 'sess-1' as never })))
  const types = chunks.map((c) => c.type)
  assert.equal(types[types.length - 1], 'finish')
  assert.equal(types[types.length - 2], 'usage')
  assert.ok(types.includes('reasoning-delta'))
  assert.ok(types.includes('text-delta'))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
  assert.equal(text, 'Hello from fake agy')
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--output-format'))
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(argv.includes('--mode'))
  assert.ok(!argv.includes('--conversation'))
  const b = store.get('sess-1')
  assert.equal(b?.conversationId, 'conv-fresh-1')
  assert.equal(b?.lastMessageCount, 1)
})

test('second turn reuses the bound conversation id', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args2.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await collect(adapter.stream(opts([msg('user', 'one')], { sessionId: 'sess-2' as never })))
  await collect(adapter.stream(opts([msg('assistant', 'one'), msg('user', 'two')], { sessionId: 'sess-2' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.equal(argv[argv.indexOf('--conversation') + 1], 'conv-fresh-1')
})

test('unbound follow-up turn gets a history digest prefix', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args3.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await collect(adapter.stream(opts([msg('assistant', 'earlier answer'), msg('user', 'follow up')])))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('[conversation so far]'))
  assert.ok(prompt.includes('follow up'))
})

test('auth failure maps to an AUTH error finish', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'auth'
  const chunks = await collect(adapter.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.AUTH)
  assert.ok(finish.reason.failure?.message.includes('/agy auth'))
})

test('garbage-noise run still finishes clean', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'noise'
  const chunks = await collect(adapter.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('nonzero exit without result maps to PROCESS_EXIT', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'exit12'
  const chunks = await collect(adapter.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.PROCESS_EXIT)
})

test('aux calls rejected when allowAuxiliary is false', async () => {
  const { adapter } = makeAdapter({ allowAuxiliary: false })
  process.env.FAKE_AGY_MODE = 'ok'
  await assert.rejects(
    () => collect(adapter.stream(opts([msg('user', 'big history')], { purpose: 'compaction' }))),
    (e: unknown) => e instanceof LlmError && (e as LlmError & { code?: string }).code === Err.AUX_DISABLED,
  )
})

test('compaction prompt flattens the whole history', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args4.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await collect(adapter.stream(opts([msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2')], { purpose: 'compaction' })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('compaction'))
  assert.ok(prompt.includes('u1'))
  assert.ok(prompt.includes('a1'))
  assert.ok(argv.includes('--mode'))
  assert.equal(argv[argv.indexOf('--mode') + 1], 'plan')
})

test('unknown reasoning effort on known model is rejected', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  await assert.rejects(
    () => collect(adapter.stream(opts([msg('user', 'x')], { reasoningEffort: 'ultra' as never }))),
    (e: unknown) => e instanceof LlmError && (e as LlmError & { code?: string }).code === Err.UNSUPPORTED_REASONING_EFFORT,
  )
})

test('buildArgs assembles flags per ADR-3/8/10', () => {
  const { adapter } = makeAdapter()
  const args = adapter.buildArgs({
    prompt: 'do it',
    model: 'gemini-3.7-flash',
    effort: 'high',
    conversationId: 'c9',
    permissionMode: 'skip',
    timeoutMs: 90_000,
    extraArgs: ['--add-dir', '/tmp'],
  })
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(!args.includes('--mode'))
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.7-flash')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.equal(args[args.indexOf('--conversation') + 1], 'c9')
  assert.equal(args[args.indexOf('--print-timeout') + 1], '2m')
  assert.equal(args[args.indexOf('--add-dir') + 1], '/tmp')
  assert.equal(args[args.length - 1], 'do it')
  const planArgs = adapter.buildArgs({ prompt: 'p', model: 'm', permissionMode: 'plan', timeoutMs: 60_000, extraArgs: [] })
  assert.equal(planArgs[planArgs.indexOf('--mode') + 1], 'plan')
})

test('buildDigest bounds output and keeps newest turns', () => {
  const msgs = [msg('user', 'turn-one'), msg('assistant', 'turn-two'), msg('user', 'turn-three')]
  const d = buildDigest(msgs, 0, 25)
  assert.ok(d.includes('[conversation so far]'))
  assert.ok(d.includes('turn-three'))
  assert.ok(!d.includes('turn-one'))
  const full = buildDigest(msgs, 0, 10_000)
  assert.ok(full.includes('turn-one'))
  assert.ok(full.includes('turn-three'))
})

function msgSrc(role: 'user' | 'assistant', text: string, provider?: string): Message {
  const m: Record<string, unknown> = { role, content: [{ type: 'text', text }] }
  if (provider !== undefined) m.source = { provider }
  return m as unknown as Message
}

test('returning session digests only foreign turns since the watermark', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-w1.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  // Turn 1 binds the session (watermark = 1 message).
  await collect(adapter.stream(opts([msg('user', 'one')], { sessionId: 'sess-w' as never })))
  // Turn 2: our own agy reply + a foreign (deepseek) interjection in between.
  await collect(adapter.stream(opts([
    msgSrc('assistant', 'one', 'antigravity'),
    msg('user', 'two'),
    msgSrc('assistant', 'deepseek said Z', 'deepseek-official'),
    msg('user', 'final question'),
  ], { sessionId: 'sess-w' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('final question'))
  assert.ok(prompt.includes('deepseek said Z'), 'foreign turn digested')
  assert.ok(prompt.includes('two'), 'interleaved user turn digested')
  assert.ok(!prompt.includes('User: one'), 'pre-watermark history not re-sent')
  assert.equal(argv[argv.indexOf('--conversation') + 1], 'conv-fresh-1')

  // Turn 3 (clean, only our own replies since watermark): no digest at all.
  const argsFile2 = join(workDir, 'args-w2.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile2
  await collect(adapter.stream(opts([
    msgSrc('assistant', 'one', 'antigravity'),
    msg('user', 'two'),
    msgSrc('assistant', 'deepseek said Z', 'deepseek-official'),
    msg('user', 'final question'),
    msgSrc('assistant', 'final answer', 'antigravity'),
    msg('user', 'third'),
  ], { sessionId: 'sess-w' as never })))
  const argv2 = JSON.parse(readFileSync(argsFile2, 'utf8')) as string[]
  const prompt2 = argv2[argv2.indexOf('-p') + 1] ?? ''
  assert.ok(!prompt2.includes('[conversation so far]'), 'clean follow-up carries no digest')
  assert.equal(prompt2, 'third')
})

test('unspawnable binary maps to PROCESS_EXIT without hanging', async () => {
  const { adapter } = makeAdapter()
  const argsFile = join(workDir, 'args-x.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const broken = new AgyAdapter({
    getConfig: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
    catalog: new ModelCatalog(async () => { throw new Error('x') }, defaultConfig().fallbackModels, 300_000),
    store: new SessionStore(join(workDir, 'sessions-x.json')),
    bin: () => '/nonexistent/agy-binary-x',
    acquire: () => Promise.resolve(() => {}),
  })
  void adapter
  const chunks = await collect(broken.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.PROCESS_EXIT)
})

test.after(() => {
  rmSync(workDir, { recursive: true, force: true })
})
