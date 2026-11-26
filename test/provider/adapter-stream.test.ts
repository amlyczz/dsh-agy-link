// Span protocol against the fake agy binary: native tool mirroring
// (finish:tool-calls + continuation), Stop mid-flight, the finish/error
// mapping table (result error, exit code, auth, garbage), the synthetic
// bridge calls (prepareCall / update_goal), and the turn wall-clock cap.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../../src/host/adapter.ts'
import { ModelCatalog } from '../../src/host/models.ts'
import { defaultConfig, Err } from '../../src/common/types.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { classifyToolError, RunRegistry } from '../../src/host/recording.ts'
import { defineAgyMirrorTool } from '../../src/host/mirror-tool.ts'
import { collect, makeAdapter, msg, opts, runTurn, waitFor, workDir } from '../helpers/adapter-fixtures.ts'

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

test('maxTurnMinutes terminates a self-driving turn that never goes idle (issue #92)', async () => {
  const { adapter } = makeAdapter({ maxTurnMinutes: 0.02 }) // 1.2 s wall-clock cap
  process.env.FAKE_AGY_MODE = 'hang'
  const started = Date.now()
  try {
    const chunks = await collect(adapter.stream(opts([msg('user', 'loop forever')])))
    const blob = JSON.stringify(chunks)
    assert.ok(blob.includes('maxTurnMinutes'), 'the cap message is surfaced to the caller')
    assert.ok(Date.now() - started < 8_000, 'the cap fires well before an idle timeout would')
  } finally {
    delete process.env.FAKE_AGY_MODE
  }
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

test('stale completed goal: a later human turn no longer re-emits update_goal', async () => {
  // 2026-11-07: after goal-a88ea83e completed, every agy turn still ended with
  // the same synthetic update_goal call id; switching to an HTTP provider then
  // failed with `400 Duplicate 'call_id'`. The live goal view says "none".
  process.env.FAKE_AGY_MODE = 'ok'
  const { adapter } = makeAdapter({}, { sessionGoal: () => null })
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: '<goal_round>\nObjective: "X"\nRound: 1/4\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'goal-stale', revision: 2, round: 1 },
    } as unknown as Message,
    {
      role: 'tool',
      toolCallId: 'agytc-bridge-goal-goal-stale-2',
      content: 'Error: cannot complete goal "goal-stale" from phase "complete"',
    } as unknown as Message,
    msg('user', '现在回答另一个问题'),
  ]

  const chunks = await collect(
    adapter.stream(
      opts(messages, {
        sessionId: 'sess-stale-goal' as never,
        tools: [{ name: 'update_goal' }] as never,
      }),
    ),
  )
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
  const synthetic = chunks.find(
    (c) => c.type === 'block-end' && (c as { block?: { name?: string } }).block?.name === 'update_goal',
  )
  assert.equal(synthetic, undefined, 'must not synthesize update_goal for an inactive goal')
})

test('goal round with a live active goal emits update_goal with the live revision', async () => {
  process.env.FAKE_AGY_MODE = 'ok'
  const { adapter } = makeAdapter({}, { sessionGoal: () => ({ goalId: 'goal-live', revision: 5 }) })
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: '<goal_round>\nObjective: "Y"\nRound: 2/4\n</goal_round>' }],
      source: { kind: 'goal', goalId: 'goal-live', revision: 1, round: 2 },
    } as unknown as Message,
  ]

  const chunks = await collect(
    adapter.stream(
      opts(messages, {
        sessionId: 'sess-live-goal' as never,
        tools: [{ name: 'update_goal' }] as never,
      }),
    ),
  )
  const end = chunks.find(
    (c) => c.type === 'block-end' && (c as { block?: { name?: string } }).block?.name === 'update_goal',
  ) as unknown as { block: { id: string; arguments: string } } | undefined
  assert.ok(end, 'active goal round must still complete the goal')
  const args = JSON.parse(end.block.arguments)
  assert.equal(args.goal_id, 'goal-live')
  assert.equal(args.revision, 5, 'live revision wins over the stale one in history')
  assert.equal(args.action, 'complete')
})

test('chat diagnostics identify disabled settings, deduplicate reordered tools, and clear after recovery', async () => {
  const cfg = { ...defaultConfig(), forwardSystemPrompt: false }
  const logs: string[] = []
  const { adapter } = makeAdapter({}, { getConfig: () => cfg, log: msg => logs.push(msg) })
  const stream = (names: string[]) => collect(adapter.stream(opts([msg('user', 'hello')], {
    tools: names.map(name => ({ name, description: '', parameters: {} })),
  })))
  const warnings = () => logs.filter(msg => msg.includes('DSH host tools'))
  await stream(['read', 'agy_tool', 'bash'])
  assert.equal(adapter.bridgeDiagnostic, null)
  assert.equal(warnings().length, 0)
  for (const names of [['send_message', 'read_ticket', 'bash'], ['read_ticket', 'send_message', 'send_message']]) await stream(names)
  assert.deepEqual(adapter.bridgeDiagnostic, { hostTools: ['read_ticket', 'send_message'], disabledSettings: ['mcpBridge', 'forwardSystemPrompt'] })
  assert.equal(warnings().length, 1)
  assert.match(warnings()[0]!, /read_ticket.*send_message.*mcpBridge=false.*forwardSystemPrompt=false/)
  cfg.mcpBridge = true
  await stream(['run_code'])
  assert.deepEqual(adapter.bridgeDiagnostic, { hostTools: ['run_code'], disabledSettings: ['forwardSystemPrompt'] })
  cfg.forwardSystemPrompt = true
  cfg.mcpBridge = false
  await stream(['read_ticket'])
  assert.deepEqual(adapter.bridgeDiagnostic, { hostTools: ['read_ticket'], disabledSettings: ['mcpBridge'] })
  cfg.mcpBridge = true
  await stream(['read_ticket'])
  assert.equal(adapter.bridgeDiagnostic, null)
  assert.equal(warnings().length, 3)
})
