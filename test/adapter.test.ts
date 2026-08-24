// End-to-end adapter tests against the fake agy binary. Covers the span
// protocol (native tool mirroring via finish:tool-calls + continuation),
// conversation binding reuse, auth-failure mapping, aux-call gate, and
// argv assembly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, buildDigest, detectContinuation, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { defineAgyMirrorTool, parseMirrorInvocation } from '../src/host/mirror-tool.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err, type PluginConfig } from '../src/common/types.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'agy-adapter-'))
process.env.DSH_AGY_CONVERSATIONS_DIR = join(workDir, 'convs')

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as unknown as Message
}

function makeAdapter(cfgOverrides: Partial<PluginConfig> = {}, deps: Partial<AgyAdapterDeps> = {}) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const store = new SessionStore(join(workDir, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const argsFile = join(workDir, 'args.json')
  const runs = new RunRegistry()
  const adapter = new AgyAdapter({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => fakeBin,
    acquire: () => Promise.resolve(() => {}),
    runs,
    ...deps,
  })
  return { adapter, store, argsFile, runs }
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

async function waitFor<T>(f: () => T | undefined, ms = 3_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

type MirrorArgs = { run: string; step: number; tool: string; input?: unknown }

/**
 * Drive one full agy turn the way DSH's agent loop would: collect a span,
 * and whenever it finishes with tool-calls, append the assistant tool-call
 * message plus the mirrored tool-result message and call stream() again.
 */
async function runTurn(
  adapter: AgyAdapter,
  base: Message[],
  extra: Partial<GenerateOptions> = {},
  maxHops = 12,
): Promise<{ chunks: StreamChunk[]; toolCalls: Array<{ id: string; args: MirrorArgs }>; messages: Message[] }> {
  const messages = [...base]
  const all: StreamChunk[] = []
  const toolCalls: Array<{ id: string; args: MirrorArgs }> = []
  for (let hop = 0; hop < maxHops; hop++) {
    // Pass a copy: the adapter's outcome handler captures the array it was
    // given, and the watermark it records must reflect this hop's view.
    const chunks = await collect(adapter.stream(opts([...messages], extra)))
    all.push(...chunks)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } } | undefined
    if (finish === undefined || finish.type !== 'finish') throw new Error('span ended without a finish chunk')
    if (finish.reason.kind !== 'tool-calls') return { chunks: all, toolCalls, messages }
    const end = chunks.find(
      (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
    ) as unknown as { block: { id: string; name: string; arguments: string } } | undefined
    if (end === undefined) throw new Error('tool-calls finish without a tool-call block')
    let args: MirrorArgs
    if (end.block.name === 'run_code') {
      const wrapper = JSON.parse(end.block.arguments) as { code: string; description: string }
      const inv = parseMirrorInvocation(wrapper.code)
      if (inv === null) throw new Error('run_code wrapper lacks the agy_tool invocation')
      args = { run: inv.run, step: inv.step, tool: '' } as unknown as MirrorArgs
    } else if (end.block.name === 'agy_tool') {
      const parsed = JSON.parse(end.block.arguments) as { run: string; step: number; tool?: string }
      args = { run: parsed.run, step: parsed.step, tool: parsed.tool ?? '' } as unknown as MirrorArgs
    } else {
      throw new Error('tool-call block must address run_code or agy_tool, got ' + end.block.name)
    }
    toolCalls.push({ id: end.block.id, args })
    messages.push({ role: 'assistant', content: [end.block] } as unknown as Message)
    messages.push({
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: end.block.id, content: [{ type: 'text', text: 'replayed' }] }],
      source: { kind: 'tool', callId: end.block.id },
    } as unknown as Message)
  }
  throw new Error('runTurn exceeded the hop budget')
}

