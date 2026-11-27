// issue #223: agy truncates a prompt above its single-message ceiling silently,
// and its own system prompt, tool schemas and skills share that budget on top of
// ours. So the budget this plugin keeps must be adjustable per installation —
// while its default stays exactly where it has always been.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, type PluginConfig } from '../../src/common/types.ts'
import { buildSpawnArgs, type AttemptInput } from '../../src/provider/attempt.ts'
import { buildCompactionPrompt } from '../../src/provider/compaction-prompt.ts'
import { protectTrailingRequest } from '../../src/provider/live-last-request.ts'
import { PROMPT_BUDGET_MIN_BYTES, promptBudgetBytes } from '../../src/provider/prompt-budget.ts'
import { AGY_PROMPT_SAFE_BYTES, AGY_SINGLE_MESSAGE_MAX_BYTES, utf8Bytes } from '../../src/provider/prompt-text.ts'

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] }) as unknown as Message

test('promptBudgetBytes: the shipped default unless a usable override is given', () => {
  assert.equal(promptBudgetBytes({}), AGY_PROMPT_SAFE_BYTES)
  assert.equal(promptBudgetBytes({ promptMaxBytes: 150_000 }), 150_000)
  assert.equal(promptBudgetBytes({ promptMaxBytes: 150_000.7 }), 150_000, 'bytes are whole')
  assert.equal(promptBudgetBytes({ promptMaxBytes: PROMPT_BUDGET_MIN_BYTES }), PROMPT_BUDGET_MIN_BYTES)
  assert.equal(promptBudgetBytes({ promptMaxBytes: AGY_SINGLE_MESSAGE_MAX_BYTES }), AGY_SINGLE_MESSAGE_MAX_BYTES)
  // Above agy's ceiling would configure the silent truncation back in; below the
  // floor leaves no room for a policy, an environment and a request.
  assert.equal(promptBudgetBytes({ promptMaxBytes: AGY_SINGLE_MESSAGE_MAX_BYTES + 1 }), AGY_PROMPT_SAFE_BYTES)
  assert.equal(promptBudgetBytes({ promptMaxBytes: PROMPT_BUDGET_MIN_BYTES - 1 }), AGY_PROMPT_SAFE_BYTES)
  for (const junk of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(promptBudgetBytes({ promptMaxBytes: junk }), AGY_PROMPT_SAFE_BYTES, String(junk))
  }
})

function attemptInput(cfg: PluginConfig, prompt: string): AttemptInput {
  return {
    cfg, bin: 'agy', permissionMode: 'auto', sessionKey: 's1', workspaceRoot: '/tmp', isAux: false,
    account: undefined, prompt, model: 'gemini-3.8-flash', activeModel: 'gemini-3.8-flash', effort: undefined,
    addDirs: [], persistBinding: false, binding: undefined, messages: [], newlySentImageIds: [],
    sessionAccountKey: 's1', family: 'google', signal: undefined, agyOnEvent: undefined, sandbox: false, agent: '',
  }
}

test('buildSpawnArgs trims to the configured budget, not only to the default', () => {
  const big = 'x'.repeat(60_000)
  assert.equal(buildSpawnArgs(attemptInput(defaultConfig(), big), 10, undefined).prompt, big, '60 KB is inside the default budget')
  const logs: string[] = []
  const lowered = buildSpawnArgs(attemptInput({ ...defaultConfig(), promptMaxBytes: 20_000 }, big), 10, (m) => logs.push(m))
  assert.ok(utf8Bytes(lowered.prompt) <= 20_000, `trimmed to ${utf8Bytes(lowered.prompt)} B`)
  assert.ok(lowered.prompt.endsWith('…[truncated]'))
  assert.match(logs.join('\n'), /20000/, 'the log names the budget that was applied')
})

test('the compaction prompt and live-last protection share the same configured budget', () => {
  const cfg = { ...defaultConfig(), promptMaxBytes: 20_000 }
  const compact = buildCompactionPrompt([user('a'.repeat(50_000)), user('b'.repeat(50_000))], 800_000, promptBudgetBytes(cfg))
  assert.ok(utf8Bytes(compact) <= 20_000, `compaction prompt is ${utf8Bytes(compact)} B`)

  const last = 'PENDING ' + 'c'.repeat(10_000)
  const history = 'h'.repeat(30_000)
  const out = protectTrailingRequest('System instructions:\n' + history + '\n\n' + last, [user(history), user(last)], promptBudgetBytes(cfg))
  assert.ok(utf8Bytes(out) <= 20_000, `live-last prompt is ${utf8Bytes(out)} B`)
  assert.ok(out.endsWith(last), 'the final message still survives')
})
