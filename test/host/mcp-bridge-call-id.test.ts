import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('bridge tool calls keep distinct persisted IDs across process restarts', () => {
  const fixture = fileURLToPath(new URL('../fixtures/bridge-call-ids.mjs', import.meta.url))
  const ids: string[] = []
  for (let boot = 0; boot < 3; boot++) {
    const out = execFileSync(process.execPath, ['--experimental-transform-types', fixture], { encoding: 'utf8' })
    const calls: string[] = JSON.parse(out)
    assert.equal(calls.length, 2)
    for (const id of calls) assert.match(id, /^agy-mcp-.+/)
    ids.push(...calls)
  }
  assert.equal(new Set(ids).size, ids.length)
})
