// Regression: v0.6.19 / v0.6.20 got GitHub Releases but never landed on npm.
// The publish workflow did a single `npm publish` (transient E404 killed both)
// and never verified the version is actually readable from the registry.
// TDD for scripts/publish-retry.mjs — the runner/sleeper are injected so no
// real npm command is ever executed by these tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isTransientPublishError, publishWithRetry } from '../scripts/publish-retry.mjs'

const pkg = { name: 'dsh-agy-link', version: '9.9.9' }
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const fail = (stderr: string, status = 1): RunResult => ({ status, stdout: '', stderr })
const noop = async () => {}

/** Fake npm: `view` is driven by a mutable registry set, `publish` by a scripted queue. */
type RunResult = { status: number; stdout: string; stderr: string }
function fakeNpm(scripted: RunResult[], opts: { alreadyPublished?: boolean } = {}) {
  const calls: string[] = []
  const registry = new Set(opts.alreadyPublished ? [pkg.version] : [])
  const run = (_bin: string, args: string[]) => {
    calls.push(args.join(' '))
    if (args[0] === 'view') return registry.has(pkg.version) ? ok(pkg.version) : fail('E404 not found')
    const next = scripted.shift()
    if (next && next.status === 0) registry.add(pkg.version)
    return next ?? ok()
  }
  return { run, calls, registry }
}

test('transient publish errors are classified separately from fatal auth errors', () => {
  assert.equal(isTransientPublishError('npm error 404 Not Found - PUT https://registry.npmjs.org/dsh-agy-link'), true)
  assert.equal(isTransientPublishError('npm error code ETIMEDOUT'), true)
  assert.equal(isTransientPublishError('npm error code ENEEDAUTH'), false)
  assert.equal(isTransientPublishError('npm error 403 Forbidden'), false)
  assert.equal(isTransientPublishError('npm error code EBADSEMVER'), false)
})

test('a transient E404 is retried and the release succeeds on the next attempt', async () => {
  const npm = fakeNpm([fail('npm error 404 Not Found - PUT ...'), ok()])
  const sleeps: number[] = []
  const result = await publishWithRetry({
    pkg, run: npm.run, sleep: async (ms: number) => { sleeps.push(ms) },
  })
  assert.equal(result.published, true)
  assert.equal(result.attempts, 2)
  assert.equal(npm.calls.filter((c) => c.startsWith('publish')).length, 2)
  assert.deepEqual(sleeps, [5000])
  assert.ok(npm.calls.some((c) => c.startsWith('view dsh-agy-link@9.9.9 version')), 'registry is verified after publishing')
})

test('persistent transient errors exhaust the retry budget and fail loudly', async () => {
  const npm = fakeNpm([fail('npm error 404 Not Found - PUT ...'), fail('npm error 404 Not Found - PUT ...'), fail('npm error 404 Not Found - PUT ...')])
  await assert.rejects(
    () => publishWithRetry({ pkg, run: npm.run, sleep: noop, attempts: 3, delays: [1, 2], verifyAttempts: 1 }),
    /404/,
  )
  assert.equal(npm.calls.filter((c) => c.startsWith('publish')).length, 3)
})

test('a fatal auth error fails immediately without burning retries', async () => {
  const npm = fakeNpm([fail('npm error code ENEEDAUTH'), ok(), ok()])
  await assert.rejects(
    () => publishWithRetry({ pkg, run: npm.run, sleep: noop, attempts: 4 }),
    /ENEEDAUTH/,
  )
  assert.equal(npm.calls.filter((c) => c.startsWith('publish')).length, 1)
})

test('an already-published version is idempotent: no second publish attempt', async () => {
  const npm = fakeNpm([], { alreadyPublished: true })
  const result = await publishWithRetry({ pkg, run: npm.run, sleep: noop })
  assert.equal(result.published, false)
  assert.equal(result.attempts, 0)
  assert.equal(npm.calls.some((c) => c.startsWith('publish')), false)
})

test('a publish that exits 0 but is not yet on the registry is polled, not trusted blindly', async () => {
  // Registry needs one extra probe before the version becomes visible.
  const calls: string[] = []
  let views = 0
  const run = (_bin: string, args: string[]) => {
    calls.push(args.join(' '))
    if (args[0] === 'view') {
      views++ // #1 = pre-publish probe, #2 = first verify (still invisible)
      return views >= 3 ? ok(pkg.version) : fail('E404')
    }
    return ok()
  }
  const result = await publishWithRetry({ pkg, run, sleep: noop, verifyAttempts: 2, verifyDelayMs: 1 })
  assert.equal(result.published, true)
  assert.equal(calls.filter((c) => c.startsWith('view')).length >= 3, true)
})

test('publish that never becomes visible warns but does not fail (registry propagation is slow)', async () => {
  const warnings: string[] = []
  const run = (_bin: string, args: string[]) => args[0] === 'publish' ? ok() : fail('E404')
  const result = await publishWithRetry({
    pkg, run, sleep: noop, verifyAttempts: 2, verifyDelayMs: 1,
    log: (m: string) => warnings.push(m),
  })
  assert.equal(result.published, true)
  assert.equal(result.verified, false)
  assert.ok(warnings.some((m) => m.includes('WARNING')), 'the slow-propagation warning is surfaced')
})

test('PUBLISH_STRICT_VERIFY mode makes an unresolved registry probe fatal', async () => {
  const run = (_bin: string, args: string[]) => args[0] === 'publish' ? ok() : fail('E404')
  await assert.rejects(
    () => publishWithRetry({ pkg, run, sleep: noop, verifyAttempts: 2, verifyDelayMs: 1, strictVerify: true, log: () => {} }),
    /not readable from the registry/i,
  )
})
