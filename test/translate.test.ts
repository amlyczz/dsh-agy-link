import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TranslationService,
  allTextOfTurn,
  buildTranslationPrompt,
  buildTranslationRequest,
  chunkText,
  completedTurns,
  finalAnswerOfTurn,
  findTranslationRecord,
  isTurnRunning,
  lastCompletedTurn,
  buildTranslationSetup,
  resolveTranslateTarget,
  sessionDigest,
  sessionEvents,
  turnOfMessage,
  type SessionEventLike,
  type TranslationRecord,
} from '../src/host/translate.ts'
import { defaultConfig } from '../src/common/types.ts'
import type { Catalog } from '../src/host/models.ts'

const catalog: Catalog = {
  source: 'fallback',
  discoveredAt: 0,
  models: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: null },
  ],
}

function messageIdOfTest(ev: SessionEventLike): string | undefined {
  const d = (ev as { data?: { message?: { id?: string } } }).data
  return d?.message?.id
}

function assistant(turn: number, step: number, text: string, model = 'auto/deepseek-v4.1-flash', id = `m-${turn}-${step}`): SessionEventLike {
  return {
    type: 'assistant/message',
    seq: turn * 100 + step,
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        id,
        content: text === '' ? [{ type: 'tool-call' }] : [{ type: 'text', text }],
        source: { kind: 'model', provider: 'magpie', model },
      },
    },
  }
}

const log: SessionEventLike[] = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { turn: 1, message: { role: 'user', id: 'u-1-1', content: [{ type: 'text', text: '把翻译功能做好' }] } } },
  assistant(1, 1, '先看下代码。'),
  assistant(1, 2, ''),
  assistant(1, 3, '最终答复：构建通过。'),
  { type: 'turn/end', seq: 110, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 111, data: { turn: 2 } },
  { type: 'user/message', seq: 112, data: { turn: 2, message: { role: 'user', id: 'u-2-1', content: [{ type: 'text', text: '再修 hover' }] } } },
  assistant(2, 1, ''),
  assistant(2, 2, '第二个回合的答案。'),
]

test('prompt asks for plain speech at the real content volume', () => {
  const p = buildTranslationPrompt('原文内容', '中文（简体）', 4000)
  assert.match(p, /讲成大白话/)
  assert.match(p, /中文（简体）/)
  assert.match(p, /别用行话/)
  assert.match(p, /该长就长/)
  assert.match(p, /别改原意/)
  assert.match(p, /<content>\n原文内容\n<\/content>/)
  // The rule list that produced headings and bullet lists is gone.
  assert.doesNotMatch(p, /结论先行/)
  assert.doesNotMatch(p, /输出 Markdown/)
  assert.doesNotMatch(p, /^\d\. /m)
  // Short source: no length talk at all. Long source: a "finish it" hint, NOT
  // the old "挑重点" compression ask — the reader wants the real volume.
  assert.doesNotMatch(p, /原文比较长/)
  const long = buildTranslationPrompt('x'.repeat(5_000), '中文（简体）', 8_000)
  assert.match(long, /原文比较长/)
  assert.match(long, /一步步讲完/)
  assert.doesNotMatch(long, /挑重点/)
  assert.doesNotMatch(long, /输出 Markdown/)
  // The DSH session id is an anchor for "which thread is this", not history:
  // it only appears when the caller knows it.
  assert.doesNotMatch(p, /DSH 会话/)
  assert.match(buildTranslationPrompt('原文', '中文（简体）', 4000, 's1'), /DSH 会话 s1/)
})

