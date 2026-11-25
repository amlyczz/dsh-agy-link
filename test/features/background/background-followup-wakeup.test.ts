import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveConfig } from '../../../src/common/config.ts'
import { defaultConfig } from '../../../src/common/types.ts'
import { extractAttemptBackgroundSignals, isBackgroundWakeupNotice, matchesTimerCondition } from '../../../src/features/background/schedule-parse.ts'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'
import { BackgroundWakeWatcher } from '../../../src/features/background/watcher.ts'
import { setAgyDbDir } from '../../../src/runtime/agy/db/paths.ts'
import { agyCommandDefinition } from '../../../src/host/commands.ts'
import { createHostServices } from '../../../src/host/services.ts'
import { sandboxEnv } from '../../helpers/sandbox-env.ts'
import { RunRecording } from '../../../src/host/recording.ts'
import { isSyntheticHarnessMessage, latestUserTaskText } from '../../../src/provider/prompt-text.ts'
import { registerRoutes } from '../../../src/transport/http/router.ts'

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
        kind: 'plugin:agy-link',
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
    let inboxNextTurn: { nextTurn: Array<{ source: { kind: string; form: string } }> } = { nextTurn: [] }
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
      inboxNextTurn = { nextTurn: [{ source: { kind: 'plugin:agy-link', form: 'notice' } }] }
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
    const sandboxDir = mkdtempSync(join(tmpdir(), 'agy-wakeup-services-'))
    const restoreEnv = sandboxEnv(sandboxDir)
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
      restoreEnv()
      rmSync(sandboxDir, { recursive: true, force: true })
    }
  })
})

