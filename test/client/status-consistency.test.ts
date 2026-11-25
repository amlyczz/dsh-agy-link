import { renderToStaticMarkup } from '../helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountPoolManager } from '../../src/host/pool.ts'
import { QuotaService } from '../../src/host/quota.ts'
import { handlePool } from '../../src/host/commands/pool.ts'
import { R } from '../../src/client/react.ts'
import { publishStatusSnapshot } from '../../src/client/status.ts'
import { AccountsPanel } from '../../src/client/sections/AccountsPanel.ts'
import { renderFamilyQuotaBar, renderQuotaUnavailableNote } from '../../src/client/sections/QuotaPanel.ts'
import { createSessionStatus } from '../../src/client/sections/SessionStatus.ts'
import { agyModalStore, modalHostManager } from '../../src/client/ui/Modal.ts'

const noopHandlers = {
  moveAccount: async () => {},
  setActiveAccount: async () => {},
  beginReauth: async () => {},
  removeAccount: async () => {},
  toggleAccountEnabled: async () => {},
  refreshQuota: async () => {},
  warmupAccount: async () => {},
  saveProxy: async () => {},
  saveAlias: async () => {},
  clearCooldown: async () => {},
}

test('per-family cooling isolates card dot color, renders unified cooldown actions, and preserves healthy family controls', () => {
  const t = ((k: string) => k) as never
  const now = Date.now()
  const benchedAcc = {
    id: 'acc_god',
    alias: 'god',
    email: 'god@example.com',
    dir: '/tmp/god',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 0,
        resetTime: new Date(now + 4 * 60_000).toISOString(),
        weeklyFraction: 0.53,
        weeklyResetTime: new Date(now + 6 * 86_400_000).toISOString(),
        updatedAt: now,
      },
      argon: {
        weeklyFraction: 1,
        weeklyResetTime: new Date(now + 7 * 86_400_000).toISOString(),
        updatedAt: now,
      },
    },
  }

  const tree = JSON.stringify(AccountsPanel({
    t,
    pool: { mode: 'sequential', accounts: [benchedAcc], primaryAccountId: 'acc_other' } as never,
    accounts: [benchedAcc] as never,
    loadingAction: null,
    proxyInputs: {},
    setProxyInputs: () => {},
    editingProxyId: null,
    setEditingProxyId: () => {},
    aliasInputs: {},
    setAliasInputs: () => {},
    editingAliasId: null,
    setEditingAliasId: () => {},
    expandedModels: {},
    toggleExpand: () => {},
    optimisticActiveByFamily: {},
    warmupState: null,
    handlers: noopHandlers,
  }))

  // Google is cooling, but Argon is 100% healthy -> card remains available (green), not amber.
  assert.ok(tree.includes('#10b981'), 'account with healthy Argon stays green even when Gemini is cooling')
  assert.equal(tree.includes('#f59e0b') && !tree.includes('rgba(245, 158, 11'), false)
  assert.ok(tree.includes('status.cooldown'), 'cooling family renders unified cooldown badge')
  assert.ok(tree.includes('account.clearCooldown'), 'cooling family exposes clear-cooldown action')
  assert.ok(tree.includes('account.setActive'), 'healthy Argon family still exposes per-family setActive')
  assert.equal(tree.includes('status.quotaLimited'), false, 'redundant account-level quotaLimited badge removed')
  assert.equal(tree.includes('account.cooldown'), false, 'redundant account-level cooldown banner removed')
  assert.equal(tree.includes('"AGY"'), false, 'redundant static [AGY] badge removed')

  const fullyCoolingAcc = {
    ...benchedAcc,
    quotas: {
      google: benchedAcc.quotas.google,
      argon: {
        weeklyFraction: 0,
        weeklyResetTime: new Date(now + 7 * 86_400_000).toISOString(),
        updatedAt: now,
      },
    },
  }
  const fullTree = JSON.stringify(AccountsPanel({
    t,
    pool: { mode: 'sequential', accounts: [fullyCoolingAcc], primaryAccountId: 'acc_other' } as never,
    accounts: [fullyCoolingAcc] as never,
    loadingAction: null,
    proxyInputs: {},
    setProxyInputs: () => {},
    editingProxyId: null,
    setEditingProxyId: () => {},
    aliasInputs: {},
    setAliasInputs: () => {},
    editingAliasId: null,
    setEditingAliasId: () => {},
    expandedModels: {},
    toggleExpand: () => {},
    optimisticActiveByFamily: {},
    warmupState: null,
    handlers: noopHandlers,
  }))
  assert.ok(fullTree.includes('#f59e0b'), 'account where ALL known families are cooling renders amber dot')
  assert.equal(fullTree.includes('account.setActive'), false, 'setActive hidden across all cooling families')

  const barTree = JSON.stringify(renderFamilyQuotaBar(t, 'Gemini', 'google', benchedAcc as never, false, {
    isActive: false,
    canSetActive: true,
    onSetActive: () => {},
    onClearCooldown: () => {},
  }))
  assert.ok(barTree.includes('status.cooldown'), 'cooling family header displays status.cooldown')
  assert.ok(barTree.includes('account.clearCooldown'), 'cooling family header exposes clearCooldown')
  assert.equal(barTree.includes('account.quotaLimitedNote'), false, 'redundant quotaLimitedNote suffix removed')
  assert.equal(barTree.includes('account.localCooldown'), false, 'redundant localCooldown suffix removed')
  assert.equal(barTree.includes('account.setActive'), false, 'setActive hidden for cooling family')

  // Once the user clears the quota gate, the warning and bench clear immediately.
  const clearedAcc = {
    ...benchedAcc,
    quotaGateClearedAt: { google: now },
  }
  const clearedTree = JSON.stringify(AccountsPanel({
    t,
    pool: { mode: 'sequential', accounts: [clearedAcc], primaryAccountId: 'acc_other' } as never,
    accounts: [clearedAcc] as never,
    loadingAction: null,
    proxyInputs: {},
    setProxyInputs: () => {},
    editingProxyId: null,
    setEditingProxyId: () => {},
    aliasInputs: {},
    setAliasInputs: () => {},
    editingAliasId: null,
    setEditingAliasId: () => {},
    expandedModels: {},
    toggleExpand: () => {},
    optimisticActiveByFamily: {},
    warmupState: null,
    handlers: noopHandlers,
  }))
  assert.ok(clearedTree.includes('#10b981'), 'cleared quota gate restores green dot')
  assert.equal(clearedTree.includes('status.cooldown'), false)
  assert.ok(clearedTree.includes('account.setActive'), 'setActive returns once quota gate is cleared')
})

