import '../helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../../src/common/types.ts'
import { accountCoolingFamilies, isQuotaBenched } from '../../src/common/quota-bench.ts'
import { argonSharesGoogleGroup, sharedArgonPeerFamily, type ManagedAccount } from '../../src/common/pool-types.ts'
import { AccountPoolManager } from '../../src/host/pool.ts'
import { SessionStore } from '../../src/host/sessions.ts'
import { selectSessionAccount, stickyAccount } from '../../src/provider/account-selection.ts'
import { createLiveQuotaController } from '../../src/provider/quota-failover.ts'
import { refreshAccountQuotaPipeline } from '../../src/features/quota/refresh.ts'
import { AccountsPanel } from '../../src/client/sections/AccountsPanel.ts'

const SHARED_GEMINI_DESC =
  'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash'
const FLASH_ONLY_DESC = 'Models within this group: Gemini 3.8 Flash'

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

function makeSharedPool() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-shared-argon-'))
  const pool = new AccountPoolManager(dir)
  pool.setAccountEnabled('acc_primary', false)
  const acc1 = pool.createAccountSlot('Pro1')
  const acc2 = pool.createAccountSlot('Pro2')
  const accFree = pool.createAccountSlot('FreeFlash')
  const now = Date.now()
  const reset5h = new Date(now + 4 * 3_600_000).toISOString()
  const reset7d = new Date(now + 6 * 86_400_000).toISOString()
  for (const id of [acc1.id, acc2.id]) {
    pool.updateAccountQuotas(id, {
      google: {
        remainingFraction: 0.9,
        resetTime: reset5h,
        weeklyFraction: 0.85,
        weeklyResetTime: reset7d,
        description: SHARED_GEMINI_DESC,
        updatedAt: now,
      },
    })
  }
  pool.updateAccountQuotas(accFree.id, {
    google: {
      weeklyFraction: 1,
      weeklyResetTime: reset7d,
      description: FLASH_ONLY_DESC,
      models: [{ modelId: 'gemini-3.8-flash', remainingFraction: 1, resetTime: reset7d }],
      updatedAt: now,
    },
  })
  return { dir, pool, acc1, acc2, accFree, reset5h, reset7d }
}

