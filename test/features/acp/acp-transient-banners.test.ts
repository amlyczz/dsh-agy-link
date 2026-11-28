// Regression coverage for transient 401/503/504 ACP status banner interception
// and clean empty-stderr exit diagnostics.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err } from '../../../src/common/types.ts'
import { AcpProcess, AcpSessionPool, runAcpAttempt } from '../../../src/features/acp/index.ts'
import { failureBannerAfter, isAgyFailureBanner } from '../../../src/features/acp/settle.ts'
import { buildPromptFailure } from '../../../src/features/acp/prompt-failure.ts'
import { RunRecording, RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../../../src/provider/attempt.ts'

async function waitSettled(rec: { isSettled?: boolean }, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (rec.isSettled !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15))
  }
}

function makeDeps(store: SessionStore, overrides: Partial<AttemptDeps> = {}): AttemptDeps {
  return {
    acquire: async () => () => {},
    runs: new RunRegistry(),
    store,
    clearInFlightPrompt: () => {},
    registerActiveRun: () => {},
    unregisterActiveRun: () => {},
    isSuperseded: () => false,
    noteNetworkFailure: () => 1,
    clearNetworkStreak: () => {},
    dropFailoverBudget: () => {},
    clearRateLimitFailover: () => {},
    sharesSingleEgress: () => false,
    lastAccountSpawnTime: new Map(),
    minSpawnIntervalMs: 0,
    ...overrides,
  }
}

function makeInput(dir: string, overrides: Partial<AttemptInput> = {}): AttemptInput {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'check status' }] } as unknown as Message]
  return {
    cfg: { ...defaultConfig(), transport: 'acp', permissionMode: 'skip' },
    bin: 'agy',
    permissionMode: 'skip',
    sessionKey: 'sess-banner',
    workspaceRoot: dir,
    isAux: false,
    account: undefined,
    prompt: 'check status',
    model: 'gemini-3.8-flash',
    activeModel: 'gemini-3.8-flash',
    effort: '',
    addDirs: [],
    persistBinding: false,
    binding: undefined,
    messages,
    newlySentImageIds: [],
    sessionAccountKey: 'sess-banner',
    family: 'google',
    signal: undefined,
    agyOnEvent: undefined,
    sandbox: false,
    agent: '',
    ...overrides,
  }
}

function makeSlot(): AttemptSlot {
  return {
    releaseOnce: () => {},
    armHandoff: () => ({ onFirstEvent: () => {}, dispose: () => {}, released: () => false, timedOut: () => false }),
  }
}

function makeFakeProc(
  updates: ReadonlyArray<Record<string, unknown>>,
  result: Record<string, unknown> = { stopReason: 'end_turn' },
): AcpProcess & { closed: boolean } {
  const ee = new EventEmitter() as unknown as AcpProcess & { closed: boolean }
  let alive = true
  ee.closed = false
  Object.assign(ee, {
    lastUsedAt: Date.now(),
    logFilePath: null,
    supportsImageBlocks: false,
    sessionCount: 1,
    isBusy: false,
    advertisedCommands: [],
    isAlive: () => alive,
    hasActivePrompt: () => false,
    hasOpenSession: () => true,
    stderrOffset: () => 0,
    readStderrSince: () => '',
    cancelSession: () => {},
    openSession: async () => ({ sessionId: 'sid-banner', status: 'created' as const, resumeFailed: false }),
    prompt: async (opts: { onUpdate?: (u: Record<string, unknown>) => void }) => {
      for (const u of updates) opts.onUpdate?.(u)
      return result
    },
    close: () => {
      alive = false
      ee.closed = true
    },
    closeGracefully: async () => {
      alive = false
      ee.closed = true
    },
  })
  return ee
}

test('isAgyFailureBanner recognises 401/503/504 transient status banners without false positives', () => {
  assert.equal(isAgyFailureBanner('⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.'), true)
  assert.equal(isAgyFailureBanner('⚠️ UNAVAILABLE (code 503): The service is currently unavailable.'), true)
  assert.equal(isAgyFailureBanner('⚠ DEADLINE_EXCEEDED (code 504): Gateway Timeout'), true)
  assert.equal(isAgyFailureBanner('⚠ failed to construct the executor: proxyconnect tcp'), true)
  // Normal assistant prose carrying a warning symbol must NOT be intercepted.
  assert.equal(isAgyFailureBanner('⚠ 端口 8080 已被占用，请先停掉旧服务。'), false)
  // Longer multi-line answers that happen to mention a status code must NOT match.
  assert.equal(
    isAgyFailureBanner('Line 1\nLine 2\n⚠ UNAVAILABLE (code 503): example in docs'),
    false,
  )
})

