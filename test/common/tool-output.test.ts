import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanToolOutput, isEnvelopeOnly, stripReadGutter } from '../../src/common/tool-output.ts'

const CMD_ENVELOPE = [
  'Created At: 2026-11-26T19:35:10+08:00',
  'Completed At: 2026-11-26T19:35:16+08:00',
  'Command exited with code 1.',
  '',
  'Command output:',
  'fatal: not a git repository (or any of the parent directories): .git',
].join('\n')

test('command envelope is stripped from the body', () => {
  const cleaned = cleanToolOutput('run_command', CMD_ENVELOPE)
  assert.equal(cleaned.body, 'fatal: not a git repository (or any of the parent directories): .git\n\n[exit code 1]')
  assert.equal(cleaned.exitCode, 1)
  assert.equal(cleaned.truncated, false)
})

test('a successful command keeps no exit note, a failing one does', () => {
  const ok = cleanToolOutput('run_command', CMD_ENVELOPE.replace('code 1', 'code 0'))
  assert.equal(ok.body, 'fatal: not a git repository (or any of the parent directories): .git')
  assert.equal(ok.exitCode, 0)
  assert.ok(!ok.body.includes('[exit code'))

  const failed = cleanToolOutput('run_command', CMD_ENVELOPE)
  assert.ok(failed.body.endsWith('[exit code 1]'), failed.body)
})

test('truncation preamble is dropped and the full log path is noted', () => {
  const text = [
    "The tool's output was truncated due to being too long. You can find the full output in a file at file:///C:/Users/x/.dsh/agy-accounts/acc/.gemini/antigravity-cli/brain/conv/.system_generated/steps/3/output.txt.",
    '',
    'Here is a preview with the middle of the output truncated:',
    'Created At: 2026-11-26T19:35:09+08:00',
    'Completed At: 2026-11-26T19:35:14+08:00',
    'Command exited with code 0.',
    '',
    'Command output:',
    'FullName',
    'D:\\repo\\01-literature',
  ].join('\n')
  const cleaned = cleanToolOutput('run_command', text)
  assert.equal(cleaned.truncated, true)
  assert.equal(cleaned.exitCode, 0)
  assert.equal(cleaned.body, 'FullName\nD:\\repo\\01-literature\n\n[output truncated · full log: steps/3/output.txt]')
})

test('collapsed preview no longer starts with the envelope', () => {
  const cleaned = cleanToolOutput('run_command', CMD_ENVELOPE)
  const first = cleaned.body.split('\n').find((line) => line.trim() !== '')
  assert.equal(first, 'fatal: not a git repository (or any of the parent directories): .git')
})

test('read result header and line-number gutter are removed', () => {
  const text = [
    'Created At: 2026-11-26T19:35:34+08:00',
    'Completed At: 2026-11-26T19:35:36+08:00',
    'Showing lines 1-4 of 4',
    '1: # Title',
    '2: ',
    '3: body text',
    '4: trailing',
  ].join('\n')
  const cleaned = cleanToolOutput('read_file', text)
  assert.equal(cleaned.body, '# Title\n\nbody text\ntrailing')
})

test('content that merely contains numbered lines keeps its text', () => {
  const body = 'notes\n12: not a gutter\n13: also not'
  assert.equal(stripReadGutter(body), body)
})

test('non-consecutive numbering is not treated as a gutter', () => {
  const body = '1: alpha\n5: beta\n9: gamma'
  assert.equal(stripReadGutter(body), body)
})

test('payload without an envelope is returned untouched', () => {
  const plain = 'total 12\ndrwxr-xr-x 1 user 0 Jun 1 10:00 src'
  const cleaned = cleanToolOutput('list_dir', plain)
  assert.equal(cleaned.body, plain)
  assert.equal(cleaned.truncated, false)
})

test('envelope-only results are detected', () => {
  assert.equal(isEnvelopeOnly('Created At: 2026-11-26T19:35:10+08:00\nCompleted At: 2026-11-26T19:35:16+08:00'), true)
  assert.equal(isEnvelopeOnly('Created At: 2026-11-26T19:35:10+08:00\nfile created'), false)
})

test('CRLF results are normalized before stripping', () => {
  const text = 'Created At: 2026-11-26T19:35:10+08:00\r\nCompleted At: 2026-11-26T19:35:16+08:00\r\nCommand output:\r\nok\r\n'
  assert.equal(cleanToolOutput('run_command', text).body, 'ok')
})
