// Hardening tests for the ACP channel: background detection without the CLI
// RUNNING flag, pool draining, scheme-A report delivery, session rebuild, empty
// turns classified from the per-process acp log, and the identity gates.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig } from '../../../src/common/types.ts'
import { AcpProcess, AcpSessionPool, runAcpAttempt } from '../../../src/features/acp/index.ts'
import { extractAttemptBackgroundSignals } from '../../../src/features/background/schedule-parse.ts'
import { BackgroundWakeWatcher } from '../../../src/features/background/watcher.ts'
import { RunRecording, RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../../../src/provider/attempt.ts'

import { FIXTURES_DIR } from '../../helpers/paths.ts'
const FIXTURE = join(FIXTURES_DIR, 'mock-acp-hardening.mjs')

/** Wait for the background settlement a streamed turn performs after hand-off. */
async function waitSettled(rec: { isSettled?: boolean }, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (rec.isSettled !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * Let taskkill reap the mock children before the temp cwd is removed. A child
 * that still holds the directory makes rmSync fail with EPERM, so retry until
 * the reaper catches up (a loaded machine can take well over a second).
 */
async function cleanupDir(dir: string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
      return
    } catch (e) {
      const code = (e as { code?: string }).code
      if (Date.now() >= deadline || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw e
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}


type MockMode = 'chat' | 'empty-proxy' | 'empty-auth' | 'banner'

function acpBin(mode: MockMode): string {
  return FIXTURE + ' ' + mode
}

function spawnAcp(dir: string, mode: MockMode, logFile?: string): AcpProcess {
  const saved = process.env.MOCK_ACP_MODE
  process.env.MOCK_ACP_MODE = mode
  try {
    return new AcpProcess({
      bin: FIXTURE,
      cwd: dir,
      permissionMode: 'auto',
      sandbox: false,
      env: { ...process.env, MOCK_ACP_MODE: mode },
      ...(logFile === undefined ? {} : { logFile }),
      preemptAutoUpdate: false,
    })
  } finally {
    if (saved === undefined) delete process.env.MOCK_ACP_MODE
    else process.env.MOCK_ACP_MODE = saved
  }
}

function attemptDeps(overrides: Partial<AttemptDeps> = {}): AttemptDeps {
  return {
    acquire: async () => () => {},
    runs: new RunRegistry(),
    store: undefined as never,
    clearInFlightPrompt: () => {},
    registerActiveRun: () => {},
    unregisterActiveRun: () => {},
    isSuperseded: () => false,
    noteNetworkFailure: () => 0,
    clearNetworkStreak: () => {},
    dropFailoverBudget: () => {},
    clearRateLimitFailover: () => {},
    sharesSingleEgress: () => false,
    lastAccountSpawnTime: new Map(),
    minSpawnIntervalMs: 0,
    ...overrides,
  }
}

/** Run one attempt with MOCK_ACP_MODE exported for the spawned mock. */
async function runWithMode(
  pool: AcpSessionPool,
  deps: AttemptDeps,
  input: AttemptInput,
  mode: string,
): Promise<Awaited<ReturnType<typeof runAcpAttempt>>> {
  const saved = process.env.MOCK_ACP_MODE
  process.env.MOCK_ACP_MODE = mode
  try {
    return await runAcpAttempt(pool, deps, input, slot())
  } finally {
    if (saved === undefined) delete process.env.MOCK_ACP_MODE
    else process.env.MOCK_ACP_MODE = saved
  }
}

function attemptInput(dir: string, overrides: Partial<AttemptInput> = {}): AttemptInput {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as unknown as Message]
  return {
    cfg: { ...defaultConfig(), transport: 'acp', permissionMode: 'auto' },
    bin: FIXTURE,
    permissionMode: 'auto',
    sessionKey: 'sess-hard',
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
    sessionAccountKey: 'sess-hard',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
    ...overrides,
  }
}

const slot = (): AttemptSlot => ({ releaseOnce: () => {}, armHandoff: () => null })

function meAccount(): never {
  return { id: 'acc-me', alias: 'me', email: 'me@example.com', enabled: true, createdAt: 1, cooldowns: {}, quotas: {} } as never
}

// ---- background signal extraction ------------------------------------------

test('ACP tool calls are background work by raw status, not the CLI RUNNING flag', () => {
  const rec = new RunRecording()
  rec.append({ kind: 'step', stepKey: 'tc-live', stepKind: 'tool', state: 'ACTIVE', rawStatus: 'in_progress', text: '', tool: { name: 'run_command', args: { CommandLine: 'npm run dev' } } })
  rec.append({ kind: 'step', stepKey: 'tc-done', stepKind: 'tool', state: 'ACTIVE', rawStatus: 'in_progress', text: '', tool: { name: 'run_command', args: { CommandLine: 'npm run build' } } })
  rec.append({ kind: 'step', stepKey: 'tc-done', stepKind: 'tool', state: 'DONE', rawStatus: 'completed', text: 'done', tool: { name: 'run_command', args: { CommandLine: 'npm run build' } } })
  rec.append({ kind: 'step', stepKey: 'tc-sub', stepKind: 'tool', state: 'ACTIVE', rawStatus: 'pending', text: '', tool: { name: 'invoke_subagent', args: { Role: 'reviewer' } } })

  const signals = extractAttemptBackgroundSignals(rec)
  const keys = signals.backgroundTools.map((t) => t.stepKey).sort()
  assert.deepEqual(keys, ['tc-live', 'tc-sub'])
  const live = signals.backgroundTools.find((t) => t.stepKey === 'tc-live')
  assert.equal(live?.toolName, 'run_command')
  assert.equal(live?.summary, 'npm run dev')
})

test('a completed ACP tool call is never reported as background work', () => {
  const rec = new RunRecording()
  rec.append({ kind: 'step', stepKey: 'tc-1', stepKind: 'tool', state: 'ACTIVE', rawStatus: 'in_progress', text: '', tool: { name: 'run_command', args: { CommandLine: 'ls' } } })
  rec.append({ kind: 'step', stepKey: 'tc-1', stepKind: 'tool', state: 'DONE', rawStatus: 'completed', text: 'ok', tool: { name: 'run_command', args: { CommandLine: 'ls' } } })
  assert.equal(extractAttemptBackgroundSignals(rec).backgroundTools.length, 0)
})

test('a tool call with no terminal status stays live and is watched', () => {
  const rec = new RunRecording()
  rec.append({ kind: 'step', stepKey: 'tc-plain', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { CommandLine: 'ping' } } })
  assert.equal(extractAttemptBackgroundSignals(rec).backgroundTools.length, 1)
})

// ---- pool draining ---------------------------------------------------------

function stubProc(sessions: string[] = []) {
  const open = new Set(sessions)
  const listeners = new Map<string, Array<() => void>>()
  const stub = {
    closed: false,
    alive: true,
    lastUsedAt: 1,
    get sessionCount() { return open.size },
    isAlive() { return stub.alive },
    hasOpenSession: (sid: string) => open.has(sid),
    close() { stub.closed = true; stub.alive = false },
    /** The pool closes a live process gracefully: stub an instant exit. */
    closeGracefully() {
      stub.closed = true
      stub.alive = false
      return Promise.resolve()
    },
    once(ev: string, cb: () => void) {
      const list = listeners.get(ev) ?? []
      list.push(cb)
      listeners.set(ev, list)
    },
  }
  return stub
}

test('pool capacity eviction drains a retained process instead of killing its background work', () => {
  const procs: Array<ReturnType<typeof stubProc>> = []
  const closed: Array<{ sessions: readonly string[]; expired: boolean }> = []
  const pool = new AcpSessionPool({
    bin: () => FIXTURE,
    cfg: () => defaultConfig(),
    maxProcesses: 1,
    createProcess: () => {
      const p = stubProc(['acp-bg-1'])
      procs.push(p)
      return p as never
    },
    onDrainClosed: (info) => { closed.push({ sessions: info.sessions, expired: info.expired }) },
  })
  try {
    const first = pool.acquireProcess({ bin: 'agy', cwd: process.cwd(), accountId: 'a1', mode: 'auto', sandbox: false, agent: '' })
    const release = pool.retainSession('acp-bg-1')
    assert.ok(first.isAlive())

    pool.acquireProcess({ bin: 'agy', cwd: process.cwd(), accountId: 'a1', mode: 'skip', sandbox: false, agent: '' })
    assert.equal(procs[0]!.closed, false, 'a retained process must survive capacity pressure')
    assert.equal(pool.status().drainingProcesses, 1)
    assert.equal(pool.status().activeProcesses, 1)

    release()
    assert.equal(procs[0]!.closed, true)
    assert.equal(closed.length, 1)
    assert.deepEqual(closed[0]!.sessions, ['acp-bg-1'])
    assert.equal(closed[0]!.expired, false)
    assert.equal(pool.status().drainingProcesses, 0)
  } finally {
    pool.dispose()
  }
})

test('account switch drains retained processes and reports the expiry to the session', () => {
  const procs: Array<ReturnType<typeof stubProc>> = []
  const expired: Array<{ sessions: readonly string[]; reason: string }> = []
  const pool = new AcpSessionPool({
    bin: () => FIXTURE,
    cfg: () => ({ ...defaultConfig(), backgroundWakeupTtlMinutes: 1 }),
    createProcess: () => {
      const p = stubProc(['acp-old'])
      procs.push(p)
      return p as never
    },
    onDrainExpired: (info) => { expired.push({ sessions: info.sessions, reason: info.reason }) },
  })
  try {
    pool.acquireProcess({ bin: 'agy', cwd: process.cwd(), accountId: 'a1', mode: 'auto', sandbox: false, agent: '' })
    pool.retainSession('acp-old')
    assert.equal(pool.evictOtherAccounts('a2'), 1)
    assert.equal(procs[0]!.closed, false, 'the old account keeps running its background work')
    assert.equal(pool.status().drainingProcesses, 1)

    assert.equal(pool.evictIdle(Date.now() + 10 * 60_000), 1)
    assert.equal(procs[0]!.closed, true)
    assert.equal(expired.length, 1)
    assert.deepEqual(expired[0]!.sessions, ['acp-old'])
    assert.equal(expired[0]!.reason, 'account-switch')
  } finally {
    pool.dispose()
  }
})

test('pool status exposes drain and credential-slot guard counters', () => {
  const pool = new AcpSessionPool({ bin: () => FIXTURE, cfg: () => defaultConfig() })
  try {
    const status = pool.status()
    assert.equal(status.drainingProcesses, 0)
    assert.ok(Array.isArray(status.drainingKeys))
    assert.equal(typeof status.slotOverwriteDetectedCount, 'number')
    assert.ok(status.lastSlotRecoveryAt === null || typeof status.lastSlotRecoveryAt === 'number')
    pool.noteSlotOverwrite()
    pool.noteSlotRecovery(1_700_000_000_000)
    assert.ok(pool.status().slotOverwriteDetectedCount >= 1)
    assert.ok((pool.status().lastSlotRecoveryAt ?? 0) >= 1_700_000_000_000)
  } finally {
    pool.dispose()
  }
})

// ---- scheme A --------------------------------------------------------------

function acpWatcher(opts: {
  present?: (sessionId: string, text: string) => Promise<boolean>
  armedGoal?: boolean
}) {
  const followups: string[] = []
  const presented: string[] = []
  let listener: (u: Record<string, unknown>) => void = () => {}
  // Wakeup is opt-in: these tests exercise it, so they turn it on explicitly.
  const cfg = { ...defaultConfig(), transport: 'acp' as const, backgroundWakeup: true }
  const proc = {
    isAlive: () => true,
    lastUsedAt: 0,
    hasOpenSession: () => true,
    subscribeSession: (_sid: string, cb: (u: Record<string, unknown>) => void) => {
      listener = cb
      return () => { listener = () => {} }
    },
  }
  const watcher = new BackgroundWakeWatcher({
    getConfig: () => cfg,
    coalesceMs: 20,
    acpReportSilenceMs: 60,
    acpReportUsageGraceMs: 60,
    // Longer than the report silence window, exactly like the shipped defaults
    // (2.2s grace vs 700ms silence): the report must win the race.
    acpToolGraceMs: 150,
    resolveAgent: async () => ({
      status: 'idle',
      inbox: { nextTurn: [] },
      followup: (m) => followups.push((m.content[0] as { text?: string })?.text ?? ''),
    }),
    ...(opts.present === undefined ? {} : {
      presentAcpReport: async (sid: string, text: string) => {
        const ok = await opts.present!(sid, text)
        if (ok) presented.push(text)
        return ok
      },
    }),
    ...(opts.armedGoal === undefined ? {} : { hasArmedGoal: () => opts.armedGoal! }),
  })
  const rec = new RunRecording()
  rec.append({ kind: 'step', stepKey: 'acp-bg', stepKind: 'tool', state: 'ACTIVE', rawStatus: 'in_progress', text: '', tool: { name: 'run_command', args: { CommandLine: 'npm run dev' } } })
  rec.settle(null)
  watcher.onAttemptSettled({
    sessionKey: 'sess-scheme-a',
    conversationId: 'acp-sid',
    transport: 'acp',
    recording: rec,
    failure: null,
    superseded: false,
    acpProcess: proc as never,
    acpSessionId: 'acp-sid',
  })
  return { watcher, listener: () => listener, followups, presented }
}

test('scheme A merges a multi-chunk ACP report into one direct presentation', async () => {
  const h = acpWatcher({ present: async () => true })
  try {
    for (const chunk of ['BG_DONE', ' — build', ' finished', ' cleanly']) {
      h.listener()({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
      await new Promise((r) => setTimeout(r, 15))
    }
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(h.presented.length, 1, 'four chunks must collapse into one presentation')
    assert.equal(h.presented[0], 'BG_DONE — build finished cleanly')
    assert.equal(h.followups.length, 0, 'a directly presented report must not spend a model turn')
    assert.equal(h.watcher.status().directPresentations, 1)
    assert.equal(h.watcher.status().followupWakes, 0)
  } finally {
    h.watcher.dispose()
  }
})

test('an armed goal still gets a real turn so the goal can advance', async () => {
  const h = acpWatcher({ present: async () => true, armedGoal: true })
  try {
    h.listener()({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'SCHEDULE_FIRED' } })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(h.presented.length, 0, 'an armed goal must not be satisfied by a passive record')
    assert.equal(h.followups.length, 1)
    assert.ok(h.followups[0]?.includes('SCHEDULE_FIRED'))
    assert.equal(h.watcher.status().followupWakes, 1)
  } finally {
    h.watcher.dispose()
  }
})

test('a host that cannot write the transcript degrades to exactly one followup', async () => {
  const h = acpWatcher({ present: async () => false })
  try {
    for (const chunk of ['A', 'B', 'C']) {
      h.listener()({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
      await new Promise((r) => setTimeout(r, 15))
    }
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(h.followups.length, 1, 'never one wake per chunk')
    assert.ok(h.followups[0]?.includes('ABC'))
    assert.equal(h.watcher.status().directPresentations, 0)
  } finally {
    h.watcher.dispose()
  }
})

test('a post-turn tool completion waits out the report grace window instead of racing it', async () => {
  const h = acpWatcher({ present: async () => true })
  try {
    h.listener()({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', title: 'dev server', status: 'completed' })
    await new Promise((r) => setTimeout(r, 15))
    h.listener()({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'dev server is up' } })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(h.presented.length, 1)
    assert.equal(h.presented[0], 'dev server is up')
    assert.equal(h.followups.length, 0)
  } finally {
    h.watcher.dispose()
  }
})

test('a pure timer keeps the ACP session retained even with no background tool', async () => {
  const cfg = { ...defaultConfig(), transport: 'acp' as const, backgroundWakeup: true }
  const proc = { isAlive: () => true, lastUsedAt: 0, hasOpenSession: (sid: string) => sid === 'acp-timer', subscribeSession: () => () => {} }
  let retained = 0
  const watcher = new BackgroundWakeWatcher({
    getConfig: () => cfg,
    resolveAgent: async () => ({ status: 'idle', inbox: { nextTurn: [] }, followup: () => {} }),
    retainAcpSession: () => { retained++; return () => {} },
  })
  try {
    const rec = new RunRecording()
    rec.append({ kind: 'step', stepKey: 'step-sched', stepKind: 'tool', state: 'RUNNING', text: '', tool: { name: 'schedule', args: { DurationSeconds: 600, Prompt: 'check build' } } })
    rec.settle(null)
    watcher.onAttemptSettled({
      sessionKey: 'sess-timer',
      conversationId: 'acp-timer',
      transport: 'acp',
      recording: rec,
      failure: null,
      superseded: false,
      acpProcess: proc as never,
      acpSessionId: 'acp-timer',
    })
    assert.equal(retained, 1, 'a pending one-shot timer must retain the ACP session')
  } finally {
    watcher.dispose()
  }
})

test('a wake from one background task must not drop the watch while others are still running', async () => {
  const h = acpWatcher({ present: async () => true })
  try {
    // A post-turn tool completion wakes the session first; the background tool
    // call itself is still outstanding, so the watch has to survive that wake.
    h.listener()({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-done', title: 'timer', status: 'completed' })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(h.followups.length, 1, 'the first completion wakes once')
    assert.equal(h.watcher.status().activeWatches, 1, 'a still-running task keeps the ACP watch attached')
    assert.ok((h.watcher.status().pendingAcpTools ?? 0) >= 1)

    // The late report from the still-running task must still arrive.
    h.listener()({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BG_DONE' } })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(h.presented.length, 1, 'the later report is still delivered: ' + JSON.stringify(h.watcher.status()))
    assert.equal(h.presented[0], 'BG_DONE')
  } finally {
    h.watcher.dispose()
  }
})

// ---- session rebuild / empty turns / identity gate -------------------------

test('a session/load that replays nothing is treated as lost and rebuilt with history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-reset-'))
  const notices: Array<{ kind: string; text: string }> = []
  const logs: string[] = []
  const store = new SessionStore(join(dir, 'sessions.json'))
  try {
    const deps = attemptDeps({
      store,
      log: (m: string) => logs.push(m),
      appendAcpNotice: (_k, notice) => notices.push(notice),
    })
    const input = attemptInput(dir, {
      binding: { conversationId: 'gone-cid', lastMessageCount: 0 } as never,
    })
    const pool = new AcpSessionPool({ bin: () => FIXTURE, cfg: () => input.cfg })
    try {
      const rec = await runWithMode(pool, deps, input, 'chat')
      assert.ok(rec !== null)
      await waitSettled(rec)
      assert.equal(notices.length, 1, 'the user must be told the session was rebuilt')
      assert.equal(notices[0]!.kind, 'acp-reset')
      assert.ok(notices[0]!.text.includes('原常驻会话已重置'))
      assert.ok(logs.some((m) => m.includes('could not be restored')), 'the reason must be logged')
      // Regression for the stale-binding bug: the NEW conversation id is persisted.
      assert.equal(store.get('sess-hard')?.conversationId, 'sess-new')
    } finally {
      pool.dispose()
    }
  } finally {
    await cleanupDir(dir)
  }
})

test('an empty ACP turn is classified from the per-process log slice, not as success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-proxy-'))
  const logs: string[] = []
  try {
    const deps = attemptDeps({ store: new SessionStore(join(dir, 'sessions.json')), log: (m: string) => logs.push(m) })
    const input = attemptInput(dir)
    const pool = new AcpSessionPool({ bin: () => FIXTURE, cfg: () => input.cfg })
    let rec: unknown
    try {
      rec = await runWithMode(pool, deps, input, 'empty-proxy')
    } finally {
      pool.dispose()
    }
    assert.equal(rec, null, 'an empty turn must fall back to the CLI, never settle as a success')
    assert.ok(logs.some((m) => m.includes('acp turn produced no output (NETWORK)')), 'the proxy failure comes from the acp log: ' + logs.join(' | '))
  } finally {
    await cleanupDir(dir)
  }
})

test('an empty ACP turn caused by auth failure is classified as AUTH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-auth-'))
  const logs: string[] = []
  try {
    const deps = attemptDeps({ store: new SessionStore(join(dir, 'sessions.json')), log: (m: string) => logs.push(m) })
    const input = attemptInput(dir)
    const pool = new AcpSessionPool({ bin: () => FIXTURE, cfg: () => input.cfg })
    let rec: unknown
    try {
      rec = await runWithMode(pool, deps, input, 'empty-auth')
    } finally {
      pool.dispose()
    }
    // AUTH is not transport-specific: re-running on the CLI would use the same
    // bad credential, so the turn settles with an actionable AUTH failure.
    assert.ok(rec !== null, 'auth failure must settle instead of retrying over CLI')
    await waitSettled(rec as RunRecording)
    assert.equal((rec as RunRecording).failureInfo?.code, 'AUTH')
    assert.equal(logs.some((m) => m.includes('retrying over CLI')), false, logs.join(' | '))
  } finally {
    await cleanupDir(dir)
  }
})

test('agy own failure banner is never mistaken for a model answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-banner-'))
  const logs: string[] = []
  try {
    const deps = attemptDeps({ store: new SessionStore(join(dir, 'sessions.json')), log: (m: string) => logs.push(m) })
    const input = attemptInput(dir)
    const pool = new AcpSessionPool({ bin: () => FIXTURE, cfg: () => input.cfg })
    let rec: unknown
    try {
      rec = await runWithMode(pool, deps, input, 'banner')
    } finally {
      pool.dispose()
    }
    // agy answers "failed to construct executor" as a normal end_turn, so only
    // the banner check keeps a dead proxy from settling as a green turn.
    assert.equal(rec, null, 'a banner-only turn must fall back to the CLI, never settle as success')
    assert.ok(logs.some((m) => m.includes('acp turn produced no output (NETWORK)')), logs.join(' | '))
  } finally {
    await cleanupDir(dir)
  }
})

