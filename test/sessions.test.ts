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

test('a concurrent writer does not lose the other host bindings (dirty-key merge)', () => {
  const mergeFile = join(dir, 'merge.json')
  rmSync(mergeFile, { force: true })
  const web = new SessionStore(mergeFile)
  const headless = new SessionStore(mergeFile)
  // Both hosts loaded an empty file, then each writes its own session.
  web.set('session-a', { conversationId: 'ca', lastMessageCount: 1, updatedAt: 1 })
  headless.set('session-b', { conversationId: 'cb', lastMessageCount: 2, updatedAt: 2 })
  const onDisk = JSON.parse(readFileSync(mergeFile, 'utf8')) as Record<string, unknown>
  assert.ok('session-a' in onDisk, 'the first host binding must survive the second host write')
  assert.ok('session-b' in onDisk)
  assert.equal(new SessionStore(mergeFile).get('session-a')?.conversationId, 'ca')
  // Deletions still win over a concurrent re-add of the SAME key.
  headless.delete('session-a')
  assert.equal(new SessionStore(mergeFile).get('session-a'), undefined)
  assert.equal(new SessionStore(mergeFile).get('session-b')?.conversationId, 'cb')
})

test('cleanupStaleAccounts does not mis-purge bindings whose session key contains ":"', () => {
  // DSH session ids from other plugins can be composite and contain ':'.
  // Splitting on the FIRST ':' reads "sess:acc_valid" as the account id, which
  // is never in the valid set, so a LIVE binding was wrongly deleted.
  const f = join(dir, 'cleanup-colon.json')
  rmSync(f, { force: true })
  const store = new SessionStore(f)
  store.set('ns:sess:acc_valid', { conversationId: 'c1', lastMessageCount: 1, updatedAt: 100 })
  store.set('ns:sess:acc_gone', { conversationId: 'c2', lastMessageCount: 2, updatedAt: 200 })
  store.cleanupStaleAccounts(new Set(['acc_valid']))
  assert.ok(store.get('ns:sess:acc_valid'), 'valid binding survives despite colons in the session key')
  assert.equal(store.get('ns:sess:acc_gone'), undefined, 'deleted account binding is still purged')
})

test('cleanupStaleAccounts removes deleted account IDs from sessions.json', () => {
  const cleanupFile = join(dir, 'cleanup.json')
  rmSync(cleanupFile, { force: true })
  const store = new SessionStore(cleanupFile)
  store.set('sess1:acc_valid', { conversationId: 'c1', lastMessageCount: 1, updatedAt: 100 })
  store.set('sess1:acc_deleted', { conversationId: 'c2', lastMessageCount: 2, updatedAt: 200 })
  store.set('sess2:acc_deleted', { conversationId: 'c3', lastMessageCount: 3, updatedAt: 300 })
  store.set('sess2:acc_valid', { conversationId: 'c4', lastMessageCount: 4, updatedAt: 400 })

  store.cleanupStaleAccounts(new Set(['acc_valid']))

  assert.ok(store.get('sess1:acc_valid'))
  assert.ok(store.get('sess2:acc_valid'))
  assert.equal(store.get('sess1:acc_deleted'), undefined)
  assert.equal(store.get('sess2:acc_deleted'), undefined)

  // Verify on disk persistence
  const reloaded = new SessionStore(cleanupFile)
  assert.ok(reloaded.get('sess1:acc_valid'))
  assert.equal(reloaded.get('sess1:acc_deleted'), undefined)
})
