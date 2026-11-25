import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'

import { defaultConfig, type AgyEvent } from '../../../src/common/types.ts'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'
import { runAcpAttempt } from '../../../src/features/acp/run-attempt.ts'
import { SubagentTracker } from '../../../src/features/subagent/tracker.ts'
import { TaskActivityTracker, formatTaskLogLine, summarizeMessageJson } from '../../../src/features/subagent/task-activity.ts'
import { AgyAdapter } from '../../../src/host/adapter.ts'
import { ModelCatalog } from '../../../src/host/models.ts'
import { RunRecording, RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import { createAttemptSlot, type AttemptDeps, type AttemptInput } from '../../../src/provider/attempt.ts'
import { EventMapper } from '../../../src/provider/mapper/event-mapper.ts'
import { presentMirrorResult } from '../../../src/provider/mirror/present.ts'
import { setAgyDbDir } from '../../../src/runtime/agy/db/paths.ts'
import { FAKE_AGY } from '../../helpers/paths.ts'

describe('background task visibility (tasks/*.log, messages/*.json, RUNNING cards)', () => {
  test('TaskActivityTracker tails new tasks/*.log lines and deduplicates messages across undelivered/delivered', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-task-activity-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainDir = join(root, '.gemini', 'antigravity-cli', 'brain', 'conv-1')
    const tasksDir = join(brainDir, '.system_generated', 'tasks')
    const msgDir = join(brainDir, '.system_generated', 'messages')
    const undeliveredDir = join(msgDir, 'undelivered')
    mkdirSync(convDir, { recursive: true })
    mkdirSync(tasksDir, { recursive: true })
    mkdirSync(undeliveredDir, { recursive: true })
    setAgyDbDir(convDir)

    try {
      const priorLog = join(tasksDir, 'task-10.log')
      writeFileSync(priorLog, 'old line before resume\n')
      const priorMsg = join(msgDir, 'old-msg.json')
      writeFileSync(priorMsg, JSON.stringify({ id: 'old-msg', sender: 'conv-1/task-10', content: 'old finished' }))

      const tracker = new TaskActivityTracker()
      tracker.baseline(brainDir)

      const emitted: Array<{ stepKey: string; text: string }> = []
      tracker.poll(brainDir, (ev) => emitted.push({ stepKey: ev.stepKey, text: ev.text }))
      assert.equal(emitted.length, 0, 'baseline must suppress pre-existing task log lines and messages')

      // New task-11 created after baseline + appended to priorLog
      writeFileSync(priorLog, 'new line on resumed task\n', { flag: 'a' })
      const freshLog = join(tasksDir, 'task-11.log')
      writeFileSync(freshLog, 'step 1\nstep 2\n')

      // Undelivered message appears first, then identical id moves to delivered/
      const msgBody = JSON.stringify({
        id: 'uuid-msg-1',
        sender: 'conv-1/task-11',
        renderDetails: { messageTitle: 'Build finished' },
        content: 'Task id "conv-1/task-11" finished with result: Command exited with code 0.',
      })
      writeFileSync(join(undeliveredDir, 'uuid-msg-1.json'), msgBody)
      tracker.poll(brainDir, (ev) => emitted.push({ stepKey: ev.stepKey, text: ev.text }))

      assert.ok(emitted.some((e) => e.text.includes('[后台任务 · task-10] new line on resumed task')))
      assert.ok(emitted.some((e) => e.text.includes('[后台任务 · task-11] step 1')))
      assert.ok(emitted.some((e) => e.text.includes('[后台任务 · task-11] step 2')))
      const msgEventsBeforeMove = emitted.filter((e) => e.stepKey === 'task-msg-uuid-msg-1')
      assert.equal(msgEventsBeforeMove.length, 1)
      assert.ok(msgEventsBeforeMove[0]?.text.includes('[后台通知 · task-11]'))
      assert.ok(msgEventsBeforeMove[0]?.text.includes('Build finished'))

      writeFileSync(join(msgDir, 'uuid-msg-1.json'), msgBody)
      tracker.poll(brainDir, (ev) => emitted.push({ stepKey: ev.stepKey, text: ev.text }))
      assert.equal(emitted.filter((e) => e.stepKey === 'task-msg-uuid-msg-1').length, 1, 'same message id moved to delivered/ must not duplicate')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('SubagentTracker integrates TaskActivityTracker and flushes final lines on stop()', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-tracker-tasklog-'))
    const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
    const mainBrain = join(brainBase, 'main-conv-bg')
    const tasksDir = join(mainBrain, '.system_generated', 'tasks')
    mkdirSync(convDir, { recursive: true })
    mkdirSync(tasksDir, { recursive: true })
    setAgyDbDir(convDir)

    const events: AgyEvent[] = []
    let activity = 0
    const tracker = new SubagentTracker({
      conversationId: 'main-conv-bg',
      accountHome: root,
      pollIntervalMs: 5_000,
      onEvent: (ev) => events.push(ev),
      noteActivity: () => {
        activity += 1
      },
    })

    try {
      tracker.start()
      writeFileSync(join(tasksDir, 'task-99.log'), 'running final check\nCommand exited with code 0.\n')
      // stop() flushes one synchronous poll before stopping so tail output isn't lost on exit
      tracker.stop()

      assert.ok(events.some((e) => e.kind === 'step' && e.stepKind === 'subagent' && e.text.includes('[后台任务 · task-99] Command exited with code 0.')))
      assert.ok(activity >= 2)
    } finally {
      tracker.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('EventMapper and presentMirrorResult enrich RUNNING background tool and schedule outputs without breaking cutOnTool', () => {
    const mapper = new EventMapper({ runId: 'run-bg', cutOnTool: true })
    const chunks = Array.from(mapper.map({
      kind: 'step',
      stepKey: 's-bg',
      stepKind: 'tool',
      state: 'RUNNING',
      text: '',
      tool: { name: 'run_command', args: { CommandLine: 'npm run build', bgTaskId: 'task-42' } },
    }, 0))
    const callEnd = chunks.find((c) => c.type === 'block-end')
    assert.ok(callEnd && callEnd.type === 'block-end' && callEnd.block.type === 'tool-call')
    const finish = chunks.find((c) => c.type === 'finish')
    assert.deepEqual(finish, { type: 'finish', reason: { kind: 'tool-calls' } })

    const mapper2 = new EventMapper({ runId: 'run-sched', cutOnTool: true })
    const schedChunks = Array.from(mapper2.map({
      kind: 'step',
      stepKey: 's-sched',
      stepKind: 'tool',
      state: 'RUNNING',
      text: '',
      tool: { name: 'schedule', args: { DurationSeconds: 60, Prompt: 'check task-42' } },
    }, 0))
    const schedEnd = schedChunks.find((c) => c.type === 'block-end')
    assert.ok(schedEnd && schedEnd.type === 'block-end' && schedEnd.block.type === 'tool-call')

    const termCard = presentMirrorResult(
      { tool: 'run_command', input: { CommandLine: 'npm run build' } },
      { content: [{ type: 'text', text: 'Tool is running as a background task (task-42): npm run build' }], isError: false },
    )
    assert.equal(termCard?.card, 'terminal')
    assert.equal((termCard as { exitCode?: number }).exitCode, undefined)
    assert.ok((termCard as { output: string }).output.includes('.system_generated/tasks/task-42.log'))

    const schedCard = presentMirrorResult(
      { tool: 'schedule', input: { DurationSeconds: 60, Prompt: 'check task-42' } },
      { content: [], isError: false },
    )
    assert.equal(schedCard?.card, 'generic')
    const schedText = (schedCard as { content: Array<{ text?: string }> }).content[0]?.text ?? ''
    assert.ok(schedText.includes('[scheduled] 60s timer — check task-42'))
  })

  test('helpers format single-line task logs and ignore invalid message JSON safely', () => {
    assert.ok(formatTaskLogLine('task-1', 'a\r\n  b\tc').includes('[后台任务 · task-1] a b c'))
    assert.equal(summarizeMessageJson(null), null)
    assert.equal(summarizeMessageJson({}), null)
  })

  test('TaskActivityTracker handles split multi-byte UTF-8 sequences and caps large single-poll bursts', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-task-utf8-'))
    const brainDir = join(root, 'brain', 'conv-utf8')
    const tasksDir = join(brainDir, '.system_generated', 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    try {
      const tracker = new TaskActivityTracker()
      const logPath = join(tasksDir, 'task-7.log')
      const lineBytes = Buffer.from('完成检查\n', 'utf8')
      // Write only partial UTF-8 bytes without newline first
      writeFileSync(logPath, lineBytes.subarray(0, 4))
      const out: string[] = []
      tracker.poll(brainDir, (ev) => out.push(ev.text))
      assert.equal(out.length, 0)

      writeFileSync(logPath, lineBytes.subarray(4), { flag: 'a' })
      tracker.poll(brainDir, (ev) => out.push(ev.text))
      assert.equal(out.length, 1)
      assert.ok(out[0]?.includes('[后台任务 · task-7] 完成检查'))
      assert.equal(out[0]?.includes('\uFFFD'), false)

      const burstLog = join(tasksDir, 'task-8.log')
      const manyLines = Array.from({ length: 28 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
      writeFileSync(burstLog, manyLines)
      const burstOut: string[] = []
      tracker.poll(brainDir, (ev) => burstOut.push(ev.text))
      assert.ok(burstOut.some((t) => t.includes('跳过 8 行中间输出')))
      assert.ok(burstOut.some((t) => t.includes('line-28')))
      assert.equal(burstOut.some((t) => t.includes('line-1\n')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('adapter does not inject false interruption warning when previous run already had a consumable result', async () => {
    const work = mkdtempSync(join(tmpdir(), 'agy-preempt-consumable-'))
const fakeBin = FAKE_AGY
    const argsFile = join(work, 'args.json')
    const prevArgsFile = process.env.FAKE_AGY_ARGS_FILE
    const prevMode = process.env.FAKE_AGY_MODE
    try {
      process.env.FAKE_AGY_ARGS_FILE = argsFile
      process.env.FAKE_AGY_MODE = 'ok'
      const cfg = { ...defaultConfig(), permissionMode: 'plan' as const, timeoutMs: 20_000 }
      const store = new SessionStore(join(work, 'sessions.json'))
      store.set('sess-post-res', {
        conversationId: 'conv-post-res',
        lastMessageCount: 2,
        updatedAt: Date.now(),
        model: 'gemini-3.8-flash',
      })
      const runs = new RunRegistry()
      const slowLiveRun = new RunRecording()
      slowLiveRun.append({
        kind: 'result',
        ok: true,
        response: 'Initial turn answer.',
        conversationId: 'conv-post-res',
        usage: {},
        raw: null,
      })
      let abortedCalled = false
      slowLiveRun.requestAbort = () => {
        abortedCalled = true
        slowLiveRun.settle(null)
      }
      // Keep liveRun unsettled past the 1.5s wait so the preemption branch executes.
      setTimeout(() => {
        if (!slowLiveRun.isSettled) slowLiveRun.settle(null)
      }, 2_100).unref?.()

      const adapter = new AgyAdapter({
        getConfig: () => cfg,
        catalog: new ModelCatalog(async () => { throw new Error('offline') }, cfg.fallbackModels, 300_000),
        store,
        bin: () => fakeBin,
        acquire: () => Promise.resolve(() => {}),
        runs,
      })
      ;(adapter as unknown as { activeRuns: Map<string, RunRecording> }).activeRuns.set('sess-post-res', slowLiveRun)

      const msgs = [
        { role: 'user', content: [{ type: 'text', text: 'First prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Initial turn answer.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Background timer wakeup task' }] },
      ] as unknown as Message[]
      const chunks: StreamChunk[] = []
      for await (const c of adapter.stream({
        provider: 'antigravity',
        model: 'gemini-3.8-flash',
        messages: msgs,
        sessionId: 'sess-post-res' as never,
      } as GenerateOptions)) {
        chunks.push(c)
      }
      assert.equal(abortedCalled, true)
      const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
      const prompt = argv[argv.indexOf('-p') + 1] ?? ''
      assert.ok(prompt.includes('Background timer wakeup task'))
      assert.equal(prompt.includes('the previous turn was interrupted before it finished'), false)
      assert.equal(store.get('sess-post-res')?.interrupted, undefined)
    } finally {
      if (prevArgsFile === undefined) delete process.env.FAKE_AGY_ARGS_FILE
      else process.env.FAKE_AGY_ARGS_FILE = prevArgsFile
      if (prevMode === undefined) delete process.env.FAKE_AGY_MODE
      else process.env.FAKE_AGY_MODE = prevMode
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('runAcpAttempt enables TaskActivityTracker during non-aux ACP turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-acp-tasklog-'))
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    try {
      process.env.HOME = root
      process.env.USERPROFILE = root
      const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
      const sid = 'acp-conv-track-1'
      const tasksDir = join(root, '.gemini', 'antigravity-cli', 'brain', sid, '.system_generated', 'tasks')
      mkdirSync(convDir, { recursive: true })
      mkdirSync(tasksDir, { recursive: true })
      setAgyDbDir(convDir)

      const cfg = { ...defaultConfig(), permissionMode: 'plan' as const, transport: 'acp' as const }
      const fakeProc = {
        stderr: '',
        stderrOffset: () => 0,
        readStderrSince: () => '',
        logFilePath: null,
        isAlive: () => true,
        lastUsedAt: Date.now(),
        activeSessionCount: 0,
        once: () => fakeProc,
        openSession: async () => ({ sessionId: sid, status: 'created', resumeFailed: false }),
        cancelSession: () => {},
        prompt: async (opts: { onUpdate?: (u: Record<string, unknown>) => void }) => {
          writeFileSync(join(tasksDir, 'task-55.log'), 'acp background line\n')
          // A live turn always says something; an empty turn is now classified as
          // a dead transport and retried over CLI instead of settling here.
          opts.onUpdate?.({
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-acp-1',
            name: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'ping -n 20 127.0.0.1' },
          })
          opts.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started the task' } })
          await new Promise((r) => setTimeout(r, 80))
          return { stopReason: 'end_turn' }
        },
        close: () => {},
      }
      const pool = new AcpSessionPool({
        bin: () => 'agy',
        cfg: () => cfg,
        createProcess: () => fakeProc as never,
      })

      const runs = new RunRegistry()
      const deps: AttemptDeps = {
        acquire: () => Promise.resolve(() => {}),
        runs,
        store: new SessionStore(join(root, 'sessions.json')),
        clearInFlightPrompt: () => {},
        registerActiveRun: () => {},
        unregisterActiveRun: () => {},
        isSuperseded: () => false,
        noteNetworkFailure: () => 0,
        clearNetworkStreak: () => {},
        dropFailoverBudget: () => {},
        clearRateLimitFailover: () => {},
        sharesSingleEgress: () => false,
        lastAccountSpawnTime: new Map(),
        minSpawnIntervalMs: 0,
      }
      const input: AttemptInput = {
        cfg,
        bin: 'agy',
        permissionMode: 'plan',
        sessionKey: 'sess-acp-1',
        workspaceRoot: root,
        isAux: false,
        account: undefined,
        prompt: 'run acp task',
        model: 'gemini-3.8-flash',
        activeModel: 'gemini-3.8-flash',
        effort: undefined,
        addDirs: [],
        persistBinding: true,
        binding: undefined,
        messages: [],
        newlySentImageIds: [],
        sessionAccountKey: 'sess-acp-1',
        family: 'google',
        signal: undefined,
        agyOnEvent: undefined,
      }
      const slot = createAttemptSlot(() => {}, undefined, undefined)
      const rec = await runAcpAttempt(pool, deps, input, slot)
      assert.ok(rec !== null)
      while (!rec.isSettled) {
        await new Promise((r) => setTimeout(r, 20))
      }
      const recorded: AgyEvent[] = []
      for (let i = 0; i < rec.length; i++) {
        const ev = rec.eventAt(i)
        if (ev) recorded.push(ev)
      }
      assert.ok(recorded.some((e) => e.kind === 'step' && e.stepKind === 'subagent' && e.text.includes('[后台任务 · task-55] acp background line')))
      pool.dispose()
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevUserProfile
      rmSync(root, { recursive: true, force: true })
    }
  })
})

