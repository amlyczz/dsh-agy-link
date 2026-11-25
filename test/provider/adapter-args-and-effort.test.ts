// argv assembly and per-model capability learning: buildArgs flags,
// reasoning effort (refusal learning, seeded lists, parse helpers), the
// aux / translation / image routes, and spawn cwd wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type GenerateOptions, LlmError } from '@deepseek-ai/dsh-llm'
import { parseEffortUnsupported, parseModelNotRecognized } from '../../src/host/adapter.ts'
import { ModelCatalog } from '../../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS, Err } from '../../src/common/types.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { collect, makeAdapter, msg, opts, workDir } from '../helpers/adapter-fixtures.ts'

test('aux calls rejected when allowAuxiliary is false', async () => {
  const { adapter } = makeAdapter({ allowAuxiliary: false })
  process.env.FAKE_AGY_MODE = 'ok'
  await assert.rejects(
    () => collect(adapter.stream(opts([msg('user', 'big history')], { purpose: 'compaction' }))),
    (e: unknown) => e instanceof LlmError && (e as LlmError & { code?: string }).code === Err.AUX_DISABLED,
  )
})

test('translation calls ride the aux channel: plan mode, explicit effort, no session binding', async () => {
  // Regression for the /tsl route: `purpose:'translation'` must behave like an
  // auxiliary call (no conversation binding, no tools, plan mode) while keeping
  // the caller's reasoning effort — aux calls would otherwise force Gemini to
  // 'low' — and it must not be blocked by allowAuxiliary.
  const { adapter, store } = makeAdapter({ allowAuxiliary: false })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-tsl.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const chunks = await collect(
    adapter.stream(
      opts([msg('user', 'translate this')], {
        purpose: 'translation' as never,
        reasoningEffort: 'high' as never,
        sessionId: 'sess-tsl' as never,
      }),
    ),
  )
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.equal(argv[argv.indexOf('--mode') + 1], 'plan', 'aux translation must run in plan mode')
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high', 'explicit effort must survive the aux path')
  assert.equal(store.get('sess-tsl'), undefined, 'aux translation must not create a conversation binding')
  const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
  assert.equal(finish.type, 'finish')
  assert.notEqual(finish.reason.kind, 'error')
})

test('compaction prompt flattens the whole history, stays in plan mode, and never inherits skip permissions', async () => {
  const { adapter } = makeAdapter({ permissionMode: 'skip' })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args4.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  await collect(adapter.stream(opts([msg('user', 'u1'), msg('assistant', 'a1'), msg('user', 'u2')], { purpose: 'compaction' })))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const prompt = argv[argv.indexOf('-p') + 1] ?? ''
  assert.ok(prompt.includes('conversation_history'))
  assert.ok(prompt.includes('u1'))
  assert.ok(prompt.includes('a1'))
  assert.ok(prompt.includes('Do NOT call any tools'))
  assert.ok(argv.includes('--mode'))
  assert.equal(argv[argv.indexOf('--mode') + 1], 'plan', 'compaction call must stay in plan mode')
  assert.equal(argv.includes('--dangerously-skip-permissions'), false, 'compaction call must never inherit skip permissions')
})

test('unknown reasoning effort on known model is rejected', async () => {
  const { adapter } = makeAdapter()
  process.env.FAKE_AGY_MODE = 'ok'
  await assert.rejects(
    () => collect(adapter.stream(opts([msg('user', 'x')], { reasoningEffort: 'ultra' as never }))),
    (e: unknown) => e instanceof LlmError && (e as LlmError & { code?: string }).code === Err.UNSUPPORTED_REASONING_EFFORT,
  )
})

test('buildArgs passes --effort for a Claude 5.5 base slug (agy 1.5.3 verified)', () => {
  const { adapter } = makeAdapter()
  const args = adapter.buildArgs({
    prompt: 'x',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    permissionMode: 'skip',
    timeoutMs: 60_000,
    extraArgs: [],
  })
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
})

