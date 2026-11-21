import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveConfig } from '../src/common/config.ts'
import { defaultConfig } from '../src/common/types.ts'
import { AcpSessionPool } from '../src/features/acp/pool.ts'
import { extractAttemptBackgroundSignals, isBackgroundWakeupNotice, matchesTimerCondition } from '../src/features/background/schedule-parse.ts'
import { BackgroundWakeWatcher, type AgentLike } from '../src/features/background/watcher.ts'
import { agyCommandDefinition } from '../src/host/commands.ts'
import { createHostServices } from '../src/host/services.ts'
import { RunRecording } from '../src/host/recording.ts'
import { isSyntheticHarnessMessage, latestUserTaskText } from '../src/provider/prompt-text.ts'
import { setAgyDbDir } from '../src/runtime/agy/db/paths.ts'
import { registerRoutes } from '../src/transport/http/router.ts'

describe('cross-turn background wakeup (PR 2)', () => {
  test('config resolves and clamps backgroundWakeup knobs with env overrides', () => {
    const def = defaultConfig()
    assert.equal(def.backgroundWakeup, true)
    assert.equal(def.backgroundWakeupTtlMinutes, 30)
    assert.equal(def.backgroundWakeupMaxPerSession, 12)

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

  test('TimerCondition cancels early timer when matching task completion message wakes first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-wake-cond-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const cid = 'conv-cond-1'
    const sysDir = join(root, '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated')
    const tasksDir = join(sysDir, 'tasks')
    const msgDir = join(sysDir, 'messages')
    mkdirSync(convDir, { recursive: true })
    mkdirSync(tasksDir, { recursive: true })
    mkdirSync(msgDir, { recursive: true })
    setAgyDbDir(convDir)

    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => defaultConfig(),
      pollIntervalMs: 50,
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
        stepKey: 'step-task',
        stepKind: 'tool',
        state: 'RUNNING',
        text: 'Running task-42',
        tool: { name: 'run_command', args: { CommandLine: 'npm test', bgTaskId: 'task-42' } },
      })
      rec.append({
        kind: 'step',
        stepKey: 'step-sched',
        stepKind: 'tool',
        state: 'RUNNING',
        text: '',
        tool: { name: 'schedule', args: { DurationSeconds: 5, Prompt: 'fallback check', TimerCondition: 'task-42' } },
      })
      rec.append({ kind: 'result', ok: true, response: 'Waiting.', conversationId: cid, usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-cond',
        conversationId: cid,
        accountHome: root,
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })
      assert.equal(watcher.status().pendingTimers, 1)

      // Task 42 writes completion log
      writeFileSync(join(tasksDir, 'task-42.log'), 'tests passed\nCommand exited with code 0.\n')
      await new Promise((r) => setTimeout(r, 250))

      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('Task task-42 finished'))
      assert.equal(watcher.status().pendingTimers, 0, 'matching condition cancels pending schedule timer')
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ignores LS server-restart notice, respects archive, running agent deferral, duplicate inbox, max cap, and onHumanTurn reset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-wake-guards-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const cid = 'conv-guard-1'
    const msgDir = join(root, '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated', 'messages')
    mkdirSync(convDir, { recursive: true })
    mkdirSync(msgDir, { recursive: true })
    setAgyDbDir(convDir)

    let archived = false
    let agentStatus: 'idle' | 'running' = 'running'
    let releaseIdle = (): void => {}
    let inboxNextTurn: AgentLike['inbox'] = { nextTurn: [] }
    const followups: string[] = []
    const cfg = { ...defaultConfig(), backgroundWakeupMaxPerSession: 2 }

    const watcher = new BackgroundWakeWatcher({
      getConfig: () => cfg,
      pollIntervalMs: 50,
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
      rec.append({ kind: 'result', ok: true, response: 'ok', conversationId: cid, usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-g',
        conversationId: cid,
        accountHome: root,
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })

      // Wait until timer fires while agent is still running -> must defer
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 0)

      // Transition agent to idle -> wakeup flushes
      agentStatus = 'idle'
      releaseIdle?.()
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(followups.length, 1)

      // Server-restart shutdown message must NOT trigger wake
      writeFileSync(join(msgDir, 'stop.json'), JSON.stringify({
        id: 'stop-1',
        sender: 'system',
        content: '[Notice] All your subagents and background tasks have been stopped due to server restart.',
      }))
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(followups.length, 1)

      // Duplicate notice already queued in inbox -> skip double-enqueue
      inboxNextTurn = { nextTurn: [{ source: { plugin: 'agy-link', form: 'notice' } }] }
      const rec2 = new RunRecording()
      rec2.append({ kind: 'step', stepKey: 's2', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'dup skip' } } })
      rec2.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-g', conversationId: cid, accountHome: root, transport: 'cli', recording: rec2, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 1)

      // Archive guard drops everything cleanly; onHumanTurn resets counters
      inboxNextTurn = { nextTurn: [] }
      archived = true
      const rec3 = new RunRecording()
      rec3.append({ kind: 'step', stepKey: 's3', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'archived skip' } } })
      rec3.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-g', conversationId: cid, accountHome: root, transport: 'cli', recording: rec3, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 1)

      archived = false
      watcher.onHumanTurn('sess-g')
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('retains active ACP session against evictIdle and wakes on post-turn ACP tool_call_update', async () => {
    const cfg = { ...defaultConfig(), transport: 'acp' as const }
    let listener: (u: Record<string, unknown>) => void = () => {}
    let open = true
    let closed = false
    const fakeProc = {
      isAlive: () => !closed,
      lastUsedAt: 0,
      hasOpenSession: (sid: string) => sid === 'acp-sid-1' && open,
      subscribeSession: (_sid: string, cb: (u: Record<string, unknown>) => void) => {
        listener = cb
        return () => { listener = () => {} }
      },
      once: () => fakeProc,
      close: () => { closed = true },
    }
    const pool = new AcpSessionPool({
      bin: () => 'agy',
      cfg: () => cfg,
      idleTtlMs: 100,
      createProcess: () => fakeProc as never,
    })
    const acquired = pool.acquireProcess({ bin: 'agy', cwd: process.cwd(), mode: 'plan', sandbox: false, agent: '' })
    acquired.lastUsedAt = 0

    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => cfg,
      coalesceMs: 25,
      // Scheme A: a completed tool call waits out the autonomous-report grace
      // window before it is allowed to wake the session.
      acpToolGraceMs: 40,
      retainAcpSession: (sid) => pool.retainSession(sid),
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
        // In the ACP transport the step key IS the tool call id (protocol.ts
        // maps tool_call/tool_call_update to stepKey = update.toolCallId), so
        // the terminal update below must carry the same id to retire it.
        stepKey: 'tc-bg-1',
        stepKind: 'tool',
        state: 'RUNNING',
        text: 'Running in background',
        tool: { name: 'run_command', args: { CommandLine: 'npm run dev' } },
      })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-acp-bg',
        conversationId: 'acp-sid-1',
        transport: 'acp',
        recording: rec,
        failure: null,
        superseded: false,
        acpProcess: fakeProc,
        acpSessionId: 'acp-sid-1',
      })

      // Idle TTL expired (lastUsedAt=0) -> retained session must NOT be evicted!
      assert.equal(pool.evictIdle(10_000), 0)
      assert.equal(closed, false)

      // Post-turn ACP notification arrives -> held for the grace window, then
      // delivered once and the retention is released.
      listener?.({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-bg-1', title: 'dev server', status: 'completed' })
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('dev server (completed)'))
      assert.equal(pool.evictIdle(10_000), 1, 'released session can now be evicted once idle')
      assert.equal(closed, true)
    } finally {
      open = false
      watcher.dispose()
      pool.dispose()
    }
  })

  test('/agy wakeup command toggles config and helpers match conditions properly', async () => {
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

  test('wakes on subagent state transition, defers on unsettled liveRun, and enforces max wakes per session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-wake-subagent-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const cid = 'conv-sub-1'
    const subsDir = join(root, '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated', 'subagents')
    mkdirSync(convDir, { recursive: true })
    mkdirSync(subsDir, { recursive: true })
    setAgyDbDir(convDir)

    writeFileSync(join(subsDir, 'worker-1.json'), JSON.stringify({ conversationId: 'worker-1', state: 'SUBAGENT_STATE_ALIVE' }))
    const liveRun = new RunRecording()
    const followups: string[] = []
    const cfg = { ...defaultConfig(), backgroundWakeupMaxPerSession: 1 }

    const watcher = new BackgroundWakeWatcher({
      getConfig: () => cfg,
      pollIntervalMs: 40,
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
      rec.append({ kind: 'result', ok: true, response: 'Subagent spawned.', conversationId: cid, usage: {}, raw: null })
      rec.settle(null)

      watcher.onAttemptSettled({
        sessionKey: 'sess-sub',
        conversationId: cid,
        accountHome: root,
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })

      // Subagent finishes while liveRun is still unsettled -> defers
      writeFileSync(join(subsDir, 'worker-1.json'), JSON.stringify({ conversationId: 'worker-1', state: 'SUBAGENT_STATE_COMPLETED' }))
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(followups.length, 0)

      // Live run settles -> deferred wakeup fires after short backoff
      liveRun.settle(null)
      await new Promise((r) => setTimeout(r, 1650))
      assert.equal(followups.length, 1)
      assert.ok(followups[0]?.includes('SUBAGENT_STATE_COMPLETED'))

      // Second wakeup hits maxPerSession=1 cap until next human turn
      const rec2 = new RunRecording()
      rec2.append({ kind: 'step', stepKey: 's-cap', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'over cap' } } })
      rec2.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'sess-sub', conversationId: cid, accountHome: root, transport: 'cli', recording: rec2, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 650))
      assert.equal(followups.length, 1)
    } finally {
      watcher.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('HTTP /status exposes backgroundWakeup and /config toggles backgroundWakeup cleanly', async () => {
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

  test('createHostServices resolves sessionController under real Cordis Context without agents proxy injected', async () => {
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
      await new Promise((r) => setTimeout(r, 1100))
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
