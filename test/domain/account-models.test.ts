import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAccountModelRows } from '../../src/common/account-models.ts'
import { accountSupportsModel, baseModelSlug, type ManagedAccount } from '../../src/common/pool-types.ts'

function baseAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc_1',
    alias: 'test',
    dir: '/tmp/acc_1',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {},
    ...overrides,
  }
}

test('buildAccountModelRows uses authoritative catalog without duplicates or internal noise', () => {
  const daoCatalog = [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] }, // duplicate guard
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'high'] },
    { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ]
  const acc = baseAccount({
    quotas: {
      google: {
        remainingFraction: 0.9,
        resetTime: '2026-11-20T12:00:00Z',
        models: [
          { modelId: 'gemini-4-hydrogen-low', displayName: 'Gemini 4 Hydrogen (Low)', remainingFraction: 0.95 },
          { modelId: 'gemini-4-hydrogen-tiered-xhigh', displayName: 'Gemini 4 Hydrogen (Tiered)', remainingFraction: 0.72, resetTime: '2026-11-20T11:00:00Z' },
          { modelId: 'gemini-4-hydrogen-sonar', displayName: 'gemini-4-hydrogen-sonar', remainingFraction: 1 },
          { modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', remainingFraction: 1 },
          { modelId: 'gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash (Tiered)', remainingFraction: 0.8 },
          { modelId: 'claude-opus-5-5-medium', displayName: 'Claude Opus 5.5 (Medium)', remainingFraction: 0.6 },
        ],
      },
      // No dedicated argon quota row -> Argon must stay UNKNOWN, never inherit the Gemini bucket.
    },
  })

  const rows = buildAccountModelRows(acc, daoCatalog)
  assert.equal(rows.length, 9, 'exact 9 unique models from authoritative catalog')
  assert.deepEqual(rows.map((r) => r.id), [
    'gemini-4-argon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-pro-orchestrator-neon',
    'gemini-pro-orchestrator-g1-pro',
    'gemini-3.8-flash',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-oss-120b-medium',
  ])
  const h = rows.find((r) => r.id === 'gemini-4-hydrogen')!
  assert.equal(h.remainingFraction, 0.72, 'matches folded & -tiered quota variants picking min remainingFraction')
  assert.equal(h.resetTime, '2026-11-20T11:00:00Z')
  assert.deepEqual(h.efforts, ['low', 'medium', 'high', 'xhigh'])

  const argon = rows.find((r) => r.id === 'gemini-4-argon')!
  assert.equal(argon.family, 'argon')
  assert.equal(argon.familyLabel, 'Argon')
  assert.equal(
    argon.remainingFraction,
    undefined,
    'Argon must NOT inherit the Gemini bucket when acc.quotas.argon is absent (separate quota books)',
  )

  const orchestrator = rows.find((r) => r.id === 'gemini-pro-orchestrator-neon')!
  assert.equal(orchestrator.name, 'Orchestrator (Neon)')
})