test('SessionStatus turns amber when google/all accounts are cooling, and stays green if only non-google cools', () => {
  const testLocale = { subscribe: () => () => {}, bind: () => (k: string) => k }
  const Badge = createSessionStatus(testLocale as never, () => null)
  const prevOpen = agyModalStore.open
  const prevActive = modalHostManager.activeId
  try {
    modalHostManager.activeId = null
    agyModalStore.setOpen(false)
    const now = Date.now()
    publishStatusSnapshot({
      pool: {
        mode: 'sequential',
        primaryAccountId: 'acc_1',
        activeAccountId: 'acc_1',
        accounts: [{
          id: 'acc_1',
          alias: 'god',
          dir: '',
          enabled: true,
          createdAt: 1,
          cooldowns: {},
          quotas: {
            google: {
              remainingFraction: 0,
              resetTime: new Date(now + 10 * 60_000).toISOString(),
              updatedAt: now,
            },
          },
        }],
      },
    } as never)
    const html = renderToStaticMarkup(R.createElement(Badge, null) as never)
    assert.ok(html.includes('#f59e0b'), 'header badge dot must turn amber when pool is quota-benched')

    publishStatusSnapshot({
      pool: {
        mode: 'sequential',
        primaryAccountId: 'acc_1',
        activeAccountId: 'acc_1',
        resolvedActiveAccountIds: { google: 'acc_1' },
        accounts: [{
          id: 'acc_1',
          alias: 'god',
          dir: '',
          enabled: true,
          createdAt: 1,
          cooldowns: {},
          quotas: {
            google: {
              remainingFraction: 1,
              resetTime: new Date(now + 10 * 60_000).toISOString(),
              updatedAt: now,
            },
            anthropic: {
              remainingFraction: 0,
              resetTime: new Date(now + 10 * 60_000).toISOString(),
              updatedAt: now,
            },
          },
        }],
      },
    } as never)
    const healthyGoogleHtml = renderToStaticMarkup(R.createElement(Badge, null) as never)
    assert.ok(healthyGoogleHtml.includes('#10b981'), 'header badge dot stays green when google is healthy and only anthropic cools')
    assert.equal(healthyGoogleHtml.includes('#f59e0b'), false)
  } finally {
    agyModalStore.setOpen(prevOpen)
    modalHostManager.activeId = prevActive
  }
})

