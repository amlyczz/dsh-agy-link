// Boot-time credential hygiene for pool accounts (issue-free hardening):
// an isolated pool home whose token file is missing must be quarantined, and a
// home whose credential came back must have the quarantine lifted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBootHygiene } from '../../src/host/boot-hygiene.ts'
import { defaultConfig } from '../../src/common/types.ts'
import type { HostServices } from '../../src/host/services.ts'
import type { ManagedAccount } from '../../src/common/pool-types.ts'

interface Harness {
  logs: string[]
  marked: Array<[string, string | undefined]>
  cleared: string[]
  services: HostServices
}

function harness(accounts: ManagedAccount[]): Harness {
  const logs: string[] = []
  const marked: Array<[string, string | undefined]> = []
  const cleared: string[] = []
  const services = {
    pool: {
      dir: '/tmp/pool-not-used',
      getAccounts: () => accounts,
      sweepStaleStaging: () => 0,
      sweepOldLogs: () => 0,
      markAuthRequired: (id: string, reason?: string) => marked.push([id, reason]),
      clearAuthRequired: (id: string) => cleared.push(id),
    },
    store: { cleanupStaleAccounts: () => {}, pruneStaleBindings: () => 0 },
    log: (m: string) => logs.push(m),
    getConfig: () => ({ ...defaultConfig(), logRetentionDays: 7 }),
  } as unknown as HostServices
  return { logs, marked, cleared, services }
}

function account(dir: string, over: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc_test', alias: 'Test', dir, systemHome: false, enabled: true, createdAt: 1, cooldowns: {}, quotas: {},
    ...over,
  } as ManagedAccount
}

test('boot hygiene quarantines an isolated account whose credential file is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-hyg-missing-'))
  try {
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
    const h = harness([account(home)])
    runBootHygiene(h.services)
    assert.deepEqual(h.marked, [['acc_test', 'credential file is missing or corrupted']])
    assert.ok(h.logs.some((l) => l.includes('no valid credential file')), 'the reason is logged')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('boot hygiene lifts the quarantine once a valid credential is back', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-hyg-back-'))
  try {
    const dir = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'antigravity-oauth-token'), JSON.stringify({ token: { refresh_token: '1//fake-refresh-token-for-test' } }), { mode: 0o600 })
    const h = harness([account(home, { authRequired: true, authError: 'credential file is missing or corrupted' })])
    runBootHygiene(h.services)
    assert.deepEqual(h.cleared, ['acc_test'])
    assert.deepEqual(h.marked, [], 'an account with a valid credential is not re-quarantined')
    assert.ok(h.logs.some((l) => l.includes('credential restored')), 'the recovery is logged')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('boot hygiene never touches the system-home account or a dir-less account', () => {
  const h = harness([
    account('', { id: 'acc_nodir' }),
    account('/tmp/nonexistent-system-home', { id: 'acc_sys', systemHome: true }),
  ])
  runBootHygiene(h.services)
  assert.deepEqual(h.marked, [], 'systemHome accounts are the user\'s own login and stay untouched')
  assert.deepEqual(h.cleared, [])
})
