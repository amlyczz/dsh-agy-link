// Branch-level coverage for the cross-turn background wakeup helpers: the
// awkward inputs (unreadable files, malformed JSON, odd argument shapes) are
// exactly the ones that decide whether a session gets woken or left alone.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../../../src/common/types.ts'
import {
  baselineSessionBrain,
  listSubagentStates,
  pollSessionBrainDir,
  summarizeWakeMessage,
} from '../../../src/features/background/brain-poll.ts'
import {
  buildWakeupMessageText,
  extractAttemptBackgroundSignals,
  matchesTimerCondition,
} from '../../../src/features/background/schedule-parse.ts'
import { createWatchState } from '../../../src/features/background/watch-state.ts'
import { BackgroundWakeWatcher } from '../../../src/features/background/watcher.ts'
import { RunRecording } from '../../../src/host/recording.ts'
import { setAgyDbDir } from '../../../src/runtime/agy/db/paths.ts'

const ORIG_DB_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'conversations')

function withBrain(convId: string, fn: (brain: string) => void | Promise<void>): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'agy-branch-'))
  setAgyDbDir(join(root, 'conversations'))
  const brain = join(root, 'brain', convId)
  mkdirSync(join(brain, '.system_generated', 'messages'), { recursive: true })
  mkdirSync(join(brain, '.system_generated', 'tasks'), { recursive: true })
  mkdirSync(join(brain, '.system_generated', 'subagents'), { recursive: true })
  const cleanup = (): void => { rmSync(root, { recursive: true, force: true }); setAgyDbDir(ORIG_DB_DIR) }
  const result = fn(brain)
  if (result instanceof Promise) return result.finally(cleanup)
  cleanup()
  return undefined
}

function emptyState() {
  return {
    seenMessageKeys: new Set<string>(),
    knownTaskLogs: new Map(),
    knownSubagents: new Map<string, string>(),
    seenWakeKeys: new Set<string>(),
  }
}

