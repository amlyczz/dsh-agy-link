// Issue #49: agy's own `--bg-updater` child chain allocates a visible console
// on Windows before any parent env switch can apply. The only pre-spawn lever
// is agy's 15-minute `last_check.timestamp` fast path, so the plugin refreshes
// that mtime before every agy spawn.
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UPDATE_CHECK_FAST_PATH_MS,
  agyAppDataDir,
  agyUpdateCheckAgeMs,
  agyUpdateCheckPaths,
  describeAgyAutoUpdate,
  preemptAgyAutoUpdate,
} from '../../src/host/auto-updater.ts'
import { startAgyProcess } from '../../src/host/runner.ts'
import { defaultConfig } from '../../src/common/types.ts'
import { resolveConfig } from '../../src/common/config.ts'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('agyAppDataDir follows the same home isolation chain the plugin spawns with', () => {
  // The agent runs agy with ANTIGRAVITY_APP_DATA_DIR / GEMINI_CLI_HOME / HOME
  // redirected for pooled accounts; the timestamp must land in that same dir.
  assert.equal(
    agyAppDataDir({ ANTIGRAVITY_APP_DATA_DIR: '/tmp/app', GEMINI_CLI_HOME: '/tmp/g', HOME: '/tmp/h' }),
    '/tmp/app',
  )
  assert.equal(agyAppDataDir({ GEMINI_CLI_HOME: '/tmp/g', HOME: '/tmp/h' }), join('/tmp/g', 'antigravity-cli'))
  assert.equal(agyAppDataDir({ HOME: '/tmp/h' }), join('/tmp/h', '.gemini', 'antigravity-cli'))
  // Windows resolves home from USERPROFILE (Go and libuv both do).
  assert.equal(agyAppDataDir({ USERPROFILE: '/tmp/u' }), join('/tmp/u', '.gemini', 'antigravity-cli'))
  // Blank values must not be treated as a directory.
  assert.equal(agyAppDataDir({ ANTIGRAVITY_APP_DATA_DIR: '   ', HOME: '/tmp/h' }), join('/tmp/h', '.gemini', 'antigravity-cli'))
})

test('agyUpdateCheckPaths covers both platform layouts of last_check.timestamp', () => {
  const paths = agyUpdateCheckPaths({ ANTIGRAVITY_APP_DATA_DIR: '/tmp/app' })
  assert.deepEqual(paths, [
    join('/tmp/app', 'last_check.timestamp'),
    join('/tmp/app', 'updater', 'last_check.timestamp'),
  ])
})

test('preemptAgyAutoUpdate creates a fresh fast-path timestamp when agy has never checked', () => {
  const app = join(tmp('agy-preempt-'), 'app')
  assert.equal(existsSync(join(app, 'last_check.timestamp')), false)

  const now = Date.UTC(2026, 9, 19, 8, 0, 0)
  const res = preemptAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: app }, now)

  assert.deepEqual(res.failures, [])
  assert.deepEqual(res.touched, [
    join(app, 'last_check.timestamp'),
    join(app, 'updater', 'last_check.timestamp'),
  ])
  for (const p of res.touched) {
    assert.equal(existsSync(p), true, p + ' exists')
    assert.ok(Math.abs(statSync(p).mtimeMs - now) < 1000, p + ' mtime is now')
  }
})

test('preemptAgyAutoUpdate refreshes a stale timestamp (the 15-minute fast path gate)', () => {
  const app = tmp('agy-stale-')
  const file = join(app, 'last_check.timestamp')
  writeFileSync(file, '')
  const stale = Date.now() - 3 * 60 * 60_000
  utimesSync(file, stale / 1000, stale / 1000)
  assert.ok(agyUpdateCheckAgeMs({ ANTIGRAVITY_APP_DATA_DIR: app })! > UPDATE_CHECK_FAST_PATH_MS)

  preemptAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: app })
  const age = agyUpdateCheckAgeMs({ ANTIGRAVITY_APP_DATA_DIR: app })
  assert.notEqual(age, null)
  assert.ok(age! < UPDATE_CHECK_FAST_PATH_MS, 'age is inside the fast-path window after pre-emption')
})

test('preemptAgyAutoUpdate is best-effort: an unwritable path is reported, never thrown', () => {
  const root = tmp('agy-unwritable-')
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'not a directory')
  // <file>/app is impossible to create on every platform.
  const res = preemptAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: join(blocker, 'app') })
  assert.equal(res.touched.length, 0)
  assert.equal(res.failures.length, 2)
  for (const f of res.failures) assert.ok(f.error.length > 0)
})

test('agyUpdateCheckAgeMs is null when agy has no recorded check yet', () => {
  const app = join(tmp('agy-none-'), 'app')
  mkdirSync(app, { recursive: true })
  assert.equal(agyUpdateCheckAgeMs({ ANTIGRAVITY_APP_DATA_DIR: app }), null)
})

test('describeAgyAutoUpdate reports the suppression state for /agy doctor', () => {
  const app = tmp('agy-describe-')
  assert.match(describeAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: app }), /no agy update check recorded/)
  preemptAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: app })
  assert.match(describeAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: app }), /suppressed/)
})

test('startAgyProcess pre-empts the update check before spawning agy', async () => {
  const app = join(tmp('agy-spawn-'), 'app')
  const env = { ...process.env, ANTIGRAVITY_APP_DATA_DIR: app }
  const proc = startAgyProcess({ bin: process.execPath, args: ['-e', '0'], timeoutMs: 30_000, env })
  const outcome = await proc.outcome
  assert.equal(outcome.code, 0)
  assert.equal(existsSync(join(app, 'last_check.timestamp')), true)
})

test('startAgyProcess leaves the updater alone when pre-emption is disabled', async () => {
  const app = join(tmp('agy-spawn-off-'), 'app')
  const env = { ...process.env, ANTIGRAVITY_APP_DATA_DIR: app }
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', '0'],
    timeoutMs: 30_000,
    env,
    preemptAutoUpdate: false,
  })
  const outcome = await proc.outcome
  assert.equal(outcome.code, 0)
  assert.equal(existsSync(join(app, 'last_check.timestamp')), false)
})

test('suppressAgyAutoUpdate defaults to Windows-only and is overridable', () => {
  assert.equal(defaultConfig().suppressAgyAutoUpdate, process.platform === 'win32')
  // cordis entry / runtime override layer
  assert.equal(resolveConfig({ suppressAgyAutoUpdate: true }, {}, {}).suppressAgyAutoUpdate, true)
  // env wins last
  assert.equal(resolveConfig({ suppressAgyAutoUpdate: false }, { DSH_AGY_SUPPRESS_AUTOUPDATE: '1' }, {}).suppressAgyAutoUpdate, true)
  assert.equal(resolveConfig({}, { DSH_AGY_SUPPRESS_AUTOUPDATE: '0' }, {}).suppressAgyAutoUpdate, false)
})

test('pre-emption cleans up nothing of its own: temp roots stay removable', () => {
  // Guard against the module leaving open handles or read-only files behind.
  const app = tmp('agy-cleanup-')
  preemptAgyAutoUpdate({ ANTIGRAVITY_APP_DATA_DIR: app })
  rmSync(app, { recursive: true, force: true })
  assert.equal(existsSync(app), false)
})
