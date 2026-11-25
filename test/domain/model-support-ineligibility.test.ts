// Regression tests for issues #120 / #122:
//  - a model absent from a (possibly stale) catalog is NOT the same failure as
//    "the account lacks the whole model family / plan";
//  - a stale or fallback `agy models` snapshot must not veto positive evidence
//    from the account's own quota groups.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountSupportsModel, type ManagedAccount } from '../../src/common/pool-types.ts'
import { explainIneligibility } from '../../src/domain/accounts/selection.ts'

function acc(over: Partial<ManagedAccount> = {}): ManagedAccount {
  return { id: 'a', alias: 'a', dir: '', createdAt: 0, enabled: true, cooldowns: {}, quotas: {}, ...over }
}

test('issue #120: model mismatch gets its own ineligibility reason', () => {
  const noModel = { isModelSupported: () => false } as never
  // A known account whose catalog lacks the requested model.
  assert.equal(
    explainIneligibility(acc(), 'google', Date.now(), noModel, 'gemini-4-argon'),
    'model-unsupported',
  )
  // Family-level access is still reported separately.
  assert.equal(explainIneligibility(acc(), 'argon', Date.now(), undefined), 'unsupported')
})

test('issue #122: a stale discovered catalog cannot veto the account quota groups', () => {
  const staleCatalog = {
    source: 'discovered' as const,
    discoveredAt: Date.now() - 60 * 60_000,
    models: [
      { id: 'gemini-3.8-flash', name: 'Flash', efforts: ['low'] },
      { id: 'claude-sonnet-4-6', name: 'Sonnet', efforts: null },
    ],
  }
  const withHydrogenQuota = acc({
    quotas: {
      google: {
        models: [
          { modelId: 'gemini-4-hydrogen-high', remainingFraction: 1 },
          { modelId: 'gemini-3.8-flash', remainingFraction: 1 },
        ],
      },
    },
  } as never)
  assert.equal(
    accountSupportsModel(withHydrogenQuota, 'gemini-4-hydrogen', undefined, staleCatalog),
    true,
    'the quota group explicitly lists the model — a stale 4-model catalog must not override it',
  )
  assert.equal(
    accountSupportsModel(acc(), 'gemini-4-hydrogen', undefined, staleCatalog),
    false,
    'without quota evidence the discovered catalog remains authoritative',
  )
})
