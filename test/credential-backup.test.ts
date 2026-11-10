import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readAccountCredential, saveCredentialBackup, withCredentialFileLock } from '../src/host/credential-backup.ts'

const token = (refresh: string, access = 'access') =>
  JSON.stringify({ token: { refresh_token: refresh, access_token: access } })

test('backs up, updates and restores an isolated credential without sharing its inode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-backup-'))
  const file = join(dir, 'token')
  try {
    writeFileSync(file, token('grant', 'one'))
    assert.equal(readAccountCredential(file), token('grant', 'one'))
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant', 'one'))
    writeFileSync(file, token('grant', 'two'))
    readAccountCredential(file)
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant', 'two'))
    unlinkSync(file)
    assert.equal(readAccountCredential(file), token('grant', 'two'))
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
    assert.equal(readAccountCredential(file), 'broken')
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('grant'))
    unlinkSync(file)
    writeFileSync(file + '.bak', '{"token":{"access_token":"only-access"}}')
    assert.equal(readAccountCredential(file), null)
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a different grant cannot silently replace an existing backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-backup-grant-'))
  const file = join(dir, 'token')
  try {
    writeFileSync(file, token('old'))
    readAccountCredential(file)
    writeFileSync(file, token('new'))
    readAccountCredential(file)
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('old'))
    unlinkSync(file)
    assert.equal(readAccountCredential(file), null)
    assert.equal(existsSync(file), false)
    assert.equal(withCredentialFileLock(file, () => saveCredentialBackup(file, token('new'))), true)
    assert.equal(readFileSync(file + '.bak', 'utf8'), token('new'))
    assert.equal(readAccountCredential(file), token('new'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a busy credential lock does not restore while another writer is active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-backup-lock-'))
  const file = join(dir, 'token')
  try {
    writeFileSync(file + '.bak', token('old'))
    withCredentialFileLock(file, () => {
      assert.equal(readAccountCredential(file), null)
      assert.equal(existsSync(file), false)
    })
    assert.equal(readAccountCredential(file), token('old'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
