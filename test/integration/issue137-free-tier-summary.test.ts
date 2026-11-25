// Regression tests for issue #137: a free-tier Google account gets
// `403 PERMISSION_DENIED` from retrieveUserQuotaSummary. That is a terminal
// verdict about the SUMMARY endpoint — not about the account:
//  - the summary call must stop repeating every hour,
//  - but the account must keep polling, because its models/weekly data still
//    comes from fetchAvailableModels / userQuota.
// Folding it into `no_license` would skip the account entirely and freeze the
// model list, which is why the two kinds of suppression stay separate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySummaryRefusal } from '../../src/features/quota/http.ts'
import {
  accountPollSuppressed,
  quotaSummarySuppressed,
  shouldPollAccount,
  type ManagedAccount,
} from '../../src/common/pool-types.ts'

const DENIED = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}'
// A licence refusal that does NOT carry the API-level PERMISSION_DENIED status.
// The real body can carry both, which is exactly the case #142 caught: see the
// dedicated test below.
const LICENCE = '{"error":{"code":403,"message":"You do not have a valid license of this product"}}'

test('issue #137: 403 PERMISSION_DENIED is a terminal summary refusal, not a generic http error', () => {
  const refusal = classifySummaryRefusal(403, DENIED)
  assert.equal(refusal.kind, 'no_summary_access')
  assert.equal(refusal.status, 403)
  assert.equal(refusal.detail, 'PERMISSION_DENIED')
})

test('issue #137: a licence refusal keeps its own kind', () => {
  assert.equal(classifySummaryRefusal(403, LICENCE).kind, 'no_license', 'without PERMISSION_DENIED it stays a licence verdict')
  // A 403 without either signal stays generic: it may be transient.
  assert.equal(classifySummaryRefusal(403, '{"error":{"status":"UNKNOWN"}}').kind, 'http')
  assert.equal(classifySummaryRefusal(401, '').kind, 'auth')
})

function acc(over: Partial<ManagedAccount> = {}): ManagedAccount {
  return { id: 'a', alias: 'a', dir: '', createdAt: 1, enabled: true, cooldowns: {}, quotas: {}, ...over } as ManagedAccount
}

function withState(reason: 'no_license' | 'no_summary_access', retryAfter: number): ManagedAccount {
  return acc({ quotaUnavailable: { reason, since: 0, retryAfter } } as never)
}

test('issue #137: the refused summary call is suppressed for both terminal kinds', () => {
  const future = Date.now() + 3600_000
  assert.equal(quotaSummarySuppressed(withState('no_summary_access', future)), true)
  assert.equal(quotaSummarySuppressed(withState('no_license', future)), true)
  // Expired suppression re-probes.
  assert.equal(quotaSummarySuppressed(withState('no_summary_access', Date.now() - 1)), false)
  // Partial/unreachable must never suppress: those can recover on their own.
  assert.equal(quotaSummarySuppressed(acc({ quotaUnavailable: { reason: 'partial', since: 0, retryAfter: future } } as never)), false)
})

test('issue #137: a free-tier account keeps polling so its model list stays fresh', () => {
  const future = Date.now() + 3600_000
  const free = withState('no_summary_access', future)
  assert.equal(accountPollSuppressed(free), false, 'only a licence-less account leaves the poll entirely')
  assert.equal(shouldPollAccount(free), true, 'the free-tier account is still polled (summary is skipped inside the pipeline)')
  // A licence refusal still stops the hourly probe completely.
  assert.equal(accountPollSuppressed(withState('no_license', future)), true)
  assert.equal(shouldPollAccount(withState('no_license', future)), false)
})

test('issue #137: the free-tier suppression window tracks the weekly quota window', async () => {
  const { QUOTA_FREE_TIER_RETRY_MS, QUOTA_LICENSE_RETRY_MS } = await import('../../src/common/timeouts.ts')
  assert.equal(QUOTA_FREE_TIER_RETRY_MS, 7 * 24 * 3600_000, 'free tier re-probes after a week, not every 6h')
  assert.equal(QUOTA_LICENSE_RETRY_MS, 6 * 3600_000, 'an unlicensed account still recovers within hours of a new licence')
  assert.ok(QUOTA_FREE_TIER_RETRY_MS > QUOTA_LICENSE_RETRY_MS)
})

