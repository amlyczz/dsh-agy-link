import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { AgyAdapterDeps } from '../../src/host/adapter.ts'
import { rebuildAcpSession } from '../../src/features/acp/rebuild.ts'
import { RunRecording } from '../../src/host/recording.ts'
import { finalizeAttempt } from '../../src/provider/finalize.ts'
import { findSdkBlocks, systemDelta } from '../../src/provider/system-budget.ts'
import { deliverSystemPrompt } from '../../src/provider/system-delivery.ts'
import { AGY_PROMPT_SAFE_BYTES } from '../../src/provider/prompt-text.ts'
import { makeAdapter, msg, runTurn, waitFor, workDir } from '../helpers/adapter-fixtures.ts'

function snapshot(plugin: string, value: string): Message {
  return { ...msg('user', value), source: { kind: 'plugin', form: 'snapshot', plugin } } as unknown as Message
}

function fixture(key: string, deps: Partial<AgyAdapterDeps> = {}, promptMaxBytes = AGY_PROMPT_SAFE_BYTES) {
  process.env.DSH_HOME = workDir
  process.env.FAKE_AGY_MODE = 'ok'
  const { adapter, store, argsFile } = makeAdapter({ forwardSystemPrompt: true, cloakSystemPrompt: false, transport: deps.runAcp ? 'acp' : 'cli', promptMaxBytes }, deps)
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  async function send(system: string, user: string, snapshots: Message[] = []) {
    const { chunks } = await runTurn(adapter, [...snapshots, msg('user', user)], { system, sessionId: key as never })
    const args: string[] = JSON.parse(readFileSync(argsFile, 'utf8'))
    assert.ok(args.includes('-p'))
    const finish = chunks.at(-1)
    return { reason: finish?.type === 'finish' ? finish.reason.kind : undefined, args, prompt: args[args.indexOf('-p') + 1]! }
  }
  return { send, store, binding: () => store.get(key) }
}

test('resumed conversations send zero unchanged prefix bytes and only the changed snapshot', async () => {
  const f = fixture('delta')
  const snapshots = [snapshot('a', 'first A'), snapshot('b', 'first B')]
  assert.match((await f.send('role', 'task one', snapshots)).prompt, /role[\s\S]*first A[\s\S]*first B/)
  await waitFor(() => f.binding()?.sentSystemHash)
  assert.equal((await f.send('role', '  task two\n🧭  ', snapshots)).prompt, '  task two\n🧭  ')
  const { prompt } = await f.send('role', 'task three', [snapshots[0]!, snapshot('b', 'new B')])
  assert.equal(prompt, 'Current DSH context (supersedes previous snapshots):\nnew B\n\ntask three')
})

test('a failed turn preserves acknowledged hashes and retries both changes', async () => {
  const f = fixture('retry')
  await f.send('old role', 'first', [snapshot('x', 'old context')])
  const previous = await waitFor(() => f.binding()?.sentSystemHash ? f.binding() : undefined)
  process.env.FAKE_AGY_MODE = 'exit12'
  assert.equal((await f.send('new role', 'retry me', [snapshot('x', 'new context')])).reason, 'error')
  assert.equal(f.binding()?.sentSystemHash, previous.sentSystemHash)
  assert.deepEqual(f.binding()?.sentSnapshotHashes, previous.sentSnapshotHashes)
  process.env.FAKE_AGY_MODE = 'ok'
  const { prompt } = await f.send('new role', 'retry me', [snapshot('x', 'new context')])
  assert.match(prompt, /new role[\s\S]*new context[\s\S]*retry me/)
})

test('a measured input-token cliff causes the following turn to re-seed the system only', async () => {
  const f = fixture('cliff')
  const snaps = [snapshot('x', 'context')]
  await f.send('role', 'first', snaps)
  const previous = await waitFor(() => f.binding()?.sentSystemHash ? f.binding() : undefined)
  f.store.set('cliff', { ...previous, lastInputTokens: 40_000, updatedAt: Date.now() })
  process.env.FAKE_AGY_MODE = 'real'
  assert.equal((await f.send('role', 'small usage', snaps)).prompt, 'small usage')
  await waitFor(() => f.binding()?.lastInputTokens === 1100 ? true : undefined)
  assert.equal(f.binding()?.sentSystemHash, undefined)
  assert.equal((await f.send('role', 'next', snaps)).prompt, 'System instructions:\nrole\n\nnext')
})

