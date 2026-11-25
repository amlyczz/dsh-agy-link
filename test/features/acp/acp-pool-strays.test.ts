// Pool-level stray reconciliation: `status()` must describe the machine, and
// eviction must actually reap what the pool lost track of.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'
import type { AcpProcess } from '../../../src/features/acp/client.ts'
import type { StrayDeps } from '../../../src/features/acp/strays.ts'
import type { ProcessRow } from '../../../src/runtime/agy/process-table.ts'
import type { PluginConfig } from '../../../src/common/types.ts'

function fakeProc(pid: number): AcpProcess {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    pid,
    lastUsedAt: Date.now(),
    sessionCount: 0,
    isAlive: () => true,
    hasOpenSession: () => false,
    close: () => undefined,
    closeGracefully: async () => undefined,
    ensureInitialized: async () => ({}),
  }) as unknown as AcpProcess
}

function row(pid: number, parentPid: number): ProcessRow {
  return { pid, parentPid, startedAtMs: 1, commandLine: '/usr/local/bin/agy acp --disable-telemetry' }
}

test('status() counts tracked + draining + stray servers instead of only the pool map', () => {
  const killed: number[] = []
  const strays: StrayDeps = {
    list: () => [row(11_000, process.pid), row(11_001, process.pid), row(12_345, 1)],
    kill: (pid) => killed.push(pid),
  }
  const pool = new AcpSessionPool({
    bin: () => '/usr/local/bin/agy',
    cfg: () => ({ backgroundWakeupTtlMinutes: 30 } as PluginConfig),
    maxProcesses: 2,
    createProcess: () => fakeProc(7_770),
    strays,
  })
  try {
    pool.acquireProcess({ bin: '/usr/local/bin/agy', cwd: '/tmp', mode: 'skip', sandbox: false, agent: '' })
    const status = pool.status()
    assert.equal(status.activeProcesses, 1)
    // Two strays are children of THIS host; 12_345 belongs to pid 1 (not ours).
    assert.equal(status.strayProcesses, 2)
    assert.deepEqual([...status.strayPids].sort((a, b) => a - b), [11_000, 11_001])
    assert.deepEqual(killed, [], 'reading the badge must not kill anything')
  } finally {
    pool.dispose()
  }
})

test('evictIdle reaps strays but never the process the pool still owns', () => {
  const killed: number[] = []
  // A killed process disappears from the table, exactly like the real machine.
  let rows: ProcessRow[] = [row(7_770, process.pid), row(11_000, process.pid)]
  const strays: StrayDeps = {
    list: () => rows,
    kill: (pid) => {
      killed.push(pid)
      rows = rows.filter((r) => r.pid !== pid)
    },
  }
  const pool = new AcpSessionPool({
    bin: () => '/usr/local/bin/agy',
    cfg: () => ({ backgroundWakeupTtlMinutes: 30 } as PluginConfig),
    maxProcesses: 2,
    createProcess: () => fakeProc(7_770),
    strays,
  })
  try {
    pool.acquireProcess({ bin: '/usr/local/bin/agy', cwd: '/tmp', mode: 'skip', sandbox: false, agent: '' })
    const evicted = pool.evictIdle(Date.now())
    assert.equal(evicted, 1, 'one stray reaped')
    assert.deepEqual(killed, [11_000])
    assert.equal(pool.status().strayProcesses, 0)
    assert.equal(pool.status().reapedStrays, 1)
  } finally {
    pool.dispose()
  }
})

test('an idle pool may reap in status(): nothing legitimate can own the child then', () => {
  const killed: number[] = []
  let rows: ProcessRow[] = [row(11_500, process.pid)]
  const pool = new AcpSessionPool({
    bin: () => '/usr/local/bin/agy',
    cfg: () => ({ backgroundWakeupTtlMinutes: 30 } as PluginConfig),
    maxProcesses: 2,
    strays: {
      list: () => rows,
      kill: (pid) => {
        killed.push(pid)
        rows = rows.filter((r) => r.pid !== pid)
      },
    },
  })
  try {
    const status = pool.status()
    assert.deepEqual(killed, [11_500])
    assert.equal(status.strayProcesses, 0)
    assert.equal(status.reapedStrays, 1)
  } finally {
    pool.dispose()
  }
})
