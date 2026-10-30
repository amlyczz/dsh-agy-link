// End-to-end adapter tests against the fake agy binary. Covers the span
// protocol (native tool mirroring via finish:tool-calls + continuation),
// conversation binding reuse, auth-failure mapping, aux-call gate, and
// argv assembly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, buildDigest, collectUnsentImageRefs, detectContinuation, isRealUserMessage, isSyntheticHarnessMessage, latestUserTaskText, mergeSentImageIds, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { classifyToolError } from '../src/host/recording.ts'
import { defineAgyMirrorTool, parseMirrorInvocation } from '../src/host/mirror-tool.ts'
import { stripNulBytes } from '../src/host/runner.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { NETWORK_RETRY_DELAYS_MS, defaultConfig, Err, type PluginConfig } from '../src/common/types.ts'

const fakeBin = join(import.meta.dirname, 'fake-agy.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'agy-adapter-'))
process.env.DSH_AGY_CONVERSATIONS_DIR = join(workDir, 'convs')

function msg(role: 'user' | 'assistant' | 'system', text: string): Message {
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
 *
 * `toolResultSchema` selects how DSH stores the tool result:
 *  - `'user'` (default, dsh-llm 0.1.x): `role: 'user'` + `source.callId`
 *  - `'tool'` (dsh-llm 0.1.7+): `role: 'tool'` + `message.toolCallId`
 */
async function runTurn(
  adapter: AgyAdapter,
  base: Message[],
  extra: Partial<GenerateOptions> = {},
  maxHops = 12,
  trailingPluginSnapshots = false,
  replayRuns?: RunRegistry,
  toolResultSchema: 'user' | 'tool' = 'user',
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
    let output = 'replayed'
    let isError = false
    if (replayRuns) {
      try {
        output = String(await defineAgyMirrorTool({ runs: replayRuns }).execute(args as never, { signal: new AbortController().signal } as never))
      } catch (error) {
        isError = true
        output = String(error)
      }
    }
    if (toolResultSchema === 'tool') {
      messages.push({
        role: 'tool',
        toolCallId: end.block.id,
        content: [{ type: 'text', text: output }],
        source: { kind: 'tool', callId: end.block.id },
      } as unknown as Message)
    } else {
      messages.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: end.block.id, content: [{ type: 'text', text: output }], isError }],
        source: { kind: 'tool', callId: end.block.id },
      } as unknown as Message)
    }
    if (trailingPluginSnapshots) {
      messages.push({ role: 'user', content: [], source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] } } as unknown as Message)
    }
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
  // reasoning-delta only when thought prose is available; fake ok mode may
  // report thinking_tokens without DB prose — empty chips are suppressed.
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

test('registry pressure during a long span never breaks the pending mirror replay', async () => {
  // Regression for the flash-blast incident (2026-10-10): a wedged tool step
  // held a span for hours while other DSH sessions kept creating runs; the
  // global FIFO registry evicted the run and the mirror call the span had
  // already queued failed with "no recorded agy run".
  const { adapter, runs } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real'
  process.env.FAKE_AGY_DELAY_MS = '700'
  try {
    const pending = collect(adapter.stream(opts([msg('user', 'count the files')], { sessionId: 'sess-pressure' as never })))
    // The span owns the run and has pinned it; agy has not emitted anything yet.
    await waitFor(() => (runs.pinnedCount > 0 ? true : undefined))
    assert.equal(runs.size, 1)
    const runId = runs.runIds[0] as string
    for (let i = 0; i < 12; i++) {
      const other = runs.create()
      other.settle(null)
    }
    assert.notEqual(runs.get(runId), undefined, 'pinned run survives registry pressure')
    const chunks = await pending
    const end = chunks.find(
      (c) => c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call',
    ) as unknown as { block: { name: string; arguments: string } } | undefined
    assert.ok(end !== undefined, 'span cut on a tool-call')
    const parsed = JSON.parse(end.block.arguments) as { run: string; step: number; tool: string }
    assert.equal(parsed.run, runId)
    assert.notEqual(runs.get(runId), undefined, 'recording re-registered before the mirror dispatch')
    const replayed = await defineAgyMirrorTool({ runs }).execute(
      { run: parsed.run, step: parsed.step, tool: parsed.tool } as never,
      { signal: new AbortController().signal } as never,
    )
    assert.equal(replayed, 'note1.txt\nnote2.txt\n')
  } finally {
    delete process.env.FAKE_AGY_DELAY_MS
  }
})

test('detectContinuation permits only trailing plugin snapshots after our mirror result', () => {
  const toolResult = (callId: string): Message =>
    ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [] }], source: { kind: 'tool', callId } }) as never
  const pluginSnapshot = { role: 'user', content: [], source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] } } as unknown as Message
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7')]),
    { runId: 'run-1', eventIndex: 7 },
  )
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7'), pluginSnapshot]),
    { runId: 'run-1', eventIndex: 7 },
  )
  assert.equal(detectContinuation([toolResult('agytc-run-1-7'), msg('user', 'a human follow-up')]), null)
  assert.deepEqual(detectContinuation([toolResult('agytc-run-1-7'), pluginSnapshot, pluginSnapshot]), { runId: 'run-1', eventIndex: 7 })
  assert.equal(detectContinuation([pluginSnapshot]), null)
  for (const form of ['notice', 'instructions', 'relay', 'recall', undefined]) {
    const meaningfulPluginMessage = { role: 'user', content: [{ type: 'text', text: 'new instruction' }], source: { kind: 'plugin', plugin: 'test', form } } as unknown as Message
    assert.equal(detectContinuation([toolResult('agytc-run-1-7'), meaningfulPluginMessage, pluginSnapshot]), null, `must not skip ${form}`)
  }
  assert.equal(detectContinuation([toolResult('agytc-run-1-7'), toolResult('other-provider-4')]), null)
  assert.equal(detectContinuation([msg('user', 'q')]), null)
  assert.equal(detectContinuation([msg('user', 'q'), toolResult('bash-9')]), null)
})

test('plugin snapshots continue the existing run without a duplicate spawn and retain tool errors', async () => {
  const reports: Array<{ processOk: boolean; processCode: string; toolErrors: readonly string[] }> = []
  const { adapter } = makeAdapter({}, { onRun: (info) => reports.push(info) })
  process.env.FAKE_AGY_MODE = 'real-error'
  const { chunks, toolCalls } = await runTurn(adapter, [msg('user', 'count the files')], {}, 12, true)
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(toolCalls.length, 2)
  const report = await waitFor(() => reports[0])
  assert.equal(reports.length, 1, 'continuation spans must not spawn another agy process')
  assert.equal(report.processOk, true)
  assert.equal(report.processCode, 'OK')
  assert.deepEqual(report.toolErrors, ['Find command timed out.'])
})

test('headless automatic denial stays raw while process success remains separate', async () => {
  const reports: Array<{ processOk: boolean; processCode: string; toolErrors: readonly string[] }> = []
  const { adapter, runs } = makeAdapter({}, { onRun: (info) => reports.push(info) })
  process.env.FAKE_AGY_MODE = 'real-denied'
  const { chunks, messages, toolCalls } = await runTurn(adapter, [msg('user', 'inspect files')], {}, 12, true, runs)
  assert.ok(messages.some(m => JSON.stringify(m).includes('"isError":true')), 'denial must be replayed as a real error result')
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  const report = await waitFor(() => reports[0])
  assert.equal(report.processOk, true)
  assert.equal(report.processCode, 'OK')
  assert.deepEqual(report.toolErrors, ['Permission denied automatically in headless plan mode: read_file ~/.agents'])
  assert.equal(reports.length, 1, 'error replay must not spawn a second AGY process')
  assert.equal(toolCalls.length, 2)
  const failedResult = messages.find(m => JSON.stringify(m).includes('"isError":true'))!
  assert.match(JSON.stringify(failedResult), /Permission denied automatically in headless plan mode: read_file ~\/.agents/)
  assert.match(JSON.stringify(failedResult), /agy tool/)
})

test('tool errors distinguish missing files and non-bypassable system protection from approval', () => {
  assert.equal(classifyToolError('ENOENT: no such file or directory, open qa-proof-stack.md'), 'missing_file')
  assert.equal(classifyToolError('Denied by hardcoded system protection for global brain search'), 'system_protection')
  assert.equal(classifyToolError('Permission denied automatically in headless plan mode'), 'approval')
})

test('long prompts switch to --input-format stream-json on stdin (issue #14)', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-long.json')
  const stdinFile = join(workDir, 'stdin-long.txt')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_STDIN_FILE = stdinFile
  const longPrompt = 'L'.repeat(30_000)
  await runTurn(adapter, [msg('user', longPrompt)])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--input-format'), argv.slice(0, 20).join(' '))
  assert.ok(!argv.includes('-p'), 'prompt must not ride argv when over budget')
  // fake-agy may exit before the async stdin drain writes the file on some
  // platforms; the argv shape above is the portable assertion.
  process.env.FAKE_AGY_ARGS_FILE = join(workDir, 'args.json')
  delete process.env.FAKE_AGY_STDIN_FILE
})

