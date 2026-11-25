// The post-run failure classification shared by the one-shot runner and
// external leases (src/host/run-settlement.ts). Pins each branch's pool side
// effects, including eligibility/auth, which the one-shot e2e tests do not hit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { settleRunFailure, settleSlotUnavailable, NOT_SIGNED_IN_ERROR, type RunFailureFacts } from '../../src/host/run-settlement.ts'
import { SlotUnavailableError } from '../../src/host/credential-slot.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

function poolDouble() {
  const calls: Array<[string, ...unknown[]]> = []
  const pool = {
    markAuthRequired: (...a: unknown[]) => { calls.push(['markAuthRequired', ...a]) },
    recordFailure: (...a: unknown[]) => { calls.push(['recordFailure', ...a]) },
    advanceAccount: (...a: unknown[]) => { calls.push(['advanceAccount', ...a]); return null },
    noteAuthFailure: (...a: unknown[]) => { calls.push(['noteAuthFailure', ...a]); return true },
    markModelUnsupported: (...a: unknown[]) => { calls.push(['markModelUnsupported', ...a]) },
  }
  return { pool, calls, names: () => calls.map((c) => c[0]) }
}

const account = { id: 'acc_b', dir: '/tmp/b', enabled: true } as unknown as ManagedAccount
const facts = (rawErr: string, extra: Partial<RunFailureFacts> = {}): RunFailureFacts => ({
  rawErr, resultText: '', resultOk: false, resultError: rawErr, text: '', ...extra,
})

test('TOS quarantines and wins over every other signal', () => {
  const d = poolDouble()
  const out = settleRunFailure(d.pool, account, 'google', 'gemini-3-flash', facts('TOS_VIOLATION quota exhausted', { effortRefusedModel: 'm' }))
  assert.deepEqual(out, { kind: 'tos', error: 'TOS_VIOLATION quota exhausted' })
  assert.deepEqual(d.names(), ['markAuthRequired'])
})

test('effort refusal is reported before quota, with no pool change', () => {
  const d = poolDouble()
  const out = settleRunFailure(d.pool, account, 'google', undefined, facts('RESOURCE_EXHAUSTED', { effortRefusedModel: 'gemini-x' }))
  assert.deepEqual(out, { kind: 'effort', refusedModel: 'gemini-x' })
  assert.deepEqual(d.calls, [])
})

test('hard quota cools the error model family and advances when it differs', () => {
  const d = poolDouble()
  const out = settleRunFailure(d.pool, account, 'google', 'gemini-3-flash', facts('RESOURCE_EXHAUSTED for model claude-sonnet-4-5 "model": "claude-sonnet-4-5"'))
  assert.equal(out?.kind, 'quota')
  assert.deepEqual(d.calls.map((c) => c.slice(0, 3)), [['recordFailure', 'acc_b', 'anthropic'], ['advanceAccount', 'acc_b', 'google']])
  // Without a parseable error model the requested family is used and nothing advances.
  const d2 = poolDouble()
  settleRunFailure(d2.pool, account, 'google', undefined, facts('RESOURCE_EXHAUSTED'))
  assert.deepEqual(d2.names(), ['recordFailure'])
  assert.equal(d2.calls[0]![2], 'google')
})

test('model not recognized marks the model and advances; without a pool it falls through', () => {
  const d = poolDouble()
  const err = 'model "gemini-x" is not recognized as a known model'
  assert.deepEqual(settleRunFailure(d.pool, account, 'google', 'gemini-x', facts(err)), { kind: 'model_unsupported', error: err })
  assert.deepEqual(d.names(), ['markModelUnsupported', 'advanceAccount'])
  assert.equal(settleRunFailure(undefined, undefined, 'google', 'gemini-x', facts(err)), null)
})

test('eligibility advances; auth notes the failure and advances only when it should mark', () => {
  const d = poolDouble()
  assert.deepEqual(settleRunFailure(d.pool, account, 'google', undefined, facts('eligibility check failed')), { kind: 'eligibility', error: 'eligibility check failed' })
  assert.deepEqual(d.names(), ['advanceAccount'])

  const a = poolDouble()
  assert.deepEqual(settleRunFailure(a.pool, account, 'google', undefined, facts('authentication required')), { kind: 'auth', error: NOT_SIGNED_IN_ERROR })
  assert.deepEqual(a.names(), ['noteAuthFailure', 'advanceAccount'])

  // A network-shaped auth message is not a reason to quarantine.
  const n = poolDouble()
  const out = settleRunFailure(n.pool, account, 'google', undefined, facts('not signed in: ECONNRESET socket hang up'))
  assert.equal(out?.kind, 'auth')
  assert.deepEqual(n.calls, [])

  // The parser's own auth signal is enough even when the text is generic.
  const p = poolDouble()
  assert.equal(settleRunFailure(p.pool, account, 'google', undefined, facts('', { sawAuthFailure: true }))?.kind, 'auth')
})

test('non-consumable failure with partial text, and unclassified output', () => {
  const d = poolDouble()
  const out = settleRunFailure(d.pool, account, 'google', undefined, facts('VALIDATION_REQUIRED', { text: 'partial' }))
  assert.deepEqual(out, { kind: 'non_consumable', error: 'VALIDATION_REQUIRED' })
  assert.deepEqual(d.calls, [])
  assert.equal(settleRunFailure(d.pool, account, 'google', undefined, facts('boom')), null)
  assert.equal(settleRunFailure(d.pool, account, 'google', undefined, { rawErr: '', resultText: 'ok', resultOk: true, text: 'ok' }), null)
})

test('settleSlotUnavailable: quarantine, except a primary-reassert failure on a secondary', () => {
  const d = poolDouble()
  settleSlotUnavailable(d.pool, account, 'google', undefined, new SlotUnavailableError('x'))
  settleSlotUnavailable(d.pool, account, 'google', undefined, new SlotUnavailableError('y', 'primary'))
  const primary = { id: 'acc_primary', dir: '', systemHome: true } as unknown as ManagedAccount
  settleSlotUnavailable(d.pool, primary, 'google', undefined, new SlotUnavailableError('z', 'primary'))
  assert.deepEqual(d.names(), ['markAuthRequired', 'advanceAccount', 'markAuthRequired'])
})
