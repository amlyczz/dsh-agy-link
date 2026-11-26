// Command opt-outs: `slashCommandsEnabled` drops the top-level `/a*` shortcut
// family and `tslEnabled` drops `/tsl`; `/agy` itself is always registered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../src/index.ts'
import { DIRECT_AGY_SLASH_COMMANDS } from '../../src/common/agy-slash-list.ts'
import { sandboxEnv } from '../helpers/sandbox-env.ts'

const workDir = mkdtempSync(join(tmpdir(), 'agy-slash-opt-'))
sandboxEnv(workDir)
const stubBin = join(workDir, 'agy')
writeFileSync(stubBin, '#!/bin/sh\necho "agy version 1.1.15"\n')
chmodSync(stubBin, 0o755)
process.env.DSH_AGY_BIN = stubBin

type FakeCtx = Context & {
  provide: (key: string, value: unknown) => void
  fiber: { dispose: () => Promise<void> }
}

async function bootAndListCommands(): Promise<string[]> {
  const ctx = new Context() as FakeCtx
  const commands: string[] = []
  ctx.plugin({
    name: 'fake-host-services',
    apply(c: Context) {
      const fc = c as FakeCtx
      fc.provide('llm', { registerAdapter() { return () => undefined } })
      fc.provide('commands', {
        register(def: { name: string }) {
          commands.push(def.name)
          return () => undefined
        },
      })
    },
  })
  await new Promise((r) => setTimeout(r, 20))
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 20))
  await ctx.fiber.dispose()
  return commands
}

test('the /a* shortcut family is registered by default', async () => {
  delete process.env.DSH_AGY_SLASH_COMMANDS_ENABLED
  const commands = await bootAndListCommands()
  assert.ok(commands.includes('agy'), '/agy is registered: ' + JSON.stringify(commands))
  assert.ok(commands.includes('tsl'), '/tsl registered by default')
  for (const name of DIRECT_AGY_SLASH_COMMANDS) assert.ok(commands.includes(name), `/${name} registered by default`)
  for (const name of ['agoal', 'acompact', 'afork', 'alearn']) assert.ok(commands.includes(name), `/${name} registered by default`)
})

test('slashCommandsEnabled=false skips the /a* family but keeps /agy', async () => {
  process.env.DSH_AGY_SLASH_COMMANDS_ENABLED = 'false'
  try {
    const commands = await bootAndListCommands()
    assert.ok(commands.includes('agy'), '/agy stays registered: ' + JSON.stringify(commands))
    const leaked = commands.filter((n) => (DIRECT_AGY_SLASH_COMMANDS as readonly string[]).includes(n) || ['agoal', 'acompact', 'afork', 'alearn'].includes(n))
    assert.deepEqual(leaked, [], 'no /a* shortcut registered with the switch off')
  } finally {
    delete process.env.DSH_AGY_SLASH_COMMANDS_ENABLED
  }
})

test('tslEnabled=false skips /tsl but keeps /agy and the /a* family', async () => {
  process.env.DSH_AGY_TSL_ENABLED = 'false'
  try {
    const commands = await bootAndListCommands()
    assert.ok(commands.includes('agy'), '/agy stays registered')
    assert.ok(!commands.includes('tsl'), '/tsl not registered with the switch off: ' + JSON.stringify(commands))
    assert.ok(commands.includes('aplan'), 'the /a* family is independent of tslEnabled')
  } finally {
    delete process.env.DSH_AGY_TSL_ENABLED
    rmSync(workDir, { recursive: true, force: true })
  }
})
