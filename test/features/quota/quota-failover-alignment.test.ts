import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  defaultConfig,
  Err,
  extractAgyQuotaBanner,
  extractQuotaErrorModel,
  isAgyQuotaBannerLine,
  isHardQuotaResultError,
  isNonConsumableResultError,
  isTransientBurstRateLimit,
  looksLikeHardRateLimit,
  parseResetDurationMs,
  type PluginConfig,
} from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import { isQuotaBenched } from '../../../src/common/quota-bench.ts'
import { AgyAdapter, type AgyAdapterDeps } from '../../../src/host/adapter.ts'
import { ModelCatalog } from '../../../src/host/models.ts'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { defineAgyMirrorTool, parseMirrorInvocation } from '../../../src/host/mirror-tool.ts'
import { RunRecording, RunRegistry } from '../../../src/host/recording.ts'
import { SessionStore } from '../../../src/host/sessions.ts'
import { runAgyOnce } from '../../../src/host/oneshot.ts'
import { EventMapper } from '../../../src/provider/mapper/event-mapper.ts'
import { driveSpan } from '../../../src/provider/span.ts'
import { SubagentTracker } from '../../../src/features/subagent/tracker.ts'
import { ImageService } from '../../../src/features/image/service.ts'
import { TranslationService } from '../../../src/features/translation/service.ts'
import { AcpProcess, AcpSessionPool, runAcpAttempt } from '../../../src/features/acp/index.ts'
import type { AttemptDeps, AttemptInput, AttemptSlot } from '../../../src/provider/attempt.ts'

import { FAKE_AGY } from '../../helpers/paths.ts'
const fakeBin = FAKE_AGY

function msg(role: 'user' | 'assistant' | 'system', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as unknown as Message
}

function opts(messages: Message[], extra: Partial<GenerateOptions> & Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    messages,
    ...extra,
  } as GenerateOptions
}

function makeAdapter(
  root: string,
  cfgOverrides: Partial<PluginConfig> = {},
  deps: Partial<AgyAdapterDeps> = {},
) {
  const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const store = new SessionStore(join(root, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const runs = new RunRegistry()
  const adapter = new AgyAdapter({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => fakeBin,
    acquire: () => Promise.resolve(() => {}),
    runs,
    ...deps,
  })
  return { adapter, store, runs, cfg }
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

async function runTurn(
  adapter: AgyAdapter,
  base: Message[],
  extra: Partial<GenerateOptions> & Record<string, unknown> = {},
  replayRuns?: RunRegistry,
): Promise<{ chunks: StreamChunk[]; messages: Message[] }> {
  const messages = [...base]
  const all: StreamChunk[] = []
  for (let hop = 0; hop < 12; hop++) {
    const chunks = await collect(adapter.stream(opts([...messages], extra)))
    all.push(...chunks)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } } | undefined
    if (!finish || finish.type !== 'finish') throw new Error('span ended without finish')
    if (finish.reason.kind !== 'tool-calls') return { chunks: all, messages }
    const end = chunks.find(
      (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
    ) as unknown as { block: { id: string; name: string; arguments: string } } | undefined
    if (!end) throw new Error('tool-calls finish without tool-call block')
    const parsed = end.block.name === 'run_code'
      ? parseMirrorInvocation((JSON.parse(end.block.arguments) as { code: string }).code)!
      : (JSON.parse(end.block.arguments) as { run: string; step: number })
    messages.push({ role: 'assistant', content: [end.block] } as unknown as Message)
    let output = 'replayed'
    let isError = false
    if (replayRuns) {
      try {
        output = String(await defineAgyMirrorTool({ runs: replayRuns }).execute(parsed as never, { signal: new AbortController().signal } as never))
      } catch (err) {
        isError = true
        output = String(err)
      }
    }
    messages.push({
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: end.block.id, content: [{ type: 'text', text: output }], isError }],
      source: { kind: 'tool', callId: end.block.id },
    } as unknown as Message)
  }
  throw new Error('runTurn exceeded hop budget')
}

