// The adapter's side of issue #236: the answer to the bridge's question call
// is what agy receives as its next prompt — the prompt builder already sends a
// bridge tool result through instead of repeating the earlier human prompt —
// readable rather than raw JSON, and a timed-out question ends the hop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { collect, makeAdapter, opts } from '../helpers/adapter-fixtures.ts'

const CALL = 'agytc-bridge-ask-m3xabc-1'
const QUESTIONS = [{ id: 'q1', question: '宿主架构？你倾向哪种？', options: [{ label: '单机 CLI' }, { label: '桌面常驻' }] }]

function askTurn(resultText: string): Message[] {
  return [
    { role: 'user', content: '帮我把项目搭起来' } as unknown as Message,
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: CALL, name: 'ask_user_question', arguments: JSON.stringify({ questions: QUESTIONS }) }],
    } as unknown as Message,
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: CALL, content: [{ type: 'text', text: resultText }] }],
      source: { kind: 'tool', callId: CALL },
    } as unknown as Message,
  ]
}

async function run(messages: Message[], session: string): Promise<{ chunks: StreamChunk[]; prompt: string | null }> {
  const work = mkdtempSync(join(tmpdir(), 'agy-ask-adapter-'))
  const argsFile = join(work, 'args.json')
  const prevArgs = process.env.FAKE_AGY_ARGS_FILE
  const prevMode = process.env.FAKE_AGY_MODE
  try {
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    process.env.FAKE_AGY_MODE = 'ok'
    const { adapter } = makeAdapter()
    const chunks = await collect(adapter.stream(opts(messages, { sessionId: session as never, tools: [{ name: 'ask_user_question' }] as never })))
    let prompt: string | null = null
    if (existsSync(argsFile)) {
      const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
      const at = argv.indexOf('-p')
      prompt = at >= 0 ? (argv[at + 1] ?? null) : null
    }
    return { chunks, prompt }
  } finally {
    if (prevArgs === undefined) delete process.env.FAKE_AGY_ARGS_FILE
    else process.env.FAKE_AGY_ARGS_FILE = prevArgs
    if (prevMode === undefined) delete process.env.FAKE_AGY_MODE
    else process.env.FAKE_AGY_MODE = prevMode
    rmSync(work, { recursive: true, force: true })
  }
}

test('an answered question reaches agy as readable Q/A lines, never as the raw result JSON', async () => {
  const { prompt } = await run(askTurn('{"answers":[{"id":"q1","selected":["桌面常驻"],"custom":"越快越好"}]}'), 'sess-ask-answered')
  assert.ok(prompt !== null, 'agy must be called with the answer')
  assert.ok(prompt.includes('Q1: 宿主架构？你倾向哪种？'), prompt)
  assert.ok(prompt.includes('A1: 桌面常驻 — 越快越好'), prompt)
  assert.equal(prompt.includes('"answers"'), false, 'the host result object is not a prompt')
})

test('a skipped question forwards agy\'s own words for it', async () => {
  const { prompt } = await run(askTurn('{"answers":[{"id":"q1","selected":[]}]}'), 'sess-ask-skipped')
  assert.ok(prompt !== null)
  assert.ok(prompt.includes('User Skipped'), String(prompt))
  assert.equal(prompt.includes('"answers"'), false)
})

test('a question the user has not answered yet ends the hop without calling agy', async () => {
  const { chunks, prompt } = await run(askTurn('{"pending":true,"callId":"' + CALL + '","message":"No answer batch arrived before the timeout."}'), 'sess-ask-pending')
  assert.equal(prompt, null, 'nothing is sent to agy: the answer is still pending on the host side')
  const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string } } | undefined
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})