test('short prompts still pass -p on argv', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-short.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'short question')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('-p'))
  assert.equal(argv[argv.indexOf('-p') + 1], 'short question')
  assert.ok(!argv.includes('--input-format'))
  process.env.FAKE_AGY_ARGS_FILE = join(workDir, 'args.json')
})

test('normal prompts are not polluted by keyword-driven recovery suffixes', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'recover the missing artifact')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.equal(prompt, 'recover the missing artifact')
  assert.ok(!prompt.includes('Recovery boundary'), 'no plugin-side prompt injection on missing/not-found keywords')
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
  assert.equal(argv[argv.indexOf('-p') + 1] ?? '', 'two', 'resumed turn forwards only the user text')
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

test('a bound conversation does not re-send tool output it already owns', async () => {
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-redundancy.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'one')], { sessionId: 'sess-redundant' as never })
  await waitFor(() => store.get('sess-redundant'))
  // DSH hands back our mirrored tool result followed by the user's new
  // question — the shape that used to pipe kilobytes of stale tool output INTO
  // the prompt, ahead of the actual question.
  const bigToolOutput = 'GODOT-SIM-DUMP ' + 'x'.repeat(6000)
  const toolMsg = {
    role: 'user',
    source: { kind: 'tool', callId: 'agytc-old-3' },
    content: [{ type: 'tool-result', toolCallId: 'agytc-old-3', content: [{ type: 'text', text: bigToolOutput }] }],
  } as unknown as Message
  await runTurn(adapter, [msg('assistant', 'one'), toolMsg, msg('user', 'what changed?')], { sessionId: 'sess-redundant' as never })
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('what changed?'), prompt.slice(0, 200))
  assert.ok(!prompt.includes('GODOT-SIM-DUMP'), 'tool output the live conversation already owns must not be re-sent')
  assert.ok(prompt.length < 500, `prompt should stay small, got ${prompt.length}`)
})

test('an image-only follow-up never re-sends an older question as the task', async () => {
  const readImage = async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3, 4])
  const { adapter, store } = makeAdapter({}, { readImage })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-imgonly.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'FIRST-QUESTION')], { sessionId: 'sess-imgonly' as never })
  await waitFor(() => store.get('sess-imgonly'))
  const imgOnly = {
    role: 'user',
    content: [
      { type: 'text', text: '' },
      { type: 'image', attachment: { attachmentId: 'img-only-1', mediaType: 'image/png', byteLength: 4 } },
    ],
  } as unknown as Message
  await collect(adapter.stream(opts([msg('user', 'FIRST-QUESTION'), msg('assistant', 'partial'), imgOnly], { sessionId: 'sess-imgonly' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  // The newest message carries no text: falling back to the PREVIOUS question
  // made agy answer the wrong message outright (S2).
  assert.ok(!prompt.includes('FIRST-QUESTION'), `stale task leaked into the prompt: ${prompt.slice(0, 200)}`)
  assert.ok(prompt.includes('view_file'), 'the attached image must still be pointed at')
})

test('a Stop mid-flight marks the binding interrupted and the next prompt carries the boundary', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const prevDelay = process.env.FAKE_AGY_DELAY_MS
  process.env.FAKE_AGY_MODE = 'slow-init'
  process.env.FAKE_AGY_DELAY_MS = '300'
  const { adapter, store } = makeAdapter()
  const ctrl = new AbortController()
  const iter = adapter.stream(opts([msg('user', 'FIRST-QUESTION')], { sessionId: 'sess-abort' as never, signal: ctrl.signal }))[Symbol.asyncIterator]()
  try {
    const first = await iter.next()
    assert.equal(first.done, false, 'the run must stream something before the abort')
    ctrl.abort()
  } finally {
    try { while (!(await iter.next()).done) { /* drain the aborted stream */ } } catch { /* aborted streams may reject */ }
  }
  const binding = await waitFor(() => store.get('sess-abort'))
  assert.equal(binding.interrupted, true, 'an interrupted turn must be flagged so the next prompt can say so')

  // Next turn: the boundary must precede the newest request, otherwise agy's
  // conversation still ends with the unanswered interrupted turn and the model
  // answers THAT (the "latest message ignored" bug, session-c65a826e 17→19).
  const argsFile = join(workDir, 'args-interrupted.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_DELAY_MS = '0'
  await runTurn(
    adapter,
    [msg('user', 'FIRST-QUESTION'), msg('assistant', 'partial answer'), msg('user', 'NEW-QUESTION')],
    { sessionId: 'sess-abort' as never },
  )
  await waitFor(() => store.get('sess-abort'))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.startsWith('[the previous turn was interrupted'), prompt.slice(0, 160))
  assert.ok(prompt.includes('NEW-QUESTION'))
  await waitFor(() => (store.get('sess-abort')?.interrupted === undefined ? true : undefined))
  assert.equal(store.get('sess-abort')?.interrupted, undefined, 'a successful turn clears the interrupted flag')

  process.env.FAKE_AGY_MODE = prevMode
  if (prevDelay === undefined) delete process.env.FAKE_AGY_DELAY_MS
  else process.env.FAKE_AGY_DELAY_MS = prevDelay
})

test('agy 1.1.15 stream mirrors tools as native cards across spans', async () => {
  const { adapter, runs } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real'
  const { chunks, toolCalls } = await runTurn(adapter, [msg('user', 'count the files')])
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as unknown as { text: string }).text).join('')
  // Banner-only chips are suppressed; prose still renders when extracted.
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

test('a Stop mid-flight during tool continuation aborts immediately and terminates the stream', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real'
  const messages: Message[] = [msg('user', 'count the files')]

  // Hop 0: streams until first tool call
  const span0 = await collect(adapter.stream(opts([...messages])))
  const finish0 = span0[span0.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish0.reason.kind, 'tool-calls')

  const end = span0.find(
    (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
  ) as unknown as { block: { id: string; name: string; arguments: string } }
  assert.ok(end !== undefined)

  messages.push({
    role: 'assistant',
    content: [{ type: 'tool-call', id: end.block.id, name: end.block.name, arguments: end.block.arguments }],
  } as unknown as Message)
  messages.push({
    role: 'tool',
    toolCallId: end.block.id,
    content: [{ type: 'text', text: 'note1.txt\nnote2.txt\n' }],
  } as unknown as Message)

  // Hop 1 (continuation span): simulate user clicking "Stop generating"
  const ctrl = new AbortController()
  const iter = adapter.stream(opts([...messages], { signal: ctrl.signal }))[Symbol.asyncIterator]()

  ctrl.abort()

  const continuationChunks: StreamChunk[] = []
  for await (const chunk of { [Symbol.asyncIterator]: () => iter }) {
    continuationChunks.push(chunk)
  }

  const lastChunk = continuationChunks[continuationChunks.length - 1] as { type: string; reason?: { kind: string } }
  assert.equal(lastChunk?.type, 'finish')
  assert.equal(lastChunk?.reason?.kind, 'aborted')
})

test('a Stop mid-flight during tool continuation with active iterator aborts cleanly', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'real'
  const messages: Message[] = [msg('user', 'count the files')]

  const span0 = await collect(adapter.stream(opts([...messages])))
  const end = span0.find(
    (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
  ) as unknown as { block: { id: string; name: string; arguments: string } }
  assert.ok(end !== undefined)

  messages.push({
    role: 'assistant',
    content: [{ type: 'tool-call', id: end.block.id, name: end.block.name, arguments: end.block.arguments }],
  } as unknown as Message)
  messages.push({
    role: 'tool',
    toolCallId: end.block.id,
    content: [{ type: 'text', text: 'note1.txt\nnote2.txt\n' }],
  } as unknown as Message)

  const ctrl = new AbortController()
  const iter = adapter.stream(opts([...messages], { signal: ctrl.signal }))[Symbol.asyncIterator]()
  // Read first chunk
  const first = await iter.next()
  assert.equal(first.done, false)
  // Stop clicked while continuation span is draining
  ctrl.abort()

  const rem: StreamChunk[] = []
  for (;;) {
    const next = await iter.next()
    if (next.done) break
    rem.push(next.value)
  }
  const last = rem[rem.length - 1] as { type: string; reason?: { kind: string } }
  assert.equal(last?.type, 'finish')
  assert.equal(last?.reason?.kind, 'aborted')
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
  process.env.FAKE_AGY_MODE = 'real-bare'
  const { chunks } = await runTurn(adapter, [msg('user', 'hi')])
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.AGY_ERROR)
  assert.ok(finish.reason.failure?.message.includes('upstream request failed'))
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

test('nonzero exit WITH a stdout error envelope surfaces the real cause', async () => {
  // Regression: agy exits 1 with empty stderr and puts its error in the
  // stdout result envelope. The message used to be the bare
  // "agy exited with code 1" with no cause, which is exactly what a user
  // session log showed while quota errors went unnoticed.
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'exit-error'
  const chunks = await collect(adapter.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.PROCESS_EXIT)
  assert.ok((finish.reason.failure?.message ?? '').startsWith('agy exited with code 1:'))
  assert.ok((finish.reason.failure?.message ?? '').includes('upstream request failed while generating'))
})

test('prepareCall binds model metadata and dispatch (dsh-llm >= 0.1.1-rc.2 contract)', async () => {
  // Regression: new hosts call registration.adapter.prepareCall()
  // unconditionally; an adapter built against the old base class crashed
  // with "registration.adapter.prepareCall is not a function".
  const { adapter } = makeAdapter()
  const prepared = await adapter.prepareCall('antigravity', 'gemini-3.7-flash')
  assert.equal(prepared.model.provider, 'antigravity')
  assert.equal(prepared.model.id, 'gemini-3.7-flash')
  assert.ok(typeof prepared.model.defaultMaxTokens === 'number' && prepared.model.defaultMaxTokens > 0)
  assert.equal(typeof prepared.stream, 'function')
  // the bound stream runs a full turn through the fake binary
  process.env.FAKE_AGY_MODE = 'ok'
  const chunks = await collect(prepared.stream(opts([msg('user', 'hi')])))
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.notEqual(finish.reason.kind, 'error')
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
  assert.ok(full.indexOf('turn-one') < full.indexOf('turn-two'))
  assert.ok(full.indexOf('turn-two') < full.indexOf('turn-three'), 'historical turns must precede the latest task')
})

test('buildDigest never lets tool-result bulk eat the live task (issue #35)', () => {
  const huge = 'x'.repeat(4_000)
  const msgs = [
    msg('user', 'please read block LOg2xNRy3'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: huge }] }],
      source: { kind: 'tool', callId: 'c1' },
    } as unknown as Message,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: huge }] }],
      source: { kind: 'tool', callId: 'c2' },
    } as unknown as Message,
  ]
  const d = buildDigest(msgs, 0, 8_000)
  assert.ok(d.includes('please read block LOg2xNRy3'), 'task line must survive a digest saturated by tool results')
  assert.ok(d.includes('Tool result:'), 'tool results are labeled distinctly')
})

