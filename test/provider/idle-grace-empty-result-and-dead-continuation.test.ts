// Regression tests for the `agy stream ended without a result event` (INVALID_OUTPUT)
// double-bug:
// 1) When the idle-grace reaper SIGTERMs agy and agy flushes an empty error result
//    (`{ kind: 'result', ok: false, response: '' }`) before exiting, `rec.hasResult`
//    was already true so handleAttemptOutcome skipped reply recovery / synthResult,
//    while classifyFailure still returned null and EventMapper ignored the empty error
//    result — dropping driveSpan into `INVALID_OUTPUT: agy stream ended without a result event`.
// 2) When a settled continuation recording has `failureInfo === null` and no remaining
//    finishable event after the cut point, AgyAdapter kept re-driving that dead recording
//    on every retry instead of forgetting it and spawning a fresh agy run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../../src/common/config.ts'
import type { AgyEvent, PluginConfig } from '../../src/common/types.ts'
import { AgyAdapter } from '../../src/host/adapter.ts'
import { ModelCatalog } from '../../src/host/models.ts'
import { StreamJsonParser } from '../../src/host/parser.ts'
import { mirrorCallId, RunRecording, RunRegistry } from '../../src/host/recording.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { handleAttemptOutcome } from '../../src/provider/attempt-outcome.ts'
import { IDLE_GRACE_NO_REPLY_NOTICE } from '../../src/provider/idle-grace-reply.ts'
import { driveSpan } from '../../src/provider/span.ts'
import type { AttemptDeps, AttemptInput, AttemptRecorder } from '../../src/provider/attempt.ts'
import type { RunningProcess } from '../../src/host/runner.ts'

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of iter) out.push(ch)
  return out
}

function makeAttemptInput(home: string, prompt: string, sessionKey: string): AttemptInput {
  return {
    cfg: resolveConfig({}, {}, {}),
    bin: process.execPath,
    workspaceRoot: home,
    prompt,
    permissionMode: 'skip',
    isAux: false,
    account: undefined,
    model: 'gemini-3.8-flash',
    activeModel: 'gemini-3.8-flash',
    effort: undefined,
    addDirs: [],
    persistBinding: false,
    binding: undefined,
    messages: [],
    newlySentImageIds: [],
    sessionAccountKey: '',
    family: 'google',
    sessionKey,
    signal: undefined,
    agyOnEvent: undefined,
  }
}

function makeAttemptDeps(home: string, runs: RunRegistry): AttemptDeps {
  return {
    runs,
    store: new SessionStore(join(home, 'sessions.json')),
    acquire: () => Promise.resolve(() => {}),
    lastAccountSpawnTime: new Map(),
    minSpawnIntervalMs: 0,
    registerActiveRun: () => {},
    unregisterActiveRun: () => {},
    clearInFlightPrompt: () => {},
    isSuperseded: () => false,
    noteNetworkFailure: () => 1,
    clearNetworkStreak: () => {},
    dropFailoverBudget: () => {},
    clearRateLimitFailover: () => {},
    sharesSingleEgress: () => false,
  }
}

function makeRecorder(home: string, rec: RunRecording, cid: string): AttemptRecorder {
  const conversationsDir = join(home, '.gemini', 'antigravity-cli', 'conversations')
  return {
    rec,
    parser: new StreamJsonParser(),
    conversationsDir,
    before: { dir: conversationsDir, files: new Map() },
    streamCid: cid,
    printTimeoutMinutes: 10,
    attachProcess: () => {},
    feedLine: () => {},
    drain: () => {},
    flushTracker: () => {},
    stop: () => {},
    quotaFailover: () => null,
    cooledInLiveFamilies: () => new Set(),
    conversationId: () => cid,
  }
}

test('RunRecording.hasConsumableResult and hasFinishableEventFrom classify empty error results accurately', () => {
  const rec = new RunRecording('run-classify')
  assert.equal(rec.hasResult, false)
  assert.equal(rec.hasConsumableResult, false)
  assert.equal(rec.hasFinishableEventFrom(0), false)

  // Event 0: completed tool step
  rec.append({
    kind: 'step',
    stepKey: '1',
    stepKind: 'tool',
    state: 'DONE',
    text: '',
    tool: { name: 'read_file', output: 'ok' },
    raw: {},
  })
  assert.equal(rec.hasFinishableEventFrom(0, true), true)
  assert.equal(rec.hasFinishableEventFrom(0, false), false)
  assert.equal(rec.hasFinishableEventFrom(1, true), false)

  // Event 1: empty error result (what agy can flush on SIGTERM)
  rec.append({
    kind: 'result',
    conversationId: 'conv-1',
    ok: false,
    response: '',
    error: 'terminated',
    usage: {},
    raw: {},
  })
  assert.equal(rec.hasResult, true)
  assert.equal(rec.hasConsumableResult, false)
  assert.equal(rec.hasFinishableEventFrom(1, true), false)

  // Event 2: consumable ok result (or synthetic idle-grace recovery)
  rec.append({
    kind: 'result',
    conversationId: 'conv-1',
    ok: true,
    response: 'done',
    usage: {},
    raw: {},
  })
  assert.equal(rec.hasConsumableResult, true)
  assert.equal(rec.hasFinishableEventFrom(1, true), true)
  assert.equal(rec.hasFinishableEventFrom(2, false), true)
})