test('prompt pins the model to THIS message and to spoken register', () => {
  // The reader complained the output was complete but too professional, so the
  // instruction names the ONE reply it must explain, spells out the spoken
  // register, and forbids compressing the real content volume.
  const p = buildTranslationPrompt('原文内容', '中文（简体）', 4000)
  assert.match(p, /当前这一条 AI 回复/)
  assert.match(p, /只讲这一条回复/)
  assert.match(p, /该长就长/)
  assert.match(p, /首先 \/ 其次|别写成标题/)
  // A bound conversation hears the persona once; the per-turn request must carry
  // the same pinning, or the model happily re-translates an earlier answer.
  const b = buildTranslationRequest('原文内容', '中文（简体）', 4000)
  assert.match(b, /当前这一条 AI 回复/)
  assert.match(b, /讲成大白话/)
  assert.match(b, /只讲这一条/)
  assert.match(b, /<content>\n原文内容\n<\/content>/)
  assert.match(b, /只输出讲解本身/)
  assert.doesNotMatch(b, /^\d\. /m)
  assert.match(buildTranslationRequest('x'.repeat(9_000), '中文（简体）', 8_000), /原文比较长/)
})

test('chunkText never exceeds the cap and keeps every paragraph', () => {
  const text = ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(20)].join('\n\n')
  const chunks = chunkText(text, 400)
  assert.ok(chunks.length >= 2)
  for (const c of chunks) assert.ok(c.length <= 400, 'chunk too long: ' + c.length)
  assert.equal(chunks.join('\n\n').replace(/\n+/g, ''), text.replace(/\n+/g, ''))
})

test('short text is one chunk', () => {
  assert.deepEqual(chunkText('hello', 8000), ['hello'])
})

test('finalAnswerOfTurn picks the last assistant message that actually has text', () => {
  const answer = finalAnswerOfTurn(log, 1)
  assert.equal(answer?.text, '最终答复：构建通过。')
  assert.equal(answer?.anchorSeq, 103)
  assert.equal(answer?.messageId, 'm-1-3')
  assert.equal(answer?.sourceModel, 'auto/deepseek-v4.1-flash')
})

test('allTextOfTurn joins every text block of the turn', () => {
  const answer = allTextOfTurn(log, 1)
  assert.equal(answer?.text, '先看下代码。\n\n最终答复：构建通过。')
})

test('completedTurns ignores unfinished turns and reports running state', () => {
  assert.deepEqual(completedTurns(log), [1])
  assert.equal(lastCompletedTurn(log), 1)
  assert.equal(isTurnRunning(log, 2), true)
  assert.equal(isTurnRunning(log, 1), false)
  assert.equal(lastCompletedTurn([]), null)
})

test('turnOfMessage maps a message id back to its turn', () => {
  const located = turnOfMessage(log, 'm-2-2')
  assert.equal(located?.turn, 2)
  assert.equal(located?.text, '第二个回合的答案。')
  assert.equal(turnOfMessage(log, 'nope'), null)
})

test('resolveTranslateTarget defaults to gemini-3.8-flash medium', () => {
  const cfg = defaultConfig()
  const t = resolveTranslateTarget(cfg, catalog)
  assert.equal(t.model, 'gemini-3.8-flash')
  assert.equal(t.effort, 'medium')
})

test('resolveTranslateTarget falls back to the newest flash when 3.8 is absent', () => {
  const cfg = defaultConfig()
  const without38: Catalog = { ...catalog, models: catalog.models.filter((m) => m.id !== 'gemini-3.8-flash') }
  const t = resolveTranslateTarget(cfg, without38)
  assert.equal(t.model, 'gemini-3.7-flash')
})

test('resolveTranslateTarget honours an explicit unlisted override', () => {
  const cfg = defaultConfig()
  const t = resolveTranslateTarget(cfg, catalog, { model: 'claude-sonnet-4-6', effort: 'medium' })
  assert.equal(t.model, 'claude-sonnet-4-6')
  // claude has no selectable efforts → empty effort (no --effort flag)
  assert.equal(t.effort, '')
})

test('resolveTranslateTarget clamps an unsupported effort to the model default', () => {
  const cfg = defaultConfig()
  const t = resolveTranslateTarget(cfg, catalog, { effort: 'banana' })
  assert.equal(t.model, 'gemini-3.8-flash')
  // An unknown explicit level is unsupported, so the model default (cfg.defaultEffort) wins.
  assert.equal(t.effort, 'high')
})

interface RunnerCall {
  prompt: string
  model: string
  effort?: string
  text?: string
  setup?: string
}