function identityPool(dir: string, emails: string[], created: string[]) {
  let i = 0
  return new AcpSessionPool({
    bin: () => FIXTURE,
    cfg: () => defaultConfig(),
    createProcess: (opts) => {
      const logFile = join(dir, `auth-${i}.log`)
      writeFileSync(logFile, '', 'utf8')
      created.push(logFile)
      const email = emails[Math.min(i, emails.length - 1)]!
      i++
      return new AcpProcess({ ...opts, logFile, env: { ...opts.env, MOCK_ACP_EMAIL: email } })
    },
  })
}

test('a wrong identity in the acp log reinstalls the slot once and then succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-gate2-'))
  const created: string[] = []
  let reinstalls = 0
  try {
    const deps = attemptDeps({
      store: new SessionStore(join(dir, 'sessions.json')),
      reinstallCredentialSlot: () => { reinstalls++; return true },
    })
    const input = attemptInput(dir, { account: meAccount() })
    const pool = identityPool(dir, ['other@example.com', 'me@example.com'], created)
    try {
      const rec = await runWithMode(pool, deps, input, 'chat')
      assert.ok(rec !== null, 'the retry after a slot reinstall must succeed')
      await waitSettled(rec)
      assert.equal(reinstalls, 1)
      assert.equal(created.length, 2, 'the mismatched process must be replaced, not reused')
    } finally {
      pool.dispose()
    }
  } finally {
    await cleanupDir(dir)
  }
})

