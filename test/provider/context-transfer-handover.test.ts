// Tests for account-switch context handover:
// 1. Inline-first up to 150 KB + hybrid tail-inline / head-archive delivery
// 2. Unified foreign (A→B→A) channel beyond the old 8,000-char cap
// 3. Chronological in-place historical attachments vs live current-turn attachments
// 4. ACP spawn --add-dir pre-mounting for context-transfer & media
// 5. Failure watermark preservation + [watermark-drop] diagnostic logging
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, Err, type PluginConfig } from '../../src/common/types.ts'
import { buildAcpSpawnArgs } from '../../src/features/acp/spawn.ts'
import { defaultMediaDir } from '../../src/host/media.ts'
import { RunRecording } from '../../src/host/recording.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import {
  defaultContextTransferDir,
  deliverContext,
  splitDigestForHybridDelivery,
} from '../../src/provider/context-delivery.ts'
import { finalizeAttempt, warnWatermarkDrop } from '../../src/provider/finalize.ts'
import { buildPromptPlan, type PromptPlanDeps } from '../../src/provider/prompt.ts'
import { AGY_PROMPT_SAFE_BYTES, buildDigest, utf8Bytes } from '../../src/provider/prompt-text.ts'
import { purposePolicy } from '../../src/provider/purpose-policy.ts'
import type { CallContext } from '../../src/provider/call-context.ts'

function msg(role: 'user' | 'assistant' | 'system', text: string, source?: Record<string, unknown>): Message {
  return {
    role,
    content: [{ type: 'text', text }],
    ...(source ? { source } : {}),
  } as unknown as Message
}

function imgMsg(id: string, text: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', attachmentId: id, mediaType: 'image/png', bytes: 12, width: 4, height: 4, name: `${id}.png` },
    ],
  } as unknown as Message
}

function makeCallCtx(sessionKey: string, workspaceRoot: string, cfg: PluginConfig): CallContext {
  return {
    cfg,
    bin: 'agy',
    purpose: 'chat',
    sessionKey,
    workspaceRoot,
    neutralAuxWorkspace: false,
    permissionMode: 'auto',
    isCodeMode: true,
    hasToolSupport: true,
    isAux: false,
    isCompaction: false,
    isTitle: false,
    isReview: false,
    isTranslate: false,
    isImage: false,
    isTranslateSession: false,
    translateSession: null,
  }
}

async function withTempDshHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agy-handover-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

test('default contextTransferFileAboveBytes is 150 KB and delivers 100 KB digest fully inline', async () => {
  await withTempDshHome(async () => {
    const cfg = defaultConfig()
    assert.equal(cfg.contextTransferFileAboveBytes, 150_000)

    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(msg('user', `turn ${i} ask`))
      messages.push(msg('assistant', `turn ${i} reply ` + 'a'.repeat(4_800)))
    }
    const digest = buildDigest(messages, 0, cfg.contextTransferMaxChars, {
      maxBytes: cfg.contextTransferFileMaxBytes,
      maxLineBytes: 40_000,
      includeTaskLine: false,
    })
    const bytes = utf8Bytes(digest)
    assert.ok(bytes > 80_000 && bytes < 140_000, `expected 80-140KB digest, got ${bytes}`)

    const extraDirs: string[] = []
    const delivered = await deliverContext(digest, 'sess-inline-100k', extraDirs, cfg, { liveRequestBytes: 500 })
    assert.equal(delivered, digest, 'digest <= 150KB must be delivered 100% inline')
    assert.deepEqual(extraDirs, [], 'inline delivery must not spill to disk')
  })
})

