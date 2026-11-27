// issue #221: DSH's auto-review sends a request made only of `user` messages —
// environment, retained items in Session order, and the pending tool call LAST
// ("The final message is the pending tool call", REVIEW_POLICY). Nothing puts
// that request first (no assistant message to wrap it, no binding to continue),
// so the whole history went out in order and the generic byte trim cut it from
// the TAIL: the pending call vanished, the reviewer failed closed, and every
// tool call in a long session turned into an approval prompt.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig, PROVIDER_ID } from '../../src/common/types.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { resolveCallContext } from '../../src/provider/call-context.ts'
import { buildPromptPlan } from '../../src/provider/prompt.ts'
import { AGY_PROMPT_SAFE_BYTES, utf8Bytes } from '../../src/provider/prompt-text.ts'
import { purposePolicy } from '../../src/provider/purpose-policy.ts'

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] }) as unknown as Message
const PENDING_END = '"PENDING_CALL_END_7f3a9c"}'
const POLICY = 'REVIEW_POLICY: You are the final authorization reviewer for exactly one pending tool call.'

async function buildReviewPlan(messages: Message[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agy-review-prompt-'))
  try {
    const cfg = { ...defaultConfig(), forwardSystemPrompt: false, cloakSystemPrompt: false }
    const options = { provider: PROVIDER_ID, model: 'gemini-3.8-flash', sessionId: 's-review' as never, system: POLICY, messages }
    const ctx = resolveCallContext({ options, cfg, bin: 'agy', cwd: dir, warnOnce: () => {} })
    assert.equal(ctx.isReview, true, 'fixture must be recognised as a review request')
    const plan = await buildPromptPlan({
      options, cfg, ctx, policy: purposePolicy(ctx), account: undefined,
      model: 'gemini-3.8-flash', activeModel: 'gemini-3.8-flash',
      deps: {
        store: new SessionStore(join(dir, 'sessions.json')),
        getActiveRun: () => undefined,
        recentlyCompactedSessions: new Map(),
        deliverContext: async (digest) => digest,
      },
    })
    return plan.prompt
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const retainedItem = (i: number): string => JSON.stringify({ type: 'tool-call', i, args: { content: 'x'.repeat(20_000) } })
const pendingCall = (): string => '{"type":"pending-tool-call","tool":"write","args":{"path":"a.txt"},' + PENDING_END

test('issue #221: the pending tool call survives when the retained history overflows the budget', async () => {
  const messages = [user('ENVIRONMENT: cwd=/repo'), ...Array.from({ length: 14 }, (_, i) => user(retainedItem(i))), user(pendingCall())]
  const prompt = await buildReviewPlan(messages)

  assert.ok(utf8Bytes(prompt) <= AGY_PROMPT_SAFE_BYTES, `must fit the single-message budget (${utf8Bytes(prompt)} B)`)
  assert.ok(prompt.endsWith(PENDING_END), 'the pending call is what the reviewer must judge — it cannot be cut')
  assert.ok(prompt.startsWith('System instructions:\n' + POLICY), 'the policy stays at the head')
  assert.match(prompt, /ENVIRONMENT: cwd=\/repo/, 'the environment (first user message) is kept')
  assert.match(prompt, /…\[elided \d+B\]…/, 'history is elided in the MIDDLE')
  assert.equal(prompt.endsWith('…[truncated]'), false, 'the generic tail trim must not have run')
})

test('a request that already fits is returned untouched', async () => {
  const messages = [user('ENVIRONMENT: cwd=/repo'), user(retainedItem(0)), user(pendingCall())]
  const prompt = await buildReviewPlan(messages)
  assert.doesNotMatch(prompt, /…\[(elided|truncated)/)
  assert.ok(prompt.endsWith(pendingCall()))
})

test('a pending call nearly filling the budget keeps the policy and both of its own ends', async () => {
  // Nothing left to elide in the history: degrade by eliding the MIDDLE of the
  // request itself (tool name and the end of the arguments stay readable)
  // rather than dropping the policy or the call's tail.
  const huge = '{"type":"pending-tool-call","tool":"write","args":{"content":"' + 'y'.repeat(190_000) + '"},' + PENDING_END
  const prompt = await buildReviewPlan([user('ENVIRONMENT: cwd=/repo'), user(huge)])
  assert.ok(utf8Bytes(prompt) <= AGY_PROMPT_SAFE_BYTES, `must fit the budget (${utf8Bytes(prompt)} B)`)
  assert.ok(prompt.startsWith('System instructions:\n' + POLICY), 'policy is never dropped')
  assert.match(prompt, /"tool":"write"/, 'the head of the call is kept')
  assert.ok(prompt.endsWith(PENDING_END), 'the tail of the call is kept')
})