test('a second identity mismatch refuses the turn instead of billing the wrong account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-gate2-bad-'))
  const created: string[] = []
  const logs: string[] = []
  let reinstalls = 0
  try {
    const deps = attemptDeps({
      store: new SessionStore(join(dir, 'sessions.json')),
      log: (m: string) => logs.push(m),
      reinstallCredentialSlot: () => { reinstalls++; return true },
    })
    const input = attemptInput(dir, { account: meAccount() })
    const pool = identityPool(dir, ['other@example.com'], created)
    try {
      const rec = await runWithMode(pool, deps, input, 'chat')
      assert.ok(rec !== null, 'a refused turn still settles (with an error)')
      await waitSettled(rec as RunRecording)
      assert.equal((rec as RunRecording).failureInfo?.code, 'AUTH', 'never answer on the wrong account')
      assert.equal(reinstalls, 1, 'exactly one self-heal attempt')
      assert.ok(logs.some((m) => m.includes('refusing to run on the wrong account')), logs.join(' | '))
    } finally {
      pool.dispose()
    }
  } finally {
    await cleanupDir(dir)
  }
})
// ---- warm process reuse / crash recovery (reviewer's third request) --------

/** All assistant text a recording streamed, in order. */
function textOf(rec: { length: number; eventAt(i: number): unknown }): string {
  let out = ''
  for (let i = 0; i < rec.length; i++) {
    const ev = rec.eventAt(i) as { kind?: string; stepKind?: string; text?: string } | undefined
    if (ev?.kind === 'step' && ev.stepKind === 'text' && typeof ev.text === 'string') out += ev.text
  }
  return out
}