// --- agy single-message ceiling (192,000 UTF-8 bytes, tail-truncated) -------
// Measured on agy 1.4.9: a 300 KB ASCII prompt kept exactly 192,000 B and a
// 490 KB CJK prompt kept 191,998 B; the model then answered the OLD task because
// the live request (appended after the digest) had been cut off. These tests pin
// the two guards: a byte budget for the digest and live-request-first assembly.

test('buildDigest enforces a UTF-8 byte ceiling without splitting code points', () => {
  const big = '这是用于测试字节预算的中文内容。'.repeat(2_000)
  const msgs = [msg('user', 'first question'), msg('assistant', big), msg('user', 'latest')]
  const d = buildDigest(msgs, 0, 1_000_000, { maxBytes: 20_000, maxLineBytes: 5_000 })
  const bytes = Buffer.byteLength(d, 'utf8')
  assert.ok(bytes <= 20_100, 'digest must respect the byte ceiling, got ' + bytes + ' B')
  assert.ok(d.includes('[conversation so far]'))
  assert.ok(!d.includes('\uFFFD'), 'a split code point must not leak a replacement char')
})

test('first-contact prompt leads with the live request (agy cuts the tail)', async () => {
  const { adapter } = makeAdapter({ contextTransferFileAboveBytes: 5_000_000 })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-live-head.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const history: Message[] = []
  for (let i = 0; i < 40; i++) {
    history.push(msg('user', 'earlier question ' + i))
    history.push(msg('assistant', 'earlier answer ' + i + ' ' + 'x'.repeat(500)))
  }
  history.push(msg('user', 'THE-LIVE-QUESTION'))
  await runTurn(adapter, history)
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.startsWith('[CURRENT REQUEST'), 'live request block must lead the prompt')
  assert.ok(
    prompt.indexOf('THE-LIVE-QUESTION') < prompt.indexOf('[conversation so far]'),
    'the live question must come before the digest',
  )
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 180_000, 'prompt must stay under agy single-message ceiling')
})

test('oversized context transfer travels as a file reference, not inlined', async () => {
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = workDir
  try {
    const { adapter } = makeAdapter({ contextTransferFileAboveBytes: 5_000 })
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-ctx-file.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const history: Message[] = []
    for (let i = 0; i < 30; i++) {
      history.push(msg('user', 'p' + i))
      history.push(msg('assistant', 'answer ' + i + ' ' + 'y'.repeat(800)))
    }
    history.push(msg('user', 'LIVE-QUESTION-FILE-MODE'))
    await runTurn(adapter, history)
    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const prompt = argv[argv.indexOf('-p') + 1] ?? ''
    assert.ok(prompt.includes('BACKGROUND CONTEXT'), 'must reference the background file')
    assert.ok(prompt.includes('read_file'))
    assert.ok(!prompt.includes('[conversation so far]'), 'the digest must NOT be inlined')
    const m = prompt.match(/([A-Za-z]:\\[^\n]*?\.md)/) ?? prompt.match(/(\/[^\n]*?\.md)/)
    assert.ok(m !== null, 'prompt must name the context file path')
    const ctxPath = m![1]!
    assert.ok(existsSync(ctxPath), 'context file must exist: ' + ctxPath)
    assert.ok(readFileSync(ctxPath, 'utf8').includes('[conversation so far]'))
    const dirs: string[] = []
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--add-dir') dirs.push(argv[i + 1] ?? '')
    assert.ok(dirs.some((d) => ctxPath.startsWith(d)), 'the context dir must be passed via --add-dir')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})

function imgMsg(id: string, text = 'shot'): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', attachmentId: id, mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
    ],
  } as unknown as Message
}

test('collectUnsentImageRefs skips already-sent ids and dedupes', () => {
  const history = [imgMsg('a1'), imgMsg('a2')]
  const trailing = [imgMsg('a2', 'again'), imgMsg('a3', 'new')]
  const got = collectUnsentImageRefs(history, trailing, 0, ['a1'])
  assert.deepEqual(got.map((r) => r.attachmentId), ['a2', 'a3'], 'trailing first, a1 already sent')
})

test('collectUnsentImageRefs on a tool hop only takes unseen ids since the watermark', () => {
  // history: user image a1 (already inside the watermark), then a tool hop
  // with no new attachments. The old fallback re-sent a1 on every hop.
  const history = [
    imgMsg('a1'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
    } as unknown as Message,
  ]
  const trailing = [history[2]!]
  const got = collectUnsentImageRefs(history, trailing, 3, [])
  assert.deepEqual(got.map((r) => r.attachmentId), [], 'no unseen images after a tool hop')
  // …but a first-contact / account-switch call (fromIdx 0, nothing sent) still carries it
  const fresh = collectUnsentImageRefs(history, trailing, 0, [])
  assert.deepEqual(fresh.map((r) => r.attachmentId), ['a1'])
})

test('mergeSentImageIds dedupes and keeps the newest under the cap', () => {
  assert.deepEqual(mergeSentImageIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])
  const many = mergeSentImageIds(['x0'], Array.from({ length: 70 }, (_, i) => 'i' + i), 64)
  assert.equal(many.length, 64)
  assert.equal(many[many.length - 1], 'i69', 'newest kept')
  assert.ok(!many.includes('x0'), 'oldest evicted')
})

test('first contact seeds a new conversation with contextTransferMaxChars, not digestMaxChars', async () => {
  const { adapter } = makeAdapter({
    digestMaxChars: 40,
    contextTransferMaxChars: 4_000,
    mediaMaxImages: 0,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-transfer.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const old = 'OLD-CONTEXT-' + 'x'.repeat(200)
  await runTurn(adapter, [msg('assistant', old), msg('user', 'carry on')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('OLD-CONTEXT'), 'transfer digest keeps the old turn')
  assert.ok(prompt.includes('carry on'))
})

test('returning hop does not re-attach historical screenshots (image watermark)', async () => {
  const reads: string[] = []
  const { adapter, store } = makeAdapter(
    { mediaMaxImages: 8, mediaDir: join(workDir, 'media-wm') },
    {
      readImage: async (ref) => {
        reads.push(ref.attachmentId)
        return new Uint8Array([1, 2, 3])
      },
    },
  )
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-wm.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // Hop 1: user attaches a1. It must be staged and recorded.
  const first = [imgMsg('a1', 'look at this UI')]
  await runTurn(adapter, first, { sessionId: 'sess-wm' as never })
  await waitFor(() => store.get('sess-wm'))
  assert.deepEqual(reads, ['a1'])
  assert.deepEqual(store.get('sess-wm')?.sentImageIds, ['a1'])

  // Hop 2: tool-hop continuation with no new attachment — a1 must NOT be re-read.
  reads.length = 0
  const second = [
    ...first,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'agy_tool', arguments: '{}' }] } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
    } as unknown as Message,
  ]
  await runTurn(adapter, second, { sessionId: 'sess-wm' as never })
  assert.deepEqual(reads, [], 'historical image must not be re-staged on a tool hop')

  // Hop 3: a NEW attachment is still forwarded.
  reads.length = 0
  const third = [...second, imgMsg('a2', 'another look')]
  await runTurn(adapter, third, { sessionId: 'sess-wm' as never })
  assert.deepEqual(reads, ['a2'], 'only the unseen attachment is staged')
  assert.deepEqual(store.get('sess-wm')?.sentImageIds, ['a1', 'a2'])
})

