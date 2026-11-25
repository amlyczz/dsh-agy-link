// A turn that ends on an in-progress announcement is not a finished turn.
//
// Live 2026-11-23 00:46 (`session-e778203d`): agy answered "正在运行 Windows
// Vulkan RTX 2080 Ti 实机多场景截帧…，完成后立即审图与精修。" and finished with
// `stop`. Nothing was running, `backgroundWakeup` is off by default, so no wake
// path existed and the session sat idle until the user asked "好了吗" 16 hours
// later. These tests pin the shape detector and the single bounded repair.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildAnnouncementNudgeText,
  finalAssistantText,
  hasToolActivity,
  isInProgressAnnouncement,
} from '../../src/common/announcement.ts'
import { defaultConfig } from '../../src/common/types.ts'
import { BackgroundWakeWatcher } from '../../src/features/background/watcher.ts'
import { RunRecording } from '../../src/host/recording.ts'

const ANNOUNCEMENT =
  '正在运行 Windows Vulkan RTX 2080 Ti 实机多场景截帧以进行逐帧视觉验收，完成后立即审图与精修。'

function toolStep(rec: RunRecording, name = 'run_command'): void {
  rec.append({
    kind: 'step',
    stepKey: '1',
    stepKind: 'tool',
    state: 'DONE',
    text: '',
    tool: { name, args: { CommandLine: 'godot --headless' }, output: 'ok' },
  })
}

function textStep(rec: RunRecording, text: string, stepKey = '2'): void {
  rec.append({ kind: 'step', stepKey, stepKind: 'text', state: 'DONE', text })
}

function announcementRecording(): RunRecording {
  const rec = new RunRecording()
  toolStep(rec)
  textStep(rec, ANNOUNCEMENT)
  rec.settle(null)
  return rec
}

function watcherFor(delivered: string[]) {
  return new BackgroundWakeWatcher({
    // Opt-in wakeups stay OFF on purpose: the repair must not depend on them.
    getConfig: () => ({ ...defaultConfig(), enabled: true, backgroundWakeup: false }),
    coalesceMs: 5,
    announcementNudgeDelayMs: 5,
    resolveAgent: async () => ({
      status: 'idle',
      whenIdle: async () => undefined,
      inbox: { nextTurn: [] },
      followup: (msg: { content: Array<{ type: string; text?: string }> }) => {
        const text = msg.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('')
        delivered.push(text)
      },
    }),
    log: () => undefined,
  })
}

describe('in-progress announcement detector', () => {
  test('the exact sentence that ended the reported turn is recognised', () => {
    assert.equal(isInProgressAnnouncement(ANNOUNCEMENT), true)
    assert.equal(isInProgressAnnouncement('正在运行 `pytest`，完成后立即汇报。'), true)
    assert.equal(isInProgressAnnouncement('稍后更新这一份数值。'), true)
    assert.equal(isInProgressAnnouncement('The capture is running; I will report once it finishes.'), true)
  })

  test('a real report, a long answer and an empty tail are never announcements', () => {
    assert.equal(isInProgressAnnouncement('已经全部修好并通过验证：145/145 全绿。'), false)
    assert.equal(isInProgressAnnouncement('### 结论\n\n- 测试通过\n- 已提交'), false)
    assert.equal(isInProgressAnnouncement(''), false)
    assert.equal(isInProgressAnnouncement(ANNOUNCEMENT.repeat(8)), false, 'a long answer is a report, never a status line')
  })

  test('the nudge quotes the announcement and demands the real result', () => {
    const text = buildAnnouncementNudgeText(ANNOUNCEMENT)
    assert.match(text, /Continue · dsh-agy-link/)
    assert.match(text, /正在运行 Windows Vulkan/)
    assert.match(text, /Do the work NOW/)
  })
})

