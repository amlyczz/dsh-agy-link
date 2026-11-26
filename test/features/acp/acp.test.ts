import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err, type AgyEvent } from '../../../src/common/types.ts'
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
} from '../../../src/features/acp/index.ts'
import { RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import { runAgyAttempt } from '../../../src/provider/attempt-outcome.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../../../src/provider/attempt.ts'

function createMockAcpBin(dir: string, behavior: 'normal' | 'fail-resume-load' | 'hang-prompt' | 'crash-on-prompt' | 'crash-after-chunk' = 'normal'): string {
  const scriptPath = join(dir, `mock-acp-${behavior}.mjs`)
  const script = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

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
    // A real agy replays the stored transcript; an id that does not exist
    // "succeeds" with nothing. Only the replay is evidence of a real restore.
    if (mode === 'fail-resume-load') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } } } });
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } });
    return;
  }
  if (msg.method === 'session/new') {
    const models = process.env.MOCK_ACP_ADVERTISE_MODELS
      ? { models: { availableModels: [
          { modelId: 'gemini-4-hydrogen-high' },
          { modelId: 'gemini-4-hydrogen-xhigh' },
          { modelId: 'gemini-4-neon-high' },
        ] } }
      : {};
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1', ...models } });
    return;
  }
  if (msg.method === 'session/set_model') {
    if (process.env.MOCK_ACP_RECORD_DIR) {
      try { appendFileSync(process.env.MOCK_ACP_RECORD_DIR + '/calls.log', msg.method + ' ' + JSON.stringify(msg.params) + '\\n'); } catch {}
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option' || msg.method === 'session/close') {
    if (process.env.MOCK_ACP_RECORD_DIR) {
      try { appendFileSync(process.env.MOCK_ACP_RECORD_DIR + '/calls.log', msg.method + ' ' + JSON.stringify(msg.params) + '\\n'); } catch {}
    }
    if (msg.method === 'session/close') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
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
    if (mode === 'crash-after-chunk') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } } } });
      setTimeout(() => {
        process.stderr.write('fatal acp stderr');
        process.exit(2);
      }, 30);
      return;
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
  // issue #158: `used` is context occupancy, never a token sample — it lives in
  // lastContextUsed so it can never clobber PromptResponse.usage with 0 output/cache.  assert.equal((text[0] as Extract<AgyEvent, { kind: 'step' }>).usage, undefined)
  assert.equal(st.lastContextUsed, 120)
  assert.equal(st.accumulatedText, 'hi')

  // An update that really reports token counts still feeds the sample.
  acpUpdateToAgyEvents('s1', { sessionUpdate: 'usage_update', used: 120, outputTokens: 7, cachedReadTokens: 90 }, st)
  assert.equal(st.lastUsage.cache_read_tokens, 90)
  assert.equal(st.lastUsage.output_tokens, 7)
  const text2 = acpUpdateToAgyEvents('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' } }, st)
  assert.equal((text2[0] as Extract<AgyEvent, { kind: 'step' }>).usage?.output_tokens, 7)
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
    env: { ...process.env, MOCK_ACP_RECORD_DIR: dir },
  })
  const proc2 = new AcpProcess({ bin: loadBin, cwd: dir, permissionMode: 'skip', preemptAutoUpdate: false })
  try {
    const opened = await proc.openSession({ cwd: dir, addDirs: [dir], model: 'gemini-4-hydrogen', effort: 'medium', mode: 'auto' })
    const sid = opened.sessionId
    assert.equal(sid, 'acp-sess-1')
    assert.equal(opened.status, 'created')
    assert.equal(opened.resumeFailed, false)
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
    assert.equal(reused.sessionId, sid)
    assert.equal(reused.status, 'cached')
    // issue #167: set_config_option is not idempotent on agy's side — it logs
    // 'Switching model in session <sid>' and re-runs the switch for an unchanged
    // value. DSH opens the session again on every turn, so an unchanged turn
    // must not re-send anything.
    const callsAfterFirst = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
    assert.equal(callsAfterFirst.filter((l) => l.startsWith('session/set_mode')).length, 1)
    assert.equal(callsAfterFirst.filter((l) => l.startsWith('session/set_config_option')).length, 2)
    await proc.openSession({ cwd: dir, resumeId: sid, mode: 'auto', model: 'gemini-4-hydrogen', effort: 'medium' })
    assert.equal(readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').length, callsAfterFirst.length)
    // A turn that changes only the effort sends only the effort.
    await proc.openSession({ cwd: dir, resumeId: sid, mode: 'auto', effort: 'high' })
    const effortCalls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').slice(callsAfterFirst.length)
    assert.equal(effortCalls.length, 1)
    assert.match(effortCalls[0] ?? '', /thought_level.*high/)
    // A model change re-sends the effort: agy resets it to the new model's default.
    await proc.openSession({ cwd: dir, resumeId: sid, mode: 'auto', model: 'gemini-4-neon', effort: 'high' })
    const modelCalls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').slice(callsAfterFirst.length + 1)
    assert.equal(modelCalls.length, 2)
    assert.match(modelCalls[0] ?? '', /"configId":"model".*gemini-4-neon/)
    assert.match(modelCalls[1] ?? '', /thought_level.*high/)

    // Resume fallback to session/load when session/resume errors.
    const sid2 = await proc2.openSession({ cwd: dir, resumeId: 'prev-cid', mode: 'skip' })
    assert.equal(sid2.sessionId, 'prev-cid')
    assert.equal(sid2.status, 'loaded')
    assert.equal(sid2.resumeFailed, false)
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
    const { sessionId: sid } = await proc.openSession({ cwd: dir })

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

    const { sessionId: crashSid } = await crashProc.openSession({ cwd: dir })
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

    // 4. A child that dies before emitting anything is a dead transport, not an
    // answer: the attempt hands back null so the caller re-runs over CLI -p.
    const beforeCrashRelease = released
    const deadRec = await runAcpAttempt(crashPool, deps, { ...baseInput, bin: createMockAcpBin(dir, 'crash-on-prompt'), sessionKey: 'sess-acp-dead', persistBinding: false }, slot())
    assert.equal(deadRec, null, 'a turn with no output must fall back to the CLI transport')
    assert.equal(released, beforeCrashRelease, 'the fallback keeps the slot held for the CLI retry')

    // 5. A child that dies AFTER producing output keeps its partial answer and
    // classifies as a failure instead of being retried (that would duplicate it).
    const crashPool2 = new AcpSessionPool({
      bin: () => createMockAcpBin(dir, 'crash-after-chunk'),
      cfg: () => cfg,
      createProcess: (o) => {
        const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
        spawnedProcs.push(p)
        return p
      },
    })
    const crashRec = await runAcpAttempt(crashPool2, deps, { ...baseInput, bin: createMockAcpBin(dir, 'crash-after-chunk'), sessionKey: 'sess-acp-crash', persistBinding: false }, slot())
    assert.ok(crashRec)
    for await (const _ of crashRec.eventsFrom(0)) { /* wait for settlement */ }
    assert.ok(crashRec.failureInfo !== null)
    assert.equal(crashRec.failureInfo?.kind, 'error')
    assert.equal(crashRec.failureInfo?.code, Err.PROCESS_EXIT)
    crashPool2.dispose()
  } finally {
    await Promise.all(spawnedProcs.map((p) => closeProc(p)))
    pool.dispose()
    badPool.dispose()
    crashPool.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('issue #167: an advertised effort-suffixed model id is switched atomically in one call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-atomic-'))
  const bin = createMockAcpBin(dir, 'normal')
  const proc = new AcpProcess({
    bin,
    cwd: dir,
    permissionMode: 'skip',
    preemptAutoUpdate: false,
    env: { ...process.env, MOCK_ACP_RECORD_DIR: dir, MOCK_ACP_ADVERTISE_MODELS: '1' },
  })
  try {
    const opened = await proc.openSession({ cwd: dir, model: 'gemini-4-hydrogen', effort: 'xhigh', mode: 'skip' })
    assert.equal(opened.sessionId, 'acp-sess-1')
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
    const setModel = calls.filter((l) => l.startsWith('session/set_model'))
    const configCalls = calls.filter((l) => l.startsWith('session/set_config_option'))
    assert.equal(setModel.length, 1, 'one atomic switch')
    assert.match(setModel[0] ?? '', /gemini-4-hydrogen-xhigh/)
    assert.equal(configCalls.length, 0, 'no model→thought_level double switch')
  } finally {
    await closeProc(proc)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('issue #167: without an advertised id the two-step config switch still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-atomic-fallback-'))
  const bin = createMockAcpBin(dir, 'normal')
  const proc = new AcpProcess({
    bin,
    cwd: dir,
    permissionMode: 'skip',
    preemptAutoUpdate: false,
    env: { ...process.env, MOCK_ACP_RECORD_DIR: dir },
  })
  try {
    await proc.openSession({ cwd: dir, model: 'gemini-4-hydrogen', effort: 'xhigh', mode: 'skip' })
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
    assert.equal(calls.filter((l) => l.startsWith('session/set_model')).length, 0)
    assert.equal(calls.filter((l) => l.startsWith('session/set_config_option')).length, 2)
  } finally {
    await closeProc(proc)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('AcpProcess.closeSession sends session/close and clears sessionCount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-close-sess-'))
  const bin = createMockAcpBin(dir, 'normal')
  const proc = new AcpProcess({
    bin,
    cwd: dir,
    permissionMode: 'skip',
    preemptAutoUpdate: false,
    env: { ...process.env, MOCK_ACP_RECORD_DIR: dir },
  })
  try {
    const opened = await proc.openSession({ cwd: dir, model: 'gemini-4-hydrogen', mode: 'skip' })
    assert.equal(proc.sessionCount, 1)
    await proc.closeSession(opened.sessionId)
    assert.equal(proc.sessionCount, 0)
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
    const closed = calls.filter((l) => l.startsWith('session/close'))
    assert.equal(closed.length, 1)
    assert.match(closed[0] ?? '', /acp-sess-1/)
  } finally {
    await closeProc(proc)
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('runAcpAttempt closes ephemeral isAux sessions without persisting binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-aux-'))
  const bin = createMockAcpBin(dir, 'normal')
  const cfg = defaultConfig()
  const store = new SessionStore(join(dir, 'sessions.json'))
  const runs = new RunRegistry()
  const spawnedProcs: AcpProcess[] = []
  let registered = 0
  let lastRunCalled = false
  const deps: AttemptDeps = {
    acquire: async () => () => {},
    runs,
    store,
    clearInFlightPrompt: () => {},
    registerActiveRun: () => { registered += 1 },
    unregisterActiveRun: () => {},
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
  const slot: AttemptSlot = {
    releaseOnce: () => {},
    armHandoff: () => null,
  }
  const pool = new AcpSessionPool({
    bin: () => bin,
    cfg: () => cfg,
    createProcess: (o) => {
      const p = new AcpProcess({ ...o, preemptAutoUpdate: false, env: { ...process.env, MOCK_ACP_RECORD_DIR: dir } })
      spawnedProcs.push(p)
      return p
    },
  })
  const input: AttemptInput = {
    cfg,
    bin,
    permissionMode: 'skip',
    sessionKey: 'sess-aux-1',
    workspaceRoot: dir,
    isAux: true,
    account: undefined,
    prompt: 'title this',
    model: 'gemini-3.8-flash',
    activeModel: 'gemini-3.8-flash',
    effort: undefined,
    addDirs: [],
    persistBinding: false,
    binding: undefined,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'title this' }] } as unknown as Message],
    newlySentImageIds: [],
    sessionAccountKey: 'sess-aux-1',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
  }
  try {
    const rec = await runAcpAttempt(pool, deps, input, slot)
    assert.ok(rec)
    for await (const _ of rec.eventsFrom(0)) { /* drain */ }
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(registered, 0)
    assert.equal(lastRunCalled, true)
    assert.equal(store.get('sess-aux-1'), undefined)
    assert.equal(spawnedProcs[0]?.sessionCount, 0)
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
    assert.equal(calls.filter((l) => l.startsWith('session/close')).length, 1)
  } finally {
    await Promise.all(spawnedProcs.map((p) => closeProc(p)))
    pool.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('runAgyAttempt routes isAux calls via ACP unless CLI overrides require CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-aux-route-'))
  try {
    const scriptPath = join(dir, 'cli-mock.mjs')
    writeFileSync(
      scriptPath,
      `console.log(JSON.stringify({ event: 'response', content: 'ok' }));
console.log(JSON.stringify({ event: 'complete', stats: { total_tokens: 3 } }));
`,
      'utf8',
    )
    const fakeBin = process.platform === 'win32' ? join(dir, 'agy.cmd') : join(dir, 'agy')
    if (process.platform === 'win32') {
      writeFileSync(fakeBin, `@echo off\r\nnode "${scriptPath}" %*\r\n`, 'utf8')
    } else {
      writeFileSync(fakeBin, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ event: 'response', content: 'ok' }));\nconsole.log(JSON.stringify({ event: 'complete', stats: { total_tokens: 3 } }));\n`, 'utf8')
      chmodSync(fakeBin, 0o755)
    }
    const runs = new RunRegistry()
    const store = new SessionStore(join(dir, 'sessions.json'))
    let acpCalls = 0
    const cfg = { ...defaultConfig(), transport: 'acp' as const }
    const deps: AttemptDeps = {
      acquire: async () => () => undefined,
      runs,
      store,
      clearInFlightPrompt: () => undefined,
      registerActiveRun: () => undefined,
      unregisterActiveRun: () => undefined,
      isSuperseded: () => false,
      noteNetworkFailure: () => 0,
      clearNetworkStreak: () => undefined,
      dropFailoverBudget: () => undefined,
      clearRateLimitFailover: () => undefined,
      sharesSingleEgress: () => false,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
      runAcp: async () => {
        acpCalls++
        const rec = runs.create()
        rec.settle(null)
        return rec
      },
    }
    const baseInput: AttemptInput = {
      cfg,
      bin: fakeBin,
      permissionMode: 'skip',
      sessionKey: 'sess-route',
      workspaceRoot: dir,
      isAux: true,
      account: undefined,
      prompt: 'hi',
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      effort: undefined,
      addDirs: [],
      persistBinding: false,
      binding: undefined,
      messages: [],
      newlySentImageIds: [],
      sessionAccountKey: 'sess-route',
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    }
    const drain = async (input: AttemptInput) => {
      const gen = runAgyAttempt(deps, input)
      while (true) {
        const step = await gen.next()
        if (step.done) {
          for await (const _ of step.value.eventsFrom(0)) { /* drain */ }
          break
        }
      }
    }
    await drain(baseInput)
    assert.equal(acpCalls, 1, 'isAux without CLI overrides should route via ACP')
    await drain({ ...baseInput, jsonSchema: '{"type":"object"}' })
    assert.equal(acpCalls, 1, 'isAux with jsonSchema must stay on CLI')
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }) } catch { /* windows handle cleanup */ }
  }
})

test('issue #207: ACP cancel sets ok=false, skips self-heal, preserves interrupted binding, and fires onAccountUsed on success', async () => {
  for (const sr of ['cancelled', 'canceled']) {
    const ev = acpPromptResultToAgyEvent('s1', { stopReason: sr }, '')
    assert.equal(ev.kind, 'result')
    if (ev.kind === 'result') {
      assert.equal(ev.ok, false)
      assert.equal(ev.error, 'ACP prompt cancelled')
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-cancel-'))
  try {
    const scriptPath = join(dir, 'mock-acp-cancel.mjs')
    writeFileSync(scriptPath, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let prompts = 0;
const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-c-1' } });
  if (msg.method === 'session/close') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/prompt') {
    prompts++;
    const logDir = process.env.MOCK_CANCEL_LOG;
    if (logDir) appendFileSync(logDir, 'prompt\\n');
    const mode = process.env.MOCK_ACP_MODE || 'cancel';
    if (mode === 'ok') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } } });
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } });
  }
  send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`, 'utf8')
    const fakeBin = join(dir, process.platform === 'win32' ? 'agy.cmd' : 'agy')
    if (process.platform === 'win32') {
      writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8')
    } else {
      writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8')
      chmodSync(fakeBin, 0o755)
    }

    const logFile = join(dir, 'prompts.log')
    const acpCfg = { ...defaultConfig(), transport: 'acp' as const }
    const pool = new AcpSessionPool({ bin: () => fakeBin, cfg: () => acpCfg })
    const runs = new RunRegistry()
    const store = new SessionStore(join(dir, 'sessions.json'))
    const usedCalls: Array<[string, string]> = []
    const deps: AttemptDeps = {
      acquire: async () => () => undefined,
      runs,
      store,
      onAccountUsed: (id, fam) => usedCalls.push([id, fam]),
      clearInFlightPrompt: () => undefined,
      registerActiveRun: () => undefined,
      unregisterActiveRun: () => undefined,
      isSuperseded: () => false,
      noteNetworkFailure: () => 0,
      clearNetworkStreak: () => undefined,
      dropFailoverBudget: () => undefined,
      clearRateLimitFailover: () => undefined,
      sharesSingleEgress: () => false,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
    }
    const acc = { id: 'acc-1', dir, enabled: true, email: 'a@b.c' } as never
    const baseInput = (sessionKey: string): AttemptInput => ({
      cfg: { ...defaultConfig(), transport: 'acp' },
      bin: fakeBin,
      permissionMode: 'skip',
      sessionKey,
      workspaceRoot: dir,
      isAux: false,
      account: acc,
      prompt: 'hello',
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      effort: undefined,
      addDirs: [],
      persistBinding: true,
      binding: { conversationId: 'acp-c-1', lastMessageCount: 1, updatedAt: Date.now(), model: 'gemini-3.8-flash', interrupted: true },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as unknown as Message],
      newlySentImageIds: [],
      sessionAccountKey: `${sessionKey}:acc-1`,
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    })

    const prevLog = process.env.MOCK_CANCEL_LOG
    const prevMode = process.env.MOCK_ACP_MODE
    process.env.MOCK_CANCEL_LOG = logFile
    const makeSlot = (): AttemptSlot => ({ releaseOnce: () => undefined, armHandoff: () => null })
    try {
      process.env.MOCK_ACP_MODE = 'cancel'
      const cancelInput = baseInput('s-cancel')
      store.set(cancelInput.sessionAccountKey, cancelInput.binding!)
      const cancelRec = await runAcpAttempt(pool, deps, cancelInput, makeSlot())
      assert.ok(cancelRec, 'cancelled ACP prompt returns settled RunRecording')
      for await (const _ of cancelRec.eventsFrom(0)) { /* wait for settlement */ }
      assert.equal(cancelRec.failureInfo?.kind, 'aborted', 'cancelled ACP prompt must settle as aborted, never failure: null')
      assert.equal(readFileSync(logFile, 'utf8').trim().split(/\r?\n/).length, 1, 'cancelled ACP prompt must NOT trigger self-heal retry')
      assert.equal(usedCalls.length, 0, 'cancelled ACP prompt must not fire onAccountUsed')
      assert.equal(store.get(cancelInput.sessionAccountKey)?.interrupted, true, 'cancelled ACP prompt must preserve interrupted binding')

      const poolOk = new AcpSessionPool({ bin: () => fakeBin, cfg: () => acpCfg })
      try {
        process.env.MOCK_ACP_MODE = 'ok'
        const okRec = await runAcpAttempt(poolOk, deps, baseInput('s-ok'), makeSlot())
        assert.ok(okRec)
        for await (const _ of okRec.eventsFrom(0)) { /* wait for settlement */ }
        assert.equal(okRec.failureInfo, null)
        assert.deepEqual(usedCalls, [['acc-1', 'google']], 'successful non-aux ACP turn must fire onAccountUsed')
      } finally {
        poolOk.dispose()
      }
    } finally {
      pool.dispose()
      if (prevLog === undefined) delete process.env.MOCK_CANCEL_LOG
      else process.env.MOCK_CANCEL_LOG = prevLog
      if (prevMode === undefined) delete process.env.MOCK_ACP_MODE
      else process.env.MOCK_ACP_MODE = prevMode
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 }) } catch { /* windows handle cleanup */ }
  }
})