test('buildArgs keeps the Argon base slug and passes effort separately', () => {
  const { adapter } = makeAdapter()
  for (const effort of ['high', undefined] as const) {
    const args = adapter.buildArgs({
      prompt: 'x',
      model: 'gemini-4-argon',
      effort,
      permissionMode: 'skip',
      timeoutMs: 60_000,
      extraArgs: [],
    })
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-argon')
    if (effort) assert.equal(args[args.indexOf('--effort') + 1], effort)
    else assert.ok(!args.includes('--effort'))
  }
})

test('buildArgs assembles flags per ADR-3/8/10', () => {
  const { adapter } = makeAdapter()
  const args = adapter.buildArgs({
    prompt: 'do it',
    model: 'gemini-3.7-flash',
    effort: 'high',
    conversationId: 'c9',
    permissionMode: 'skip',
    timeoutMs: 90_000,
    extraArgs: ['--add-dir', '/tmp'],
  })
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(!args.includes('--mode'))
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.7-flash')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
  assert.equal(args[args.indexOf('--conversation') + 1], 'c9')
  assert.equal(args[args.indexOf('--print-timeout') + 1], '2m')
  assert.equal(args[args.indexOf('--add-dir') + 1], '/tmp')
  const planArgs = adapter.buildArgs({ prompt: 'p', model: 'gemini-3.5-flash', permissionMode: 'plan', timeoutMs: 60_000, extraArgs: [] })
  assert.equal(planArgs[planArgs.indexOf('--mode') + 1], 'plan')

  // Non-Gemini models (Claude, GPT-OSS) MUST strip --effort and resolve aliases
  const claudeArgs = adapter.buildArgs({
    prompt: 'hello',
    model: 'claude-opus-4-6',
    effort: 'medium',
    permissionMode: 'plan',
    timeoutMs: 60_000,
    extraArgs: [],
  })
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'claude-opus-4-6-thinking')
  assert.ok(!claudeArgs.includes('--effort'), 'effort flag stripped for non-gemini models')
})

test('translation runs keep ONE agy conversation per DSH session (persona once, text after)', async () => {
  // The source text must not carry the instruction again: the persona (who agy
  // is, which DSH session it serves, where that session's history lives) travels
  // with the FIRST message only, and the conversation is bound under
  // `<sessionKey>#tsl` so it never collides with the turn conversation.
  process.env.FAKE_AGY_MODE = 'real'
  const argsFile = join(workDir, 'tsl-args.json')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const { adapter, store } = makeAdapter()
    // `text` is the short request line (the persona travels in `setup` only).
    const first = await collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      sessionId: 'sess-bind-1',
      messages: [msg('user', '原文 A')],
      purpose: 'translation',
      agyTranslateSession: { setup: '你是人话翻译器。', text: '把它讲成人话：\n\n原文 A' },
    } as unknown as GenerateOptions))
    assert.equal((first[first.length - 1] as { reason: { kind: string } }).reason.kind, 'stop')
    const firstArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const promptAt = firstArgs.indexOf('-p')
    assert.ok(promptAt >= 0, 'the prompt rides argv for a short message')
    const firstPrompt = firstArgs[promptAt + 1]!
    assert.match(firstPrompt, /人话翻译器/)
    assert.match(firstPrompt, /原文 A/)
    assert.match(firstPrompt, /把它讲成人话/)
    assert.equal(firstArgs.includes('--conversation'), false, 'the first call CREATES the conversation')

    const bound = store.all()['sess-bind-1#tsl']
    assert.ok(bound?.conversationId, 'a translation conversation is bound under <session>#tsl')
    assert.equal(store.all()['sess-bind-1'], undefined, 'the turn binding of the same session is untouched')

    // Second translation: same conversation, and the prompt is ONLY the text.
    const second = await collect(adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      sessionId: 'sess-bind-1',
      messages: [msg('user', '原文 B')],
      purpose: 'translation',
      agyTranslateSession: { setup: '你是人话翻译器。', text: '把它讲成人话：\n\n原文 B' },
    } as unknown as GenerateOptions))
    assert.equal((second[second.length - 1] as { reason: { kind: string } }).reason.kind, 'stop')
    const secondArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const at = secondArgs.indexOf('--conversation')
    assert.ok(at >= 0, 'the second call reuses the conversation')
    assert.equal(secondArgs[at + 1], bound.conversationId)
    const secondPrompt = secondArgs[secondArgs.indexOf('-p') + 1]!
    assert.equal(secondPrompt, '把它讲成人话：\n\n原文 B', 'the short request line, without the persona block')
    assert.doesNotMatch(secondPrompt, /你是人话翻译器/, 'the persona is NOT re-sent')
    assert.doesNotMatch(secondPrompt, /人话翻译器/)
    // Plan mode (read-only) is what lets agy read the session files it was told about.
    assert.ok(secondArgs.includes('--mode') && secondArgs[secondArgs.indexOf('--mode') + 1] === 'plan')
  } finally {
    delete process.env.FAKE_AGY_ARGS_FILE
    process.env.FAKE_AGY_MODE = 'ok'
  }
})

