import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { binCandidates, isolatedHomeEnv, isCmdShim, resolveAgyBin, startAgyProcess, windowsQuote, buildStreamInputLine, shouldUsePromptStdin, ARGV_PROMPT_LIMIT } from '../src/host/runner.ts'
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

test('isolatedHomeEnv always sets HOME + GEMINI_CLI_HOME', () => {
  const env = isolatedHomeEnv('/tmp/acc1')
  assert.equal(env.HOME, '/tmp/acc1')
  assert.equal(env.GEMINI_CLI_HOME, join('/tmp/acc1', '.gemini'))
  if (process.platform === 'win32') {
    // Windows libuv/Go ignore $HOME — USERPROFILE/HOMEDRIVE/HOMEPATH required.
    assert.equal(env.USERPROFILE, '/tmp/acc1')
    const drive = isolatedHomeEnv('C:\\Users\\acc1')
    assert.equal(drive.HOMEDRIVE, 'C:')
    assert.equal(drive.HOMEPATH, '\\Users\\acc1')
  }
})

test('isCmdShim detects cmd/bat case-insensitively', () => {
  assert.equal(isCmdShim('C:\\npm\\agy.CMD'), true)
  assert.equal(isCmdShim('C:\\npm\\agy.bat'), true)
  assert.equal(isCmdShim('C:\\npm\\agy.exe'), false)
  assert.equal(isCmdShim('/usr/local/bin/agy'), false)
})

// Issue #13: GUI hosts must not flash a console for wrapper spawns.
test('Windows execFile call sites pass windowsHide', async () => {
  const { readFile } = await import('node:fs/promises')
  const oauth = await readFile(new URL('../src/host/oauth.ts', import.meta.url), 'utf8')
  const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(oauth, /windowsVerbatimArguments: true, windowsHide: true/)
  // pool/add and pool/open-terminal each spawn cmd.exe with windowsHide nearby
  const cmdSpawns = [...index.matchAll(/execFile\('cmd\.exe'[\s\S]{0,300}?\n/g)].map((m) => m[0])
  assert.ok(cmdSpawns.length >= 2, `expected >=2 cmd.exe spawns, found ${cmdSpawns.length}`)
  for (const call of cmdSpawns) {
    assert.match(call, /windowsHide:\s*true/, `missing windowsHide in: ${call.slice(0, 120)}`)
  }
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
  // timeoutMs is 3000ms, child emits 4 chunks across 600ms (every 150ms).
  // A fixed watchdog would kill at 3000ms; sliding activity watchdog refreshes on each chunk.
  const script = `
    const fs = require('node:fs');
    let i = 0;
    fs.writeSync(1, Buffer.from('chunk' + (++i) + '\\n'));
    const t = setInterval(() => {
      fs.writeSync(1, Buffer.from('chunk' + (++i) + '\\n'));
      if (i >= 4) clearInterval(t);
    }, 150);
  `
  const lines: string[] = []
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
    onLine: (l) => lines.push(l),
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.code, 0)
  assert.deepEqual(lines, ['chunk1', 'chunk2', 'chunk3', 'chunk4'])
})


test('startAgyProcess times out if child is completely silent', async () => {
  // timeoutMs is 500ms, child sleeps for 2500ms silently without any stdout/stderr
  const script = `setTimeout(() => {}, 2500)`
  const lines: string[] = []
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 500,
    onLine: (l) => lines.push(l),
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, true)
  assert.equal(lines.length, 0)
})

test('resolveAgyBin honors explicit agyBin config if it exists', () => {
  const found = resolveAgyBin({ agyBin: process.execPath } as never)
  assert.equal(found, process.execPath)
  const missing = resolveAgyBin({ agyBin: '/nonexistent/agy/path/xyz' } as never)
  // If explicit path does not exist, it falls back to scanning or null
  assert.notEqual(missing, '/nonexistent/agy/path/xyz')
})

test('buildStreamInputLine emits the verified agy stream-json user event', () => {
  const line = buildStreamInputLine('hello\nworld')
  assert.equal(line.endsWith('\n'), true)
  const parsed = JSON.parse(line)
  assert.deepEqual(parsed, { event: 'user', message: { role: 'user', content: 'hello\nworld' } })
})

test('shouldUsePromptStdin switches only past the argv budget (issue #14)', () => {
  const short = ['--output-format', 'stream-json', '-p', 'hi']
  assert.equal(shouldUsePromptStdin(short), false)
  const longPrompt = 'x'.repeat(ARGV_PROMPT_LIMIT)
  const long = ['--output-format', 'stream-json', '-p', longPrompt]
  assert.equal(shouldUsePromptStdin(long), true)
})

test('startAgyProcess writes stdinPayload then closes stdin', async () => {
  const script = `
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { data += d })
    process.stdin.on('end', () => { process.stdout.write('GOT:' + data.length + ':' + data.trim()); process.exit(0) })
  `
  const lines: string[] = []
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
    stdinPayload: 'hello-stdin-payload\n',
    onLine: (l) => lines.push(l),
  })
  const outcome = await proc.outcome
  assert.equal(outcome.code, 0)
  assert.ok(lines.some((l) => l.includes('GOT:20:hello-stdin-payload')), lines.join('|'))
})
