import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BackgroundWaitMonitor,
  persistInterimAcpBinding,
} from '../../../src/features/acp/bg-wait-notice.ts'
import { TaskActivityTracker } from '../../../src/features/subagent/task-activity.ts'
import { SubagentTracker } from '../../../src/features/subagent/tracker.ts'

test('acp early binding: persists conversationId on first output while preserving prior watermark and skipping aux/superseded', () => {
  const storeMap = new Map<string, any>()
  storeMap.set('sess-1:acc-a', {
    conversationId: 'old-conv-id',
    lastMessageCount: 42,
    updatedAt: 1000,
    model: 'gemini-4-neon',
    sentImageIds: ['img-1', 'img-2'],
    lastInputTokens: 120000,
    cwd: 'D:\\proj\\rabbit',
  })

  let superseded = false
  const deps = {
    store: {
      get: (k: string) => storeMap.get(k),
      set: (k: string, v: any) => { storeMap.set(k, v) },
    },
    isSuperseded: () => superseded,
  } as any
  const recorder = { rec: { id: 'rec-1' } } as any

  // 1. Persists new sid immediately while keeping lastMessageCount, sentImageIds, lastInputTokens, cwd
  const wrote = persistInterimAcpBinding({
    deps,
    input: {
      isAux: false,
      persistBinding: true,
      sessionKey: 'sess-1',
      sessionAccountKey: 'sess-1:acc-a',
      activeModel: 'gemini-4-neon',
      workspaceRoot: 'D:\\proj\\rabbit',
      binding: storeMap.get('sess-1:acc-a'),
    } as any,
    recorder,
    sid: 'new-acp-sid-999',
  })
  assert.equal(wrote, true)
  const saved = storeMap.get('sess-1:acc-a')
  assert.equal(saved.conversationId, 'new-acp-sid-999')
  assert.equal(saved.lastMessageCount, 42, 'watermark stays untouched until final settlement')
  assert.deepEqual(saved.sentImageIds, ['img-1', 'img-2'])
  assert.equal(saved.lastInputTokens, 120000)
  assert.equal(saved.cwd, 'D:\\proj\\rabbit')

  // 2. Idempotent when already bound to the same sid
  const wroteAgain = persistInterimAcpBinding({
    deps,
    input: {
      isAux: false,
      persistBinding: true,
      sessionKey: 'sess-1',
      sessionAccountKey: 'sess-1:acc-a',
      activeModel: 'gemini-4-neon',
      workspaceRoot: 'D:\\proj\\rabbit',
    } as any,
    recorder,
    sid: 'new-acp-sid-999',
  })
  assert.equal(wroteAgain, false)

  // 3. Skips aux turns, non-persistent turns, and superseded attempts
  assert.equal(
    persistInterimAcpBinding({
      deps,
      input: { isAux: true, persistBinding: true, sessionKey: 's', sessionAccountKey: 's:a', activeModel: 'm', workspaceRoot: '/' } as any,
      recorder,
      sid: 'aux-sid',
    }),
    false,
  )
  assert.equal(
    persistInterimAcpBinding({
      deps,
      input: { isAux: false, persistBinding: false, sessionKey: 's', sessionAccountKey: 's:a', activeModel: 'm', workspaceRoot: '/' } as any,
      recorder,
      sid: 'no-persist-sid',
    }),
    false,
  )
  superseded = true
  assert.equal(
    persistInterimAcpBinding({
      deps,
      input: { isAux: false, persistBinding: true, sessionKey: 's', sessionAccountKey: 's:a', activeModel: 'm', workspaceRoot: '/' } as any,
      recorder,
      sid: 'superseded-sid',
    }),
    false,
  )
})