describe('background wakeup helpers: filesystem edge cases', () => {
  test('summarizeWakeMessage returns null for anything without a title or content', () => {
    assert.equal(summarizeWakeMessage(null, 'x'), null)
    assert.equal(summarizeWakeMessage('a string', 'x'), null)
    assert.equal(summarizeWakeMessage({ id: 'a' }, 'x'), null)
    assert.equal(summarizeWakeMessage({ id: 'a', content: '   ' }, 'x'), null)

    // Title only, content only, and the collapsed "title — content" shape.
    assert.deepEqual(summarizeWakeMessage({ id: 'a', renderDetails: { messageTitle: 'Build' } }, 'x'), { dedupKey: 'a', text: 'Build' })
    assert.deepEqual(summarizeWakeMessage({ id: 'b', content: 'exit 0' }, 'x'), { dedupKey: 'b', text: 'exit 0' })
    assert.deepEqual(
      summarizeWakeMessage({ id: 'c', sender: 'conv/peer', renderDetails: { messageTitle: 'Build' }, content: 'exit 0' }, 'x'),
      { dedupKey: 'c', sender: 'conv/peer', text: 'Build — exit 0' },
    )
    // Content that already repeats the title is not duplicated.
    assert.deepEqual(
      summarizeWakeMessage({ renderDetails: { messageTitle: 'Build finished' }, content: 'build finished cleanly' }, 'fallback.json'),
      { dedupKey: 'fallback.json', text: 'build finished cleanly' },
    )
  })

  test('malformed and unreadable files never throw and never wake', () => withBrain('conv-bad', async (brain) => {
    const st = emptyState()
    const msgDir = join(brain, '.system_generated', 'messages')
    const subDir = join(brain, '.system_generated', 'subagents')
    const taskDir = join(brain, '.system_generated', 'tasks')

    writeFileSync(join(msgDir, 'broken.json'), '{ not json')
    writeFileSync(join(msgDir, 'notes.txt'), 'ignored: not a json message')
    writeFileSync(join(subDir, 'broken.json'), 'also broken')
    writeFileSync(join(subDir, 'empty.json'), JSON.stringify({}))
    writeFileSync(join(taskDir, 'empty.log'), '')
    mkdirSync(join(taskDir, 'directory.log'), { recursive: true })

    // Baseline and poll must both survive all of it.
    const alive = baselineSessionBrain(st, brain)
    // A descriptor with no state is "unknown", which errs on the side of keeping
    // the watch open; the unparsable one is dropped entirely.
    assert.equal(alive, true, 'a state-less descriptor counts as possibly alive')
    assert.equal(st.knownSubagents.has('broken'), false, 'an unparsable subagent descriptor is ignored')
    assert.ok(st.seenMessageKeys.has('broken'), 'the stem is recorded even when parsing fails')

    const notices: unknown[] = []
    const res = pollSessionBrainDir(st, brain, (n) => notices.push(n))
    assert.deepEqual(res, { stoppedByServer: false })
    assert.deepEqual(notices, [])

    // A missing subdirectory is simply empty.
    assert.equal(listSubagentStates(join(brain, 'nope')).size, 0)
  }))

  test('a subagent without a conversation id falls back to its filename and "" counts as alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-branch-sub-'))
    try {
      const dir = join(root, '.system_generated', 'subagents')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'abc.json'), JSON.stringify({ state: 'SUBAGENT_STATE_ALIVE' }))
      const states = listSubagentStates(root)
      assert.equal(states.get('abc'), 'SUBAGENT_STATE_ALIVE')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('undelivered messages are scanned too, and a timed-out task log reports once', () => withBrain('conv-undelivered', async (brain) => {
    const st = emptyState()
    const undelivered = join(brain, '.system_generated', 'messages', 'undelivered')
    mkdirSync(undelivered, { recursive: true })
    writeFileSync(join(undelivered, 'pending.json'), JSON.stringify({ id: 'p1', content: 'queued while idle' }))
    baselineSessionBrain(st, brain)
    const notices: Array<{ label: string; detail: string }> = []
    pollSessionBrainDir(st, brain, (n) => notices.push(n as never))
    assert.equal(notices.length, 0, 'a baselined undelivered message is old news')

    writeFileSync(join(undelivered, 'fresh.json'), JSON.stringify({ id: 'p2', content: 'arrived later' }))
    pollSessionBrainDir(st, brain, (n) => notices.push(n as never))
    assert.equal(notices.length, 1)
    assert.ok(notices[0]?.detail.includes('arrived later'))

    // [command timed out] is a terminal marker just like an exit code.
    const taskDir = join(brain, '.system_generated', 'tasks')
    writeFileSync(join(taskDir, 'task-9.log'), 'working\n[command timed out after 30s]\n')
    const after: Array<{ label: string; logPath?: string }> = []
    pollSessionBrainDir(st, brain, (n) => after.push(n as never))
    assert.equal(after.length, 1)
    assert.ok(after[0]?.label.includes('task-9'))
    assert.ok(after[0]?.logPath?.endsWith('task-9.log'))
  }))

  test('the same subagent transition is reported once and an unknown previous state counts as a transition', () => withBrain('conv-sub2', async (brain) => {
    const st = emptyState()
    const subDir = join(brain, '.system_generated', 'subagents')
    writeFileSync(join(subDir, 'x.json'), JSON.stringify({ conversationId: 'sub-x', state: 'SUBAGENT_STATE_DONE' }))
    const notices: unknown[] = []
    pollSessionBrainDir(st, brain, (n) => notices.push(n))
    assert.equal(notices.length, 1)
    pollSessionBrainDir(st, brain, (n) => notices.push(n))
    assert.equal(notices.length, 1, 'no previous state means one transition, not one per poll')
  }))
})