describe('recording inspection', () => {
  test('trailing text fragments are joined, and text before a tool step is not the answer', () => {
    const rec = new RunRecording()
    textStep(rec, '正在运行 Vulkan ', '2')
    textStep(rec, '多场景截帧，完成后立即审图。', '3')
    assert.equal(finalAssistantText(rec), '正在运行 Vulkan 多场景截帧，完成后立即审图。')

    const withToolAfter = new RunRecording()
    textStep(withToolAfter, '正在运行 Vulkan 截帧。')
    toolStep(withToolAfter, 'read_file')
    assert.equal(finalAssistantText(withToolAfter), '', 'a tool step after the text means the turn continued')
  })

  test('a turn only earns a nudge after it actually executed a tool', () => {
    const chatOnly = new RunRecording()
    textStep(chatOnly, ANNOUNCEMENT)
    assert.equal(hasToolActivity(chatOnly), false)

    const worked = new RunRecording()
    toolStep(worked)
    textStep(worked, ANNOUNCEMENT)
    assert.equal(hasToolActivity(worked), true)
  })
})

describe('announcement nudge', () => {
  test('a stalled turn is continued once, even with background wakeups disabled', async () => {
    const delivered: string[] = []
    const watcher = watcherFor(delivered)
    try {
      watcher.onAttemptSettled({
        sessionKey: 'sess-ann',
        conversationId: 'conv',
        transport: 'cli',
        recording: announcementRecording(),
        failure: null,
        superseded: false,
      })
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(delivered.length, 1, 'exactly one follow-up turn is spent')
      assert.match(delivered[0] ?? '', /running NOW|do the work/i)
      assert.equal(watcher.status().announcementNudges, 1)

      // Same turn settling again (e.g. a late ACP report) must not nudge twice.
      watcher.onAttemptSettled({
        sessionKey: 'sess-ann',
        conversationId: 'conv',
        transport: 'cli',
        recording: announcementRecording(),
        failure: null,
        superseded: false,
      })
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(delivered.length, 1, 'one nudge per turn generation')
    } finally {
      watcher.dispose()
    }
  })

  test('a turn with a live background task belongs to the wake path, not the nudge', async () => {
    const delivered: string[] = []
    const watcher = watcherFor(delivered)
    try {
      const rec = new RunRecording()
      rec.append({
        kind: 'step',
        stepKey: '1',
        stepKind: 'tool',
        state: 'RUNNING',
        text: '',
        tool: { name: 'schedule', args: { DurationSeconds: 60, Prompt: 'check the build' } },
      })
      textStep(rec, ANNOUNCEMENT)
      rec.settle(null)
      watcher.onAttemptSettled({
        sessionKey: 'sess-timer',
        conversationId: 'conv',
        transport: 'cli',
        recording: rec,
        failure: null,
        superseded: false,
      })
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(delivered.length, 0, 'the scheduled timer owns this turn')
      assert.equal(watcher.status().announcementNudges, 0)
    } finally {
      watcher.dispose()
    }
  })

  test('a failed or superseded turn is never nudged, and the cap holds', async () => {
    const delivered: string[] = []
    const watcher = watcherFor(delivered)
    try {
      watcher.onAttemptSettled({
        sessionKey: 'sess-fail',
        conversationId: 'conv',
        transport: 'cli',
        recording: announcementRecording(),
        failure: { code: 'PROCESS_EXIT', message: 'boom' },
        superseded: false,
      })
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(delivered.length, 0, 'a failed attempt is not a promise to repair')

      for (let i = 0; i < 5; i += 1) {
        watcher.onHumanTurn('sess-cap')
        watcher.onAttemptSettled({
          sessionKey: 'sess-cap',
          conversationId: 'conv',
          transport: 'cli',
          recording: announcementRecording(),
          failure: null,
          superseded: false,
        })
        await new Promise((r) => setTimeout(r, 30))
      }
      assert.equal(delivered.length, 3, 'the per-session cap is three')
    } finally {
      watcher.dispose()
    }
  })
})