import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err, type AgyEvent } from '../src/common/types.ts'
import {
  AcpProcess,
  AcpSessionPool,
  acpPromptResultToAgyEvent,
  acpUpdateToAgyEvents,
  acpUsageToRawUsage,
  createAcpStreamState,
  extractAcpToolOutput,
  pickPermissionOption,
  runAcpAttempt,
} from '../src/features/acp/index.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { SessionStore } from '../src/host/sessions.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../src/provider/attempt.ts'

function createMockAcpBin(dir: string, behavior: 'normal' | 'fail-resume-load' | 'hang-prompt' | 'crash-on-prompt' = 'normal'): string {
  const scriptPath = join(dir, `mock-acp-${behavior}.mjs`)
  const script = `
import { createInterface } from 'node:readline';

const mode = ${JSON.stringify(behavior)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closed = false;
function send(obj) {
  if (!closed) process.stdout.write(JSON.stringify(obj) + '\\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  if (msg.method === 'initialize') {
    process.stdout.write('not-json-banner\\n');
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === 'session/resume') {
    if (mode === 'fail-resume-load') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'resume unsupported' } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } });
    }
    return;
  }
  if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } });
    return;
  }
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
    return;
  }
  if (msg.method === 'session/cancel') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[cancelled]' } } } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    if (mode === 'crash-on-prompt') {
      process.stderr.write('fatal acp stderr');
      process.exit(2);
    }
    if (mode === 'hang-prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-hang', name: 'run_command', status: 'running', rawInput: { CommandLine: 'sleep' } } } });
      return;
    }
    // Ask permission + unsupported server method before returning text.
    send({
      jsonrpc: '2.0',
      id: 'srv-perm-1',
      method: 'session/request_permission',
      params: { options: [{ optionId: 'opt-allow', kind: 'allow_once' }, { optionId: 'opt-deny', kind: 'reject_once' }] },
    });
    send({
      jsonrpc: '2.0',
      id: 'srv-unknown-1',
      method: 'client/unsupported_probe',
      params: {},
    });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'usage_update', used: 42 } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'read_file', status: 'in_progress', rawInput: { Path: '/tmp/a' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: { output: 'file-contents' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello acp' } } } });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, thoughtTokens: 3, totalTokens: 20 },
        },
      });
    }, 15);
  }
});

rl.on('close', () => {
  closed = true;
  process.exit(0);
});
`
  writeFileSync(scriptPath, script, 'utf8')
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o755)
  return scriptPath
}

async function closeProc(proc: AcpProcess): Promise<void> {
  if (!proc.isAlive()) {
    proc.close()
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000)
    timer.unref?.()
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    proc.close()
  })
}

