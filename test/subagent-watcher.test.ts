import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  unquoteArg,
  formatSubagentStep,
  readIncrementalTranscript,
  SubagentWatcher,
  type SubagentSummaryRecord,
} from '../src/provider/subagent-watcher.ts'
import { EventMapper } from '../src/provider/mapper/event-mapper.ts'
import type { AgyEvent } from '../src/common/types.ts'

describe('unquoteArg helper', () => {
  test('unquotes JSON-escaped strings and objects', () => {
    assert.equal(unquoteArg('"hello"'), 'hello')
    assert.equal(unquoteArg('plain text'), 'plain text')
    assert.equal(unquoteArg('""'), '')
    assert.equal(unquoteArg(null), '')
    assert.equal(unquoteArg(undefined), '')
    assert.equal(unquoteArg(123), '123')
    assert.equal(unquoteArg('{"foo":"bar"}'), '{"foo":"bar"}')
    assert.equal(unquoteArg('"\\"nested\\""'), 'nested')
  })

  test('keeps non-string JSON values, bad literals and malformed objects honest', () => {
    // A quoted number/array is not a string: serialise it back instead of
    // silently stringifying `[object Object]`-style values.
    assert.equal(unquoteArg('"42"'), '42')
    assert.equal(unquoteArg('"[1,2]"'), '[1,2]')
    assert.equal(unquoteArg('"null"'), 'null')
    // Quoted but invalid JSON: the parse failure must not eat the value.
    assert.equal(unquoteArg('"bad\\x"'), '"bad\\x"')
    // Object-shaped but invalid JSON: same fallback.
    assert.equal(unquoteArg('{not json}'), '{not json}')
    assert.equal(unquoteArg(true), 'true')
  })
})

describe('formatSubagentStep', () => {
  test('ignores system SDK and system message lines', () => {
    assert.equal(formatSubagentStep('worker', JSON.stringify({ source: 'SYSTEM_SDK', content: 'test' })), null)
    assert.equal(formatSubagentStep('worker', JSON.stringify({ type: 'SYSTEM_MESSAGE', content: 'test' })), null)
    assert.equal(formatSubagentStep('worker', 'invalid json'), null)
  })

  test('formats run_command with and without summary', () => {
    const lineWithSummary = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"ls -la"',
            toolSummary: '"List workspace files"',
          },
        },
      ],
    })
    assert.equal(
      formatSubagentStep('WorkerL0', lineWithSummary),
      '• [WorkerL0] 🛠️ run_command: List workspace files (`ls -la`)',
    )

    const lineWithoutSummary = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    })
    assert.equal(formatSubagentStep('WorkerL0', lineWithoutSummary), '• [WorkerL0] 🛠️ run_command: `npm test`')
  })

  test('formats read_file, edit_file, write_file, search_web, invoke_subagent', () => {
    const readFile = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'read_file', args: { Path: 'src/main.ts', StartLine: 1, EndLine: 50 } }],
    })
    assert.equal(
      formatSubagentStep('Investigator', readFile),
      '• [Investigator] 📖 read_file: `src/main.ts` (L1-50)',
    )

    const editFile = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'edit_file', args: { Path: 'src/main.ts' } }],
    })
    assert.equal(formatSubagentStep('Investigator', editFile), '• [Investigator] ✏️ edit_file: `src/main.ts`')

    const writeFile = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_file', args: { Path: 'out/result.json' } }],
    })
    assert.equal(formatSubagentStep('Investigator', writeFile), '• [Investigator] 📝 write_file: `out/result.json`')

    const searchWeb = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'search_web', args: { query: 'remotion transitions' } }],
    })
    assert.equal(
      formatSubagentStep('Investigator', searchWeb),
      '• [Investigator] 🔍 search_web: "remotion transitions"',
    )

    const invokeSubagent = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Layer 0 Worker' } }],
    })
    assert.equal(
      formatSubagentStep('Coordinator', invokeSubagent),
      '• [Coordinator] 🤖 invoke_subagent: Layer 0 Worker',
    )
  })

  test('formats thinking prose when tool_calls absent', () => {
    const thinkingStep = JSON.stringify({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      thinking: '# Thinking plan\nFirst investigate the API endpoints.\nThen build prototype.',
    })
    assert.equal(
      formatSubagentStep('Investigator', thinkingStep),
      '• [Investigator] 💭 First investigate the API endpoints.',
    )
  })

  test('formats every remaining tool branch, truncates long text and ignores empty steps', () => {
    const longCmd = 'x'.repeat(90)
    const longThought = 'y'.repeat(100)
    const line = JSON.stringify({
      source: 'MODEL',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: longCmd, toolSummary: 'sum' } },
        { name: 'run_command', args: {} },
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'edit_file', args: {} },
        { name: 'write_file', args: {} },
        { name: 'search_web', args: { Query: 'q' } },
        { name: 'invoke_subagent', args: { TypeName: 'Worker' } },
        { name: 'manage_task', args: { action: 'kill', taskId: 't-9' } },
        { name: 'send_message', args: { recipient: 'agent-1' } },
        { name: 'send_message', args: { Recipient: 'agent-2' } },
        { name: 'mystery_tool', args: {} },
        { args: {} },
      ],
    })
    const out = formatSubagentStep('W', line) ?? ''
    assert.match(out, /run_command: sum \(`x{67}\.\.\.`\)/)
    assert.match(out, /🛠️ run_command$/m)
    assert.match(out, /🤖 invoke_subagent: Worker/)
    assert.match(out, /⚙️ manage_task: kill t-9/)
    assert.match(out, /💬 send_message: agent-1/)
    assert.match(out, /💬 send_message: agent-2/)
    assert.match(out, /🛠️ mystery_tool/)
    assert.match(out, /🛠️ tool/)

    const thought = formatSubagentStep('W', JSON.stringify({ thinking: longThought }))
    assert.equal(thought, '• [W] 💭 ' + 'y'.repeat(77) + '...')
    assert.equal(formatSubagentStep('W', JSON.stringify({ thinking: '   \n# only a heading' })), null)
    assert.equal(formatSubagentStep('W', JSON.stringify({ content: 'no tools, no thinking' })), null)
  })
})

