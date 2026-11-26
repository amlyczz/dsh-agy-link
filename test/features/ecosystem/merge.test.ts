// mergeEcosystemSnapshots: several single-root inventories -> one panel snapshot
// (issue #219). Pure, so the de-duplication rules are pinned on their own.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EcosystemSnapshot } from '../../../src/common/ecosystem-types.ts'
import { mergeEcosystemSnapshots } from '../../../src/features/ecosystem/merge.ts'

const snap = (over: Partial<EcosystemSnapshot> = {}): EcosystemSnapshot => ({
  primaryHome: '/home',
  plugins: [],
  mcpServers: [],
  skills: [],
  rules: [],
  agents: [],
  syncedAccountCount: 0,
  lastSyncAt: null,
  ...over,
})
const skill = (name: string, path: string) => ({ name, description: '', source: 'workspace' as const, path })

test('no extras: the base snapshot is returned as-is', () => {
  const base = snap({ workspaceRoot: '/A', workspaceRoots: ['/A'], skills: [skill('a', '/A/a/SKILL.md')] })
  assert.equal(mergeEcosystemSnapshots(base, []), base)
})

test('the base keeps its identity; each name is listed once, first occurrence wins', () => {
  const base = snap({
    workspaceRoot: '/A',
    workspaceRoots: ['/A'],
    skills: [skill('a', '/A/a/SKILL.md')],
    syncedAccountCount: 3,
    lastSyncAt: 7,
  })
  const extra = snap({
    workspaceRoot: '/B',
    workspaceRoots: ['/B'],
    skills: [skill('a', '/B/a/SKILL.md'), skill('b', '/B/b/SKILL.md')],
    syncedAccountCount: 99,
    lastSyncAt: 99,
  })
  const merged = mergeEcosystemSnapshots(base, [extra])
  // Two workspaces exposing the same name are ONE item to the picker.
  assert.deepEqual(merged.skills.map((s) => s.path), ['/A/a/SKILL.md', '/B/b/SKILL.md'])
  assert.equal(merged.primaryHome, '/home')
  assert.equal(merged.syncedAccountCount, 3)
  assert.equal(merged.lastSyncAt, 7)
  assert.equal(merged.workspaceRoot, '/A')
  assert.deepEqual(merged.workspaceRoots, ['/A', '/B'])
})

test('every kind is de-duplicated by a key that matches how the panel renders it', () => {
  const base = snap({
    plugins: [{ id: 'p', name: 'p', enabled: true, source: 'global', hasMcp: false, hasHooks: false, skillCount: 0, ruleCount: 0, path: '/home/p' }],
    mcpServers: [{ name: 'srv', transport: 'stdio', target: 'node x.js', disabled: false, source: 'global' }],
    agents: [{ name: 'rev', description: '', source: 'global', path: '/home/rev.md' }],
    rules: [
      { name: 'AGENTS.md', path: '/home/AGENTS.md', bytes: 1, source: 'global' },
      { name: 'AGENTS.md', path: '/A/AGENTS.md', bytes: 2, source: 'workspace' },
    ],
  })
  // The same global inventory is rescanned for the extra root and must not double up.
  const extra = snap({ agents: [{ name: 'rev', description: '', source: 'global', path: '/home/rev.md' }], rules: [{ name: 'AGENTS.md', path: '/home/AGENTS.md', bytes: 1, source: 'global' }] })
  const merged = mergeEcosystemSnapshots(base, [extra])
  assert.equal(merged.plugins.length, 1)
  assert.equal(merged.mcpServers.length, 1)
  assert.equal(merged.agents.length, 1, 'agent React keys are name:source — a duplicate would collide')
  assert.deepEqual(merged.rules.map((r) => r.path), ['/home/AGENTS.md', '/A/AGENTS.md'])
})

test('a root that was never scanned is never reported', () => {
  const merged = mergeEcosystemSnapshots(snap(), [snap()])
  assert.equal(merged.workspaceRoot, undefined)
  assert.deepEqual(merged.workspaceRoots, [])
})
