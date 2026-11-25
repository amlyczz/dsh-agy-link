// Regression tests for issue #124 — PR #119 shipped two linked defects:
//  1. `RunRecording.hasResult` was true from the first `init` frame, so the
//     synthetic result appended on an idle-grace kill never ran and every such
//     turn failed with "agy stream ended without a result event".
//  2. the 5s idle grace killed the process tree even while agy was legitimately
//     waiting for `invoke_subagent` / `send_message` / `run_workflow` / `swarm`
//     subagents to wake the root agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RunRecording } from '../../src/host/recording.ts'
import { startAgyProcess } from '../../src/runtime/agy/process.ts'
import type { AgyEvent } from '../../src/common/types.ts'

const init: AgyEvent = { kind: 'init', conversationId: 'conv-1', raw: {} } as AgyEvent
const result: AgyEvent = { kind: 'result', conversationId: 'conv-1', ok: true, response: 'hi', raw: {} } as AgyEvent

test('issue #124: hasResult reflects a real result envelope, not the init conversation id', () => {
  const rec = new RunRecording('run-1')
  assert.equal(rec.hasResult, false, 'a fresh recording has no result')
  rec.append(init)
  assert.equal(rec.conversationId, 'conv-1', 'init still supplies the conversation id')
  assert.equal(rec.hasResult, false, 'init alone must not claim a result')
  rec.append(result)
  assert.equal(rec.hasResult, true, 'the real result envelope flips it')
})

/** Spawn a child that reports the idle line (0 remaining tasks) and then stays alive. */
function idleChild(opts: { idleGraceMs: number }) {
  const script = `
    process.stderr.write('root agent idle; waiting up to 240m0s for 0 background task(s)\\n');
    setInterval(() => {}, 1000);
  `
  return startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 30_000,
    stderrKeepalive: true,
    idleGraceMs: opts.idleGraceMs,
  })
}

test('issue #124: an idle-grace kill is skipped while a subagent is being awaited', async () => {
  const proc = idleChild({ idleGraceMs: 60 })
  proc.exemptIdleGrace(true)
  // Well past the grace window: the child must still be running.
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(proc.child.exitCode, null, 'a subagent wait must not be killed after 5s')
  proc.exemptIdleGrace(false)
  // Once the exemption is lifted, the next idle grace reclaims it promptly.
  await new Promise((r) => setTimeout(r, 300))
  const outcome = await proc.outcome
  assert.equal(outcome.idleGraceTerminated, true, 'the reaper still works after the wait ends')
})

test('issue #124: new stdout output cancels a pending idle-grace kill', async () => {
  const script = `
    process.stderr.write('root agent idle; waiting up to 240m0s for 0 background task(s)\\n');
    setTimeout(() => { process.stdout.write('{"event":"step_update"}\\n'); }, 30);
    setInterval(() => {}, 1000);
  `
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 30_000,
    stderrKeepalive: true,
    idleGraceMs: 120,
  })
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(proc.child.exitCode, null, 'a wake-up on stdout must cancel the pending kill')
  proc.kill('abort')
  await proc.outcome
})

test('issue #124: the watchdog exempts the idle reaper only for subagent-collab tools', async () => {
  const { createToolWatchdog } = await import('../../src/provider/tool-watchdog.ts')
  const { defaultConfig } = await import('../../src/common/types.ts')
  const calls: boolean[] = []
  const wd = createToolWatchdog(undefined, defaultConfig())
  wd.attach({ noteActivity: () => {}, exemptIdleGrace: (v: boolean) => calls.push(v) } as never)
  // attach() syncs the initial (false) state; only transitions matter below.
  calls.length = 0

  const tool = (name: string, stepKey: string) =>
    ({ kind: 'step', stepKey, stepKind: 'tool', state: 'RUNNING', tool: { name } }) as never
  const text = (stepKey: string) => ({ kind: 'step', stepKey, stepKind: 'text', text: 'back' }) as never

  // An ordinary background command must NOT get the exemption: that is exactly
  // the orphaned-dev-server case #119 exists to reclaim.
  wd.trackStep(tool('run_command', 'c1'))
  assert.deepEqual(calls, [], 'run_command keeps the 5s reaper')

  wd.trackStep(tool('invoke_subagent', 't1'))
  assert.deepEqual(calls, [true], 'a subagent wait suspends the reaper')
  // A repeated report of the same tool state is idempotent.
  wd.trackStep(tool('invoke_subagent', 't1'))
  assert.deepEqual(calls, [true])

  wd.trackStep(text('x1'))
  assert.deepEqual(calls, [true, false], 'the root agent speaking again resumes the reaper')

  // If invoke_subagent fails or is canceled immediately, the reaper exemption must lift right away.
  wd.trackStep(tool('invoke_subagent', 't2'))
  assert.deepEqual(calls, [true, false, true])
  wd.trackStep({ kind: 'step', stepKey: 't2', stepKind: 'tool', state: 'CANCELED', tool: { name: 'invoke_subagent', error: 'canceled' } } as never)
  assert.deepEqual(calls, [true, false, true, false], 'CANCELED subagent must drop idle-grace exemption')
  wd.stop()
})