test('handleAttemptOutcome synthesizes recovered reply on idleGraceTerminated even after an empty error result', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-idle-empty-res-'))
  try {
    const cid = 'conv-empty-res-1'
    const logDir = join(home, '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated', 'logs')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'run job' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Recovered final answer.' }),
      ].join('\n') + '\n',
    )

    const runs = new RunRegistry()
    const rec = runs.create()
    rec.accountHome = home
    // Simulate agy emitting an empty error result envelope when SIGTERM hits.
    const emptyErrResult: AgyEvent = {
      kind: 'result',
      conversationId: cid,
      ok: false,
      response: '',
      error: 'signal: terminated',
      usage: {},
      raw: {},
    }
    rec.append(emptyErrResult)

    const proc = {
      outcome: Promise.resolve({
        code: null,
        signal: 'SIGTERM' as const,
        timedOut: false,
        aborted: false,
        capped: false,
        idleGraceTerminated: true,
        stdout: '',
        stderrTail: 'root agent idle; waiting for 0 background tasks',
        durationMs: 100,
      }),
    } as unknown as RunningProcess

    await handleAttemptOutcome(makeAttemptDeps(home, runs), makeAttemptInput(home, 'run job', 'sess-1'), {
      proc,
      runLogHome: home,
      runLogsBefore: new Map(),
      recorder: makeRecorder(home, rec, cid),
      slot: { releaseOnce: () => {}, armHandoff: () => null },
      spawn: { prompt: 'run job', args: [], stdinPayload: undefined },
    })

    assert.equal(rec.isSettled, true)
    assert.equal(rec.failureInfo, null)
    assert.equal(rec.hasConsumableResult, true)

    const chunks = await collect(driveSpan({ runs }, rec, 0, true, false))
    const finish = chunks.find((c) => c.type === 'finish') as { type: 'finish'; reason: { kind: string } } | undefined
    assert.ok(finish, 'span must emit a finish chunk')
    assert.equal(finish.reason.kind, 'stop', 'must finish cleanly instead of INVALID_OUTPUT')
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'Recovered final answer.')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('handleAttemptOutcome falls back to IDLE_GRACE_NO_REPLY_NOTICE after empty error result with no transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-idle-notice-'))
  try {
    const runs = new RunRegistry()
    const rec = runs.create()
    rec.accountHome = home
    rec.append({
      kind: 'result',
      conversationId: 'conv-missing',
      ok: false,
      response: '',
      error: 'terminated',
      usage: {},
      raw: {},
    })
    const proc = {
      outcome: Promise.resolve({
        code: null,
        signal: 'SIGTERM' as const,
        timedOut: false,
        aborted: false,
        capped: false,
        idleGraceTerminated: true,
        stdout: '',
        stderrTail: '',
        durationMs: 50,
      }),
    } as unknown as RunningProcess

    await handleAttemptOutcome(makeAttemptDeps(home, runs), makeAttemptInput(home, 'hi', 'sess-2'), {
      proc,
      runLogHome: home,
      runLogsBefore: new Map(),
      recorder: makeRecorder(home, rec, 'conv-missing'),
      slot: { releaseOnce: () => {}, armHandoff: () => null },
      spawn: { prompt: 'hi', args: [], stdinPayload: undefined },
    })

    const chunks = await collect(driveSpan({ runs }, rec, 0, true, false))
    const finish = chunks.find((c) => c.type === 'finish') as { type: 'finish'; reason: { kind: string } } | undefined
    assert.equal(finish?.reason.kind, 'stop')
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text, IDLE_GRACE_NO_REPLY_NOTICE)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('AgyAdapter forgets a settled continuation with no finishable event instead of replaying INVALID_OUTPUT', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agy-dead-cont-'))
  try {
    const fakeBin = join(workDir, 'fake-agy.mjs')
    writeFileSync(
      fakeBin,
      `#!${process.execPath}
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-fresh' }))
console.log(JSON.stringify({ event: 'result', status: 'OK', conversation_id: 'conv-fresh', response: 'fresh attempt succeeded', usage: { input_tokens: 10, output_tokens: 5 } }))
`,
    )
    chmodSync(fakeBin, 0o755)

    const cfg: PluginConfig = { ...resolveConfig({}, {}, {}), permissionMode: 'plan', timeoutMs: 10_000 }
    const store = new SessionStore(join(workDir, 'sessions.json'))
    const catalog = new ModelCatalog(async () => { throw new Error('no discovery') }, cfg.fallbackModels, 300_000)
    const runs = new RunRegistry()
    const warnings: string[] = []
    const adapter = new AgyAdapter({
      getConfig: () => cfg,
      catalog,
      store,
      bin: () => fakeBin,
      acquire: () => Promise.resolve(() => {}),
      runs,
      log: (m) => warnings.push(m),
    })

    // Seed a settled recording whose last completed tool was at index 0, followed
    // only by a non-consumable empty error result, settled with failureInfo === null.
    const deadRec = runs.create()
    deadRec.append({
      kind: 'step',
      stepKey: '1',
      stepKind: 'tool',
      state: 'DONE',
      text: '',
      tool: { name: 'run_command', output: 'ok' },
      raw: {},
    })
    deadRec.append({
      kind: 'result',
      conversationId: 'conv-dead',
      ok: false,
      response: '',
      error: 'terminated',
      usage: {},
      raw: {},
    })
    deadRec.settle(null)

    const callId = mirrorCallId(deadRec.runId, 0)
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'agy_tool', arguments: '{}' }] },
      { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] },
    ] as unknown as Message[]
    const options: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages,
      tools: [{ name: 'agy_tool', description: '', parameters: {} } as never],
      sessionId: 'sess-dead-cont' as never,
    } as GenerateOptions

    const chunks = await collect(adapter.stream(options))
    const finish = chunks.find((c) => c.type === 'finish') as { type: 'finish'; reason: { kind: string } } | undefined
    assert.equal(finish?.reason.kind, 'stop', 'retry must spawn a fresh run and finish cleanly')
    assert.equal(runs.get(deadRec.runId), undefined, 'dead recording must be forgotten')
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'fresh attempt succeeded')
    assert.ok(
      warnings.some((w) => w.includes('settled without a consumable result')),
      'must log the dead-continuation recovery warning',
    )
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('AgyAdapter revives a continuation whose recording settled with PROCESS_EXIT instead of replaying it', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agy-revivable-cont-'))
  try {
    const fakeBin = join(workDir, 'fake-agy.mjs')
    writeFileSync(
      fakeBin,
      `#!${process.execPath}
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-revived' }))
console.log(JSON.stringify({ event: 'result', status: 'OK', conversation_id: 'conv-revived', response: 'retry spawned a fresh process', usage: { input_tokens: 10, output_tokens: 5 } }))
`,
    )
    chmodSync(fakeBin, 0o755)

    const cfg: PluginConfig = { ...resolveConfig({}, {}, {}), permissionMode: 'plan', timeoutMs: 10_000 }
    const store = new SessionStore(join(workDir, 'sessions.json'))
    const catalog = new ModelCatalog(async () => { throw new Error('no discovery') }, cfg.fallbackModels, 300_000)
    const runs = new RunRegistry()
    const warnings: string[] = []
    const adapter = new AgyAdapter({
      getConfig: () => cfg,
      catalog,
      store,
      bin: () => fakeBin,
      acquire: () => Promise.resolve(() => {}),
      runs,
      log: (m) => warnings.push(m),
    })

    // Live shape (2026-11-23): the idle sweep killed the child mid-turn, so the
    // recording settled with PROCESS_EXIT while a mirrored tool result was
    // already in history. Replaying it failed in ~8ms five times.
    const deadRec = runs.create()
    deadRec.append({
      kind: 'step',
      stepKey: '1',
      stepKind: 'tool',
      state: 'DONE',
      text: '',
      tool: { name: 'read_file', output: 'ok' },
      raw: {},
    })
    deadRec.settle({ kind: 'error', code: 'PROCESS_EXIT', message: 'agy acp exited (code=1, signal=null):' })

    const callId = mirrorCallId(deadRec.runId, 0)
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'agy_tool', arguments: '{}' }] },
      { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] },
    ] as unknown as Message[]
    const options: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
      messages,
      tools: [{ name: 'agy_tool', description: '', parameters: {} } as never],
      sessionId: 'sess-revivable' as never,
    } as GenerateOptions

    const started = Date.now()
    const chunks = await collect(adapter.stream(options))
    const finish = chunks.find((c) => c.type === 'finish') as { type: 'finish'; reason: { kind: string } } | undefined
    assert.equal(finish?.reason.kind, 'stop', 'a fresh spawn must be able to finish the step')
    assert.equal(runs.get(deadRec.runId), undefined, 'the dead recording must be forgotten')
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.text)
      .join('')
    assert.equal(text, 'retry spawned a fresh process')
    assert.ok(
      warnings.some((w) => w.includes('fresh process')),
      'must log that the recorded run could not be resumed',
    )
    assert.ok(Date.now() - started > 0)
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})