test('ok run mirrors tools natively, streams text, and persists the binding', async () => {
  const { adapter, store, argsFile, runs } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const { chunks, toolCalls } = await runTurn(adapter, [msg('user', 'hello there')], { sessionId: 'sess-1' as never })
  const types = chunks.map((c) => c.type)
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(types[types.length - 2], 'usage')
  assert.ok(types.includes('reasoning-delta'))
  assert.ok(types.includes('text-delta'))
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
  assert.ok(!text.includes('[agy tool:'), 'no text-body tool annotations in v0.3: ' + text)
  assert.ok(text.endsWith('Hello from fake agy'), text)
  // the read_file step became exactly one native tool-call span; the block
  // carries only the (run, step) cursor — the tool name lives in the recording
  assert.equal(toolCalls.length, 1)
  const first = toolCalls[0] as { args: { run: string; step: number } }
  assert.equal(first.args.run.length > 0, true)
  const t = runs.get(first.args.run)?.toolEventAt(first.args.step)
  assert.equal(t?.name, 'read_file')
  // the mirror replays the recorded output for that callId
  const mirror = defineAgyMirrorTool({ runs })
  const replayed = await mirror.execute(toolCalls[0]?.args as never, { signal: new AbortController().signal } as never)
  assert.equal(replayed, 'file contents here')
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--output-format'))
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json')
  assert.ok(argv.includes('--mode'))
  assert.ok(!argv.includes('--conversation'))
  const b = await waitFor(() => store.get('sess-1'))
  assert.equal(b.conversationId, 'conv-fresh-1')
  assert.equal(b.lastMessageCount, 1)
})

test('detectContinuation keys off the trailing mirror tool-result only', () => {
  const toolResult = (callId: string): Message =>
    ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [] }], source: { kind: 'tool', callId } }) as never
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7')]),
    { runId: 'run-1', eventIndex: 7 },
  )
  assert.equal(detectContinuation([msg('user', 'q')]), null)
  assert.equal(detectContinuation([msg('user', 'q'), toolResult('bash-9')]), null)
})

test('second turn reuses the bound conversation id', async () => {
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args2.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'one')], { sessionId: 'sess-2' as never })
  await waitFor(() => store.get('sess-2'))
  await runTurn(adapter, [msg('assistant', 'one'), msg('user', 'two')], { sessionId: 'sess-2' as never })
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.equal(argv[argv.indexOf('--conversation') + 1], 'conv-fresh-1')
})

test('unbound follow-up turn gets a history digest prefix', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args3.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('assistant', 'earlier answer'), msg('user', 'follow up')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('[conversation so far]'))
  assert.ok(prompt.includes('follow up'))
})

test('agy 1.1.15 stream mirrors tools as native cards across spans', async () => {
  const { adapter, runs } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real'
  const { chunks, toolCalls } = await runTurn(adapter, [msg('user', 'count the files')])
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as unknown as { text: string }).text).join('')
  assert.ok(reasoning.includes('[agy thinking turn · 80 thinking tokens]'), reasoning)
  assert.ok(!reasoning.includes('[agy tool:'), 'no tool annotations in reasoning')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
  assert.ok(!text.includes('note1.txt'), 'tool output no longer pasted into the text body')
  assert.ok(text.includes('There are 2 files, 6 words total.'), text)
  // both tool steps became mirrored native calls, in order — the wrapper
  // carries cursor-only args; resolve the names from the recording
  const mirror = defineAgyMirrorTool({ runs })
  const names = toolCalls.map((t) => runs.get(t.args.run)?.toolEventAt(t.args.step)?.name)
  assert.deepEqual(names, ['run_command', 'find_by_name'])
  // the mirror replays run_command's recorded output and surfaces the errored tool
  const out = await mirror.execute(toolCalls[0]?.args as never, { signal: new AbortController().signal } as never)
  assert.equal(out, 'note1.txt\nnote2.txt\n')
  await assert.rejects(
    () => mirror.execute(toolCalls[1]?.args as never, { signal: new AbortController().signal } as never),
    (e: unknown) => String(e).includes('Find command timed out'),
  )
  // pending-card projection enriches cursor-only args from the recording:
  // run_command renders as a terminal card
  const card = mirror.presentCall?.(toolCalls[0]?.args)
  assert.equal((card as { card: string } | undefined)?.card, 'terminal')
})

