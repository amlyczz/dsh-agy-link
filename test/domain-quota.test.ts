// Focused unit coverage for domain helpers that had no direct test before the
// Phase 5a move. The bucket/identity helpers keep their existing coverage in
// test/quota.test.ts and test/pool.test.ts (they are re-exported unchanged);
// only the atomic JSON writer lacked a direct, isolated test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic } from '../src/domain/accounts/paths.ts'

test('writeJsonAtomic publishes a complete JSON snapshot with no temp residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-write-json-atomic-'))
  try {
    const file = join(dir, 'pool.json')
    writeJsonAtomic(file, '{"accounts":[]}')
    assert.equal(readFileSync(file, 'utf8'), '{"accounts":[]}')
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file may survive')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonAtomic refuses to publish an unparsable snapshot over a good file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-write-json-atomic-'))
  try {
    const file = join(dir, 'pool.json')
    writeFileSync(file, '{"keep":true}')
    assert.throws(() => writeJsonAtomic(file, 'not-json'))
    // The JSON round-trip guard fires before the rename, so the real file is intact.
    assert.equal(readFileSync(file, 'utf8'), '{"keep":true}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
