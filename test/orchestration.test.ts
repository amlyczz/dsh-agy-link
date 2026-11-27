// Orchestrator visibility: seat attribution, plan/checklist adoption, context
// window learning, and the per-(run, step) seat table the tool cards read.
//
// These are the pieces that turn "two models shared one conversation" into
// something the UI can show; before them the ACP stream said nothing and DSH
// rendered one flat run of identical cards.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPlannerModel, seatForModel, shortModelName } from '../src/common/seat.ts'
import { OrchestrationLedger, attachOrchestration, resetOrchestrationForTests, snapshotOrchestration } from '../src/features/orchestration/live.ts'
import { readModeUpdate, readPlanUpdate, readSessionInfoTitle, readToolPlan, readUsageWindow } from '../src/features/orchestration/acp-updates.ts'
import { learnedContextWindow, noteContextWindow, resetLearnedContextWindowsForTests } from '../src/features/acp/context-window.ts'
import { noteToolSeat, resetToolSeatsForTests, toolSeatsForRun } from '../src/features/orchestration/tool-seats.ts'
import { contextPercent, formatDuration, formatTokens } from '../src/client/orchestration/format.ts'
import { beginOrchestrationTurn, instrumentTurn } from '../src/features/orchestration/instrument.ts'
import { noteToolSeatFromRecording } from '../src/features/orchestration/tool-seats.ts'
import type { AgyEvent } from '../src/common/types/events.ts'

test('seatForModel splits orchestrator planners from executors', () => {
  assert.equal(isPlannerModel('gemini-pro-orchestrator-neon'), true)
  assert.equal(seatForModel('gemini-pro-orchestrator-neon'), 'planner')
  assert.equal(seatForModel('gemini-flash-worker-agy'), 'executor')
  assert.equal(seatForModel('gemini-4-hydrogen-high'), 'executor')
  assert.equal(seatForModel(''), 'unknown')
})

test('shortModelName keeps the model readable in a chip', () => {
  assert.equal(shortModelName('gemini-pro-orchestrator-neon'), 'orchestrator neon')
  assert.equal(shortModelName('gemini-flash-worker-agy'), 'flash worker')
  assert.ok(shortModelName('gemini-4-hydrogen-high').length <= 24)
  assert.equal(shortModelName(''), '')
})

test('the ledger follows the seat hand-off a real Orchestrator session performs', () => {
  const ledger = new OrchestrationLedger('s1', 'conv1')
  ledger.beginTurn()
  // Planner writes the plan and calls exit_plan_mode.
  ledger.noteTranscriptSample('gemini-pro-orchestrator-neon', { input_tokens: 26069, output_tokens: 771 })
  ledger.noteTool({ callId: 'c1', tool: 'exit_plan_mode', args: { plan: 'x' }, state: 'ACTIVE' })
  ledger.notePlan('目标：一次性修复。\n1. 读日志\n2. 改代码')
  ledger.noteTool({ callId: 'c1', tool: 'exit_plan_mode', args: { plan: 'x' }, state: 'DONE' })
  // Executor takes over and drives the tools.
  ledger.noteTranscriptSample('gemini-flash-worker-agy', { input_tokens: 211795, cache_read_tokens: 11113, output_tokens: 400 })
  ledger.noteTool({ callId: 'c2', tool: 'read_file', args: { Path: 'a.ts' }, state: 'ACTIVE' })
  ledger.noteTool({ callId: 'c2', tool: 'read_file', args: { Path: 'a.ts' }, state: 'DONE' })
  ledger.noteContext(211795, 1_000_000)

  const snap = ledger.snapshot()
  assert.deepEqual(snap.seats.map((s) => s.role).sort(), ['executor', 'planner'])
  const planner = snap.seats.find((s) => s.role === 'planner')
  const executor = snap.seats.find((s) => s.role === 'executor')
  assert.equal(planner?.model, 'gemini-pro-orchestrator-neon')
  assert.equal(planner?.calls, 1)
  assert.equal(executor?.inputTokens, 211795)
  assert.equal(executor?.cacheReadTokens, 11113)
  // The read_file step belongs to the executor, the plan call to the planner.
  assert.deepEqual(snap.steps.map((s) => [s.tool, s.seat]), [['exit_plan_mode', 'planner'], ['read_file', 'executor']])
  assert.equal(snap.live, true)
  assert.ok(snap.plan?.text.startsWith('目标'))
  assert.equal(snap.context.used, 211795)
  assert.equal(snap.context.size, 1_000_000)
  // `usage_update` names no model, so the reading belongs to whichever seat
  // spoke last — the executor here. Without this the panel had one unattributed
  // number that jumped between seats mid-turn.
  assert.equal(snap.context.seat, 'executor')
  assert.equal(planner?.contextTokens, 26069)
  assert.equal(executor?.contextTokens, 222908)

  ledger.settle()
  const settled = ledger.snapshot()
  assert.equal(settled.live, false)
  assert.deepEqual(settled.steps.map((s) => s.state), ['DONE', 'DONE'])
})

