// Prompt assembly and modes: argv vs stdin delivery, digest prefixes,
// first-contact ordering, system-prompt forwarding (review / title /
// opt-in), plan-mode argv, and the prompt-side helper predicates.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Message } from '@deepseek-ai/dsh-llm'
import { isRealUserMessage, isSyntheticHarnessMessage, latestUserTaskText } from '../../src/host/adapter.ts'
import { collect, makeAdapter, msg, opts, runTurn, waitFor, workDir } from '../helpers/adapter-fixtures.ts'

test('long prompts switch to --input-format stream-json on stdin (issue #14)', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-long.json')
  const stdinFile = join(workDir, 'stdin-long.txt')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_STDIN_FILE = stdinFile
  const longPrompt = 'L'.repeat(30_000)
  await runTurn(adapter, [msg('user', longPrompt)])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--input-format'), argv.slice(0, 20).join(' '))
  assert.ok(!argv.includes('-p'), 'prompt must not ride argv when over budget')
  // fake-agy may exit before the async stdin drain writes the file on some
  // platforms; the argv shape above is the portable assertion.
  process.env.FAKE_AGY_ARGS_FILE = join(workDir, 'args.json')
  delete process.env.FAKE_AGY_STDIN_FILE
})

test('short prompts still pass -p on argv', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-short.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'short question')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('-p'))
  assert.equal(argv[argv.indexOf('-p') + 1], 'short question')
  assert.ok(!argv.includes('--input-format'))
  process.env.FAKE_AGY_ARGS_FILE = join(workDir, 'args.json')
})

test('normal prompts are not polluted by keyword-driven recovery suffixes', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'recover the missing artifact')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.equal(prompt, 'recover the missing artifact')
  assert.ok(!prompt.includes('Recovery boundary'), 'no plugin-side prompt injection on missing/not-found keywords')
})

test('unbound follow-up turn gets a history digest prefix', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args3.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('assistant', 'earlier answer'), msg('user', 'follow up')])
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('[conversation so far]'))
  assert.ok(prompt.includes('follow up'))
})

test('an image-only follow-up never re-sends an older question as the task', async () => {
  const readImage = async (): Promise<Uint8Array> => new Uint8Array([1, 2, 3, 4])
  const { adapter, store } = makeAdapter({}, { readImage })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-imgonly.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await runTurn(adapter, [msg('user', 'FIRST-QUESTION')], { sessionId: 'sess-imgonly' as never })
  await waitFor(() => store.get('sess-imgonly'))
  const imgOnly = {
    role: 'user',
    content: [
      { type: 'text', text: '' },
      { type: 'image', attachment: { attachmentId: 'img-only-1', mediaType: 'image/png', byteLength: 4 } },
    ],
  } as unknown as Message
  await collect(adapter.stream(opts([msg('user', 'FIRST-QUESTION'), msg('assistant', 'partial'), imgOnly], { sessionId: 'sess-imgonly' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  // The newest message carries no text: falling back to the PREVIOUS question
  // made agy answer the wrong message outright (S2).
  assert.ok(!prompt.includes('FIRST-QUESTION'), `stale task leaked into the prompt: ${prompt.slice(0, 200)}`)
  assert.ok(prompt.includes('view_file'), 'the attached image must still be pointed at')
})

test('first-contact prompt leads with the live request (agy cuts the tail)', async () => {
  const { adapter } = makeAdapter({ contextTransferFileAboveBytes: 5_000_000 })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-live-head.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const history: Message[] = []
  for (let i = 0; i < 40; i++) {
    history.push(msg('user', 'earlier question ' + i))
    history.push(msg('assistant', 'earlier answer ' + i + ' ' + 'x'.repeat(500)))
  }
  history.push(msg('user', 'THE-LIVE-QUESTION'))
  await runTurn(adapter, history)
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.startsWith('[CURRENT REQUEST'), 'live request block must lead the prompt')
  assert.ok(
    prompt.indexOf('THE-LIVE-QUESTION') < prompt.indexOf('[conversation so far]'),
    'the live question must come before the digest',
  )
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 180_000, 'prompt must stay under agy single-message ceiling')
})

test('forwardSystemPrompt falls back to role: system message when options.system is omitted', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: true })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-sys-msg.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  await runTurn(adapter, [
    msg('system', 'You are a meticulous TypeScript expert.'),
    msg('user', 'Please write a test.'),
  ], { sessionId: 'sess-sys' as never })

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('System instructions:\nYou are a meticulous TypeScript expert.'), 'system message forwarded')
  assert.ok(prompt.includes('Please write a test.'))
})

