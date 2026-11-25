import assert from 'node:assert/strict'
import test from 'node:test'
import { startAgyProcess } from '../../../src/runtime/agy/process.ts'
import { classifyFailure } from '../../../src/provider/failure.ts'
import { EventMapper } from '../../../src/provider/mapper/event-mapper.ts'
import { classifyEvent } from '../../../src/host/parser.ts'
import { resolveConfig } from '../../../src/common/config.ts'

test('startAgyProcess terminates on root agent idle grace period and sets idleGraceTerminated', async () => {
  // Simulate agy child that prints root agent idle (0 remaining tasks) on stderr and then sits blocked
  const script = `
    process.stderr.write('root agent idle; waiting up to 240m0s for 0 background task(s)\\n');
    setTimeout(() => {}, 60000);
  `
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 30_000,
    idleGraceMs: 60,
  })
  const outcome = await proc.outcome
  assert.equal(outcome.idleGraceTerminated, true)
  assert.equal(outcome.timedOut, false)
})

test('startAgyProcess also matches root agent idle waiting without up to duration', async () => {
  // The count decides: 0 means nothing is left, so the reaper reclaims the
  // child after its grace. (A positive count must NOT be reaped — that is
  // issue #144 and is covered in test/issue144-idle-grace.test.ts.)
  const script = `
    process.stderr.write('root agent idle; waiting for 0 background tasks to finish\\n');
    setTimeout(() => {}, 60000);
  `
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 30_000,
  })
  const outcome = await proc.outcome
  assert.equal(outcome.idleGraceTerminated, true)
  assert.equal(outcome.timedOut, false)
})

test('classifyFailure returns null when idleGraceTerminated is true', () => {
  const cfg = resolveConfig({}, {}, {})
  const failure = classifyFailure({
    cfg,
    outcome: {
      aborted: false,
      capped: false,
      timedOut: false,
      idleGraceTerminated: true,
      code: null,
      stderrTail: 'root agent idle; waiting up to 240m0s for 1 background task(s)',
    },
    parser: { stats: { sawAuthFailure: false, lastResultError: undefined, garbage: 0 } },
    sawAuthFailure: false,
    consumable: false,
    transportFailure: false,
    keyringJitter: false,
    rawErrText: '',
    isRateLimit: false,
    silentTimeout: false,
  })
  assert.equal(failure, null)
})

test('EventMapper treats state RUNNING as completed tool and falls back to text for output', () => {
  const mapper = new EventMapper({
    runId: 'run-test',
    cutOnTool: true,
  })
  const ev = classifyEvent(
    {
      event: 'step_update',
      step_update: {
        step_index: 2,
        state: 'RUNNING',
        step_type: 'tool',
        text: 'Tool is running as a background task with task id: task-1',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'test' },
        },
      },
    },
    2,
  )
  assert.ok(ev)
  assert.equal(ev?.kind, 'step')
  if (ev?.kind === 'step') {
    assert.equal(ev.state, 'RUNNING')
    assert.equal(ev.tool?.output, 'Tool is running as a background task with task id: task-1')
    const chunks = Array.from(mapper.map(ev, 2))
    assert.ok(chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'))
    assert.equal(mapper.isFinished, true)
  }
})

test('startAgyProcess does not reset watchdog on background stderr noise', async () => {
  // timeoutMs is 300ms. Child writes background chatter at 200ms.
  // If chatter resets watchdog, process will survive past 500ms.
  // Because noise is filtered, watchdog times out at ~300ms.
  const script = `
    setTimeout(() => {
      process.stderr.write('fetchAvailableModels: refreshed token\\n');
    }, 200);
    setTimeout(() => {
      process.exit(0);
    }, 1200);
  `
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 300,
    stderrKeepalive: true,
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, true, 'background noise must not prevent timeout')
})

test('RunRecording.hasConsumableResultFrom ignores bare error results so idleGraceTerminated and continuation retry recover cleanly', async () => {
  const { RunRecording } = await import('../../../src/host/recording.ts')
  const rec = new RunRecording('run-bare-err')
  rec.append({ kind: 'init', conversationId: 'c1', model: 'gemini-4-neon', raw: {} })
  rec.append({ kind: 'result', conversationId: 'c1', ok: false, response: '', error: 'signal: terminated', usage: {}, raw: {} })
  assert.equal(rec.hasResult, true)
  assert.equal(rec.hasConsumableResultFrom(0), false, 'bare error result is NOT consumable by EventMapper')

  rec.append({ kind: 'result', conversationId: 'c1', ok: true, response: 'recovered reply', usage: {}, raw: {} })
  assert.equal(rec.hasConsumableResultFrom(0), true)
  assert.equal(rec.hasConsumableResultFrom(2), true)
  assert.equal(rec.hasConsumableResultFrom(3), false)
})

