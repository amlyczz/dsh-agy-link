// The header's predicted account must be able to serve the session's model.
// Regression: after switching a session from Hydrogen to Neon, the header kept
// naming a Hydrogen-only account (the family-level prediction preferred the
// narrowest account) while dispatch correctly ran on the Neon-capable pin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ManagedAccount } from '../../src/common/pool-types.ts'
import type { HostServices } from '../../src/host/services.ts'
import { resolveSessionView } from '../../src/host/session-view.ts'

const NOW = Date.now()
const iso = (h: number) => new Date(NOW + h * 3600_000).toISOString()

function acc(id: string, models: string[]): ManagedAccount {
  return {
    id,
    alias: id,
    dir: '',
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 0.5,
        resetTime: iso(5),
        weeklyResetTime: iso(100),
        models: models.map((modelId) => ({ modelId, remainingFraction: 1 })),
      },
    },
  } as ManagedAccount
}

function services(model: string, activeGoogle = 'h-only'): HostServices {
  const accounts = [acc('h-only', ['gemini-4-hydrogen']), acc('dual', ['gemini-4-hydrogen', 'gemini-4-neon'])]
  const pool = {
    getAccounts: () => accounts,
    getAccount: (id: string) => accounts.find((a) => a.id === id),
    // Family-level prediction (no model) is what the pool snapshot carries.
    getPoolData: () => ({ accounts, activeAccountIds: { google: activeGoogle }, resolvedActiveAccountIds: { google: activeGoogle } }),
    isModelSupported: (a: ManagedAccount, m: string) => a.id === 'dual' || !m.startsWith('gemini-4-neon'),
  }
  return {
    getConfig: () => ({ defaultModel: model }),
    sessionsSvc: () => undefined,
    pool,
    store: { all: () => ({}), get: () => undefined, delete: () => {} },
  } as unknown as HostServices
}

test('Neon session header names the Neon-capable account, not a Hydrogen-only pin', () => {
  const view = resolveSessionView(services('gemini-4-neon', 'h-only'), '')
  assert.equal(view.model, 'gemini-4-neon')
  assert.equal(view.accountId, 'dual')
})

test('Hydrogen session header stays locked on the pinned account instead of splitting to a narrower one', () => {
  assert.equal(resolveSessionView(services('gemini-4-hydrogen', 'dual'), '').accountId, 'dual')
})