function toolResultMsg(opts: {
  role?: string
  callId?: string
  toolCallIdOnMessage?: string
  nestedText?: string
  sourceKind?: string
}): Message {
  const m: Record<string, unknown> = {
    role: opts.role ?? 'user',
    content: opts.nestedText !== undefined
      ? [{ type: 'tool-result', toolCallId: opts.callId ?? 'agytc-run-1-7', content: [{ type: 'text', text: opts.nestedText }] }]
      : [{ type: 'tool-result', toolCallId: opts.callId ?? 'agytc-run-1-7', content: [] }],
  }
  if (opts.toolCallIdOnMessage !== undefined) m.toolCallId = opts.toolCallIdOnMessage
  if (opts.callId !== undefined || opts.sourceKind !== undefined) {
    m.source = { kind: opts.sourceKind ?? 'tool', callId: opts.callId ?? 'agytc-run-1-7' }
  }
  return m as unknown as Message
}

test('detectContinuation accepts dsh-llm 0.1.7 role:tool results (issue #34)', () => {
  // 0.1.7: role 'tool', callId on the message
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResultMsg({ role: 'tool', toolCallIdOnMessage: 'agytc-run-1-7' })]),
    { runId: 'run-1', eventIndex: 7 },
  )
  // callId only in source, role still 'tool'
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResultMsg({ role: 'tool', callId: 'agytc-run-2-3' })]),
    { runId: 'run-2', eventIndex: 3 },
  )
  // callId only on the nested tool-result block
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResultMsg({ role: 'tool' })]),
    { runId: 'run-1', eventIndex: 7 },
  )
  // role 'tool' but NOT our mirror call id
  assert.equal(
    detectContinuation([msg('user', 'q'), toolResultMsg({ role: 'tool', toolCallIdOnMessage: 'bash-9' })]),
    null,
  )
  // human message still wins over a preceding tool result
  assert.equal(
    detectContinuation([toolResultMsg({ role: 'tool', toolCallIdOnMessage: 'agytc-run-1-7' }), msg('user', 'follow up')]),
    null,
  )
})

test('prompt keeps the user task when the trailing span is tool-results only (issue #34)', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-taskkeep.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  // Simulate a post-tool hop that is NOT recognized as a mirror continuation
  // (foreign/legacy call id): trailing span is tool-role only and must still
  // carry the live task plus the nested tool-result text.
  const messages = [
    msg('user', 'do the Roam thing'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'legacy-1', name: 'other_tool', arguments: '{}' }] } as unknown as Message,
    toolResultMsg({ role: 'tool', toolCallIdOnMessage: 'legacy-1', callId: 'legacy-1', nestedText: 'partial tool output' }),
  ]
  await collect(adapter.stream(opts(messages, { sessionId: 'sess-task' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('do the Roam thing'), 'task text must be in the prompt: ' + prompt.slice(0, 200))
  assert.ok(prompt.includes('partial tool output'), 'nested tool-result text is forwarded')
})

test('role:tool continuation (dsh-llm 0.1.7) resumes one process across spans (issues #34/#35)', async () => {
  const reports: Array<{ processOk: boolean; processCode: string; toolErrors: readonly string[] }> = []
  const { adapter } = makeAdapter({}, { onRun: (info) => reports.push(info) })
  process.env.FAKE_AGY_MODE = 'real-error'
  const { toolCalls, chunks } = await runTurn(
    adapter,
    [msg('user', 'count the files')],
    { sessionId: 'sess-toolrole' as never },
    12,
    false,
    undefined,
    'tool',
  )
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(toolCalls.length, 2, 'both tool spans should cut and continue')
  const report = await waitFor(() => reports[0])
  assert.equal(reports.length, 1, 'role:tool results must resume the same run, not spawn a new agy process')
  assert.equal(report.processOk, true)
})

test('region eligibility refusal maps to a clear ELIGIBILITY error (issue #32)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'exit-eligible'
  const chunks = await collect(adapter.stream(opts([msg('user', '测试')], { sessionId: 'sess-elig' as never })))
  process.env.FAKE_AGY_MODE = prevMode
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { message: string; code: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, 'ELIGIBILITY')
  assert.ok(
    finish.reason.failure?.message.includes('not eligible') || finish.reason.failure?.message.includes('Antigravity'),
    'message should explain the eligibility/region refusal: ' + finish.reason.failure?.message,
  )
  assert.ok(finish.reason.failure?.message.includes('location'), finish.reason.failure?.message)
})

test('"Eligibility check failed" wrapping a TLS handshake timeout is NETWORK, not ELIGIBILITY', async () => {
  // Observed live: every first turn failed with "Eligibility check failed:
  // failed to get profile picture: … TLS handshake timeout" and the retry
  // succeeded — a transport blip (proxy cold start), not a region refusal.
  const prevMode = process.env.FAKE_AGY_MODE
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'exit-eligible-network'
  const chunks = await collect(adapter.stream(opts([msg('user', '测试')], { sessionId: 'sess-elig-net' as never })))
  process.env.FAKE_AGY_MODE = prevMode
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, Err.NETWORK)
  assert.ok(!finish.reason.failure?.message.includes('not eligible'), 'must not show the region hint: ' + finish.reason.failure?.message)
})

test('live location refusal rotates the refused account away (retry can serve another)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'location-denied'
  const pool = new AccountPoolManager(join(workDir, 'pool-location'))
  const second = pool.createAccountSlot('Proxied')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const res = await runTurn(adapter, [msg('user', 'hi')], { sessionId: 'sess-location' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.reason.failure?.code, Err.ELIGIBILITY)
    assert.ok(finish.reason.failure?.message.includes('location'), finish.reason.failure?.message)
    // ELIGIBILITY is retryable AND the sticky pointer already moved off the
    // refused account, so the retry is served by a different account instead of
    // hitting the same unsupported location again and again.
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
    // Rotating away is not a cooldown penalty on a healthy account.
    assert.equal(pool.getAccounts()[0]!.cooldowns.google, undefined)
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

function msgSrc(role: 'user' | 'assistant', text: string, provider?: string, replayState?: unknown): Message {
  const m: Record<string, unknown> = { role, content: [{ type: 'text', text }] }
  if (provider !== undefined) m.source = { provider, ...(replayState !== undefined ? { replayState } : {}) }
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
  assert.equal(prompt2, 'third', 'no keyword-driven recovery suffix is injected into the prompt')
})

test('returning session digests replies from another agy conversation id (cross-conversation / cross-account)', async () => {
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-cross-conv.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  // Turn 1 binds the session to conv-fresh-1
  await runTurn(adapter, [msg('user', 'first message')], { sessionId: 'sess-cross' as never })
  await waitFor(() => store.get('sess-cross'))

  // Turn 2: User asked second, but it was answered on another conversation (conv-other-2)
  await runTurn(adapter, [
    msgSrc('assistant', 'first reply', 'antigravity', { response: { conversationId: 'conv-fresh-1' } }),
    msg('user', 'second message'),
    msgSrc('assistant', 'second reply on another account', 'antigravity', { response: { conversationId: 'conv-other-2' } }),
    msg('user', 'third message'),
  ], { sessionId: 'sess-cross' as never })

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('third message'))
  assert.ok(prompt.includes('second reply on another account'), 'reply from another conversation must be digested')
  assert.ok(prompt.includes('second message'), 'user question from intervening turn must be digested')
})

test('forwardSystemPrompt falls back to role: system message when options.system is omitted', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: true })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-sys-msg.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  await runTurn(adapter, [
    msg('system', 'You are a meticulous TypeScript expert.'),
    msg('user', 'Please write a test.'),
  ], { sessionId: 'sess-sys' as never })

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('System instructions:\nYou are a meticulous TypeScript expert.'), 'system message forwarded')
  assert.ok(prompt.includes('Please write a test.'))
})