describe('quota failover alignment across subagents, aux, and tools', () => {
  test('1. diagnostics helpers parse 429 JSON, QUOTA_EXHAUSTED, reset after, transient bursts, and model name', () => {
    const sub429 = 'Encountered error in step execution: image failed to generate: failed to generate content: 429 Too Many Requests, body: {\n  "error": {\n    "code": 429,\n    "message": "You have exhausted your capacity on this model. Your quota will reset after 4h58m46s.",\n    "status": "RESOURCE_EXHAUSTED",\n    "details": [{\n      "@type": "type.googleapis.com/google.rpc.ErrorInfo",\n      "reason": "QUOTA_EXHAUSTED",\n      "metadata": { "model": "gemini-3.1-flash-image", "quotaResetDelay": "4h58m46.438781284s" }\n    }]\n  }\n}'
    assert.equal(looksLikeHardRateLimit(sub429), true)
    assert.equal(looksLikeHardRateLimit('QUOTA_EXHAUSTED'), true)
    assert.equal(looksLikeHardRateLimit('{"code": 429}'), true)
    assert.equal(looksLikeHardRateLimit('conversation 42912345-abcd-1234 not found'), false)
    assert.equal(looksLikeHardRateLimit('the docs say rate limits apply'), false)

    const d1 = parseResetDurationMs('Your quota will reset after 4h58m46s.')
    assert.equal(d1, (4 * 3600 + 58 * 60 + 46) * 1000)
    const d2 = parseResetDurationMs('"quotaResetDelay": "4h58m46.438781284s"')
    assert.ok(d2 !== undefined && Math.abs(d2 - 17926439) <= 2, `got ${d2}`)
    assert.equal(parseResetDurationMs('Your quota will reset after 1s.'), 1000)
    assert.equal(parseResetDurationMs('Resets in 3h43m44s.'), (3 * 3600 + 43 * 60 + 44) * 1000)

    const burst1s = '429 Too Many Requests, body: { "error": { "code": 429, "message": "You have exhausted your capacity on this model. Your quota will reset after 1s.", "status": "RESOURCE_EXHAUSTED", "details": [{ "reason": "RATE_LIMIT_EXCEEDED", "metadata": { "quotaResetDelay": "1.309933519s" } }] } }'
    assert.equal(isTransientBurstRateLimit(burst1s), true)
    assert.equal(isTransientBurstRateLimit(sub429), false)
    assert.equal(isTransientBurstRateLimit('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h43m44s.'), false)

    assert.equal(extractQuotaErrorModel(sub429), 'gemini-3.1-flash-image')

    assert.equal(isNonConsumableResultError(false, 'RESOURCE_EXHAUSTED (code 429): Individual quota reached.', 'partial'), true)
    assert.equal(isNonConsumableResultError(false, 'TOS_VIOLATION', 'partial'), true)
    assert.equal(isNonConsumableResultError(false, 'Find command timed out.', 'There are 2 files.'), false)
  })

  test('2. isQuotaBenched enforces per-model exhaustion and honors quotaGateClearedAt', () => {
    const now = Date.parse('2026-11-21T14:00:00Z')
    const future = new Date(now + 3600_000).toISOString()
    const acc: ManagedAccount = {
      id: 'acc_1',
      alias: 'A1',
      dir: '/tmp/a1',
      enabled: true,
      createdAt: now - 10_000,
      cooldowns: {},
      quotas: {
        google: {
          remainingFraction: 0.8,
          resetTime: future,
          weeklyFraction: 0.9,
          weeklyResetTime: future,
          updatedAt: now - 1000,
          models: [
            { modelId: 'gemini-3.1-flash-image', remainingFraction: 0, resetTime: future },
            { modelId: 'gemini-4-neon-high', remainingFraction: 0.8, resetTime: future },
          ],
        },
      },
    }
    assert.equal(isQuotaBenched(acc, 'google', now, 'gemini-3.1-flash-image'), true)
    assert.equal(isQuotaBenched(acc, 'google', now, 'gemini-4-neon-high'), false)
    assert.equal(isQuotaBenched(acc, 'google', now), false)

    acc.quotaGateClearedAt = { google: now }
    assert.equal(isQuotaBenched(acc, 'google', now, 'gemini-3.1-flash-image'), false)
  })

  test('3. partial-response hard quota exhaustion stays non-consumable, cools down, and rotates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-partial-quota-'))
    const prevMode = process.env.FAKE_AGY_MODE
    try {
      process.env.FAKE_AGY_MODE = 'real-quota-partial'
      const mapper = new EventMapper({ runId: 'r1', cutOnTool: true })
      const chunks = [
        ...mapper.map({ kind: 'step', stepKey: '1', stepKind: 'text', text: 'partial interim text', fragment: true }, 0),
        ...mapper.map({ kind: 'result', conversationId: 'c1', ok: false, response: 'partial interim text', error: 'Individual quota reached. Resets in 3h43m38s.', usage: {}, raw: {} }, 1),
      ]
      assert.equal(mapper.isFinished, false)
      assert.equal(chunks.some((c) => c.type === 'finish'), false)

      const rec = new RunRecording('r-rec')
      rec.append({ kind: 'result', conversationId: 'c1', ok: false, response: 'partial interim text', error: 'Individual quota reached. Resets in 3h43m38s.', usage: {}, raw: {} })
      assert.equal(rec.hasConsumableResult, false)
      assert.equal(rec.hasFinishableEventFrom(0), false)

      const pool = new AccountPoolManager(join(root, 'pool'))
      const second = pool.createAccountSlot('Second')
      const primary = pool.getAccounts()[0]!
      const { adapter, runs } = makeAdapter(root, {}, { pool })
      const res = await runTurn(adapter, [msg('user', 'count files')], { sessionId: 'sess-partial' as never }, runs)
      const finish = res.chunks[res.chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
      assert.equal(finish.reason.kind, 'error')
      assert.equal(finish.reason.failure?.code, Err.RATE_LIMIT)
      const cdUntil = primary.cooldowns.google?.cooldownUntil ?? 0
      assert.ok(cdUntil - Date.now() > 3 * 3600_000, `expected >3h cooldown, got ${cdUntil - Date.now()}`)
      assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
    } finally {
      process.env.FAKE_AGY_MODE = prevMode
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('4. SubagentTracker detects subagent & parent SYSTEM_MESSAGE quota exhaustion with strict provenance and burst filtering', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-sub-tracker-q-'))
    try {
      const brainBase = join(root, '.gemini', 'antigravity-cli', 'brain')
      const mainId = 'main-conv-q'
      const subId = 'sub-conv-q'
      const mainLogDir = join(brainBase, mainId, '.system_generated', 'logs')
      const mainSubDir = join(brainBase, mainId, '.system_generated', 'subagents')
      const subLogDir = join(brainBase, subId, '.system_generated', 'logs')
      mkdirSync(mainLogDir, { recursive: true })
      mkdirSync(mainSubDir, { recursive: true })
      mkdirSync(subLogDir, { recursive: true })

      writeFileSync(
        join(mainSubDir, `${subId}.json`),
        JSON.stringify({ conversationId: subId, subagentDescriptor: { typeName: 'image-generator', role: 'Sprite Artist' }, state: 'SUBAGENT_STATE_ALIVE' }),
      )

      const subTranscript = join(subLogDir, 'transcript.jsonl')
      writeFileSync(subTranscript, '')

      const quotaHits: Array<{ source: string; model?: string; resetMs?: number; errorText: string }> = []
      const events: Array<{ text?: string }> = []
      const tracker = new SubagentTracker({
        conversationId: mainId,
        accountHome: root,
        pollIntervalMs: 5000,
        onEvent: (ev) => events.push({ ...(ev.kind === 'step' ? { text: ev.text } : {}) }),
        onQuotaExhausted: (info) => quotaHits.push(info),
      })
      tracker.start()
      // False positives first: command exit and 1s burst and DONE status must NOT fire
      writeFileSync(
        subTranscript,
        [
          JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'ERROR', content: 'Command exited with code 1\nRESOURCE_EXHAUSTED (code 429)' }),
          JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'ERROR', content: 'image failed to generate: 429 Too Many Requests {"error":{"code":429,"message":"Your quota will reset after 1s.","status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED","metadata":{"quotaResetDelay":"1.3s"}}]}}' }),
          JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'RESOURCE_EXHAUSTED (code 429)' }),
        ].join('\n') + '\n',
        { flag: 'a' },
      )
      tracker.poll()
      assert.equal(quotaHits.length, 0)

      // Real subagent QUOTA_EXHAUSTED error
      writeFileSync(
        subTranscript,
        JSON.stringify({
          step_index: 4,
          type: 'GENERIC',
          status: 'ERROR',
          content: 'Encountered error in step execution: image failed to generate: failed to generate content: 429 Too Many Requests, body: {"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 4h58m46s.","status":"RESOURCE_EXHAUSTED","details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"model":"gemini-3.1-flash-image","quotaResetDelay":"4h58m46.438s"}}]}}',
        }) + '\n',
        { flag: 'a' },
      )
      tracker.poll()
      assert.equal(quotaHits.length, 1)
      assert.equal(quotaHits[0]!.model, 'gemini-3.1-flash-image')
      assert.ok((quotaHits[0]!.resetMs ?? 0) > 4 * 3600_000)

      // Parent SYSTEM_MESSAGE subagent error
      const parentTranscript = join(mainLogDir, 'transcript.jsonl')
      writeFileSync(
        parentTranscript,
        JSON.stringify({
          step_index: 10,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: 'The subagent Code Auditor (research) with id "895a3e66" encountered an error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h43m44s.',
        }) + '\n',
      )
      tracker.poll()
      assert.equal(quotaHits.length, 2)
      assert.ok((quotaHits[1]!.resetMs ?? 0) > 3 * 3600_000)
      tracker.stop()

      // Resumed tracker must baseline parent transcript at EOF and NOT replay step 10
      const resumedHits: unknown[] = []
      const resumedTracker = new SubagentTracker({
        conversationId: mainId,
        accountHome: root,
        resumed: true,
        pollIntervalMs: 5000,
        onEvent: () => {},
        onQuotaExhausted: (info) => resumedHits.push(info),
      })
      resumedTracker.start()
      resumedTracker.poll()
      assert.equal(resumedHits.length, 0)
      resumedTracker.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('5. Live subagent MODEL-scoped quota keeps the run alive, pauses only that model, never moves the pointer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-sub-live-'))
    const prevMode = process.env.FAKE_AGY_MODE
    const prevInv = process.env.FAKE_AGY_INVOCATION_FILE
    const prevWait = process.env.FAKE_AGY_SUBAGENT_WAIT_MS
    const invFile = join(root, 'inv.txt')
    try {
      process.env.FAKE_AGY_MODE = 'subagent-quota-live'
      process.env.FAKE_AGY_INVOCATION_FILE = invFile
      process.env.FAKE_AGY_SUBAGENT_WAIT_MS = '2000'

      // 2 isolated accounts -> the image-model 429 must NOT abort the run nor
      // move the family pointer: it only pauses that model on acc1.
      const pool2 = new AccountPoolManager(join(root, 'pool2'))
      pool2.setAccountEnabled('acc_primary', false)
      const acc1 = pool2.createAccountSlot('A1')
      const acc2 = pool2.createAccountSlot('A2')
      const { adapter: a2 } = makeAdapter(join(root, 'a2'), {}, { pool: pool2 })
      const chunks2 = await collect(a2.stream(opts([msg('user', 'run subagent')], { sessionId: 'sess-sub2' as never })))
      const finish2 = chunks2[chunks2.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
      assert.equal(finish2.reason.kind, 'stop', 'a model-scoped 429 must not kill the turn')
      assert.equal(pool2.getAccount(acc1.id)?.cooldowns?.google, undefined)
      assert.equal(pool2.getPoolData().lastActiveAccountId, acc1.id, 'the sticky pointer must stay on acc1')
      assert.ok(acc2.id, 'the spare account stays available for later turns')

      // 1 isolated account (no alternative) -> cools account but does NOT kill prematurely
      writeFileSync(invFile, '')
      process.env.FAKE_AGY_SUBAGENT_WAIT_MS = '650'
      const pool1 = new AccountPoolManager(join(root, 'pool1'))
      pool1.setAccountEnabled('acc_primary', false)
      const solo = pool1.createAccountSlot('Solo')
      const { adapter: a1 } = makeAdapter(join(root, 'a1'), {}, { pool: pool1 })
      const chunks1 = await collect(a1.stream(opts([msg('user', 'run subagent solo')], { sessionId: 'sess-sub1' as never })))
      const finish1 = chunks1[chunks1.length - 1] as { type: string; reason: { kind: string } }
      assert.equal(finish1.reason.kind, 'stop')
      assert.equal(pool1.getAccount(solo.id)?.cooldowns?.google, undefined)
    } finally {
      process.env.FAKE_AGY_MODE = prevMode
      if (prevInv === undefined) delete process.env.FAKE_AGY_INVOCATION_FILE
      else process.env.FAKE_AGY_INVOCATION_FILE = prevInv
      if (prevWait === undefined) delete process.env.FAKE_AGY_SUBAGENT_WAIT_MS
      else process.env.FAKE_AGY_SUBAGENT_WAIT_MS = prevWait
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('6. retry policy scales to pool size and isAux fails over in-adapter (except TOS_VIOLATION)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-aux-retry-'))
    const prevMode = process.env.FAKE_AGY_MODE
    const prevInv = process.env.FAKE_AGY_INVOCATION_FILE
    const invFile = join(root, 'inv.txt')
    try {
      const pool7 = new AccountPoolManager(join(root, 'pool7'))
      for (let i = 2; i <= 7; i++) pool7.createAccountSlot(`S${i}`)
      const { adapter: a7 } = makeAdapter(join(root, 'a7'), {}, { pool: pool7 })
      assert.equal(a7.providerRetryPolicy('agy').maxRetries, 6)

      // isAux compaction auto-failover across quota-once -> succeeds inside single stream() call
      process.env.FAKE_AGY_MODE = 'quota-once'
      process.env.FAKE_AGY_INVOCATION_FILE = invFile
      writeFileSync(invFile, '')
      const pool2 = new AccountPoolManager(join(root, 'pool2'))
      pool2.createAccountSlot('Second')
      const { adapter: a2 } = makeAdapter(join(root, 'a2'), {}, { pool: pool2 })
      const auxChunks = await collect(a2.stream(opts([msg('user', 'summarize')], { purpose: 'compaction' as never })))
      const auxFinish = auxChunks[auxChunks.length - 1] as { type: string; reason: { kind: string } }
      assert.equal(auxFinish.reason.kind, 'stop')
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 2)

      // TOS_VIOLATION must NEVER fail over across sibling accounts even on isAux
      process.env.FAKE_AGY_MODE = 'tos-violation'
      writeFileSync(invFile, '')
      const poolTos = new AccountPoolManager(join(root, 'pool-tos'))
      poolTos.createAccountSlot('Backup')
      const { adapter: aTos } = makeAdapter(join(root, 'atos'), {}, { pool: poolTos })
      const tosChunks = await collect(aTos.stream(opts([msg('user', 'summarize')], { purpose: 'compaction' as never })))
      const tosFinish = tosChunks[tosChunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
      assert.equal(tosFinish.reason.kind, 'error')
      assert.equal(tosFinish.reason.failure?.code, Err.AGY_ERROR)
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 1)
    } finally {
      process.env.FAKE_AGY_MODE = prevMode
      if (prevInv === undefined) delete process.env.FAKE_AGY_INVOCATION_FILE
      else process.env.FAKE_AGY_INVOCATION_FILE = prevInv
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('7. runAgyOnce cools exhausted account, switches to next account, refuses fallback to undefined when all unavailable, and stops on TOS_VIOLATION', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-oneshot-'))
    const prevMode = process.env.FAKE_AGY_MODE
    const prevInv = process.env.FAKE_AGY_INVOCATION_FILE
    const invFile = join(root, 'inv.txt')
    try {
      process.env.FAKE_AGY_MODE = 'quota-once'
      process.env.FAKE_AGY_INVOCATION_FILE = invFile
      writeFileSync(invFile, '')
      const pool = new AccountPoolManager(join(root, 'pool'))
      const second = pool.createAccountSlot('Second')
      const res = await runAgyOnce(
        {
          cfg: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
          bin: () => fakeBin,
          pool: () => pool,
        },
        { prompt: 'ask question' },
      )
      assert.equal(res.ok, true, res.error)
      assert.equal(res.text, 'There are 2 files, 6 words total.')
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 2)
      assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
      assert.ok((pool.getAccounts()[0]!.cooldowns.google?.cooldownUntil ?? 0) > Date.now())

      // All accounts exhausted -> fail without spawning as undefined/primary
      process.env.FAKE_AGY_MODE = 'real-quota'
      pool.recordFailure(second.id, 'google', '429')
      writeFileSync(invFile, '')
      const noneRes = await runAgyOnce(
        {
          cfg: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
          bin: () => fakeBin,
          pool: () => pool,
        },
        { prompt: 'ask question' },
      )
      assert.equal(noneRes.ok, false)
      assert.match(noneRes.error ?? '', /unavailable/i)
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 0)

      // TOS_VIOLATION -> stops on 1st attempt
      process.env.FAKE_AGY_MODE = 'tos-violation'
      const poolTos = new AccountPoolManager(join(root, 'pool-tos'))
      poolTos.createAccountSlot('Second')
      writeFileSync(invFile, '')
      const tosRes = await runAgyOnce(
        {
          cfg: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
          bin: () => fakeBin,
          pool: () => poolTos,
        },
        { prompt: 'ask question' },
      )
      assert.equal(tosRes.ok, false)
      assert.equal(readFileSync(invFile, 'utf8').split('\n').filter(Boolean).length, 1)
    } finally {
      process.env.FAKE_AGY_MODE = prevMode
      if (prevInv === undefined) delete process.env.FAKE_AGY_INVOCATION_FILE
      else process.env.FAKE_AGY_INVOCATION_FILE = prevInv
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('8. ImageService rotates across 4 accounts on tool-level 429 QUOTA_EXHAUSTED even when imageRetries=1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-img-failover-'))
    try {
      const pool = new AccountPoolManager(join(root, 'pool'))
      pool.createAccountSlot('Acc2')
      pool.createAccountSlot('Acc3')
      pool.createAccountSlot('Acc4')
      let runIdx = 0
      const okImg = join(root, 'ok.png')
      const png = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
      png.writeUInt32BE(13, 8)
      png.write('IHDR', 12, 'ascii')
      png.writeUInt32BE(512, 16)
      png.writeUInt32BE(512, 20)
      writeFileSync(okImg, png)

      const service = new ImageService({
        cfg: () => ({ ...defaultConfig(), imageRetries: 1 }),
        bin: () => '/fake/agy',
        poolQuotaHops: () => Math.max(0, pool.getAccounts().filter((a) => a.enabled).length - 1),
        onQuotaExhausted: (accId, model, errText) => {
          if (accId) pool.recordFailure(accId, 'google', errText)
          return pool.selectAccount('google', model) !== null
        },
        run: async () => {
          const active = pool.selectAccount('google')!
          runIdx++
          if (runIdx <= 3) {
            return {
              ok: true,
              text: 'quota error',
              accountId: active.id,
              toolCalls: [{ name: 'generate_image', error: '429 Too Many Requests {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"model":"gemini-3.1-flash-image","quotaResetDelay":"4h58m46s"}}]}}' }],
              subagents: [],
              durationMs: 5,
            }
          }
          return {
            ok: true,
            text: 'IMAGE_PATH=' + okImg,
            accountId: active.id,
            toolCalls: [{ name: 'generate_image', output: 'ok' }],
            subagents: [],
            durationMs: 5,
          }
        },
      })
      const res = await service.generate({ prompt: 'a cat', aspectRatio: '1:1' })
      assert.equal(res.ok, true, res.error)
      assert.equal(runIdx, 4)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('9. TranslationService allows RATE_LIMIT retries up to poolQuotaHops while bounding non-quota errors', async () => {
    const cfg = { ...defaultConfig(), translateRetries: 1 }
    const fallbackCatalog = cfg.fallbackModels.map((m) => ({ ...m, efforts: m.efforts ?? null }))
    let calls = 0
    const service = new TranslationService({
      cfg: () => cfg,
      catalog: () => ({ source: 'fallback', models: fallbackCatalog, fetchedAt: 0, discoveredAt: 0 }),
      getSession: () => undefined,
      poolQuotaHops: () => 3,
      run: async () => {
        calls++
        if (calls < 4) return { ok: false, text: '', code: Err.RATE_LIMIT, error: 'quota reached' }
        return { ok: true, text: 'translated ok' }
      },
      now: (() => { let t = 1000; return () => (t += 10) })(),
    })
    const res = await service.translate({ text: 'technical jargon' })
    assert.equal(res.ok, true, res.error)
    assert.equal(calls, 4)

    let errCalls = 0
    const service2 = new TranslationService({
      cfg: () => cfg,
      catalog: () => ({ source: 'fallback', models: fallbackCatalog, fetchedAt: 0, discoveredAt: 0 }),
      getSession: () => undefined,
      poolQuotaHops: () => 5,
      run: async () => {
        errCalls++
        return { ok: false, text: '', code: Err.TIMEOUT, error: 'timed out' }
      },
      now: (() => { let t = 1000; return () => (t += 10) })(),
    })
    const res2 = await service2.translate({ text: 'more jargon' })
    assert.equal(res2.ok, false)
    assert.equal(errCalls, 2)
  })

  test('10. runAcpAttempt treats partial-response 429 quota error as RATE_LIMIT and rotates account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-acp-quota-'))
    const pool = new AccountPoolManager(join(dir, 'pool'))
    const second = pool.createAccountSlot('Second')
    const primary = pool.getAccounts()[0]!
    const scriptPath = join(dir, 'mock-acp-quota.mjs')
    writeFileSync(scriptPath, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-q-1' } });
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') return send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer ' } } } });
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: msg.id, result: { error: { message: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m0s.' } } });
    }, 15);
  }
});
rl.on('close', () => process.exit(0));
`, 'utf8')
    const cfg: PluginConfig = { ...defaultConfig(), timeoutMs: 10_000, transport: 'acp' }
    const store = new SessionStore(join(dir, 'sessions.json'))
    const runs = new RunRegistry()
    const spawned: AcpProcess[] = []
    const acpPool = new AcpSessionPool({
      bin: () => scriptPath,
      cfg: () => cfg,
      createProcess: (o) => {
        const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
        spawned.push(p)
        return p
      },
    })
    const deps: AttemptDeps = {
      acquire: () => Promise.resolve(() => {}),
      pool,
      runs,
      store,
      clearInFlightPrompt: () => {},
      registerActiveRun: () => {},
      unregisterActiveRun: () => {},
      isSuperseded: () => false,
      noteNetworkFailure: () => 1,
      clearNetworkStreak: () => {},
      dropFailoverBudget: () => {},
      clearRateLimitFailover: () => {},
      sharesSingleEgress: () => true,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
    }
    const input: AttemptInput = {
      cfg,
      bin: scriptPath,
      permissionMode: 'auto',
      sessionKey: 'sess-acp-q',
      workspaceRoot: dir,
      isAux: false,
      account: primary,
      prompt: 'hi',
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      effort: 'medium',
      addDirs: [],
      persistBinding: false,
      binding: undefined,
      messages: [msg('user', 'hi')],
      newlySentImageIds: [],
      sessionAccountKey: 'sess-acp-q',
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    }
    const slot: AttemptSlot = { releaseOnce: () => {}, armHandoff: () => null }
    try {
      const rec = await runAcpAttempt(acpPool, deps, input, slot)
      assert.ok(rec)
      for await (const _ of rec.eventsFrom(0)) { /* drain */ }
      assert.equal(rec.failureInfo?.kind, 'error')
      assert.equal(rec.failureInfo?.code, Err.RATE_LIMIT)
      assert.ok((primary.cooldowns.google?.cooldownUntil ?? 0) > Date.now() + 3600_000)
      assert.equal(pool.getPoolData().lastActiveAccountId, second.id)
    } finally {
      await Promise.all(spawned.map((p) => new Promise<void>((r) => { p.once('exit', () => r()); p.close(); setTimeout(r, 200) })))
      acpPool.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
    }
  })

  test('11. standalone agy ⚠ quota banners with ok=true classify as hard quota without false positives on prose', () => {
    const banner = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.'
    const credits = '⚠ Your AI credits balance is too low to continue.'
    assert.equal(isAgyQuotaBannerLine(banner), true)
    assert.equal(isAgyQuotaBannerLine(credits), true)
    assert.equal(extractAgyQuotaBanner(banner), banner)
    assert.equal(isHardQuotaResultError(true, undefined, banner), true)
    assert.equal(isNonConsumableResultError(true, undefined, banner), true)
    assert.equal(isHardQuotaResultError(true, undefined, credits), true)

    // Prose quoting or non-quota ⚠ answers must remain normal consumable replies.
    assert.equal(isAgyQuotaBannerLine('⚠ 端口 8080 已被占用，请先停掉旧服务。'), false)
    assert.equal(isAgyQuotaBannerLine('Fixed Individual quota reached in diagnostics.ts'), false)
    assert.equal(extractAgyQuotaBanner(`${banner}\nDone checking logs.`), undefined)
    assert.equal(isHardQuotaResultError(true, undefined, 'Fixed Individual quota reached handling.'), false)
    assert.equal(isNonConsumableResultError(true, undefined, '⚠ 端口 8080 已被占用，请先停掉旧服务。'), false)
  })

  test('12. EventMapper suppresses fragmented ⚠ quota banners while preserving legitimate ⚠ warnings', () => {
    const mapperQuota = new EventMapper({ runId: 'r-q', cutOnTool: false })
    const c1 = [...mapperQuota.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: '⚠ Individual quota ' }, 0)]
    const c2 = [...mapperQuota.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: 'reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.' }, 1)]
    const c3 = [...mapperQuota.map({ kind: 'result', conversationId: 'c1', ok: true, response: '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.', usage: {}, raw: {} }, 2)]
    const c4 = [...mapperQuota.emitFailure('error', Err.RATE_LIMIT, 'quota reached')]
    const leaked = [...c1, ...c2, ...c3, ...c4].filter((c) => c.type === 'text-delta')
    assert.equal(leaked.length, 0, 'quota banner must never leak as assistant text-delta')
    assert.equal(mapperQuota.isFinished, true)

    const mapperWarn = new EventMapper({ runId: 'r-w', cutOnTool: false })
    const w1 = [...mapperWarn.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: '⚠ 端口 8080 ' }, 0)]
    const w2 = [...mapperWarn.map({ kind: 'step', stepKey: 's1', stepKind: 'text', fragment: true, text: '已被占用。' }, 1)]
    const w3 = [...mapperWarn.map({ kind: 'result', conversationId: 'c1', ok: true, response: '⚠ 端口 8080 已被占用。', usage: {}, raw: {} }, 2)]
    const textOut = [...w1, ...w2, ...w3].filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    assert.equal(textOut, '⚠ 端口 8080 已被占用。')
  })

  test('13. runAcpAttempt cools & rotates when agy emits ⚠ Individual quota reached with end_turn (both post-tool and empty turn)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-acp-banner-quota-'))
    const pool = new AccountPoolManager(join(dir, 'pool'))
    const second = pool.createAccountSlot('Second')
    const primary = pool.getAccounts()[0]!
    const scriptPath = join(dir, 'mock-acp-banner.mjs')
    writeFileSync(scriptPath, `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
