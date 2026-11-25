// Stray `agy acp` reaper: pure selection logic + kill ordering.
//
// Regression context (2026-11-23): the console badge read "1 进程" while two
// `agy acp` servers were alive — one was a pool-orphaned child that had lost
// track of its credential (logging "You are not logged into Antigravity" every
// 60s) and kept six MCP children alive. These tests pin the reconciliation
// rules so a future refactor cannot silently reintroduce the blind spot.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectDescendants,
  isAcpCommandLine,
  reapStrayAcpProcesses,
  selectStrayAcpProcesses,
  type StrayDeps,
} from '../../../src/features/acp/strays.ts'
import type { ProcessRow } from '../../../src/runtime/agy/process-table.ts'

function row(pid: number, parentPid: number, commandLine: string): ProcessRow {
  return { pid, parentPid, startedAtMs: 1, commandLine }
}

test('isAcpCommandLine matches a real acp server but never a -p run or a log path', () => {
  assert.equal(isAcpCommandLine('/Users/zqy/.local/bin/agy acp --disable-telemetry --dangerously-skip-permissions'), true)
  assert.equal(isAcpCommandLine('C:\\Program Files\\agy\\agy.exe acp --disable-telemetry'), true)
  assert.equal(isAcpCommandLine('cmd.exe /d /s /c "C:\\agy\\agy.exe" acp --log-file x'), true)
  // A shorter-lived CLI turn is not an ACP server.
  assert.equal(isAcpCommandLine('/Users/zqy/.local/bin/agy --output-format stream-json --model gemini-3.8-flash -p hi'), false)
  // `agy models --log-file .../acp-123.log` must not look like an acp server.
  assert.equal(isAcpCommandLine('/Users/zqy/.local/bin/agy models --log-file /tmp/acp-123-abc.log'), false)
  assert.equal(isAcpCommandLine('/Users/zqy/.local/bin/agy --version'), false)
  // MCP children of the acp server are not acp servers themselves.
  assert.equal(isAcpCommandLine('python .../bin/blender-mcp'), false)
})

test('selectStrayAcpProcesses only reports untracked DIRECT children of this host', () => {
  const parent = 500
  const rows: ProcessRow[] = [
    row(600, parent, '/usr/local/bin/agy acp --a'), // tracked below
    row(601, parent, '/usr/local/bin/agy acp --b'), // stray
    row(602, parent, '/usr/local/bin/agy -p hi'), // not acp
    row(603, 1, '/usr/local/bin/agy acp --c'), // another host's child
    row(604, 601, 'python mcp'), // grandchild, not a direct child
    row(parent, 1, 'DeepSeek Harness'), // ourselves
  ]
  const strays = selectStrayAcpProcesses(rows, { parentPid: parent, trackedPids: new Set([600]) })
  assert.deepEqual(strays, [601])
})

test('collectDescendants walks the whole tree so MCP children are not reparented', () => {
  const rows: ProcessRow[] = [
    row(10, 1, 'agy acp'),
    row(11, 10, 'python blender-mcp'),
    row(12, 10, 'python colab-mcp'),
    row(13, 11, 'node helper'),
    row(14, 99, 'unrelated'),
  ]
  assert.deepEqual(collectDescendants(rows, 10).sort((a, b) => a - b), [11, 12, 13])
})

test('reapStrayAcpProcesses kills children before the root, and observe-only never kills', () => {
  const rows: ProcessRow[] = [
    row(20, 1, '/bin/agy acp --x'),
    row(21, 20, 'python mcp-a'),
    row(22, 20, 'python mcp-b'),
  ]
  const killedByscan: number[][] = []
  const deps: StrayDeps = { list: () => rows, kill: (pid) => { killedByscan.push([pid]) } }
  const observed = reapStrayAcpProcesses(deps, { parentPid: 1, trackedPids: new Set() }, { kill: false })
  assert.deepEqual(observed.strays, [20])
  assert.deepEqual(observed.killed, [])
  assert.deepEqual(killedByscan, [], 'a badge read must not signal anything')

  const order: number[] = []
  const reap = reapStrayAcpProcesses(
    { list: () => rows, kill: (pid) => { order.push(pid) } },
    { parentPid: 1, trackedPids: new Set() },
    { kill: true },
  )
  assert.deepEqual(reap.strays, [20])
  // Descendants first, root last: killing the root first would reparent them.
  assert.deepEqual(order, [22, 21, 20])
  assert.deepEqual(reap.killed, [22, 21, 20])
})
