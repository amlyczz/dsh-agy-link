// Regression tests for issue #148: `schedule`, backgrounded `run_command` and
// `invoke_subagent` all end with the root agent waiting on work it launched.
// agy tells the model to emit a short status line BEFORE it prints the idle
// line, so a text/thinking step must not cancel the wait, and a step that went
// to `state === 'RUNNING'` (i.e. moved to the background) is NOT finished.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../../../src/common/config.ts'
import { createToolWatchdog } from '../../../src/provider/tool-watchdog.ts'
import type { AgyEvent } from '../../../src/common/types.ts'
import type { RunningProcess } from '../../../src/host/runner.ts'

function fakeProc() {
  const calls: boolean[] = []
  const proc = {
    exemptIdleGrace: (exempt: boolean) => { calls.push(exempt) },
    noteActivity: () => {},
  } as unknown as RunningProcess
  return { proc, last: () => calls[calls.length - 1] }
}

const step = (over: Record<string, unknown>): AgyEvent =>
  ({ kind: 'step', stepKey: 's1', stepKind: 'tool', text: '', ...over }) as AgyEvent

test('issue #148: a backgrounded schedule keeps the reaper suspended across the status line', () => {
  const cfg = resolveConfig({}, {}, {})
  const { proc, last } = fakeProc()
  const wd = createToolWatchdog(undefined, cfg)
  wd.attach(proc)
  try {
    // 1. The tool returns RUNNING: it moved to the background and is awaited.
    wd.trackStep(step({ tool: { name: 'schedule' }, state: 'RUNNING' }))
    assert.equal(last(), true, 'a backgrounded schedule must suspend the reaper')

    // 2. agy asks the model for a short status update before it goes idle; that
    //    text/thinking must NOT release the wait (this is the ordering in #148).
    wd.trackStep({ kind: 'step', stepKey: 't1', stepKind: 'text', text: 'waiting 30s' } as AgyEvent)
    assert.equal(last(), true, 'a pre-idle status line must not release the wait')
    wd.trackStep({ kind: 'step', stepKey: 't2', stepKind: 'thinking', text: 'hmm' } as AgyEvent)
    assert.equal(last(), true, 'thinking must not release the wait either')

    // 3. The background task completes.
    wd.trackStep(step({ tool: { name: 'schedule' }, state: 'DONE' }))
    assert.equal(last(), false, 'the completion releases the wait')
  } finally {
    wd.stop()
  }
})

test('issue #148: a backgrounded run_command keeps the #119 behaviour (no blanket exemption)', () => {
  const cfg = resolveConfig({}, {}, {})
  const { proc, last } = fakeProc()
  const wd = createToolWatchdog(undefined, cfg)
  wd.attach(proc)
  try {
    // run_command also starts daemons (dev servers, watchers) that never report
    // back; exempting it wholesale would resurrect the orphan #119 reclaims. A
    // backgrounded BUILD is protected by agy's own `N background task(s)` count
    // instead (idle-line.ts), which disarms the reaper without an exemption.
    wd.trackStep(step({ tool: { name: 'run_command' }, state: 'RUNNING' }))
    assert.equal(last(), false, 'run_command must keep the reaper so daemons are reclaimed')
  } finally {
    wd.stop()
  }
})

test('issue #148: a completed tool followed by text still restores the idle budget', () => {
  const cfg = resolveConfig({}, {}, {})
  const { proc, last } = fakeProc()
  const wd = createToolWatchdog(undefined, cfg)
  wd.attach(proc)
  try {
    // No background wait involved: the existing "text after a finished tool"
    // behaviour must be preserved so the normal idle budget returns.
    wd.trackStep(step({ tool: { name: 'read_file' }, state: 'DONE' }))
    assert.equal(last(), false, 'a finished read_file never suspends the reaper')
  } finally {
    wd.stop()
  }
})