test('a new turn resets seats, steps and the plan but keeps the conversation id', () => {
  const ledger = new OrchestrationLedger('s1', 'conv1')
  ledger.beginTurn()
  ledger.noteTranscriptSample('gemini-pro-orchestrator-neon', { input_tokens: 10 })
  ledger.notePlan('old plan')
  ledger.beginTurn()
  const snap = ledger.snapshot()
  assert.equal(snap.conversationId, 'conv1')
  assert.equal(snap.seats.length, 0)
  assert.equal(snap.steps.length, 0)
  assert.equal(snap.plan, undefined)
})

test('update_steps checklists land in the todos section', () => {
  const ledger = new OrchestrationLedger('s1', 'conv1')
  ledger.noteStepsTodos([
    { title: 'read logs', status: 'done' },
    { title: 'patch file', status: 'in_progress' },
    { title: 'run tests', status: 'pending' },
  ])
  assert.deepEqual(ledger.snapshot().todos, [
    { text: 'read logs', state: 'done' },
    { text: 'patch file', state: 'in_progress' },
    { text: 'run tests', state: 'pending' },
  ])
})

test('registry: one ledger per session, snapshot readable by the route', () => {
  resetOrchestrationForTests()
  const a = attachOrchestration('s1', 'conv1')
  a.beginTurn()
  a.noteTranscriptSample('gemini-flash-worker-agy', { input_tokens: 5 })
  assert.equal(snapshotOrchestration('s1')?.seats.length, 1)
  assert.equal(snapshotOrchestration('other'), null)
  resetOrchestrationForTests()
})

test('ACP plan / mode / title / window updates are read instead of dropped', () => {
  assert.deepEqual(
    readPlanUpdate({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] }),
    [{ text: 'a', state: 'done' }, { text: 'b', state: 'in_progress' }],
  )
  assert.equal(readPlanUpdate({ sessionUpdate: 'plan', entries: [] }), null)
  assert.equal(readPlanUpdate({ sessionUpdate: 'agent_message_chunk' }), null)
  assert.equal(readModeUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'fast' }), 'fast')
  assert.equal(readModeUpdate({ sessionUpdate: 'current_mode_update' }), null)
  assert.equal(readSessionInfoTitle({ sessionUpdate: 'session_info_update', title: 'Fix the parser' }), 'Fix the parser')
  assert.deepEqual(readUsageWindow({ sessionUpdate: 'usage_update', used: 211795, size: 1_000_000 }), { used: 211795, size: 1_000_000 })
  assert.deepEqual(readUsageWindow({ sessionUpdate: 'usage_update', used: 10 }), { used: 10 })
  assert.equal(readUsageWindow({ sessionUpdate: 'usage_update' }), null)
  assert.equal(readToolPlan({ rawInput: { plan: '# Goal\n- step' } }, 'exit_plan_mode'), '# Goal\n- step')
  assert.equal(readToolPlan({ rawInput: { plan: 'x' } }, 'read_file'), null)
})

test('context windows are learned per model and survive obvious junk', () => {
  resetLearnedContextWindowsForTests()
  assert.equal(learnedContextWindow('gemini-4-hydrogen-high'), undefined)
  assert.equal(noteContextWindow('gemini-4-hydrogen-high', 1_048_576), true)
  assert.equal(learnedContextWindow('gemini-4-hydrogen-high'), 1_048_576)
  // Same number again: not news.
  assert.equal(noteContextWindow('gemini-4-hydrogen-high', 1_048_576), false)
  // A token count is not a window.
  assert.equal(noteContextWindow('gemini-4-neon-low', 4096), false)
  assert.equal(learnedContextWindow('gemini-4-neon-low'), undefined)
  // Effort suffix drift still resolves to the same window.
  assert.equal(learnedContextWindow('gemini-4-hydrogen-high-2'), 1_048_576)
  resetLearnedContextWindowsForTests()
})

