// Regression tests for the effort-unsupported persistence store.
//
// Extracted from the composition factory (issue #115): one cohesive module owns
// the file, the filter rules, the live-reload invariant and the picker event.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEffortUnsupportedStore } from '../../src/host/effort-unsupported-store.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agy-effort-store-'))
  const events: string[] = []
  const lines: string[] = []
  const store = createEffortUnsupportedStore({
    stateDir: () => join(root, 'agy-link'),
    notifyPicker: () => events.push('llm/adapters-updated'),
    log: (m) => lines.push(m),
  })
  return { root, events, lines, store, file: join(root, 'agy-link', 'effort-unsupported.json') }
}

test('read filters non-strings and survives a missing or invalid file', () => {
  const f = fixture()
  try {
    assert.deepEqual(f.store.read(), [])
    mkdirSync(join(f.root, 'agy-link'), { recursive: true })
    writeFileSync(f.file, JSON.stringify(['a', '', 2, ' b ', 'a', null]))
    assert.deepEqual(f.store.read(), ['a', ' b ', 'a'], 'duplicates are preserved, junk is dropped')
    writeFileSync(f.file, 'not json')
    assert.deepEqual(f.store.read(), [])
    writeFileSync(f.file, JSON.stringify({ nope: true }))
    assert.deepEqual(f.store.read(), [])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('read observes external edits without a restart (issue #115)', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'agy-link'), { recursive: true })
    writeFileSync(f.file, JSON.stringify(['gemini-4-hydrogen']))
    assert.deepEqual(f.store.read(), ['gemini-4-hydrogen'])
    writeFileSync(f.file, JSON.stringify([]))
    assert.deepEqual(f.store.read(), [], 'an operator clearing a false refusal must take effect immediately')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('remember appends, dedupes case/space-insensitively and notifies once', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'agy-link'), { recursive: true })
    writeFileSync(f.file, JSON.stringify(['a']))
    f.store.remember('claude-sonnet-4-6')
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), ['a', 'claude-sonnet-4-6'])
    assert.deepEqual(f.events, ['llm/adapters-updated'])
    f.store.remember('  CLAUDE-SONNET-4-6 ')
    assert.deepEqual(f.events, ['llm/adapters-updated'], 'no second write or event')
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), ['a', 'claude-sonnet-4-6'])
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('remember logs instead of throwing when persistence fails', () => {
  const f = fixture()
  try {
    // A plain file where the state directory should be makes mkdirSync throw.
    writeFileSync(join(f.root, 'agy-link'), 'blocker')
    assert.doesNotThrow(() => f.store.remember('m'))
    assert.ok(f.lines.some((l) => l.includes('failed to persist the effort-unsupported')))
    assert.deepEqual(f.events, ['llm/adapters-updated'], 'the picker is still told to re-read')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
