// Regression coverage for the silent-exit diagnostic: a run that ends with
// `agy exited with code N` while stderr and the result envelope are empty used
// to surface no detail at all, so the turn failure was undiagnosable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agyLogTailText, withRunLogTail } from '../../src/provider/failure-log-tail.ts'
import { Err } from '../../src/common/types.ts'
import { defaultConfig } from '../../src/common/types/config.ts'
import { oneshotEnv } from '../../src/host/oneshot.ts'

const RUN_LOG = [
  'I1124 14:31:21.855 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
  'I1124 14:31:36.364 server.go:1351] Stream goroutine exited for 02fbac56, sending completion signal',
  'I1124 14:31:36.364 rpcs_backend.go:484] ForceStopCascadeTree requested: cascade_id="02fbac56"',
  'E1124 14:31:36.425 file_watcher.go:194] skipping empty or temp file: ',
].join('\n')

test('silent PROCESS_EXIT gets the agy log tail appended', () => {
  const failure = withRunLogTail(
    { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code 1' },
    RUN_LOG,
  )
  assert.ok(failure !== null)
  assert.ok(failure.message.startsWith('agy exited with code 1: [agy log tail] '))
  assert.ok(failure.message.includes('Stream goroutine exited'), 'the meaningful line must survive')
  assert.ok(failure.message.includes('ForceStopCascadeTree'))
  assert.equal(failure.message.includes('http_helpers.go:748'), false, 'URL noise must be filtered')
  assert.equal(failure.message.includes('file_watcher.go'), false, 'watcher noise must be filtered')
})

test('a PROCESS_EXIT that already carries a detail is left untouched', () => {
  const message = 'agy exited with code 1: invalid model'
  const failure = withRunLogTail({ kind: 'error', code: Err.PROCESS_EXIT, message }, RUN_LOG)
  assert.equal(failure?.message, message)
})

test('non-PROCESS_EXIT failures and empty logs are left untouched', () => {
  const timeout = { kind: 'error' as const, code: Err.TIMEOUT, message: 'agy run was idle' }
  assert.equal(withRunLogTail(timeout, RUN_LOG)?.message, timeout.message)
  assert.equal(withRunLogTail(null, RUN_LOG), null)
  const silent = { kind: 'error' as const, code: Err.PROCESS_EXIT, message: 'agy exited with code 1' }
  assert.equal(withRunLogTail(silent, '')?.message, silent.message)
  // A log made only of noise lines is as useless as an empty one.
  const noiseOnly = RUN_LOG.split('\n').filter((l) => l.includes('file_watcher')).join('\n')
  assert.equal(withRunLogTail(silent, noiseOnly)?.message, silent.message)
})

test('the tail is bounded so the error stays readable', () => {
  const tail = agyLogTailText(Array.from({ length: 200 }, (_, i) => `line ${i} ` + 'x'.repeat(40)).join('\n'))
  assert.ok(tail.length <= 901, 'tail must be capped at ~900 chars')
  assert.ok(tail.includes('line 199'), 'the newest lines are the ones kept')
})

test('the oneshot spawn honours disableTelemetry (was the last unflagged path)', () => {
  const on = oneshotEnv({ ...defaultConfig(), disableTelemetry: true })
  assert.equal(on.DO_NOT_TRACK, '1')
  assert.equal(on.DISABLE_TELEMETRY, '1')
  assert.equal(on.GOOGLE_CLOUD_DISABLE_TELEMETRY, '1')
  assert.equal(on.ANTIGRAVITY_DISABLE_TELEMETRY, '1')
  const off = oneshotEnv({ ...defaultConfig(), disableTelemetry: false })
  assert.equal(off.DO_NOT_TRACK, undefined)
  assert.equal(off.ANTIGRAVITY_DISABLE_TELEMETRY, undefined)
})