// Hosts that ask a model to authorize a tool call put the entire output
// protocol in `options.system` — DSH's auto-review sends REVIEW_POLICY, which
// demands exactly one JSON object. Dropping it left the model with only the
// data sections, so it answered in prose and the host's JSON.parse threw
// ("Unexpected token 'B', \"Based on a\"... is not valid JSON"), denying the
// tool call instead of reviewing it. The fix forwards the policy for review
// calls even when the global opt-in is off. Regression for issue #50.
test('review calls forward the REVIEW_POLICY system prompt without the global opt-in', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: false })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-review-policy.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  const policy = 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.\nReturn exactly one JSON object and no other text.'
  await runTurn(adapter, [
    msg('user', 'ENVIRONMENT\n{"cwd":"/tmp/project"}\n\nPENDING_ACTION\n{"tool":"bash"}'),
  ], { sessionId: 'sess-review' as never, system: policy } as never)

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('System instructions:\n' + policy), 'review policy reaches the model')
  assert.ok(prompt.includes('PENDING_ACTION'), 'the review data sections are still present')
  assert.ok(prompt.startsWith('System instructions:'), 'the policy leads the prompt')
})

test('issue #113: DSH plan mode overrides a statically configured skip permission', async () => {
  const { adapter } = makeAdapter({ permissionMode: 'skip' })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-plan-mode.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  // One span is enough: the fake agy records argv at spawn time. Using
  // collect() directly avoids runTurn's tool-result replay (the plan-mode
  // bridge synthesizes an exit_plan_mode call that is not a mirror step).
  await collect(adapter.stream(opts(
    [msg('user', 'You are in plan mode. Plan the Redis cache change.')],
    { sessionId: 'sess-plan' as never, tools: [{ name: 'exit_plan_mode' }] as never },
  )))

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.equal(argv.includes('--dangerously-skip-permissions'), false, 'plan mode must not keep skip permissions')
  const idx = argv.indexOf('--mode')
  assert.ok(idx !== -1 && argv[idx + 1] === 'plan', 'agy must run read-only in --mode plan')
})

test('issue #136: a historical plan-mode mention does not downgrade skip permissions', async () => {
  // A tool result quoting source code that mentions plan mode used to make
  // isPlanMode() true forever, forcing `--mode plan` on ordinary turns: every
  // tool was then denied and the synthesized exit_plan_mode was rejected.
  const { adapter } = makeAdapter({ permissionMode: 'skip' })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-historical-plan.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  await collect(adapter.stream(opts(
    [
      msg('user', 'read that file'),
      { role: 'tool', toolCallId: 't1', content: 'const s = "You are in plan mode. Stay in plan mode"' } as never,
      msg('assistant', 'here it is'),
      msg('user', 'now run the tests'),
    ],
    { sessionId: 'sess-hist-plan' as never, tools: [{ name: 'exit_plan_mode' }] as never },
  )))

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--dangerously-skip-permissions'), 'skip must survive a historical mention')
  assert.equal(argv.includes('--mode'), false, 'no plan-mode flag on an ordinary turn')
})

test('session-title calls forward the system prompt and never force plan mode', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: false, permissionMode: 'skip' })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-session-title.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  const titleSystem = 'Create a concise title. Return only the title on one line, in plain text, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes.'
  await runTurn(adapter, [
    msg('user', 'Generate the session title from this JSON array of human messages:\n[{"seq":1,"text":"echo test"}]'),
  ], { sessionId: 'sess-title' as never, system: titleSystem, purpose: 'session-title' } as never)

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('System instructions:\n' + titleSystem), 'title instructions reach the model')
  assert.ok(prompt.startsWith('System instructions:'), 'the title policy leads the prompt')
  const modeIdx = argv.indexOf('--mode')
  if (modeIdx !== -1) assert.notEqual(argv[modeIdx + 1], 'plan', 'title call must not inject plan mode')
})

test('ordinary turns keep dropping the system prompt while the opt-in is off', async () => {
  const { adapter } = makeAdapter({ forwardSystemPrompt: false })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-no-system.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile

  await runTurn(adapter, [msg('user', 'what is in this repo?')], {
    sessionId: 'sess-no-sys' as never,
    system: 'You are a helpful coding agent.',
  } as never)

  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(!prompt.includes('System instructions:'), 'non-review turns stay unchanged')
  assert.equal(prompt, 'what is in this repo?')
})

