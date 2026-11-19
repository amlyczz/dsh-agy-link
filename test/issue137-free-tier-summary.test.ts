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
import { classifySummaryRefusal } from '../src/features/quota/http.ts'
import {
  accountPollSuppressed,
  quotaSummarySuppressed,
  shouldPollAccount,
  type ManagedAccount,
} from '../src/common/pool-types.ts'

const DENIED = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}'
const LICENCE = '{"error":{"code":403,"message":"You do not have a valid license of this product","status":"PERMISSION_DENIED"}}'

test('issue #137: 403 PERMISSION_DENIED is a terminal summary refusal, not a generic http error', () => {
  const refusal = classifySummaryRefusal(403, DENIED)
  assert.equal(refusal.kind, 'no_summary_access')
  assert.equal(refusal.status, 403)
  assert.equal(refusal.detail, 'PERMISSION_DENIED')
})

test('issue #137: a licence refusal keeps its own kind', () => {
  assert.equal(classifySummaryRefusal(403, LICENCE).kind, 'no_license')
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
  const { QUOTA_FREE_TIER_RETRY_MS, QUOTA_LICENSE_RETRY_MS } = await import('../src/common/timeouts.ts')
  assert.equal(QUOTA_FREE_TIER_RETRY_MS, 7 * 24 * 3600_000, 'free tier re-probes after a week, not every 6h')
  assert.equal(QUOTA_LICENSE_RETRY_MS, 6 * 3600_000, 'an unlicensed account still recovers within hours of a new licence')
  assert.ok(QUOTA_FREE_TIER_RETRY_MS > QUOTA_LICENSE_RETRY_MS)
})