test('a second turn on the same session reuses the warm process and restores nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-two-turns-'))
  const created: AcpProcess[] = []
  const notices: Array<{ kind: string }> = []
  const logs: string[] = []
  const store = new SessionStore(join(dir, 'sessions.json'))
  try {
    const deps = attemptDeps({
      store,
      log: (m: string) => logs.push(m),
      appendAcpNotice: (_k, notice) => notices.push(notice),
    })
    const pool = new AcpSessionPool({
      bin: () => FIXTURE,
      cfg: () => attemptInput(dir).cfg,
      createProcess: (opts) => {
        const proc = new AcpProcess(opts)
        created.push(proc)
        return proc
      },
    })
    try {
      const first = await runWithMode(pool, deps, attemptInput(dir), 'chat')
      assert.ok(first !== null)
      await waitSettled(first)
      assert.equal(textOf(first), 'ok')
      const binding = store.get('sess-hard')
      assert.equal(binding?.conversationId, 'sess-new', 'the first turn must persist its session id')

      // Second turn: same session, same account. The process is warm and the
      // session id is already open on it, so NOTHING may be restored — a
      // session/load here would replay the whole conversation into the new turn.
      const second = await runWithMode(pool, deps, attemptInput(dir, { binding: binding as never }), 'chat')
      assert.ok(second !== null, 'the second turn must run')
      await waitSettled(second)
      assert.equal(textOf(second), 'ok', 'only this turn own answer may appear')
      assert.equal(created.length, 1, 'the warm process is reused, not respawned')
      assert.equal(notices.length, 0, 'a cached session must not be reported as lost: ' + JSON.stringify(notices))
      assert.ok(!logs.some((m) => m.includes('could not be restored')), logs.join(' | '))
      assert.equal(store.get('sess-hard')?.conversationId, 'sess-new', 'the binding still points at the live session')
    } finally {
      pool.dispose()
    }
  } finally {
    await cleanupDir(dir)
  }
})