test('(run, step) seat table answers the tool cards', () => {
  resetToolSeatsForTests()
  noteToolSeat('run-1', 16, 'read_file', 'gemini-flash-worker-agy')
  noteToolSeat('run-1', 2, 'exit_plan_mode', 'gemini-pro-orchestrator-neon')
  const table = toolSeatsForRun('run-1')
  assert.equal(table['16']?.seat, 'executor')
  assert.equal(table['2']?.seat, 'planner')
  assert.equal(table['2']?.short, 'orchestrator neon')
  assert.deepEqual(toolSeatsForRun('run-missing'), {})
  resetToolSeatsForTests()
})
test('panel formatters stay readable at every scale', () => {
  assert.equal(formatTokens(undefined), '—')
  assert.equal(formatTokens(997), '997')
  assert.equal(formatTokens(12_345), '12k')
  assert.equal(formatTokens(9_400), '9.4k')
  assert.equal(formatTokens(211_795), '212k')
  assert.equal(formatTokens(1_048_576), '1.0M')
  assert.equal(formatDuration(undefined), '')
  assert.equal(formatDuration(120), '120ms')
  assert.equal(formatDuration(1234), '1.2s')
  assert.equal(formatDuration(65_000), '1m 05s')
  assert.equal(formatDuration(3_600_000), '1h 00m')
  assert.equal(contextPercent(211_795, 1_000_000)?.toFixed(1), '21.2')
  assert.equal(contextPercent(undefined, 1000), undefined)
  assert.equal(contextPercent(10, 0), undefined)
})

test('detached task logs land in the ledger, never in the conversation', async () => {
  const { backgroundLogOf } = await import('../src/features/subagent/task-activity.ts')
  const line = backgroundLogOf({
    kind: 'step',
    stepKind: 'subagent',
    text: '[后台任务 · task-4] some log line\n',
    raw: { kind: 'task-log', taskId: 'task-4', line: 'some log line' },
  })
  assert.deepEqual(line, { taskId: 'task-4', lines: ['some log line'], skipped: 0 })

  const skipped = backgroundLogOf({
    kind: 'step',
    stepKind: 'subagent',
    text: '',
    raw: { kind: 'task-log', taskId: 'task-4', skipped: 1575 },
  })
  assert.deepEqual(skipped, { taskId: 'task-4', lines: [], skipped: 1575 })

  // Recordings written before raw carried a kind are recovered from the text.
  const legacy = backgroundLogOf({ kind: 'step', stepKind: 'subagent', text: '[后台任务 · task-9] D:\\a\\b.txt\n' })
  assert.deepEqual(legacy, { taskId: 'task-9', lines: ['D:\\a\\b.txt'], skipped: 0 })

  // Anything else keeps its normal route (real subagent progress, thoughts).
  assert.equal(backgroundLogOf({ kind: 'step', stepKind: 'subagent', text: '[agy subagent] working', raw: {} }), null)
  assert.equal(backgroundLogOf({ kind: 'step', stepKind: 'thinking', text: '[后台任务 · x] y' }), null)
  assert.equal(backgroundLogOf({ kind: 'text', text: 'hello' }), null)

  resetOrchestrationForTests()
  const ledger = attachOrchestration('sess-log', 'conv-1')
  ledger.beginTurn()
  ledger.noteBackground('task-4', ['one', 'two'], 0)
  ledger.noteBackground('task-4', ['three'], 1575)
  const snap = snapshotOrchestration('sess-log')
  assert.ok(snap !== null)
  const bg = snap.background[0]
  assert.ok(bg !== undefined)
  assert.equal(snap.background.length, 1)
  assert.deepEqual(bg.lines, ['one', 'two', 'three'])
  assert.equal(bg.skipped, 1575)
  assert.equal(bg.taskId, 'task-4')
})