test('buildAccountModelRows fallback collapses raw 33-row REST duplicates and strips sonar/image noise', () => {
  const acc = baseAccount({
    quotas: {
      google: {
        models: [
          { modelId: 'gemini-2.5-flash', displayName: 'Gemini 3.5 Flash Lite', remainingFraction: 1 },
          { modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', remainingFraction: 0.85 },
          { modelId: 'gemini-2.5-flash-thinking', displayName: 'Gemini 3.5 Flash Lite', remainingFraction: 0.9 },
          { modelId: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', remainingFraction: 1 },
          { modelId: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image', remainingFraction: 1 },
          { modelId: 'gemini-4-hydrogen-low', displayName: 'Gemini 4 Hydrogen (Low)', remainingFraction: 0.9 },
          { modelId: 'gemini-4-hydrogen-medium', displayName: 'Gemini 4 Hydrogen (Medium)', remainingFraction: 0.9 },
          { modelId: 'gemini-4-hydrogen-high', displayName: 'Gemini 4 Hydrogen (High)', remainingFraction: 0.8 },
          { modelId: 'gemini-4-hydrogen-xhigh', displayName: 'Gemini 4 Hydrogen (Extra)', remainingFraction: 0.7 },
          { modelId: 'gemini-4-hydrogen-tiered-high', displayName: 'Gemini 4 Hydrogen (Tiered)', remainingFraction: 0.95 },
          { modelId: 'gemini-4-hydrogen-sonar', displayName: 'gemini-4-hydrogen-sonar', remainingFraction: 1 },
          { modelId: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)', remainingFraction: 1 },
          { modelId: 'gemini-3.8-flash-tiered', displayName: 'Gemini 3.8 Flash (Tiered)', remainingFraction: 0.95 },
          { modelId: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)', remainingFraction: 0.5 },
        ],
      },
    },
  })

  const rows = buildAccountModelRows(acc)
  assert.deepEqual(rows.map((r) => r.name), [
    'Gemini 3.5 Flash Lite',
    'Gemini 4 Hydrogen',
    'Gemini 3.8 Flash',
    'GPT-OSS 120B (Medium)',
  ])
  assert.equal(rows[0]!.remainingFraction, 0.85, 'collapsed alias keeps min remainingFraction')
  assert.deepEqual(rows[1]!.efforts, ['low', 'medium', 'high', 'xhigh'])
  assert.equal(rows[1]!.remainingFraction, 0.7)
  assert.equal(rows[3]!.id, 'gpt-oss-120b-medium', 'OpenAI medium model keeps -medium verbatim')
  assert.equal(rows[3]!.familyLabel, 'OpenAI')
})

test('buildAccountModelRows leaves remainingFraction undefined when neither model nor family bucket has data', () => {
  const acc = baseAccount({ quotas: {} })
  const rows = buildAccountModelRows(acc, [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low'] }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.remainingFraction, undefined, 'must not fabricate 100% when quota is unknown')
})

test('accountSupportsModel recognizes CLI orchestrator models and -xhigh/-tiered-* variants from quota backing evidence', () => {
  assert.equal(baseModelSlug('gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen')
  assert.equal(baseModelSlug('gemini-4-hydrogen-tiered-xhigh'), 'gemini-4-hydrogen')
  assert.equal(baseModelSlug('gemini-4-neon-xhigh'), 'gemini-4-neon')

  const proAcc = baseAccount({
    id: 'pro',
    dedicatedGroups: ['argon'],
    quotas: {
      google: {
        models: [
          { modelId: 'gemini-4-neon-xhigh', remainingFraction: 1 },
          { modelId: 'gemini-4-carbon-high', remainingFraction: 1 },
          { modelId: 'gemini-4-hydrogen-tiered-xhigh', remainingFraction: 1 },
          { modelId: 'gemini-3.8-flash-low', remainingFraction: 1 },
        ],
      },
      argon: {
        weeklyFraction: 1,
        models: [{ modelId: 'gemini-4-argon-high', remainingFraction: 1 }],
      },
    },
  })
  const freeAcc = baseAccount({
    id: 'free',
    quotas: {
      google: {
        models: [
          { modelId: 'gemini-3.8-flash-low', remainingFraction: 1 },
          { modelId: 'gemini-4-hydrogen-sonar', remainingFraction: 1 },
        ],
      },
    },
  })

  // Without per-account catalog (e.g. newly added account or pre-warm boot):
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator-neon', null, undefined), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator', null, undefined), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator-argon', null, undefined), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator-g1-pro', null, undefined), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-4-carbon', null, undefined), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-4-hydrogen', null, undefined), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-4-neon', null, undefined), true)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-pro-orchestrator-neon', null, undefined), false)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-pro-orchestrator', null, undefined), false)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-pro-orchestrator-g1-pro', null, undefined), false)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-4-carbon', null, undefined), false)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-4-hydrogen', null, undefined), false)

  // Even with a stale discovered catalog predating orchestrator rollout:
  const staleCat = { source: 'discovered', models: [{ id: 'gemini-3.8-flash' }] }
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator-neon', null, staleCat), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator', null, staleCat), true)
  assert.equal(accountSupportsModel(proAcc, 'gemini-pro-orchestrator-g1-pro', null, staleCat), true)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-pro-orchestrator-neon', null, staleCat), false)
  assert.equal(accountSupportsModel(freeAcc, 'gemini-pro-orchestrator', null, staleCat), false)
})
