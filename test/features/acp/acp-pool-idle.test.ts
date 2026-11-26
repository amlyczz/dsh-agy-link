import assert from 'node:assert/strict'
import { once, EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../../../src/common/types.ts'
import { AcpProcess } from '../../../src/features/acp/client.ts'
import { AcpSessionPool } from '../../../src/features/acp/pool.ts'

import { FIXTURES_DIR } from '../../helpers/paths.ts'
const FIXTURE = join(FIXTURES_DIR, 'mock-acp-hardening.mjs')
const TTL = 15 * 60_000

test('a foreground ACP prompt survives idle eviction and starts a fresh idle window when it completes', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1 })
  const cwd = mkdtempSync(join(tmpdir(), 'agy-pool-idle-'))
  const pool = new AcpSessionPool({
    bin: () => FIXTURE,
    cfg: defaultConfig,
    idleTtlMs: TTL,
    strays: null,
    createProcess: (opts) => new AcpProcess({ ...opts, logFile: join(cwd, 'acp.log') }),
  })
  const proc = pool.acquireProcess({
    bin: FIXTURE,
    cwd,
    mode: 'auto',
    sandbox: false,
    agent: '',
    preemptAutoUpdate: false,
    env: { ...process.env, MOCK_ACP_MODE: 'held' },
  })
  const abort = new AbortController()
  const exited = once(proc, 'exit')
  try {
    const opened = await proc.openSession({ cwd, addDirs: [], mode: 'auto' })
    let seen!: () => void
    const firstOutput = new Promise<void>((resolve) => { seen = resolve })
    const prompt = proc.prompt({
      sessionId: opened.sessionId,
      text: 'run a long foreground task',
      timeoutMs: 5_000,
      signal: abort.signal,
      onUpdate: (update) => { if (update.sessionUpdate === 'agent_message_chunk') seen() },
    })
    await Promise.race([firstOutput, prompt.then(() => assert.fail('fixture prompt ended before the sweep'))])
    t.mock.timers.tick(TTL + 56_000)
    assert.equal(pool.evictIdle(), 0, 'the sweep must not close an active session/prompt')

    // Advance the clock again before processing the peer's reply, so the
    // result time is distinguishable from the last outbound write.
    proc.notify('test/release_prompt', {})
    t.mock.timers.tick(5_000)
    assert.equal((await prompt).stopReason, 'end_turn')

    t.mock.timers.tick(TTL - 1)
    assert.equal(pool.evictIdle(), 0, 'idle time starts at the prompt result, not at the last write')
    t.mock.timers.tick(2)
    assert.equal(pool.evictIdle(), 1, 'genuinely idle processes must still be reaped')
  } finally {
    abort.abort()
    pool.dispose()
    await exited
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('issue #204: the orchestrator settings tag is part of the ACP process key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-settings-tag-'))
  const created: unknown[] = []
  const pool = new AcpSessionPool({
    bin: () => 'agy',
    cfg: defaultConfig,
    strays: null,
    createProcess: () => {
      const proc = new EventEmitter()
      Object.assign(proc, {
        isAlive: () => true,
        isBusy: false,
        hasOpenSession: () => false,
        lastUsedAt: 0,
        close: () => undefined,
      })
      created.push(proc)
      return proc as never
    },
  })
  const acquire = (settingsTag?: string) => pool.acquireProcess({
    bin: 'agy',
    cwd: dir,
    mode: 'auto',
    sandbox: false,
    agent: '',
    ...(settingsTag === undefined ? {} : { settingsTag }),
  })
  try {
    const a = acquire('seats-a')
    assert.equal(acquire('seats-a'), a, 'same seats reuse the resident process')
    const b = acquire('seats-b')
    assert.notEqual(b, a, 'changed seats must spawn a fresh process')
    assert.equal(created.length, 2)
    // Non-orchestrator turns keep their historical key (no tag).
    assert.equal(acquire(), acquire())
  } finally {
    pool.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('four bridged sessions keep their own live ACP peer across a pool capacity of one', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'agy-bridge-pool-'))
  const pool = new AcpSessionPool({ bin: () => FIXTURE, cfg: defaultConfig, maxProcesses: 1, strays: null })
  const requests = Array.from({ length: 4 }, (_, i) => ({
    mode: 'auto' as const, sandbox: false, agent: '', cwd, bin: FIXTURE,
    env: { ...process.env, MOCK_ACP_MODE: 'chat', DSH_MCP_ROUTE: 'fixture-owner-' + i },
  }))
  const peers = requests.map(req => pool.acquireProcess(req))
  const exits = peers.map(peer => once(peer, 'exit'))
  try {
    const opened = await Promise.all(peers.map(peer => peer.openSession({ cwd })))
    assert.equal(new Set(peers).size, 4)
    await Promise.all(peers.map(async (peer, i) => {
      assert.equal(pool.acquireProcess(requests[i]!), peer)
      assert.equal((await peer.openSession({ cwd, resumeId: opened[i]!.sessionId })).status, 'cached')
    }))
  } finally {
    pool.dispose()
    await Promise.all(exits)
    await rm(cwd, { recursive: true, force: true })
  }
})
