// agy's `ask_question`, asked through DSH's native question card (issue #236).
//
// Over ACP, agy parks a question and ends the turn. The bridge used to show it
// as a generic tool card plus plain text, and the answer only reached agy if
// the user typed it as the next message. These are the pure rules of the
// bridge that replaces that: mapping the question, shaping the call, and
// reading the answer back.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  AGY_ASK_TOOL,
  ASK_BRIDGE_PREFIX,
  askAnswerPrompt,
  askQuestionsOfCall,
  buildAskUserToolCallBlock,
  classifyAskToolContinuation,
  isAcpAskStep,
  mapAgyQuestions,
  trailingAskQuestions,
} from '../../src/host/dsh-ask.ts'

const agyInput = {
  questions: [
    {
      question: '首先确定宿主架构：你倾向哪种运行形态？',
      options: ['(Recommended) 单机 CLI', '桌面常驻', '两者都要'],
      is_multi_select: false,
      header: '宿主架构',
    },
    { question: 'Any hard deadline?', is_multi_select: true },
    { question: '   ', options: ['never mapped'] },
    'not a question',
  ],
}
const acpAskStep = (state: 'ACTIVE' | 'DONE', args: unknown = agyInput): Parameters<typeof isAcpAskStep>[0] => ({
  kind: 'step',
  stepKind: 'tool',
  tool: { name: AGY_ASK_TOOL, args },
  raw: { sessionUpdate: state === 'DONE' ? 'tool_call_update' : 'tool_call', toolCallId: 'call-7', name: AGY_ASK_TOOL },
})

test('mapAgyQuestions maps agy questions onto the DSH schema and drops what is not a question', () => {
  const mapped = mapAgyQuestions(agyInput)
  assert.ok(mapped)
  assert.deepEqual(mapped, [
    { id: 'q1', question: '首先确定宿主架构：你倾向哪种运行形态？', header: '宿主架构', options: [{ label: '(Recommended) 单机 CLI' }, { label: '桌面常驻' }, { label: '两者都要' }] },
    { id: 'q2', question: 'Any hard deadline?', multi_select: true },
  ])
  assert.equal(mapAgyQuestions(undefined), null)
  assert.equal(mapAgyQuestions({}), null)
  assert.equal(mapAgyQuestions({ questions: [] }), null)
  assert.equal(mapAgyQuestions({ questions: [{ question: ' ' }, 'x'] }), null, 'nothing usable')
  // agy has been seen to title a question instead of heading it.
  assert.deepEqual(mapAgyQuestions({ questions: [{ question: 'Q?', title: 'Title' }] }), [{ id: 'q1', question: 'Q?', header: 'Title' }])
})

test('isAcpAskStep recognises only agy asking over ACP', () => {
  assert.equal(isAcpAskStep(acpAskStep('ACTIVE')), true)
  assert.equal(isAcpAskStep(acpAskStep('DONE')), true)
  // The CLI's print mode auto-answers ask_question ("User Skipped"): there is no
  // pending question to deliver an answer to, so its steps are not asks.
  assert.equal(isAcpAskStep({ ...acpAskStep('DONE'), raw: { type: 'tool_use', name: AGY_ASK_TOOL } }), false)
  assert.equal(isAcpAskStep({ ...acpAskStep('DONE'), raw: undefined }), false)
  assert.equal(isAcpAskStep({ ...acpAskStep('DONE'), tool: { name: 'run_command', args: {} } }), false)
  assert.equal(isAcpAskStep({ kind: 'result' }), false)
})

test('trailingAskQuestions yields the questions only for a mappable ACP ask', () => {
  const step = acpAskStep('DONE')
  assert.equal(trailingAskQuestions(step)?.length, 2)
  assert.equal(trailingAskQuestions(acpAskStep('DONE', { questions: [] })), null)
  assert.equal(trailingAskQuestions({ ...step, tool: { name: 'run_command', args: agyInput } }), null)
  assert.equal(trailingAskQuestions({ ...step, raw: { type: 'tool_use' } }), null)
})

