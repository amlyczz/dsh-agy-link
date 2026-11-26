import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Message } from '@deepseek-ai/dsh-llm'
import { defaultConfig } from '../../src/common/types.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { resolveCallContext } from '../../src/provider/call-context.ts'
import { buildPromptPlan } from '../../src/provider/prompt.ts'
import { purposePolicy } from '../../src/provider/purpose-policy.ts'

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as never
}

test('same-family model switch clears older stale bindings in that family while preserving other families', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-model-switch-clean-'))
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const now = Date.now()
    store.set('sess-x:acc_alb', {
      conversationId: 'cid-alb',
      lastMessageCount: 10,
      updatedAt: now - 30_000,
      model: 'gemini-4-neon',
    })
    store.set('sess-x:acc_dao', {
      conversationId: 'cid-dao',
      lastMessageCount: 20,
      updatedAt: now - 20_000,
      model: 'gemini-4-neon',
    })
    store.set('sess-x:acc_god', {
      conversationId: 'cid-god',
      lastMessageCount: 30,
      updatedAt: now - 10_000,
      model: 'gemini-4-neon',
    })
    store.set('sess-x:acc_claude', {
      conversationId: 'cid-claude',
      lastMessageCount: 5,
      updatedAt: now - 5_000,
      model: 'claude-sonnet-4-6',
    })

    const cfg = defaultConfig()
    const options = {
      model: 'gemini-pro-orchestrator-neon',
      messages: [msg('user', 'switch model')],
      sessionId: 'sess-x',
    } as never
    const ctx = resolveCallContext({ options, cfg, bin: '/usr/bin/agy', warnOnce: () => undefined })
    const policy = purposePolicy(ctx)
    const account = {
      id: 'acc_god',
      alias: 'god',
      dir: '',
      enabled: true,
      createdAt: 1,
      cooldowns: {},
    } as ManagedAccount

    const plan = await buildPromptPlan({
      options,
      cfg,
      ctx,
      policy,
      account,
      model: 'gemini-pro-orchestrator-neon',
      activeModel: 'gemini-pro-orchestrator-neon',
      deps: {
        store,
        getActiveRun: () => undefined,
        recentlyCompactedSessions: new Map(),
        deliverContext: async (digest) => digest,
      },
    })

    assert.equal(plan.binding, undefined)
    assert.equal(store.get('sess-x:acc_god'), undefined, 'current account old-model binding is removed')
    assert.equal(store.get('sess-x:acc_dao'), undefined, 'older same-family old-model binding (dao) must not survive to resurrect')
    assert.equal(store.get('sess-x:acc_alb'), undefined, 'older same-family old-model binding (alb) must not survive to resurrect')
    assert.equal(store.get('sess-x:acc_claude')?.conversationId, 'cid-claude', 'unrelated family binding is preserved')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