describe('cross-turn background wakeup, slice 2: task logs, completion messages, subagents', () => {
  const origDbDir = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')

  /** Build a throwaway conversation brain dir and point the resolver at it. */
  function makeBrain(convId: string): { root: string; brain: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'agy-brain-'))
    setAgyDbDir(join(root, 'conversations'))
    const brain = join(root, 'brain', convId)
    mkdirSync(join(brain, '.system_generated', 'messages'), { recursive: true })
    mkdirSync(join(brain, '.system_generated', 'tasks'), { recursive: true })
    mkdirSync(join(brain, '.system_generated', 'subagents'), { recursive: true })
    return { root, brain, cleanup: () => { rmSync(root, { recursive: true, force: true }); setAgyDbDir(origDbDir) } }
  }

  function liveBackgroundRecording(convId: string, state = 'RUNNING'): RunRecording {
    const rec = new RunRecording()
    rec.append({
      kind: 'step',
      stepKey: 'bg-1',
      stepKind: 'tool',
      state,
      text: '',
      tool: { name: 'run_command', args: { CommandLine: 'npm run build' } },
    })
    rec.append({ kind: 'result', ok: true, response: 'Started in the background.', conversationId: convId, usage: {}, raw: null })
    rec.settle(null)
    return rec
  }

  test('a live background call is detected in both the CLI and the ACP status vocabulary', () => {
    const cli = liveBackgroundRecording('conv-cli')
    assert.equal(extractAttemptBackgroundSignals(cli).backgroundTools.length, 1)

    // The ACP transport reports pending / in_progress / completed and maps a
    // live call to ACTIVE; only looking for RUNNING would silently miss it.
    for (const state of ['ACTIVE', 'pending', 'in_progress']) {
      assert.equal(extractAttemptBackgroundSignals(liveBackgroundRecording('conv-acp', state)).backgroundTools.length, 1, state)
    }
    // A call that already reported a terminal state was not left running.
    for (const state of ['DONE', 'ERROR', 'CANCELED']) {
      assert.equal(extractAttemptBackgroundSignals(liveBackgroundRecording('conv-done', state)).backgroundTools.length, 0, state)
    }
  })

  test('a completion message written after the turn wakes the session exactly once', async () => {
    const { brain, cleanup } = makeBrain('conv-msg')
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
      // Present before the turn ended: baseline must swallow it.
      writeFileSync(join(brain, '.system_generated', 'messages', 'old.json'), JSON.stringify({ id: 'old', content: 'stale news' }))
      watcher.onAttemptSettled({
        sessionKey: 'sess-msg',
        conversationId: 'conv-msg',
        transport: 'cli',
        recording: liveBackgroundRecording('conv-msg'),
        failure: null,
        superseded: false,
      })
      assert.equal(watcher.status().pendingTasks, 1)

      writeFileSync(join(brain, '.system_generated', 'messages', 'new.json'), JSON.stringify({
        id: 'new-1',
        sender: 'conversations/conv-msg',
        renderDetails: { messageTitle: 'Build finished' },
        content: 'exit code 0',
      }))
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 200))

      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('Build finished'))
      assert.ok(!followups[0]?.includes('stale news'), 'the baseline message must not be replayed')

      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 1, 'the same message must not wake twice')
    } finally {
      watcher.dispose()
      cleanup()
    }
  })

  test('the language-server restart notice never wakes the session', async () => {
    const { brain, cleanup } = makeBrain('conv-ls')
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
      watcher.onAttemptSettled({
        sessionKey: 'sess-ls',
        conversationId: 'conv-ls',
        transport: 'cli',
        recording: liveBackgroundRecording('conv-ls'),
        failure: null,
        superseded: false,
      })
      writeFileSync(join(brain, '.system_generated', 'messages', 'restart.json'), JSON.stringify({
        id: 'restart-1',
        content: 'Language server stopped due to server restart',
      }))
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 200))

      assert.equal(followups.length, 0, 'an infrastructure restart is not user-actionable')
      assert.equal(watcher.status().pendingTasks, 0, 'and it clears the watch instead of retrying forever')
    } finally {
      watcher.dispose()
      cleanup()
    }
  })

  test('a task log that reaches a terminal line wakes once, and a pre-existing one never does', async () => {
    const { brain, cleanup } = makeBrain('conv-task')
    const followups: string[] = []
    const tasksDir = join(brain, '.system_generated', 'tasks')
    writeFileSync(join(tasksDir, 'task-1.log'), 'already done\nThe command exited with code 0\n')
    writeFileSync(join(tasksDir, 'task-2.log'), 'still running\n')

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
      watcher.onAttemptSettled({
        sessionKey: 'sess-task',
        conversationId: 'conv-task',
        transport: 'cli',
        recording: liveBackgroundRecording('conv-task'),
        failure: null,
        superseded: false,
      })

      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 0, 'task-1 finished before the turn ended')

      appendFileSync(join(tasksDir, 'task-2.log'), 'The command exited with code 1\n')
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('task-2'))
      assert.ok(followups[0]?.includes('exited with code 1'))

      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 1, 'a terminal log is reported once')
    } finally {
      watcher.dispose()
      cleanup()
    }
  })

  test('a real completion message (task-<n> sender) wakes the session even though its log has no exit marker', async () => {
    // Shape captured from agy 1.5.14 on this machine: the outcome is a message
    // from "<conversation>/task-<n>"; the matching tasks/task-<n>.log holds only
    // the command's own stdout and never contains "Command exited with code".
    const { brain, cleanup } = makeBrain('conv-real')
    const followups: string[] = []
    const tasksDir = join(brain, '.system_generated', 'tasks')
    writeFileSync(join(tasksDir, 'task-11.log'), 'No issues found!\n')

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
      watcher.onAttemptSettled({
        sessionKey: 'sess-real',
        conversationId: 'conv-real',
        transport: 'cli',
        recording: liveBackgroundRecording('conv-real'),
        failure: null,
        superseded: false,
      })

      writeFileSync(join(brain, '.system_generated', 'messages', 'done.json'), JSON.stringify({
        id: 'done-1',
        sender: 'conv-real/task-11',
        renderDetails: { messageTitle: 'Dart analyze 8 touched files finished' },
        content: 'Task id "conv-real/task-11" finished with result:\nCommand exited with code 0.\n\nCommand output:\nNo issues found!\n\nLog: file:///' + join(tasksDir, 'task-11.log').replace(/\\/g, '/'),
      }))
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 200))

      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('Task task-11 finished'), 'the job id must be visible')
      assert.ok(followups[0]?.includes('Command exited with code 0.'), 'the exit line comes from the message body')
      assert.ok(followups[0]?.includes('task-11.log'), 'the log path is carried through')

      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 1, 'a completion message wakes only once')
    } finally {
      watcher.dispose()
      cleanup()
    }
  })

  test('an alive subagent keeps the watch open and its transition wakes the session', async () => {
    const { brain, cleanup } = makeBrain('conv-sub')
    const followups: string[] = []
    const subDir = join(brain, '.system_generated', 'subagents')
    writeFileSync(join(subDir, 'a.json'), JSON.stringify({ conversationId: 'sub-a', state: 'SUBAGENT_STATE_ALIVE' }))

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
      rec.append({ kind: 'result', ok: true, response: 'Delegated.', conversationId: 'conv-sub', usage: {}, raw: null })
      rec.settle(null)
      watcher.onAttemptSettled({
        sessionKey: 'sess-sub',
        conversationId: 'conv-sub',
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })
      // No background tool, but the subagent is still alive -> the watch must stay open.
      assert.equal(watcher.status().pendingTasks, 1)

      writeFileSync(join(subDir, 'a.json'), JSON.stringify({ conversationId: 'sub-a', state: 'SUBAGENT_STATE_DONE' }))
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('sub-a'))
    } finally {
      watcher.dispose()
      cleanup()
    }
  })

  test('wakeup stays off unless backgroundWakeup is enabled', async () => {
    const { brain, cleanup } = makeBrain('conv-off')
    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => defaultConfig(),
      coalesceMs: 25,
      resolveAgent: async () => ({
        status: 'idle',
        inbox: { nextTurn: [] },
        followup: (m) => followups.push((m.content[0] as { text?: string })?.text ?? ''),
      }),
    })
    try {
      watcher.onAttemptSettled({
        sessionKey: 'sess-off',
        conversationId: 'conv-off',
        transport: 'cli',
        recording: liveBackgroundRecording('conv-off'),
        failure: null,
        superseded: false,
      })
      writeFileSync(join(brain, '.system_generated', 'messages', 'n.json'), JSON.stringify({ id: 'n', content: 'anything' }))
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(followups.length, 0)
      assert.equal(watcher.status().pendingTasks, 0)
    } finally {
      watcher.dispose()
      cleanup()
    }
  })
})

