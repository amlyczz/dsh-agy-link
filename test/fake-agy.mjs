#!/usr/bin/env node
// Fake agy CLI for offline tests. Modes via FAKE_AGY_MODE env:
//   ok | auth | noise | exit12 | real | real-error
//   ok            — legacy flat event shapes (kept for compat coverage)
//   real          — real agy 1.1.15 stream-json shapes (nested step_update
//                   envelopes, agent_response text_delta fragments,
//                   thinking-only turns, tool ACTIVE/DONE/ERROR)
//   real-error    — same as real, but the result envelope carries
//                   status=ERROR together with a usable response
// Records its argv (JSON) to FAKE_AGY_ARGS_FILE when set.
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_AGY_MODE ?? 'ok'
if (process.env.FAKE_AGY_ARGS_FILE) {
  try { writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv)) } catch {}
}
if (process.env.FAKE_AGY_CWD_FILE) {
  try { writeFileSync(process.env.FAKE_AGY_CWD_FILE, process.cwd()) } catch {}
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
} else if (mode === 'real' || mode === 'real-error' || mode === 'real-fail') {
  // Shapes captured from a live agy 1.1.15 binary
  // (`--output-format stream-json --mode plan --model ... --effort ...`).
  emit({ event: 'init', conversation_id: conv, init: { model: 'gemini-3-7-flash', cwd: '/tmp', tools: ['run_command', 'read_file'] } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'DONE', step_type: 'checkpoint', duration_seconds: 0.1 } })
  // thinking-only turn: usage with thinking tokens, no text_delta
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'DONE', step_type: 'agent_response', duration_seconds: 1.2, usage: { input_tokens: 500, output_tokens: 40, thinking_tokens: 80, total_tokens: 540 } } })
  // tool call: ACTIVE announces parameters, DONE carries output
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 3, state: 'DONE', step_type: 'tool', duration_seconds: 0.3, tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' }, output: 'note1.txt\nnote2.txt\n' } } })
  // failed tool call: state ERROR with tool_info.error
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'find_by_name', tool_info: { name: 'find_by_name', parameters: { Pattern: 'note*.txt' } } } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 4, state: 'ERROR', step_type: 'tool', duration_seconds: 30, tool_name: 'find_by_name', tool_info: { name: 'find_by_name', parameters: { Pattern: 'note*.txt' }, error: { type: 'TOOL_ERROR', message: 'Find command timed out.' } } } })
  // streamed answer: sequential text_delta fragments across ACTIVE -> DONE
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'There are ' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: '2 files, ' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '6 words total.', duration_seconds: 2, usage: { input_tokens: 900, output_tokens: 60, thinking_tokens: 15, cache_read_tokens: 200, total_tokens: 960 } } })
  if (mode === 'real-fail') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'model overloaded', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'real') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'There are 2 files, 6 words total.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
  } else {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: 'There are 2 files, 6 words total.', error: 'Find command timed out. Use a more targeted search directory or pattern.: context deadline exceeded', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
  }
  process.exit(0)
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
