import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { AuthHelper } from '../src/host/auth.ts'
import { PoolAuthFlow } from '../src/host/pool-auth.ts'

test('auth cleanup is deferred until the plugin scope is disposed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lifecycle-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const disposeAuth = t.mock.method(AuthHelper.prototype, 'dispose', () => undefined)
  const cancelPool = t.mock.method(PoolAuthFlow.prototype, 'cancel', async () => undefined)
  const ctx = new Context()
  try {
    ctx.plugin({
      name: 'lifecycle-test-host',
      apply(c: Context) {
        c.provide('llm', { registerAdapter() { return () => undefined } })
        c.provide('commands', { register() { return () => undefined } })
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    apply(ctx, { enabled: false, mcpBridge: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(disposeAuth.mock.callCount(), 0, 'must not dispose auth at initialization')
    assert.equal(cancelPool.mock.callCount(), 0, 'must not cancel pool authentication at initialization')
    await ctx.fiber.dispose()
    assert.equal(disposeAuth.mock.callCount(), 1)
    assert.equal(cancelPool.mock.callCount(), 1)
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