test('250 KB DSH SDK is the only archive; role instructions, index and the exact request reach the CLI', async () => {
  const f = fixture('sdk')
  const sdk = ['```ts', 'interface ToolArgsMap {', '  /** ' + 'x'.repeat(250_000) + ' */',
    '  "multi-tool": string;', '}', 'declare const tools: {', '  [K in ToolName]: ToolArgsMap[K];', '}', '```'].join('\n')
  const system = 'Keep this role.\n```js\nconst example = 1\n```\nRole priorities.\n' + sdk + '\nObserve this closing policy.'
  const user = '  用户问题 🧭\n第二行。  '
  const { prompt, args } = await f.send(system, user)
  const path = /read declarations at (.+?\.md)\]/.exec(prompt)?.[1]
  assert.ok(path)
  assert.match(prompt, /^System instructions:\nKeep this role\.[\s\S]*Role priorities\.[\s\S]*PTC SDK — multi-tool/)
  assert.ok(prompt.endsWith('Observe this closing policy.\n\n' + user))
  assert.ok(Buffer.byteLength(prompt) <= AGY_PROMPT_SAFE_BYTES)
  assert.equal(readFileSync(path, 'utf8'), sdk)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o222, 0)
  assert.ok(args.some((arg, i) => arg === '--add-dir' && args[i + 1] === dirname(path)))
  const bound = await waitFor(() => f.binding()?.prefixFilesExpireAt ? f.binding() : undefined)
  const next = await f.send(system, 'resume')
  assert.equal(next.prompt, 'resume')
  assert.ok(next.args.includes(dirname(path)))
  f.store.set('sdk', { ...bound, prefixFilesExpireAt: Date.now() - 1, updatedAt: Date.now() })
  assert.match((await f.send(system, 'after expiry')).prompt, /read declarations at /)
})

test('source hashes are bounded and an omitted source is sent when reintroduced', () => {
  const messages = Array.from({ length: 40 }, (_, i) => snapshot(String(i), String(i)))
  const first = systemDelta('role', messages, false, true)
  assert.equal(first.snapshots.length, 40)
  assert.equal(Object.keys(first.nextSnapshotHashes!).length, 32)
  const binding = { conversationId: 'c', lastMessageCount: 0, updatedAt: 1, sentSnapshotHashes: first.nextSnapshotHashes }
  const missing = systemDelta('role', messages.slice(0, 39), false, true, binding)
  assert.deepEqual(systemDelta('role', [messages[39]!], false, true, { ...binding, sentSnapshotHashes: missing.nextSnapshotHashes }).snapshots, ['39'])
})

test('standalone namespaces and explicit tool lists stop before subsequent role prose', () => {
  const blocks = ['declare namespace tools {\n  function search(): void;\n}', '## Available tools\n- search: find text\n']
  for (const block of blocks) {
    const found = findSdkBlocks('Role A\n' + block + '\nRole B')
    assert.equal(found.length, 1)
    assert.equal(found[0]?.text, block)
    assert.equal(found[0]?.index, 'search')
  }
})

test('static overflow keeps both ends of the persona and archives the complete multibyte source', async () => {
  process.env.DSH_HOME = workDir
  const system = 'Role begins.\n' + '繁'.repeat(90_000) + '\nRole ends.'
  const user = '用户请求'
  const result = await deliverSystemPrompt({ system, snapshots: [] }, user, '', 'static', [], 0, AGY_PROMPT_SAFE_BYTES)
  assert.ok(Buffer.byteLength(result.prompt) <= AGY_PROMPT_SAFE_BYTES)
  assert.ok(result.prompt.startsWith('System instructions:\nRole begins.'))
  assert.ok(result.prompt.endsWith('Role ends.\n\n' + user))
  const file = /complete system instructions at (.+?\.md)\]/.exec(result.prompt)?.[1]
  assert.ok(file)
  assert.equal(readFileSync(file, 'utf8'), system)
})

test('user input exceeding the entire transport limit is recoverable byte for byte', async () => {
  process.env.DSH_HOME = workDir
  const user = '🧭'.repeat(50_000)
  const { prompt } = await deliverSystemPrompt({ system: '', snapshots: [] }, user, '', 'large-user', [], 0, AGY_PROMPT_SAFE_BYTES)
  const path = prompt.split('\n').at(-1)!
  assert.ok(path.startsWith(join(workDir, 'agy-link')))
  assert.equal(readFileSync(path, 'utf8'), user)
  assert.ok(Buffer.byteLength(prompt) <= AGY_PROMPT_SAFE_BYTES)
})