test('setActiveAccount rejects cooldown/quota-benched accounts consistently with getActiveAccountId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-status-active-'))
  try {
    const pool = new AccountPoolManager(dir)
    const first = pool.getAccounts()[0]!
    const second = pool.createAccountSlot('Second')
    const now = Date.now()

    pool.updateAccountQuotas(first.id, {
      google: { remainingFraction: 1, resetTime: new Date(now + 3_600_000).toISOString(), updatedAt: now },
    })
    pool.updateAccountQuotas(second.id, {
      google: { remainingFraction: 0, resetTime: new Date(now + 10 * 60_000).toISOString(), updatedAt: now },
    })

    assert.equal(pool.setActiveAccount(second.id, 'google'), false, 'cannot pin quota-benched account')
    assert.equal(pool.getActiveAccountId('google'), first.id, 'active pointer stays on eligible account')

    // Clearing the quota gate allows pinning cleanly.
    pool.clearCooldown(second.id, 'google', true)
    assert.equal(pool.setActiveAccount(second.id, 'google'), true)
    assert.equal(pool.getActiveAccountId('google'), second.id)

    // Local 429 cooldown also blocks setActiveAccount until cleared.
    pool.recordFailure(first.id, 'google', '429 Rate Limit', new Date(now + 60_000).toISOString())
    assert.equal(pool.setActiveAccount(first.id, 'google'), false, 'cannot pin cooling account')
    assert.equal(pool.getActiveAccountId('google'), second.id)

    // /agy pool command reflects quota-limited instead of Ready.
    pool.updateAccountQuotas(second.id, {
      google: { remainingFraction: 0, resetTime: new Date(now + 10 * 60_000).toISOString(), updatedAt: now + 100 },
    })
    const poolRes = await handlePool(
      { pool: () => pool, cfg: () => ({}) as never } as never,
      { sub: 'pool', arg: '', raw: '/agy pool' } as never,
    )
    assert.ok((poolRes.text ?? '').includes('Gemini cooling'), `/agy pool should flag cooling family: ${poolRes.text ?? ''}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderQuotaUnavailableNote uses the oldest frozen family timestamp instead of a newer partial row', () => {
  const t = ((k: string, vars?: Record<string, string | number>) =>
    vars?.time ? `${k}:${vars.time}` : k) as never
  const frozenAt = new Date(2026, 10, 20, 11, 27, 0).getTime()
  const partialAt = new Date(2026, 10, 20, 14, 5, 0).getTime()
  const acc = {
    id: 'acc_dao',
    alias: 'dao',
    dir: '/tmp/dao',
    enabled: true,
    createdAt: 1,
    cooldowns: {},
    quotaUnavailable: { reason: 'unreachable', since: partialAt, retryAfter: partialAt + 60_000, detail: 'ECONNRESET' },
    quotas: {
      google: { remainingFraction: 0, updatedAt: frozenAt },
      argon: { weeklyFraction: 1, updatedAt: partialAt },
    },
  }
  const note = JSON.stringify(renderQuotaUnavailableNote(t, acc as never))
  assert.ok(note.includes('11/20 11:27'), `expected oldest frozen stamp 11/20 11:27, got: ${note}`)
  assert.equal(note.includes('14:05'), false)
})

test('VALIDATION_REQUIRED summary refusal marks authRequired consistently and heals on verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-status-val-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const acc = pool.createAccountSlot('verify-me')
    pool.clearAuthRequired(acc.id, true)
    const tokenDir = join(acc.dir, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(
      join(tokenDir, 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'tok', refresh_token: 'ref', expiry: Date.now() + 3_600_000 }, auth_method: 'consumer' }),
      'utf8',
    )

    let verified = false
    class VerifyQuotaService extends QuotaService {
      constructor() {
        super(pool, () => '', () => '1.5.12', { bin: () => null, viaCli: () => false })
      }
      override async fetchUserInfo(): Promise<{ email?: string }> {
        return { email: 'verify@example.com' }
      }
      protected override async fetchSummaryEndpoint(): Promise<Response> {
        if (!verified) {
          return new Response(JSON.stringify({
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'VALIDATION_REQUIRED', metadata: { validation_url: 'https://accounts.google.com/v3/signin/continue?plt=xyz' } }],
            },
          }), { status: 403 })
        }
        return new Response(JSON.stringify({
          groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-20T18:00:00Z' }] }],
        }), { status: 200 })
      }
      protected override async fetchUserQuotaEndpoint(): Promise<Response> {
        return new Response('{}', { status: 200 })
      }
      override async fetchAvailableModels(): Promise<never> {
        return { models: {} } as never
      }
    }

    const qs = new VerifyQuotaService()
    await qs.refreshAccountQuota(pool.getAccount(acc.id)!, true)
    const blocked = pool.getAccount(acc.id)!
    assert.equal(blocked.authRequired, true, 'VALIDATION_REQUIRED must mark authRequired immediately')
    assert.ok(blocked.authError?.includes('https://accounts.google.com/v3/signin/continue?plt=xyz'))
    assert.equal(pool.isAccountEligible(blocked, 'google'), false)

    verified = true
    await qs.refreshAccountQuota(pool.getAccount(acc.id)!, true)
    const healed = pool.getAccount(acc.id)!
    assert.equal(healed.authRequired, undefined, 'successful summary after verification clears authRequired')
    assert.equal(healed.quotaUnavailable, undefined)
    assert.equal(pool.isAccountEligible(healed, 'google'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
