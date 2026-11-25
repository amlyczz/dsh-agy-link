// Card consistency: a single account card renders a plan badge, per-family quota
// bars, a failure note and timestamps that come from different fields. These
// tests pin the two ways it used to contradict itself (reported 2026-11-23):
//   • a bare stale percentage whose 5-hour boundary had passed 33 hours earlier
//   • a "free-tier account" note on a card that also showed a Pro badge + 5h bar
// Imports this helper FIRST: it installs the `require('react')` shim the client
// modules expect before any of them is evaluated.
import { renderToStaticMarkup } from '../helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderFamilyQuotaBar, renderQuotaUnavailableNote } from '../../src/client/sections/QuotaPanel.ts'

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars === undefined ? key : `${key}[${Object.values(vars).join(',')}]`) as never

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc_1',
    alias: 'test',
    dir: '',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {},
    ...overrides,
  } as never
}

const HOUR = 3_600_000

test('an expired 5h boundary below 100% carries a stale marker instead of a bare percentage', () => {
  const tree = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Gemini', 'google', account({
    quotas: {
      google: {
        remainingFraction: 0.91,
        resetTime: new Date(Date.now() - 33 * HOUR).toISOString(),
        updatedAt: Date.now() - 30 * HOUR,
      },
    },
  }), false))
  assert.ok(tree.includes('quota.windowResetStale'), 'expired boundary must not render a bare 91%')
})

test('a full window whose boundary passed still reads as "reset · available"', () => {
  const tree = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Gemini', 'google', account({
    quotas: {
      google: {
        remainingFraction: 1,
        resetTime: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: Date.now(),
      },
    },
  }), false))
  assert.ok(tree.includes('quota.windowReset'))
  assert.equal(tree.includes('quota.windowResetStale'), false, '100% needs no stale warning')
})

test('a live window gets no reset or stale marker at all', () => {
  const tree = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Gemini', 'google', account({
    quotas: {
      google: {
        remainingFraction: 0.5,
        resetTime: new Date(Date.now() + HOUR).toISOString(),
        updatedAt: Date.now(),
      },
    },
  }), false))
  assert.equal(tree.includes('quota.windowReset'), false)
})

test('no_summary_access must not call a 5h-capable account free-tier', () => {
  const tree = renderToStaticMarkup(renderQuotaUnavailableNote(t, account({
    quotas: {
      google: {
        remainingFraction: 0.9,
        resetTime: new Date(Date.now() + HOUR).toISOString(),
        updatedAt: Date.now(),
      },
    },
    quotaUnavailable: { reason: 'no_summary_access', since: Date.now() - 1_000, retryAfter: Date.now() + 1_000 },
  })))
  assert.ok(tree.includes('no_summary_access_paid'), 'a paid account gets the neutral refusal wording')
})

test('no_summary_access still reads as free-tier when no 5h window exists', () => {
  const tree = renderToStaticMarkup(renderQuotaUnavailableNote(t, account({
    quotas: {
      google: {
        weeklyFraction: 0.7,
        weeklyResetTime: new Date(Date.now() + 3 * 24 * HOUR).toISOString(),
        updatedAt: Date.now(),
      },
    },
    quotaUnavailable: { reason: 'no_summary_access', since: Date.now() - 1_000, retryAfter: Date.now() + 1_000 },
  })))
  assert.ok(tree.includes('quota.unavailable.no_summary_access'), 'weekly-only accounts keep the free-tier wording')
  assert.equal(tree.includes('no_summary_access_paid'), false)
})

test('the note reports the OLDEST family stamp, never the freshest', () => {
  const oldest = Date.now() - 30 * HOUR
  const tree = renderToStaticMarkup(renderQuotaUnavailableNote(t, account({
    quotas: {
      google: { remainingFraction: 0.9, updatedAt: oldest },
      argon: { weeklyFraction: 1, weeklyResetTime: new Date(Date.now() + HOUR).toISOString(), updatedAt: Date.now() },
    },
    quotaUnavailable: { reason: 'no_summary_access', since: oldest, retryAfter: Date.now() + HOUR },
  })))
  assert.ok(tree.includes('quota.unavailableSince'), 'the stale stamp must be surfaced')
  const d = new Date(oldest)
  const stamp = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  assert.ok(tree.includes(stamp), `expected the oldest stamp ${stamp} in ${tree}`)
})

test('a predicted family shows the muted badge AND the pin action', () => {
  const tree = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Gemini', 'google', {
    id: 'acc_1', alias: 'a', dir: '', enabled: true, createdAt: 1, cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 0.8,
        resetTime: new Date(Date.now() + 3_600_000).toISOString(),
        updatedAt: Date.now(),
      },
    },
  } as never, false, { isActive: true, predicted: true, canSetActive: true, onSetActive: () => {} }))
  assert.ok(tree.includes('account.predictedInUse'), 'said out loud that it is only predicted')
  assert.ok(tree.includes('account.setActive'), 'and pinnable, so it can be made real')
})