test('a file read with no streamed result is answered from the file itself', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { canRecoverFromFile, recoverFromFile } = await import('../src/provider/mirror/result-recovery.ts')
  const dir = await mkdtemp(join(tmpdir(), 'agy-recover-'))
  try {
    const file = join(dir, 'note.md')
    await writeFile(file, '# title\n\nbody\n', 'utf8')
    assert.equal(canRecoverFromFile('read_file'), true)
    assert.equal(canRecoverFromFile('run_command'), false)
    assert.equal(await recoverFromFile('read_file', { Path: file }), '# title\n\nbody')
    assert.equal(await recoverFromFile('run_command', { Path: file }), null)
    assert.equal(await recoverFromFile('read_file', { Path: join(dir, 'missing.md') }), null)
    assert.equal(await recoverFromFile('read_file', {}), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the transport wiring reports to the ledger without touching the transcript', () => {
  resetOrchestrationForTests()
  resetToolSeatsForTests()
  const appended: AgyEvent[] = []
  const learned: Array<[string, number | undefined]> = []
  beginOrchestrationTurn(false, 'sess-wire', 'conv-wire')
  const wiring = instrumentTurn({
    isAux: false,
    sessionKey: 'sess-wire',
    conversationId: 'conv-wire',
    activeModel: 'gemini-4-neon-high',
    append: (ev) => appended.push(ev),
    learnWindow: (model, size) => learned.push([model, size]),
  })
  wiring.resume()
  // transcript.jsonl is the only place CACP names the seat (ACP sends no model).
  wiring.noteTranscriptSample({ model: 'gemini-pro-orchestrator-neon', usage: { input_tokens: 26069, output_tokens: 771 } })
  // usage_update carries the REAL window; it must be learned under the active model.
  wiring.noteUpdate({ sessionUpdate: 'usage_update', used: 4000, size: 1048576 })
  wiring.noteUpdate({ sessionUpdate: 'plan', entries: [{ content: '读日志', status: 'pending' }] })
  const step = {
    kind: 'step',
    stepKey: 's1',
    stepKind: 'tool',
    text: '',
    state: 'ACTIVE',
    tool: { name: 'run_command', args: { CommandLine: 'ls' } },
  } as unknown as AgyEvent
  wiring.noteStep(step, {})
  // exit_plan_mode carries the plan body in its arguments.
  const planStep = {
    kind: 'step',
    stepKey: 's2',
    stepKind: 'tool',
    text: '',
    state: 'DONE',
    tool: { name: 'exit_plan_mode', args: { plan: '目标：把编排显出来' } },
  } as unknown as AgyEvent
  wiring.noteStep(planStep, { sessionUpdate: 'tool_call', rawInput: { plan: '目标：把编排显出来' } })
  // A detached task-log burst: ledger yes, transcript no.
  wiring.onEvent({
    kind: 'step',
    stepKey: 'log1',
    stepKind: 'subagent',
    text: '[后台任务 · task-9] tail',
    state: 'ACTIVE',
    raw: { kind: 'task-log', taskId: 'task-9', lines: ['tail'], skipped: 3 },
  } as unknown as AgyEvent)
  wiring.onEvent({ kind: 'init', conversationId: 'conv-wire' } as unknown as AgyEvent)
  wiring.settle()

  // The tool step was stamped with the seat that was driving.
  assert.equal((step as { model?: string }).model, 'gemini-pro-orchestrator-neon')
  // Only the non-log event reached the transcript.
  assert.deepEqual(appended.map((ev) => ev.kind), ['init'])
  assert.deepEqual(learned, [['gemini-4-neon-high', 1048576]])
  const snap = snapshotOrchestration('sess-wire')
  assert.ok(snap !== null)
  assert.equal(snap?.live, false)
  assert.equal(snap?.context.seat, 'planner')
  assert.equal(snap?.plan?.text, '目标：把编排显出来')
  // the ACP `plan` update is the checklist, not the plan body
  assert.deepEqual(snap?.todos.map((t) => t.text), ['读日志'])
  assert.deepEqual(snap?.steps.map((s) => s.tool), ['run_command', 'exit_plan_mode'])
  assert.deepEqual(snap?.background.map((b) => [b.taskId, b.skipped]), [['task-9', 3]])
})

test('a recorded step remembers the seat it ran on, and never fails over it', () => {
  resetToolSeatsForTests()
  const rec = { runId: 'run-seat', eventAt: (step: number) => (step === 3 ? { model: 'gemini-flash-worker-agy' } : undefined) }
  noteToolSeatFromRecording(rec, 3, 'read_file')
  noteToolSeatFromRecording(rec, 4, 'read_file')
  // A recording that cannot answer (a replayed CLI run) must stay quiet.
  noteToolSeatFromRecording({ runId: 'run-seat', eventAt: () => { throw new Error('no events') } }, 5, 'read_file')
  const seats = toolSeatsForRun('run-seat')
  assert.equal(seats['3']?.seat, 'executor')
  assert.equal(seats['3']?.short, 'flash worker')
  assert.equal(seats['4']?.seat, 'unknown')
  assert.equal(seats['5'], undefined)
})
