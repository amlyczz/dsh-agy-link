import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFullToolArgs, readStepThoughts, extractStepThoughts, clearAgyDbCache, isSafeConversationId, findConversationDb, conversationsDirCandidates, __setAgyDbDirForTest, __setNodeSqliteQueryForTest } from '../src/host/agy-db.ts'

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

test('extractStepThoughts: returns null when Field 20.3 is empty (does not extract response text as thoughts)', () => {
  const payload = buildThoughtStepPayload('', '你好！请问有什么我可以帮你的吗？无论是关于 dsh-agy-link 的开发、测试、调试，还是其他任务，随时告诉我！')
  const extracted = extractStepThoughts(payload)
  assert.equal(extracted, null)
})

test('extractStepThoughts: extracts Field 20.3 even when response text is much longer than thoughts', () => {
  const thought = 'Quick evaluation'
  const longResponse = 'This is a much longer response text that has more characters and sentences! It contains lots of punctuation and Chinese characters: 无论是关于开发、测试还是调试。'
  const payload = buildThoughtStepPayload(thought, longResponse)
  const extracted = extractStepThoughts(payload)
  assert.equal(extracted, thought)
})

test('readFullToolArgs and readStepThoughts: parse realistic nested protobuf step_payloads', async (t) => {
  // The reader prefers node:sqlite (no external binary — the desktop-host
  // fix for issue #43) and falls back to the sqlite3 CLI. The FIXTURE is now
  // also built through node:sqlite, so the test runs on machines without the
  // CLI at all.
  let Database: new (path: string) => { prepare(sql: string): { run(...p: unknown[]): unknown }; close(): void }
  try {
    ({ DatabaseSync: Database } = await import('node:sqlite') as { DatabaseSync: new (path: string) => { prepare(sql: string): { run(...p: unknown[]): unknown }; close(): void } })
  } catch {
    return t.skip('node:sqlite unavailable')
  }
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

  // Create DB via node:sqlite (hex literal avoids quoting issues)
  const db = new Database(dbPath)
  try {
    db.prepare(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);`).run()
    db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (23,132,3,X'${toolPayload.toString('hex')}');`).run()
    db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (22,15,3,X'${thoughtPayload.toString('hex')}');`).run()
  } finally {
    db.close()
  }

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

test('issue #52: direct SQLite read handles active WAL and truncated WAL without copyFile busy loop', async (t) => {
  let Database: new (path: string) => {
    exec(sql: string): unknown
    prepare(sql: string): { run(...p: unknown[]): unknown }
    close(): void
  }
  try {
    ({ DatabaseSync: Database } = await import('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): unknown
        prepare(sql: string): { run(...p: unknown[]): unknown }
        close(): void
      }
    })
  } catch {
    return t.skip('node:sqlite unavailable')
  }

  const { mkdtemp, rm } = await import('node:fs/promises')
  const { statSync } = await import('node:fs')
  const testRoot = await mkdtemp(join(tmpdir(), 'agy-db-wal-test-'))
  t.after(async () => {
    __setNodeSqliteQueryForTest(undefined)
    await rm(testRoot, { recursive: true, force: true })
  })

  const convId = 'conv-wal-active'
  const dbPath = join(testRoot, `${convId}.db`)

  const toolPayload = buildStepPayload('write_to_file', {
    CodeContent: 'console.log("wal test")',
    TargetFile: '/tmp/test.ts',
  })
  const thoughtText = 'Inspecting WAL resilience under active truncation.'
  const thoughtPayload = buildThoughtStepPayload(thoughtText)

  // Initialize DB in WAL mode with active WAL entries
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);')
  db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (1,132,3,X'${toolPayload.toString('hex')}');`).run()
  db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (2,14,3,X'${thoughtPayload.toString('hex')}');`).run()
  // Keep connection open so WAL and SHM remain active
  db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (3,132,3,X'${toolPayload.toString('hex')}');`).run()

  __setAgyDbDirForTest(testRoot)
  clearAgyDbCache()

  // 1. Read under active WAL mode via node:sqlite
  const startActive = Date.now()
  const activeTool = await readFullToolArgs(convId, 1)
  const activeThought = await readStepThoughts(convId, 2)
  const elapsedActive = Date.now() - startActive
  assert.ok(elapsedActive < 2000, `active WAL read must not hang (took ${elapsedActive}ms)`)
  assert.equal(activeTool?.name, 'write_to_file')
  assert.equal(activeThought, thoughtText)

  // 2. Truncate WAL via SQLite checkpoint (simulates SQLite checkpoint/truncate
  // which previously triggered libuv copyFile busy loop if racing a copy)
  clearAgyDbCache()
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  assert.equal(statSync(dbPath + '-wal').size, 0, 'WAL should be truncated to 0')

  const startTruncated = Date.now()
  const truncatedTool = await readFullToolArgs(convId, 1)
  const elapsedTruncated = Date.now() - startTruncated
  assert.ok(elapsedTruncated < 2000, `truncated WAL read must complete quickly without busy loop (took ${elapsedTruncated}ms)`)
  assert.equal(truncatedTool?.name, 'write_to_file')

  // 3. Write new steps into the truncated WAL and read again
  clearAgyDbCache()
  const thought2 = 'Second thought written into fresh WAL post-truncate.'
  db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (4,14,3,X'${buildThoughtStepPayload(thought2).toString('hex')}');`).run()
  assert.ok(statSync(dbPath + '-wal').size > 0, 'WAL should have new frames')

  const postTruncateThought = await readStepThoughts(convId, 4)
  assert.equal(postTruncateThought, thought2)

  db.close()
})

test('issue #52: fallback to sqlite3 CLI directly on dbPath without copyFile', async (t) => {
  if (!sqliteOk) return t.skip('sqlite3 CLI unavailable')

  let Database: new (path: string) => {
    exec(sql: string): unknown
    prepare(sql: string): { run(...p: unknown[]): unknown }
    close(): void
  }
  try {
    ({ DatabaseSync: Database } = await import('node:sqlite') as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): unknown
        prepare(sql: string): { run(...p: unknown[]): unknown }
        close(): void
      }
    })
  } catch {
    return t.skip('node:sqlite unavailable')
  }

  const { mkdtemp, rm } = await import('node:fs/promises')
  const testRoot = await mkdtemp(join(tmpdir(), 'agy-db-cli-test-'))
  t.after(async () => {
    __setNodeSqliteQueryForTest(undefined)
    await rm(testRoot, { recursive: true, force: true })
  })

  const convId = 'conv-cli-direct'
  const dbPath = join(testRoot, `${convId}.db`)

  const toolPayload = buildStepPayload('read_file', {
    Path: '/tmp/test.txt',
  })
  const thoughtText = 'Fallback CLI reading direct database file.'
  const thoughtPayload = buildThoughtStepPayload(thoughtText)

  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB);')
  db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (10,132,3,X'${toolPayload.toString('hex')}');`).run()
  db.prepare(`INSERT INTO steps (idx,step_type,status,step_payload) VALUES (11,15,3,X'${thoughtPayload.toString('hex')}');`).run()
  db.close()

  __setAgyDbDirForTest(testRoot)
  // Force node:sqlite unavailable to exercise the sqlite3 CLI fallback path
  __setNodeSqliteQueryForTest(null)
  clearAgyDbCache()

  const start = Date.now()
  const tool = await readFullToolArgs(convId, 10)
  const thought = await readStepThoughts(convId, 11)
  const elapsed = Date.now() - start

  assert.ok(elapsed < 3000, `sqlite3 CLI fallback took ${elapsed}ms`)
  assert.equal(tool?.name, 'read_file')
  assert.equal((tool as { args: { Path?: string } })?.args?.Path, '/tmp/test.txt')
  assert.equal(thought, thoughtText)

  __setNodeSqliteQueryForTest(undefined)
})

test('zero-byte DB file returns null gracefully without error', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const testRoot = await mkdtemp(join(tmpdir(), 'agy-db-zero-test-'))
  t.after(async () => {
    await rm(testRoot, { recursive: true, force: true })
  })

  const convId = 'conv-zero'
  await writeFile(join(testRoot, `${convId}.db`), Buffer.alloc(0))

  __setAgyDbDirForTest(testRoot)
  clearAgyDbCache()

  assert.equal(await readFullToolArgs(convId, 1), null)
  assert.equal(await readStepThoughts(convId, 1), null)
})