test('auto-review calls with REVIEW_POLICY do not cut on tools and finish with stop', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const chunks = await collect(
    adapter.stream(
      opts([msg('user', 'review')], {
        system: 'REVIEW_POLICY\nYou are the final authorization reviewer for exactly one pending tool call.',
      }),
    ),
  )
  const toolCallChunks = chunks.filter(
    (c) =>
      (c.type === 'block-start' && (c as { blockType?: string }).blockType === 'tool-call') ||
      (c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call'),
  )
  assert.equal(toolCallChunks.length, 0)
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('calls with explicit empty tools: [] do not cut on tools and finish with stop', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const chunks = await collect(
    adapter.stream(
      opts([msg('user', 'no tools')], {
        tools: [],
      }),
    ),
  )
  const toolCallChunks = chunks.filter(
    (c) =>
      (c.type === 'block-start' && (c as { blockType?: string }).blockType === 'tool-call') ||
      (c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call'),
  )
  assert.equal(toolCallChunks.length, 0)
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('isSyntheticHarnessMessage and latestUserTaskText skip timing and reminder telemetry', () => {
  const timeMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Time sampled while preparing turn 28, step 22: 2026-10-10T16:15:54+05:00[Indian/Maldives]' }],
    source: { kind: 'time-context' },
  } as unknown as Message
  const reminderMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nSkill guidelines: ...</system-reminder>' }],
    source: { kind: 'system-reminder' },
  } as unknown as Message
  const runtimeMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
    source: { kind: 'runtime-context' },
  } as unknown as Message
  const realMsg: Message = {
    role: 'user',
    content: [{ type: 'text', text: '请帮我实现战斗系统' }],
    source: { kind: 'user' },
  } as unknown as Message

  assert.equal(isSyntheticHarnessMessage(timeMsg), true)
  assert.equal(isSyntheticHarnessMessage(reminderMsg), true)
  assert.equal(isSyntheticHarnessMessage(runtimeMsg), true)
  assert.equal(isSyntheticHarnessMessage(realMsg), false)

  assert.equal(isRealUserMessage(timeMsg), false)
  assert.equal(isRealUserMessage(reminderMsg), false)
  assert.equal(isRealUserMessage(runtimeMsg), false)
  assert.equal(isRealUserMessage(realMsg), true)

  // Trailing time-context messages must never overwrite or become the user task
  const history: Message[] = [realMsg, timeMsg]
  assert.equal(latestUserTaskText(history), '请帮我实现战斗系统')
  assert.equal(latestUserTaskText([timeMsg]), '')
})

test('prompt assembly uses real user task instead of trailing time context', async () => {
  const { adapter, argsFile } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const realMsg = msg('user', '换成激昂风格的背景音乐')
  const timeMsg = {
    role: 'user',
    content: [{ type: 'text', text: 'Time sampled while preparing turn 5, step 1: 2026-10-10T18:50:47+05:00' }],
    source: { kind: 'time-context' },
  } as unknown as Message

  await collect(adapter.stream(opts([realMsg, timeMsg], { sessionId: 'sess-real-task' as never })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const promptArg = argv[argv.length - 1]!
  assert.ok(promptArg.includes('换成激昂风格的背景音乐'), 'real user task must be present in prompt')
  assert.ok(!promptArg.includes('Time sampled while preparing'), 'synthetic timing context must not be appended to agy prompt')
})

test('plan approval continues execution via agy (drops --mode plan) while dismissal stops cleanly', async () => {
  const { adapter, store } = makeAdapter({ permissionMode: 'accept-edits' })
  store.set('sess-plan:primary', { conversationId: 'conv-plan-1', lastMessageCount: 2, updatedAt: Date.now() })
  const argsFile = join(workDir, 'args-plan-exec.json')
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const approved = {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'agytc-bridge-plan-100',
        content: [{ type: 'text', text: 'Plan approved. Exit plan mode and execute the plan.' }],
      }],
    } as unknown as Message
    const chunks = await collect(adapter.stream(opts([msg('user', 'make a plan'), approved], {
      sessionId: 'sess-plan' as never,
      tools: [{ name: 'exit_plan_mode', description: 'exit', parameters: {} } as never],
      system: 'Planning is disabled after approval.',
    })))
    assert.equal((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind, 'stop')
    const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    assert.equal(argv[argv.indexOf('--mode') + 1], 'accept-edits', 'approved plan exits plan mode to configured mode')
    const promptArg = argv[argv.indexOf('-p') + 1] ?? ''
    assert.match(promptArg, /Plan approved\. Exit plan mode/, 'bound conversation receives approval text from bridge tool-result')

    // Dismissed plan short-circuits without spawning agy.
    const argsFile2 = join(workDir, 'args-plan-dismissed.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile2
    const dismissed = {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'agytc-bridge-plan-101',
        content: [{ type: 'text', text: 'Plan review was dismissed by the user.' }],
      }],
    } as unknown as Message
    const dismissedChunks = await collect(adapter.stream(opts([msg('user', 'make a plan'), dismissed], {
      sessionId: 'sess-plan' as never,
    })))
    assert.deepEqual(dismissedChunks, [{ type: 'finish', reason: { kind: 'stop' } }])
    assert.equal(existsSync(argsFile2), false, 'dismissed plan review must not spawn agy')
  } finally {
    delete process.env.FAKE_AGY_ARGS_FILE
  }
})
