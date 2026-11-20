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
import { resolveConfig } from '../src/common/config.ts'
import { startAgyProcess } from '../src/runtime/agy/process.ts'
import { createToolWatchdog } from '../src/provider/tool-watchdog.ts'
import type { AgyEvent } from '../src/common/types.ts'
import type { RunningProcess } from '../src/host/runner.ts'

const IDLE_LINE = 'root agent idle; waiting for 1 background task(s) to finish'

/** A child that reports the idle line and then sits blocked, like agy waiting on a build. */
function idleChild(idleGraceMs: number) {
  const script = `
    process.stderr.write(${JSON.stringify(IDLE_LINE)} + '\\n');
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