test('issue #142: a 403 carrying BOTH a licence phrase and PERMISSION_DENIED is the free tier', async () => {
  // Reports disagree about the exact body: #137 saw only PERMISSION_DENIED,
  // #142 saw both. Ordering the licence check first made the free-tier branch
  // unreachable in the second case, so the account stayed on the 6h window.
  // `status` is the more specific API-level verdict, so it must win.
  const both = '{"error":{"code":403,"message":"You do not have a valid license of this product","status":"PERMISSION_DENIED"}}'
  assert.equal(classifySummaryRefusal(403, both).kind, 'no_summary_access')
  // A licence refusal WITHOUT that status keeps its own kind.
  const licenceOnly = '{"error":{"code":403,"message":"You do not have a valid license of this product"}}'
  assert.equal(classifySummaryRefusal(403, licenceOnly).kind, 'no_license')
})

test('403 PERMISSION_DENIED with VALIDATION_REQUIRED or TOS_VIOLATION is never mislabeled as free tier', () => {
  const validationBody = JSON.stringify({
    error: {
      code: 403,
      message: 'Verify your account to continue.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          reason: 'VALIDATION_REQUIRED',
          metadata: {
            validation_url: 'https://accounts.google.com/v3/signin/continue?plt=abc',
            validation_error_message: 'Verify your account to continue.',
          },
        },
      ],
    },
  })
  const v = classifySummaryRefusal(403, validationBody)
  assert.equal(v.kind, 'validation_required')
  assert.equal(v.actionUrl, 'https://accounts.google.com/v3/signin/continue?plt=abc')

  const tosBody = JSON.stringify({
    error: {
      code: 403,
      message: 'This service has been disabled in this account. TOS_VIOLATION',
      status: 'PERMISSION_DENIED',
    },
  })
  assert.equal(classifySummaryRefusal(403, tosBody).kind, 'tos_violation')

  const future = Date.now() + 60_000
  const valAcc = acc({ quotaUnavailable: { reason: 'validation_required', since: 0, retryAfter: future } } as never)
  assert.equal(quotaSummarySuppressed(valAcc), true)
  assert.equal(accountPollSuppressed(valAcc), true)
  assert.equal(shouldPollAccount(valAcc), false)
})

test('issue #151: fresh CLI quota data clears a stale quotaUnavailable marker', async () => {
  // The CLI path returns before the REST/summary branch that owns
  // clearQuotaUnavailable, so a marker written while the endpoint was down
  // outlived the successful refresh: the panel kept claiming "quota endpoint
  // unreachable · data from 19:02" while the stored quotas advanced past 22:44.
  const { refreshAccountQuotaPipeline } = await import('../../src/features/quota/refresh.ts')
  const cleared: string[] = []
  const updated: string[] = []
  const pool = {
    clearQuotaUnavailable: (id: string) => cleared.push(id),
    updateAccountQuotas: (id: string) => updated.push(id),
    clearAuthRequired: () => {},
    noteDedicatedGroup: () => {},
    clearQuotaFamily: () => {},
    forgetDedicatedGroup: () => {},
    clearCooldown: () => {},
  }
  const account = {
    id: 'acc-151', alias: 'a', dir: '', createdAt: 1, enabled: true, cooldowns: {}, quotas: {},
    quotaUnavailable: { reason: 'unreachable', since: 0, retryAfter: Date.now() - 1 },
  } as never
  const out = await refreshAccountQuotaPipeline({
    shouldUseCli: () => true,
    readCliUsageFamilies: async () => ({ google: { weeklyFraction: 0.4 } }),
    readPrimaryCredential: () => null,
    detectEmailFromLogs: () => undefined,
    pool: { ...pool, getAccounts: () => [] },
  } as never, { ...(account as object), email: 'a@example.com' } as never, true)
  assert.ok(out !== null, 'the CLI path returns its families')
  assert.deepEqual(updated, ['acc-151'], 'the fresh quotas are stored')
  assert.deepEqual(cleared, ['acc-151'], 'and the stale marker is cleared')
})

test('issue #151: a CLI read that yields nothing leaves the marker alone', async () => {
  const { refreshAccountQuotaPipeline } = await import('../../src/features/quota/refresh.ts')
  const cleared: string[] = []
  const pool = {
    clearQuotaUnavailable: (id: string) => cleared.push(id),
    updateAccountQuotas: () => {},
    clearAuthRequired: () => {},
  }
  const account = { id: 'acc-2', alias: 'a', dir: '', createdAt: 1, enabled: true, cooldowns: {}, quotas: {} } as never
  // Falling through to REST: no token, so the pipeline bails without touching it.
  await refreshAccountQuotaPipeline({
    shouldUseCli: () => true,
    readCliUsageFamilies: async () => null,
    getValidAccessToken: async () => null,
    readPrimaryCredential: () => null,
    detectEmailFromLogs: () => undefined,
    pool: { ...pool, getAccounts: () => [], dir: '' },
  } as never, { ...(account as object), email: 'b@example.com' } as never, true)
  assert.deepEqual(cleared, [], 'nothing was proven fresh, so nothing is cleared')
})
