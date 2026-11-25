import test from 'node:test'
import assert from 'node:assert/strict'

import { attachSubagentTracker, detachSubagentTracker, snapshotSubagents, type SubagentTrackable } from '../../../src/features/subagent/live.ts'
import { SubagentTracker } from '../../../src/features/subagent/tracker.ts'

function fake(running: number, total: number): SubagentTrackable {
  return {
    snapshot: () => ({
      total,
      running,
      items: Array.from({ length: total }, (_, i) => ({
        conversationId: `c${i}`,
        role: `R${i}`,
        typeName: 'builder',
        running: i < running,
        lastAction: i < running ? '正在执行终端命令: build' : '已停止 (DONE)',
        startedAt: 1,
        lastAt: 2,
      })),
    }),
  }
}

test('live registry scopes subagents per session and aggregates them', () => {
  const a = fake(2, 3)
  const b = fake(1, 1)
  attachSubagentTracker('sess-1', a)
  attachSubagentTracker('sess-2', b)

  const snap = snapshotSubagents()
  const s1 = snap.find((s) => s.session === 'sess-1')
  const s2 = snap.find((s) => s.session === 'sess-2')
  assert.equal(s1?.total, 3)
  assert.equal(s1?.running, 2)
  assert.equal(s2?.total, 1)
  assert.equal(s2?.running, 1)

  detachSubagentTracker('sess-1', a)
  const after = snapshotSubagents()
  assert.equal(after.find((s) => s.session === 'sess-1'), undefined, 'an emptied session disappears')
  assert.ok(after.find((s) => s.session === 'sess-2'))
})

test('an empty session key or a tracker with no items is never reported', () => {
  const idle = fake(0, 0)
  attachSubagentTracker('', idle)
  attachSubagentTracker('sess-idle', idle)
  const snap = snapshotSubagents()
  assert.equal(snap.some((s) => s.session === ''), false, 'blank session key is ignored')
  assert.equal(snap.some((s) => s.session === 'sess-idle'), false, 'a tracker with zero items is skipped')
})

test('SubagentTracker.snapshot() is empty before any subagent is discovered', () => {
  const tracker = new SubagentTracker({ onEvent: () => {} })
  const snap = tracker.snapshot()
  assert.deepEqual(snap, { total: 0, running: 0, items: [] })
})