test('a killed ACP process is recovered on the next turn by rebuilding with history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-killed-'))
  const created: AcpProcess[] = []
  const notices: Array<{ kind: string }> = []
  const logs: string[] = []
  const store = new SessionStore(join(dir, 'sessions.json'))
  try {
    const deps = attemptDeps({
      store,
      log: (m: string) => logs.push(m),
      appendAcpNotice: (_k, notice) => notices.push(notice),
    })
    const pool = new AcpSessionPool({
      bin: () => FIXTURE,
      cfg: () => attemptInput(dir).cfg,
      createProcess: (opts) => {
        const proc = new AcpProcess(opts)
        created.push(proc)
        return proc
      },
    })
    try {
      const first = await runWithMode(pool, deps, attemptInput(dir), 'chat')
      assert.ok(first !== null)
      await waitSettled(first)
      const binding = store.get('sess-hard')
      assert.equal(binding?.conversationId, 'sess-new')

      // Kill the child the way a crash would: the pool keeps no live process,
      // and agy no longer knows the session it was told about.
      const victim = created[0]!
      victim.close()
      const deadline = Date.now() + 5_000
      while (victim.isAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      assert.equal(victim.isAlive(), false, 'the killed process must be gone')

      const second = await runWithMode(pool, deps, attemptInput(dir, { binding: binding as never }), 'chat')
      assert.ok(second !== null, 'the next turn must still run after the crash')
      await waitSettled(second)
      assert.equal(textOf(second), 'ok')
      assert.equal(created.length, 2, 'a dead process is replaced, not reused')
      assert.equal(notices.length, 1, 'the user must be told the session was rebuilt')
      assert.equal(notices[0]!.kind, 'acp-reset')
      assert.ok(logs.some((m) => m.includes('could not be restored')), logs.join(' | '))
    } finally {
      pool.dispose()
    }
  } finally {
    await cleanupDir(dir)
  }
})

