import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountHome, buildAgyEnv, buildAgyEnvWithProxy, pickProxy, resolveProxy } from '../src/runtime/net/account-env.ts'
import { defaultConfig } from '../src/common/types.ts'

test('pickProxy: account proxy wins over global, empty strings fall through', () => {
  assert.equal(pickProxy('http://account:1', 'http://global:2'), 'http://account:1')
  assert.equal(pickProxy('  ', 'http://global:2'), 'http://global:2')
  assert.equal(pickProxy(undefined, '  '), pickProxy(undefined, undefined))
})

test('resolveProxy uses the config proxy and trims it', () => {
  const cfg = { ...defaultConfig(), proxyUrl: ' http://global:7890 ' }
  assert.equal(resolveProxy(undefined, cfg), 'http://global:7890')
  assert.equal(resolveProxy({ proxyUrl: 'http://acc:1' }, cfg), 'http://acc:1')
})

test('accountHome follows the isolated dir, else HOME', () => {
  assert.equal(accountHome({ dir: '/tmp/acc' }), '/tmp/acc')
  // `os.homedir()` is the fallback and reads USERPROFILE on Windows, where HOME is unset.
  const systemHome = process.env.HOME ?? homedir()
  assert.equal(accountHome({ dir: '' }), systemHome)
  assert.equal(accountHome(undefined), systemHome)
})

test('buildAgyEnv isolates HOME and applies the proxy to every variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-env-'))
  try {
    const cfg = { ...defaultConfig(), proxyUrl: 'http://global:7890' }
    const env = buildAgyEnv({ account: { dir }, cfg, sessionId: 'sess-1' })
    assert.equal(env.HOME, dir)
    assert.equal(env.GEMINI_CLI_HOME, join(dir, '.gemini'))
    assert.equal(env.DSH_MCP_SESSION, 'sess-1')
    assert.equal(env.HTTPS_PROXY, 'http://global:7890')
    assert.equal(env.https_proxy, 'http://global:7890')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildAgyEnv telemetry flags are opt-in', () => {
  const cfg = { ...defaultConfig(), disableTelemetry: true }
  const withFlags = buildAgyEnv({ cfg, telemetryFlags: true })
  assert.equal(withFlags.DO_NOT_TRACK, '1')
  assert.equal(withFlags.ANTIGRAVITY_DISABLE_TELEMETRY, '1')
  const without = buildAgyEnv({ cfg })
  assert.equal(without.DO_NOT_TRACK, undefined)
})

test('buildAgyEnvWithProxy accepts an already resolved proxy', () => {
  const env = buildAgyEnvWithProxy({ proxy: 'socks5://127.0.0.1:1080' })
  assert.equal(env.ALL_PROXY, 'socks5://127.0.0.1:1080')
  assert.equal(env.HOME, process.env.HOME)
})
