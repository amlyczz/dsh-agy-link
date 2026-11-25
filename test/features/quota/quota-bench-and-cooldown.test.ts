// Polling and eligibility gates: restricted accounts are skipped, an
// orphaned Argon cooldown is released exactly once, and a drained Gemini
// book never benches Argon.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldReleaseOrphanedCooldown } from '../../../src/host/quota.ts'
import { shouldPollAccount } from '../../../src/common/pool-types.ts'
import { makeTempPool } from './quota-fixtures.ts'

test('shouldPollAccount skips restricted accounts in background polling', () => {
  const { dir, pool } = makeTempPool('agy-poll-gate-')
  const healthy = pool.createAccountSlot('healthy')
  const cooling = pool.createAccountSlot('cooling')
  const quarantined = pool.createAccountSlot('quarantined')
  const disabled = pool.createAccountSlot('disabled')

  // healthy: pollable as-is
  assert.equal(shouldPollAccount(pool.getAccount(healthy.id)!), true)

  // cooling: 429 cooldown active -> skipped until it expires
  pool.recordFailure(cooling.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 21m25s.')
  assert.equal(shouldPollAccount(pool.getAccount(cooling.id)!), false)

  // quarantined: invalid_grant -> skipped until re-auth
  pool.markAuthRequired(quarantined.id, 'invalid_grant')
  assert.equal(shouldPollAccount(pool.getAccount(quarantined.id)!), false)

  // disabled: skipped
  const dis = pool.getAccount(disabled.id)!
  dis.enabled = false
  assert.equal(shouldPollAccount(dis), false)

  // expired cooldown becomes pollable again
  const cd = pool.getAccount(cooling.id)!.cooldowns.google!
  cd.cooldownUntil = Date.now() - 1
  assert.equal(shouldPollAccount(pool.getAccount(cooling.id)!), true)
})

test('shouldReleaseOrphanedCooldown never fires for an account that never had an Argon bucket', () => {
  // Reviewer-reported regression: the first draft cleared the argon cooldown on
  // every authoritative poll that lacked the group 鈥?true for free-tier and every
  // non-Pro account, whose argon cooldowns come from real 429s. Clearing those
  // every 60s silently disabled the cooldown mechanism for that family.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true,
    groupPresent: false,
    groupSeenBefore: false,   // never reported a dedicated bucket
    hasCooldown: true,
  }), false)

  // The genuine Pro -> Ultra transition: the account used to report the bucket.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true,
    groupPresent: false,
    groupSeenBefore: true,
    hasCooldown: true,
  }), true)

  // Still reported -> nothing to release.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true, groupPresent: true, groupSeenBefore: true, hasCooldown: true,
  }), false)

  // No cooldown to release -> no pointless persist().
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: true, groupPresent: false, groupSeenBefore: true, hasCooldown: false,
  }), false)

  // Failed/empty summary carries no authority over a family that is missing.
  assert.equal(shouldReleaseOrphanedCooldown({
    summaryAuthoritative: false, groupPresent: false, groupSeenBefore: true, hasCooldown: true,
  }), false)
})

test('a drained Gemini pool must not bench Argon (separate quota books)', () => {
  // Argon and Gemini are independent books. An account with no `argon` row has
  // UNKNOWN Argon state, which must never be read as "drained" just because the
  // Gemini pool is nearly empty — that would block Argon turns while Argon's
  // own weekly pool is still full.
  const { dir, pool } = makeTempPool('agy-quota-argon-gate-')
  const acc = pool.createAccountSlot('argon-gate')
  const reset = new Date(Date.now() + 2 * 3600_000).toISOString()
  pool.updateAccountQuotas(acc.id, {
    google: {
      remainingFraction: 0.5,
      resetTime: reset,
      weeklyFraction: 0.03,
      weeklyResetTime: reset,
      updatedAt: 1,
      models: [
        {
          modelId: 'gemini-4-argon-low',
          displayName: 'Gemini 4 Argon (Low)',
          remainingFraction: 0.5,
          resetTime: reset,
        },
      ],
    },
  }, 'argon-gate@example.com')

  const stored = pool.getAccount(acc.id)!
  assert.equal(pool.isAccountEligible(stored, 'argon'), true, 'a drained Gemini pool must not bench Argon')
  assert.equal(pool.isAccountEligible(stored, 'google'), false, 'the Gemini family itself is still benched')
})
