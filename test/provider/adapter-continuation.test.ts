// Continuation detection and conversation binding: which trailing spans
// resume the live agy process, when a binding is reused / invalidated
// (compaction, model switch, interruption), and the watermarked digest a
// returning session sends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Message } from '@deepseek-ai/dsh-llm'
import { detectContinuation, hasNewHumanTask, isSyntheticHarnessMessage, latestUserTaskText } from '../../src/host/adapter.ts'
import { RunRegistry } from '../../src/host/recording.ts'
import { INTERRUPTION_NOTICE, promptIdentity } from '../../src/provider/prompt-identity.ts'
import { collect, makeAdapter, msg, msgSrc, opts, runTurn, toolResultMsg, waitFor, workDir } from '../helpers/adapter-fixtures.ts'

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

test('a Stop mid-flight marks the binding interrupted and the next prompt carries the boundary', async () => {
  const prevMode = process.env.FAKE_AGY_MODE
  const prevDelay = process.env.FAKE_AGY_DELAY_MS
  process.env.FAKE_AGY_MODE = 'slow-init'
  // Wide enough that the abort always lands BEFORE the fake result: at 300ms a
  // coverage-instrumented run could spawn, stream, and finish inside the window,
  // which wrote a successful (non-interrupted) binding and made this flake.
  process.env.FAKE_AGY_DELAY_MS = '3000'
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
  const { chunks } = await runTurn(adapter, [
    msg('assistant', '[compacted summary of m1-m3]'),
    msg('user', 'new question after compaction'),
  ], { sessionId: 'sess-compact' as never })

  const cardChunk = chunks.find((c) => c.type === 'text-delta' && ((c as { text?: string }).text?.includes('agy-compaction-card') || (c as { text?: string }).text?.includes('#agy-compaction')))
  assert.ok(cardChunk !== undefined, 'Turn 2 must emit compaction card marker')

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
    model: 'gemini-3.8-flash',
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

test('issue #138: DSH context messages never make a tool continuation look like a user steer', () => {
  const toolResult = (callId: string): Message =>
    ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [] }], source: { kind: 'tool', callId } }) as never
  const expected = { runId: 'run-1', eventIndex: 7 }
  // DSH 0.2.2 producers each use their OWN kind: there is no catch-all "plugin".
  const timeContext = { role: 'user', content: [], source: { kind: 'time-context', form: 'snapshot' } } as unknown as Message
  const agentInstructions = { role: 'user', content: [{ type: 'text', text: 'Updated instructions from: AGENTS.md' }], source: { kind: 'agent-instructions', form: 'instructions' } } as unknown as Message
  const memoryNotice = { role: 'user', content: [{ type: 'text', text: 'recalled memory' }], source: { kind: 'plugin:memory', form: 'notice' } } as unknown as Message

  assert.deepEqual(detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7'), timeContext]), expected,
    'a time-context snapshot must not break the continuation')
  assert.deepEqual(detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7'), agentInstructions]), expected,
    'an AGENTS.md refresh must not break the continuation')
  assert.deepEqual(detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7'), memoryNotice]), expected,
    'a plugin:<name> notice must not break the continuation')
  assert.deepEqual(
    detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7'), timeContext, agentInstructions, memoryNotice]),
    expected,
    'several context messages in a row still continue',
  )
  // A real typed message still ends the scan: it IS a new request.
  assert.equal(detectContinuation([toolResult('agytc-run-1-7'), msg('user', '补充一点：先写草稿')]), null)
})

test('issue #205: system/developer tail messages do not hide a tool continuation', () => {
  const toolResult = (callId: string): Message =>
    ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [] }], source: { kind: 'tool', callId } }) as never
  const systemTail = { role: 'system', content: [{ type: 'text', text: 'tool-registry refresh' }] } as unknown as Message
  const developerTail = { role: 'developer', content: [{ type: 'text', text: 'system prompt update' }] } as unknown as Message
  const expected = { runId: 'run-1', eventIndex: 7 }

  assert.deepEqual(detectContinuation([toolResult('agytc-run-1-7'), systemTail]), expected,
    'a system-prompt refresh after the tool result must not break continuation detection')
  assert.deepEqual(detectContinuation([toolResult('agytc-run-1-7'), developerTail, systemTail]), expected,
    'a developer/tool-registry tail is harness context, not a human boundary')
  assert.equal(detectContinuation([systemTail]), null, 'a system message alone is never a continuation')
  assert.equal(detectContinuation([toolResult('agytc-run-1-7'), msg('user', 'new ask'), systemTail]), null,
    'a real human ask must still end the scan even when a system message follows it')
})

