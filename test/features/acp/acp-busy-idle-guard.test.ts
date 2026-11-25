// Regression: the 15-minute idle sweep used to kill a LIVE turn.
//
// A mirrored-tool turn sends ONE `session/prompt` and then streams updates for
// however long the agent works. `lastUsedAt` only moved on outbound RPCs, so
// after 15 quiet minutes `evictIdle` closed the process tree
// (`agy acp exited (code=1, signal=null)`), and every retry then replayed the
// dead recording. Two guards are pinned here: the process reports `isBusy`
// while a prompt is outstanding, and the pool refuses to evict a busy child.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../../../src/common/types.ts'
import { AcpProcess, AcpSessionPool } from '../../../src/features/acp/index.ts'

/** ACP stub: answers the handshake, streams while a prompt runs, then settles. */
function createSlowAcpBin(dir: string, answerAfterMs: number): string {
  const scriptPath = join(dir, 'mock-acp-slow.mjs')
  writeFileSync(
    scriptPath,
    `import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }); return }
  if (msg.method === 'session/new') { send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'busy-sess' } }); return }
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option' || msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }); return
  }
  if (msg.method === 'session/cancel') { return }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'tick ' + ticks } } } })
    }, 40)
    setTimeout(() => {
      clearInterval(timer)
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } })
    }, ${answerAfterMs})
  }
})
`,
    'utf8',
  )
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o755)
  return scriptPath
}

async function closeProc(proc: AcpProcess): Promise<void> {
  if (!proc.isAlive()) {
    proc.close()
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000)
    timer.unref?.()
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.close()
  })
}

test('AcpProcess.isBusy tracks an outstanding session/prompt and refresh lastUsedAt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-busy-guard-'))
  const bin = createSlowAcpBin(dir, 400)
  const proc = new AcpProcess({ bin, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
  try {
    const opened = await proc.openSession({ cwd: dir })
    assert.equal(proc.isBusy, false, 'a freshly opened session is not a running turn')

    const before = proc.lastUsedAt
    // No idle timer: the point is what the POOL sees while the turn runs.
    const running = proc.prompt({
      sessionId: opened.sessionId,
      text: 'long turn',
      timeoutMs: 0,
      idleTimeoutMs: 0,
      onUpdate: () => {},
    })
    assert.equal(proc.isBusy, true, 'a pending session/prompt means the child is mid-turn')

    // Streaming updates alone must move lastUsedAt, or a long silence inside
    // one turn still looks idle to the sweep.
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(proc.lastUsedAt > before, 'inbound session/update frames are activity')

    await running
    assert.equal(proc.isBusy, false, 'a settled prompt releases the busy flag')
  } finally {
    await closeProc(proc)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('evictIdle never closes a busy process, and refreshes its lastUsedAt', (t) => {
  const created: Array<{ alive: boolean; closed: boolean; lastUsedAt: number; busy: boolean }> = []
  const pool = new AcpSessionPool({
    bin: () => '/usr/bin/agy',
    cfg: () => defaultConfig(),
    maxProcesses: 4,
    idleTtlMs: 1_000,
    createProcess: () => {
      const stub = {
        alive: true,
        closed: false,
        lastUsedAt: 0,
        busy: false,
        isAlive() {
          return this.alive
        },
        get isBusy() {
          return this.busy
        },
        close() {
          this.closed = true
          this.alive = false
        },
        once() {},
        hasOpenSession: () => false,
        sessionCount: 0,
      }
      created.push(stub)
      return stub as unknown as AcpProcess
    },
  })
  t.after(() => pool.dispose())

  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a1', mode: 'auto', sandbox: false, agent: '' })
  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a2', mode: 'auto', sandbox: false, agent: '' })
  assert.equal(created.length, 2)

  const now = Date.now() + 60 * 60_000
  created[0]!.busy = true // mid-turn for an hour
  created[1]!.busy = false // genuinely idle
  assert.equal(pool.evictIdle(now), 1, 'only the idle process may be closed')
  assert.equal(created[0]!.closed, false, 'a live session/prompt must survive the sweep')
  assert.equal(created[0]!.lastUsedAt, now, 'the sweep re-stamps a busy process')
  assert.equal(created[1]!.closed, true)
})

test('capacity eviction leaves busy processes alone instead of killing a turn', (t) => {
  const created: Array<{ alive: boolean; closed: boolean; lastUsedAt: number; busy: boolean }> = []
  const pool = new AcpSessionPool({
    bin: () => '/usr/bin/agy',
    cfg: () => defaultConfig(),
    maxProcesses: 1,
    idleTtlMs: 60 * 60_000,
    createProcess: () => {
      const stub = {
        alive: true,
        closed: false,
        lastUsedAt: 0,
        busy: false,
        isAlive() {
          return this.alive
        },
        get isBusy() {
          return this.busy
        },
        close() {
          this.closed = true
          this.alive = false
        },
        once() {},
        hasOpenSession: () => false,
        sessionCount: 0,
      }
      created.push(stub)
      return stub as unknown as AcpProcess
    },
  })
  t.after(() => pool.dispose())

  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a1', mode: 'auto', sandbox: false, agent: '' })
  created[0]!.busy = true
  // At capacity with the only process busy: oversubscribe rather than kill it.
  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a2', mode: 'auto', sandbox: false, agent: '' })
  assert.equal(created[0]!.closed, false)
  assert.equal(created.length, 2)
})