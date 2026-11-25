// Regression tests for issue #128 bug 2 (and the ask in #127):
// when the 5s idle reaper ends a turn that already produced its final answer in
// agy's own transcript, the synthesized `result` must carry that answer instead
// of an empty string — otherwise DSH shows "completed" with no reply bubble.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDLE_GRACE_NO_REPLY_NOTICE, recoverFinalReply } from '../../src/provider/idle-grace-reply.ts'

const CID = 'conv-128-test'

/** Build `<home>/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/transcript.jsonl`. */
function transcript(lines: unknown[]): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'agy-128-'))
  const dir = join(home, '.gemini', 'antigravity-cli', 'brain', CID, '.system_generated', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('issue #128: the final PLANNER_RESPONSE after the last USER_INPUT is recovered', () => {
  const f = transcript([
    { step_index: 0, type: 'USER_INPUT', content: 'older prompt' },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'older answer' },
    { step_index: 2, type: 'USER_INPUT', content: 'run the regression suite' },
    { step_index: 3, type: 'PLANNER_RESPONSE', content: 'started tests in the background' },
    { step_index: 4, type: 'PLANNER_RESPONSE', content: 'All 42 tests passed.\n' },
  ])
  try {
    assert.equal(recoverFinalReply(CID, f.home), 'All 42 tests passed.\n')
  } finally {
    f.cleanup()
  }
})

test('issue #128: a response still carrying tool_calls is not a final answer', () => {
  const f = transcript([
    { step_index: 0, type: 'USER_INPUT', content: 'go' },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'I will run more checks', tool_calls: [{ name: 'run_command' }] },
  ])
  try {
    assert.equal(recoverFinalReply(CID, f.home), '', 'an in-flight step is not the final reply')
  } finally {
    f.cleanup()
  }
})

test('issue #128: a previous turn\'s answer is never reused', () => {
  const f = transcript([
    { step_index: 0, type: 'USER_INPUT', content: 'first' },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'first answer' },
    { step_index: 2, type: 'USER_INPUT', content: 'second' },
  ])
  try {
    assert.equal(recoverFinalReply(CID, f.home), '', 'nothing was answered in the current turn')
  } finally {
    f.cleanup()
  }
})

test('issue #128: a missing transcript or unknown conversation yields an empty reply', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-128-empty-'))
  try {
    assert.equal(recoverFinalReply(CID, home), '')
    assert.equal(recoverFinalReply('does/not/exist', home), '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('issue #127: the no-reply notice explains an unconfirmed turn without claiming success', () => {
  assert.match(IDLE_GRACE_NO_REPLY_NOTICE, /未确认|unconfirmed/)
  assert.match(IDLE_GRACE_NO_REPLY_NOTICE, /后台等待|Background wait/)
})

test('issue #128: malformed or non-object transcript rows are skipped, not fatal', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-128-junk-'))
  try {
    const dir = join(home, '.gemini', 'antigravity-cli', 'brain', CID, '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    // A torn JSON line (writer mid-append), a JSON scalar, JSON null, then the
    // only usable answer: every unusable row must be ignored.
    writeFileSync(join(dir, 'transcript.jsonl'), [
      '{"step_index":0,"type":"USER_INPUT","content":"go"}',
      '{"step_index":1,"type":"PLANNER_RESP',
      '"a bare string"',
      'null',
      '{"step_index":2,"type":"PLANNER_RESPONSE","content":"  recovered  "}',
    ].join('\n'))
    assert.equal(recoverFinalReply(CID, home), '  recovered  ')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('issue #128: an unreadable transcript path degrades to an empty reply', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-128-dir-'))
  try {
    // A DIRECTORY where the log file belongs: existsSync passes, the read throws.
    const dir = join(home, '.gemini', 'antigravity-cli', 'brain', CID, '.system_generated', 'logs', 'transcript.jsonl')
    mkdirSync(dir, { recursive: true })
    assert.equal(recoverFinalReply(CID, home), '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('issue #128: an empty transcript file yields no reply', () => {
  const f = transcript([])
  try {
    assert.equal(recoverFinalReply(CID, f.home), '')
  } finally {
    f.cleanup()
  }
})
