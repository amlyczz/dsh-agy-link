import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveConfig } from '../src/common/config.ts'
import { defaultConfig } from '../src/common/types.ts'
import { extractAttemptBackgroundSignals, isBackgroundWakeupNotice, matchesTimerCondition } from '../src/features/background/schedule-parse.ts'
import { BackgroundWakeWatcher } from '../src/features/background/watcher.ts'
import { agyCommandDefinition } from '../src/host/commands.ts'
import { createHostServices } from '../src/host/services.ts'
import { RunRecording } from '../src/host/recording.ts'
import { isSyntheticHarnessMessage, latestUserTaskText } from '../src/provider/prompt-text.ts'
import { registerRoutes } from '../src/transport/http/router.ts'

describe('cross-turn background wakeup, slice 1: one-shot schedule timers', () => {
  test('config resolves and clamps backgroundWakeup knobs with env overrides', () => {
    const def = defaultConfig()
    // Opt-in: a fresh install must not start speaking on its own after the turn.
    assert.equal(def.backgroundWakeup, false)
    assert.equal(def.backgroundWakeupTtlMinutes, 30)
    assert.equal(def.backgroundWakeupMaxPerSession, 12)

    const envOn = resolveConfig({}, { DSH_AGY_BACKGROUND_WAKEUP: 'on' }, {})
    assert.equal(envOn.backgroundWakeup, true)

    const envCfg = resolveConfig(
      {},
      {
        DSH_AGY_BACKGROUND_WAKEUP: 'off',
        DSH_AGY_BACKGROUND_WAKEUP_TTL_MINUTES: '999',
        DSH_AGY_BACKGROUND_WAKEUP_MAX_PER_SESSION: '500',
      },
      {},
    )
    assert.equal(envCfg.backgroundWakeup, false)
    assert.equal(envCfg.backgroundWakeupTtlMinutes, 240)
    assert.equal(envCfg.backgroundWakeupMaxPerSession, 100)
  })

  test('buildPromptPlan forward check: wakeup notice is never treated as a synthetic snapshot', () => {
    const msg = createUserMessage({
      content: [{ type: 'text', text: '[Background Task Wakeup] timer fired — run verification' }],
      source: {
        kind: 'plugin',
        plugin: 'agy-link',
        form: 'notice',
        summary: boundContextSummary('Scheduled timer: verify'),
      },
    })
    assert.equal(isBackgroundWakeupNotice(msg), true)
    assert.equal(isSyntheticHarnessMessage(msg), false)
    assert.equal(latestUserTaskText([msg]), '[Background Task Wakeup] timer fired — run verification')
  })

  test('wakes idle session via resolveAgent + agent.followup after one-shot CLI schedule timer expires', async () => {
    const cfg = { ...defaultConfig(), backgroundWakeup: true }
    const followups: Array<ReturnType<typeof createUserMessage>> = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => cfg,
      coalesceMs: 25,
      resolveAgent: async () => ({
        status: 'idle',
        inbox: { nextTurn: [] },
        followup: (m) => followups.push(m),
      }),
    })

    try {
      const rec = new RunRecording()
      rec.append({
        kind: 'step',
        stepKey: 'step-sched-1',
        stepKind: 'tool',
        state: 'RUNNING',
        text: '',
        tool: { name: 'schedule', args: { DurationSeconds: 0.1, Prompt: 'check build result' } },
      })
      rec.append({ kind: 'result', ok: true, response: 'Scheduled check.', conversationId: 'conv-s1', usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptStart('sess-1')
      watcher.onAttemptSettled({
        sessionKey: 'sess-1',
        conversationId: 'conv-s1',
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })

      assert.equal(watcher.status().pendingTimers, 1)
      await new Promise((r) => setTimeout(r, 700))
      assert.equal(followups.length, 1)
      const txt = (followups[0]?.content[0] as { text?: string })?.text ?? ''
      assert.ok(txt.includes('Scheduled timer'))
      assert.ok(txt.includes('check build result'))
      assert.equal(watcher.status().pendingTimers, 0)
    } finally {
      watcher.dispose()
    }
  })

  test('TimerCondition cancels the early timer when the matching completion notice arrives first', async () => {
    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 25,
      resolveAgent: async () => ({
        status: 'idle',
        inbox: { nextTurn: [] },
        followup: (m) => followups.push((m.content[0] as { text?: string })?.text ?? ''),
      }),
    })

    try {
      const rec = new RunRecording()
      rec.append({
        kind: 'step',
        stepKey: 'step-sched',
        stepKind: 'tool',
        state: 'RUNNING',
        text: '',
        tool: { name: 'schedule', args: { DurationSeconds: 5, Prompt: 'fallback check', TimerCondition: 'task-42' } },
      })
      rec.append({ kind: 'result', ok: true, response: 'Waiting.', conversationId: 'conv-cond-1', usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-cond',
        conversationId: 'conv-cond-1',
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })
      assert.equal(watcher.status().pendingTimers, 1)

      // The completion notice for task-42 reaches the watcher first.
      watcher.noteNotice('sess-cond', { kind: 'task-log', label: 'Task task-42 finished', detail: 'tests passed', sender: 'task-42' })
      await new Promise((r) => setTimeout(r, 250))

      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('Task task-42 finished'))
      assert.equal(watcher.status().pendingTimers, 0, 'matching condition cancels the pending schedule timer')
    } finally {
      watcher.dispose()
    }
  })

  test('respects archive, running-agent deferral, duplicate inbox, max cap, and onHumanTurn reset', async () => {
    let archived = false
    let agentStatus: 'idle' | 'running' = 'running'
    let releaseIdle = (): void => {}
    let inboxNextTurn: { nextTurn: Array<{ source: { plugin: string; form: string } }> } = { nextTurn: [] }
    const followups: string[] = []
    const cfg = { ...defaultConfig(), backgroundWakeup: true, backgroundWakeupMaxPerSession: 2 }

    const watcher = new BackgroundWakeWatcher({
      getConfig: () => cfg,
      coalesceMs: 25,
      isArchived: (sid) => archived && sid === 'sess-g',
      resolveAgent: async () => ({
        status: agentStatus,
        inbox: inboxNextTurn,
        whenIdle: () => new Promise<void>((r) => { releaseIdle = r }),
        followup: (m) => followups.push((m.content[0] as { text?: string })?.text ?? ''),
      }),
    })

    try {
      const rec = new RunRecording()
      rec.append({
        kind: 'step',
        stepKey: 's1',
        stepKind: 'tool',
        state: 'RUNNING',
        text: '',
        tool: { name: 'schedule', args: { DurationSeconds: 0.1, Prompt: 'first timer' } },
      })
      rec.append({ kind: 'result', ok: true, response: 'ok', conversationId: 'conv-guard-1', usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-g',
        conversationId: 'conv-guard-1',
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })

      // Wait until the timer fires while the agent is still running -> must defer
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 0)

      // Transition the agent to idle -> the wakeup flushes
      agentStatus = 'idle'
      releaseIdle?.()
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(followups.length, 1)

      // A notice already queued in the inbox must not be double-enqueued
      inboxNextTurn = { nextTurn: [{ source: { plugin: 'agy-link', form: 'notice' } }] }
      const rec2 = new RunRecording()
      rec2.append({ kind: 'step', stepKey: 's2', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'dup skip' } } })
      rec2.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-g', conversationId: 'conv-guard-1', transport: 'cli', recording: rec2, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 1)

      // Archive guard drops everything cleanly
      inboxNextTurn = { nextTurn: [] }
      archived = true
      const rec3 = new RunRecording()
      rec3.append({ kind: 'step', stepKey: 's3', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'archived skip' } } })
      rec3.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-g', conversationId: 'conv-guard-1', transport: 'cli', recording: rec3, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 1)

      // onHumanTurn resets the counter and drops pending watches
      archived = false
      watcher.onHumanTurn('sess-g')
      assert.equal(watcher.status().activeWatches, 0)
    } finally {
      watcher.dispose()
    }
  })

  test('/agy wakeup command toggles the config and helpers match conditions properly', async () => {
    const overrides: Record<string, unknown> = {}
    const def = agyCommandDefinition({
      cfg: () => ({ ...defaultConfig(), ...(overrides.backgroundWakeup !== undefined ? { backgroundWakeup: overrides.backgroundWakeup as boolean } : {}) }),
      bin: () => null,
      version: () => '1.0.0',
      auth: () => null,
      catalog: () => ({ get: () => ({ source: 'fallback', models: [] }) }),
      store: () => ({ all: () => ({}) }),
      lastRun: () => null,
      setOverride: (k: string, v: unknown) => { overrides[k] = v },
      runDoctor: async () => '',
      backgroundStatus: () => ({ enabled: true, activeWatches: 1, pendingTimers: 2, pendingTasks: 1 }),
    } as never)

    const stRes = await def.handler({ rawInput: 'wakeup status' } as never)
    assert.ok(stRes.text?.includes('watches: 1, timers: 2, tasks: 1'))
    const offRes = await def.handler({ rawInput: 'wakeup off' } as never)
    assert.equal(overrides.backgroundWakeup, false)
    assert.ok(offRes.text?.includes('off'))

    assert.equal(matchesTimerCondition('any', 'task-1'), true)
    assert.equal(matchesTimerCondition('never', 'task-1'), false)
    assert.equal(matchesTimerCondition('task-42', 'conv/task-42'), true)
    assert.equal(matchesTimerCondition('task-42', 'conv/task-99'), false)

    const cronRec = new RunRecording()
    cronRec.append({ kind: 'step', stepKey: 'c1', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { CronExpression: '*/5 * * * *', Prompt: 'poll' } } })
    const sig = extractAttemptBackgroundSignals(cronRec)
    assert.equal(sig.ignoredRecurringCron, true)
    assert.equal(sig.schedules.length, 0)
  })

  test('defers while a live run is unsettled and enforces max wakes per session', async () => {
    const liveRun = new RunRecording()
    const followups: string[] = []
    const cfg = { ...defaultConfig(), backgroundWakeup: true, backgroundWakeupMaxPerSession: 1 }

    const watcher = new BackgroundWakeWatcher({
      getConfig: () => cfg,
      coalesceMs: 25,
      getActiveRun: () => liveRun,
      resolveAgent: async () => ({
        status: 'idle',
        inbox: { nextTurn: [] },
        followup: (m) => followups.push((m.content[0] as { text?: string })?.text ?? ''),
      }),
    })

    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 's-live', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'after live run' } } })
      rec.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-live', conversationId: 'conv-live', transport: 'cli', recording: rec, failure: null, superseded: false })

      // The timer fires while the run is still unsettled -> deferred
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 0)

      // Live run settles -> the deferred wakeup fires after the short backoff
      liveRun.settle(null)
      await new Promise((r) => setTimeout(r, 1_700))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('after live run'))

      // Second wakeup hits maxPerSession=1 until the next human turn
      const rec2 = new RunRecording()
      rec2.append({ kind: 'step', stepKey: 's-cap', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'over cap' } } })
      rec2.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-live', conversationId: 'conv-live', transport: 'cli', recording: rec2, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 1)
    } finally {
      watcher.dispose()
    }
  })

  test('HTTP /status exposes backgroundWakeup and /config toggles it cleanly', async () => {
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = []
    let bw = true
    const written: Array<[string, unknown]> = []
    registerRoutes(
      { register: (r) => { routes.push({ path: r.path, handler: r.handler as (req: unknown, res: unknown) => void }); return () => {} } },
      {
        getConfig: () => ({ ...defaultConfig(), backgroundWakeup: bw }),
        status: { version: '1.0.0', dormantReason: null },
        bin: () => 'agy',
        store: { all: () => ({}) },
        pool: { getPoolData: () => ({ accounts: [] }), getActiveAccountId: () => undefined, getAccounts: () => [] },
        catalog: { get: () => ({ source: 'fallback', models: [] }), getUnion: () => [], getModelsForAccount: () => [] },
        auth: { status: () => ({ phase: 'ok' }) },
        poolAuth: { status: () => ({ phase: 'idle' }) },
        adapter: { effortUnsupportedModels: () => [] },
        acpPool: { status: () => ({ activeProcesses: 0, sessions: 0, keys: [] }) },
        backgroundWakeup: { status: () => ({ enabled: bw, activeWatches: 0, pendingTimers: 0, pendingTasks: 0 }) },
        translation: { pendingFor: () => [], stats: () => ({}) },
        lastRun: null,
        hostDir: '',
        mediaDir: () => '',
        activeCwds: () => [],
        setOverride: (k: string, v: unknown) => {
          written.push([k, v])
          if (k === 'backgroundWakeup' && typeof v === 'boolean') bw = v
        },
        notifyPicker: () => {},
        onConfigWritten: () => {},
      } as never,
    )

    const statusRoute = routes.find((r) => r.path === '/plugins/agy-link/status')!
    let statusBody = ''
    statusRoute.handler({ method: 'GET', headers: {} }, {
      statusCode: 200,
      writeHead: () => {},
      setHeader: () => {},
      end: (d?: string) => { statusBody = d ?? '' },
    })
    await new Promise((r) => setTimeout(r, 20))
    const parsedStatus = JSON.parse(statusBody) as Record<string, unknown>
    assert.equal(parsedStatus.backgroundWakeup, true)
    assert.deepEqual(parsedStatus.backgroundWakeState, { enabled: true, activeWatches: 0, pendingTimers: 0, pendingTasks: 0 })

    const cfgReq = Object.assign(
      Readable.from([Buffer.from(JSON.stringify({ key: 'backgroundWakeup', value: false }))]),
      { method: 'POST', headers: {} },
    )
    const cfgRoute = routes.find((r) => r.path === '/plugins/agy-link/config')!
    let cfgCode = 0
    cfgRoute.handler(
      cfgReq,
      {
        statusCode: 200,
        writeHead: (c: number) => { cfgCode = c },
        setHeader: () => {},
        end: () => { if (!cfgCode) cfgCode = 200 },
      },
    )
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(cfgCode, 200)
    assert.deepEqual(written, [['backgroundWakeup', false]])
    assert.equal(bw, false)
  })

  test('createHostServices resolves sessionController under a real Cordis Context without an agents proxy', async () => {
    const ctx = new Context()
    const followups: Array<ReturnType<typeof createUserMessage>> = []
    ctx.provide('sessionController')
    ctx.set('sessionController', {
      async resolveAgent() {
        return {
          agent: {
            status: 'idle',
            inbox: { nextTurn: [] },
            followup: (m: ReturnType<typeof createUserMessage>) => followups.push(m),
          },
        }
      },
    })
    const services = createHostServices(ctx, { enabled: true, backgroundWakeup: true })
    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 's-cordis', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'cordis wake' } } })
      rec.settle(null)
      services.backgroundWakeup.onAttemptSettled({
        sessionKey: 'sess-cordis-1',
        conversationId: 'conv-cordis-1',
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })
      await new Promise((r) => setTimeout(r, 1_100))
      assert.equal(followups.length, 1)
      const txt = (followups[0]?.content[0] as { text?: string })?.text ?? ''
      assert.ok(txt.includes('cordis wake'))
    } finally {
      services.backgroundWakeup.dispose()
      services.acpPool.dispose()
      services.translationWorkers?.dispose()
      await (ctx as unknown as { stop?: () => Promise<void> }).stop?.()
    }
  })
})
