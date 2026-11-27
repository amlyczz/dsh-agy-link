// Issue #229: the stray `agy acp` sweep must never block the DSH host event loop.
//
// On Windows the process-table read is `powershell.exe Get-CimInstance`, ~950 ms
// of synchronous `execFileSync` every 15 s (`status()`) and 60 s (eviction).
// With `listAsync` present the sweep runs off the loop: callers get the previous
// observation at once, concurrent callers share one scan, a child spawned while
// the table was being read is never mistaken for a stray, and a scan that
// completes after `dispose()` only observes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'
import type { AcpProcess } from '../../../src/features/acp/client.ts'
import {
  STRAY_SCAN_OBSERVE_MS,
  StraySweeper,
  reapStrayAcpProcessesAsync,
  type StrayDeps,
} from '../../../src/features/acp/strays.ts'
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

test('#229 reapStrayAcpProcessesAsync re-reads the tracked pids AFTER the table arrives', async () => {
  const killed: number[] = []
  const table = deferred<ProcessRow[]>()
  const deps: StrayDeps = {
    list: () => { throw new Error('the async path must not use the blocking read') },
    listAsync: () => table.promise,
    kill: (pid) => killed.push(pid),
  }
  const tracked = new Set<number>()
  const pending = reapStrayAcpProcessesAsync(deps, () => ({ parentPid: process.pid, trackedPids: tracked }), { kill: true })
  // While "PowerShell" is still scanning, the pool spawns 11_000 and tracks it.
  tracked.add(11_000)
  table.resolve([row(11_000, process.pid), row(11_001, process.pid), row(12_345, 1)])
  const result = await pending
  assert.deepEqual(result.strays, [11_001], 'the mid-scan spawn is tracked by the time the table lands, so it is not a stray')
  assert.deepEqual(killed, [11_001], 'only the real stray is signalled; 12_345 belongs to another parent')
})

test('#229 a scan that lands after dispose() observes but never kills', async () => {
  const killed: number[] = []
  const table = deferred<ProcessRow[]>()
  const deps: StrayDeps = { list: () => [], listAsync: () => table.promise, kill: (pid) => killed.push(pid) }
  const sweeper = new StraySweeper(deps, () => {})
  const tracked = () => new Set<number>()
  // Kick a killing (eviction-style) scan, then dispose before the table lands.
  const scan = sweeper.reap(1_000, tracked)
  assert.equal(scan, 0, 'the async path never reports a reap synchronously')
  sweeper.dispose()
  table.resolve([row(11_000, process.pid)])
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(killed.length, 0, 'no signal after dispose')
  assert.deepEqual(sweeper.lastObserved(), [], 'a disposed sweeper does not publish either')
  assert.equal(sweeper.reapedTotal(), 0)
})

test('#229 StraySweeper.observe returns at once, dedupes concurrent calls into one scan, and publishes when it lands', async () => {
  const killed: number[] = []
  let reads = 0
  const table = deferred<ProcessRow[]>()
  const logs: string[] = []
  const deps: StrayDeps = {
    list: () => [],
    listAsync: () => { reads++; return table.promise },
    kill: (pid) => killed.push(pid),
  }
  const sweeper = new StraySweeper(deps, (m) => logs.push(m))
  // The pool's view of its own pids: 11_000 is acquired while the table is being read.
  const trackedSet = new Set<number>()
  const tracked = (): Set<number> => trackedSet
  const t0 = Date.now()
  const first = sweeper.observe(1_000, tracked, true)
  const second = sweeper.observe(1_001, tracked, true)
  const third = sweeper.observe(1_002, tracked, true)
  assert.ok(Date.now() - t0 < 50, 'no caller waits for the table read')
  assert.deepEqual([first, second, third], [[], [], []], 'the previous observation is served from memory')
  assert.equal(reads, 1, 'concurrent callers share one in-flight scan')
  // The pool has a process by the time the table lands: nothing is stray.
  trackedSet.add(11_000)
  table.resolve([row(11_000, process.pid)])
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(killed.length, 0, 'observe from an empty pool kills; here the row was tracked before the table landed')
  assert.deepEqual(sweeper.lastObserved(), [], 'no stray: the table row became tracked before the scan landed')

  // A real stray in an empty pool is killed, logged, and recounted.
  const table2 = deferred<ProcessRow[]>()
  let reads2 = 0
  const deps2: StrayDeps = {
    list: () => [],
    // First read is the kill scan (waits on table2); the post-kill recount sees an empty table.
    listAsync: () => { reads2++; return reads2 === 1 ? table2.promise : Promise.resolve([]) },
    kill: (pid) => killed.push(pid),
  }
  const sweeper2 = new StraySweeper(deps2, (m) => logs.push(m))
  sweeper2.observe(10_000, tracked, true)
  table2.resolve([row(11_001, process.pid)])
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(killed, [11_001])
  assert.equal(sweeper2.reapedTotal(), 1)
  assert.match(logs.join('\n'), /reaped 1 stray agy acp process\(es\): 11001/)
  assert.deepEqual(sweeper2.lastObserved(), [], 'the post-kill recount (no rows left) is what the badge shows')
})