test('issue #205: prompt identity ignores the interruption notice, and lifecycle hops are not steers', () => {
  const base = '/plan do the thing'
  assert.equal(promptIdentity(INTERRUPTION_NOTICE + '\n\n' + base), promptIdentity(base))
  // Behind a leading slash command the notice is appended at the END.
  assert.equal(promptIdentity('/plan\n\ndo the thing\n\n' + INTERRUPTION_NOTICE), promptIdentity('/plan\n\ndo the thing'))

  const toolResult = { role: 'user', content: [{ type: 'tool-result', toolCallId: 'agytc-run-1-7', content: [] }], source: { kind: 'tool', callId: 'agytc-run-1-7' } } as unknown as Message
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'working' }] } as unknown as Message
  const timeContext = { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }], source: { kind: 'time-context' } } as unknown as Message
  const mnemon = { role: 'user', content: [{ type: 'text', text: 'memory snapshot' }], source: { kind: 'dsh-mnemon' } } as unknown as Message
  const systemTail = { role: 'system', content: [{ type: 'text', text: 'tool-registry' }] } as unknown as Message

  assert.equal(hasNewHumanTask([msg('user', 'task'), assistant, toolResult]), false, 'a tool result is a continuation')
  assert.equal(hasNewHumanTask([msg('user', 'task'), assistant, toolResult, systemTail]), false, 'harness context is not a steer')
  assert.equal(hasNewHumanTask([msg('user', 'task'), assistant, timeContext]), false, 'time telemetry is not a steer')
  assert.equal(hasNewHumanTask([msg('user', 'task'), assistant, mnemon]), false, 'a memory snapshot is not a typed task')
  assert.equal(hasNewHumanTask([msg('user', 'task'), assistant, msg('user', 'new ask')]), true, 'a typed message IS a steer')
})

test('working-context, DSH 0.2.2 snapshot/catalog forms, and built-in harness kinds do not break detectContinuation', () => {
  const userToolResult = (callId: string): Message =>
    ({ role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [] }], source: { kind: 'tool', callId } }) as never
  const toolRoleResult = (callId: string): Message =>
    ({ role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }) as never
  const expected = { runId: 'run-1', eventIndex: 7 }
  const humanTask = { role: 'user', content: [{ type: 'text', text: 'fix the bridge' }], source: { kind: 'user' } } as unknown as Message

  const workingCtxBare = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: in progress: Clone repo]' }],
    source: { kind: 'working-context' },
  } as unknown as Message
  const workingCtxPrefixed = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: plan mode: on | in progress: Edit file]' }],
    source: { kind: 'preset-working-context' },
  } as unknown as Message
  const customWorkingCtx = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: in progress: Step A]' }],
    source: { kind: 'team-working-context' },
  } as unknown as Message
  const customToolCatalog = {
    role: 'user',
    content: [{ type: 'text', text: 'Available tools' }],
    source: { kind: 'team-tool-catalog' },
  } as unknown as Message
  const workingCtxArbitraryNonUser = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: in progress: Step B]' }],
    source: { kind: 'custom-preset-context' },
  } as unknown as Message
  const workingCtxNoSource = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: in progress: Step C]' }],
  } as unknown as Message
  const tmuxSnapshot = {
    role: 'user',
    content: [{ type: 'text', text: 'tmux pane status' }],
    source: { kind: 'tmux-context', form: 'snapshot', sections: [] },
  } as unknown as Message
  const customSnapshot = {
    role: 'user',
    content: [{ type: 'text', text: 'snapshot state' }],
    source: { kind: 'custom-state-producer', form: 'snapshot', sections: [] },
  } as unknown as Message
  const customCatalog = {
    role: 'user',
    content: [{ type: 'text', text: 'catalog listing' }],
    source: { kind: 'custom-catalog-producer', form: 'catalog' },
  } as unknown as Message
  const builtinKinds = ['working-directory', 'ptc-mode', 'repeat-tool-reminder', 'user-approval'].map((kind) => ({
    role: 'user',
    content: [{ type: 'text', text: `notice from ${kind}` }],
    source: { kind },
  }) as unknown as Message)

  for (const m of [
    workingCtxBare,
    workingCtxPrefixed,
    customWorkingCtx,
    customToolCatalog,
    workingCtxArbitraryNonUser,
    workingCtxNoSource,
    tmuxSnapshot,
    customSnapshot,
    customCatalog,
    ...builtinKinds,
  ]) {
    assert.equal(isSyntheticHarnessMessage(m), true, `expected synthetic for ${JSON.stringify((m as { source?: unknown }).source)}`)
    assert.deepEqual(detectContinuation([humanTask, userToolResult('agytc-run-1-7'), m]), expected)
    assert.deepEqual(detectContinuation([humanTask, toolRoleResult('agytc-run-1-7'), m]), expected)
    assert.equal(latestUserTaskText([humanTask, m]), 'fix the bridge')
  }

  // An explicit human message starting with "[Working Context:" must NOT be treated as synthetic.
  const humanQuotingWorkingContext = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: in progress: quoted by user]' }],
    source: { kind: 'user' },
  } as unknown as Message
  assert.equal(isSyntheticHarnessMessage(humanQuotingWorkingContext), false)
  assert.equal(detectContinuation([humanTask, toolRoleResult('agytc-run-1-7'), humanQuotingWorkingContext]), null)

  // Actionable non-user sources must remain non-synthetic and still end continuation scans.
  const actionableSources: Message[] = [
    { role: 'user', content: [{ type: 'text', text: '<goal_round>...</goal_round>' }], source: { kind: 'goal' } } as unknown as Message,
    { role: 'user', content: [{ type: 'text', text: 'timer fired' }], source: { kind: 'schedule' } } as unknown as Message,
    { role: 'user', content: [{ type: 'text', text: 'webhook payload' }], source: { kind: 'webhook', form: 'notice', summary: 'wh' } } as unknown as Message,
    { role: 'user', content: [{ type: 'text', text: 'subagent done' }], source: { kind: 'subagent-settled', form: 'notice', summary: 'done' } } as unknown as Message,
    { role: 'user', content: [{ type: 'text', text: 'wake up' }], source: { kind: 'plugin:agy-link', form: 'notice', summary: 'wake' } } as unknown as Message,
    { role: 'user', content: [{ type: 'text', text: 'Recalled memory snapshot' }], source: { kind: 'dsh-mnemon' } } as unknown as Message,
  ]
  for (const m of actionableSources) {
    assert.equal(isSyntheticHarnessMessage(m), false, `must not treat ${(m as { source?: { kind?: string } }).source?.kind} as synthetic`)
    assert.equal(detectContinuation([humanTask, toolRoleResult('agytc-run-1-7'), m]), null)
  }
})