test('CLI fallback after an ACP reset sends the fresh system and snapshots without the dead conversation id', async () => {
  let attemptedResume = ''
  let rebuiltPrompt = ''
  const f = fixture('rebuilt', {
    runAcp: async (deps, input) => {
      if (input.binding) {
        attemptedResume = input.prompt
        const rebuilt = await rebuildAcpSession({
          deps, input, previousSid: 'replacement', workspaceRoot: workDir,
          proc: { openSession: async () => ({ sessionId: 'new' }) } as never,
        })
        rebuiltPrompt = rebuilt.prompt
      }
      return null
    },
  })
  const snaps = [snapshot('roster', 'current roster')]
  await f.send('role obligations', 'start', snaps)
  await waitFor(() => f.binding()?.sentSystemHash)
  const next = await f.send('role obligations', 'new request', snaps)
  assert.equal(attemptedResume, 'new request')
  assert.match(rebuiltPrompt, /role obligations[\s\S]*current roster[\s\S]*new request/)
  assert.equal(next.prompt, rebuiltPrompt)
  assert.ok(!next.args.includes('--conversation'))
})

test('long static paragraphs spill before the role policy and SDK index between them', async () => {
  process.env.DSH_HOME = workDir
  const corpus = 'reference material '.repeat(9000)
  const sdk = 'declare namespace tools {\n  function catalog(): void;\n  /** ' + 'x'.repeat(60000) + ' */\n}'
  const system = [corpus, 'Central role policy.', sdk, corpus].join('\n\n')
  const deliver = () => deliverSystemPrompt({ system, snapshots: [] }, 'task', '', 'paragraphs', [], 0, AGY_PROMPT_SAFE_BYTES)
  const first = await deliver()
  assert.match(first.prompt, /Central role policy\.[\s\S]*PTC SDK — catalog/)
  assert.ok(Buffer.byteLength(first.prompt) <= AGY_PROMPT_SAFE_BYTES)
  assert.equal((await deliver()).prompt, first.prompt, 'identical in-flight submissions must have a stable prompt identity')
})

test('ACP uses measured usage at the compression thresholds and keeps prior receipts for an unconfirmed result', async () => {
  const { store } = fixture('thresholds')
  for (const [previous, used, confirmed, expected] of [
    [39_999, 200, true, 'new'], [40_000, 22_000, true, 'new'],
    [40_000, 21_999, true, undefined], [40_000, 0, true, 'new'], [40_000, 200, false, 'old'],
  ] as const) {
    const rec = new RunRecording('thresholds')
    rec.append({ kind: 'result', ok: true, conversationId: 'c', response: 'done', usage: { input_tokens: used }, raw: {} })
    await finalizeAttempt({
      rec, store, failure: null, account: undefined, family: 'google',
      outcome: { code: 0, signal: null, timedOut: false, aborted: false, capped: false, durationMs: 1, stdout: '', stderrTail: '', idleGraceTerminated: !confirmed },
      persistBinding: true, sessionKey: 'thresholds', sessionAccountKey: 'thresholds', conversationId: 'c',
      binding: { conversationId: 'c', updatedAt: 1, lastMessageCount: 1, lastInputTokens: previous, sentSystemHash: 'old' },
      systemWatermarks: { nextSystemHash: 'new' }, acpResultUsage: true,
      cwd: workDir, messages: [], model: 'm', activeModel: 'm', superseded: false,
      newlySentImageIds: [], rawErrText: '', runLogText: '', silentTimeout: false,
      clearNetworkStreak() {}, dropFailoverBudget() {}, clearRateLimitFailover() {}, sharesSingleEgress: () => false,
    })
    assert.equal(store.get('thresholds')?.sentSystemHash, expected)
  }
})

test('a configured 20 KB budget governs PTC staging even when the entire system fits the default', async () => {
  const f = fixture('custom-budget', {}, 20_000)
  const sdk = 'declare namespace tools {\n  function review(): void;\n  /** ' + 'T'.repeat(35_000) + ' */\n}'
  const user = '最终结论 🧭'
  const { prompt } = await f.send('Core role.\n' + sdk, user)
  assert.ok(Buffer.byteLength(prompt) <= 20_000)
  assert.match(prompt, /^System instructions:\nCore role\.[\s\S]*PTC SDK — review/)
  assert.ok(prompt.endsWith(user))
  const file = /read declarations at (.+?\.md)\]/.exec(prompt)?.[1]
  assert.ok(file)
  assert.equal(readFileSync(file, 'utf8'), sdk)
})

test('a large preceding user context can spill while the actual last request stays inline', async () => {
  const f = fixture('live-last', {}, 20_000)
  const latest = '  用户最新消息 🧭  '
  const { prompt } = await f.send('Role at the head.', latest, [msg('user', 'earlier '.repeat(5000))])
  assert.match(prompt, /^System instructions:\nRole at the head\./)
  assert.ok(prompt.endsWith(latest))
  assert.ok(Buffer.byteLength(prompt) <= 20_000)
})
