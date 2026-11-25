// The console's per-family "当前使用" badge must describe reality, not a guess.
//
// Reported 2026-11-23: a session running Orchestrator (Argon) as `ele` showed
// the Argon row claiming the PRIMARY account was in use. The row was rendering
// the eligibility PREDICTION ("who would be picked") under an "in use" label,
// because only the google pointer was ever written.
import { renderToStaticMarkup } from '../helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountPoolManager } from '../../src/host/pool.ts'
import { renderFamilyQuotaBar } from '../../src/client/sections/QuotaPanel.ts'

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars === undefined ? key : `${key}[${Object.values(vars).join(',')}]`) as never

test('markAccountActive is family-scoped: an argon run never rewrites the google pointer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-active-scope-'))
  try {
    const pool = new AccountPoolManager(dir)
    const a = pool.createAccountSlot('a')
    const b = pool.createAccountSlot('b')

    pool.markAccountActive(a.id)                 // google
    pool.markAccountActive(b.id, 'argon')        // argon turn actually served by b

    const data = pool.getPoolData()
    assert.equal(data.activeAccountIds?.google, a.id, 'google pointer untouched')
    assert.equal(data.activeAccountIds?.argon, b.id, 'argon pointer records the account that ran')
    assert.equal(data.lastActiveAccountId, a.id, 'the global pointer stays on the google pick')
    assert.equal(pool.getAccount(b.id)?.id, b.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a predicted family shows "predicted", a real pin shows "in use"', () => {
  const acc = {
    id: 'acc_1', alias: 'a', dir: '', enabled: true, createdAt: 1, cooldowns: {},
    quotas: { argon: { weeklyFraction: 1, weeklyResetTime: new Date(Date.now() + 86_400_000).toISOString() } },
  } as never

  const predicted = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Argon', 'argon', acc, false, {
    isActive: true,
    predicted: true,
  }))
  assert.ok(predicted.includes('account.predictedInUse'), 'an unpinned family must not claim to be in use')
  assert.equal(predicted.includes('status.inUse'), false)

  const pinned = renderToStaticMarkup(renderFamilyQuotaBar(t, 'Argon', 'argon', acc, false, {
    isActive: true,
    predicted: false,
  }))
  assert.ok(pinned.includes('status.inUse'), 'a real pin reads "in use"')
  assert.equal(pinned.includes('account.predictedInUse'), false)
})