// Hosts that ask a model to authorize a tool call put the entire output
// protocol in `options.system` — DSH's auto-review sends REVIEW_POLICY, which
// demands exactly one JSON object. Dropping it left the model with only the
// data sections, so it answered in prose and the host's JSON.parse threw
// ("Unexpected token 'B', \"Based on a\"... is not valid JSON"), denying the
// tool call instead of reviewing it. The fix forwards the policy for review
// calls even when the global opt-in is off. Regression for issue #50.
test('review calls forward the REVIEW_POLICY system prompt without the global opt-in', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: false })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-review-policy.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  const policy = 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.\nReturn exactly one JSON object and no other text.'
  await runTurn(adapter, [
    msg('user', 'ENVIRONMENT\n{"cwd":"/tmp/project"}\n\nPENDING_ACTION\n{"tool":"bash"}'),
  ], { sessionId: 'sess-review' as never, system: policy } as never)

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('System instructions:\n' + policy), 'review policy reaches the model')
  assert.ok(prompt.includes('PENDING_ACTION'), 'the review data sections are still present')
  assert.ok(prompt.startsWith('System instructions:'), 'the policy leads the prompt')
})

test('session-title auxiliary calls forward the system prompt and do not force plan mode', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: false, permissionMode: 'skip' })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-session-title.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  const titleSystem = 'Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.'
  await runTurn(adapter, [
    msg('user', 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"echo test"}]'),
  ], { sessionId: 'sess-title' as never, system: titleSystem, purpose: 'session-title' } as never)

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('System instructions:\n' + titleSystem), 'title instructions reach the model')
  assert.ok(prompt.includes('Generate the session title'), 'the user prompt is present')
  assert.ok(prompt.startsWith('System instructions:'), 'the policy leads the prompt')
  const modeIdx = argv.indexOf('--mode')
  if (modeIdx !== -1) {
    assert.notEqual(argv[modeIdx + 1], 'plan', 'title call must not inject plan mode')
  }
})

test('ordinary turns keep dropping the system prompt while the opt-in is off', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: false })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-no-system.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  await runTurn(adapter, [msg('user', 'what is in this repo?')], {
    sessionId: 'sess-no-sys' as never,
    system: 'You are a helpful coding agent.',
  } as never)

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(!prompt.includes('System instructions:'), 'non-review turns stay unchanged')
  assert.equal(prompt, 'what is in this repo?')
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
  // agy ignores cwd for Active Workspace — the root must also ride --add-dir (issue #26)
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--add-dir'), argv.join(' '))
  const addIdx = argv.indexOf('--add-dir')
  assert.equal(argv[addIdx + 1], sessionDir)
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
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const addIdx = argv.indexOf('--add-dir')
  assert.ok(addIdx >= 0, 'explicit workspaceRoot also rides --add-dir')
  assert.equal(argv[addIdx + 1], explicitDir)
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

test('listModels never returns duplicate ids even with duplicate fallback defs (issue #1)', async () => {
  // DSH's llm.listModels contract throws INVALID_CATALOG on any duplicate
  // model id and the model picker then drops the whole Antigravity group.
  // A user-configured fallbackModels list (or any catalog source) must never
  // be able to trigger that, so the adapter dedupes as a final guard.
  const logs: string[] = []
  const { adapter } = makeAdapter({
    fallbackModels: [
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash (dup)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (dup)' },
    ],
  }, { log: (m) => logs.push(m) })
  const models = await adapter.listModels('antigravity')
  const ids = models.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, 'listModels ids must be unique')
  assert.deepEqual(ids, ['gemini-3.7-flash', 'claude-sonnet-4-6'])
  // The guard must be observable so field instances show up in server logs
  // instead of silently masking the underlying catalog duplication.
  assert.ok(
    logs.some((m) => m.includes('duplicate') && m.includes('gemini-3.7-flash') && m.includes('claude-sonnet-4-6')),
    'deduping should log which duplicate ids were dropped',
  )
})

test('listModels hides hiddenModels from the picker while resolveModel still resolves them', async () => {
  const { adapter } = makeAdapter({ hiddenModels: ['gemini-3.7-flash', ' gpt-oss-120b-medium '] })
  const models = await adapter.listModels('antigravity')
  const ids = models.map((m) => m.id)
  assert.ok(!ids.includes('gemini-3.7-flash'), 'a hidden id must leave the picker list')
  assert.ok(!ids.includes('gpt-oss-120b-medium'), 'hidden ids are matched after trimming')
  assert.ok(ids.includes('claude-sonnet-4-6'), 'unlisted models stay visible (deny-list semantics)')
  // resolveModel deliberately does not filter: in-flight sessions and direct
  // references keep resolving a model after it has been hidden.
  const resolved = await adapter.resolveModel('antigravity', 'gemini-3.7-flash')
  assert.equal(resolved.id, 'gemini-3.7-flash')
  assert.equal(resolved.name, 'Gemini 3.7 Flash')
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

test('listModels and resolveModel defensively handle empty IDs, empty names, and empty effort lists', async () => {
  const { adapter } = makeAdapter({
    fallbackModels: [
      { id: '  ', name: 'Empty Id' },
      { id: 'valid-model', name: '  ', efforts: [''] },
      { id: 'effort-model', name: 'Effort Model', efforts: ['high', 'low', 'high'] },
    ],
  })
  const models = await adapter.listModels('antigravity')
  assert.equal(models.some((m) => m.id.trim() === ''), false)
  assert.ok(models.some((m) => m.id === 'valid-model' && m.name === 'valid-model'))

  const resolved = await adapter.resolveModel('antigravity', 'effort-model')
  assert.ok(resolved.reasoning)
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.id), ['high', 'low'])
  assert.equal(resolved.reasoning.defaultEffort, 'high')

  const resolvedNoEffort = await adapter.resolveModel('antigravity', 'valid-model')
  assert.equal(resolvedNoEffort.reasoning, undefined)
})