test('issue #67: an `--effort` refusal is learned and the call replayed without it', async () => {
  // agy 1.4.6 refuses the WHOLE invocation when --effort is passed to a model
  // that does not accept one, naming the model in the error. Effort support is
  // advisory in our catalog, so the refusal is the truth: learn it, stop asking,
  // and replay the same call once without the flag instead of failing the turn.
  const invocations = join(workDir, 'effort-invocations.txt')
  rmSync(invocations, { force: true })
  const argsFile = join(workDir, 'effort-args.json')
  process.env.FAKE_AGY_MODE = 'effort-unsupported'
  process.env.FAKE_AGY_INVOCATION_FILE = invocations
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const { adapter } = makeAdapter()
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], { model: 'gemini-3.8-flash', reasoningEffort: 'medium' } as Partial<GenerateOptions>)))
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop', 'the replay must end as a normal stop, not an error')
    assert.match(text, /answered without --effort/)
    // Two spawns: the refused attempt, then the replay.
    const spawns = readFileSync(invocations, 'utf8').split('\n').filter(Boolean).length
    assert.equal(spawns, 2, 'exactly one replay')
    // The flag survives the FIRST argv and is gone from the replay's argv.
    const lastArgs = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    assert.equal(lastArgs.includes('--effort'), false, 'the replay must not pass --effort')
    // Learned in-process: later runs do not ask, and the picker stops offering levels.
    assert.equal(adapter.isEffortUnsupported('gemini-3.8-flash'), true)
    assert.deepEqual(adapter.effortUnsupportedModels(), ['gemini-3.8-flash'])
    const resolved = (await adapter.resolveModel('antigravity', 'gemini-3.8-flash')) as { reasoning?: unknown }
    assert.equal(resolved.reasoning, undefined, 'a learned model advertises no efforts')
    // A second call for the same model never asks again: one spawn, no --effort.
    rmSync(invocations, { force: true })
    const again = await collect(adapter.stream(opts([msg('user', 'hi again')], { model: 'gemini-3.8-flash', reasoningEffort: 'medium' } as Partial<GenerateOptions>)))
    assert.equal((again[again.length - 1] as { reason: { kind: string } }).reason.kind, 'stop')
    assert.equal(readFileSync(invocations, 'utf8').split('\n').filter(Boolean).length, 1)
    assert.equal((JSON.parse(readFileSync(argsFile, 'utf8')) as string[]).includes('--effort'), false)
  } finally {
    delete process.env.FAKE_AGY_INVOCATION_FILE
    delete process.env.FAKE_AGY_ARGS_FILE
    process.env.FAKE_AGY_MODE = 'ok'
  }
})

