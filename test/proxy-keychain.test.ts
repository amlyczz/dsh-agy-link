// Regression tests: global proxy plumbing, per-account keychain
// provisioning, stdout-only idle watchdog, and the Stop-button SIGKILL
// escalation (offline agy ignores SIGTERM forever).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/common/config.ts'
import { defaultConfig } from '../src/common/types.ts'
import { ensureIsolatedKeychain, isolatedHomeEnv, proxyEnvFor, startAgyProcess } from '../src/host/runner.ts'

test('proxyEnvFor maps one URL onto all six proxy vars', () => {
  assert.deepEqual(proxyEnvFor(undefined), {})
  assert.deepEqual(proxyEnvFor(''), {})
  assert.deepEqual(proxyEnvFor('   '), {})
  const env = proxyEnvFor(' http://127.0.0.1:17891 ')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:17891')
  assert.equal(env.https_proxy, 'http://127.0.0.1:17891')
  assert.equal(Object.keys(env).length, 6)
})

test('resolveConfig reads proxyUrl from entry, overrides and env', () => {
  assert.equal(defaultConfig().proxyUrl, '')
  assert.equal(resolveConfig({ proxyUrl: 'http://p:1' }).proxyUrl, 'http://p:1')
  const overrides = join(tmpdir(), `agy-ovr-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(overrides, JSON.stringify({ proxyUrl: 'socks5://o:2' }))
  try {
    assert.equal(resolveConfig({}, {}, { proxyUrl: 'socks5://o:2' }).proxyUrl, 'socks5://o:2')
    // overrides beat the cordis entry (ADR-13 layering), env beats both
    assert.equal(resolveConfig({ proxyUrl: 'http://e:3' }, {}, { proxyUrl: 'socks5://o:2' }).proxyUrl, 'socks5://o:2')
    // env beats everything
    assert.equal(
      resolveConfig({ proxyUrl: 'http://e:3' }, { DSH_AGY_PROXY_URL: 'http://env:4' }, {}).proxyUrl,
      'http://env:4',
    )
  } finally {
    rmSync(overrides, { force: true })
  }
})

test('ensureIsolatedKeychain no-ops off darwin', () => {
  let calls = 0
  const ok = ensureIsolatedKeychain('/tmp/whatever', 'linux', () => { calls++ })
  assert.equal(ok, false)
  assert.equal(calls, 0)
})

test('ensureIsolatedKeychain provisions once per home and survives errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-kc-'))
  try {
    const calls: string[] = []
    const run = (_file: string, args: readonly string[]) => { calls.push(args.join(' ')) }
    assert.equal(ensureIsolatedKeychain(dir, 'darwin', run), true)
    assert.equal(calls.length, 4)
    assert.match(calls[0] ?? '', /create-keychain -p  /)
    assert.match(calls[1] ?? '', /default-keychain -s/)
    assert.match(calls[2] ?? '', /set-keychain-settings/)
    assert.match(calls[3] ?? '', /unlock-keychain -p/)
    // Second call: keychain file now exists (simulate by touching it) —
    // returns false immediately WITHOUT poking security CLI (issue #42 SecurityAgent prompt).
    mkdirSync(join(dir, 'Library', 'Keychains'), { recursive: true })
    writeFileSync(join(dir, 'Library', 'Keychains', 'login.keychain-db'), 'x')
    assert.equal(ensureIsolatedKeychain(dir, 'darwin', run), false)
    assert.equal(calls.length, 4, 'must NOT execute security CLI on existing keychains')
    // Failing security invocations never throw out.
    assert.equal(ensureIsolatedKeychain(dir, 'darwin', () => { throw new Error('boom') }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isolatedHomeEnv still relocates HOME (sanity)', () => {
  const env = isolatedHomeEnv('/tmp/h1')
  assert.equal(env.HOME, '/tmp/h1')
})

function nodeChild(script: string): string[] {
  // startAgyProcess receives bin=process.execPath, so args must NOT repeat it.
  return ['-e', script]
}

test('watchdog: stderr chatter does NOT keep an offline run alive', async () => {
  // Child writes to stderr every 100ms for 2s — the old behavior would stay
  // "active" forever; stdout-only semantics must time it out at 400ms.
  const p = startAgyProcess({
    bin: process.execPath,
    args: nodeChild('const t=Date.now();const i=setInterval(()=>{if(Date.now()-t>2000){process.exit(0)};console.error("noise")},100)'),
    timeoutMs: 400,
  })
  const outcome = await Promise.race([p.outcome, new Promise<null>((r) => setTimeout(() => r(null), 5000))])
  assert.ok(outcome, 'run should settle')
  assert.equal(outcome!.timedOut, true)
  assert.ok(outcome!.durationMs < 2000, `took ${outcome!.durationMs}ms`)
})

test('watchdog: stdout activity DOES keep the run alive', async () => {
  const p = startAgyProcess({
    bin: process.execPath,
    args: nodeChild('const t=Date.now();const i=setInterval(()=>{if(Date.now()-t>1200){clearInterval(i);process.exit(0)};console.log("progress")},100)'),
    timeoutMs: 800,
  })
  const outcome = await p.outcome
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.code, 0)
})

test('watchdog: stderrKeepalive opt-in preserves login-flow semantics', async () => {
  const p = startAgyProcess({
    bin: process.execPath,
    args: nodeChild('const t=Date.now();const i=setInterval(()=>{if(Date.now()-t>1200){clearInterval(i);process.exit(0)};console.error("login noise")},100)'),
    timeoutMs: 800,
    stderrKeepalive: true,
  })
  const outcome = await p.outcome
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.code, 0)
})

test('Stop button: SIGTERM-ignoring children still die via SIGKILL escalation', async () => {
  // A wedged agy (offline dial-retry) ignores SIGTERM; the 3s escalation
  // must SIGKILL the whole group so the UI Stop button always wins.
  const dir = mkdtempSync(join(tmpdir(), 'agy-stop-'))
  const marker = join(dir, 'ready')
  try {
    // The marker file is written strictly AFTER the SIGTERM handler is
    // registered, so killing on its existence has no registration race.
    const script = 'process.on("SIGTERM", () => {});' +
      'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "1");' +
      'setInterval(() => {}, 1000)'
    const p = startAgyProcess({ bin: process.execPath, args: nodeChild(script), timeoutMs: 0 })
    const waitStart = Date.now()
    while (!existsSync(marker)) {
      if (Date.now() - waitStart > 5000) throw new Error('child never became ready')
      await new Promise((r) => setTimeout(r, 20))
    }
    p.kill('abort')
    const outcome = await Promise.race([p.outcome, new Promise<null>((r) => setTimeout(() => r(null), 10000))])
    assert.ok(outcome, 'run should settle')
    assert.equal(outcome!.aborted, true)
    if (process.platform !== 'win32') {
      assert.equal(outcome!.signal, 'SIGKILL', `expected SIGKILL escalation, got ${outcome!.signal}`)
      assert.ok(outcome!.durationMs >= 2500, `escalated too early: ${outcome!.durationMs}ms`)
      assert.ok(outcome!.durationMs < 8000, `escalated too late: ${outcome!.durationMs}ms`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