function makeService(options: {
  runs: Array<{ ok: boolean; text?: string; code?: string; error?: string }>
  autoEnabled?: (id: string) => boolean
  cfg?: ReturnType<typeof defaultConfig>
  onRun?: (call: RunnerCall) => void
}) {
  const calls: RunnerCall[] = []
  const records: Array<{ sessionId: string; record: TranslationRecord }> = []
  // Records are appended to the session log the same way the host does, so the
  // dedupe path (findTranslationRecord) sees what a real session would.
  const events: SessionEventLike[] = [...log]
  const cfg = options.cfg ?? defaultConfig()
  let index = 0
  const service = new TranslationService({
    cfg: () => cfg,
    catalog: () => catalog,
    getSession: (id) => (id === 's1' ? { id: 's1', log: events } : undefined),
    sessionCwd: (id) => (id === 's1' ? '/work/project' : undefined),
    sessionLogPath: (id) => (id === 's1' ? '/dsh/sessions/-work-project-/session-s1/session.v4.jsonl.zstd' : undefined),
    run: async (req) => {
      calls.push({
        prompt: req.prompt,
        model: req.model,
        ...(req.effort === undefined ? {} : { effort: req.effort }),
        ...(req.text === undefined ? {} : { text: req.text }),
        ...(req.setup === undefined ? {} : { setup: req.setup }),
      })
      options.onRun?.(calls[calls.length - 1]!)
      const next = options.runs[Math.min(index, options.runs.length - 1)]!
      index++
      return { ok: next.ok, text: next.text ?? '', ...(next.code === undefined ? {} : { code: next.code }), ...(next.error === undefined ? {} : { error: next.error }), accountId: 'acc_a', durationMs: 5 }
    },
    appendRecord: (sessionId, record) => {
      records.push({ sessionId, record })
      events.push({ type: 'plugin:agy-link/translation', seq: 42, data: record as unknown })
      return 42
    },
    ...(options.autoEnabled === undefined ? {} : { autoEnabled: options.autoEnabled }),
    now: (() => {
      let t = 1_000
      return () => (t += 10)
    })(),
  })
  return { service, calls, records, cfg }
}

test('successful translation is cached and a force bypasses the cache', async () => {
  const { service, calls } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const first = await service.translate({ text: '一段黑话' })
  assert.equal(first.ok, true)
  assert.equal(first.text, '人话版')
  assert.equal(first.cached, false)
  const second = await service.translate({ text: '一段黑话' })
  assert.equal(second.cached, true)
  assert.equal(calls.length, 1)
  await service.translate({ text: '一段黑话', force: true })
  assert.equal(calls.length, 2)
})

test('a quota failure is retried on the next account, then succeeds', async () => {
  const { service, calls } = makeService({
    runs: [
      { ok: false, code: 'RATE_LIMIT', error: 'quota reached' },
      { ok: false, code: 'RATE_LIMIT', error: 'quota reached' },
      { ok: true, text: '终于成功' },
    ],
  })
  const res = await service.translate({ text: 'x' })
  assert.equal(res.ok, true)
  assert.equal(res.text, '终于成功')
  // 1 attempt + 2 retries (config default translateRetries = 2)
  assert.equal(calls.length, 3)
})

