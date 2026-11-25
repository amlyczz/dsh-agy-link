// Model-scoped quota refusals must never cool a whole family.
//
// Observed live 2026-11-23: account "ele" (Pro, Google family at 20%, Argon at
// 80%) was put into a 4h32m `google` cooldown by an IMAGE-model 429:
//   `ResourceExhausted, HTTP 429: You have exhausted your capacity on this
//    model. Your quota will reset after 4h32m32s.`
// Gemini text models still had 20% left, yet the family left rotation. These
// tests pin the taxonomy, the live-failover behaviour, and the startup cleanup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isDirectToolQuotaExhausted,
  createLiveQuotaController,
} from '../../../src/provider/quota-failover.ts'
import {
  isImageModelId,
  isModelScopedQuotaFailure,
  looksLikeHardRateLimit,
} from '../../../src/common/types.ts'
import { AccountPoolManager } from '../../../src/host/pool.ts'
import { QuotaService } from '../../../src/host/quota.ts'
import type { AgyEvent } from '../../../src/common/types.ts'

const IMAGE_429 =
  'transport error (ResourceExhausted, HTTP 429): You have exhausted your capacity on this model. Your quota will reset after 4h32m32s.: RESOURCE_EXHAUSTED (code 429)'
const IMAGE_JSON_429 =
  '429 Too Many Requests {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"reason":"QUOTA_EXHAUSTED","metadata":{"model":"gemini-3.1-flash-image","quotaResetDelay":"4h58m46s"}}]}}'
const FAMILY_429 = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 42m9s.'

test('model-scoped taxonomy: image / "on this model" yes, family quota no', () => {
  assert.equal(looksLikeHardRateLimit(IMAGE_429), true, 'still a hard 429 for the retry decision')
  assert.equal(isModelScopedQuotaFailure(IMAGE_429), true)
  assert.equal(isModelScopedQuotaFailure(IMAGE_JSON_429), true)
  assert.equal(isModelScopedQuotaFailure(FAMILY_429), false)
  assert.equal(isModelScopedQuotaFailure('RESOURCE_EXHAUSTED: quota exceeded'), false)
  assert.equal(isImageModelId('gemini-3.1-flash-image'), true)
  assert.equal(isImageModelId('gemini-4-hydrogen-xhigh'), false)
})

test('direct tool 429: generate_image is flagged model-scoped, subagent family quota is not', () => {
  const img = isDirectToolQuotaExhausted({
    kind: 'step',
    stepKind: 'tool',
    state: 'ERROR',
    tool: { name: 'generate_image', args: {}, error: IMAGE_429 },
  } as unknown as AgyEvent)
  assert.equal(img?.modelScoped, true)

  const sub = isDirectToolQuotaExhausted({
    kind: 'step',
    stepKind: 'tool',
    state: 'ERROR',
    tool: { name: 'invoke_subagent', args: {}, error: FAMILY_429 },
  } as unknown as AgyEvent)
  assert.equal(sub?.modelScoped, false)
})

test('live failover: a model-scoped 429 pauses only that model, keeps the turn on the account', () => {
  const calls = { record: 0, advance: 0, model: 0 }
  const pool = {
    getAccounts: () => [],
    getAccount: () => undefined,
    isAccountEligibleForModel: () => false,
    isAccountEligible: () => false,
    recordFailure: () => { calls.record += 1 },
    recordModelFailure: () => { calls.model += 1 },
    advanceAccount: () => { calls.advance += 1 },
  }
  const ctrl = createLiveQuotaController({
    pool: pool as never,
    account: { id: 'acc-ele' } as never,
    inputFamily: 'google',
    activeModel: 'gemini-4-neon',
    emitNotice: () => undefined,
    onTriggerKill: () => undefined,
  })
  ctrl.handleQuotaExhausted({ source: 'tool-step', errorText: IMAGE_429, modelScoped: true, model: 'gemini-3.1-flash-image' })
  assert.equal(calls.record, 0, 'no family cooldown for a model-scoped refusal')
  assert.equal(calls.advance, 0, 'the turn must NOT move to another account')
  assert.equal(calls.model, 1, 'only the image model is paused')

  const ctrl2 = createLiveQuotaController({
    pool: pool as never,
    account: { id: 'acc-ele' } as never,
    inputFamily: 'google',
    activeModel: 'gemini-4-neon',
    emitNotice: () => undefined,
    onTriggerKill: () => undefined,
  })
  ctrl2.handleQuotaExhausted({ source: 'tool-step', errorText: FAMILY_429 })
  assert.equal(calls.record, 1, 'a genuine family quota refusal still cools down')
})

test('startup migration: model-scoped cooldowns are released, family cooldowns survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-model-scoped-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getAccounts()[0]!
    pool.recordFailure(acc.id, 'google', IMAGE_429)
    assert.ok(pool.getAccount(acc.id)?.cooldowns?.google, 'precondition: cooldown written')

    const reopened = new AccountPoolManager(dir)
    assert.equal(reopened.getAccount(acc.id)?.cooldowns?.google, undefined, 'model-scoped cooldown dropped')

    reopened.recordFailure(acc.id, 'google', FAMILY_429)
    const reopened2 = new AccountPoolManager(dir)
    assert.ok(reopened2.getAccount(acc.id)?.cooldowns?.google, 'family quota cooldown is preserved')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('CLI usage negative cache: a timed-out probe is skipped instead of costing another 20s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-skip-'))
  try {
    const pool = new AccountPoolManager(dir)
    const acc = pool.getAccounts()[0]!
    const quota = new QuotaService(pool, () => '', () => '1.5.15', { bin: () => '/nonexistent/agy-test' })
    const skip = (quota as unknown as { cliUsageSkipUntil: Map<string, number> }).cliUsageSkipUntil
    skip.set(acc.id, Date.now() + 60_000)
    const started = Date.now()
    const groups = await (quota as unknown as {
      readCliUsageFamilies: (a: unknown) => Promise<Record<string, unknown> | null>
    }).readCliUsageFamilies(acc)
    assert.equal(groups, null)
    assert.ok(Date.now() - started < 1000, 'skipped without spawning agy')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})