test('listModels dynamically isolates Argon models based on active account eligibility', async () => {
  let activeId = 'acc_free'
  const accounts: Record<string, any> = {
    acc_free: {
      id: 'acc_free',
      alias: 'Free Account',
      dir: '/tmp/acc_free',
      enabled: true,
      quotas: { google: { remainingFraction: 1 } },
    },
    acc_pro: {
      id: 'acc_pro',
      alias: 'Pro Account',
      dir: '/tmp/acc_pro',
      enabled: true,
      quotas: { argon: { remainingFraction: 1 }, google: { remainingFraction: 1 } },
    },
  }
  const fakePool = {
    getActiveAccountId: () => activeId,
    getPoolData: () => ({ primaryAccountId: 'acc_free', accounts: Object.values(accounts) }),
    getAccount: (id: string) => accounts[id],
    hasDedicatedGroup: (id: string, fam: string) => id === 'acc_pro' && fam === 'argon',
  }
  const { adapter } = makeAdapter({
    fallbackModels: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    ],
  }, { pool: fakePool as any })

  // 1. With free account active: gemini-4-argon is hidden from picker
  activeId = 'acc_free'
  const freeModels = await adapter.listModels('antigravity')
  assert.ok(freeModels.some((m) => m.id === 'gemini-3.8-flash'))
  assert.ok(!freeModels.some((m) => m.id === 'gemini-4-argon'), 'free account must not show gemini-4-argon')

  // 2. With pro account active: gemini-4-argon is present in picker
  activeId = 'acc_pro'
  const proModels = await adapter.listModels('antigravity')
  assert.ok(proModels.some((m) => m.id === 'gemini-3.8-flash'))
  assert.ok(proModels.some((m) => m.id === 'gemini-4-argon'), 'pro account must show gemini-4-argon')
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

test('compaction detection does not invalidate binding on minor message drop (e.g. telemetry pruning)', async () => {
  const { adapter, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-compact-minor.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // Turn 1: 15 messages, creates binding with watermark 15
  const msgs1 = []
  for (let i = 0; i < 7; i++) {
    msgs1.push(msg('user', `u${i}`))
    msgs1.push(msg('assistant', `a${i}`))
  }
  msgs1.push(msg('user', 'u7'))
  await runTurn(adapter, msgs1, { sessionId: 'sess-minor-drop' as never })

  await waitFor(() => store.get('sess-minor-drop'))
  const initialBinding = store.get('sess-minor-drop')
  assert.equal(initialBinding?.lastMessageCount, 15)
  const initialConvId = initialBinding?.conversationId
  assert.ok(initialConvId)

  // Turn 2: history drops 1 message (e.g. 14 messages due to telemetry filtering)
  const msgs2 = msgs1.slice(0, 14)
  await runTurn(adapter, msgs2, { sessionId: 'sess-minor-drop' as never })

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  // Binding should NOT be deleted, conversation id should be preserved
  assert.ok(argv.includes('--conversation'))
  assert.equal(argv[argv.indexOf('--conversation') + 1], initialConvId)
  assert.equal(store.get('sess-minor-drop')?.lastMessageCount, 14)
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

test('identical prompt while a live run owns the session is rejected with BUSY (issue #33)', async () => {
  const prevDelay = process.env.FAKE_AGY_DELAY_MS
  const { adapter } = makeAdapter()
  const userMsg = msg('user', 'Please perform task X')
  const sessionOptions = opts([userMsg], { sessionId: 'sess-dup-test' as never })

  try {
    // Keep the first agy child alive long enough for the second submission
    // to observe a live run (a long tool is silent for minutes — issue #33).
    process.env.FAKE_AGY_DELAY_MS = '400'
    const iter1 = adapter.stream(sessionOptions)[Symbol.asyncIterator]()
    const firstChunkPromise = iter1.next()
    // Let stream() spawn and register the live run; do NOT wait for output.
    await new Promise((r) => setTimeout(r, 80))

    // Identical retry must NOT preempt/kill the live long tool — BUSY only.
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

    // Drain first stream so it finishes cleanly.
    const first = await firstChunkPromise
    if (!first.done) {
      while (!(await iter1.next()).done) {}
    }
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_AGY_DELAY_MS
    else process.env.FAKE_AGY_DELAY_MS = prevDelay
  }
})

test('retry after a settled failure is not blocked by debounce (issue #32)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'exit-error'
  try {
    const { adapter } = makeAdapter()
    const userMsg = msg('user', 'Please perform task X')
    const sessionOptions = opts([userMsg], { sessionId: 'sess-retry-after-fail' as never })

    // First attempt fails the way a fast agy error does (exit 1 + envelope).
    const res1 = await collect(adapter.stream(sessionOptions))
    const finish1 = res1[res1.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish1.type, 'finish')
    assert.equal(finish1.reason.kind, 'error')

    // DSH auto-retries the same prompt. A time-only debounce wall used to
    // swallow this as BUSY; settled runs must not block the retry.
    process.env.FAKE_AGY_MODE = 'ok'
    const res2 = await collect(adapter.stream(sessionOptions))
    const finish2 = res2[res2.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish2.type, 'finish')
    assert.notEqual(finish2.reason.kind, 'error', 'retry must not surface Duplicate/BUSY')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a NEW (steered) prompt preempts a live run instead of debouncing', async () => {
  const prevDelay = process.env.FAKE_AGY_DELAY_MS
  const { adapter } = makeAdapter()
  const firstMsg = msg('user', 'Please perform task X')
  const steeredMsg = msg('user', 'Actually please perform task Y instead')
  try {
    process.env.FAKE_AGY_DELAY_MS = '400'
    const iter1 = adapter.stream(opts([firstMsg], { sessionId: 'sess-steer-same' as never }))[Symbol.asyncIterator]()
    const firstChunkPromise = iter1.next()
    await new Promise((r) => setTimeout(r, 80))

    // Different prompt = mid-turn steer: abort the predecessor and run.
    process.env.FAKE_AGY_DELAY_MS = '0'
    const res2 = await collect(adapter.stream(opts([steeredMsg], { sessionId: 'sess-steer-same' as never })))
    const finish2 = res2[res2.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish2.type, 'finish')
    assert.notEqual(finish2.reason.kind, 'error', 'steering turn must not be BUSY')

    try {
      const first = await firstChunkPromise
      if (!first.done) {
        while (!(await iter1.next()).done) {}
      }
    } catch { /* aborted runs may reject; that's fine */ }
  } finally {
    if (prevDelay === undefined) delete process.env.FAKE_AGY_DELAY_MS
    else process.env.FAKE_AGY_DELAY_MS = prevDelay
  }
})

test('soft rate limit signal (model overloaded) becomes a retryable OVERLOADED and stays on current account', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const invocationFile = join(workDir, `invocations-overload-${Date.now()}.txt`)
  process.env.FAKE_AGY_MODE = 'real-fail'
  process.env.FAKE_AGY_INVOCATION_FILE = invocationFile
  const pool = new AccountPoolManager(join(workDir, `pool-soft-overload-${Date.now()}`))
  pool.createAccountSlot('Second')
  const initialActive = pool.getActiveAccountId('google')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const res = await runTurn(adapter, [msg('user', 'Say hello')], { sessionId: 'sess-ratelimit' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    // Server capacity refusals (model overloaded / 503 / 529): retryable OVERLOADED,
    // NO cooldown (nothing spent locally), and STAYS on current account to prevent
    // cascading load onto healthy backup accounts.
    assert.equal(finish.reason.failure?.code, Err.OVERLOADED)
    assert.ok(finish.reason.failure?.message.includes('rate limit'))
    assert.ok(adapter.providerRetryPolicy('agy').retryableCodes.includes(Err.OVERLOADED), 'overload must be retryable')
    const spawns = readFileSync(invocationFile, 'utf8').split('\n').filter(Boolean).length
    assert.ok(spawns >= 2, `expected a failover spawn, got ${spawns}`)
    assert.equal(pool.getActiveAccountId('google'), initialActive, 'capacity overload must stay on current account, not rotate')
    for (const acc of pool.getAccounts()) {
      assert.equal(acc.cooldowns.google, undefined, 'a capacity signal must never cool an account down')
    }
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
    delete process.env.FAKE_AGY_INVOCATION_FILE
  }
})

test('transport-shaped auth failure is NETWORK (retryable) instead of AUTH', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth-network'
  const pool = new AccountPoolManager(join(workDir, 'pool-auth-network'))
  const second = pool.createAccountSlot('Second')
  const initialActive = pool.getActiveAccountId('google')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-network' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    // agy says "not logged into Antigravity" whenever it cannot VALIDATE a good
    // token. Reporting AUTH there ends the turn on a healthy account and DSH
    // renders that code as "API key is invalid" — the live 2026-10-10 bug.
    assert.equal(finish.reason.failure?.code, Err.NETWORK)
    assert.ok(/transport failure/i.test(finish.reason.failure?.message ?? ''), finish.reason.failure?.message)
    const primary = pool.getAccounts()[0]!
    assert.equal(primary.authRequired, undefined, 'a transport blip must never flag the account for re-login')
    // No account owns a proxy here: every account leaves through the same
    // egress, so rotating the sticky pointer only repoints the session and
    // spends the rotation budget a real quota/eligibility hop needs.
    assert.equal(pool.getActiveAccountId('google'), initialActive, 'a shared-egress blip must stay on the current account')
    assert.notEqual(pool.getActiveAccountId('google'), second.id, 'the shared-egress blip must not hop accounts')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a transport failure rotates when accounts leave through different proxies', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth-network'
  const pool = new AccountPoolManager(join(workDir, `pool-auth-network-split-${Date.now()}`))
  const second = pool.createAccountSlot('Second')
  // A per-account proxy makes the egress account-scoped: this account's route
  // to Google can be broken while the next account's route is fine.
  pool.setAccountProxy(second.id, 'socks5://127.0.0.1:7890')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-network-split' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    assert.equal(finish.reason.failure?.code, Err.NETWORK)
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id, 'a distinct egress must hand the retry to the other account')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('transport failures ask DSH for a 5s/15s/30s backoff that resets after a success', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const { adapter } = makeAdapter()
  const sessionId = 'sess-network-backoff'
  const failureDelay = async (): Promise<number | undefined> => {
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: sessionId as never })))
    const finish = chunks[chunks.length - 1] as {
      type: string
      reason: { kind: string; failure?: { code: string; providerRetryAfterMs?: number } }
    }
    assert.equal(finish.reason.failure?.code, Err.NETWORK, JSON.stringify(finish.reason.failure))
    return finish.reason.failure?.providerRetryAfterMs
  }
  try {
    // A 14-minute egress outage outlives any short exponential backoff, so the
    // adapter states the delay it wants instead of letting 2s/4s burn the
    // whole retry budget inside four seconds (live 2026-10-21 16:43).
    process.env.FAKE_AGY_MODE = 'auth-network'
    assert.equal(await failureDelay(), 5_000)
    assert.equal(await failureDelay(), 15_000, 'the second consecutive transport failure waits longer')
    assert.equal(await failureDelay(), 30_000)
    assert.equal(await failureDelay(), 30_000, 'the schedule caps instead of escalating forever')

    process.env.FAKE_AGY_MODE = 'ok'
    const ok = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: sessionId as never })))
    // An `ok` run may cut on a mirrored tool step; what matters is that the run
    // SETTLED successfully, which is what clears the transport streak.
    assert.notEqual((ok[ok.length - 1] as { reason: { kind: string } }).reason.kind, 'error', 'the healthy run must settle')

    process.env.FAKE_AGY_MODE = 'auth-network'
    assert.equal(await failureDelay(), 5_000, 'a success resets the transport streak')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a keyring-auth timeout in agy\'s own log is NETWORK, never a sticky AUTH quarantine', async () => {
  // The live 2026-10-16 bug: the stderr banner is byte-identical to a real
  // sign-out, but agy's log shows `keyringAuth: timed out after 10s` — proof a
  // stored credential existed and only the network was down.
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth-jitter'
  const pool = new AccountPoolManager(join(workDir, 'pool-auth-jitter'))
  const slot = pool.createAccountSlot('Jitter')
  pool.setAccountEnabled('acc_primary', false)
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-jitter' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure?.code, Err.NETWORK, JSON.stringify(finish.reason.failure))
    assert.ok(/keyring auth timing out/.test(finish.reason.failure?.message ?? ''), finish.reason.failure?.message)
    const flagged = pool.getAccount(slot.id)!
    assert.equal(flagged.authRequired, undefined, 'jitter must never sticky-quarantine the account')
    assert.equal(pool.getPoolData().lastActiveAccountId, slot.id === flagged.id ? slot.id : pool.getPoolData().lastActiveAccountId)
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a bare "not signed in" banner does not sticky-quarantine on the first occurrence', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'auth'
  const pool = new AccountPoolManager(join(workDir, 'pool-auth-confirm'))
  const slot = pool.createAccountSlot('Ambiguous')
  pool.setAccountEnabled('acc_primary', false)
  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-auth-confirm' as never })))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    // The turn still fails with the accurate AUTH diagnosis…
    assert.equal(finish.reason.failure?.code, Err.AUTH)
    // …but one banner is not proof of a dead login, so no sticky flag yet.
    assert.equal(pool.getAccount(slot.id)!.authRequired, undefined, 'a single ambiguous AUTH must not hard-quarantine')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
  }
})