test('splitDigestForHybridDelivery preserves multi-paragraph turns without duplication', () => {
  const messages: Message[] = [
    msg('user', 'turn 1 question'),
    msg('assistant', 'turn 1 para 1\n\n```ts\nconst a = 1\n```\n\nturn 1 para 2 ' + 'x'.repeat(3_000)),
    msg('user', 'turn 2 question'),
    msg('assistant', 'turn 2 para 1\n\nstill turn 2 para 2 ' + 'y'.repeat(1_500)),
    msg('user', 'turn 3 latest question'),
    msg('assistant', 'turn 3 para 1\n\nstill turn 3 para 2 ' + 'z'.repeat(1_200)),
  ]
  const digest = buildDigest(messages, 0, 500_000, { maxBytes: 500_000, includeTaskLine: false })
  const { archive, recent } = splitDigestForHybridDelivery(digest, 3_800)

  assert.ok(archive.includes('turn 1 para 1') && archive.includes('turn 1 para 2'), 'older turn stays complete in archive')
  assert.ok(recent.includes('[RECENT CONVERSATION'), 'recent header marks inlined tail')
  assert.ok(recent.includes('turn 3 para 1') && recent.includes('still turn 3 para 2'), 'multi-paragraph newest turn stays intact in recent')
  assert.ok(!archive.includes('turn 3 latest question'), 'recent turns must not be duplicated in archive')
  assert.ok(!recent.includes('turn 1 para 1'), 'older turns must stay in archive only')
})

test('deliverContext spills older overflow to .md, keeps newest turns inline, and respects liveRequestBytes ceiling', async () => {
  await withTempDshHome(async () => {
    const cfg: PluginConfig = { ...defaultConfig(), contextTransferFileAboveBytes: 8_000 }
    const messages: Message[] = []
    for (let i = 0; i < 12; i++) {
      messages.push(msg('user', `ask-${i}`))
      messages.push(msg('assistant', `ans-${i} ` + 'b'.repeat(1_400)))
    }
    const digest = buildDigest(messages, 0, cfg.contextTransferMaxChars, {
      maxBytes: cfg.contextTransferFileMaxBytes,
      includeTaskLine: false,
    })

    const extraDirs: string[] = []
    const delivered = await deliverContext(digest, 'sess-hybrid', extraDirs, cfg, { liveRequestBytes: 400 })
    assert.ok(delivered.includes('[BACKGROUND CONTEXT'), 'archive pointer must be present')
    assert.ok(delivered.includes('[RECENT CONVERSATION'), 'newest turns must remain inlined')
    assert.ok(delivered.includes('ans-11'), 'newest assistant reply must be inlined')
    assert.ok(!delivered.includes('ans-0 '), 'oldest assistant reply must move to archive file')
    assert.equal(extraDirs.length, 1, 'archive directory must be added to extraAddDirs')

    const match = delivered.match(/([A-Za-z]:\\[^\n]*?\.md)/) ?? delivered.match(/(\/[^\n]*?\.md)/)
    assert.ok(match !== null, 'archive file path must appear in prompt')
    const archiveText = readFileSync(match![1]!, 'utf8')
    assert.ok(archiveText.includes('ans-0 '), 'archive must hold oldest turns')
    assert.ok(!archiveText.includes('ans-11'), 'archive must not duplicate inlined recent turns')

    // Adversarial: huge live request leaves very little room under AGY_PROMPT_SAFE_BYTES
    const tightDirs: string[] = []
    const hugeLive = AGY_PROMPT_SAFE_BYTES - 3_000
    const tightDelivered = await deliverContext(digest, 'sess-tight', tightDirs, defaultConfig(), {
      liveRequestBytes: hugeLive,
    })
    assert.ok(tightDelivered.includes('[BACKGROUND CONTEXT'), 'must spill to archive when live request consumes safe budget')
    assert.ok(!tightDelivered.includes('[RECENT CONVERSATION'), 'no inline tail when remaining budget cannot fit pointer+recent')
    assert.ok(hugeLive + utf8Bytes(tightDelivered) <= AGY_PROMPT_SAFE_BYTES + 1_000)
  })
})