test('issue #125: model support stays ACCOUNT-scoped so routing picks the right account', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { AccountPoolManager } = await import('../../src/host/pool.ts')

  const dir = mkdtempSync(join(tmpdir(), 'agy-125-'))
  const pool = new AccountPoolManager(dir)
  pool.createAccountSlot('second')
  const [a, b] = pool.getAccounts()
  const model = 'gemini-4-hydrogen'
  pool.updateAccountQuotas(a!.id, {
    google: { updatedAt: Date.now(), models: [{ modelId: 'gemini-3.8-flash-high', remainingFraction: 1 }] },
  } as never)
  pool.updateAccountQuotas(b!.id, {
    google: { updatedAt: Date.now(), models: [{ modelId: 'gemini-4-hydrogen-high', remainingFraction: 1 }] },
  } as never)

  // A sibling serving the model must NOT make account A look capable: selection
  // routes on this answer, so corroborating here sent requests to an account
  // that cannot serve them. Pool-wide healing happens before the error instead.
  assert.equal(pool.isModelSupported(pool.getAccount(a!.id)!, model), false)
  assert.equal(pool.isModelSupported(pool.getAccount(b!.id)!, model), true)
  // A learned refusal outranks the quota snapshot taken before it.
  pool.markModelUnsupported(b!.id, model)
  assert.equal(pool.isModelSupported(pool.getAccount(b!.id)!, model), false)
})

test('a learned refusal heals once a later quota refresh lists the model again', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { AccountPoolManager } = await import('../../src/host/pool.ts')

  // agy also says "not recognized" when it could not load its model list (a TLS
  // timeout), which used to shut the model out of the pool until a restart.
  const pool = new AccountPoolManager(mkdtempSync(join(tmpdir(), 'agy-refusal-heal-')))
  const account = pool.getAccounts()[0]!
  const model = 'gemini-4-neon-high'
  const listing = (updatedAt: number, modelId: string) =>
    ({ google: { updatedAt, remainingFraction: 1, models: [{ modelId, remainingFraction: 1 }] } }) as never
  pool.updateAccountQuotas(account.id, listing(Date.now() - 1000, model))
  pool.markModelUnsupported(account.id, model)
  assert.equal(pool.selectAccount('google', model), null)

  pool.updateAccountQuotas(account.id, listing(Date.now() + 1000, model))
  assert.equal(pool.selectAccount('google', model)?.id, account.id)
})

test('a refusal the account quota contradicts expires without a refresh; one it does not stays final', async () => {
  const { accountCanServeModel, LISTED_REFUSAL_RETRY_MS } = await import('../../src/host/model-support.ts')
  const model = 'gemini-4-neon-high'
  const account = (modelId: string) =>
    ({ id: 'acc_a', quotas: { google: { updatedAt: 1, models: [{ modelId, remainingFraction: 1 }] } } }) as never
  const ctx = (learnedAt: number) =>
    ({ unsupportedModels: new Map([['acc_a', new Map([['gemini-4-neon', learnedAt]])]]), catalogFor: () => undefined, pool: null })
  const stale = Date.now() - LISTED_REFUSAL_RETRY_MS - 1000

  assert.equal(accountCanServeModel(account(model), model, ctx(Date.now())), false)
  assert.equal(accountCanServeModel(account(model), model, ctx(stale)), true)
  assert.equal(accountCanServeModel(account('gemini-4-hydrogen-high'), model, ctx(stale)), false)
})

test('issue #125: an all-model-mismatch failure heals with ONE quota refresh, then retries', async () => {
  const { selectSessionAccount } = await import('../../src/provider/account-selection.ts')
  const { defaultConfig } = await import('../../src/common/types.ts')

  const account = { id: 'acc_a', alias: 'a', dir: '', createdAt: 1, enabled: true, cooldowns: {}, quotas: {} }
  let refreshed = 0
  let selectCalls = 0
  const pool = {
    getAccounts: () => [account],
    // Before the heal every account is denied purely because of the model list;
    // the refresh repairs the truncated snapshot, so the retry succeeds.
    explainIneligibility: () => (refreshed === 0 ? 'model-unsupported' : null),
    selectAccount: () => {
      selectCalls += 1
      return refreshed === 0 ? null : account
    },
    getPoolData: () => ({ lastActiveAccountId: undefined }),
    setActiveAccount: () => {},
    getEarliestResetCountdown: () => null,
  } as never
  const res = await selectSessionAccount({
    deps: {
      pool,
      store: { all: () => ({}), delete: () => {} } as never,
      refreshQuota: async () => { refreshed += 1 },
    },
    cfg: { ...defaultConfig(), autoFallbackModel: false },
    model: 'gemini-4-hydrogen',
    isAux: false,
    sessionKey: 's1',
  })
  assert.equal(refreshed, 1, 'exactly one self-heal refresh')
  assert.equal(res.account?.id, 'acc_a', 'the retry picks the healed account')
  assert.equal(selectCalls >= 2, true, 'selection ran again after the refresh')
})

test('issue #125: the self-heal does not run for a quota/auth blocker', async () => {
  const { selectSessionAccount } = await import('../../src/provider/account-selection.ts')
  const { defaultConfig } = await import('../../src/common/types.ts')

  const account = { id: 'acc_q', alias: 'q', dir: '', createdAt: 1, enabled: true, cooldowns: {}, quotas: {} }
  let refreshed = 0
  const pool = {
    getAccounts: () => [account],
    explainIneligibility: () => 'quota',
    selectAccount: () => null,
    getPoolData: () => ({ lastActiveAccountId: undefined }),
    setActiveAccount: () => {},
    getEarliestResetCountdown: () => 30_000,
  } as never
  await assert.rejects(() => selectSessionAccount({
    deps: { pool, store: { all: () => ({}), delete: () => {} } as never, refreshQuota: async () => { refreshed += 1 } },
    cfg: { ...defaultConfig(), autoFallbackModel: false },
    model: 'gemini-4-hydrogen',
    isAux: false,
    sessionKey: 's1',
  }))
  assert.equal(refreshed, 0, 'quota exhaustion is not a stale-snapshot problem')
})