test('buildAskUserToolCallBlock keeps the bridge call id and wraps for run_code under PTC', () => {
  const questions = mapAgyQuestions(agyInput)!
  const direct = buildAskUserToolCallBlock(questions, 0, 'direct')
  const block = (direct[1] as { block: { id: string; name: string; arguments: string } }).block
  assert.equal(block.name, 'ask_user_question')
  assert.ok(block.id.startsWith(ASK_BRIDGE_PREFIX))
  assert.deepEqual(JSON.parse(block.arguments), { questions })

  const wrapped = buildAskUserToolCallBlock(questions, 3, 'run_code')
  const wblock = (wrapped[1] as { block: { id: string; name: string; arguments: string } }).block
  assert.equal(wblock.name, 'run_code')
  assert.ok(wblock.id.startsWith(ASK_BRIDGE_PREFIX), 'the continuation scan keys on this prefix')
  const args = JSON.parse(wblock.arguments) as { code: string; description: string }
  assert.ok(args.code.includes("await tools['ask_user_question']("))
  assert.match(args.code, /console\.log\(JSON\.stringify\(/, 'the answer reaches the tool-result text')
  assert.doesNotMatch(args.code, /^\s*return\b/m)
  assert.match(args.description, /首先确定宿主架构/)
})

const askResult = (callId: string, text: string): Message => ({
  role: 'user',
  content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
  source: { kind: 'tool', callId },
}) as unknown as Message
const CALL = ASK_BRIDGE_PREFIX + 'abc'

test('classifyAskToolContinuation reads the answer, the timeout and the skip', () => {
  assert.equal(classifyAskToolContinuation([]), 'none')
  assert.equal(classifyAskToolContinuation([askResult('agytc-bridge-plan-1', '{"approved":true}')]), 'none', 'another bridge')
  assert.equal(classifyAskToolContinuation([askResult('call-9', '{"answers":[]}')]), 'none', 'a mirror result')
  // The host timed out: the questions stay answerable and a later reply arrives as a user message.
  assert.equal(classifyAskToolContinuation([askResult(CALL, '{"pending":true,"callId":"c","message":"No answer batch arrived before the timeout."}')]), 'pending')
  assert.equal(classifyAskToolContinuation([askResult(CALL, '{"answers":[{"id":"q1","selected":["桌面常驻"],"custom":"also note X"}]}')]), 'answered')
  assert.equal(classifyAskToolContinuation([askResult(CALL, '{"answers":[{"id":"q1","selected":[]},{"id":"q2","selected":[]}]}')]), 'skipped')
  assert.equal(classifyAskToolContinuation([askResult(CALL, 'plain text the host chose')]), 'answered', 'not JSON: the text is the answer')
  // The call itself failed (tool missing, rejected): that text is not an answer.
  const failed: Message = {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: CALL, isError: true, content: [{ type: 'text', text: 'Tool ask_user_question not found' }] }],
    source: { kind: 'tool', callId: CALL },
  } as unknown as Message
  assert.equal(classifyAskToolContinuation([failed]), 'pending', 'nothing may be forwarded as an answer')
})

test('askAnswerPrompt is readable lines for agy, never raw JSON', () => {
  const questions = mapAgyQuestions(agyInput)!
  assert.equal(
    askAnswerPrompt('{"answers":[{"id":"q1","selected":["桌面常驻","两者都要"]},{"id":"q2","selected":[],"custom":"next Friday"}]}', questions),
    'Q1: 首先确定宿主架构：你倾向哪种运行形态？\nA1: 桌面常驻; 两者都要\n\nQ2: Any hard deadline?\nA2: next Friday',
  )
  assert.equal(
    askAnswerPrompt('{"answers":[{"id":"q1","selected":["A"],"custom":"but keep it simple"}]}', questions),
    'Q1: 首先确定宿主架构：你倾向哪种运行形态？\nA1: A — but keep it simple',
  )
  assert.equal(askAnswerPrompt('{"answers":[{"id":"q1","selected":[]},{"id":"q2","selected":[]}]}', questions), 'User Skipped')
  assert.equal(askAnswerPrompt('{"answers":[{"id":"q9","selected":["A"]}]}', questions), 'Q9: (question q9)\nA9: A', 'an id the bridge never asked still reads as an answer')
  assert.equal(askAnswerPrompt('free text', questions), 'free text')
})

test('askQuestionsOfCall finds the questions of the call that is being answered', () => {
  const questions = mapAgyQuestions(agyInput)!
  const call: Message = {
    role: 'assistant',
    content: [{ type: 'tool-call', id: CALL, name: 'ask_user_question', arguments: JSON.stringify({ questions }) }],
  } as unknown as Message
  assert.deepEqual(askQuestionsOfCall(CALL, [call, askResult(CALL, '{}')]), questions)
  assert.equal(askQuestionsOfCall('agytc-bridge-ask-other', [call]), null)
  assert.equal(askQuestionsOfCall(CALL, [{ ...call, content: [{ type: 'tool-call', id: CALL, name: 'ask_user_question', arguments: 'not json' }] } as unknown as Message]), null)
})
