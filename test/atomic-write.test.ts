import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { atomicTmpPath, writeFileAtomicSync } from '../src/common/atomic-write.ts'

test('atomicTmpPath: unique per call, same directory as target', () => {
  const file = '/a/b/sessions.json'
  const a = atomicTmpPath(file)
  const b = atomicTmpPath(file)
  assert.notEqual(a, b, 'temp names must differ across calls')
  assert.equal(dirname(a), dirname(file), 'temp lives beside the target')
  assert.match(a, /\.tmp$/)
})

test('writeFileAtomicSync: writes content and leaves no temp residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-atomic-'))
  try {
    const file = join(dir, 'x.json')
    writeFileAtomicSync(file, '{"a":1}')
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}')
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomicSync: a failed rename cleans up the temp file and rethrows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-atomic-'))
  try {
    const target = join(dir, 'collide.json')
    mkdirSync(target) // a rename of a file over a directory fails
    assert.throws(() => writeFileAtomicSync(target, 'x'))
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'temp must be cleaned up')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