test('ACP protocol helpers map updates, tool outputs, usage, results, and permission options', () => {
  const st = createAcpStreamState()
  assert.deepEqual(acpUpdateToAgyEvents('s1', { sessionUpdate: 'usage_update', used: 120 }, st), [])
  const thought = acpUpdateToAgyEvents('s1', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }, st)
  assert.equal(thought[0]?.kind, 'step')
  assert.equal((thought[0] as Extract<AgyEvent, { kind: 'step' }>).stepKind, 'thinking')

  const text = acpUpdateToAgyEvents('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, st)
  assert.equal(text[0]?.kind, 'step')
  // issue #158: { used } is context occupancy, never a token sample.
  assert.equal((text[0] as Extract<AgyEvent, { kind: 'step' }>).usage, undefined)
  assert.equal(st.lastContextUsed, 120)
  assert.equal(st.accumulatedText, 'hi')

  // An update that really reports token counts still feeds the sample.
  acpUpdateToAgyEvents('s1', { sessionUpdate: 'usage_update', used: 120, outputTokens: 7, cachedReadTokens: 90 }, st)
  assert.deepEqual(st.lastUsage, { cache_read_tokens: 90, output_tokens: 7 })

  const startTool = acpUpdateToAgyEvents('s1', {
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    name: 'run_command',
    status: 'running',
    rawInput: { CommandLine: 'pwd' },
  }, st)
  assert.equal((startTool[0] as Extract<AgyEvent, { kind: 'step' }>).state, 'ACTIVE')

  const doneTool = acpUpdateToAgyEvents('s1', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    rawOutput: { text: '/work' },
  }, st)
  assert.equal((doneTool[0] as Extract<AgyEvent, { kind: 'step' }>).state, 'DONE')
  assert.equal((doneTool[0] as Extract<AgyEvent, { kind: 'step' }>).tool?.output, '/work')
  assert.equal(st.textSeq, 1)

  const errTool = acpUpdateToAgyEvents('s1', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c2',
    title: 'write_to_file',
    status: 'failed',
    content: [{ content: { text: 'disk full' } }],
  }, st)
  assert.equal((errTool[0] as Extract<AgyEvent, { kind: 'step' }>).state, 'ERROR')
  assert.equal((errTool[0] as Extract<AgyEvent, { kind: 'step' }>).tool?.error, 'disk full')

  const canceledTool = acpUpdateToAgyEvents('s1', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c3',
    status: 'cancelled',
  }, st)
  assert.equal((canceledTool[0] as Extract<AgyEvent, { kind: 'step' }>).state, 'CANCELED')
  assert.equal((canceledTool[0] as Extract<AgyEvent, { kind: 'step' }>).tool?.error, 'tool execution canceled')

  assert.equal(extractAcpToolOutput({ rawOutput: 'plain' }), 'plain')
  assert.equal(extractAcpToolOutput({ rawOutput: { result: 'ok' } }), 'ok')
  assert.equal(extractAcpToolOutput({ rawOutput: { k: 1 } }), '{"k":1}')
  assert.equal(extractAcpToolOutput({ content: [{ text: 'a' }, { content: { text: 'b' } }] }), 'a\nb')
  assert.equal(extractAcpToolOutput({}), undefined)

  assert.deepEqual(acpUsageToRawUsage({ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, thinking_tokens: 5, total_tokens: 15 }), {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
    thinking_tokens: 5,
    total_tokens: 15,
  })
  assert.deepEqual(acpUsageToRawUsage(null), {})

  const badRes = acpPromptResultToAgyEvent('s1', { stopReason: 'error', error: 'boom', usage: { inputTokens: 9 } }, '')
  assert.equal(badRes.kind, 'result')
  if (badRes.kind === 'result') {
    assert.equal(badRes.ok, false)
    assert.equal(badRes.error, 'boom')
    assert.equal(badRes.usage.input_tokens, 9)
  }

  const opts = [
    { optionId: 'a1', kind: 'allow_always' },
    { optionId: 'a2', kind: 'allow_once' },
    { optionId: 'r1', kind: 'reject_once' },
  ]
  assert.deepEqual(pickPermissionOption({ options: opts }, 'plan'), { outcome: 'selected', optionId: 'r1' })
  assert.deepEqual(pickPermissionOption({ options: opts }, 'auto'), { outcome: 'selected', optionId: 'a1' })
  assert.deepEqual(pickPermissionOption({ options: opts }, 'skip'), { outcome: 'selected', optionId: 'a1' })
  assert.deepEqual(pickPermissionOption({ options: opts }, 'accept-edits'), { outcome: 'selected', optionId: 'a2' })
  assert.deepEqual(pickPermissionOption({ options: [] }, 'auto'), { outcome: 'cancelled' })
})

