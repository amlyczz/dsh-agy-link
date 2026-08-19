// Integration guard for the v0.3.2 registration race: the plugin must
// register agy_tool with the tools service EVEN WHEN the service only
// appears after the plugin loaded. The 0.3.1 one-shot ctx.get('tools')
// lost that race and every mirrored call died with "unknown tool agy_tool".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

// Hermetic sandbox: own DSH_HOME + a stub agy binary so the guard runs on
// CI machines without agy installed.
const workDir = mkdtempSync(join(tmpdir(), 'agy-inject-'))
process.env.DSH_HOME = workDir
const stubBin = join(workDir, 'agy')
writeFileSync(stubBin, '#!/bin/sh\necho "agy version 1.1.15"\n')
chmodSync(stubBin, 0o755)
process.env.DSH_AGY_BIN = stubBin

type FakeCtx = Context & {
  provide: (key: string, value: unknown) => void
  fiber: { dispose: () => Promise<void> }
}

test('agy_tool registers when the tools service appears after plugin load', async () => {
  const ctx = new Context() as FakeCtx
  const registered: string[] = []
  const disposed: string[] = []
  const track = (name: string) => (): void => {
    disposed.push(name)
  }

  // Host services the plugin touches eagerly — present BEFORE load.
  ctx.plugin({
    name: 'fake-host-services',
    apply(c: Context) {
      const fc = c as FakeCtx
      fc.provide('llm', { registerAdapter() { return () => undefined } })
      fc.provide('commands', {
        register(def: { name: string }) {
          registered.push('cmd:' + def.name)
          return track('cmd:' + def.name)
        },
      })
    },
  })
  await new Promise((r) => setTimeout(r, 20))

  // Plugin loads — the tools service does NOT exist yet (the 0.3.1 race).
  apply(ctx, {})
  assert.ok(!registered.includes('agy_tool'), 'nothing registered before the service exists')
  assert.ok(!registered.includes('agy_ask'), 'agy_ask stays off by default')

  // The tools service starts LATER.
  ctx.plugin({
    name: 'fake-tools-service',
    apply(c: Context) {
      ;(c as FakeCtx).provide('tools', {
        register(def: { name: string }) {
          registered.push(def.name)
          return track(def.name)
        },
      })
    },
  })
  await new Promise((r) => setTimeout(r, 50))

  // The reactive inject fiber picked the service up and registered the mirror.
  assert.ok(registered.includes('agy_tool'), 'agy_tool registered after the service appears: ' + JSON.stringify(registered))
  assert.ok(!registered.includes('agy_ask'), 'agy_ask stays off while askTool=false')

  // Teardown disposes the registration.
  await ctx.fiber.dispose()
  assert.ok(disposed.includes('agy_tool'), 'agy_tool disposed on teardown')
  rmSync(workDir, { recursive: true, force: true })
})
