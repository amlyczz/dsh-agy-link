import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { AuthHelper } from '../src/host/auth.ts'
import { PoolAuthFlow } from '../src/host/pool-auth.ts'

test('disposing during MCP startup closes the listener without publishing workspace config', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-mcp-dispose-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.mock.method(AuthHelper.prototype, 'dispose', () => undefined)
  t.mock.method(PoolAuthFlow.prototype, 'cancel', async () => undefined)
  const ctx = new Context()
  const activeHandles = () => (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
  const before = new Set(activeHandles())
  try {
    ctx.plugin({ name: 'mcp-disposal-test-host', apply(c: Context) {
      c.provide('llm', { registerAdapter() { return () => undefined } })
      c.provide('commands', { register() { return () => undefined } })
    } })
    await new Promise(resolve => setTimeout(resolve, 20))
    apply(ctx, { enabled: true, mcpBridge: true, workspaceRoot: dir, agyBin: '/nonexistent/agy-test' })
    await ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(existsSync(join(dir, '.mcp.json')), false, 'disposed scope must not publish a bearer capability')
    assert.equal(activeHandles().some(handle => !before.has(handle) && handle instanceof Server && handle.listening), false)
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