test('agy 1.1.15 result ERROR with response still finishes stop', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real-error'
  const { chunks } = await runTurn(adapter, [msg('user', 'count the files')])
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as unknown as { text: string }).text).join('')
  assert.ok(reasoning.includes('[agy finished with error] Find command timed out'), reasoning)
})

test('agy 1.1.15 bare result error maps to AGY_ERROR after the tool spans', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real-fail'
  const { chunks } = await runTurn(adapter, [msg('user', 'hi')])
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.AGY_ERROR)
  assert.ok(finish.reason.failure?.message.includes('model overloaded'))
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
  const { chunks } = await runTurn(adapter, [msg('user', 'hi')])
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
  const planArgs = adapter.buildArgs({ prompt: 'p', model: 'gemini-3.5-flash', permissionMode: 'plan', timeoutMs: 60_000, extraArgs: [] })
  assert.equal(planArgs[planArgs.indexOf('--mode') + 1], 'plan')

  // Non-Gemini models (Claude, GPT-OSS) MUST strip --effort and resolve aliases
  const claudeArgs = adapter.buildArgs({
    prompt: 'hello',
    model: 'claude-opus-4-6',
    effort: 'medium',
    permissionMode: 'plan',
    timeoutMs: 60_000,
    extraArgs: [],
  })
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'claude-opus-4-6-thinking')
  assert.ok(!claudeArgs.includes('--effort'), 'effort flag stripped for non-gemini models')
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
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-w1.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  // Turn 1 binds the session (watermark = 1 message).
  await runTurn(adapter, [msg('user', 'one')], { sessionId: 'sess-w' as never })
  await waitFor(() => store.get('sess-w'))
  // Turn 2: our own agy reply + a foreign (deepseek) interjection in between.
  await runTurn(adapter, [
    msgSrc('assistant', 'one', 'antigravity'),
    msg('user', 'two'),
    msgSrc('assistant', 'deepseek said Z', 'deepseek-official'),
    msg('user', 'final question'),
  ], { sessionId: 'sess-w' as never })
  // wait for turn 2's watermark (4 messages) before asserting/driving turn 3
  await waitFor(() => {
    const b = store.get('sess-w')
    return b !== undefined && b.lastMessageCount >= 4 ? b : undefined
  })
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
  await runTurn(adapter, [
    msgSrc('assistant', 'one', 'antigravity'),
    msg('user', 'two'),
    msgSrc('assistant', 'deepseek said Z', 'deepseek-official'),
    msg('user', 'final question'),
    msgSrc('assistant', 'final answer', 'antigravity'),
    msg('user', 'third'),
  ], { sessionId: 'sess-w' as never })
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
    runs: new RunRegistry(),
  })
  void adapter
  const chunks = await collect(broken.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.PROCESS_EXIT)
})


test('adapter spawns agy in the DSH session cwd when workspaceRoot is not configured', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'agy-adapter-session-cwd-'))
  const { adapter } = makeAdapter({ workspaceRoot: '' }, {
    sessionCwd: () => sessionDir,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-cwd-session.json')
  const cwdFile = join(workDir, 'cwd-session.txt')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_CWD_FILE = cwdFile
  await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-cwd' as never })))
  assert.equal(readFileSync(cwdFile, 'utf8'), realpathSync(sessionDir))
  rmSync(sessionDir, { recursive: true, force: true })
})

