// Issue #225: an ACP turn that is ONLY waiting on a one-shot agy `schedule`
// timer used to hold the DSH turn open until the timer fired (10-minute gaps,
// new user messages queued, the wake-up landing inside the same turn).
//
// `runAcpTurn` now releases such a turn after `scheduleReleaseMs` of quiet:
// the prompt is cancelled on agy's side and resolved as `end_turn`, so the
// normal settle path re-arms the timer and the background wakeup opens a new
// turn when it fires. A real foreground tool still running blocks the release.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isScheduleToolName, runAcpTurn, scheduleDurationSeconds, type AcpTurnHost, type AcpPromptOptions } from '../../../src/features/acp/turn.ts'
import { defaultConfig } from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import { AcpProcess } from '../../../src/features/acp/client.ts'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'
import { runAcpAttempt } from '../../../src/features/acp/run-attempt.ts'
import { RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../../../src/provider/attempt.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakeHost(): AcpTurnHost & {
  push: (u: Record<string, unknown>) => void
  cancelled: string[]
  promptResponse: ReturnType<typeof deferred<Record<string, unknown>>>
} {
  let listener: ((u: Record<string, unknown>) => void) | null = null
  const cancelled: string[] = []
  const promptResponse = deferred<Record<string, unknown>>()
  const host: AcpTurnHost = {
    subscribeSession: (_sid, l) => { listener = l; return () => { listener = null } },
    request: () => promptResponse.promise,
    cancelSession: (sid) => { cancelled.push(sid) },
  }
  return Object.assign(host, {
    cancelled,
    promptResponse,
    push: (u: Record<string, unknown>) => listener?.(u),
  })
}

const SCHEDULE_CALL = { sessionUpdate: 'tool_call', toolCallId: 'tc-sched', name: 'schedule', status: 'in_progress', rawInput: { DurationSeconds: 600, Prompt: 'Check the monitor.' } }
const SCHEDULE_DONE = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-sched', status: 'completed' }
const REPLY = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Monitoring started; I will report when the timer fires.' } }

function options(host: AcpTurnHost, over: Partial<Parameters<typeof runAcpTurn>[1]> = {}): Parameters<typeof runAcpTurn>[1] {
  return {
    sessionId: 'sess-1',
    text: 'hi',
    timeoutMs: 15 * 60_000,
    idleTimeoutMs: 15 * 60_000,
    scheduleReleaseMs: 10_000,
    onUpdate: () => {},
    ...over,
  }
}

test('schedule helpers recognise the tool and its one-shot delay however ACP spells them', () => {
  assert.equal(isScheduleToolName('schedule'), true)
  assert.equal(isScheduleToolName('Schedule'), true)
  assert.equal(isScheduleToolName(' schedule '), true)
  assert.equal(isScheduleToolName('schedule_task'), false, 'only agy\'s own tool, like the post-turn extractor')
  assert.equal(isScheduleToolName('run_command'), false)
  assert.equal(isScheduleToolName(undefined), false)
  assert.equal(scheduleDurationSeconds({ DurationSeconds: 600 }), 600)
  assert.equal(scheduleDurationSeconds({ duration_seconds: '90' }), 90)
  assert.equal(scheduleDurationSeconds({ DurationSeconds: 0, CronExpression: '* * * * *' }), 0, 'cron-only is not one-shot')
  assert.equal(scheduleDurationSeconds({ CronExpression: '* * * * *' }), 0)
  assert.equal(scheduleDurationSeconds(undefined), 0)
  assert.equal(scheduleDurationSeconds('text'), 0)
})

test('#225 a turn that only waits on a one-shot schedule is released after the quiet window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const host = fakeHost()
  const updates: Record<string, unknown>[] = []
  const releases: Array<{ delayMs: number }> = []
  const pending = runAcpTurn(host, options(host, { onUpdate: (u) => updates.push(u), onScheduleRelease: (info) => releases.push(info) }))
  await Promise.resolve()
  host.push(SCHEDULE_CALL)
  t.mock.timers.tick(1_000)
  host.push(SCHEDULE_DONE)
  t.mock.timers.tick(500)
  host.push(REPLY)
  await Promise.resolve()
  t.mock.timers.tick(9_999)
  assert.deepEqual(host.cancelled, [], 'inside the quiet window the turn is untouched')
  t.mock.timers.tick(1)
  await Promise.resolve()
  const result = await pending
  assert.deepEqual(host.cancelled, ['sess-1'], 'the parked prompt is cancelled on agy so the cascade lets go')
  assert.deepEqual(releases, [{ delayMs: 600_000 }])
  assert.equal(result.stopReason, 'end_turn', 'released as a normal end of turn, never as a cancel')
  assert.equal(result._agyScheduleRelease, true)
  assert.equal(updates.length, 3, 'every update still reached the stream')
  // A late answer from agy to the cancelled prompt must not change anything.
  host.promptResponse.resolve({ stopReason: 'cancelled' })
  await Promise.resolve()
  assert.equal(result.stopReason, 'end_turn')
})

