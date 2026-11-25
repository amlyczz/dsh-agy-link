import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { Err, defaultConfig } from '../../../src/common/types.ts'
import { TranslationWorkerPool, type WorkerProcessLike, type WorkerSpawnFn } from '../../../src/features/translation/worker.ts'
import { AccountPoolManager } from '../../../src/host/pool.ts'

class FakeWorkerChild extends EventEmitter implements WorkerProcessLike {
  // Keep `pid` undefined on fake children so `killWorkerProcess` invokes
  // `child.kill('SIGKILL')` directly instead of sending SIGKILL to a real OS
  // process group matching a synthetic PID.
  readonly pid = undefined
  private readonly fakeId: number
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly receivedLines: string[] = []
  killCalls = 0
  closed = false

  constructor(fakeId: number, onLine?: (line: string, child: FakeWorkerChild) => void) {
    super()
    this.fakeId = fakeId
    let buf = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buf += chunk
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        this.receivedLines.push(line)
        onLine?.(line, this)
        idx = buf.indexOf('\n')
      }
    })
  }

  emitResult(response: string, opts: { ok?: boolean; error?: string; deltas?: string[] } = {}): void {
    this.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-' + this.fakeId }) + '\n')
    for (const d of opts.deltas ?? []) {
      this.stdout.write(JSON.stringify({ event: 'step_update', step_type: 'text', delta: d }) + '\n')
    }
    this.stdout.write(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-' + this.fakeId,
        status: opts.ok === false ? 'ERROR' : 'OK',
        response,
        ...(opts.error ? { error: opts.error } : {}),
      },
    }) + '\n')
  }

  kill(): boolean {
    this.killCalls += 1
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => this.emit('close', 0))
    }
    return true
  }
}

function makeHarness(onChildLine: (turnInChild: number, line: string, child: FakeWorkerChild) => void) {
  const spawns: Array<{ bin: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv; child: FakeWorkerChild }> = []
  const spawn: WorkerSpawnFn = (bin, args, opts) => {
    const child = new FakeWorkerChild(10_000 + spawns.length, (line, c) => {
      onChildLine(c.receivedLines.length, line, c)
    })
    spawns.push({ bin, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}), child })
    return child
  }
  return { spawns, spawn }
}

test('TranslationWorkerPool reuses a warm worker across turns without exit and avoids broken flags', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-worker-reuse-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('w1')
  pool.setActiveAccount(acc.id)

  const h = makeHarness((turn, _line, child) => {
    queueMicrotask(() => child.emitResult(`译文#${turn}`, { deltas: [`译文#${turn}`] }))
  })
  const workers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => '/usr/local/bin/agy',
    pool,
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
  })
  t.after(() => {
    workers.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const r1 = await workers.tryTranslate({ prompt: 'hello 1', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 512, timeoutMs: 10_000 })
  const r2 = await workers.tryTranslate({ prompt: 'hello 2', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 512, timeoutMs: 10_000 })
  assert.equal(r1?.ok, true)
  assert.equal(r1?.text, '译文#1')
  assert.equal(r1?.accountId, acc.id)
  assert.equal(r2?.ok, true)
  assert.equal(r2?.text, '译文#2')
  assert.equal(h.spawns.length, 1, 'second turn must reuse the live warm process')
  const spawn = h.spawns[0]!
  assert.equal(spawn.child.closed, false, 'worker stays alive waiting on stdin')
  assert.equal(spawn.cwd, tmpdir(), 'runs in tmpdir rather than workspace')
  assert.ok(spawn.args.includes('--input-format') && spawn.args.includes('stream-json'))
  assert.ok(spawn.args.includes('--output-format') && spawn.args.includes('stream-json'))
  assert.ok(spawn.args.includes('--mode') && spawn.args.includes('plan'))
  assert.equal(spawn.args.includes('--disable-slash-commands'), false, 'never pass --disable-slash-commands with --mode plan')
  assert.equal(spawn.args.includes('--add-dir'), false)
  assert.equal(spawn.child.receivedLines.length, 2)
  assert.equal((JSON.parse(spawn.child.receivedLines[0]!) as { message: { content: string } }).message.content, 'hello 1')
  assert.equal((JSON.parse(spawn.child.receivedLines[1]!) as { message: { content: string } }).message.content, 'hello 2')
  // The warm worker is long-lived, so it must honour disableTelemetry like every
  // other spawn path: leaving `telemetryFlags` unset makes buildAgyEnv DELETE
  // these variables and agy's Clearcut uploader comes back on.
  assert.equal(spawn.env?.DO_NOT_TRACK, '1', 'telemetry opt-out reaches the warm translation worker')
  assert.equal(spawn.env?.ANTIGRAVITY_DISABLE_TELEMETRY, '1')
  assert.equal(spawn.env?.GOOGLE_CLOUD_DISABLE_TELEMETRY, '1')
})

