// Regression tests for issue #144 — the `root agent idle; waiting for N
// background task(s)` reaper used a hard-coded 5 s grace, so a turn that
// legitimately waited on a build / integration test / Docker job it had just
// launched was SIGTERM'd mid-flight and surfaced as
// `agy stream ended without a result event` (INVALID_OUTPUT, retried 3×).
//
// The fix: the grace is configurable (`idleGraceMinutes` /
// DSH_AGY_IDLE_GRACE_MINUTES, default 10 minutes, 0 disables it), and the
// reaper stays suspended while ANY tool step is still open — not just the
// subagent hand-off tools covered by #124.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../../src/common/config.ts'
import { startAgyProcess } from '../../src/runtime/agy/process.ts'
import { createToolWatchdog } from '../../src/provider/tool-watchdog.ts'
import type { AgyEvent } from '../../src/common/types.ts'
import type { RunningProcess } from '../../src/host/runner.ts'

// agy reports its OWN count of work still running. `0` means nothing is left,
// so reclaiming after the grace is right; a positive count means the wait is
// legitimate (see the positive-count test below).
const IDLE_LINE = 'root agent idle; waiting for 0 background tasks to finish'

/** A child that reports the idle line and then sits blocked, like agy waiting on a build. */
function idleChild(idleGraceMs: number, idleLine = IDLE_LINE) {
  const script = `
    process.stderr.write(${JSON.stringify(idleLine)} + '\\n');
    setInterval(() => {}, 1000);
  `
  return startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 30_000,
    stderrKeepalive: true,
    idleGraceMs,
  })
}

test('issue #144: the idle-grace default is 10 minutes, not the old hard-coded 5 s', () => {
  const cfg = resolveConfig({}, {}, {})
  assert.equal(cfg.idleGraceMinutes, 10)
})

test('issue #144: the idle grace is configurable by entry and by environment', () => {
  assert.equal(resolveConfig({ idleGraceMinutes: 30 }, {}, {}).idleGraceMinutes, 30)
  assert.equal(resolveConfig({}, { DSH_AGY_IDLE_GRACE_MINUTES: '45' }, {}).idleGraceMinutes, 45)
  // 0 is a meaningful value (disables the reaper), not a fallback to the default.
  assert.equal(resolveConfig({ idleGraceMinutes: 0 }, {}, {}).idleGraceMinutes, 0)
})

test('issue #144: idleGraceMs 0 disables the reaper entirely', async () => {
  const proc = idleChild(0)
  try {
    // Well past the old 5 s hard-coded grace (scaled down here): never killed.
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(proc.child.exitCode, null, 'a disabled reaper must not kill the child')
  } finally {
    proc.kill('abort')
  }
})

test('issue #144: an idleGraceMs override is honoured (the old 60 ms grace still reaps)', async () => {
  const proc = idleChild(60)
  const outcome = await proc.outcome
  assert.equal(outcome.idleGraceTerminated, true, 'an explicit short grace still reclaims the child')
  assert.equal(outcome.timedOut, false)
})

/** Fake process that records the last `exemptIdleGrace` value. */
function fakeProc() {
  const calls: boolean[] = []
  const proc = {
    exemptIdleGrace: (exempt: boolean) => { calls.push(exempt) },
    noteActivity: () => {},
  } as unknown as RunningProcess
  return { proc, calls, last: () => calls[calls.length - 1] }
}

const toolStep = (state?: string, name = 'run_command'): AgyEvent =>
  ({ kind: 'step', stepKey: 'tool-1', stepKind: 'tool', text: '', tool: { name }, ...(state === undefined ? {} : { state }) }) as AgyEvent

const textStep: AgyEvent = { kind: 'step', stepKey: 'text-1', stepKind: 'text', text: 'done' } as AgyEvent

test('issue #144: any open tool step suspends the idle-grace reaper, not only subagent tools', () => {
  const cfg = resolveConfig({}, {}, {})
  const { proc, last } = fakeProc()
  const wd = createToolWatchdog(undefined, cfg)
  wd.attach(proc)
  try {
    // A long build started by run_command: no subagent is involved.
    wd.trackStep(toolStep(undefined, 'run_command'))
    assert.equal(last(), true, 'run_command must suspend the reaper while it runs')

    // The step completes: the reaper is armed again.
    wd.trackStep(toolStep('DONE', 'run_command'))
    assert.equal(last(), false, 'the reaper is re-armed once the tool step completes')
  } finally {
    wd.stop()
  }
})

test('issue #144: text output also releases a suspended reaper', () => {
  const cfg = resolveConfig({}, {}, {})
  const { proc, last } = fakeProc()
  const wd = createToolWatchdog(undefined, cfg)
  wd.attach(proc)
  try {
    wd.trackStep(toolStep()) // no state: still open
    assert.equal(last(), true)
    wd.trackStep(textStep)
    assert.equal(last(), false)
  } finally {
    wd.stop()
  }
})

test('issue #144: a completed tool step never suspends the reaper', () => {
  const cfg = resolveConfig({}, {}, {})
  const { proc, calls } = fakeProc()
  const wd = createToolWatchdog(undefined, cfg)
  wd.attach(proc)
  try {
    wd.trackStep(toolStep('DONE'))
    assert.equal(calls.includes(true), false, 'a finished command must not hold the reaper off')
  } finally {
    wd.stop()
  }
})

// ---- the reaper must read agy's own background-task count ----
test('issue #144: a positive background-task count never arms the reaper', async () => {
  // agy prints `root agent idle; waiting for 2 background task(s)` precisely
  // when it KNOWS work it launched is still running. That is authoritative:
  // waiting a grace period and then killing it is wrong no matter how long the
  // grace is, so a positive count must not arm the reaper at all.
  const parsers = await import('../../src/runtime/agy/idle-line.ts')
  assert.equal(parsers.backgroundTasksFrom('root agent idle; waiting for 2 background task(s)'), 2)
  assert.equal(parsers.backgroundTasksFrom('root agent idle; waiting for 1 background task'), 1)
  assert.equal(parsers.backgroundTasksFrom('root agent idle; waiting up to 240m0s for 1 background task(s)'), 1)
  assert.equal(parsers.backgroundTasksFrom('root agent idle; waiting up to 240m0s for 0 background task(s)'), 0)
  // Zero is the only count that means "nothing left; reclaim it".
  assert.equal(parsers.backgroundTasksFrom('root agent idle; waiting for 0 background tasks'), 0)
  // Unparseable idleness still counts as idle — keep the old conservative path.
  assert.equal(parsers.backgroundTasksFrom('root agent idle; waiting'), null)
  assert.equal(parsers.backgroundTasksFrom('unrelated stderr'), null)
})

test('issue #144: waiting up to <duration> for positive background tasks also never reaps', async () => {
  const proc = idleChild(60, 'root agent idle; waiting up to 240m0s for 1 background task(s)')
  try {
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(proc.child.exitCode, null, 'waiting up to <duration> with positive count must keep the child alive')
  } finally {
    proc.kill('abort')
    await proc.outcome.catch(() => undefined)
  }
})

test('issue #144: a child waiting on its OWN background task is never reaped, however short the grace', async () => {
  // This is the reported failure mode verbatim: agy says it is waiting for one
  // task it launched (a build / integration test / Docker job). Killing it after
  // any grace cuts a healthy turn, so the count — not the grace — decides.
  const proc = idleChild(60, 'root agent idle; waiting for 1 background task(s) to finish')
  try {
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(proc.child.exitCode, null, 'a positive background count must keep the child alive')
  } finally {
    proc.kill('abort')
    await proc.outcome.catch(() => undefined)
  }
})