test('banner-only transient 401/503/504 turn discards the ACP process and retries over CLI', async () => {
  const cases = [
    '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.',
    '⚠ UNAVAILABLE (code 503): The service is currently unavailable.',
    '⚠ DEADLINE_EXCEEDED (code 504): Gateway Timeout',
  ]
  for (const banner of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'agy-acp-banner-only-'))
    try {
      const store = new SessionStore(join(dir, 'sessions.json'))
      const logs: string[] = []
      let proc!: AcpProcess & { closed: boolean }
      const pool = new AcpSessionPool({
        bin: () => 'agy',
        cfg: () => defaultConfig(),
        createProcess: () => {
          proc = makeFakeProc([
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: banner } },
          ])
          return proc
        },
      })
      try {
        const rec = await runAcpAttempt(pool, makeDeps(store, { log: (m) => logs.push(m) }), makeInput(dir), makeSlot())
        assert.equal(rec, null, `banner-only turn should fall back to CLI: ${banner}`)
        assert.equal(proc.closed, true, `broken ACP process must be discarded: ${banner}`)
        assert.ok(logs.some((m) => m.includes('retrying over CLI -p')), logs.join(' | '))
      } finally {
        pool.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('trailing 401/503/504 banner after tool calls fails cleanly without leaking prose or quarantining AUTH', async () => {
  const cases: Array<{ banner: string; expectedCode: string }> = [
    { banner: '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials.', expectedCode: Err.PROCESS_EXIT },
    { banner: '⚠ UNAVAILABLE (code 503): The service is currently unavailable.', expectedCode: Err.PROCESS_EXIT },
    { banner: '⚠ DEADLINE_EXCEEDED (code 504): Gateway Timeout', expectedCode: Err.NETWORK },
  ]
  for (const { banner, expectedCode } of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'agy-acp-mid-banner-'))
    try {
      const store = new SessionStore(join(dir, 'sessions.json'))
      const pool = new AcpSessionPool({
        bin: () => 'agy',
        cfg: () => defaultConfig(),
        createProcess: () =>
          makeFakeProc([
            { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'read_file', status: 'in_progress', rawInput: { path: 'a.ts' } },
            { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', name: 'read_file', status: 'completed', rawOutput: 'ok' },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: banner } },
          ]),
      })
      try {
        const rec = await runAcpAttempt(pool, makeDeps(store), makeInput(dir), makeSlot())
        assert.ok(rec !== null, 'mid-turn failure after tools should settle instead of silently replaying')
        await waitSettled(rec)
        assert.equal(rec.failureInfo?.code, expectedCode, `unexpected code for ${banner}: ${rec.failureInfo?.message}`)
        assert.ok(rec.failureInfo?.message.includes(banner), `failure message must retain banner: ${rec.failureInfo?.message}`)
        assert.notEqual(rec.failureInfo?.code, Err.AUTH, 'transient banner must not trigger AUTH quarantine')
        const recordedTexts: string[] = []
        for (let i = 0; i < rec.length; i++) {
          const ev = rec.eventAt(i)
          if (ev?.kind === 'step' && ev.stepKind === 'text') recordedTexts.push(ev.text)
        }
        assert.equal(recordedTexts.some((t) => t.includes(banner)), false, 'raw error banner must not leak into recorded assistant prose')
      } finally {
        pool.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a transient banner split across two chunks is one banner, never a green reply', async () => {
  // agy may stream the banner in pieces; the second piece alone is plain prose
  // and used to settle the turn green with "…currently unavailable." as the reply.
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-banner-split-'))
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const logs: string[] = []
    let proc!: AcpProcess & { closed: boolean }
    const pool = new AcpSessionPool({
      bin: () => 'agy',
      cfg: () => defaultConfig(),
      createProcess: () => {
        proc = makeFakeProc([
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ UNAVAILABLE (code 503): The service is' } },
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' currently unavailable.' } },
        ])
        return proc
      },
    })
    try {
      const rec = await runAcpAttempt(pool, makeDeps(store, { log: (m) => logs.push(m) }), makeInput(dir), makeSlot())
      assert.equal(rec, null, 'a split banner-only turn must fall back to CLI')
      assert.equal(proc.closed, true, 'the broken ACP process must be discarded')
    } finally {
      pool.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failureBannerAfter: a chunk starts a banner, continues one, or is not banner text', () => {
  const head = '⚠ UNAVAILABLE (code 503): The service is'
  assert.equal(failureBannerAfter(null, head), head)
  // Continuation: the whole is still at most two lines starting with the status glyph.
  assert.equal(failureBannerAfter(head, ' currently unavailable.'), head + '\ncurrently unavailable.')
  // Within one turn text after an upstream error is part of that error, but a
  // banner is never more than two lines: a third piece is not absorbed.
  assert.equal(failureBannerAfter(head + '\nline two.', ' a third line'), null)
  // Prose that merely mentions the status is not a banner.
  assert.equal(failureBannerAfter(null, 'The proxy returned UNAVAILABLE (code 503) upstream; retrying.'), null)
  // Plain prose with no banner before it is not a banner.
  assert.equal(failureBannerAfter(null, 'All good, here is the summary.'), null)
})

test('buildPromptFailure preserves empty-stderr exit cause and deduplicates repeated error fragments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-pf-'))
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const deps = makeDeps(store)
    const input = makeInput(dir)
    const rec = new RunRecording()

    // Empty stderr: msg must populate outcome.stderrTail so rate-limit detail is preserved.
    const rateLimitRes = buildPromptFailure({
      cfg: input.cfg,
      deps,
      input,
      rec,
      err: new Error('RESOURCE_EXHAUSTED: quota exhausted on this bucket'),
      stderrText: '',
      logText: '',
      quotaFailover: null,
      quotaCancelled: false,
      emittedAny: false,
      sawRealOutput: false,
      cooledInLiveFamilies: new Set(),
      startedAt: Date.now() - 50,
    })
    assert.equal(rateLimitRes.failure?.code, Err.RATE_LIMIT)
    assert.ok(rateLimitRes.failure?.message.includes('RESOURCE_EXHAUSTED: quota exhausted on this bucket'))
    assert.equal(rateLimitRes.outcomeOverride?.stderrTail, 'RESOURCE_EXHAUSTED: quota exhausted on this bucket')

    // Duplicate fragment between msg and stderrText should appear only once in rawErrText.
    const dupRes = buildPromptFailure({
      cfg: input.cfg,
      deps,
      input,
      rec,
      err: new Error('agy acp exited (code=1, signal=null): proxyconnect tcp: dial tcp 127.0.0.1:7890: connection refused'),
      stderrText: 'proxyconnect tcp: dial tcp 127.0.0.1:7890: connection refused',
      logText: '',
      quotaFailover: null,
      quotaCancelled: false,
      emittedAny: false,
      sawRealOutput: false,
      cooledInLiveFamilies: new Set(),
      startedAt: Date.now() - 50,
    })
    assert.equal(dupRes.rawErrText.split('proxyconnect tcp').length - 1, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('AcpProcess exit error omits trailing colon when stderr is empty and appends tail when present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-acp-exit-msg-'))
  try {
    const quietBin = join(dir, 'exit-quiet.mjs')
    writeFileSync(quietBin, 'process.exit(0)\n', 'utf8')
    const quietProc = new AcpProcess({
      bin: quietBin,
      cwd: dir,
      permissionMode: 'skip',
      preemptAutoUpdate: false,
      logFile: join(dir, 'quiet.log'),
    })
    await assert.rejects(
      () => quietProc.ensureInitialized(),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        assert.equal(msg, 'agy acp exited (code=0, signal=null)')
        return true
      },
    )

    const noisyBin = join(dir, 'exit-noisy.mjs')
    writeFileSync(noisyBin, 'process.stderr.write("fatal startup boom\\n"); process.exit(2)\n', 'utf8')
    const noisyProc = new AcpProcess({
      bin: noisyBin,
      cwd: dir,
      permissionMode: 'skip',
      preemptAutoUpdate: false,
      logFile: join(dir, 'noisy.log'),
    })
    await assert.rejects(
      () => noisyProc.ensureInitialized(),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        assert.equal(msg, 'agy acp exited (code=2, signal=null): fatal startup boom')
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
