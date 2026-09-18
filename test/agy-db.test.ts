import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFullToolArgs, readStepThoughts, extractStepThoughts, clearAgyDbCache, isSafeConversationId, findConversationDb, conversationsDirCandidates, __setAgyDbDirForTest } from '../src/host/agy-db.ts'

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

/** Realistic agent_response step_payload: outer field 20 wraps inner {f1 text, f3 thoughts, f8 text}. */
function buildThoughtStepPayload(thoughts: string, text = 'Here is the answer'): Buffer {
  const thoughtBuf = Buffer.from(thoughts, 'utf-8')
  const textBuf = Buffer.from(text, 'utf-8')
  const inner = Buffer.concat([
    Buffer.from([0x0a]), encodeVarint(textBuf.length), textBuf,
    Buffer.from([0x1a]), encodeVarint(thoughtBuf.length), thoughtBuf,
    Buffer.from([0x42]), encodeVarint(textBuf.length), textBuf,
  ])
  const header = Buffer.from([0x08, 0x0f, 0x20, 0x03])
  return Buffer.concat([
    header,
    Buffer.from([0xa2, 0x01]),
    encodeVarint(inner.length),
    inner,
  ])
}

const sqliteOk = spawnSync('which', ['sqlite3'], { encoding: 'utf-8' }).status === 0

test('rejects path-traversal conversation ids before joining the DB path', async () => {
  assert.equal(isSafeConversationId('conv-fresh-1'), true)
  assert.equal(isSafeConversationId('abc_123-XYZ'), true)
  assert.equal(isSafeConversationId('../../etc/passwd'), false)
  assert.equal(isSafeConversationId('..\\..\\windows'), false)
  assert.equal(isSafeConversationId('a/b'), false)
  assert.equal(isSafeConversationId(''), false)
  assert.equal(await readFullToolArgs('../../etc/passwd', 1), null)
  assert.equal(await readStepThoughts('../../etc/passwd', 1), null)
})

let tempDir: string | null = null

after(async () => {
  if (tempDir) {
    try { await rm(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('extractStepThoughts: extracts Field 20.3 from protobuf payload', () => {
  const thought = 'I need to check why the function returns null.'
  const payload = buildThoughtStepPayload(thought)
  const extracted = extractStepThoughts(payload)
  assert.equal(extracted, thought)
})

test('readFullToolArgs and readStepThoughts: parse realistic nested protobuf step_payloads', async (t) => {
  if (!sqliteOk) return t.skip('sqlite3 CLI not available')
  tempDir = await mkdtemp(join(tmpdir(), 'agy-db-test-'))
  const dbPath = join(tempDir, 'conv123.db')

  const toolPayload = buildStepPayload('write_to_file', {
    CodeContent: 'hello\nworld',
    Description: 'Create new.txt',
    Overwrite: true,
    TargetFile: '/tmp/x/new.txt',
  })

  const thoughtText = 'First I should inspect the target directory.'
  const thoughtPayload = buildThoughtStepPayload(thoughtText, 'Done creating file.')

  // Create DB via sqlite3 CLI (hex literal avoids quoting issues)
  const toolHex = toolPayload.toString('hex')
  const thoughtHex = thoughtPayload.toString('hex')
  await execFileAsync('sqlite3', [
    dbPath,
    `CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);`,
    `INSERT INTO steps (idx,step_type,status,step_payload) VALUES (23,132,3,X'${toolHex}');`,
    `INSERT INTO steps (idx,step_type,status,step_payload) VALUES (22,15,3,X'${thoughtHex}');`,
  ])

  __setAgyDbDirForTest(tempDir)
  clearAgyDbCache()

  const toolResult = await readFullToolArgs('conv123', 23)
  assert.ok(toolResult !== null, 'should resolve full args')
  assert.equal(toolResult.name, 'write_to_file')
  assert.equal((toolResult as { args: { CodeContent?: string } }).args.CodeContent, 'hello\nworld')
  assert.equal((toolResult as { args: { TargetFile?: string } }).args.TargetFile, '/tmp/x/new.txt')
  assert.equal((toolResult as { args: { Overwrite?: boolean } }).args.Overwrite, true)

  const thoughtResult = await readStepThoughts('conv123', 22)
  assert.equal(thoughtResult, thoughtText)

  // Cache hit
  assert.equal(await readStepThoughts('conv123', 22), thoughtText)
  assert.deepEqual(await readFullToolArgs('conv123', 23), toolResult)
})

test('readStepThoughts: returns null for missing conversation or empty thoughts', async () => {
  __setAgyDbDirForTest(tempDir ?? 'no-such-dir')
  clearAgyDbCache()
  assert.equal(await readStepThoughts('10000000-0000-4000-8000-000000000000', 5), null)
  assert.equal(await readStepThoughts('', 1), null)
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

test('findConversationDb searches isolated pool account homes (thinking path)', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const accHome = await mkdtemp(join(tmpdir(), 'agy-acc-home-'))
  const conv = 'conv-isolated-1'
  const dbDir = join(accHome, '.gemini', 'antigravity-cli', 'conversations')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dbDir, { recursive: true })
  await writeFile(join(dbDir, `${conv}.db`), Buffer.from([0x00]))
  t.after(async () => { await rm(accHome, { recursive: true, force: true }) })
  clearAgyDbCache()
  __setAgyDbDirForTest(join(tmpdir(), 'agy-empty-system-dir'))
  assert.equal(findConversationDb(conv, accHome), join(dbDir, `${conv}.db`))
  const cands = conversationsDirCandidates(accHome)
  assert.equal(cands[0], dbDir)
  assert.ok(cands.length >= 2)
})