test('issue #115: a refusal contradicting the live discovered catalog is NOT learned', async () => {
  // agy's print-mode validation emits "--effort is not supported for model X"
  // when its model-config fetch fails (TLS timeout), even though `agy models`
  // lists xhigh. Learning that as a static capability strips the model's whole
  // effort row and makes DSH reject later turns with UNSUPPORTED_REASONING_EFFORT.
  const catalog = new ModelCatalog(
    async () => ({ stdout: 'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (Extra)\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)', stderr: '' }),
    DEFAULT_FALLBACK_MODELS,
    300_000,
  )
  await catalog.forceRefresh()
  const invocations = join(workDir, 'p115-invocations.txt')
  const argsFile = join(workDir, 'p115-args.json')
  rmSync(invocations, { force: true })
  process.env.FAKE_AGY_MODE = 'effort-unsupported'
  process.env.FAKE_AGY_INVOCATION_FILE = invocations
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const { adapter } = makeAdapter({}, { catalog })
    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')], {
      model: 'gemini-4-hydrogen', reasoningEffort: 'xhigh',
    } as Partial<GenerateOptions>)))
    assert.equal((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind, 'stop', 'the replay still ends normally')
    assert.equal(adapter.isEffortUnsupported('gemini-4-hydrogen'), false, 'never blacklist a model whose catalog lists xhigh')
    const resolved = (await adapter.resolveModel('antigravity', 'gemini-4-hydrogen')) as { reasoning?: { efforts?: Array<{ id: string }> } }
    assert.ok(resolved.reasoning?.efforts?.some((e) => e.id === 'xhigh'), 'the effort row stays visible')
  } finally {
    delete process.env.FAKE_AGY_INVOCATION_FILE
    delete process.env.FAKE_AGY_ARGS_FILE
    process.env.FAKE_AGY_MODE = 'ok'
  }
})

test('issue #115: clearing the persisted effort list takes effect without a restart', () => {
  let list: readonly string[] = ['gemini-4-hydrogen']
  const { adapter } = makeAdapter({}, { effortUnsupported: () => list })
  assert.equal(adapter.isEffortUnsupported('gemini-4-hydrogen'), true)
  list = []
  assert.equal(adapter.isEffortUnsupported('gemini-4-hydrogen'), false, 'external edits must not require restarting DSH')
  assert.deepEqual(adapter.effortUnsupportedModels(), [])
})

test('issue #67: a persisted / seeded refusal is honoured before any spawn', async () => {
  const argsFile = join(workDir, 'seeded-args.json')
  const invocations = join(workDir, 'seeded-invocations.txt')
  rmSync(invocations, { force: true })
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_INVOCATION_FILE = invocations
  try {
    const { adapter } = makeAdapter({}, { effortUnsupported: () => ['gemini-3.8-flash'] })
    await collect(adapter.stream(opts([msg('user', 'hi')], { model: 'gemini-3.8-flash', reasoningEffort: 'medium' } as Partial<GenerateOptions>)))
    // Seeded from the host's list: the very first spawn already omits the flag.
    assert.equal(readFileSync(invocations, 'utf8').split('\n').filter(Boolean).length, 1)
    assert.equal((JSON.parse(readFileSync(argsFile, 'utf8')) as string[]).includes('--effort'), false)
    const resolved = (await adapter.resolveModel('antigravity', 'gemini-3.8-flash')) as { reasoning?: unknown }
    assert.equal(resolved.reasoning, undefined)
    // An unrelated model keeps its levels.
    const other = (await adapter.resolveModel('antigravity', 'gemini-4-argon')) as { reasoning?: { efforts?: unknown[] } }
    assert.ok(Array.isArray(other.reasoning?.efforts), 'unrelated models keep their effort row')
  } finally {
    delete process.env.FAKE_AGY_ARGS_FILE
    delete process.env.FAKE_AGY_INVOCATION_FILE
  }
})