test('#229 observe() throttles to STRAY_SCAN_OBSERVE_MS instead of starting a scan per status() call', async () => {
  let reads = 0
  const sweeper = new StraySweeper({ list: () => [], listAsync: async () => { reads++; return [] }, kill: () => {} }, () => {})
  const tracked = () => new Set<number>()
  sweeper.observe(1_000, tracked, false)
  await new Promise((r) => setTimeout(r, 10))
  sweeper.observe(1_000 + STRAY_SCAN_OBSERVE_MS - 1, tracked, false)
  assert.equal(reads, 1, 'inside the window the cached observation is reused')
  sweeper.observe(1_000 + STRAY_SCAN_OBSERVE_MS, tracked, false)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(reads, 2, 'outside the window a new scan starts')
})

test('#229 AcpSessionPool.status() does not block on the table read and never kills a child acquired mid-scan', async () => {
  const killed: number[] = []
  const table = deferred<ProcessRow[]>()
  // A killed process disappears from the table, exactly like the real machine.
  let rows: ProcessRow[] = []
  let reads = 0
  let nextPid = 7_770
  const pool = new AcpSessionPool({
    bin: () => '/usr/local/bin/agy',
    cfg: () => ({ backgroundWakeupTtlMinutes: 30 } as PluginConfig),
    maxProcesses: 4,
    createProcess: () => fakeProc(nextPid),
    strays: {
      list: () => { throw new Error('blocking read must not be used when listAsync exists') },
      // First read is the armed scan; the post-kill recount reads the live table.
      listAsync: () => { reads++; return reads === 1 ? table.promise : Promise.resolve(rows) },
      kill: (pid) => { killed.push(pid); rows = rows.filter((r) => r.pid !== pid) },
    },
  })
  try {
    const t0 = Date.now()
    const status = pool.status()
    assert.ok(Date.now() - t0 < 50, 'status() answers without waiting for the scan')
    assert.equal(status.strayProcesses, 0, 'no observation yet: nothing claimed')
    // Mid-scan the pool acquires a process; it is in the table the scan will see.
    nextPid = 11_000
    pool.acquireProcess({ bin: '/usr/local/bin/agy', cwd: '/tmp', mode: 'skip', sandbox: false, agent: '' })
    rows = [row(11_000, process.pid), row(11_001, process.pid)]
    table.resolve(rows)
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(killed, [11_001], 'the pool was empty when the scan was armed, so the real stray is reaped; the mid-scan child is tracked and survives')
    const after = pool.status()
    assert.deepEqual([...after.strayPids], [], 'the post-kill recount is what the badge shows')
    assert.equal(after.reapedStrays, 1)
    assert.equal(after.activeProcesses, 1, 'the process acquired mid-scan is alive and tracked')
  } finally {
    pool.dispose()
  }
})

test('#229 evictIdle() with async deps returns at once and the reap lands in the background', async () => {
  const killed: number[] = []
  let rows: ProcessRow[] = [row(11_000, process.pid)]
  const pool = new AcpSessionPool({
    bin: () => '/usr/local/bin/agy',
    cfg: () => ({ backgroundWakeupTtlMinutes: 30 } as PluginConfig),
    maxProcesses: 2,
    strays: {
      list: () => rows,
      listAsync: async () => rows,
      kill: (pid) => { killed.push(pid); rows = rows.filter((r) => r.pid !== pid) },
    },
  })
  try {
    const t0 = Date.now()
    const evicted = pool.evictIdle(Date.now())
    assert.ok(Date.now() - t0 < 50, 'eviction does not wait for the table read')
    assert.equal(evicted, 0, 'the async reap is not counted synchronously')
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(killed, [11_000])
    assert.equal(pool.status().reapedStrays, 1)
    assert.equal(pool.status().strayProcesses, 0)
  } finally {
    pool.dispose()
  }
})
