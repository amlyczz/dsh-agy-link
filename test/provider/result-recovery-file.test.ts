// A file read whose stream result is empty is answered from the file agy read.
//
// `read_file` reports nothing on stdout, and the conversation DB that used to
// answer it is pruned by agy eventually. Showing the file itself keeps the card
// honest: same bytes, capped, never invented.
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { canRecoverFromFile, recoverFromFile } from '../../src/provider/mirror/result-recovery.ts'

test('a file read with no streamed result is answered from the file itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-recover-'))
  try {
    const file = join(dir, 'note.md')
    writeFileSync(file, '# title\n\nbody\n', 'utf8')
    assert.equal(canRecoverFromFile('read_file'), true)
    assert.equal(canRecoverFromFile('run_command'), false)
    assert.equal(await recoverFromFile('read_file', { Path: file }), '# title\n\nbody')
    assert.equal(await recoverFromFile('run_command', { Path: file }), null)
    assert.equal(await recoverFromFile('read_file', { Path: join(dir, 'missing.md') }), null)
    assert.equal(await recoverFromFile('read_file', {}), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