test('#225 a foreground tool still running blocks the release until it finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const host = fakeHost()
  const pending = runAcpTurn(host, options(host))
  await Promise.resolve()
  host.push(SCHEDULE_CALL)
  host.push({ sessionUpdate: 'tool_call', toolCallId: 'tc-cmd', name: 'run_command', status: 'in_progress', rawInput: { CommandLine: 'npm test' } })
  host.push(SCHEDULE_DONE)
  t.mock.timers.tick(60_000)
  assert.deepEqual(host.cancelled, [], 'a real tool is running: the long-tool idle budget applies, no release')
  host.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-cmd', status: 'completed' })
  t.mock.timers.tick(9_999)
  assert.deepEqual(host.cancelled, [], 'quiet window restarts from the tool completion')
  t.mock.timers.tick(1)
  await Promise.resolve()
  const result = await pending
  assert.equal(result._agyScheduleRelease, true)
  assert.deepEqual(host.cancelled, ['sess-1'])
})

test('#225 new model activity resets the quiet window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const host = fakeHost()
  const pending = runAcpTurn(host, options(host))
  await Promise.resolve()
  host.push(SCHEDULE_CALL)
  host.push(SCHEDULE_DONE)
  t.mock.timers.tick(6_000)
  host.push(REPLY)
  t.mock.timers.tick(9_999)
  assert.deepEqual(host.cancelled, [], 'six seconds after the schedule the model spoke: counted from there')
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal((await pending)._agyScheduleRelease, true)
})

test('#225 scheduleReleaseMs=0 keeps the turn open (the old behaviour)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const host = fakeHost()
  const pending = runAcpTurn(host, options(host, { scheduleReleaseMs: 0, idleTimeoutMs: 60_000 }))
  await Promise.resolve()
  host.push(SCHEDULE_CALL)
  host.push(SCHEDULE_DONE)
  host.push(REPLY)
  t.mock.timers.tick(30_000)
  assert.deepEqual(host.cancelled, [], 'no release')
  host.promptResponse.resolve({ stopReason: 'end_turn' })
  assert.equal((await pending).stopReason, 'end_turn')
})

