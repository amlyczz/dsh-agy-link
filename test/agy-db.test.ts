import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFullToolArgs, clearAgyDbCache, __setAgyDbDirForTest } from '../src/host/agy-db.ts'
import { join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnSync } from 'node:child_process'

const execFileAsync = promisify(execFile)

function encodeVarint(n: number): Buffer {
  const bytes: number[] = []
  let val = n
  while (val > 127) {
    bytes.push((val & 0x7f) | 0x80)
    val >>>= 7
  }
  bytes.push(val & 0x7f)
  return Buffer.from(bytes)
}

/** Realistic tool step_payload: outer field 5 wraps inner {f1 callId, f2 name, f3 argsJSON}. */
function buildStepPayload(toolName: string, args: Record<string, unknown>): Buffer {
  const argsBuf = Buffer.from(JSON.stringify(args), 'utf-8')
  const nameBuf = Buffer.from(toolName, 'utf-8')
  const callIdBuf = Buffer.from('call_test123', 'utf-8')
  const inner = Buffer.concat([
    Buffer.from([0x0a]), encodeVarint(callIdBuf.length), callIdBuf,
    Buffer.from([0x12]), encodeVarint(nameBuf.length), nameBuf,
    Buffer.from([0x1a]), encodeVarint(argsBuf.length), argsBuf,
  ])
  // header (varint fields) + outer field 5 wrapping inner
  const header = Buffer.from([0x08, 0x01, 0x20, 0x02])
  return Buffer.concat([header, Buffer.from([0x2a]), encodeVarint(inner.length), inner])
}

const sqliteOk = spawnSync('which', ['sqlite3'], { encoding: 'utf-8' }).status === 0

let tempDir: string | null = null

after(async () => {
  if (tempDir) {
    try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('readFullToolArgs: parses realistic nested protobuf step_payload', async (t) => {
  if (!sqliteOk) return t.skip('sqlite3 CLI not available')
  tempDir = await mkdtemp(join(tmpdir(), 'agy-db-test-'))
  const dbPath = join(tempDir, 'conv123.db')

  const payload = buildStepPayload('write_to_file', {
    CodeContent: 'hello\nworld',
    Description: 'Create new.txt',
    Overwrite: true,
    TargetFile: '/tmp/x/new.txt',
  })

  // Create DB via sqlite3 CLI (hex literal avoids quoting issues)
  const hex = payload.toString('hex')
  await execFileAsync('sqlite3', [
    dbPath,
    `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);`,
    `INSERT INTO steps (idx,step_type,status,step_payload) VALUES (23,132,3,X'${hex}');`,
  ])

  __setAgyDbDirForTest(tempDir)
  clearAgyDbCache()

  const result = await readFullToolArgs('conv123', 23)
  assert.ok(result !== null, 'should resolve full args')
  assert.equal(result.name, 'write_to_file')
  assert.equal((result as { args: { CodeContent?: string } }).args.CodeContent, 'hello\nworld')
  assert.equal((result as { args: { TargetFile?: string } }).args.TargetFile, '/tmp/x/new.txt')
  assert.equal((result as { args: { Overwrite?: boolean } }).args.Overwrite, true)

  // Second call hits the cache
  const cached = await readFullToolArgs('conv123', 23)
  assert.deepEqual(cached, result)
})

test('readFullToolArgs: returns null for missing conversation', async () => {
  __setAgyDbDirForTest(tempDir ?? 'no-such-dir')
  clearAgyDbCache()
  const result = await readFullToolArgs('10000000-0000-4000-8000-000000000000', 5)
  assert.equal(result, null)
})

test('readFullToolArgs: empty conversation id returns null', async () => {
  assert.equal(await readFullToolArgs('', 1), null)
})