test('TranslationWorkerPool leaves telemetry flags off when disableTelemetry is false', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-worker-telemetry-off-'))
  const pool = new AccountPoolManager(dir)
  const acc = pool.createAccountSlot('w1')
  pool.setActiveAccount(acc.id)
  const h = makeHarness((_turn, _line, child) => {
    queueMicrotask(() => child.emitResult('ok', { deltas: ['ok'] }))
  })
  const workers = new TranslationWorkerPool({
    cfg: () => ({ ...defaultConfig(), disableTelemetry: false }),
    bin: () => '/usr/local/bin/agy',
    pool,
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
  })
  t.after(() => {
    workers.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const r = await workers.tryTranslate({ prompt: 'hello', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 512, timeoutMs: 10_000 })
  assert.equal(r?.ok, true)
  const spawn = h.spawns[0]!
  assert.equal(spawn.env?.DO_NOT_TRACK, undefined, 'opting out of the opt-out keeps telemetry on')
  assert.equal(spawn.env?.ANTIGRAVITY_DISABLE_TELEMETRY, undefined)
})

test('TranslationWorkerPool recycles worker on maxTurns, key change, and returns null on win32', async (t) => {
  const h = makeHarness((_turn, _line, child) => {
    queueMicrotask(() => child.emitResult('ok'))
  })
  const winWorkers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => 'agy.exe',
    log: () => {},
    platform: 'win32',
    spawn: h.spawn,
  })
  assert.equal(await winWorkers.tryTranslate({ prompt: 'hi', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 }), null)
  assert.equal(h.spawns.length, 0)

  const workers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => '/usr/local/bin/agy',
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
    maxTurns: 2,
  })
  t.after(() => workers.dispose())

  await workers.tryTranslate({ prompt: 't1', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  await workers.tryTranslate({ prompt: 't2', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(h.spawns.length, 1)
  assert.equal(h.spawns[0]!.child.killCalls, 1, 'maxTurns recycles worker after turn 2')

  await workers.tryTranslate({ prompt: 't3', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(h.spawns.length, 2)

  // Key change (effort low -> high) recycles immediately.
  await workers.tryTranslate({ prompt: 't4', model: 'gemini-3.8-flash', effort: 'high', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(h.spawns.length, 3)
  assert.ok(h.spawns[1]!.child.killCalls >= 1)
})

test('TranslationWorkerPool learns --effort refusal and transparently retries without --effort', async (t) => {
  const remembered: string[] = []
  let call = 0
  const h = makeHarness((_turn, _line, child) => {
    call += 1
    queueMicrotask(() => {
      if (call === 1) {
        child.emitResult('', {
          ok: false,
          error: 'invalid model selection (--model "gemini-3.8-flash" --effort "low"): --effort is not supported for model "gemini-3.8-flash"',
        })
      } else {
        child.emitResult('无 effort 成功')
      }
    })
  })
  const workers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => '/usr/local/bin/agy',
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
    isEffortUnsupported: (m) => remembered.includes(m),
    rememberEffortUnsupported: (m) => remembered.push(m),
  })
  t.after(() => workers.dispose())

  const res = await workers.tryTranslate({ prompt: 'hello', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(res?.ok, true)
  assert.equal(res?.text, '无 effort 成功')
  assert.deepEqual(remembered, ['gemini-3.8-flash'])
  assert.equal(h.spawns.length, 2)
  assert.equal(h.spawns[0]!.args.includes('--effort'), true)
  assert.equal(h.spawns[1]!.args.includes('--effort'), false)
})

test('TranslationWorkerPool classifies 429 rotation, TOS_VIOLATION quarantine, and keyring network jitter', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-worker-err-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)!
  pool.setAccountEnabled(primary.id, false)
  const a1 = pool.createAccountSlot('a1')
  const a2 = pool.createAccountSlot('a2')
  pool.setActiveAccount(a1.id)

  let mode: '429' | 'tos-ok' | 'jitter' = '429'
  const h = makeHarness((_turn, _line, child) => {
    queueMicrotask(() => {
      if (mode === '429') {
        child.emitResult('', { ok: false, error: 'RESOURCE_EXHAUSTED: code 429 Resets in 10m' })
      } else if (mode === 'tos-ok') {
        child.emitResult('This service has been disabled in this account. TOS_VIOLATION', { ok: true })
      } else {
        child.stderr.write('keyringAuth: timed out after 10s\nprintmode.go:409 silent auth failed\n')
        child.emitResult('', { ok: false, error: 'authentication required' })
      }
    })
  })
  const workers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => '/usr/local/bin/agy',
    pool,
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
  })
  t.after(() => {
    workers.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const r429 = await workers.tryTranslate({ prompt: 'p1', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(r429?.ok, false)
  assert.equal(r429?.code, Err.RATE_LIMIT)
  assert.equal(pool.getActiveAccountId('google'), a2.id, 'must cool a1 and rotate to a2')

  mode = 'jitter'
  const rJitter = await workers.tryTranslate({ prompt: 'p2', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(rJitter?.code, Err.NETWORK, 'keyring validation timeout must not falsely trigger AUTH')
  assert.equal(pool.getAccount(a2.id)?.authRequired, undefined)

  mode = 'tos-ok'
  const rTos = await workers.tryTranslate({ prompt: 'p3', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  assert.equal(rTos?.ok, false)
  assert.equal(rTos?.code, Err.AGY_ERROR)
  assert.equal(pool.getAccount(a2.id)?.authRequired, true, 'TOS_VIOLATION inside ok body still quarantines')
})

test('TranslationWorkerPool honors queue abort and dispose() kills active worker', async () => {
  let releaseFirst!: () => void
  const firstSent = new Promise<void>((r) => { releaseFirst = r })
  const h = makeHarness(() => {
    releaseFirst()
  })
  const workers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => '/usr/local/bin/agy',
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
  })

  const p1 = workers.tryTranslate({ prompt: 'first', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000 })
  await firstSent

  const ac = new AbortController()
  const p2 = workers.tryTranslate({ prompt: 'queued', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 256, timeoutMs: 5_000, signal: ac.signal })
  ac.abort()
  const r2 = await p2
  assert.equal(r2?.ok, false)
  assert.equal(r2?.code, 'ABORTED')

  h.spawns[0]!.child.emitResult('done1')
  const r1 = await p1
  assert.equal(r1?.ok, true)
  workers.dispose()
  assert.equal(h.spawns[0]!.child.killCalls, 1)
})

test('TranslationWorkerPool covers empty response, validation/overloaded/eligibility/auth errors, abort, timeout, exit, and idle TTL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-worker-cov-'))
  const pool = new AccountPoolManager(dir)
  const primary = pool.getAccounts().find((a) => a.systemHome)!
  pool.setAccountEnabled(primary.id, false)
  const a1 = pool.createAccountSlot('a1')
  const a2 = pool.createAccountSlot('a2')
  pool.setActiveAccount(a1.id)

  type Mode = 'empty' | 'validation' | 'overloaded' | 'eligibility' | 'auth' | 'generic-err' | 'child-error' | 'child-close' | 'hang-abort' | 'hang-timeout' | 'ok'
  let mode: Mode = 'empty'
  const h = makeHarness((_turn, _line, child) => {
    queueMicrotask(() => {
      if (mode === 'empty') child.emitResult('')
      else if (mode === 'validation') child.emitResult('', { ok: false, error: 'VALIDATION_REQUIRED: verify your account' })
      else if (mode === 'overloaded') child.emitResult('', { ok: false, error: 'model is overloaded, experiencing high traffic' })
      else if (mode === 'eligibility') child.emitResult('', { ok: false, error: 'model "gemini-3.8-flash" is not recognized as a known model' })
      else if (mode === 'auth') child.emitResult('', { ok: false, error: 'authentication required: invalid_grant' })
      else if (mode === 'generic-err') child.emitResult('', { ok: false, error: 'unexpected boom' })
      else if (mode === 'child-error') child.emit('error', new Error('spawn ENOENT'))
      else if (mode === 'child-close') { child.closed = true; child.emit('close', 1) }
      else if (mode === 'ok') child.emitResult('ok-reply')
    })
  })
  let now = 1_000
  const workers = new TranslationWorkerPool({
    cfg: defaultConfig,
    bin: () => '/usr/local/bin/agy',
    pool,
    log: () => {},
    platform: 'darwin',
    spawn: h.spawn,
    idleTtlMs: 25,
    now: () => now,
  })
  t.after(() => {
    workers.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  // Pre-aborted signal returns ABORTED immediately.
  const preAborted = new AbortController()
  preAborted.abort()
  assert.equal((await workers.tryTranslate({ prompt: 'x', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000, signal: preAborted.signal }))?.code, 'ABORTED')

  mode = 'empty'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.EMPTY_RESPONSE)

  mode = 'validation'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.AGY_ERROR)

  mode = 'overloaded'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.OVERLOADED)

  mode = 'eligibility'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.ELIGIBILITY)

  mode = 'auth'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.AUTH)

  // Clear auth/unsupported state so remaining cases run cleanly on a2.
  pool.clearAuthRequired(a2.id)
  pool.setActiveAccount(a2.id)

  mode = 'generic-err'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.AGY_ERROR)

  mode = 'child-error'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.PROCESS_EXIT)

  mode = 'child-close'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.PROCESS_EXIT)

  // Mid-flight abort
  mode = 'hang-abort'
  const ac = new AbortController()
  const pAbort = workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 5_000, signal: ac.signal })
  setTimeout(() => ac.abort(), 15)
  assert.equal((await pAbort)?.code, 'ABORTED')

  // Timeout (minimum 1_000ms)
  mode = 'hang-timeout'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 1_000 }))?.code, Err.TIMEOUT)

  // Idle timer expiry drops worker
  mode = 'ok'
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.ok, true)
  const lastSpawn = h.spawns[h.spawns.length - 1]!
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(lastSpawn.child.killCalls, 1, 'idle TTL timer must reap idle worker')

  // All accounts disabled -> QUOTA
  pool.setAccountEnabled(a1.id, false)
  pool.setAccountEnabled(a2.id, false)
  now += 100
  assert.equal((await workers.tryTranslate({ prompt: 'p', model: 'gemini-3.8-flash', effort: 'low', maxTokens: 64, timeoutMs: 2_000 }))?.code, Err.QUOTA)
})
