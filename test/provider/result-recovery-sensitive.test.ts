// A mirror result is written into DSH's session log, and that history can be
// replayed to whatever model the session later switches to. agy reading a
// secret is agy's business; copying the file into a tool result would move the
// secret into another store — and, on a model switch, to another vendor. So
// the recovery paths that fill an empty result (agy's conversation DB, the file
// agy read) must refuse credential files. The card then shows what it showed
// before recovery existed: nothing.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isSensitiveReadPath,
  recoverFromFile,
  recoverStepOutput,
} from '../../src/provider/mirror/result-recovery.ts'

test('credential-ish paths are recognised; ordinary files are not', () => {
  for (const p of [
    '/repo/.env', '/repo/.env.local', '/repo/.envrc', '/repo/build/.env.production',
    '/home/u/.ssh/id_ed25519', '/home/u/.ssh/config',
    '/etc/ssl/private/server.key', '/certs/server.pem', '/certs/bundle.p12', '/certs/keystore.pfx',
    '/home/u/.aws/credentials', '/home/u/.netrc', '/home/u/.npmrc', '/home/u/.pgpass',
    '/app/config/credentials.json', '/app/config/secrets.yaml',
  ]) {
    assert.equal(isSensitiveReadPath({ Path: p }), true, p)
  }
  for (const p of [
    '/repo/src/app.ts', '/repo/notes.txt', '/repo/docs/token-guide.md', '/repo/README.credentials.md',
    '/repo/.github/workflows/ci.yml', '/repo/src/credentials.ts',
  ]) {
    assert.equal(isSensitiveReadPath({ path: p }), false, p)
  }
  // Not a read of a file at all, or no usable path: nothing to judge.
  assert.equal(isSensitiveReadPath(undefined), false)
  assert.equal(isSensitiveReadPath({ Path: '   ' }), false)
})

test('a credential file is never read back to fill a card; an ordinary file still is', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-sensitive-read-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, '.env'), 'STRIPE_SECRET=sk_live_should_not_appear\n')
  writeFileSync(join(root, 'notes.txt'), 'ordinary notes\n')
  const body = 'PRIVATE KEY----- should_not_appear\n'
  mkdirSync(join(root, '.ssh'))
  writeFileSync(join(root, '.ssh', 'id_ed25519'), body)

  assert.equal(await recoverFromFile('read_file', { Path: join(root, '.env') }), null)
  assert.equal(await recoverFromFile('read_file', { path: join(root, '.ssh', 'id_ed25519') }), null)
  assert.equal(await recoverFromFile('read_file', { AbsolutePath: join(root, 'notes.txt') }), 'ordinary notes')
})

test('recoverStepOutput stops before the conversation DB when the read names a credential file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-sensitive-step-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, '.env'), 'TOKEN=should_not_appear\n')
  // A recording that would satisfy the DB lookup; accountHome points at an
  // empty dir so nothing real is consulted if the guard were missing.
  const rec = {
    conversationId: 'conv-1',
    accountHome: root,
    eventAt: () => ({ kind: 'step', stepKind: 'tool', stepKey: '1' }),
  } as unknown as Parameters<typeof recoverStepOutput>[0]

  const out = await recoverStepOutput(rec, 0, 'read_file', { Path: join(root, '.env') }, '')
  assert.equal(out, '', 'an empty result stays empty rather than being filled from a credential file')
})
