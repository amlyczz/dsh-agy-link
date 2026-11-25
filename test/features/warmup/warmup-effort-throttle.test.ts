// Warmup probe hygiene: `--effort` handling and per-run risk pacing.
//
// Two regressions this pins:
//  1. `--effort low` was appended for claude-sonnet-5-5, which agy 1.5.15
//     rejects outright ("--effort is not supported for model …"), so the
//     Anthropic weekly window was NEVER activated — every run burned a probe
//     and a failure backoff on an argument the CLI always refuses.
//  2. Accounts were probed 1.5–3s apart, so a 7-account pool looked like a
//     farm sweeping one egress IP. Accounts are now minutes apart and a single
//     run has a hard probe budget.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WarmupHistoryStore, WarmupService, supportsProbeEffort } from '../../../src/host/warmup.ts'
import { warmupAccountGapMs } from '../../../src/features/warmup/policy.ts'
import { defaultConfig, type PluginConfig } from '../../../src/common/types.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import type { AccountPoolManager } from '../../../src/host/pool.ts'
import type { QuotaService } from '../../../src/host/quota.ts'
import type { CliProbeOutcome, WarmupCliDeps, WarmupProbeOptions } from '../../../src/host/warmup.ts'

const OK_PROBE: CliProbeOutcome = {
  code: 0,
  stdout: '{"type":"result","subtype":"success","status":"OK","response":"hi"}\n',
  stderr: '',
  durationMs: 12,
}

const EFFORT_REFUSAL: CliProbeOutcome = {
  code: 1,
  stdout: '',
  stderr: 'invalid model selection (--model "gemini-4-argon" --effort "low"): --effort is not supported for model "gemini-4-argon"',
  durationMs: 9,
}

function makeAccount(id: string, now: number): ManagedAccount {
  return {
    id,
    alias: id,
    email: `${id}@example.com`,
    dir: '',
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 1,
        weeklyFraction: 1,
        weeklyResetTime: new Date(now + 7 * 24 * 3600_000).toISOString(),
      },
    },
  }
}

function makeService(opts: {
  accounts?: ManagedAccount[]
  cfg?: Partial<PluginConfig>
  deps: WarmupCliDeps
  dir: string
}): WarmupService {
  const pool = {
    dir: opts.dir,
    getAccounts: () => opts.accounts ?? [],
    getAccount: (id: string) => (opts.accounts ?? []).find((a) => a.id === id),
    markAuthRequired: () => undefined,
  }
  return new WarmupService(
    pool as unknown as AccountPoolManager,
    {} as QuotaService,
    () => '',
    () => '1.5.15',
    () => ({ ...defaultConfig(), autoWarmup: true, ...opts.cfg }) as PluginConfig,
    () => undefined,
    new WarmupHistoryStore(join(opts.dir, 'history.json')),
    opts.deps,
  )
}

test('supportsProbeEffort only claims families whose CLI takes --effort', () => {
  assert.equal(supportsProbeEffort('gemini-3.8-flash'), true)
  assert.equal(supportsProbeEffort('gemini-4-argon'), true)
  assert.equal(supportsProbeEffort('claude-sonnet-5-5'), false)
  assert.equal(supportsProbeEffort('gpt-oss-120b-medium'), false)
})

test('claude is probed without --effort (the flag the CLI rejects)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-effort-claude-'))
  const calls: Array<{ model: string; options?: WarmupProbeOptions }> = []
  try {
    const service = makeService({
      dir,
      deps: {
        runCliProbe: async (_acc, model, options) => {
          calls.push({ model, options })
          return OK_PROBE
        },
      },
    })
    const res = await service.probeModel(makeAccount('a', Date.now()), 'claude-sonnet-5-5')
    assert.equal(res.ok, true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { model: 'claude-sonnet-5-5', options: { effort: false } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a learned refusal is honoured up front instead of retried forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-effort-learned-'))
  const calls: Array<{ model: string; options?: WarmupProbeOptions }> = []
  try {
    const service = makeService({
      dir,
      deps: {
        runCliProbe: async (_acc, model, options) => {
          calls.push({ model, options })
          return OK_PROBE
        },
        effortUnsupported: () => ['gemini-4-argon'],
      },
    })
    const res = await service.probeModel(makeAccount('a', Date.now()), 'gemini-4-argon')
    assert.equal(res.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.options?.effort, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unexpected effort refusal is learned and retried once without the flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-effort-retry-'))
  const calls: Array<{ model: string; options?: WarmupProbeOptions }> = []
  const learned: string[] = []
  try {
    const service = makeService({
      dir,
      deps: {
        runCliProbe: async (_acc, model, options) => {
          calls.push({ model, options })
          return calls.length === 1 ? EFFORT_REFUSAL : OK_PROBE
        },
        effortUnsupported: () => [],
        onEffortUnsupported: (model) => learned.push(model),
      },
    })
    const res = await service.probeModel(makeAccount('a', Date.now()), 'gemini-4-argon')
    assert.equal(res.ok, true, 'the retry without --effort must succeed')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.options?.effort, true)
    assert.equal(calls[1]?.options?.effort, false)
    assert.deepEqual(learned, ['gemini-4-argon'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cross-account gap is minutes, not seconds (30–120s randomized)', () => {
  assert.equal(warmupAccountGapMs(() => 0), 30_000)
  assert.equal(warmupAccountGapMs(() => 0.5), 75_000)
  assert.equal(warmupAccountGapMs(() => 0.999_999), 119_999)
})

test('a run stops at warmupMaxProbesPerRun and reports the rest as skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-budget-'))
  const now = Date.now()
  const accounts = [makeAccount('a1', now), makeAccount('a2', now), makeAccount('a3', now)]
  const probes: string[] = []
  const sleeps: number[] = []
  try {
    const service = makeService({
      dir,
      accounts,
      cfg: { warmupMaxProbesPerRun: 2, warmupModels: ['gemini-3.8-flash'] },
      deps: {
        runCliProbe: async (acc) => {
          probes.push(acc.id)
          return OK_PROBE
        },
        sleep: async (ms) => { sleeps.push(ms) },
      },
    })
    const results = await service.warmupAllAccounts({ trigger: 'manual' })
    assert.deepEqual(probes, ['a1', 'a2'], 'the third account must not be probed')
    const deferred = results.filter((r) => r.skipped === true)
    assert.equal(deferred.length, 1)
    assert.equal(deferred[0]?.accountId, 'a3')
    assert.equal(deferred[0]?.skipReason, 'Run probe budget exhausted')
    assert.equal(sleeps.length, 1, 'one gap between the two probed accounts')
    assert.ok(sleeps[0]! >= 30_000 && sleeps[0]! <= 120_000, `gap out of range: ${sleeps[0]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0 disables the probe budget (legacy behaviour stays reachable)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'warmup-budget-off-'))
  const now = Date.now()
  const accounts = [makeAccount('b1', now), makeAccount('b2', now), makeAccount('b3', now)]
  const probes: string[] = []
  try {
    const service = makeService({
      dir,
      accounts,
      cfg: { warmupMaxProbesPerRun: 0, warmupModels: ['gemini-3.8-flash'] },
      deps: {
        runCliProbe: async (acc) => {
          probes.push(acc.id)
          return OK_PROBE
        },
        sleep: async () => undefined,
      },
    })
    await service.warmupAllAccounts({ trigger: 'manual' })
    assert.deepEqual(probes, ['b1', 'b2', 'b3'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
