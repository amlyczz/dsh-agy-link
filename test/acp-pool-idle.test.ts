import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/common/types.ts'
import { AcpProcess } from '../src/features/acp/client.ts'
import { AcpSessionPool } from '../src/features/acp/pool.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'mock-acp-hardening.mjs')
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
