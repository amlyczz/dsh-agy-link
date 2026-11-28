// Which families a fresh quota snapshot shows as exhausted right now — the
// rule behind AccountPoolManager.updateAccountQuotas' proactive advance. Pure,
// so it is pinned here without a pool; the pool decides what to DO about them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FamilyQuotaInfo, ModelFamily } from '../../src/common/pool-types.ts'
import { freshlyExhaustedFamilies } from '../../src/domain/accounts/quota-exhaustion.ts'

const now = Date.parse('2026-11-28T12:00:00Z')
const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString()
const info = (patch: Partial<FamilyQuotaInfo>): FamilyQuotaInfo => ({ remainingFraction: 0.9, resetTime: at(3_600_000), updatedAt: now, ...patch }) as FamilyQuotaInfo

test('a window at or below its floor is exhausted until its reset has passed', () => {
  assert.deepEqual(freshlyExhaustedFamilies({}, { google: info({ remainingFraction: 0.04 }) }, now), ['google'])
  assert.deepEqual(freshlyExhaustedFamilies({}, { google: info({ remainingFraction: 0.04, resetTime: at(-1_000) }) }, now), [], 'a reset in the past is no longer exhausted')
  assert.deepEqual(freshlyExhaustedFamilies({}, { google: info({ remainingFraction: 0.04, resetTime: 'not a date' }) }, now), ['google'], 'an unparseable reset cannot prove a recovery')
  assert.deepEqual(freshlyExhaustedFamilies({}, { google: info({ remainingFraction: 0.4 }) }, now), [], 'a healthy 5h window')
  assert.deepEqual(freshlyExhaustedFamilies({}, { google: info({ weeklyFraction: 0.01, weeklyResetTime: at(86_400_000) }) }, now), ['google'], 'the weekly window counts on its own')
  assert.deepEqual(freshlyExhaustedFamilies({}, { google: info({ remainingFraction: undefined, weeklyFraction: undefined }) }, now), [], 'no numbers, no verdict')
})

test('a gate clear at least as fresh as the snapshot overrides the verdict; an older one does not', () => {
  const snapshot = { google: info({ remainingFraction: 0.04, updatedAt: now - 5_000 }) }
  assert.deepEqual(freshlyExhaustedFamilies({ quotaGateClearedAt: { google: now - 1_000 } }, snapshot, now), [], 'cleared after the snapshot: bridged')
  assert.deepEqual(freshlyExhaustedFamilies({ quotaGateClearedAt: { google: now - 60_000 } }, snapshot, now), ['google'], 'cleared before the snapshot: stale')
  assert.deepEqual(freshlyExhaustedFamilies({ quotaGateClearedAt: { argon: now } }, snapshot, now), ['google'], "another family's clear is irrelevant")
})

test('several families are reported in the snapshot order, without empties', () => {
  const quotas = { argon: info({ remainingFraction: 0.02 }), claude: undefined, google: info({ remainingFraction: 0.01 }) } as Partial<Record<ModelFamily, FamilyQuotaInfo>>
  assert.deepEqual(freshlyExhaustedFamilies({}, quotas, now), ['argon', 'google'])
})
