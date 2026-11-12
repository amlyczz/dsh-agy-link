import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractRefreshToken, readAccountCredential, saveCredentialBackup } from '../src/host/credential-backup.ts'

const token = (refresh: string, access = 'access') =>
  JSON.stringify({ token: { refresh_token: refresh, access_token: access } })

test('backs up, preserves and restores an isolated credential when deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-backup-'))
  const file = join(dir, 'token')
  try {
    writeFileSync(file, token('grant', 'one'))
    // First read backs up the credential
    assert.equal(readAccountCredential(file), token('grant', 'one'))
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant', 'one'))

    // Ordinary read does not touch backup on token roll
    writeFileSync(file, token('grant', 'two'))
    assert.equal(readAccountCredential(file), token('grant', 'two'))
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant', 'one'))

    // Explicit saveCredentialBackup updates backup
    saveCredentialBackup(file, token('grant', 'two'))
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant', 'two'))

    // If agy removes the credential file, readAccountCredential restores it from .bak
    unlinkSync(file)
    assert.equal(readAccountCredential(file), token('grant', 'two'))
    assert.equal(existsSync(file), true)
    assert.equal(readFileSync(file, 'utf8'), token('grant', 'two'))

    // Changes to the restored file do not mutate .bak
    writeFileSync(file, 'changed')
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant', 'two'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restores valid backup over a broken/empty file and rejects malformed backup (issue #102)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-backup-invalid-'))
  const file = join(dir, 'token')
  try {
    writeFileSync(file + '.bak', token('grant'))
    writeFileSync(file, 'broken')
    // Broken file lacking refresh token is repaired from valid backup
    assert.equal(readAccountCredential(file), token('grant'))
    assert.equal(readFileSync(file, 'utf8'), token('grant'))
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant'))

    // Valid file with a different grant is NOT overwritten
    writeFileSync(file, token('grant2'))
    assert.equal(readAccountCredential(file), token('grant2'))
    assert.equal(readFileSync(file, 'utf8'), token('grant2'))

    unlinkSync(file)
    // Backup without a refresh token is not restored
    writeFileSync(file + '.bak', '{"token":{"access_token":"only-access"}}')
    assert.equal(readAccountCredential(file), null)
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractRefreshToken handles raw tokens, full json, and quoted strings', () => {
  assert.equal(extractRefreshToken('1//04abcdef'), '1//04abcdef')
  assert.equal(extractRefreshToken('  "1//04abcdef"  '), '1//04abcdef')
  assert.equal(
    extractRefreshToken(JSON.stringify({ token: { refresh_token: '1//nested-tok' } })),
    '1//nested-tok',
  )
  assert.equal(
    extractRefreshToken(JSON.stringify({ refresh_token: '1//flat-tok' })),
    '1//flat-tok',
  )
  assert.equal(
    extractRefreshToken('{"token":{"refreshToken":"1//camel-tok"}}'),
    '1//camel-tok',
  )
  assert.equal(extractRefreshToken(''), null)
  assert.equal(extractRefreshToken('   '), null)
  assert.equal(extractRefreshToken(null as any), null)
})