describe('background wakeup helpers: argument shapes', () => {
  function recWith(args: Record<string, unknown>, state = 'RUNNING', toolName = 'schedule'): RunRecording {
    const rec = new RunRecording()
    rec.append({ kind: 'step', stepKey: 'k1', stepKind: 'tool', state, text: '', tool: { name: toolName, args } })
    return rec
  }

  test('numeric arguments are accepted as numbers or numeric strings', () => {
    const fromString = extractAttemptBackgroundSignals(recWith({ DurationSeconds: '3', Prompt: 'poll' }))
    assert.equal(fromString.schedules.length, 1)
    assert.equal(fromString.schedules[0]?.durationSeconds, 3)

    // A non-numeric duration is not a timer.
    assert.equal(extractAttemptBackgroundSignals(recWith({ DurationSeconds: 'soon' })).schedules.length, 0)
    // A cron expression WITH a duration is still a one-shot timer.
    const both = extractAttemptBackgroundSignals(recWith({ CronExpression: '*/5 * * * *', DurationSeconds: 2 }))
    assert.equal(both.ignoredRecurringCron, false)
    assert.equal(both.schedules.length, 1)
    assert.equal(both.schedules[0]?.cronExpression, '*/5 * * * *')
    // No prompt at all falls back to a usable instruction instead of an empty wake.
    assert.ok(extractAttemptBackgroundSignals(recWith({ DurationSeconds: 1 })).schedules[0]?.prompt.includes('scheduled task'))
  })

  test('a long schedule prompt is clipped', () => {
    const long = 'x'.repeat(900)
    const sig = extractAttemptBackgroundSignals(recWith({ DurationSeconds: 1, Prompt: long }))
    assert.equal(sig.schedules[0]?.prompt.length, 500)
  })

  test('background tools are found by name, by task id argument, and by task id in the output', () => {
    const byName = extractAttemptBackgroundSignals(recWith({ CommandLine: 'npm run build' }, 'RUNNING', 'run_command'))
    assert.equal(byName.backgroundTools.length, 1)
    assert.equal(byName.backgroundTools[0]?.summary, 'npm run build')

    const byArg = extractAttemptBackgroundSignals(recWith({ bgTaskId: 'task-7' }, 'RUNNING', 'some_other_tool'))
    assert.equal(byArg.backgroundTools.length, 1)
    assert.equal(byArg.backgroundTools[0]?.taskId, 'task-7')

    const rec = new RunRecording()
    rec.append({
      kind: 'step',
      stepKey: 'k2',
      stepKind: 'tool',
      state: 'RUNNING',
      text: 'started task-88 in the background',
      tool: { name: 'unknown_tool', args: {} },
    })
    const byOutput = extractAttemptBackgroundSignals(rec)
    assert.equal(byOutput.backgroundTools.length, 1)
    assert.equal(byOutput.backgroundTools[0]?.taskId, 'task-88')

    // An unrelated tool with no task hint is not background work.
    assert.equal(extractAttemptBackgroundSignals(recWith({}, 'RUNNING', 'read_file')).backgroundTools.length, 0)
  })

  test('a schedule that already woke itself inside the turn is not re-armed', () => {
    const rec = new RunRecording()
    rec.append({
      kind: 'step',
      stepKey: 'sched',
      stepKind: 'tool',
      state: 'RUNNING',
      text: '',
      tool: { name: 'schedule', args: { DurationSeconds: 0.01, Prompt: 'poll' } },
    })
    // Later substantial tool work means the timer already fired and the turn
    // continued, so re-arming it would duplicate the wakeup.
    rec.append({ kind: 'step', stepKey: 'later', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: {} } })
    const sig = extractAttemptBackgroundSignals(rec, Date.now() + 60_000)
    assert.equal(sig.schedules.length, 0)
  })

  test('a background notification naming the step also counts as the timer having fired', () => {
    const rec = new RunRecording()
    rec.append({
      kind: 'step',
      stepKey: 'sched-x',
      stepKind: 'tool',
      state: 'RUNNING',
      text: '',
      tool: { name: 'schedule', args: { DurationSeconds: 0.01, Prompt: 'poll' } },
    })
    rec.append({ kind: 'step', stepKey: 'note', stepKind: 'subagent', text: '[后台通知] sched-x fired', raw: {} })
    assert.equal(extractAttemptBackgroundSignals(rec, Date.now() + 60_000).schedules.length, 0)
  })

  test('matchesTimerCondition covers the empty and partial-match shapes', () => {
    assert.equal(matchesTimerCondition('', 'task-1'), false)
    assert.equal(matchesTimerCondition('any', undefined), true)
    assert.equal(matchesTimerCondition('task-1', undefined), false)
    assert.equal(matchesTimerCondition('TASK-1', 'conv/TASK-1'), true)
    assert.equal(matchesTimerCondition('1', 'task-1'), true)
  })

  test('the wakeup text lists every item and its log path', () => {
    const { summary, text } = buildWakeupMessageText([
      { kind: 'task-log', label: 'Task task-1 finished', detail: 'exit 0', logPath: 'C:/logs/task-1.log' },
      { kind: 'acp', label: 'Build (completed)', detail: 'ACP tool completed' },
    ])
    assert.ok(summary.includes('2 background task updates'))
    assert.ok(text.includes('- [task-log] Task task-1 finished: exit 0'))
    assert.ok(text.includes('Log: C:/logs/task-1.log'))
    assert.ok(text.includes('- [acp] Build (completed): ACP tool completed'))

    const single = buildWakeupMessageText([{ kind: 'schedule', label: 'Scheduled timer', detail: 'poll' }])
    assert.equal(single.summary, 'Scheduled timer: poll')
  })
})

