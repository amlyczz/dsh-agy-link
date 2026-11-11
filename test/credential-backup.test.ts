import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAccountCredential, saveCredentialBackup } from '../src/host/credential-backup.ts'

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

test('does not restore over an existing file or use a malformed backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-backup-invalid-'))
  const file = join(dir, 'token')
  try {
    writeFileSync(file + '.bak', token('grant'))
    writeFileSync(file, 'broken')
    // Existing file is preserved
    assert.equal(readAccountCredential(file), 'broken')
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant'))

    unlinkSync(file)
    // Backup without a refresh token is not restored
    writeFileSync(file + '.bak', '{"token":{"access_token":"only-access"}}')
    assert.equal(readAccountCredential(file), null)
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