test('subagent tracker + task-activity: surfaces new task-*.log as running in snapshot, ignores baselined history, marks done on message & stop', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-task-vis-'))
  const brainDir = join(root, '.gemini', 'antigravity-cli', 'brain', 'conv-123')
  const tasksDir = join(brainDir, '.system_generated', 'tasks')
  const msgsDir = join(brainDir, '.system_generated', 'messages')
  mkdirSync(tasksDir, { recursive: true })
  mkdirSync(msgsDir, { recursive: true })

  try {
    // Historical task log before this turn starts
    writeFileSync(join(tasksDir, 'task-100.log'), 'old completed run\n')

    const tracker = new SubagentTracker({
      onEvent: () => {},
      accountHome: root,
      resumed: true,
      pollIntervalMs: 60_000,
    })
    tracker.setConversationId('conv-123')
    tracker.start()
    try {
      // Historical baselined log must NOT show up as active
      assert.equal(tracker.activeBackgroundTasks().length, 0)
      assert.equal(tracker.snapshot().items.length, 0)

      // New background task started during this turn
      writeFileSync(join(tasksDir, 'task-204.log'), 'Building release APK...\n')
      tracker.poll()

      const active = tracker.activeBackgroundTasks()
      assert.equal(active.length, 1)
      assert.equal(active[0]?.taskId, 'task-204')
      assert.match(active[0]?.lastLine ?? '', /Building release APK/)

      const snap = tracker.snapshot()
      assert.equal(snap.running, 1)
      assert.equal(snap.items.length, 1)
      assert.equal(snap.items[0]?.conversationId, 'task:task-204')
      assert.equal(snap.items[0]?.typeName, 'Background Task')
      assert.equal(snap.items[0]?.running, true)
      assert.equal(snap.items[0]?.state, 'RUNNING')

      // Completion message marks task-204 as completed
      writeFileSync(
        join(msgsDir, 'msg-1.json'),
        JSON.stringify({ id: 'm1', sender: 'system', content: 'Background task task-204 completed with exit code 0' }),
      )
      tracker.poll()
      assert.equal(tracker.activeBackgroundTasks().length, 0)
      assert.equal(tracker.snapshot().items[0]?.running, false)
      assert.equal(tracker.snapshot().items[0]?.state, 'COMPLETED')

      // Another active task gets marked completed when tracker.stop() runs
      writeFileSync(join(tasksDir, 'task-205.log'), 'Running integration suite...\n')
      tracker.poll()
      assert.equal(tracker.activeBackgroundTasks().length, 1)
      tracker.stop()
      assert.equal(tracker.activeBackgroundTasks().length, 0)
    } finally {
      tracker.stop()
    }

    // Sanity check: appending new bytes to a baselined task resurrects it as active
    const ta = new TaskActivityTracker()
    ta.baseline(brainDir)
    assert.equal(ta.activeTasks(Date.now(), 60_000).length, 0)
    appendFileSync(join(tasksDir, 'task-100.log'), 'resumed output line\n')
    ta.poll(brainDir, () => {})
    assert.equal(ta.activeTasks(Date.now(), 60_000).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BackgroundWaitMonitor: emits notice once after quiet window only when main text streamed and background tasks are active', () => {
  let clock = 10_000
  let activeTasks: Array<{ taskId: string; lastLine: string; startedAt: number; lastAt: number }> = []
  const notices: Array<{ stepKey: string; text: string; raw: unknown }> = []

  const monitor = new BackgroundWaitMonitor({
    getActiveTasks: () => activeTasks,
    emitNotice: (stepKey, text, raw) => { notices.push({ stepKey, text, raw }) },
    quietMs: 12_000,
    now: () => clock,
  })

  // Before any main text -> silent even with active tasks
  activeTasks = [{ taskId: 'task-204', lastLine: 'compiling', startedAt: 9_000, lastAt: 10_000 }]
  assert.equal(monitor.check(), false)
  assert.equal(notices.length, 0)

  // Main text arrives at t=10_000
  monitor.noteEvent({ kind: 'step', stepKey: 't1', stepKind: 'text', text: 'I started the build.', raw: {} } as any)

  // Still inside quiet window at t=21_000 -> silent
  clock = 21_000
  assert.equal(monitor.check(), false)
  assert.equal(notices.length, 0)

  // Subagent/task-log events must NOT reset the quiet timer
  monitor.noteEvent({ kind: 'step', stepKey: 's1', stepKind: 'subagent', text: '[后台任务 · task-204] 50%', raw: {} } as any)

  // Past quiet window at t=22_500 -> emits exactly ONCE
  clock = 22_500
  assert.equal(monitor.check(), true)
  assert.equal(notices.length, 1)
  assert.match(notices[0]!.text, /task-204/)
  assert.match(notices[0]!.text, /后台等待/)
  assert.match(notices[0]!.text, /Background wait/)

  // Subsequent checks do not duplicate the notice
  clock = 40_000
  assert.equal(monitor.check(), false)
  assert.equal(notices.length, 1)
})