test('#225 cron-only, failed, or not-yet-completed schedules never release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  // Cron-only
  const cron = fakeHost()
  const p1 = runAcpTurn(cron, options(cron, { idleTimeoutMs: 60_000 }))
  await Promise.resolve()
  cron.push({ sessionUpdate: 'tool_call', toolCallId: 'c', name: 'schedule', status: 'in_progress', rawInput: { CronExpression: '* * * * *' } })
  cron.push({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' })
  t.mock.timers.tick(30_000)
  assert.deepEqual(cron.cancelled, [], 'recurring cron: nothing to hand off')
  cron.promptResponse.resolve({ stopReason: 'end_turn' })
  await p1

  // Failed schedule call
  const failed = fakeHost()
  const p2 = runAcpTurn(failed, options(failed, { idleTimeoutMs: 60_000 }))
  await Promise.resolve()
  failed.push(SCHEDULE_CALL)
  failed.push({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-sched', status: 'failed' })
  t.mock.timers.tick(30_000)
  assert.deepEqual(failed.cancelled, [], 'a timer that was never armed must not end the turn')
  failed.promptResponse.resolve({ stopReason: 'end_turn' })
  await p2

  // The schedule call has not completed yet: cancelling now could kill the timer before it is set
  const open = fakeHost()
  const p3 = runAcpTurn(open, options(open, { idleTimeoutMs: 60_000 }))
  await Promise.resolve()
  open.push(SCHEDULE_CALL)
  t.mock.timers.tick(30_000)
  assert.deepEqual(open.cancelled, [], 'wait for the schedule call to complete')
  open.promptResponse.resolve({ stopReason: 'end_turn' })
  await p3
})

test('#225 runAcpAttempt arms the release only with backgroundWakeup and records a visible notice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-schedule-release-'))
  const store = new SessionStore(join(root, 'sessions.json'))
  const account: ManagedAccount = { id: 'acc_2', alias: 'second', email: 'sec@example.com', dir: join(root, 'iso'), enabled: true, createdAt: 1, cooldowns: {}, quotas: {} }
  try {
    for (const backgroundWakeup of [false, true]) {
      const promptOpts: Partial<AcpPromptOptions>[] = []
      const pool = new AcpSessionPool({
        bin: () => 'agy',
        cfg: () => defaultConfig(),
        createProcess: () => {
          let alive = true
          return {
            pid: 700, logFilePath: null, isAlive: () => alive, isBusy: false, hasActivePrompt: () => false, hasOpenSession: () => false,
            sessionCount: 0, lastUsedAt: Date.now(), advertisedCommands: [], once: () => {}, close: () => { alive = false },
            stderrOffset: () => 0, readStderrSince: () => '', supportsImageBlocks: false,
            openSession: async () => ({ sessionId: 'sid-rel', status: 'created' as const, resumeFailed: false }),
            prompt: async (opts: AcpPromptOptions) => {
              promptOpts.push(opts)
              // The model set a one-shot timer and said so; the turn is released for it.
              opts.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-s', name: 'schedule', status: 'completed', rawInput: { DurationSeconds: 120 } })
              opts.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Timer set.' } })
              // runAcpTurn only releases when the quiet window is armed (scheduleReleaseMs > 0).
              if (opts.scheduleReleaseMs !== undefined && opts.scheduleReleaseMs > 0) opts.onScheduleRelease?.({ delayMs: 120_000 })
              return { stopReason: 'end_turn', _agyScheduleRelease: true }
            },
            cancelSession: () => {},
            closeSession: async () => {},
          } as unknown as AcpProcess
        },
      })
      const deps: AttemptDeps = {
        acquire: async () => () => {}, runs: new RunRegistry(), store, clearInFlightPrompt: () => {},
        registerActiveRun: () => {}, unregisterActiveRun: () => {}, isSuperseded: () => false,
        noteNetworkFailure: () => 0, clearNetworkStreak: () => {}, dropFailoverBudget: () => {}, clearRateLimitFailover: () => {},
        sharesSingleEgress: () => false, lastAccountSpawnTime: new Map(), minSpawnIntervalMs: 0,
      }
      const input: AttemptInput = {
        cfg: { ...defaultConfig(), transport: 'acp', permissionMode: 'skip', backgroundWakeup },
        bin: 'agy', permissionMode: 'skip', sessionKey: 's-rel-' + backgroundWakeup, sessionAccountKey: 's-rel:acc_2',
        isAux: false, account, prompt: 'hi', model: 'gemini-4-neon', activeModel: 'gemini-4-neon', effort: '', addDirs: [],
        persistBinding: false, binding: undefined, messages: [], newlySentImageIds: [], family: 'google', sandbox: false, agent: '',
        workspaceRoot: root, signal: undefined, agyOnEvent: undefined,
      }
      const slot: AttemptSlot = { armHandoff: () => ({ onFirstEvent: () => {}, dispose: () => {}, released: () => false, timedOut: () => false }), releaseOnce: () => {} }
      const rec = await runAcpAttempt(pool, deps, input, slot)
      assert.ok(rec, 'the attempt streams')
      assert.equal(promptOpts.length, 1)
      if (backgroundWakeup) {
        assert.equal(promptOpts[0]!.scheduleReleaseMs, defaultConfig().scheduleReleaseSeconds * 1000, 'armed from scheduleReleaseSeconds')
      } else {
        assert.equal(promptOpts[0]!.scheduleReleaseMs, undefined, 'no background wakeup, no DSH-side timer: the turn must stay open')
      }
      const deadline = Date.now() + 3_000
      while (!(rec as { isSettled?: boolean }).isSettled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15))
      let notice: { text: string } | undefined
      for (let i = 0; i < rec.length; i++) {
        const e = rec.eventAt(i)
        if (e?.kind === 'step' && e.stepKey === 'acp-schedule-release-120s') notice = e
      }
      if (backgroundWakeup) {
        assert.ok(notice, 'the release is explained in the transcript')
        assert.match((notice as { text: string }).text, /\[定时巡检\] 已设置 120s/)
      } else {
        assert.equal(notice, undefined, 'the hook is never invoked without the release being armed')
      }
      pool.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
