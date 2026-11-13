import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { restoreTokenFromMacKeychain } from '../src/host/boot-hygiene.ts'

test('restoreTokenFromMacKeychain returns null when no keychain file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boot-hygiene-test-'))
  try {
    const tokenFile = join(dir, '.gemini/antigravity-cli/antigravity-oauth-token')
    const res = restoreTokenFromMacKeychain(dir, tokenFile)
    assert.equal(res, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
