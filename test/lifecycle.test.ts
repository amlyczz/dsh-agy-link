import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

test('hiding a model announces itself to the picker via llm/adapters-updated', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-picker-notify-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = new Context()
  const emitted: string[] = []
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = []
  try {
    ctx.plugin({
      name: 'picker-notify-test-host',
      apply(c: Context) {
        c.provide('llm', { registerAdapter() { return () => undefined } })
        c.provide('commands', { register() { return () => undefined } })
        c.provide('webServer', { register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) { routes.push(route) } })
      },
    })
    const origEmit = ctx.emit.bind(ctx) as (...args: unknown[]) => void
    ;(ctx as unknown as { emit: (...args: unknown[]) => void }).emit = (...args: unknown[]) => {
      if (typeof args[0] === 'string') emitted.push(args[0])
      origEmit(...args)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    apply(ctx, { enabled: false, mcpBridge: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const configRoute = routes.find((r) => r.path === '/plugins/agy-link/config')
    assert.ok(configRoute, 'config route must be registered')
    const post = (body: Record<string, unknown>): Promise<number> =>
      new Promise((resolve) => {
        let status = 0
        configRoute.handler(
          {
            method: 'POST',
            on(e: string, cb: (c: Buffer) => void) {
              if (e === 'data') cb(Buffer.from(JSON.stringify(body)))
              if (e === 'end') cb(Buffer.alloc(0))
            },
          },
          { writeHead(s: number) { status = s }, end() { resolve(status) } },
        )
      })
    assert.equal(await post({ key: 'hiddenModels', value: ['gemini-3.7-flash'] }), 200)
    assert.ok(emitted.includes('llm/adapters-updated'), 'hiddenModels write must emit llm/adapters-updated so the webview picker re-reads its catalog')
    const before = emitted.length
    assert.equal(await post({ key: 'defaultEffort', value: 'high' }), 200)
    assert.equal(emitted.length, before, 'unrelated config keys must not emit the picker event')
    // The write landed in the runtime-overrides file under DSH_HOME.
    const overrides = JSON.parse(readFileSync(join(dir, 'agy-link', 'runtime-overrides.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(overrides.hiddenModels, ['gemini-3.7-flash'])
  } finally {
    await ctx.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