test('live run continues without abort or replacement when working-context follows a mirrored tool result', async () => {
  let acpSpawns = 0
  let aborted = false
  const prompts: string[] = []
  let activeRec: ReturnType<RunRegistry['create']> | undefined
  let releaseSlot: (() => void) | undefined
  let unregisterRun: (() => void) | undefined
  let clearPrompt: (() => void) | undefined

  const { adapter } = makeAdapter(
    { transport: 'acp' },
    {
      runAcp: async (deps, input, slot) => {
        acpSpawns += 1
        prompts.push(input.prompt)
        const rec = deps.runs.create()
        activeRec = rec
        rec.requestAbort = () => {
          aborted = true
          slot.releaseOnce()
          deps.unregisterActiveRun(input.sessionKey, rec)
          deps.clearInFlightPrompt(input.sessionKey, input.prompt)
          rec.settle({ kind: 'aborted', code: 'ABORTED', message: 'aborted' })
        }
        deps.registerActiveRun(input.sessionKey, rec)
        releaseSlot = () => slot.releaseOnce()
        unregisterRun = () => deps.unregisterActiveRun(input.sessionKey, rec)
        clearPrompt = () => deps.clearInFlightPrompt(input.sessionKey, input.prompt)
        rec.append({ kind: 'init', conversationId: 'conv-wc-live-1', raw: {} })
        rec.append({
          kind: 'step',
          stepKey: '1',
          stepKind: 'tool',
          state: 'DONE',
          text: '',
          tool: {
            name: 'update_steps',
            args: { steps: [{ title: 'Clone repo', status: 'in_progress' }] },
            output: 'OK',
          },
        })
        return rec
      },
    },
  )

  const sessionId = 'sess-wc-live-cont' as never
  const userMsg = { role: 'user', content: [{ type: 'text', text: 'Implement fix' }], source: { kind: 'user' } } as unknown as Message
  const hop1Chunks = await collect(adapter.stream(opts([userMsg], { sessionId })))
  const hop1Finish = hop1Chunks[hop1Chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(hop1Finish.reason.kind, 'tool-calls')

  const toolEnd = hop1Chunks.find(
    (c) => c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call',
  ) as unknown as { block: { id: string; type: 'tool-call'; name: string; arguments: string } }
  assert.ok(toolEnd, 'hop 1 must emit a mirrored tool-call block')
  assert.equal(activeRec?.isSettled, false, 'run must stay live across the mirrored tool-call')

  const assistantToolCall = { role: 'assistant', content: [toolEnd.block] } as unknown as Message
  const toolResult = {
    role: 'tool',
    toolCallId: toolEnd.block.id,
    content: [{ type: 'text', text: 'OK' }],
  } as unknown as Message
  const workingContext = {
    role: 'user',
    content: [{ type: 'text', text: '[Working Context: in progress: Clone repo]' }],
    source: { kind: 'preset-working-context' },
  } as unknown as Message

  const hop2Promise = collect(
    adapter.stream(opts([userMsg, assistantToolCall, toolResult, workingContext], { sessionId })),
  )
  await new Promise((r) => setTimeout(r, 25))
  activeRec!.append({ kind: 'step', stepKey: '2', stepKind: 'text', state: 'DONE', text: 'Continued cleanly' })
  activeRec!.append({
    kind: 'result',
    conversationId: 'conv-wc-live-1',
    ok: true,
    response: 'Continued cleanly',
    usage: { input_tokens: 10, output_tokens: 5 },
    raw: {},
  })
  releaseSlot?.()
  unregisterRun?.()
  clearPrompt?.()
  activeRec!.settle(null)

  const hop2Chunks = await hop2Promise
  const hop2Finish = hop2Chunks[hop2Chunks.length - 1] as { type: string; reason: { kind: string } }
  const replyText = hop2Chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => (c as unknown as { text: string }).text)
    .join('')

  assert.equal(acpSpawns, 1, 'must continue existing live run without spawning a replacement')
  assert.equal(aborted, false, 'must NOT abort the live run when working-context arrives')
  assert.equal(prompts.length, 1)
  assert.equal(prompts.some((p) => p.includes('the previous turn was interrupted')), false)
  assert.equal(hop2Finish.reason.kind, 'stop')
  assert.match(replyText, /Continued cleanly/)
})