test('A→B→A foreign catch-up uses full contextTransfer budget (no 8K truncation) and hybrid delivery', async () => {
  await withTempDshHome(async (dir) => {
    const store = new SessionStore(join(dir, 'sessions.json'))
    store.set('sess-aba:acc-a', {
      conversationId: 'conv-a',
      lastMessageCount: 2,
      updatedAt: Date.now(),
      model: 'gemini-4-neon-high',
    })
    const cfg: PluginConfig = {
      ...defaultConfig(),
      digestMaxChars: 500, // legacy small cap — must no longer clip foreign catch-up
      contextTransferMaxChars: 660_000,
      contextTransferFileAboveBytes: 150_000,
    }
    const messages: Message[] = [
      msg('user', 'turn 1 on A'),
      msg('assistant', 'reply 1 on A', { provider: 'antigravity', replayState: { response: { conversationId: 'conv-a' } } }),
      msg('user', 'turn 2 on B'),
      msg('assistant', 'FOREIGN-MARKER-START ' + 'm'.repeat(20_000) + ' FOREIGN-MARKER-END', {
        provider: 'antigravity',
        replayState: { response: { conversationId: 'conv-b' } },
      }),
      msg('user', 'back on A now'),
    ]
    const deps: PromptPlanDeps = {
      store,
      getActiveRun: () => undefined,
      recentlyCompactedSessions: new Map(),
      deliverContext: (d, k, dirs, o) => deliverContext(d, k, dirs, cfg, o),
    }
    const ctx = makeCallCtx('sess-aba', dir, cfg)
    const plan = await buildPromptPlan({
      options: { messages, sessionId: 'sess-aba' } as never,
      cfg,
      ctx,
      policy: purposePolicy(ctx),
      account: { id: 'acc-a' } as never,
      model: 'gemini-4-neon-high',
      activeModel: 'gemini-4-neon-high',
      deps,
    })
    assert.ok(plan.prompt.includes('FOREIGN-MARKER-START'), 'full >20KB foreign reply must not be cut at old 8K limit')
    assert.ok(plan.prompt.includes('FOREIGN-MARKER-END'), 'tail of foreign reply must stay intact')
    assert.ok(plan.prompt.indexOf('back on A now') < plan.prompt.indexOf('FOREIGN-MARKER-START'), 'live request leads prompt')
  })
})

test('first-contact and foreign digests place historical images in-place while keeping only current-turn images as live inlineImages', async () => {
  await withTempDshHome(async (dir) => {
    const mediaDir = join(dir, 'media')
    const cfg: PluginConfig = { ...defaultConfig(), mediaDir }
    const store = new SessionStore(join(dir, 'sessions.json'))
    const reads: string[] = []
    const deps: PromptPlanDeps = {
      store,
      readImage: async (ref) => {
        reads.push(ref.attachmentId)
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      },
      getActiveRun: () => undefined,
      recentlyCompactedSessions: new Map(),
      deliverContext: (d, k, dirs, o) => deliverContext(d, k, dirs, cfg, o),
    }

    // 1. Account switch A -> B (binding === undefined, history has img-old, current turn has img-live)
    const switchMessages: Message[] = [
      imgMsg('img-old', 'earlier mockup'),
      msg('assistant', 'got the earlier mockup'),
      imgMsg('img-live', 'new screenshot right now'),
    ]
    const ctxFirst = makeCallCtx('sess-img', dir, cfg)
    const planFirst = await buildPromptPlan({
      options: { messages: switchMessages, sessionId: 'sess-img' } as never,
      cfg,
      ctx: ctxFirst,
      policy: purposePolicy(ctxFirst),
      account: { id: 'acc-b' } as never,
      model: 'gemini-4-neon-high',
      activeModel: 'gemini-4-neon-high',
      deps,
    })

    assert.ok(planFirst.prompt.includes('[earlier image attachment: "img-old.png"'), 'old image must be noted in-place in digest')
    assert.deepEqual(reads, ['img-live'])
    assert.equal(planFirst.stagedImages.length, 1, 'only current-turn image should ride as ACP inlineImage')
    assert.ok(planFirst.stagedImages[0]!.path.includes('img-live') || reads.includes('img-live'))
    assert.deepEqual(planFirst.newlySentImageIds, ['img-old', 'img-live'], 'both historical and live ids recorded for watermark')
    assert.ok(planFirst.addDirs.includes(mediaDir), 'mediaDir added to addDirs')
    assert.ok(
      planFirst.prompt.indexOf('earlier mockup') < planFirst.prompt.indexOf('[earlier image attachment: "img-old.png"'),
      'historical attachment annotation must sit under its owning historical user turn',
    )

    // 2. Account switch back B -> A (foreign span has img-b, A already saw img-a, current turn has no image)
    reads.length = 0
    store.set('sess-img:acc-a', {
      conversationId: 'conv-a',
      lastMessageCount: 2,
      updatedAt: Date.now(),
      model: 'gemini-4-neon-high',
      sentImageIds: ['img-a'],
    })
    const returnMessages: Message[] = [
      imgMsg('img-a', 'turn 1 on A'),
      msg('assistant', 'reply 1 on A', { provider: 'antigravity', replayState: { response: { conversationId: 'conv-a' } } }),
      imgMsg('img-b', 'turn 2 on B with screenshot'),
      msg('assistant', 'reply 2 on B', { provider: 'antigravity', replayState: { response: { conversationId: 'conv-b' } } }),
      msg('user', 'continue on A with text only'),
    ]
    const ctxForeign = makeCallCtx('sess-img', dir, cfg)
    const planForeign = await buildPromptPlan({
      options: { messages: returnMessages, sessionId: 'sess-img' } as never,
      cfg,
      ctx: ctxForeign,
      policy: purposePolicy(ctxForeign),
      account: { id: 'acc-a' } as never,
      model: 'gemini-4-neon-high',
      activeModel: 'gemini-4-neon-high',
      deps,
    })
    assert.deepEqual(reads, [], 'historical screenshots must not be read or staged again')
    assert.ok(planForeign.prompt.includes('[earlier image attachment: "img-b.png"'), 'foreign image annotated in-place')
    assert.deepEqual(planForeign.stagedImages, [], 'no stale inlineImages when current turn is text-only')
    assert.deepEqual(planForeign.newlySentImageIds, ['img-b'])
  })
})