test('a post-tool quota failure fails over inside the same step (no dead replay)', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const invocationFile = join(workDir, `invocations-${Date.now()}.txt`)
  process.env.FAKE_AGY_MODE = 'quota-once'
  process.env.FAKE_AGY_INVOCATION_FILE = invocationFile
  const pool = new AccountPoolManager(join(workDir, `pool-post-tool-${Date.now()}`))
  const second = pool.createAccountSlot('Second')
  try {
    const { adapter } = makeAdapter({}, { pool })
    // quota-once spends the FIRST account after a tool step, so the failure
    // surfaces in the tool-continuation span. That span used to be re-driven
    // from the settled recording and re-emit the identical failure, ending the
    // turn while a healthy account was idle.
    const res = await runTurn(adapter, [msg('user', 'count the files')], { sessionId: 'sess-post-tool' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop', 'the surviving account must answer instead of the turn failing')
    const spawns = readFileSync(invocationFile, 'utf8').split('\n').filter(Boolean).length
    assert.equal(spawns, 2, 'exactly one failover spawn')
    const primary = pool.getAccounts()[0]!
    assert.ok((primary.cooldowns.google?.cooldownUntil ?? 0) > Date.now(), 'the spent account must be cooled')
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id, 'the failover spawn must use the next account')
  } finally {
    process.env.FAKE_AGY_MODE = prevMode
    delete process.env.FAKE_AGY_INVOCATION_FILE
  }
})

test('quota exhaustion and timeouts are retried so the next account can serve them', () => {
  const { adapter } = makeAdapter()
  const policy = adapter.providerRetryPolicy('agy')
  // Quota exhaustion was a dead end before: the account cooled down and the
  // sticky pointer advanced, but no retry was ever attempted.
  assert.ok(policy.retryableCodes.includes(Err.RATE_LIMIT), 'rate limit must retry onto the next account')
  assert.ok(policy.retryableCodes.includes(Err.TIMEOUT), 'silent timeouts must retry onto the next account')
  assert.ok(policy.retryableCodes.includes(Err.NETWORK), 'transport failures must retry (same account when the egress is shared)')
  assert.ok(!(policy.retryableCodes as readonly string[]).includes(Err.AGY_ERROR), 'deterministic AGY_ERRORs stay single-shot')
  // The budget must outlast the 5s/15s/30s transport schedule: an egress
  // outage that spans minutes used to die after two retries inside 4 seconds
  // (live 2026-10-21 16:43), so a lone account gets the same three hops.
  assert.equal(policy.maxRetries, NETWORK_RETRY_DELAYS_MS.length)
  assert.ok(!(policy.retryableCodes as readonly string[]).includes(Err.AUTH), 'a lone account cannot fail over a sign-out')
})

test('the retry policy can carry the whole transport backoff schedule', () => {
  const { adapter } = makeAdapter()
  const policy = adapter.providerRetryPolicy('agy')
  // A provider delay ABOVE maxDelayMs makes the retry plugin refuse the retry
  // outright (normal mode returns without scheduling), so the cap must sit at
  // or past the longest transport delay.
  assert.ok(policy.maxDelayMs >= 30_000, `maxDelayMs ${policy.maxDelayMs} would discard the 30s transport delay`)
  assert.ok(policy.maxRetries >= NETWORK_RETRY_DELAYS_MS.length)
  // Non-transport retries keep their short first delay: only NETWORK states a
  // provider delay, everything else still backs off from 2s.
  assert.equal(policy.initialDelayMs, 2_000)
})

test('the retry budget follows the pool so a 3-account pool fails over twice', () => {
  const pool = new AccountPoolManager(join(workDir, `pool-retry-budget-${Date.now()}`))
  pool.createAccountSlot('Second')
  pool.createAccountSlot('Third')
  const { adapter } = makeAdapter({}, { pool })
  const policy = adapter.providerRetryPolicy('agy')
  // With one spare account a stale-token second account turned the single retry
  // into a dead end (live 2026-10-10: primary ELIGIBILITY → g98 "not signed in"
  // → turn lost). The budget must cover the pool…
  assert.equal(policy.maxRetries, NETWORK_RETRY_DELAYS_MS.length)
  assert.ok(policy.retryableCodes.includes(Err.AUTH), 'with a spare account a sign-out can continue on the next one')
  assert.ok(policy.retryableCodes.includes(Err.ELIGIBILITY))
  assert.ok(policy.retryableCodes.includes(Err.OVERLOADED))
})

test('hard quota refusal cools the spent account and hands the retry to the next one', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  process.env.FAKE_AGY_MODE = 'real-quota'
  const pool = new AccountPoolManager(join(workDir, 'pool-hard-quota'))
  const second = pool.createAccountSlot('Second')
  try {
    const { adapter } = makeAdapter({}, { pool })
    const res = await runTurn(adapter, [msg('user', 'hi')], { sessionId: 'sess-hard-quota' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure?.code, Err.RATE_LIMIT, 'hard quota must use the retryable code')
    const primary = pool.getAccounts()[0]!
    // Spent account left rotation...
    assert.ok((primary.cooldowns.google?.cooldownUntil ?? 0) > Date.now(), 'hard quota must cool the account down')
    // ...and the pointer already moved on, so the retry lands on the next one.
    assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
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
  assert.ok(elapsed < 15_000, `elapsed ${elapsed}ms exceeded 15000ms`)
})

test('auto-review calls with REVIEW_POLICY do not cut on tools and finish with stop', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const chunks = await collect(
    adapter.stream(
      opts([msg('user', 'review')], {
        system: 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.',
      }),
    ),
  )
  const toolCallChunks = chunks.filter(
    (c) =>
      (c.type === 'block-start' && (c as { blockType?: string }).blockType === 'tool-call') ||
      (c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call'),
  )
  assert.equal(toolCallChunks.length, 0)
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('calls with explicit empty tools: [] do not cut on tools and finish with stop', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const chunks = await collect(
    adapter.stream(
      opts([msg('user', 'no tools')], {
        tools: [],
      }),
    ),
  )
  const toolCallChunks = chunks.filter(
    (c) =>
      (c.type === 'block-start' && (c as { blockType?: string }).blockType === 'tool-call') ||
      (c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call'),
  )
  assert.equal(toolCallChunks.length, 0)
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('stale continuation with missing run in memory falls back to fresh turn prompt assembly instead of failing', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const toolResult = (callId: string): Message =>
    ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'stale result' }] }], source: { kind: 'tool', callId } }) as never

  // Simulate a turn that begins on a trailing tool result from an evicted/restarted runId:
  const chunks = await collect(
    adapter.stream(
      opts([msg('user', 'original task before restart'), toolResult('agytc-missing-run-3')]),
    ),
  )
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  // First span cuts on agy's tool-call as designed, rather than hard-failing with AGY_ERROR:
  assert.equal(finish.reason.kind, 'tool-calls')

  // Verify that fresh process was spawned and prompt was assembled with the original task:
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const promptArg = argv[argv.length - 1]!
  assert.ok(promptArg.includes('original task before restart'), 'assembled prompt includes the user task')

  // Also verify that a full runTurn loop drives the healed conversation to completion:
  const turnResult = await runTurn(adapter, [msg('user', 'original task'), toolResult('agytc-missing-run-4')])
  const turnFinish = turnResult.chunks[turnResult.chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(turnFinish.reason.kind, 'stop')
})