test('AcpProcess runs initialize, openSession, prompt streaming, and resume fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-client-'))
  const normalBin = createMockAcpBin(dir, 'normal')
  const loadBin = createMockAcpBin(dir, 'fail-resume-load')
  const proc = new AcpProcess({
    bin: normalBin,
    cwd: dir,
    permissionMode: 'auto',
    sandbox: false,
    agent: 'reviewer',
    preemptAutoUpdate: false,
  })
  const proc2 = new AcpProcess({ bin: loadBin, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
  try {
    const sid = await proc.openSession({ cwd: dir, addDirs: [dir], model: 'gemini-4-hydrogen', effort: 'medium', mode: 'auto' })
    assert.equal(sid, 'acp-sess-1')
    assert.equal(proc.isAlive(), true)
    assert.equal(proc.sessionCount, 1)

    const updates: Array<Record<string, unknown>> = []
    const res = await proc.prompt({
      sessionId: sid,
      text: 'hello',
      timeoutMs: 5_000,
      onUpdate: (u) => updates.push(u),
    })
    assert.equal(res.stopReason, 'end_turn')
    assert.ok(updates.some((u) => u.sessionUpdate === 'agent_message_chunk'))
    assert.ok(updates.some((u) => u.sessionUpdate === 'tool_call_update'))

    // Reuse already-open session without issuing another session/new.
    const reused = await proc.openSession({ cwd: dir, resumeId: sid, mode: 'auto' })
    assert.equal(reused, sid)

    // Resume fallback to session/load when session/resume errors.
    const sid2 = await proc2.openSession({ cwd: dir, resumeId: 'prev-cid', mode: 'skip' })
    assert.equal(sid2, 'prev-cid')
  } finally {
    await Promise.all([closeProc(proc), closeProc(proc2)])
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('AcpProcess enforces idle/maxTurn timeouts, abort cancellation, and crash rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-timeout-'))
  const hangBin = createMockAcpBin(dir, 'hang-prompt')
  const crashBin = createMockAcpBin(dir, 'crash-on-prompt')
  const proc = new AcpProcess({ bin: hangBin, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
  const crashProc = new AcpProcess({ bin: crashBin, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
  try {
    const sid = await proc.openSession({ cwd: dir })

    await assert.rejects(
      proc.prompt({ sessionId: sid, text: 'wait', timeoutMs: 40, idleTimeoutMs: 40, longToolIdleMs: 90, onUpdate: () => {} }),
      /timed out/,
    )

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    await assert.rejects(
      proc.prompt({ sessionId: sid, text: 'abort', timeoutMs: 5_000, signal: ac.signal, onUpdate: () => {} }),
      /aborted/,
    )

    await assert.rejects(
      proc.prompt({ sessionId: sid, text: 'maxTurn', timeoutMs: 5_000, maxTurnMs: 40, onUpdate: () => {} }),
      /maxTurn/,
    )

    const crashSid = await crashProc.openSession({ cwd: dir })
    await assert.rejects(
      crashProc.prompt({ sessionId: crashSid, text: 'crash', timeoutMs: 5_000, onUpdate: () => {} }),
      /exited/,
    )
    assert.match(crashProc.stderr, /fatal acp stderr/)
  } finally {
    await Promise.all([closeProc(proc), closeProc(crashProc)])
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('AcpSessionPool starts sweep lazily, evicts LRU/idle/other accounts, and disposes cleanly', (t) => {
  const intervals = t.mock.method(globalThis, 'setInterval')
  const created: Array<{ opts: unknown; closed: boolean; alive: boolean; lastUsedAt: number; sessionCount: number; emitExit: () => void }> = []

  const pool = new AcpSessionPool({
    bin: () => '/usr/bin/agy',
    cfg: () => defaultConfig(),
    maxProcesses: 2,
    idleTtlMs: 1_000,
    createProcess: (opts) => {
      const listeners = new Map<string, Array<() => void>>()
      const stub = {
        opts,
        closed: false,
        alive: true,
        lastUsedAt: 100,
        sessionCount: 1,
        isAlive() { return this.alive },
        close() { this.closed = true; this.alive = false },
        once(ev: string, cb: () => void) {
          const list = listeners.get(ev) ?? []
          list.push(cb)
          listeners.set(ev, list)
        },
        emitExit() {
          this.alive = false
          for (const cb of listeners.get('exit') ?? []) cb()
        },
      }
      created.push(stub)
      return stub as unknown as AcpProcess
    },
  })
  t.after(() => pool.dispose())

  assert.equal(intervals.mock.calls.length, 0, 'constructor must not leak an idle sweep interval')

  const p1 = pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a1', mode: 'auto', sandbox: false, agent: '' })
  assert.equal(intervals.mock.calls.length, 1, 'acquireProcess arms the lazy sweep timer')
  const p1Again = pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a1', mode: 'auto', sandbox: false, agent: '' })
  assert.equal(p1, p1Again)

  // LRU eviction within the same account (works on both Windows & POSIX)
  created[0]!.lastUsedAt = 10
  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a1', mode: 'skip', sandbox: false, agent: '' })
  created[1]!.lastUsedAt = 500
  // Exceeds maxProcesses=2 -> evicts oldest (auto)
  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a1', mode: 'plan', sandbox: false, agent: '' })
  assert.equal(created[0]!.closed, true)
  assert.equal(pool.status().activeProcesses, 2)

  assert.equal(pool.evictOtherAccounts('a2'), 2)
  assert.equal(created[1]!.closed, true)
  assert.equal(created[2]!.closed, true)

  pool.acquireProcess({ bin: 'agy', cwd: '/w', accountId: 'a2', mode: 'auto', sandbox: false, agent: '' })
  assert.equal(pool.evictIdle(Date.now() + 5_000), 1)
  assert.equal(pool.status().activeProcesses, 0)
})

test('runAcpAttempt streams happy path, falls back cleanly on pre-stream failure, and handles abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-attempt-'))
  const spawnedProcs: AcpProcess[] = []
  const store = new SessionStore(join(dir, 'sessions.json'))
  const runs = new RunRegistry()

  let released = 0
  let clearedPrompt = ''
  let registered = 0
  let unregistered = 0
  let lastRunCalled = false

  const deps: AttemptDeps = {
    acquire: async () => () => {},
    runs,
    store,
    clearInFlightPrompt: (_k, p) => { clearedPrompt = p },
    registerActiveRun: () => { registered++ },
    unregisterActiveRun: () => { unregistered++ },
    isSuperseded: () => false,
    noteNetworkFailure: () => 0,
    clearNetworkStreak: () => {},
    dropFailoverBudget: () => {},
    clearRateLimitFailover: () => {},
    sharesSingleEgress: () => false,
    lastAccountSpawnTime: new Map(),
    minSpawnIntervalMs: 0,
    onRun: () => { lastRunCalled = true },
  }

  const slot = (): AttemptSlot => ({
    releaseOnce: () => { released++ },
    armHandoff: () => null,
  })

  const cfg = { ...defaultConfig(), transport: 'acp' as const, permissionMode: 'auto' as const }
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as Message]
  const baseInput: AttemptInput = {
    cfg,
    bin: createMockAcpBin(dir, 'normal'),
    permissionMode: 'auto',
    sessionKey: 'sess-acp-1',
    workspaceRoot: dir,
    isAux: false,
    account: undefined,
    prompt: 'hi',
    model: 'gemini-3.8-flash',
    activeModel: 'gemini-3.8-flash',
    effort: 'medium',
    addDirs: [],
    persistBinding: true,
    binding: undefined,
    messages,
    newlySentImageIds: [],
    sessionAccountKey: 'sess-acp-1',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
  }

  const pool = new AcpSessionPool({
    bin: () => baseInput.bin,
    cfg: () => cfg,
    createProcess: (o) => {
      const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
      spawnedProcs.push(p)
      return p
    },
  })
  const badPool = new AcpSessionPool({
    bin: () => '/nonexistent/agy',
    cfg: () => cfg,
    createProcess: () => ({
      isAlive: () => true,
      sessionCount: 0,
      stderr: '',
      lastUsedAt: Date.now(),
      once: () => {},
      close: () => {},
      openSession: async () => { throw new Error('spawn failed') },
    } as unknown as AcpProcess),
  })
  const crashPool = new AcpSessionPool({
    bin: () => createMockAcpBin(dir, 'crash-on-prompt'),
    cfg: () => cfg,
    createProcess: (o) => {
      const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
      spawnedProcs.push(p)
      return p
    },
  })

  try {
    // 1. Happy path
    const rec = await runAcpAttempt(pool, deps, baseInput, slot())
    assert.ok(rec, 'runAcpAttempt should return live RunRecording')
    for await (const _ of rec.eventsFrom(0)) { /* wait for settlement */ }
    assert.equal(rec.failureInfo, null)
    assert.equal(released, 1)
    assert.equal(registered, 1)
    assert.equal(unregistered, 1)
    assert.equal(clearedPrompt, 'hi')
    assert.equal(lastRunCalled, true)
    assert.equal(store.get('sess-acp-1')?.conversationId, 'acp-sess-1')

    // 2. Pre-stream failure returns null and keeps slot held for CLI fallback
    const beforeRelease = released
    const fallback = await runAcpAttempt(badPool, deps, baseInput, slot())
    assert.equal(fallback, null)
    assert.equal(released, beforeRelease, 'slot must remain held on pre-stream fallback')

    // 3. Pre-aborted signal settles early and releases slot
    const ac = new AbortController()
    ac.abort()
    const abortedRec = await runAcpAttempt(pool, deps, { ...baseInput, signal: ac.signal }, slot())
    assert.ok(abortedRec)
    assert.equal(abortedRec.failureInfo?.kind, 'aborted')
    assert.equal(released, beforeRelease + 1)

    // 4. Unexpected child exit during prompt classifies as failure instead of hanging
    const crashRec = await runAcpAttempt(crashPool, deps, { ...baseInput, bin: createMockAcpBin(dir, 'crash-on-prompt'), sessionKey: 'sess-acp-crash', persistBinding: false }, slot())
    assert.ok(crashRec)
    for await (const _ of crashRec.eventsFrom(0)) { /* wait for settlement */ }
    assert.ok(crashRec.failureInfo !== null)
    assert.equal(crashRec.failureInfo?.kind, 'error')
    assert.equal(crashRec.failureInfo?.code, Err.PROCESS_EXIT)
  } finally {
    await Promise.all(spawnedProcs.map((p) => closeProc(p)))
    pool.dispose()
    badPool.dispose()
    crashPool.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})
