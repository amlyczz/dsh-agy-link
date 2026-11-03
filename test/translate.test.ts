import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TranslationService,
  allTextOfTurn,
  buildTranslationPrompt,
  chunkText,
  completedTurns,
  finalAnswerOfTurn,
  isTurnRunning,
  lastCompletedTurn,
  resolveTranslateTarget,
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
  assistant(1, 1, '先看下代码。'),
  assistant(1, 2, ''),
  assistant(1, 3, '最终答复：构建通过。'),
  { type: 'turn/end', seq: 110, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 111, data: { turn: 2 } },
  assistant(2, 1, ''),
  assistant(2, 2, '第二个回合的答案。'),
]

test('prompt carries language, rules and the source text', () => {
  const p = buildTranslationPrompt('原文内容', '中文（简体）', 4000)
  assert.match(p, /人话翻译器/)
  assert.match(p, /中文（简体）/)
  assert.match(p, /不新增事实/)
  assert.match(p, /<output>\n原文内容\n<\/output>/)
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

test('resolveTranslateTarget defaults to gemini-3.8-flash high', () => {
  const cfg = defaultConfig()
  const t = resolveTranslateTarget(cfg, catalog)
  assert.equal(t.model, 'gemini-3.8-flash')
  assert.equal(t.effort, 'high')
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
  assert.equal(t.effort, 'high')
})

interface RunnerCall {
  prompt: string
  model: string
  effort?: string
}

function makeService(options: {
  runs: Array<{ ok: boolean; text?: string; code?: string; error?: string }>
  autoEnabled?: (id: string) => boolean
  cfg?: ReturnType<typeof defaultConfig>
  onRun?: (call: RunnerCall) => void
}) {
  const calls: RunnerCall[] = []
  const records: Array<{ sessionId: string; record: TranslationRecord }> = []
  const cfg = options.cfg ?? defaultConfig()
  let index = 0
  const service = new TranslationService({
    cfg: () => cfg,
    catalog: () => catalog,
    getSession: (id) => (id === 's1' ? { id: 's1', log } : undefined),
    run: async (req) => {
      calls.push({ prompt: req.prompt, model: req.model, ...(req.effort === undefined ? {} : { effort: req.effort }) })
      options.onRun?.(calls[calls.length - 1]!)
      const next = options.runs[Math.min(index, options.runs.length - 1)]!
      index++
      return { ok: next.ok, text: next.text ?? '', ...(next.code === undefined ? {} : { code: next.code }), ...(next.error === undefined ? {} : { error: next.error }), accountId: 'acc_a', durationMs: 5 }
    },
    appendRecord: (sessionId, record) => {
      records.push({ sessionId, record })
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

test('empty text short-circuits without a model call', async () => {
  const { service, calls } = makeService({ runs: [{ ok: true, text: 'unused' }] })
  const res = await service.translate({ text: '   ' })
  assert.equal(res.ok, false)
  assert.equal(res.code, 'EMPTY_TEXT')
  assert.equal(calls.length, 0)
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
  assert.equal(rec.effort, 'high')
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
  const events = [...log]
  events[3] = assistant(1, 3, 'Gemini 自己的输出', 'gemini-3.8-flash')
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

test('autoTranslateTurn translates and persists when enabled', async () => {
  const { service, records } = makeService({ runs: [{ ok: true, text: '人话版' }], autoEnabled: () => true })
  const res = await service.autoTranslateTurn('s1', 1)
  assert.equal(res?.ok, true)
  assert.equal(records.length, 1)
})