describe('readIncrementalTranscript', () => {
  test('reads complete lines and advances offset, leaves partial line for next read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'))
    const file = join(dir, 'transcript.jsonl')
    try {
      writeFileSync(file, '{"step": 1}\n{"step": 2}\n{"partial":')
      const read1 = readIncrementalTranscript(file, 0)
      assert.equal(read1.lines.length, 2)
      assert.deepEqual(read1.lines, ['{"step": 1}', '{"step": 2}'])

      // Offset must have stopped exactly after the second newline
      writeFileSync(file, '{"step": 1}\n{"step": 2}\n{"partial": true}\n')
      const read2 = readIncrementalTranscript(file, read1.newOffset)
      assert.equal(read2.lines.length, 1)
      assert.deepEqual(read2.lines, ['{"partial": true}'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('handles missing or empty file gracefully', () => {
    const res = readIncrementalTranscript('/path/does/not/exist.jsonl', 0)
    assert.deepEqual(res, { lines: [], newOffset: 0 })
  })

  test('waits for a newline and ignores reads past EOF', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-partial-'))
    const file = join(dir, 'transcript.jsonl')
    try {
      writeFileSync(file, '{"unfinished":')
      assert.deepEqual(readIncrementalTranscript(file, 0), { lines: [], newOffset: 0 })
      const eof = readIncrementalTranscript(file, 4096)
      assert.deepEqual(eof, { lines: [], newOffset: 4096 })
      const empty = join(dir, 'empty.jsonl')
      writeFileSync(empty, '')
      assert.deepEqual(readIncrementalTranscript(empty, 0), { lines: [], newOffset: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SubagentWatcher polling & event dispatch', () => {
  test('discovers subagents, streams formatted steps, triggers onActivity and announces finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-poll-'))
    const sub1Transcript = join(dir, 'sub1.jsonl')
    writeFileSync(
      sub1Transcript,
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status' } }],
      }) + '\n',
    )

    const mockRecords: SubagentSummaryRecord[] = [
      {
        conversation_id: 'sub-1',
        parent_conversation_id: 'root-123',
        agent_name: 'DeepInvestigator',
        nesting_depth: 1,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        step_count: 1,
      },
    ]

    const events: AgyEvent[] = []
    let activities = 0

    const watcher = new SubagentWatcher({
      getRootConversationId: () => 'root-123',
      pollIntervalMs: 20,
      onEvent: (ev) => events.push(ev),
      onActivity: () => activities++,
      _findDb: () => '/mock/db.sqlite',
      _findTranscript: (cid) => (cid === 'sub-1' ? sub1Transcript : null),
      _queryDb: async () => mockRecords,
    })

    // Tick 1: discovers sub-1, announces start, reads step 1
    await watcher.tick()
    assert.ok(events.length >= 2, 'emitted start + step 1')
    const ev0 = events[0]
    const ev1 = events[1]
    assert.ok(ev0 && ev0.kind === 'step' && ev0.text.includes('Subagent started'))
    assert.ok(ev1 && ev1.kind === 'step' && ev1.text.includes('run_command: `git status`'))
    assert.ok(activities >= 2)

    // Append new step and mark status idle
    writeFileSync(
      sub1Transcript,
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', args: { Path: 'README.md' } }],
      }) + '\n',
      { flag: 'a' },
    )
    if (mockRecords[0]) mockRecords[0].status = 'CASCADE_RUN_STATUS_IDLE'

    // Tick 2: reads step 2, announces finish
    await watcher.tick()
    const step2 = events.find((e) => e.kind === 'step' && e.text.includes('read_file'))
    const finish = events.find((e) => e.kind === 'step' && e.text.includes('Finished'))
    assert.ok(step2, 'read_file step emitted')
    assert.ok(finish, 'Finished event emitted')

    watcher.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('trackExplicitSubagent discovers subagents before db query', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-explicit-'))
    const subTranscript = join(dir, 'explicit-sub.jsonl')
    writeFileSync(
      subTranscript,
      JSON.stringify({
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_file', args: { Path: 'out.txt' } }],
      }) + '\n',
    )

    const events: AgyEvent[] = []
    const watcher = new SubagentWatcher({
      getRootConversationId: () => 'root-456',
      pollIntervalMs: 50,
      onEvent: (ev) => events.push(ev),
      _findDb: () => null,
      _findTranscript: (cid) => (cid === 'sub-explicit' ? subTranscript : null),
    })

    watcher.trackExplicitSubagent('sub-explicit', 'CustomInvestigator')
    await watcher.tick()

    assert.ok(events.length >= 2, 'emitted start + tool step')
    const evStart = events.find((e) => e.kind === 'step' && e.text.includes('Subagent started'))
    const evStep = events.find((e) => e.kind === 'step' && e.text.includes('write_file: `out.txt`'))
    assert.ok(evStart && evStart.kind === 'step' && evStart.text.includes('CustomInvestigator'))
    assert.ok(evStep && evStep.kind === 'step' && evStep.text.includes('CustomInvestigator'))

    watcher.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  test('a watcher without a root conversation or db stays quiet and stops cleanly', async () => {
    const events: AgyEvent[] = []
    const watcher = new SubagentWatcher({
      getRootConversationId: () => null,
      pollIntervalMs: 5,
      onEvent: (ev) => events.push(ev),
      _findDb: () => null,
      _findTranscript: () => null,
    })
    await watcher.tick()
    assert.deepEqual(events, [])
    watcher.trackExplicitSubagent('')
    watcher.start()
    watcher.stop()
    // A stopped watcher never schedules another tick, even after an explicit track.
    watcher.trackExplicitSubagent('late-sub')
    assert.deepEqual(events, [])
  })

  test('a failed db query is transient; DONE/COMPLETED also announce finish', async () => {
    const events: AgyEvent[] = []
    const records: SubagentSummaryRecord[] = [
      {
        conversation_id: 'sub-done',
        parent_conversation_id: 'root-1',
        agent_name: 'Finisher',
        nesting_depth: 1,
        status: 'DONE',
        step_count: 0,
      },
    ]
    let calls = 0
    const watcher = new SubagentWatcher({
      getRootConversationId: () => 'root-1',
      pollIntervalMs: 5,
      onEvent: (ev) => events.push(ev),
      _findDb: () => '/mock/db.sqlite',
      _findTranscript: () => null,
      _queryDb: async () => {
        calls++
        if (calls === 1) throw new Error('database is locked')
        return records
      },
    })
    await watcher.tick() // transient failure: swallowed
    await watcher.tick() // success + start + finish
    assert.ok(events.some((e) => e.kind === 'step' && e.text.includes('Subagent started')))
    assert.ok(events.some((e) => e.kind === 'step' && e.text.includes('Finished')))
    records[0]!.status = 'COMPLETED'
    await watcher.tick()
    assert.equal(events.filter((e) => e.kind === 'step' && e.text.includes('Finished')).length, 1, 'finish is announced once')
    watcher.stop()
  })
})

describe('EventMapper subagent rendering integration', () => {
  test('single [agy subagent] banner precedes multi-step subagent progress without duplication', () => {
    const mapper = new EventMapper({ runId: 'r', cutOnTool: false })

    // Empty event is ignored
    const outEmpty = [...mapper.map({ kind: 'step', stepKey: 's0', stepKind: 'subagent', text: '   ' } as AgyEvent, 0)]
    assert.equal(outEmpty.length, 0)

    // First subagent event emits banner + first line
    const out1 = [
      ...mapper.map(
        {
          kind: 'step',
          stepKey: 's1',
          stepKind: 'subagent',
          text: '\n• [DeepInvestigator] 🤖 Subagent started',
        } as AgyEvent,
        1,
      ),
    ]
    const text1 = out1
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    assert.equal(text1, '[agy subagent]\n• [DeepInvestigator] 🤖 Subagent started')

    // Second subagent event does NOT duplicate banner
    const out2 = [
      ...mapper.map(
        {
          kind: 'step',
          stepKey: 's2',
          stepKind: 'subagent',
          text: '\n• [WorkerL0] 🛠️ run_command: ls',
        } as AgyEvent,
        2,
      ),
    ]
    const text2 = out2
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    assert.equal(text2, '\n• [WorkerL0] 🛠️ run_command: ls')
    assert.ok(!text2.includes('[agy subagent]'), 'banner must not repeat on second step')
  })
})