test('a non-retryable failure stops immediately', async () => {
  const { service, calls } = makeService({ runs: [{ ok: false, code: 'AUX_DISABLED', error: 'aux off' }] })
  const res = await service.translate({ text: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'AUX_DISABLED')
  assert.equal(calls.length, 1)
})

test('exhausted quota maps to NO_ACCOUNT', async () => {
  const { service } = makeService({ runs: [{ ok: false, code: 'RATE_LIMIT', error: 'quota' }] })
  const res = await service.translate({ text: 'x' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'NO_ACCOUNT')
  assert.match(res.error ?? '', /quota/i)
})

test('the bound translation conversation gets a persona once and a per-turn request after', async () => {
  // One agy conversation per DSH session: the setup carries WHO agy is, which
  // session it serves, that session's workspace, where its history lives and how
  // to read it, plus a bounded digest. Every later turn then sends the per-turn
  // request line wrapped around the source — NOT the bare source — because a
  // bound conversation has no instruction left after its first turn, and the bare
  // text let the model wander off to an earlier reply.
  const { service, calls } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const res = await service.translate({ text: '一段黑话', sessionId: 's1' })
  assert.equal(res.ok, true)
  const call = calls[0]!
  assert.match(call.text!, /当前这一条 AI 回复/, 'the request names the reply it must explain')
  assert.match(call.text!, /<content>\n一段黑话\n<\/content>/, 'the source rides inside the request')
  const setup = call.setup ?? ''
  assert.match(setup, /人话翻译器/)
  assert.match(setup, /DSH 会话 id：s1/)
  assert.match(setup, /只把需要翻译的原文发给你/)
  assert.match(setup, /\/work\/project/, 'agy is told the session workspace')
  assert.match(setup, /session\.v4\.jsonl\.zstd/, 'and where the raw session log is')
  assert.match(setup, /zstd -dc/, 'and how to read it')
  assert.match(setup, /<digest>[\s\S]*用户：/, 'with a digest of the asks so the first reply has context')
  assert.match(setup, /「当前这一条」AI 回复/, 'the persona pins the clicked message too')
  // The self-contained prompt still exists for hosts that do NOT bind.
  assert.match(call.prompt, /讲成大白话/)
  assert.match(call.prompt, /<content>\n一段黑话\n<\/content>/)
})

test('sessionDigest keeps asks and answers, newest first, bounded', () => {
  const d = sessionDigest(log, 8_000)
  assert.match(d, /用户：/)
  assert.match(d, /回复：/)
  assert.ok(d.indexOf('最终答复：构建通过。') >= 0, 'the answers are in there')
  const tight = sessionDigest(log, 400)
  assert.ok(tight.length <= 400 + 20, 'bounded, got ' + tight.length)
})

test('empty text short-circuits without a model call', async () => {
  const { service, calls } = makeService({ runs: [{ ok: true, text: 'unused' }] })
  const res = await service.translate({ text: '   ' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'EMPTY_TEXT')
  assert.equal(calls.length, 0)
})

test('an empty model response is retried and the retry wins', async () => {
  // Regression: agy/Gemini occasionally finishes a clean `stop` with no text at
  // all (25s, no error envelope). That used to surface as a generic AGY_ERROR
  // and the user just saw a failed translation; it is transient, so it now has
  // its own code and rides the bounded retry.
  const { service, calls } = makeService({
    runs: [
      { ok: false, code: 'EMPTY_RESPONSE', error: 'the translate model returned no text (finish: stop)' },
      { ok: true, text: '人话版' },
    ],
  })
  const res = await service.translate({ text: '一段黑话' })
  assert.equal(res.ok, true)
  assert.equal(res.text, '人话版')
  assert.equal(calls.length, 2, 'the empty response must be re-asked once')
})

test('translateTurn appends a durable record anchored at the final message', async () => {
  const { service, records } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const res = await service.translateTurn('s1', 1)
  assert.equal(res.ok, true)
  assert.equal(res.recordSeq, 42)
  assert.equal(records.length, 1)
  const rec = records[0]!.record
  assert.equal(records[0]!.sessionId, 's1')
  assert.equal(rec.turn, 1)
  assert.equal(rec.anchorSeq, 103)
  assert.equal(rec.messageId, 'm-1-3')
  assert.equal(rec.model, 'gemini-3.8-flash')
  assert.equal(rec.effort, 'medium')
  assert.equal(rec.provider, 'antigravity')
  assert.equal(rec.text, '人话版')
})

test('a cached hit never inherits another call\'s turn/record metadata', async () => {
  const { service } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const first = await service.translateTurn('s1', 1)
  assert.equal(first.recordSeq, 42)
  assert.equal(first.turn, 1)
  // Same source text + target → served from cache, but as a plain text call it
  // must not claim turn 1 or a record seq (the card already owns that).
  const second = await service.translate({ text: '最终答复：构建通过。' })
  assert.equal(second.cached, true)
  assert.equal(second.turn, undefined)
  assert.equal(second.recordSeq, undefined)
})

test('a turn already translated with the same recipe is served from its durable record', async () => {
  const { service, calls, records } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const first = await service.translateTurn('s1', 1)
  assert.equal(first.ok, true)
  assert.equal(first.recordSeq, 42)
  const second = await service.translateTurn('s1', 1)
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(second.recordSeq, 42, 'the existing card is handed back, not a new one')
  assert.equal(second.text, '人话版')
  assert.equal(calls.length, 1, 'no second model call')
  assert.equal(records.length, 1, 'no duplicate record')
  // An explicit force still re-runs and appends a fresh record.
  const forced = await service.translateTurn('s1', 1, { force: true })
  assert.equal(forced.cached, false)
  assert.equal(calls.length, 2)
})

test('translateTurn refuses a still-running turn', async () => {
  const { service, calls } = makeService({ runs: [{ ok: true, text: 'x' }] })
  const res = await service.translateTurn('s1', 2)
  assert.equal(res.ok, false)
  assert.equal(res.code, 'TRANSIENT')
  assert.equal(calls.length, 0)
})

test('translateMessage resolves the owning turn', async () => {
  const { service, records } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const res = await service.translateMessage('s1', 'm-1-3')
  assert.equal(res.ok, true)
  assert.equal(records[0]!.record.turn, 1)
})

test('autoTranslateTurn is skipped when the switch is off', async () => {
  const { service, calls } = makeService({ runs: [{ ok: true, text: 'x' }] })
  const res = await service.autoTranslateTurn('s1', 1)
  assert.equal(res, null)
  assert.equal(calls.length, 0)
})

test('autoTranslateTurn skips a turn already produced by the translate model', async () => {
  // Rewrite by identity, not by index: the fixture gained a user event and a
  // positional edit silently retargeted the wrong message.
  const events = log.map((ev) => (ev.type === 'assistant/message' && messageIdOfTest(ev) === 'm-1-3'
    ? assistant(1, 3, 'Gemini 自己的输出', 'gemini-3.8-flash')
    : ev))
  let runs = 0
  const service = new TranslationService({
    cfg: () => defaultConfig(),
    catalog: () => catalog,
    getSession: (id) => (id === 's1' ? { id: 's1', log: events } : undefined),
    run: async () => {
      runs++
      return { ok: true, text: 'x' }
    },
    autoEnabled: () => true,
  })
  assert.equal(await service.autoTranslateTurn('s1', 1), null)
  assert.equal(runs, 0)
})

test('translateMessage falls back to lastCompletedTurn when message is unindexed', async () => {
  const { service, records } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const res = await service.translateMessage('s1', 'unknown-msg-id')
  assert.equal(res.ok, true)
  assert.equal(records[0]!.record.turn, 1)
})

test('sessionEvents reads from snapshotEvents and ownEvents', () => {
  assert.equal(sessionEvents({ snapshotEvents: () => log } as any).length, log.length)
  assert.equal(sessionEvents({ ownEvents: () => log } as any).length, log.length)
})

test('existingMessage answers the reply button so a finished card survives a remount', async () => {
  const { service } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  // Nothing stored yet: the button must stay idle.
  assert.equal(service.existingMessage('s1', 'm-1-3'), null)
  assert.equal(service.isPending('s1'), false)
  // Translate, which persists a record carrying messageId = m-1-3.
  await service.translateMessage('s1', 'm-1-3')
  const existing = service.existingMessage('s1', 'm-1-3')
  assert.ok(existing, 'the stored translation must be found by message id')
  assert.equal(existing!.text, '人话版')
  assert.equal(existing!.model, 'gemini-3.8-flash')
})

test('autoTranslateTurn translates and persists when enabled', async () => {
  const { service, records } = makeService({ runs: [{ ok: true, text: '人话版' }], autoEnabled: () => true })
  const res = await service.autoTranslateTurn('s1', 1)
  assert.equal(res?.ok, true)
  assert.equal(records.length, 1)
})

test('translateMessage explains the CLICKED message, not the turn final answer', async () => {
  // Turn 1 holds three assistant events: prose at seq 101, a tool-only step at
  // 102 and the real answer at 103. Clicking the early prose used to resolve
  // through `finalAnswerOfTurn` and return the *last* one — the exact "I clicked
  // this reply but got another one" complaint.
  const { service, calls, records } = makeService({ runs: [{ ok: true, text: '人话版' }] })
  const res = await service.translateMessage('s1', 'm-1-1')
  assert.equal(res.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.text ?? '', /先看下代码/)
  assert.doesNotMatch(calls[0]!.text ?? '', /最终答复/)
  assert.equal(records[0]!.record.messageId, 'm-1-1')
  assert.equal(records[0]!.record.anchorSeq, 101, 'the card lands under the clicked message')
  assert.equal(records[0]!.record.turn, 1)
})

test('dedupe is message-scoped: siblings in one turn translate independently', async () => {
  const { service, calls, records } = makeService({ runs: [{ ok: true, text: '第一版' }, { ok: true, text: '第二版' }] })
  const first = await service.translateMessage('s1', 'm-1-1')
  assert.equal(first.ok, true)
  // The turn already owns a record (for m-1-1); m-1-3 must NOT be served it.
  const second = await service.translateMessage('s1', 'm-1-3')
  assert.equal(second.ok, true)
  assert.equal(second.cached, false, 'a sibling message is not a cache hit')
  assert.equal(second.text, '第二版')
  assert.equal(calls.length, 2, 'both messages reached the model')
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((r) => r.record.messageId), ['m-1-1', 'm-1-3'])
  // Clicking the same message again is still deduped.
  const again = await service.translateMessage('s1', 'm-1-1')
  assert.equal(again.cached, true)
  assert.equal(again.recordSeq, 42)
  assert.equal(calls.length, 2)
})

test('long source is split into paragraph chunks and the parts are joined', async () => {
  const { service, calls } = makeService({ runs: [{ ok: true, text: '第一段人话' }, { ok: true, text: '第二段人话' }] })
  const long = ('甲'.repeat(3_000) + '\n\n' + '乙'.repeat(3_000) + '\n\n' + '丙'.repeat(3_000))
  const res = await service.translate({ text: long })
  assert.equal(res.ok, true)
  assert.equal(calls.length, 2, '9000 chars over the 8000 cap → two chunks')
  assert.equal(res.text, '第一段人话\n\n第二段人话')
})

test('findTranslationRecord scopes by messageId and honours legacy turn records', async () => {
  const events: SessionEventLike[] = [
    { type: 'plugin:agy-link/translation', seq: 10, data: { turn: 1, messageId: 'a', text: 'A 的人话', model: 'gemini-3.8-flash', effort: 'medium' } },
    { type: 'plugin:agy-link/translation', seq: 11, data: { turn: 1, messageId: 'b', text: 'B 的人话', model: 'gemini-3.8-flash', effort: 'medium' } },
  ]
  assert.equal(findTranslationRecord(events, 1, undefined, undefined, 'a')?.text, 'A 的人话')
  assert.equal(findTranslationRecord(events, 1, undefined, undefined, 'b')?.text, 'B 的人话')
  assert.equal(findTranslationRecord(events, 1, undefined, undefined, 'missing'), null)
  // Turn-level lookups (the /tsl command) still take the newest record.
  assert.equal(findTranslationRecord(events, 1)?.text, 'B 的人话')
  // A record written before messageId existed is a fallback only while the turn
  // has no message-scoped record at all.
  const legacyOnly: SessionEventLike[] = [
    { type: 'plugin:agy-link/translation', seq: 20, data: { turn: 2, text: '老译文', model: 'gemini-3.8-flash', effort: 'medium' } },
  ]
  assert.equal(findTranslationRecord(legacyOnly, 2, undefined, undefined, 'x')?.text, '老译文')
  const mixed: SessionEventLike[] = [...legacyOnly, { type: 'plugin:agy-link/translation', seq: 21, data: { turn: 2, messageId: 'y', text: '新译文', model: 'gemini-3.8-flash', effort: 'medium' } }]
  assert.equal(findTranslationRecord(mixed, 2, undefined, undefined, 'x'), null)
  assert.equal(findTranslationRecord(mixed, 2, undefined, undefined, 'y')?.text, '新译文')
})