test('parseEffortUnsupported reads the real agy refusal text', () => {
  const real = 'invalid model selection (--model "gemini-3.8-flash" --effort "medium"): --effort is not supported for model "gemini-3.8-flash"'
  assert.equal(parseEffortUnsupported(real), 'gemini-3.8-flash')
  assert.equal(parseEffortUnsupported('--effort is not supported for model gemini-4-argon'), 'gemini-4-argon')
  assert.equal(parseEffortUnsupported('provider/x --effort "medium" is not supported for model "x-1"'), 'x-1')
  assert.equal(parseEffortUnsupported('quota exhausted'), null)
  assert.equal(parseEffortUnsupported(''), null)
  // A model refusal WITHOUT any --effort mention is not ours to act on.
  assert.equal(parseEffortUnsupported('invalid model selection (--model "nope")'), null)
  // A command echo that contains --effort but fails for an unrelated reason (quota, auth, rate limit) must NOT be learned as an effort refusal.
  assert.equal(parseEffortUnsupported('invalid model selection (--model "gemini-3.8-flash" --effort "high"): quota exhausted'), null)
  assert.equal(parseEffortUnsupported('invalid model selection (--model "gemini-3.8-flash" --effort "high"): rate limit exceeded'), null)
})

test('parseModelNotRecognized reads the real agy model refusal text', () => {
  const real = 'agy exited with code 1: invalid model selection (--model "claude-opus-4-6-thinking" --effort ""): model claude-opus-4-6-thinking is not recognized as a known model or custom model in settings Available models: Gemini 4 Argon (Medium)'
  assert.equal(parseModelNotRecognized(real), 'claude-opus-4-6-thinking')
  assert.equal(parseModelNotRecognized('model claude-opus-4-6 is not recognized as a known model'), 'claude-opus-4-6')
  assert.equal(parseModelNotRecognized('quota exhausted'), null)
  assert.equal(parseModelNotRecognized(''), null)
})

test('unrecognized model refusal on attempt 0 marks unsupported and replays on eligible account', async () => {
  const invocations = join(workDir, 'model-unsupported-invocations.txt')
  rmSync(invocations, { force: true })
  process.env.FAKE_AGY_MODE = 'model-unsupported'
  process.env.FAKE_AGY_INVOCATION_FILE = invocations

  const poolDir = mkdtempSync(join(tmpdir(), 'agy-model-replay-pool-'))
  const pool = new AccountPoolManager(poolDir)
  const acc1 = pool.getAccounts()[0]!
  const acc2 = pool.createAccountSlot('Secondary Account')
  pool.updateAccountQuotas(acc1.id, { anthropic: { remainingFraction: 1 } })
  pool.updateAccountQuotas(acc2.id, { anthropic: { remainingFraction: 1 } })

  try {
    const { adapter } = makeAdapter({}, { pool })
    const chunks = await collect(
      adapter.stream(
        opts([msg('user', 'hi')], { model: 'claude-opus-4-6-thinking' } as Partial<GenerateOptions>),
      ),
    )
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop', 'the replay must end as a normal stop, not an error')
    assert.match(text, /answered on supported account/)

    // Two spawns: refused attempt on acc1, replay on acc2
    const spawns = readFileSync(invocations, 'utf8').split('\n').filter(Boolean).length
    assert.equal(spawns, 2, 'refusal on attempt 0 must trigger exactly one replay')

    // acc1 must be marked unsupported for claude-opus-4-6
    assert.equal(pool.isModelSupported(acc1, 'claude-opus-4-6-thinking'), false)
    assert.equal(pool.isModelSupported(acc2, 'claude-opus-4-6-thinking'), true)
  } finally {
    delete process.env.FAKE_AGY_INVOCATION_FILE
    process.env.FAKE_AGY_MODE = 'ok'
  }
})

test('adapter spawns agy in the DSH session cwd when workspaceRoot is not configured', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'agy-adapter-session-cwd-'))
  const { adapter } = makeAdapter({ workspaceRoot: '' }, {
    sessionCwd: () => sessionDir,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-cwd-session.json')
  const cwdFile = join(workDir, 'cwd-session.txt')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_CWD_FILE = cwdFile
  await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-cwd' as never })))
  assert.equal(readFileSync(cwdFile, 'utf8'), realpathSync(sessionDir))
  // agy ignores cwd for Active Workspace — the root must also ride --add-dir (issue #26)
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  assert.ok(argv.includes('--add-dir'), argv.join(' '))
  const addIdx = argv.indexOf('--add-dir')
  assert.equal(argv[addIdx + 1], sessionDir)
  rmSync(sessionDir, { recursive: true, force: true })
})