describe('background wakeup watcher: lifecycle edges', () => {
  test('adopt replaces an existing state and clears its watches', () => {
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      resolveAgent: async () => null,
    })
    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 's', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 60, Prompt: 'x' } } })
      rec.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'adopt-1', conversationId: 'c', transport: 'cli', recording: rec, failure: null, superseded: false })
      assert.equal(watcher.status().pendingTimers, 1)

      // Same key, different object: the previous timers must be dropped.
      const replacement = createWatchState('adopt-1')
      watcher.adopt(replacement)
      assert.equal(watcher.status().pendingTimers, 0)
      // Adopting the same object again is a no-op rather than a self-clear.
      watcher.adopt(replacement)
      assert.equal(watcher.status().activeWatches, 0)
    } finally {
      watcher.dispose()
    }
  })

  test('a disabled watcher ignores notices, settles, and polls', async () => {
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => defaultConfig(),
      coalesceMs: 20,
      resolveAgent: async () => { throw new Error('must not be called') },
    })
    try {
      watcher.noteNotice('off-1', { kind: 'acp', label: 'x', detail: 'y' })
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 's', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 60, Prompt: 'x' } } })
      rec.settle(null)
      watcher.onAttemptSettled({ sessionKey: 'off-1', conversationId: 'c', transport: 'cli', recording: rec, failure: null, superseded: false })
      watcher.pollNow()
      await new Promise((r) => setTimeout(r, 100))
      assert.deepEqual(watcher.status(), {
        enabled: false,
        activeWatches: 0,
        pendingTimers: 0,
        pendingTasks: 0,
        directPresentations: 0,
        followupWakes: 0,
        pendingAcpTools: 0,
        announcementNudges: 0,
      })
    } finally {
      watcher.dispose()
    }
  })

  test('archiving and superseded/failed turns drop the watch without waking', async () => {
    const followups: string[] = []
    let archived = false
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 20,
      isArchived: () => archived,
      resolveAgent: async () => ({ status: 'idle', inbox: { nextTurn: [] }, followup: (m) => followups.push(String((m.content[0] as { text?: string })?.text)) }),
    })
    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 's', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.02, Prompt: 'archived' } } })
      rec.settle(null)

      archived = true
      watcher.onAttemptSettled({ sessionKey: 'arch-1', conversationId: 'c', transport: 'cli', recording: rec, failure: null, superseded: false })
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(followups.length, 0)
      assert.equal(watcher.status().pendingTimers, 0)

      archived = false
      watcher.onAttemptSettled({ sessionKey: 'arch-1', conversationId: 'c', transport: 'cli', recording: rec, failure: null, superseded: true })
      watcher.onAttemptSettled({ sessionKey: 'arch-1', conversationId: 'c', transport: 'cli', recording: rec, failure: { kind: 'error' }, superseded: false })
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(followups.length, 0)
    } finally {
      watcher.dispose()
    }
  })

  test('a re-armed schedule for the same step replaces its previous timer', async () => {
    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 20,
      resolveAgent: async () => ({ status: 'idle', inbox: { nextTurn: [] }, followup: (m) => followups.push(String((m.content[0] as { text?: string })?.text)) }),
    })
    try {
      const rec = new RunRecording()
      rec.append({ kind: 'step', stepKey: 'same-key', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 0.05, Prompt: 'first' } } })
      rec.settle(null)
      watcher.onAttemptSettled({ sessionKey: 're-1', conversationId: 'c', transport: 'cli', recording: rec, failure: null, superseded: false })
      watcher.onAttemptSettled({ sessionKey: 're-1', conversationId: 'c', transport: 'cli', recording: rec, failure: null, superseded: false })
      assert.equal(watcher.status().pendingTimers, 1, 'the second arm replaces the first, it does not stack')
      await new Promise((r) => setTimeout(r, 900))
      assert.equal(followups.length, 1)
    } finally {
      watcher.dispose()
    }
  })

  test('a running agent without whenIdle is retried later instead of being woken mid-turn', async () => {
    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 20,
      resolveAgent: async () => ({ status: 'running', inbox: { nextTurn: [] }, followup: (m) => followups.push(String((m.content[0] as { text?: string })?.text)) }),
    })
    try {
      watcher.noteNotice('busy-1', { kind: 'acp', label: 'x', detail: 'y' })
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(followups.length, 0, 'a running agent is never interrupted')
    } finally {
      watcher.dispose()
    }
  })

  test('a session that cannot be resolved drops the notice instead of retrying forever', async () => {
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true }),
      coalesceMs: 20,
      resolveAgent: async () => null,
    })
    try {
      watcher.noteNotice('gone-1', { kind: 'acp', label: 'x', detail: 'y' })
      await new Promise((r) => setTimeout(r, 120))
      assert.equal(watcher.status().activeWatches, 0)
    } finally {
      watcher.dispose()
    }
  })

  test('an expired watch is dropped on the next poll', async () => {
    const followups: string[] = []
    const watcher = new BackgroundWakeWatcher({
      getConfig: () => ({ ...defaultConfig(), backgroundWakeup: true, backgroundWakeupTtlMinutes: 1 }),
      coalesceMs: 20,
      resolveAgent: async () => ({ status: 'idle', inbox: { nextTurn: [] }, followup: (m) => followups.push(String((m.content[0] as { text?: string })?.text)) }),
    })
    try {
      await withBrain('conv-expire', async (brain) => {
        const rec = new RunRecording()
        rec.append({ kind: 'step', stepKey: 'bg', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'run_command', args: { CommandLine: 'sleep' } } })
        rec.settle(null)
        watcher.onAttemptSettled({ sessionKey: 'exp-1', conversationId: 'conv-expire', transport: 'cli', recording: rec, failure: null, superseded: false })
        assert.equal(watcher.status().pendingTasks, 1)

        // Pretend the TTL elapsed: the watch must be dropped, not kept forever.
        const st = (watcher as unknown as { sessions: Map<string, { expiresAt: number }> }).sessions.get('exp-1')!
        st.expiresAt = Date.now() - 1
        watcher.pollNow()
        assert.equal(watcher.status().pendingTasks, 0)
        assert.ok(brain.endsWith('conv-expire'))
      })
      assert.equal(followups.length, 0)
    } finally {
      watcher.dispose()
    }
  })
})