test('isSyntheticHarnessMessage and latestUserTaskText skip timing and reminder telemetry', () => {
  const timeMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Time sampled while preparing turn 28, step 22: 2026-10-10T16:15:54+05:00[Indian/Maldives]' }],
    source: { kind: 'time-context' },
  } as unknown as Message
  const reminderMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nSkill guidelines: ...</system-reminder>' }],
    source: { kind: 'system-reminder' },
  } as unknown as Message
  const runtimeMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
    source: { kind: 'runtime-context' },
  } as unknown as Message
  const realMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: '请帮我实现战斗系统' }],
    source: { kind: 'user' },
  } as unknown as Message

  assert.equal(isSyntheticHarnessMessage(timeMsg), true)
  assert.equal(isSyntheticHarnessMessage(reminderMsg), true)
  assert.equal(isSyntheticHarnessMessage(runtimeMsg), true)
  assert.equal(isSyntheticHarnessMessage(realMsg), false)

  assert.equal(isRealUserMessage(timeMsg), false)
  assert.equal(isRealUserMessage(reminderMsg), false)
  assert.equal(isRealUserMessage(runtimeMsg), false)
  assert.equal(isRealUserMessage(realMsg), true)

  // Trailing time-context messages must never overwrite or become the user task
  const history: Message[] = [realMsg, timeMsg]
  assert.equal(latestUserTaskText(history), '请帮我实现战斗系统')
  assert.equal(latestUserTaskText([timeMsg]), '')
})

test('prompt assembly uses real user task instead of trailing time context', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const realMsg = msg('user', '换成激昂风格的背景音乐')
  const timeMsg = {
    role: 'user',
    content: [{ type: 'text', text: 'Time sampled while preparing turn 5, step 1: 2026-10-10T18:50:47+05:00' }],
    source: { kind: 'time-context' },
  } as unknown as Message

  await collect(adapter.stream(opts([realMsg, timeMsg], { sessionId: 'sess-real-task' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const promptArg = argv[argv.length - 1]!
  assert.ok(promptArg.includes('换成激昂风格的背景音乐'), 'real user task must be present in prompt')
  assert.ok(!promptArg.includes('Time sampled while preparing'), 'synthetic timing context must not be appended to agy prompt')
})

test('returning session prompt after an interrupted turn does not duplicate the interrupted prompt', async () => {
  const { adapter, argsFile, store } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // Simulate an interrupted turn that had reached agy conversation 'conv-interrupted-1'
  // and settled with messages.length = 2 and interrupted: true
  const msg1 = msg('user', 'task 1: create snake game')
  const msg2 = msg('user', 'task 2: add music (aborted mid-turn)')
  store.set('sess-interrupted:acc_primary', {
    conversationId: 'conv-interrupted-1',
    lastMessageCount: 2,
    updatedAt: Date.now(),
    model: 'gemini-3.7-flash',
    interrupted: true,
  })

  // Next turn: user asks for task 3
  const msg3 = msg('user', 'task 3: high score system')
  const msgs = [msg1, msg2, msg3]

  await collect(adapter.stream(opts(msgs, { sessionId: 'sess-interrupted' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const promptArg = argv[argv.length - 1]!

  assert.ok(promptArg.includes('task 3: high score system'), 'new prompt must contain task 3')
  assert.ok(!promptArg.includes('task 2: add music'), 'new prompt must NOT re-include the interrupted task 2')
  assert.ok(promptArg.includes('the previous turn was interrupted before it finished'), 'new prompt must carry the interruption boundary notice')
})

test('steered prompt carries interrupted notice so agy switches tasks immediately', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_DELAY_MS = '400'

  const firstMsg = msg('user', 'Initial long calculation')
  const steeredMsg = msg('user', 'Cancel that and tell me a joke')

  try {
    const iter1 = adapter.stream(opts([firstMsg], { sessionId: 'sess-steer-notice' as never }))[Symbol.asyncIterator]()
    const firstChunk = iter1.next()
    await new Promise((r) => setTimeout(r, 80))

    process.env.FAKE_AGY_DELAY_MS = '0'
    await collect(adapter.stream(opts([steeredMsg], { sessionId: 'sess-steer-notice' as never })))

    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const promptArg = argv[argv.length - 1]!
    assert.ok(promptArg.includes('Cancel that and tell me a joke'), 'steered task must be in prompt')
    assert.ok(promptArg.includes('the previous turn was interrupted before it finished'), 'steered prompt must have interruption boundary')

    try {
      const f = await firstChunk
      if (!f.done) {
        while (!(await iter1.next()).done) {}
      }
    } catch {}
  } finally {
    delete process.env.FAKE_AGY_DELAY_MS
  }
})

test('session sticks to current account across multiple turns and only switches when quota is exhausted', async () => {
  const pool = new AccountPoolManager(join(workDir, `pool-session-sticky-${Date.now()}`))
  const first = pool.getAccounts()[0]!
  const second = pool.createAccountSlot('Account B')

  const { adapter } = makeAdapter({}, { pool })
  const sessionId = 'sess-sticky-account-turns' as never

  // Turn 1 on first account
  const res1 = await runTurn(adapter, [msg('user', 'Hello turn 1')], { sessionId })
  assert.equal(res1.chunks[res1.chunks.length - 1]!.type, 'finish')
  assert.equal(pool.getPoolData().lastActiveAccountId, first.id)

  // Even if another account exists or was marked active by background or another session,
  // Turn 2 MUST stay on the first account because its quota is not exhausted!
  pool.markAccountActive(second.id)
  const res2 = await runTurn(
    adapter,
    [msg('user', 'Hello turn 1'), msg('assistant', 'Reply 1'), msg('user', 'Hello turn 2')],
    { sessionId },
  )
  assert.equal(res2.chunks[res2.chunks.length - 1]!.type, 'finish')
  assert.equal(pool.getPoolData().lastActiveAccountId, first.id, 'session must stick to first account while quota is healthy')

  // Now first account quota is exhausted (hits 429)
  pool.recordFailure(first.id, 'google', 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.')

  // Turn 3 must now switch to second account because first account quota is exhausted
  const res3 = await runTurn(
    adapter,
    [
      msg('user', 'Hello turn 1'),
      msg('assistant', 'Reply 1'),
      msg('user', 'Hello turn 2'),
      msg('assistant', 'Reply 2'),
      msg('user', 'Hello turn 3'),
    ],
    { sessionId },
  )
  assert.equal(res3.chunks[res3.chunks.length - 1]!.type, 'finish')
  assert.equal(pool.getPoolData().lastActiveAccountId, second.id, 'session must switch to second account once quota is exhausted')
})

test.after(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// --- NUL-byte hardening -----------------------------------------------------
// Live failure (2026-10-16): a tool result that quoted binary output (the agent
// had listed/read a `.git` directory) carried U+0000 into the assembled prompt,
// and `spawn(agy, args)` threw
//   ERR_INVALID_ARG_VALUE: The argument 'args[16]' must be a string without null bytes
// which failed the whole turn ("failed to spawn agy") before agy ever started.

test('stripNulBytes removes NUL bytes and keeps other whitespace intact', () => {
  assert.equal(stripNulBytes('a\u0000b'), 'ab')
  assert.equal(stripNulBytes('\u0000\u0000'), '')
  assert.equal(stripNulBytes('tab\tlf\ncr\r'), 'tab\tlf\ncr\r')
  assert.equal(stripNulBytes('plain text'), 'plain text')
})

test('buildDigest strips NUL bytes that arrive with binary tool output', () => {
  const messages = [
    msg('user', 'look at .git'),
    toolResultMsg({ nestedText: 'total 1996\n\u0000drwxr-xr-x 3 zand zand 4096 Oct 1 .\u0000' }),
    msg('assistant', 'ok'),
    msg('user', '这啥情况？'),
  ]
  const digest = buildDigest(messages, 0, 10_000)
  assert.ok(digest.includes('[conversation so far]'))
  assert.ok(!digest.includes('\u0000'), 'digest must be NUL-free')
  assert.ok(digest.includes('drwxr-xr-x 3 zand zand 4096 Oct 1'), 'text around the NUL survives')
})

test('a NUL byte in history cannot fail the turn with a spawn TypeError', async () => {
  const argsFile = join(workDir, `args-nul-${Date.now()}.json`)
  const prevArgs = process.env.FAKE_AGY_ARGS_FILE
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const { adapter } = makeAdapter()
    const history = [
      msg('user', 'look at .git'),
      toolResultMsg({ nestedText: 'total 1996\n\u0000drwxr-xr-x 3 zand zand 4096 Oct 1 .' }),
      msg('assistant', 'ok'),
      msg('user', '这啥情况？'),
    ]
    const res = await runTurn(adapter, history, { sessionId: 'sess-nul' as never })
    const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { message?: string } } }
    assert.equal(finish.type, 'finish')
    assert.notEqual(finish.reason.kind, 'error', 'the turn must survive NUL-bearing tool output')
    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    assert.ok(Array.isArray(argv) && argv.length > 0, 'fake agy must have been spawned')
    assert.ok(argv.every((a) => typeof a === 'string' && !a.includes('\u0000')), 'no argv element may contain a NUL')
  } finally {
    if (prevArgs === undefined) delete process.env.FAKE_AGY_ARGS_FILE
    else process.env.FAKE_AGY_ARGS_FILE = prevArgs
  }
})
