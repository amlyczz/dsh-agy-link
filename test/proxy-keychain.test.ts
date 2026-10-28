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
import { ensureIsolatedKeychain, isolatedHomeEnv, openAccountTerminal, proxyEnvFor, purgeStaleIsolatedKeychain, repairMacSystemKeychain, startAgyProcess } from '../src/host/runner.ts'
import { detectSystemProxy, invalidateProxyCache, parseMacScutilProxy, parseWindowsProxyServer } from '../src/host/wincred.ts'

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
  // Isolate the real user state dir: resolveConfig() defaults its overrides
  // argument to readOverrides() (stateDir()/runtime-overrides.json), so an
  // operator-configured proxy on this machine would otherwise win over the
  // entry layer and make this assertion environment-dependent.
  const prevHome = process.env.DSH_HOME
  const isolatedHome = mkdtempSync(join(tmpdir(), 'agy-cfg-home-'))
  process.env.DSH_HOME = isolatedHome
  try {
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
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(isolatedHome, { recursive: true, force: true })
  }
})

test('parseMacScutilProxy extracts HTTP, HTTPS, and SOCKS correctly', () => {
  assert.equal(parseMacScutilProxy(''), undefined)
  assert.equal(parseMacScutilProxy('   '), undefined)
  assert.equal(parseMacScutilProxy('HTTPEnable : 0\nHTTPSEnable : 0\n'), undefined)

  const httpsSample = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}
`
  assert.equal(parseMacScutilProxy(httpsSample), 'http://127.0.0.1:7890')

  const httpOnlySample = `
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : proxy.local
  HTTPSEnable : 0
`
  assert.equal(parseMacScutilProxy(httpOnlySample), 'http://proxy.local:8080')

  const socksSample = `
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
`
  assert.equal(parseMacScutilProxy(socksSample), 'socks5://127.0.0.1:1080')
})

test('parseWindowsProxyServer supports single and multi-protocol WinINet format', () => {
  assert.equal(parseWindowsProxyServer(''), '')
  assert.equal(parseWindowsProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(parseWindowsProxyServer('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(
    parseWindowsProxyServer('http=http://proxy:8080;https=http://secproxy:8443;ftp=ftp://ftpproxy:21'),
    'http://secproxy:8443',
  )
})

test('openAccountTerminal dispatches per platform (darwin, win32, linux)', () => {
  assert.equal(openAccountTerminal(''), false)

  // macOS (darwin)
  const macCalls: Array<{ file: string; args: string[] }> = []
  const macRun = (file: string, args: readonly string[]) => { macCalls.push({ file, args: [...args] }) }
  assert.equal(openAccountTerminal('/tmp/mac-acc', 'darwin', macRun), true)
  assert.equal(macCalls.length, 1)
  assert.equal(macCalls[0]?.file, 'osascript')
  assert.ok(macCalls[0]?.args[1]?.includes("export HOME='/tmp/mac-acc'; agy"))

  // Windows (win32)
  const winCalls: Array<{ file: string; args: string[] }> = []
  const winRun = (file: string, args: readonly string[]) => { winCalls.push({ file, args: [...args] }) }
  assert.equal(openAccountTerminal('C:\\Users\\test\\.dsh\\acc', 'win32', winRun), true)
  assert.equal(winCalls.length, 1)
  assert.equal(winCalls[0]?.file, 'cmd.exe')
  assert.ok(winCalls[0]?.args[4]?.includes('set "USERPROFILE=C:\\Users\\test\\.dsh\\acc"'))

  // Linux: succeeds on first working emulator
  const linuxCalls: Array<{ file: string; args: string[] }> = []
  const linuxRun = (file: string, args: readonly string[]) => {
    linuxCalls.push({ file, args: [...args] })
    if (file === 'xdg-terminal-exec') throw new Error('not installed')
    // x-terminal-emulator succeeds
  }
  assert.equal(openAccountTerminal('/tmp/linux-acc', 'linux', linuxRun), true)
  assert.equal(linuxCalls.length, 2)
  assert.equal(linuxCalls[0]?.file, 'xdg-terminal-exec')
  assert.equal(linuxCalls[1]?.file, 'x-terminal-emulator')

  // Linux: all emulators missing -> returns false
  const linuxFail = () => { throw new Error('command not found') }
  assert.equal(openAccountTerminal('/tmp/linux-acc', 'linux', linuxFail), false)
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
    assert.equal(calls.length, 2)
    assert.match(calls[0] ?? '', /create-keychain -p  /)
    assert.match(calls[1] ?? '', /set-keychain-settings/)
    // Second call: keychain file now exists (simulate by touching it) —
    // returns false immediately WITHOUT poking security CLI (issue #42 SecurityAgent prompt).
    mkdirSync(join(dir, 'Library', 'Keychains'), { recursive: true })
    writeFileSync(join(dir, 'Library', 'Keychains', 'login.keychain-db'), 'x')
    assert.equal(ensureIsolatedKeychain(dir, 'darwin', run), false)
    assert.equal(calls.length, 2, 'must NOT execute security CLI on existing keychains')
    // Failing security invocations never throw out.
    assert.equal(ensureIsolatedKeychain(dir, 'darwin', () => { throw new Error('boom') }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purgeStaleIsolatedKeychain unregisters and deletes un-unlockable keychains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-kc-purge-'))
  try {
    // Non-darwin is a no-op
    assert.equal(purgeStaleIsolatedKeychain(dir, 'linux'), false)
    assert.equal(purgeStaleIsolatedKeychain('', 'darwin'), false)
    assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin'), false) // file doesn't exist yet

    const kcDir = join(dir, 'Library', 'Keychains')
    mkdirSync(kcDir, { recursive: true })
    const kc = join(kcDir, 'login.keychain-db')
    writeFileSync(kc, 'corrupt-or-locked-content')

    // Scenario 1: set-keychain-settings succeeds -> not stale, preserved
    const calls1: string[] = []
    const runOk = (_file: string, args: readonly string[]) => { calls1.push(args.join(' ')) }
    assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin', runOk), false)
    assert.equal(calls1.length, 1)
    assert.match(calls1[0] ?? '', /set-keychain-settings/)
    assert.equal(existsSync(kc), true)

    // Scenario 2: set-keychain-settings throws (locked with secret or corrupted) -> purged!
    const calls2: string[] = []
    const runThrow = (_file: string, args: readonly string[]) => {
      calls2.push(args.join(' '))
      if (args[0] === 'set-keychain-settings') throw new Error('settings failed')
    }
    assert.equal(purgeStaleIsolatedKeychain(dir, 'darwin', runThrow), true)
    assert.equal(calls2.length, 2)
    assert.match(calls2[0] ?? '', /set-keychain-settings/)
    assert.match(calls2[1] ?? '', /delete-keychain/)
    assert.equal(existsSync(kc), false, 'corrupted keychain file must be deleted from disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repairMacSystemKeychain restores real login keychain when default/search list is hijacked', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'agy-fake-home-'))
  try {
    assert.equal(repairMacSystemKeychain(fakeHome, 'linux'), false)
    assert.equal(repairMacSystemKeychain('', 'darwin'), false)
    // No real keychain present in fakeHome -> no-op
    assert.equal(repairMacSystemKeychain(fakeHome, 'darwin'), false)

    // Create real user login keychain in fakeHome
    const kcDir = join(fakeHome, 'Library', 'Keychains')
    mkdirSync(kcDir, { recursive: true })
    const realKc = join(kcDir, 'login.keychain-db')
    writeFileSync(realKc, 'real-login-kc')

    const calls: string[] = []
    const run = (_file: string, args: readonly string[]) => {
      calls.push(args.join(' '))
      if (args[0] === 'default-keychain' && args.length === 1) {
        return '"/Users/test/.dsh/agy-accounts/acc_hijacked/Library/Keychains/login.keychain-db"\n'
      }
      if (args[0] === 'login-keychain' && args.length === 1) {
        return '"/Users/test/.dsh/agy-accounts/acc_hijacked/Library/Keychains/login.keychain-db"\n'
      }
      if (args[0] === 'list-keychains') {
        return '    "/Users/test/.dsh/agy-accounts/acc_hijacked/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'
      }
      return ''
    }

    const repaired = repairMacSystemKeychain(fakeHome, 'darwin', run)
    assert.equal(repaired, true)
    // Verify default-keychain was reset to realKc
    assert.ok(calls.some((c) => c.startsWith(`default-keychain -s ${realKc}`)))
    // Verify login-keychain was reset to realKc
    assert.ok(calls.some((c) => c.startsWith(`login-keychain -s ${realKc}`)))
    // Verify list-keychains was cleaned
    const setListCall = calls.find((c) => c.startsWith('list-keychains -d user -s'))
    assert.ok(setListCall)
    assert.ok(setListCall.includes(realKc))
    assert.ok(!setListCall.includes('acc_hijacked'))

    // Second run: everything is already clean -> returns false
    const cleanCalls: string[] = []
    const runClean = (_file: string, args: readonly string[]) => {
      cleanCalls.push(args.join(' '))
      if (args[0] === 'default-keychain' && args.length === 1) return `"${realKc}"\n`
      if (args[0] === 'login-keychain' && args.length === 1) return `"${realKc}"\n`
      if (args[0] === 'list-keychains') return `    "${realKc}"\n    "/Library/Keychains/System.keychain"\n`
      return ''
    }
    assert.equal(repairMacSystemKeychain(fakeHome, 'darwin', runClean), false)
  } finally {
    rmSync(fakeHome, { recursive: true, force: true })
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