test('Gap 3: catalog propagation lets explainIneligibility/selectAccount/getPoolData recognize discovered Argon without quotas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-argon-cat-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const accCat = pool.createAccountSlot('CatalogArgon')
    const accNeg = pool.createAccountSlot('NegativeModels')
    pool.updateAccountQuotas(accNeg.id, {
      google: {
        weeklyFraction: 1,
        models: [{ modelId: 'gemini-3.8-flash', remainingFraction: 1 }],
        updatedAt: Date.now(),
      },
    })
    const argonCatalog = {
      source: 'discovered',
      models: [
        { id: 'gemini-4-argon' },
        { id: 'gemini-pro-orchestrator-argon' },
        { id: 'gemini-3.8-flash' },
      ],
    }
    pool.setCatalog({
      get: () => ({ source: 'fallback', models: [] }),
      getAccountCatalog: (id?: string) => (id === accCat.id || id === accNeg.id ? argonCatalog : undefined),
    })

    assert.equal(pool.explainIneligibility(pool.getAccount(accCat.id)!, 'argon'), null)
    assert.equal(pool.selectAccount('argon', 'gemini-pro-orchestrator-argon')?.id, accCat.id)
    assert.equal(pool.getPoolData().resolvedActiveAccountIds?.argon, accCat.id)

    assert.equal(
      pool.explainIneligibility(pool.getAccount(accNeg.id)!, 'argon'),
      'unsupported',
      'explicit non-Argon per-model breakdown must still reject even if catalog lists Argon',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 1: shared-group google/argon cooldowns, countdowns, failover, clearCooldown, and UI stay bidirectionally linked', async () => {
  const { dir, pool, acc1, acc2, accFree, reset5h, reset7d } = makeSharedPool()
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const cfg = { ...defaultConfig(), parallelSameAccount: false }
    const futureIso = new Date(Date.now() + 2 * 3_600_000).toISOString()

    pool.setActiveAccount(acc1.id, 'argon')
    store.set(`s1:${acc1.id}`, {
      conversationId: 'conv-orch-1',
      lastMessageCount: 2,
      updatedAt: Date.now() + 10,
      model: 'gemini-pro-orchestrator-argon',
    })

    // 1. google 429 on acc1 cools BOTH google and argon, clears sticky, rotates Orchestrator to acc2
    pool.recordFailure(acc1.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', futureIso)

    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'argon'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'google'), 'cooldown')
    assert.equal(stickyAccount({ pool, store }, 'argon', 's1', 'gemini-pro-orchestrator-argon'), undefined)

    const rotated = await selectSessionAccount({
      deps: { pool, store },
      cfg,
      model: 'gemini-pro-orchestrator-argon',
      isAux: false,
      sessionKey: 's1',
    })
    assert.equal(rotated.account?.id, acc2.id)
    assert.notEqual(rotated.account?.id, acc1.id)
    assert.notEqual(rotated.account?.id, accFree.id)

    const resetArgon = pool.getEarliestResetCountdown('argon')
    const availArgon = pool.getEarliestAvailableCountdown('argon')
    assert.ok(resetArgon !== null && resetArgon > 0, `expected >0 argon reset countdown, got ${resetArgon}`)
    assert.ok(availArgon !== null && availArgon > 0, `expected >0 argon available countdown, got ${availArgon}`)

    // UI/readout hygiene: shared-group cooling reports ['google'] (no duplicate argon), and AccountsPanel hides phantom Argon bar
    const cooledAcc1 = pool.getAccount(acc1.id)!
    assert.deepEqual(accountCoolingFamilies(cooledAcc1, Date.now()), ['google'])
    const panelTree = JSON.stringify(AccountsPanel({
      t: ((k: string) => k) as never,
      pool: pool.getPoolData(),
      accounts: [cooledAcc1],
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
    assert.equal(panelTree.includes('"Argon"'), false, 'shared-group cooling must not render a phantom Argon bar')

    // 2. Reverse direction: argon 429 on acc2 cools BOTH argon & google; google advances to accFree while argon does not
    pool.recordFailure(acc2.id, 'argon', 'RESOURCE_EXHAUSTED (code 429)', futureIso)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'argon'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'google'), 'cooldown')
    assert.equal(pool.getPoolData().activeAccountIds?.google, accFree.id)
    assert.notEqual(pool.getPoolData().activeAccountIds?.argon, accFree.id)

    // 3. recordSuccess clears both peers in either direction
    pool.recordSuccess(acc1.id, 'google')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'google'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'argon'), null)

    pool.recordSuccess(acc2.id, 'argon')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'argon'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'google'), null)

    // 4. clearCooldown(id, 'argon', true) lifts both cooldown and quota bench for BOTH argon and google
    const now = Date.now()
    pool.updateAccountQuotas(acc1.id, {
      google: {
        remainingFraction: 0.02,
        resetTime: reset5h,
        weeklyFraction: 0.5,
        weeklyResetTime: reset7d,
        description: SHARED_GEMINI_DESC,
        updatedAt: now,
      },
    })
    pool.recordFailure(acc1.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', futureIso)
    assert.equal(isQuotaBenched(pool.getAccount(acc1.id)!, 'google', now), true)
    assert.equal(isQuotaBenched(pool.getAccount(acc1.id)!, 'argon', now), true)

    pool.clearCooldown(acc1.id, 'argon', true)
    assert.equal(isQuotaBenched(pool.getAccount(acc1.id)!, 'google', now), false)
    assert.equal(isQuotaBenched(pool.getAccount(acc1.id)!, 'argon', now), false)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'google'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'argon'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 1b: createLiveQuotaController records both families for shared-group subagent 429 when !alt', () => {
  const { dir, pool, acc1, acc2, accFree } = makeSharedPool()
  try {
    pool.setAccountEnabled(acc2.id, false)
    pool.setAccountEnabled(accFree.id, false)
    let killed = false
    const ctrl = createLiveQuotaController({
      pool,
      account: pool.getAccount(acc1.id)!,
      inputFamily: 'argon',
      activeModel: 'gemini-pro-orchestrator-argon',
      emitNotice: () => {},
      onTriggerKill: () => { killed = true },
    })

    ctrl.handleQuotaExhausted({
      source: 'subagent-transcript',
      role: 'Worker',
      model: 'gemini-4-hydrogen',
      errorText: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h0m0s.',
    })

    assert.equal(killed, false)
    assert.equal(ctrl.cooledFamilies().has('google'), true)
    assert.equal(ctrl.cooledFamilies().has('argon'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 1c: steady-state shared-group CLI /usage refresh preserves active 429 cooldown', async () => {
  const { dir, pool, acc1 } = makeSharedPool()
  try {
    const futureIso = new Date(Date.now() + 2 * 3_600_000).toISOString()
    pool.recordFailure(acc1.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', futureIso)
    assert.equal(pool.hasDedicatedGroup(acc1.id, 'argon'), false)

    await refreshAccountQuotaPipeline(
      {
        pool,
        shouldUseCli: () => true,
        readCliUsageFamilies: async () => ({
          google: {
            remainingFraction: 0.9,
            resetTime: futureIso,
            weeklyFraction: 0.9,
            weeklyResetTime: futureIso,
            description: SHARED_GEMINI_DESC,
            updatedAt: Date.now(),
          },
        }),
        getValidAccessToken: async () => null,
        proxyFor: () => undefined,
        fetchUserInfo: async () => null,
        fetchQuotaSummary: async () => null,
        fetchAvailableModels: async () => null,
        fetchUserQuota: async () => null,
        getTokenFilePath: () => '',
        detectEmailFromLogs: () => undefined,
        readPrimaryCredential: () => null,
        writePrimaryCredential: () => false,
        credentialFingerprint: () => null,
      },
      pool.getAccount(acc1.id)!,
      true,
    )

    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'google'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc1.id)!, 'argon'), 'cooldown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Gap 2: setActiveAccount, markAccountActive, isAux, and stickyAccount link google <-> argon bidirectionally on shared-group accounts', async () => {
  const { dir, pool, acc1, acc2 } = makeSharedPool()
  try {
    const store = new SessionStore(join(dir, 'sessions.json'))
    const cfg = { ...defaultConfig(), parallelSameAccount: false }

    // 1. setActiveAccount(acc2, 'argon') links google, lastActiveAccountId, and manualPinAtByFamily.google
    assert.equal(pool.setActiveAccount(acc2.id, 'argon'), true)
    let data = pool.getPoolData()
    assert.equal(data.activeAccountIds?.argon, acc2.id)
    assert.equal(data.activeAccountIds?.google, acc2.id)
    assert.equal(data.lastActiveAccountId, acc2.id)
    assert.ok((data.manualPinAtByFamily?.google ?? 0) > 0)

    // 2. markAccountActive(acc1, 'argon') updates google & lastActiveAccountId, so isAux Flash picks acc1
    pool.markAccountActive(acc1.id, 'argon')
    data = pool.getPoolData()
    assert.equal(data.activeAccountIds?.argon, acc1.id)
    assert.equal(data.activeAccountIds?.google, acc1.id)
    assert.equal(data.lastActiveAccountId, acc1.id)

    const auxRes = await selectSessionAccount({
      deps: { pool, store },
      cfg,
      model: 'gemini-3.8-flash',
      isAux: true,
      sessionKey: 'sess-shared',
    })
    assert.equal(auxRes.account?.id, acc1.id)

    // 3. stickyAccount shares affinity across argon and google models, and respects a newer manual pin on either side
    const bindTs = Date.now()
    store.set(`sess-shared:${acc2.id}`, {
      conversationId: 'conv-shared',
      lastMessageCount: 1,
      updatedAt: bindTs,
      model: 'gemini-pro-orchestrator-argon',
    })
    assert.equal(stickyAccount({ pool, store }, 'google', 'sess-shared', 'gemini-4-hydrogen')?.id, acc2.id)
    assert.equal(stickyAccount({ pool, store }, 'argon', 'sess-shared', 'gemini-pro-orchestrator-argon')?.id, acc2.id)

    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pool.setActiveAccount(acc1.id, 'google'), true)
    assert.equal(stickyAccount({ pool, store }, 'argon', 'sess-shared', 'gemini-pro-orchestrator-argon'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Dedicated Argon isolation remains intact when quotas.argon exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ded-argon-'))
  try {
    const pool = new AccountPoolManager(dir)
    pool.setAccountEnabled('acc_primary', false)
    const acc1 = pool.createAccountSlot('Ded1')
    const acc2 = pool.createAccountSlot('Ded2')
    const now = Date.now()
    const reset5h = new Date(now + 4 * 3_600_000).toISOString()
    const reset7d = new Date(now + 6 * 86_400_000).toISOString()
    for (const id of [acc1.id, acc2.id]) {
      pool.updateAccountQuotas(id, {
        google: { remainingFraction: 1, resetTime: reset5h, weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now },
        argon: { weeklyFraction: 1, weeklyResetTime: reset7d, updatedAt: now },
      })
    }

    pool.setActiveAccount(acc1.id, 'google')
    pool.setActiveAccount(acc2.id, 'argon')
    assert.equal(pool.getActiveAccountId('google'), acc1.id)
    assert.equal(pool.getActiveAccountId('argon'), acc2.id)

    pool.markAccountActive(acc2.id, 'argon')
    assert.equal(pool.getPoolData().activeAccountIds?.google, acc1.id)
    assert.equal(pool.getPoolData().activeAccountIds?.argon, acc2.id)

    pool.setActiveAccount(acc2.id, 'argon')
    pool.recordFailure(acc2.id, 'argon', 'RESOURCE_EXHAUSTED (code 429)', reset5h)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'argon'), 'cooldown')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'google'), null)

    pool.recordFailure(acc2.id, 'google', 'RESOURCE_EXHAUSTED (code 429)', reset5h)
    pool.recordSuccess(acc2.id, 'argon')
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'argon'), null)
    assert.equal(pool.explainIneligibility(pool.getAccount(acc2.id)!, 'google'), 'cooldown')

    const store = new SessionStore(join(dir, 'sessions.json'))
    store.set(`sess-ded:${acc1.id}`, {
      conversationId: 'conv-ded',
      lastMessageCount: 1,
      updatedAt: Date.now() + 20,
      model: 'gemini-pro-orchestrator-argon',
    })
    assert.equal(stickyAccount({ pool, store }, 'google', 'sess-ded', 'gemini-4-hydrogen'), undefined)

    // Ensure typecheck covers ManagedAccount usage cleanly
    const accCheck: ManagedAccount = pool.getAccount(acc1.id)!
    assert.ok(accCheck.quotas.argon)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Incident (2026-11-25): the primary account card showed TWO buckets — "Gemini
// 5h 63% / weekly 0%" and a second "Argon weekly 0%" row with the SAME reset
// instant. Upstream (agy 1.5.15+) reports the merged Gemini group under both
// keys: `quotas.google.description` enumerates "Gemini 4 Argon" as a member, and
// the extra `quotas.argon` row is the same physical bucket broken out per model.
// Presence of the argon row alone must not flip the account back to "independent
// ledgers" — the group's own membership list is the authoritative signal.
test('REGRESSION: a per-model argon row does not un-merge the shared Gemini group', () => {
  const now = Date.now()
  const weeklyReset = new Date(now + 6 * 86_400_000).toISOString()
  const merged = {
    id: 'acc_merged',
    alias: 'Merged',
    dir: '/tmp/merged',
    enabled: true,
    createdAt: now,
    lastUsedAt: now,
    quotas: {
      google: {
        remainingFraction: 0.63,
        resetTime: new Date(now + 3 * 3_600_000).toISOString(),
        weeklyFraction: 0,
        weeklyResetTime: weeklyReset,
        description: SHARED_GEMINI_DESC,
        updatedAt: now,
      },
      // Same bucket, reported again under the argon key (no 5h row of its own).
      argon: {
        weeklyFraction: 0,
        weeklyResetTime: weeklyReset,
        description: SHARED_GEMINI_DESC,
        updatedAt: now,
      },
    },
  } as unknown as ManagedAccount

  assert.equal(
    argonSharesGoogleGroup(merged),
    true,
    'google.description naming Argon proves one shared pool; the extra argon row is a per-model view of it',
  )
  assert.equal(sharedArgonPeerFamily(merged, 'google'), 'argon')
  assert.equal(sharedArgonPeerFamily(merged, 'argon'), 'google')

  // An account whose Gemini group does NOT name Argon keeps independent ledgers.
  const independent = {
    ...merged,
    quotas: {
      google: { remainingFraction: 0.63, weeklyFraction: 0.4, weeklyResetTime: weeklyReset, description: FLASH_ONLY_DESC, updatedAt: now },
      argon: { weeklyFraction: 0.9, weeklyResetTime: weeklyReset, updatedAt: now },
    },
  } as unknown as ManagedAccount
  assert.equal(argonSharesGoogleGroup(independent), false, 'a group that does not list Argon stays a separate ledger')

  // The card must show ONE bucket for the merged account…
  const renderCard = (acc: ManagedAccount): string => JSON.stringify(AccountsPanel({
    t: ((k: string) => k) as never,
    pool: undefined,
    accounts: [acc],
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
  const mergedTree = renderCard(merged)
  assert.equal(
    (mergedTree.match(/"data-family":"google"/g) ?? []).length,
    1,
    'the merged account must render exactly one Gemini bucket',
  )
  assert.equal(
    (mergedTree.match(/"data-family":"argon"/g) ?? []).length,
    0,
    'no phantom Argon bucket when the Gemini group already contains Argon',
  )
  const independentTree = renderCard(independent)
  assert.equal(
    (independentTree.match(/"data-family":"argon"/g) ?? []).length,
    1,
    'an independent Argon ledger must keep its own bucket row',
  )

})