test('the wakeup switch alone decides retention: transport=acp with wakeup off keeps nothing', () => {
  const cfg = { ...defaultConfig(), transport: 'acp' as const, backgroundWakeup: false }
  let subscribed = 0
  let retained = 0
  const proc = {
    isAlive: () => true,
    lastUsedAt: 0,
    hasOpenSession: () => true,
    subscribeSession: () => { subscribed++; return () => {} },
  }
  const watcher = new BackgroundWakeWatcher({
    getConfig: () => cfg,
    resolveAgent: async () => ({ status: 'idle', inbox: { nextTurn: [] }, followup: () => {} }),
    retainAcpSession: () => { retained++; return () => {} },
  })
  try {
    const rec = new RunRecording()
    rec.append({ kind: 'step', stepKey: 'tc-live', stepKind: 'tool', state: 'ACTIVE', rawStatus: 'in_progress', text: '', tool: { name: 'run_command', args: { CommandLine: 'npm run dev' } } })
    rec.settle(null)
    watcher.onAttemptSettled({
      sessionKey: 'sess-two-switches',
      conversationId: 'acp-two',
      transport: 'acp',
      recording: rec,
      failure: null,
      superseded: false,
      acpProcess: proc as never,
      acpSessionId: 'acp-two',
    })
    assert.equal(subscribed, 0, 'wakeup off must not subscribe to post-turn updates')
    assert.equal(retained, 0, 'wakeup off must not retain the ACP session')
    assert.equal(watcher.status().activeWatches, 0)
  } finally {
    watcher.dispose()
  }
})