let promptCount = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-b-1' } });
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') return send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  if (msg.method === 'session/prompt') {
    promptCount++;
    if (promptCount === 1) {
      // Simulate a tool call followed by agy emitting ⚠ Individual quota reached... and ending with end_turn.
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', name: 'edit_file', status: 'in_progress', rawInput: { path: 'a.ts' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', name: 'edit_file', status: 'completed', rawOutput: 'ok' } } });
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.' } } } });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }, 20);
    } else {
      // Immediate banner on an empty turn (no tools)
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h25m47s.' } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  }
});
rl.on('close', () => process.exit(0));
`, 'utf8')
    const cfg: PluginConfig = { ...defaultConfig(), timeoutMs: 10_000, transport: 'acp' }
    const store = new SessionStore(join(dir, 'sessions.json'))
    const runs = new RunRegistry()
    const spawned: AcpProcess[] = []
    const acpPool = new AcpSessionPool({
      bin: () => scriptPath,
      cfg: () => cfg,
      createProcess: (o) => {
        const p = new AcpProcess({ ...o, preemptAutoUpdate: false })
        spawned.push(p)
        return p
      },
    })
    const deps: AttemptDeps = {
      acquire: () => Promise.resolve(() => {}),
      pool,
      runs,
      store,
      clearInFlightPrompt: () => {},
      registerActiveRun: () => {},
      unregisterActiveRun: () => {},
      isSuperseded: () => false,
      noteNetworkFailure: () => 1,
      clearNetworkStreak: () => {},
      dropFailoverBudget: () => {},
      clearRateLimitFailover: () => {},
      sharesSingleEgress: () => true,
      lastAccountSpawnTime: new Map(),
      minSpawnIntervalMs: 0,
    }
    const baseInput = (sessionKey: string): AttemptInput => ({
      cfg,
      bin: scriptPath,
      permissionMode: 'auto',
      sessionKey,
      workspaceRoot: dir,
      isAux: false,
      account: primary,
      prompt: 'continue',
      model: 'gemini-3.8-flash',
      activeModel: 'gemini-3.8-flash',
      effort: 'medium',
      addDirs: [],
      persistBinding: false,
      binding: undefined,
      messages: [msg('user', 'continue')],
      newlySentImageIds: [],
      sessionAccountKey: sessionKey,
      family: 'google',
      signal: undefined,
      agyOnEvent: undefined,
      sandbox: false,
      agent: '',
    })
    const slot: AttemptSlot = { releaseOnce: () => {}, armHandoff: () => null }
    try {
      // 1) Post-tool turn: span 0 cuts on tool; continuation span 1 must surface RATE_LIMIT with zero leaked banner text
      const rec1 = await runAcpAttempt(acpPool, deps, baseInput('sess-b-1'), slot)
      assert.ok(rec1)
      const span0: StreamChunk[] = []
      for await (const ch of driveSpan({ runs }, rec1, 0, true, false, undefined, undefined, undefined, undefined, undefined, true, 'sess-b-1')) span0.push(ch)
      const finish0 = span0[span0.length - 1] as { type: string; reason: { kind: string } }
      assert.equal(finish0.reason.kind, 'tool-calls')

      const span1: StreamChunk[] = []
      for await (const ch of driveSpan({ runs }, rec1, 3, true, false, undefined, undefined, undefined, undefined, undefined, true, 'sess-b-1')) span1.push(ch)
      const finish1 = span1[span1.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
      assert.equal(finish1.reason.kind, 'error')
      assert.equal(finish1.reason.failure?.code, Err.RATE_LIMIT)
      assert.equal(span1.some((c) => c.type === 'text-delta'), false, 'must not leak quota banner text before rotating')
      assert.ok((pool.getAccount(primary.id)?.cooldowns.google?.cooldownUntil ?? 0) > Date.now() + 4 * 3600_000)
      assert.equal(pool.getPoolData().lastActiveAccountId, second.id)

      // 2) Immediate empty turn: must NOT return null (CLI fallback on same account), must settle RATE_LIMIT
      delete primary.cooldowns.google
      const rec2 = await runAcpAttempt(acpPool, deps, baseInput('sess-b-2'), slot)
      assert.ok(rec2, 'must return settled recording instead of falling back to CLI on the same exhausted account')
      for await (const _ of rec2.eventsFrom(0)) { /* drain */ }
      assert.equal(rec2.failureInfo?.code, Err.RATE_LIMIT)
      assert.ok((pool.getAccount(primary.id)?.cooldowns.google?.cooldownUntil ?? 0) > Date.now() + 4 * 3600_000)
    } finally {
      await Promise.all(spawned.map((p) => new Promise<void>((r) => { p.once('exit', () => r()); p.close(); setTimeout(r, 200) })))
      acpPool.dispose()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
    }
  })
})