test('explicit workspaceRoot wins over the DSH session cwd', async () => {
  const explicitDir = mkdtempSync(join(tmpdir(), 'agy-adapter-explicit-ws-'))
  const sessionDir = mkdtempSync(join(tmpdir(), 'agy-adapter-ignored-session-cwd-'))
  const { adapter } = makeAdapter({ workspaceRoot: explicitDir }, {
    sessionCwd: () => sessionDir,
  })
  process.env.FAKE_AGY_MODE = 'ok'
  const argsFile = join(workDir, 'args-cwd-explicit.json')
  const cwdFile = join(workDir, 'cwd-explicit.txt')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  process.env.FAKE_AGY_CWD_FILE = cwdFile
  await collect(adapter.stream(opts([msg('user', 'hi')], { sessionId: 'sess-cwd-explicit' as never })))
  assert.equal(readFileSync(cwdFile, 'utf8'), realpathSync(explicitDir))
  const argv = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
  const addIdx = argv.indexOf('--add-dir')
  assert.ok(addIdx >= 0, 'explicit workspaceRoot also rides --add-dir')
  assert.equal(argv[addIdx + 1], explicitDir)
  rmSync(explicitDir, { recursive: true, force: true })
  rmSync(sessionDir, { recursive: true, force: true })
})

test('purpose:image uses the verbatim bridge prompt, the configured mode and the event hook', async () => {
  // The image CLI drives this exact route: no plan mode (the tool writes an
  // artifact), no session binding, the caller's prompt untouched, and raw agy
  // events handed back so the CLI can find the artifact.
  const argsFile = join(workDir, 'image-args.json')
  rmSync(argsFile, { force: true })
  process.env.FAKE_AGY_MODE = 'ok'
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  try {
    const { adapter, store } = makeAdapter({ permissionMode: 'accept-edits' })
    const bindingsBefore = JSON.stringify(store.all())
    const kinds: string[] = []
    const chunks = await collect(adapter.stream(opts([msg('user', 'THIS MESSAGE MUST BE IGNORED')], {
      purpose: 'image',
      agyImagePrompt: 'IMAGE PROMPT: a solid red square',
      agyOnEvent: (ev: { kind: string }) => { kinds.push(ev.kind) },
    } as unknown as Partial<GenerateOptions>)))
    assert.equal((chunks[chunks.length - 1] as { reason: { kind: string } }).reason.kind, 'stop')

    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    const prompt = args[args.indexOf('-p') + 1]
    assert.equal(prompt, 'IMAGE PROMPT: a solid red square', 'the bridge prompt is sent verbatim')
    assert.doesNotMatch(prompt, /THIS MESSAGE MUST BE IGNORED/, 'session context is not mixed in')
    assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits', 'image is NOT forced into plan mode')
    assert.equal(args.includes('--conversation'), false, 'each image run is a fresh conversation')
    assert.ok(kinds.includes('init'), 'agyOnEvent saw init')
    assert.ok(kinds.includes('result'), 'agyOnEvent saw the result envelope')
    assert.equal(JSON.stringify(store.all()), bindingsBefore, 'no conversation binding is persisted')

    // A headless caller can override the configured mode for one image call.
    await collect(adapter.stream(opts([msg('user', 'x')], {
      purpose: 'image',
      agyImagePrompt: 'IMAGE PROMPT: second',
      agyPermissionMode: 'skip',
    } as unknown as Partial<GenerateOptions>)))
    const args2 = JSON.parse(readFileSync(argsFile, 'utf8')) as string[]
    assert.ok(args2.includes('--dangerously-skip-permissions'), 'agyPermissionMode:skip reaches agy')
    assert.equal(args2.includes('--mode'), false, 'skip mode does not also pass --mode')
  } finally {
    delete process.env.FAKE_AGY_ARGS_FILE
    process.env.FAKE_AGY_MODE = 'ok'
  }
})