test('issue #207: immediate retry after Stop on a dying activeRun waits cleanly instead of BUSY', async () => {
  let spawns = 0
  let dyingRec: ReturnType<RunRegistry['create']> | undefined
  const { adapter } = makeAdapter(
    { transport: 'acp' },
    {
      runAcp: async (deps, input, slot) => {
        spawns += 1
        const rec = deps.runs.create()
        dyingRec = rec
        if (spawns === 1) {
          deps.registerActiveRun(input.sessionKey, rec)
          rec.requestAbort = () => { rec.markAbortRequested() }
          // Stay unsettled briefly across Stop, then settle shortly after Retry arrives
          setTimeout(() => {
            slot.releaseOnce()
            deps.unregisterActiveRun(input.sessionKey, rec)
            deps.clearInFlightPrompt(input.sessionKey, input.prompt)
            rec.settle({ kind: 'aborted', code: 'ABORTED', message: 'aborted' })
          }, 40)
          return rec
        }
        rec.append({ kind: 'init', conversationId: 'conv-retry-ok', raw: {} })
        rec.append({ kind: 'step', stepKey: '1', stepKind: 'text', state: 'DONE', text: 'Fresh answer' })
        rec.append({ kind: 'result', conversationId: 'conv-retry-ok', ok: true, response: 'Fresh answer', usage: { input_tokens: 5, output_tokens: 3 }, raw: {} })
        slot.releaseOnce()
        deps.unregisterActiveRun(input.sessionKey, rec)
        deps.clearInFlightPrompt(input.sessionKey, input.prompt)
        rec.settle(null)
        return rec
      },
    },
  )
  const sessionId = 'sess-stop-retry' as never
  const userMsg = { role: 'user', content: [{ type: 'text', text: 'Same prompt' }], source: { kind: 'user' } } as unknown as Message

  const ac = new AbortController()
  const turn1Promise = collect(adapter.stream(opts([userMsg], { sessionId, signal: ac.signal })))
  await new Promise((r) => setTimeout(r, 10))
  ac.abort()
  await turn1Promise
  assert.equal(dyingRec?.isAbortRequested, true)
  assert.equal(dyingRec?.isSettled, false, 'dying run has not finished settling yet when Stop resolves')

  // Immediately re-send the exact same prompt before the 40ms cancel settle completes.
  const turn2Chunks = await collect(adapter.stream(opts([userMsg], { sessionId })))
  const finish2 = turn2Chunks[turn2Chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(spawns, 2, 'retry after Stop must start a fresh run instead of attaching/BUSY')
  assert.equal(finish2.reason.kind, 'stop')
  assert.ok(dyingRec?.isSettled, 'adapter waited for dying run to settle before spawning retry')
})
