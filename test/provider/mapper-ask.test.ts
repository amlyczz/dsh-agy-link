// The event mapper's side of issue #236: agy's `ask_question` over ACP becomes
// the host's `ask_user_question` at the result event, and is NOT cut into a
// mirror card on the way there (that card would ask the same thing twice).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { EventMapper } from '../../src/provider/mapper/event-mapper.ts'

type BlockEnd = Extract<StreamChunk, { type: 'block-end' }> & {
  block: { type: string; name?: string; id?: string; arguments?: string }
}

function mapAll(opts: Record<string, unknown>, events: unknown[]): StreamChunk[] {
  const mapper = new EventMapper(Object.assign({ runId: 'r_ask', cutOnTool: true }, opts) as ConstructorParameters<typeof EventMapper>[0])
  const out: StreamChunk[] = []
  let i = 0
  for (const ev of events) {
    out.push(...mapper.map(ev as never, i))
    i++
    if (mapper.isFinished) break
  }
  return out
}
const toolCalls = (chunks: StreamChunk[]): BlockEnd['block'][] =>
  chunks.filter((c): c is BlockEnd => c.type === 'block-end' && (c as BlockEnd).block?.type === 'tool-call').map((c) => c.block)
const finishOf = (chunks: StreamChunk[]): string => (chunks.find((c) => c.type === 'finish') as { reason: { kind: string } }).reason.kind

const ASK_ARGS = { questions: [{ question: '宿主架构？你倾向哪种？', options: ['(Recommended) 单机', '桌面常驻'], is_multi_select: false }] }
const acpTool = (callId: string, name: string, args: unknown, status: 'ACTIVE' | 'DONE'): unknown => ({
  kind: 'step',
  stepKey: callId,
  stepKind: 'tool',
  state: status,
  text: '',
  conversationId: 'c1',
  tool: { name, args, ...(status === 'DONE' ? { output: '' } : {}) },
  raw: { sessionUpdate: status === 'DONE' ? 'tool_call_update' : 'tool_call', toolCallId: callId, name },
})
const askTurn = (between: unknown[] = []): unknown[] => [
  { kind: 'init', conversationId: 'c1', raw: {} },
  acpTool('call-7', 'ask_question', ASK_ARGS, 'ACTIVE'),
  acpTool('call-7', 'ask_question', ASK_ARGS, 'DONE'),
  { kind: 'step', stepKey: 't1', stepKind: 'text', text: '宿主架构？你倾向哪种？', conversationId: 'c1' },
  ...between,
  { kind: 'result', conversationId: 'c1', ok: true, response: '', usage: {} },
]

test('a span ending on an ACP ask synthesises ask_user_question instead of cutting a mirror card', () => {
  const chunks = mapAll({ supportsAskUser: 'direct' }, askTurn())
  const calls = toolCalls(chunks)
  assert.equal(calls.length, 1)
  const ask = calls[0]
  assert.ok(ask)
  assert.equal(ask.name, 'ask_user_question')
  assert.ok(String(ask.id).startsWith('agytc-bridge-ask-'))
  assert.deepEqual(JSON.parse(String(ask.arguments)), {
    questions: [{ id: 'q1', question: '宿主架构？你倾向哪种？', options: [{ label: '(Recommended) 单机' }, { label: '桌面常驻' }] }],
  })
  assert.equal(finishOf(chunks), 'tool-calls')
  // agy's own rendering of the question still precedes the card.
  assert.ok(chunks.some((c) => c.type === 'text-delta' && (c as { text: string }).text.includes('宿主架构')))
})

test('without the host tool the ask step keeps today\'s behaviour: a mirror card', () => {
  const chunks = mapAll({}, askTurn())
  const calls = toolCalls(chunks)
  assert.equal(calls.length, 1)
  assert.ok(calls[0])
  assert.equal(calls[0].name, 'agy_tool')
  assert.equal(finishOf(chunks), 'tool-calls')
})

test('under PTC the question travels inside run_code', () => {
  const calls = toolCalls(mapAll({ supportsAskUser: 'run_code', useCodeWrapper: true }, askTurn()))
  assert.equal(calls.length, 1)
  const wrapped = calls[0]
  assert.ok(wrapped)
  assert.equal(wrapped.name, 'run_code')
  assert.ok(String(wrapped.id).startsWith('agytc-bridge-ask-'))
  assert.match(String(wrapped.arguments), /tools\['ask_user_question'\]/)
})

test('a CLI-shaped ask, or an ask that agy moved past, synthesises nothing', () => {
  const cliAsk = askTurn().map((ev) =>
    ev && typeof ev === 'object' && (ev as { raw?: { sessionUpdate?: string } }).raw?.sessionUpdate
      ? { ...(ev as object), raw: { type: 'tool_use', name: 'ask_question' } }
      : ev)
  const cli = mapAll({ supportsAskUser: 'direct', cutOnTool: false }, cliAsk)
  assert.equal(toolCalls(cli).some((b) => b.name === 'ask_user_question'), false)
  assert.notEqual(finishOf(cli), 'tool-calls')

  const movedOn = mapAll(
    { supportsAskUser: 'direct', cutOnTool: false },
    askTurn([acpTool('call-9', 'run_command', { command: 'ls' }, 'DONE')]),
  )
  assert.equal(toolCalls(movedOn).some((b) => b.name === 'ask_user_question'), false)
  assert.notEqual(finishOf(movedOn), 'tool-calls')
})

test('a question is never a finished goal: the ask wins over update_goal', () => {
  const calls = toolCalls(mapAll({ supportsAskUser: 'direct', supportsGoalUpdate: true, goalContext: { goalId: 'g1', revision: 1 } }, askTurn()))
  assert.deepEqual(calls.map((b) => b.name), ['ask_user_question'])
})
