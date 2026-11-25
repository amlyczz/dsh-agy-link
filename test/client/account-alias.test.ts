// One alias rule for the console card, the action toasts and the header badge.
//
// The three copies each compared the stored string with the old Chinese
// literal `主账号 (系统登录)`, so an account whose label had been written in any
// other language rendered its raw text on one surface and the localized
// default on another.
import test from 'node:test'
import assert from 'node:assert/strict'

import { accountDisplayAlias } from '../../src/client/sections/account-alias.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars === undefined ? key : `${key}#${Object.values(vars).join(',')}`) as never

function acc(over: Partial<ManagedAccount>): ManagedAccount {
  return { id: 'acc_1', alias: 'x', dir: '', enabled: true, createdAt: 1, cooldowns: {}, ...over } as ManagedAccount
}

test('a generated default on the primary slot is localized in every language', () => {
  for (const stored of ['主账号 (系统登录)', 'Primary account (system sign-in)', 'Cuenta principal (inicio de sesión del sistema)']) {
    const a = acc({ alias: stored, systemHome: true })
    assert.equal(accountDisplayAlias(t, a, 0), 'account.defaultAlias', stored)
  }
})

test('a generated backup alias renders with its 1-based position', () => {
  const a = acc({ alias: 'Backup Google account 2', defaultAlias: true })
  assert.equal(accountDisplayAlias(t, a, 1), 'account.aliasDefault#2')
})

test('an explicit alias is shown verbatim', () => {
  assert.equal(accountDisplayAlias(t, acc({ alias: 'dao' }), 0), 'dao')
  assert.equal(accountDisplayAlias(t, acc({ alias: 'dao', defaultAlias: false, systemHome: true }), 0), 'dao')
})

test('a missing account renders nothing', () => {
  assert.equal(accountDisplayAlias(t, undefined, 0), '')
})