#!/usr/bin/env node
// Fake agy CLI for offline tests. Modes via FAKE_AGY_MODE env:
//   ok | auth | noise | exit12
// Records its argv (JSON) to FAKE_AGY_ARGS_FILE when set.
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_AGY_MODE ?? 'ok'
if (process.env.FAKE_AGY_ARGS_FILE) {
  try { writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv)) } catch {}
}

if (argv[0] === '--version') {
  process.stdout.write('agy version 1.1.13-fake\n')
  process.exit(0)
}
if (argv[0] === 'models') {
  if (process.env.FAKE_AGY_MODELS === 'text') {
    process.stdout.write('gemini-3-6-flash    Gemini 3.6 Flash\ngemini-3-6-flash-high    Gemini 3.6 Flash High\nclaude-sonnet-4-6    Claude Sonnet 4.6\n')
  } else if (process.env.FAKE_AGY_MODELS === 'fail') {
    process.stderr.write('Error: Please sign in\n')
    process.exit(1)
  } else {
    process.stdout.write(JSON.stringify([
      { id: 'gemini-3-6-flash', display_name: 'Gemini 3.6 Flash' },
      { id: 'gemini-3-6-flash-high', display_name: 'Gemini 3.6 Flash High' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    ]))
  }
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

const conv = argv.includes('--conversation')
  ? argv[argv.indexOf('--conversation') + 1]
  : 'conv-fresh-1'

if (mode === 'exit12') {
  process.stderr.write('boom: fake crash\n')
  process.exit(12)
}

await sleep(Number(process.env.FAKE_AGY_DELAY_MS ?? 0))

if (mode === 'auth') {
  process.stderr.write('Please sign in. Visit https://accounts.google.com/o/oauth2/auth?access_type=offline&code=4/AbCdEf123 to authenticate, then paste the authorization code.\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'authentication failed or timed out' } })
  process.exit(0)
}

if (mode === 'noise') {
  process.stdout.write('\u26a0 fetching model catalog\n')
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
  process.stdout.write('some progress noise\n')
} else {
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
}

emit({ event: 'step_update', idx: 1, step_type: 'thinking', text: 'Thinking...' })
emit({ event: 'step_update', idx: 1, step_type: 'thinking', text: 'Thinking... carefully' })
emit({ event: 'step_update', idx: 2, step_type: 'tool', tool_info: { name: 'read_file', parameters: { path: '/tmp/x' } } })
emit({ event: 'step_update', idx: 2, step_type: 'tool', tool_info: { name: 'read_file', parameters: { path: '/tmp/x' }, output: 'file contents here' } })
emit({ event: 'step_update', idx: 3, step_type: 'text', text: 'Hello' })
emit({ event: 'step_update', idx: 3, step_type: 'text', text: 'Hello from fake agy' })
emit({
  event: 'result',
  result: {
    conversation_id: conv,
    status: 'DONE',
    response: 'Hello from fake agy',
    usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 3 },
  },
})
process.exit(0)