test('explicit workspaceRoot wins over the DSH session cwd', async () => {
  const explicitDir = mkdtempSync(join(tmpdir(), 'agy-adapter-explicit-ws-'))
  const sessionDir = mkdtempSync(join(tmpdir(), 'agy-adapter-ignored-session-cwd-'))
  const { adapter } = makeAdapter({ workspaceRoot: explicitDir }, {
    sessionCwd: () => sessionDir,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-cwd-explicit.json')
  const cwdFile = join(workDir, 'cwd-explicit.txt')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_CWD_FILE = cwdFile
  await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-cwd-explicit' as never })))
  assert.equal(readFileSync(cwdFile, 'utf8'), realpathSync(explicitDir))
  rmSync(explicitDir, { recursive: true, force: true })
  rmSync(sessionDir, { recursive: true, force: true })
})

test('listModels and resolveModel advertise text and image modalities (multimodal)', async () => {
  const { adapter } = makeAdapter()
  const models = await adapter.listModels('antigravity')
  assert.ok(models.length > 0)
  for (const m of models) {
    assert.deepEqual(m.inputModalities, ['text', 'image'], `model ${m.id} should advertise text and image modalities`)
  }
  const resolved = await adapter.resolveModel('antigravity', 'gemini-3.7-flash')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

test('resolveModel uniformly advertises 1M context window across all Antigravity models (ADR-013)', async () => {
  const { adapter } = makeAdapter()
  const gemini = await adapter.resolveModel('antigravity', 'gemini-3.7-flash')
  assert.equal(gemini.context?.contextWindow, 1_048_576)
  const claude = await adapter.resolveModel('antigravity', 'claude-sonnet-4-6')
  assert.equal(claude.context?.contextWindow, 1_048_576)
  const gpt = await adapter.resolveModel('antigravity', 'gpt-oss-120b-medium')
  assert.equal(gpt.context?.contextWindow, 1_048_576)
})

test('compaction detection clears stale binding and re-seeds with digest (ADR-013)', async () => {
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-compact.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // Turn 1: 5 messages, creates binding with watermark 5
  await runTurn(adapter, [
    msg('user', 'm1'),
    msg('assistant', 'a1'),
    msg('user', 'm2'),
    msg('assistant', 'a2'),
    msg('user', 'm3'),
  ], { sessionId: 'sess-compact' as never })

  await waitFor(() => store.get('sess-compact'))
  assert.equal(store.get('sess-compact')?.lastMessageCount, 5)

  // Turn 2: DSH compacts history down to 2 messages (compacted summary + new user prompt)
  await runTurn(adapter, [
    msg('assistant', '[compacted summary of m1-m3]'),
    msg('user', 'new question after compaction'),
  ], { sessionId: 'sess-compact' as never })

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  // Because messages.length (2) < previous lastMessageCount (5), binding was reset and re-seeded with digest!
  assert.ok(prompt.includes('[conversation so far]'))
  assert.ok(prompt.includes('[compacted summary of m1-m3]'))
  assert.ok(prompt.includes('new question after compaction'))
  assert.ok(!argv.includes('--conversation') || argv[argv.indexOf('--conversation') + 1] !== 'conv-fresh-1')
})

test('model switch invalidates stale agy conversation binding', async () => {
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-modelswitch.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // Turn 1: model gemini-3.7-flash
  await runTurn(adapter, [msg('user', 'hello')], { sessionId: 'sess-switch' as never, model: 'gemini-3.7-flash' })
  await waitFor(() => store.get('sess-switch'))
  assert.equal(store.get('sess-switch')?.model, 'gemini-3.7-flash')
  const conv1 = store.get('sess-switch')?.conversationId

  // Turn 2: switch to claude-sonnet-4-6
  await runTurn(adapter, [msg('user', 'hello'), msg('assistant', 'hi'), msg('user', 'next')], { sessionId: 'sess-switch' as never, model: 'claude-sonnet-4-6' })

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(!argv.includes('--conversation') || argv[argv.indexOf('--conversation') + 1] !== conv1)
})

test('adapts tool dispatch to Native Mode (agy_tool) vs Code Mode (run_code)', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = join(workDir, 'args-modes.json')

  // In Code Mode: tools contains run_code
  const codeRes = await runTurn(adapter, [msg('user', 'code mode test')], {
    sessionId: 'sess-code' as never,
    tools: [{ name: 'run_code', description: 'execute JS', parameters: {} }] as never,
  })
  const codeBlocks = codeRes.chunks.filter((c) => c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call')
  assert.equal((codeBlocks[0] as unknown as { block: { name: string } }).block.name, 'run_code')

  // In Native Mode: tools contains agy_tool or standard tools
  const nativeRes = await runTurn(adapter, [msg('user', 'native mode test')], {
    sessionId: 'sess-native' as never,
    tools: [{ name: 'agy_tool', description: 'mirror tool', parameters: {} }] as never,
  })
  const nativeBlocks = nativeRes.chunks.filter((c) => c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call')
  assert.equal((nativeBlocks[0] as unknown as { block: { name: string } }).block.name, 'agy_tool')
})

test('multimodal: stages attached images and forwards path with view_file instructions', async () => {
  const pngData = Buffer.from('89504e470d0a1a0a', 'hex')
  const { adapter } = makeAdapter({}, {
    readImage: async () => pngData,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-multimodal.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // 1. Text + image
  const imgMsg: Message = {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this image?' },
      {
        type: 'image',
        attachment: {
          attachmentId: 'img_test_1' as never,
          mediaType: 'image/png',
          bytes: pngData.length,
          width: 100,
          height: 100,
          name: 'diagram.png',
        },
      },
    ],
  } as unknown as Message

  await runTurn(adapter, [imgMsg], { sessionId: 'sess-img' as never })
  const argv1 = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt1 = argv1[argv1.indexOf('-p') + 1] ?? ''
  assert.ok(prompt1.includes('what is this image?'))
  assert.ok(prompt1.includes('[image attached: "diagram.png"'))
  assert.ok(prompt1.includes('Inspect it using the view_file tool'))
  assert.ok(argv1.includes('--add-dir'))

  // 2. Image only (no text)
  const imgOnlyMsg: Message = {
    role: 'user',
    content: [
      {
        type: 'image',
        attachment: {
          attachmentId: 'img_test_2' as never,
          mediaType: 'image/png',
          bytes: pngData.length,
          width: 50,
          height: 50,
        },
      },
    ],
  } as unknown as Message

  await runTurn(adapter, [imgOnlyMsg], { sessionId: 'sess-img-only' as never })
  const argv2 = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt2 = argv2[argv2.indexOf('-p') + 1] ?? ''
  assert.ok(prompt2.includes('[image attached: "img_test_2"'))
  assert.ok(prompt2.includes('[Please inspect the attached image(s) using view_file and assist the user.]'))
})

test('duplicate request with identical prompt within debounce window is rejected with BUSY', async () => {
  const { adapter } = makeAdapter()
  const userMsg = msg('user', 'Please perform task X')
  const sessionOptions = opts([userMsg], { sessionId: 'sess-dup-test' as never })

  // Start first stream (pulling first chunk starts the generator body)
  const iter1 = adapter.stream(sessionOptions)[Symbol.asyncIterator]()
  const firstChunk = await iter1.next()
  assert.ok(!firstChunk.done)

  // Immediately attempt second identical stream for same session
  await assert.rejects(
    async () => {
      const iter2 = adapter.stream(sessionOptions)
      for await (const _ of iter2) {}
    },
    (err: unknown) => {
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, Err.BUSY)
      assert.ok(err.message.includes('Duplicate request ignored'))
      return true
    },
  )

  // Drain first stream so it finishes cleanly
  while (!(await iter1.next()).done) {}
})

test('rate limit error from agy maps to AGY_ERROR without retryable PROCESS_EXIT', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'real-fail'
  try {
    const { adapter } = makeAdapter()
    const userMsg = msg('user', 'Say hello')
    const res = await runTurn(adapter, [userMsg], { sessionId: 'sess-ratelimit' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure?.code, Err.AGY_ERROR)
    assert.ok(finish.reason.failure?.message.includes('rate limit'))
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('sliding-window rate limit enforces request throttling per minute', async () => {
  const { adapter } = makeAdapter({
    rateLimitPerMinute: 2,
  })

  const t0 = Date.now()
  const userMsg1 = msg('user', 'Req 1')
  const userMsg2 = msg('user', 'Req 2')

  // Run 2 turns quickly
  await runTurn(adapter, [userMsg1], { sessionId: 'sess-rl-1' as never })
  await runTurn(adapter, [userMsg2], { sessionId: 'sess-rl-2' as never })

  const elapsed = Date.now() - t0
  assert.ok(elapsed < 2000)
})

test.after(() => {
  rmSync(workDir, { recursive: true, force: true })
})
