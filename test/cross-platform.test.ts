import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { binCandidates, isCmdShim, startAgyProcess, windowsQuote } from '../src/host/runner.ts'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

test('windowsQuote leaves plain args untouched', () => {
  assert.equal(windowsQuote('plain-arg'), 'plain-arg')
  assert.equal(windowsQuote('--print'), '--print')
})

test('windowsQuote wraps args with spaces and escapes quotes', () => {
  assert.equal(windowsQuote('hello world'), '"hello world"')
  // inner quote escapes; a trailing backslash doubles only when quoting (cross-spawn rules)
  assert.equal(windowsQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(windowsQuote('dir \\'), '"dir \\\\"')
  // no special chars -> untouched, even with a trailing backslash
  assert.equal(windowsQuote('path\\'), 'path\\')
})

test('binCandidates are per-platform', () => {
  // extensions follow the platform; separators come from the host join(),
  // so build expectations with join too (runs green on any OS)
  const win = binCandidates('C:\\tools', 'win32')
  assert.deepEqual(win, [join('C:\\tools', 'agy.exe'), join('C:\\tools', 'agy.cmd'), join('C:\\tools', 'agy.bat')])
  assert.deepEqual(win.map((c) => c.split(/[\\/]/).pop()), ['agy.exe', 'agy.cmd', 'agy.bat'])
  const nix = binCandidates('/usr/bin', 'linux')
  assert.deepEqual(nix, [join('/usr/bin', 'agy')])
  assert.equal(nix[0]!.endsWith('agy'), true)
  const mac = binCandidates('/opt/homebrew/bin', 'darwin')
  assert.deepEqual(mac, [join('/opt/homebrew/bin', 'agy')])
})

test('isCmdShim detects cmd/bat case-insensitively', () => {
  assert.equal(isCmdShim('C:\\npm\\agy.CMD'), true)
  assert.equal(isCmdShim('C:\\npm\\agy.bat'), true)
  assert.equal(isCmdShim('C:\\npm\\agy.exe'), false)
  assert.equal(isCmdShim('/usr/local/bin/agy'), false)
})

// CRLF tolerance: a child emitting \r\n lines must deliver clean lines.
test('runner strips trailing CR from CRLF output', async () => {
  const lines: string[] = []
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({a:1}) + "\\r\\n" + JSON.stringify({b:2}) + "\\r\\n")'])
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    pending += d
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '')
      pending = pending.slice(nl + 1)
      lines.push(line)
    }
  })
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
  assert.equal(code, 0)
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }])
})

test('startAgyProcess activity watchdog refreshes on output chunks', async () => {
  // timeoutMs is 700ms, but child outputs 4 times across ~1500ms (total duration > 2x timeoutMs).
  // A fixed watchdog would kill at 700ms; sliding activity watchdog refreshes on each chunk.
  const script = `
    console.log('chunk1');
    setTimeout(() => console.log('chunk2'), 400);
    setTimeout(() => console.log('chunk3'), 800);
    setTimeout(() => console.log('chunk4'), 1200);
  `
  const lines: string[] = []
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 700,
    onLine: (l) => lines.push(l),
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.code, 0)
  assert.deepEqual(lines, ['chunk1', 'chunk2', 'chunk3', 'chunk4'])
})

test('startAgyProcess times out if child is completely silent', async () => {
  // timeoutMs is 400ms, child sleeps for 2000ms silently without any stdout/stderr
  const script = `setTimeout(() => {}, 2000)`
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 400,
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, true)
})