describe('cross-turn background wakeup, slice 3: ACP session retention and post-turn updates', () => {
  /** Minimal stand-in for AcpProcess: only what the watch actually uses. */
  function fakeAcp() {
    const listeners = new Map<string, Set<(u: Record<string, unknown>) => void>>()
    return {
      subscribed: 0,
      isAlive: () => true,
      subscribeSession(sid: string, fn: (u: Record<string, unknown>) => void) {
        let set = listeners.get(sid)
        if (!set) { set = new Set(); listeners.set(sid, set) }
        set.add(fn)
        this.subscribed += 1
        return () => { set?.delete(fn) }
      },
      push(sid: string, update: Record<string, unknown>) {
        for (const fn of [...(listeners.get(sid) ?? [])]) fn(update)
      },
      listenerCount(sid: string) { return listeners.get(sid)?.size ?? 0 },
    }
  }

  test('a post-turn tool completion on the retained ACP session wakes the session once', async () => {
    const proc = fakeAcp()
    const followups: string[] = []
    let retained = 0
    let released = 0
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 25,
      // No host-side transcript writer here, so the report degrades to a real
      // followup; the mechanical tool notice keeps its normal grace window.
      acpToolGraceMs: 0,
      acpReportSilenceMs: 25,
      retainAcpSession: () => { retained += 1; return () => { released += 1 } },
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
        stepKey: 'acp-bg-1',
        stepKind: 'tool',
        state: 'ACTIVE',
        text: '',
        tool: { name: 'run_command', args: { CommandLine: 'npm test' } },
      })
      rec.append({ kind: 'result', ok: true, response: 'Running in the background.', conversationId: 'conv-acp', usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-acp',
        conversationId: 'conv-acp',
        transport: 'acp',
        recording: rec,
        failure: null,
        superseded: false,
        acpProcess: proc,
        acpSessionId: 'sid-acp-1',
      })

      assert.equal(proc.subscribed, 1, 'the finished turn subscribes to its own session')
      assert.equal(retained, 1, 'and pins it so the pool cannot sweep the running job')

      proc.push('sid-acp-1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        title: 'npm test',
      })
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('npm test'))

      // The same terminal update arriving twice must not wake twice.
      proc.push('sid-acp-1', { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', title: 'npm test' })
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 1)

      // A non-terminal update is not a wakeup.
      proc.push('sid-acp-1', { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'in_progress', title: 'npm test' })
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 1)

      watcher.onHumanTurn('sess-acp')
      assert.equal(released, 1, 'a human turn drops the pin')
      assert.equal(proc.listenerCount('sid-acp-1'), 0, 'and the listener with it')
    } finally {
      watcher.dispose()
    }
  })

  test('a post-turn assistant message on the ACP session wakes the session', async () => {
    const proc = fakeAcp()
    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 25,
      acpReportSilenceMs: 25,
      retainAcpSession: () => () => {},
      resolveAgent: async () => ({
        status: 'idle',
        inbox: { nextTurn: [] },
        followup: (m) => followups.push((m.content[0] as { text?: string })?.text ?? ''),
      }),
    })
    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 'bg', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { CommandLine: 'sleep 1' } } })
      rec.append({ kind: 'result', ok: true, response: 'ok', conversationId: 'conv-acp2', usage: {}, raw: null })
      rec.settle(null)
      watcher.onAttemptSettled({
        sessionKey: 'sess-acp2',
        conversationId: 'conv-acp2',
        transport: 'acp',
        recording: rec,
        failure: null,
        superseded: false,
        acpProcess: proc,
        acpSessionId: 'sid-acp-2',
      })

      proc.push('sid-acp-2', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  Background run finished cleanly.  ' } })
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('Background run finished cleanly.'))
    } finally {
      watcher.dispose()
    }
  })

  test('an idle sweep keeps the process of a retained session and closes the others', () => {
    const closed: string[] = []
    const procs: Array<{ name: string; open: Set<string>; lastUsedAt: number; isAlive: () => boolean; close: () => void; hasOpenSession: (sid: string) => boolean; sessionCount: number }> = []
    const pool = new AcpSessionPool({
      bin: () => 'agy',
      cfg: () => defaultConfig(),
      idleTtlMs: 1_000,
      createProcess: ((opts: { agent?: string }) => {
        const p = {
          name: opts.agent ?? 'p',
          open: new Set<string>(),
          lastUsedAt: 0,
          isAlive: () => true,
          close: () => { closed.push(p.name) },
          hasOpenSession: (sid: string) => p.open.has(sid),
          sessionCount: 0,
          once: () => p,
        }
        procs.push(p)
        return p
      }) as never,
    })

    try {
      const busy = pool.acquireProcess({ bin: 'agy', cwd: '.', mode: 'skip', sandbox: false, agent: 'busy' })
      const idle = pool.acquireProcess({ bin: 'agy', cwd: '.', mode: 'skip', sandbox: false, agent: 'idle' })
      ;(busy as unknown as { open: Set<string> }).open.add('sid-busy')

      const release = pool.retainSession('sid-busy')
      // Both processes are past the idle TTL; only the unpinned one may go.
      assert.equal(pool.evictIdle(Date.now() + 60_000), 1)
      assert.deepEqual(closed, ['idle'])
      assert.equal((idle as unknown as { isAlive: () => boolean }).isAlive(), true)

      release()
      assert.equal(pool.evictIdle(Date.now() + 60_000), 1)
      assert.deepEqual(closed, ['idle', 'busy'])
    } finally {
      pool.dispose()
    }
  })

  test('an ACP turn with nothing outstanding never subscribes to the session', () => {
    const proc = fakeAcp()
    let retained = 0
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 25,
      retainAcpSession: () => { retained += 1; return () => {} },
      resolveAgent: async () => ({ status: 'idle', inbox: { nextTurn: [] }, followup: () => {} }),
    })
    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 't', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { CommandLine: 'echo done' } } })
      rec.append({ kind: 'result', ok: true, response: 'done', conversationId: 'conv-none', usage: {}, raw: null })
      rec.settle(null)
      watcher.onAttemptSettled({
        sessionKey: 'sess-none',
        conversationId: 'conv-none',
        transport: 'acp',
        recording: rec,
        failure: null,
        superseded: false,
        acpProcess: proc,
        acpSessionId: 'sid-none',
      })
      assert.equal(proc.subscribed, 0)
      assert.equal(retained, 0)
      assert.equal(watcher.status().pendingTasks, 0)
    } finally {
      watcher.dispose()
    }
  })
})


