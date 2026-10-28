import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

// Exercise the actual scope owner, not a manual bridge.close()/restore call.
test('disposing a ready plugin clears background timers, closes MCP and restores config', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ready-disposal-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  // The production default is the agy global registry; redirect it into the
  // temp dir so the test never mutates the developer's ~/.gemini.
  const file = join(dir, 'gemini', 'mcp_config.json')
  const original = '{"mcpServers":{},"sentinel":"preserve exact bytes"}\n'
  mkdirSync(join(dir, 'gemini'), { recursive: true })
  writeFileSync(file, original)
  const ctx = new Context()
  const listeners = t.mock.method(Server.prototype, 'listen')
  const intervals = t.mock.method(globalThis, 'setInterval')
  const timeouts = t.mock.method(globalThis, 'setTimeout')
  const clearIntervals = t.mock.method(globalThis, 'clearInterval')
  const clearTimeouts = t.mock.method(globalThis, 'clearTimeout')
  try {
    ctx.plugin({ name: 'ready-disposal-host', apply(c: Context) {
      c.provide('llm', { registerAdapter() { return () => undefined } })
      c.provide('commands', { register() { return () => undefined } })
    } })
    const servicesDeadline = Date.now() + 2000
    while (!ctx.get('commands')) {
      assert.ok(Date.now() < servicesDeadline, 'host services did not register')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    apply(ctx, { enabled: true, mcpBridge: true, workspaceRoot: dir, agyBin: '/nonexistent/agy-test', mcpConfigPath: file })
    const deadline = Date.now() + 2000
    while (readFileSync(file, 'utf8') === original) {
      assert.ok(Date.now() < deadline, 'bridge did not publish configuration')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const servers = listeners.mock.calls.map(call => call.result).filter(server => server?.listening) as Server[]
    assert.equal(servers.length, 1)
    const sweeps = intervals.mock.calls.filter(c => Number(c.arguments[1]) >= 60000)
    // Boot timers: the 4s agy version probe and the 5s quota refresh. The
    // warmup scheduler is interval-only (no boot pass, so an upgrade never
    // probes on stale pool.json rows).
    const boots = timeouts.mock.calls.filter(c => [4000, 5000].includes(Number(c.arguments[1])))
    assert.equal(sweeps.length, 3, 'media TTL, quota refresh and warmup schedulers are all >= 60s')
    assert.equal(boots.length, 2)
    for (const call of [...sweeps, ...boots]) assert.equal((call.result as NodeJS.Timeout).hasRef(), false)
    await ctx.fiber.dispose()
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.ok(servers.every(server => !server.listening))
    for (const call of sweeps) assert.ok(clearIntervals.mock.calls.some(c => c.arguments[0] === call.result))
    for (const call of boots) assert.ok(clearTimeouts.mock.calls.some(c => c.arguments[0] === call.result))
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
