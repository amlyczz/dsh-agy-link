import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/host/sessions.ts'

const dir = mkdtempSync(join(tmpdir(), 'agy-sessions-'))
const file = join(dir, 'sessions.json')

test('set/get roundtrip and persistence across instances', () => {
  const s = new SessionStore(file)
  s.set('s1', { conversationId: 'c1', lastMessageCount: 4, updatedAt: 123, model: 'gemini-3-6-flash' })
  assert.equal(s.get('s1')?.conversationId, 'c1')
  const s2 = new SessionStore(file)
  assert.equal(s2.get('s1')?.lastMessageCount, 4)
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.ok('s1' in raw)
})

test('delete removes bindings', () => {
  const s = new SessionStore(file)
  s.set('s2', { conversationId: 'c2', lastMessageCount: 1, updatedAt: 456 })
  s.delete('s2')
  assert.equal(s.get('s2'), undefined)
})

test('corrupted file recovers to empty instead of throwing', () => {
  writeFileSync(file, '{not json', 'utf8')
  const s = new SessionStore(file)
  assert.equal(Object.keys(s.all()).length, 0)
  s.set('s3', { conversationId: 'c3', lastMessageCount: 0, updatedAt: 1 })
  assert.equal(new SessionStore(file).get('s3')?.conversationId, 'c3')
})

test('all returns a readonly snapshot', () => {
  rmSync(file, { force: true })
  const s = new SessionStore(file)
  s.set('a', { conversationId: 'x', lastMessageCount: 0, updatedAt: 1 })
  assert.equal(Object.keys(s.all()).length, 1)
})