test('buildAcpSpawnArgs pre-mounts context-transfer and media directories via --add-dir', async () => {
  await withTempDshHome(async (dir) => {
    const customMedia = join(dir, 'custom-media')
    const logFile = join(dir, 'logs', 'acp-test.log')
    const args = buildAcpSpawnArgs(
      { permissionMode: 'auto', sandbox: false, addDirs: [customMedia] },
      logFile,
    )
    const addDirs: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--add-dir') addDirs.push(args[i + 1] ?? '')
    }
    const expectedCtx = defaultContextTransferDir()
    const expectedMedia = defaultMediaDir(join(dir, 'agy-link'))
    assert.ok(addDirs.includes(expectedCtx), `missing context-transfer dir in ${JSON.stringify(addDirs)}`)
    assert.ok(addDirs.includes(expectedMedia), `missing default media dir in ${JSON.stringify(addDirs)}`)
    assert.ok(addDirs.includes(customMedia), `missing custom media dir in ${JSON.stringify(addDirs)}`)
    assert.ok(existsSync(expectedCtx), 'context-transfer dir must be created')
    assert.ok(existsSync(expectedMedia), 'media dir must be created')
    assert.ok(existsSync(customMedia), 'custom media dir must be created')
  })
})

test('finalizeAttempt preserves watermark on unconsumed failures and logs [watermark-drop] on sudden drops', async () => {
  await withTempDshHome(async (dir) => {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const logs: string[] = []
    const baseInput = () => ({
      rec: new RunRecording('r1'),
      outcome: { code: 1, signal: null, timedOut: false, aborted: false, capped: false, stdout: '', stderrTail: '', durationMs: 10 },
      store,
      family: 'google' as const,
      persistBinding: true,
      sessionAccountKey: 'sess-wm:acc-a',
      conversationId: 'conv-a',
      cwd: dir,
      messages: Array.from({ length: 14 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`)),
      model: 'gemini-4-neon-high',
      activeModel: 'gemini-4-neon-high',
      superseded: false,
      newlySentImageIds: [],
      rawErrText: '',
      runLogText: '',
      silentTimeout: false,
      sessionKey: 'sess-wm',
      clearNetworkStreak: () => {},
      dropFailoverBudget: () => {},
      clearRateLimitFailover: () => {},
      sharesSingleEgress: () => false,
      log: (m: string) => logs.push(m),
    })

    // 1. Existing binding at watermark 10 fails with RATE_LIMIT -> watermark must STAY 10 (not jump to 14)
    const existingBinding = { conversationId: 'conv-a', lastMessageCount: 10, updatedAt: 1, model: 'gemini-4-neon-high' }
    store.set('sess-wm:acc-a', existingBinding)
    await finalizeAttempt({
      ...baseInput(),
      binding: existingBinding,
      failure: { kind: 'error', code: Err.RATE_LIMIT, message: '429 quota' },
    })
    assert.equal(store.get('sess-wm:acc-a')?.lastMessageCount, 10, 'RATE_LIMIT must not advance watermark')
    assert.equal(store.get('sess-wm:acc-a')?.interrupted, undefined)

    // 2. Brand-new conversation (binding undefined) fails with NETWORK -> watermark stays 0 (not 14)
    await finalizeAttempt({
      ...baseInput(),
      sessionAccountKey: 'sess-wm:acc-b',
      conversationId: 'conv-b',
      binding: undefined,
      failure: { kind: 'error', code: Err.NETWORK, message: 'ECONNRESET' },
    })
    assert.equal(store.get('sess-wm:acc-b')?.lastMessageCount, 0, 'unconsumed first turn failure must keep watermark at 0')

    // 3. Mid-flight Stop (aborted) still advances watermark and marks interrupted: true
    await finalizeAttempt({
      ...baseInput(),
      binding: existingBinding,
      outcome: { code: 1, signal: 'SIGTERM', timedOut: false, aborted: true, capped: false, stdout: '', stderrTail: '', durationMs: 500 },
      failure: { kind: 'aborted', code: Err.AGY_ERROR, message: 'aborted' },
    })
    assert.equal(store.get('sess-wm:acc-a')?.lastMessageCount, 14)
    assert.equal(store.get('sess-wm:acc-a')?.interrupted, true)

    // 4. Sudden watermark drop (>=5 -> <=2) on success logs [watermark-drop] without leaking message content
    logs.length = 0
    await finalizeAttempt({
      ...baseInput(),
      binding: { conversationId: 'conv-a', lastMessageCount: 14, updatedAt: 1, model: 'gemini-4-neon-high' },
      messages: [msg('user', 'SECRET-PROMPT-TEXT-MUST-NOT-LOG')],
      failure: null,
    })
    const dropLog = logs.find((l) => l.includes('[watermark-drop]'))
    assert.ok(dropLog !== undefined, 'must emit [watermark-drop] diagnostic log')
    assert.ok(dropLog!.includes('prev=14 next=1'), dropLog)
    assert.ok(!dropLog!.includes('SECRET-PROMPT-TEXT'), 'diagnostic log must never leak user text')

    // Normal non-drop does not log
    const noDropLogs: string[] = []
    warnWatermarkDrop({
      log: (m) => noDropLogs.push(m),
      source: 'test',
      key: 'k',
      conversationId: 'c',
      previousCount: 4,
      nextCount: 2,
      messages: [msg('user', 'hi')],
    })
    assert.deepEqual(noDropLogs, [])
  })
})

test('cold, warm and switched accounts receive the latest profile and every pending report exactly once', async () => {
  await withTempDshHome(async dir => {
    const cfg = { ...defaultConfig(), forwardSystemPrompt: true, cloakSystemPrompt: false }
    const key = 'isolated-role'
    const ctx = makeCallCtx(key, dir, cfg)
    const store = new SessionStore(join(dir, 'bindings.json'))
    const messages = [
      msg('user', 'old task'), msg('assistant', 'done'),
      msg('system', 'Profile revision two; roster = Lead, Reviewer'),
      msg('user', 'Memory revision two', { kind: 'runtime-context' }),
      msg('user', 'Obsolete plugin snapshot', { kind: 'plugin:other', form: 'snapshot' }),
      msg('user', 'Current plugin snapshot', { kind: 'plugin:other', form: 'snapshot' }),
      msg('user', 'Report from Ada', { kind: 'plugin:agent-message' }),
      msg('user', 'Report from Jin', { kind: 'team-message' }),
    ]
    for (const [account, warm] of [['a', false], ['a', true], ['b', false]] as const) {
      if (warm) store.set(key + ':a', { conversationId: 'warm-a', lastMessageCount: 2, updatedAt: Date.now(), model: 'gemini-4-neon-high' })
      const plan = await buildPromptPlan({
        cfg, ctx, policy: purposePolicy(ctx), options: { messages, sessionId: key } as never,
        account: { id: account } as never, model: 'gemini-4-neon-high', activeModel: 'gemini-4-neon-high',
        deps: { store, getActiveRun: () => undefined, recentlyCompactedSessions: new Map(), deliverContext: async d => d },
      })
      assert.ok(!plan.prompt.includes('Obsolete plugin snapshot'))
      for (const text of ['Profile revision two', 'Lead, Reviewer', 'Memory revision two', 'Current plugin snapshot', 'Report from Ada', 'Report from Jin']) {
        assert.equal(plan.prompt.split(text).length - 1, 1, text)
      }
    }
  })
})

test('issue #207: finalizeAttempt detects parseModelNotRecognized on Err.PROCESS_EXIT and Err.AGY_ERROR', async () => {
  await withTempDshHome(async (dir) => {
    const store = new SessionStore(join(dir, 'sessions.json'))
    for (const code of [Err.PROCESS_EXIT, Err.AGY_ERROR] as const) {
      const calls: Array<[string, ...unknown[]]> = []
      const pool = {
        markModelUnsupported: (...a: unknown[]) => calls.push(['markModelUnsupported', ...a]),
        advanceAccount: (...a: unknown[]) => { calls.push(['advanceAccount', ...a]); return null },
      } as never
      const acc = { id: 'acc-model', dir, enabled: true, alias: 'acc-model', createdAt: 0, cooldowns: {}, quotas: {} } as never
      await finalizeAttempt({
        rec: new RunRecording('r-unrecog'),
        outcome: { code: 1, signal: null, timedOut: false, aborted: false, capped: false, stdout: '', stderrTail: '', durationMs: 10 },
        store,
        pool,
        account: acc,
        family: 'google',
        persistBinding: false,
        sessionAccountKey: 'sess-unrecog:acc-model',
        conversationId: 'c1',
        cwd: dir,
        messages: [msg('user', 'hi')],
        model: 'gemini-99-unknown',
        activeModel: 'gemini-99-unknown',
        superseded: false,
        newlySentImageIds: [],
        rawErrText: '',
        runLogText: '',
        silentTimeout: false,
        sessionKey: 'sess-unrecog',
        clearNetworkStreak: () => undefined,
        dropFailoverBudget: () => undefined,
        clearRateLimitFailover: () => undefined,
        sharesSingleEgress: () => false,
        failure: { kind: 'error', code, message: 'model "gemini-99-unknown" is not recognized as a known model' },
      })
      assert.deepEqual(calls, [
        ['markModelUnsupported', 'acc-model', 'gemini-99-unknown'],
        ['advanceAccount', 'acc-model', 'google', 'gemini-99-unknown'],
      ], `code=${code} must mark unsupported and advance account`)
    }
  })
})

test('route hints qualify only advertised collisions and preserve the leading slash', async () => {
  await withTempDshHome(async dir => {
    const cfg = { ...defaultConfig(), mcpBridge: true }
    const ctx = makeCallCtx('routing', dir, cfg)
    const makePrompt = async (names: string[], bridgeServer?: string) => (await buildPromptPlan({
      bridgeServer, options: { messages: [msg('user', '/plan')], model: 'test', provider: 'antigravity',
        tools: names.map(name => ({ name, description: '', parameters: {} })) },
      cfg, ctx, policy: purposePolicy(ctx), account: undefined, model: 'test', activeModel: 'test',
      deps: { store: new SessionStore(join(dir, 'sessions.json')), getActiveRun: () => undefined,
        recentlyCompactedSessions: new Map(), deliverContext: async () => '' },
    })).prompt
    const server = 'dsh-tools-4242'
    const names = ['send_message', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'schedule', 'swarm',
      'run_workflow', 'read_file', 'write_file', 'edit_file', 'run_command']
    const all = await makePrompt(names, server)
    assert.ok(all.startsWith('/plan'))
    for (const name of names) assert.ok(all.includes(name))
    assert.match(all, /MUST use MCP server dsh-tools-4242.*Never call AGY's same-named built-in/)
    cfg.mcpBridgeScope = 'host-only'
    cfg.mcpToolAllowlist = 'read_file,send.message,send_message,read_ticket'
    const filtered = await makePrompt(['read_file', 'send.message', 'send_message', 'schedule'], server)
    assert.match(filtered, /send_message \(MCP name send_message__2\)/)
    assert.doesNotMatch(filtered, /read_file|schedule/)
    const generic = await makePrompt(['read_ticket'], server)
    assert.match(generic, /advertised tool names/)
    assert.doesNotMatch(generic, /MUST/)
    assert.equal(await makePrompt(['read_file'], server), '/plan')
    assert.equal(await makePrompt(['send_message']), '/plan')
  })
})
