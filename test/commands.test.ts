import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agyCommandDefinition } from '../src/host/commands.ts'
import { defaultConfig } from '../src/common/types.ts'

const deps = {
  cfg: () => defaultConfig(),
  bin: () => null,
  version: () => '0.0.0',
  auth: () => null,
  catalog: () => ({ get: () => ({ source: 'fallback', models: [] }) }),
  store: () => ({ all: () => ({}) }),
} as never

// Issue #27: without input.hint, DSH composer drops `/agy <sub>` to plain chat.
test('agy command declares input hint so subcommands are intercepted', () => {
  const def = agyCommandDefinition(deps)
  assert.equal(def.name, 'agy')
  assert.ok(def.input, 'CommandDefinition.input must be set')
  assert.match(def.input!.hint, /status/)
  assert.match(def.input!.hint, /workspace/)
})
