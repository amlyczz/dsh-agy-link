// A warmup that "succeeded" but never started the quota window.
//
// Seen live: every pool account carried 8-9 `dsh-tools-<port>` entries written
// before DSH_MCP_PID existed. They were never pruned, agy waited on all of them
// before sending the turn, and the probe hit `--print-timeout` with 0 tokens,
// so the weekly window kept sliding (100%, reset always 168h away). And once a
// warmup was recorded, the 6-day success cooldown hid the still-idle window.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMcpConfig } from '../../../src/host/mcp-bridge.ts'
import type { ManagedAccount } from '../../../src/common/pool-types.ts'
import { SLIDING_IDLE_RETRY_MS, planWarmupTargets } from '../../../src/features/warmup/policy.ts'

test('writeMcpConfig prunes legacy dsh-tools entries that carry no DSH_MCP_PID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-legacy-'))
  const file = join(dir, 'mcp_config.json')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        'dsh-tools-35448': { type: 'stdio', command: 'x', args: [], env: { DSH_MCP_URL: 'http://127.0.0.1:35448', DSH_MCP_TOKEN: 't' } },
        'dsh-tools-38844': { type: 'stdio', command: 'x', args: [], env: { DSH_MCP_URL: 'http://127.0.0.1:38844', DSH_MCP_TOKEN: 't' } },
        'dsh-tools-1': { type: 'stdio', command: 'x', args: [], env: { DSH_MCP_PID: String(process.pid) } },
        godot: { type: 'stdio', command: 'godot-mcp', args: [] },
      },
    }))
    writeMcpConfig(file, { bridgeScript: '/nonexistent/bridge.mjs', token: 'tk', url: 'http://127.0.0.1:4300', port: 4300, close: async () => undefined })
    const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers).sort()
    assert.deepEqual(keys, ['dsh-tools-1', 'dsh-tools-4300', 'godot'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function idleAccount(now: number): ManagedAccount {
  return {
    id: 'a', alias: 'a', email: 'a@example.com', enabled: true, dir: '', systemHome: true,
    createdAt: now, cooldowns: {},
    quotas: {
      google: {
        remainingFraction: 1, resetTime: new Date(now + 5 * 3600_000).toISOString(),
        weeklyFraction: 1, weeklyResetTime: new Date(now + 7 * 24 * 3600_000).toISOString(),
      },
    },
  } as ManagedAccount
}

test('a sliding-idle window is retried despite a recent "successful" warmup, at most every 2h', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  const key = 'a@example.com:google:weekly'
  const plan = (lastSuccessAgoMs: number, slidingIdle: boolean) => planWarmupTargets({
    account: idleAccount(now), force: false, configuredModels: ['gemini-3.8-flash'], windows: 'weekly', now,
    slidingIdleKeys: new Set(slidingIdle ? [key] : []),
    isCoolingDown: (k, ms) => k === key && lastSuccessAgoMs < ms,
  })
  // Warmed 25h ago, window still sliding: retry.
  assert.equal(plan(25 * 3600_000, true).kind, 'targets')
  // Warmed 30 min ago: do not hammer.
  assert.ok(30 * 60_000 < SLIDING_IDLE_RETRY_MS)
  assert.equal(plan(30 * 60_000, true).kind, 'skip')
  // Not proven idle: the 6-day success cooldown still applies.
  assert.equal(plan(25 * 3600_000, false).kind, 'skip')
})

test('a probe that exits 0 but spent 0 tokens is a failure, not a success', async () => {
  const { runWarmupProbe } = await import('../../../src/features/warmup/probe.ts')
  const ctx = {
    pool: { markAuthRequired: () => undefined },
    cfg: () => ({}),
    proxy: () => '',
    agyVersion: () => '1.5.12',
    log: () => undefined,
  } as unknown as Parameters<typeof runWarmupProbe>[0]
  const acc = idleAccount(Date.now())
  const line = (total: number) => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: total ? 'hi' : '', usage: { input_tokens: total, output_tokens: 0, total_tokens: total } } })
  const zero = await runWarmupProbe(ctx, { runCliProbe: async () => ({ code: 0, stdout: line(0), stderr: '', durationMs: 1 }) }, acc, 'gemini-3.8-flash')
  assert.equal(zero.ok, false)
  assert.match(zero.error ?? '', /0 tokens/)
  const real = await runWarmupProbe(ctx, { runCliProbe: async () => ({ code: 0, stdout: line(12), stderr: '', durationMs: 1 }) }, acc, 'gemini-3.8-flash')
  assert.equal(real.ok, true)
})

test('a manual click warms an idle window even inside the success cooldown, but not an active one', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  const key = 'a@example.com:google:weekly'
  const recentlyWarmed = (k: string, ms: number) => k === key && 3600_000 < ms
  const manual = (acc: ManagedAccount) => planWarmupTargets({
    account: acc, force: false, ignoreFailureBackoff: true, configuredModels: ['gemini-3.8-flash'], windows: 'weekly', now,
    isCoolingDown: recentlyWarmed,
  })
  assert.equal(manual(idleAccount(now)).kind, 'targets')
  // The scheduler (no manual flag) still respects the cooldown.
  assert.equal(planWarmupTargets({
    account: idleAccount(now), force: false, configuredModels: ['gemini-3.8-flash'], windows: 'weekly', now,
    isCoolingDown: recentlyWarmed,
  }).kind, 'skip')
  // A window already counting down is not probed even on a click.
  const active = idleAccount(now)
  active.quotas!.google!.weeklyFraction = 0.97
  assert.equal(manual(active).kind, 'skip')
})
