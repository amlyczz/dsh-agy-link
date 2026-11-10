#!/usr/bin/env node
// Fake agy CLI for offline tests. Modes via FAKE_AGY_MODE env:
//   ok | auth | auth-network | noise | exit12 | exit-error | real | real-error | real-quota
//   real-fail (soft capacity) | real-bare (deterministic bare result error)
//   quota-once (account-scoped failure on the FIRST invocation only, then succeeds)
//   location-denied — result envelope with the real "User location is not supported" refusal, exit 3
//   effort-unsupported — issue #67: refuses `--effort` for the named model with
//                   exit 1, and answers normally when the effort is absent
//   ok            — legacy flat event shapes (kept for compat coverage)
//   real          — real agy 1.1.15 stream-json shapes (nested step_update
//                   envelopes, agent_response text_delta fragments,
//                   thinking-only turns, tool ACTIVE/DONE/ERROR)
//   real-error    — same as real, but the result envelope carries
//                   status=ERROR together with a usable response
//   exit-error    — stdout error envelope + exit 1 + empty stderr (the real
//                   silent-failure shape that hid causes behind "exited 1")
// Records its argv (JSON) to FAKE_AGY_ARGS_FILE when set.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_AGY_MODE ?? 'ok'
/** How many times this fake has run (used by fail-then-succeed modes). */
let invocation = 0
if (process.env.FAKE_AGY_INVOCATION_FILE) {
  try {
    const f = process.env.FAKE_AGY_INVOCATION_FILE
    const prev = existsSync(f) ? readFileSync(f, 'utf8') : ''
    invocation = prev.split('\n').filter(Boolean).length
    writeFileSync(f, prev + 'x\n')
  } catch { /* counting is best-effort */ }
}
if (process.env.FAKE_AGY_ARGS_FILE) {
  try { writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv)) } catch {}
}
if (process.env.FAKE_AGY_ENV_FILE) {
  try {
    writeFileSync(process.env.FAKE_AGY_ENV_FILE, JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
    }))
  } catch { /* recording is best-effort */ }
}
if (process.env.FAKE_AGY_CWD_FILE) {
  try { writeFileSync(process.env.FAKE_AGY_CWD_FILE, process.cwd()) } catch {}
}
// Capture stdin for long-prompt transport tests (issue #14/#11).
if (process.env.FAKE_AGY_STDIN_FILE) {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => { buf += d })
  process.stdin.on('end', () => {
    try { writeFileSync(process.env.FAKE_AGY_STDIN_FILE, buf) } catch {}
  })
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

// Issue #92: a self-driving turn that keeps emitting events forever. The idle
// watchdog is re-armed by every line, so only the wall-clock maxTurnMinutes cap
// can stop it. Exits on SIGTERM (what killTree sends first).
if (mode === 'hang') {
  process.on('SIGTERM', () => process.exit(143))
  let i = 0
  const timer = setInterval(() => {
    emit({
      event: 'step_update',
      step_update: { step_type: 'tool', status: 'ACTIVE', step_id: 'task-' + i, tool_name: 'run_command' },
    })
    i++
  }, 50)
  await new Promise(() => {})
  clearInterval(timer)
}

// Real location refusal observed live: agy exits 3 after a result envelope
// carrying FAILED_PRECONDITION (code 400).
if (mode === 'location-denied') {
  emit({
    event: 'result',
    result: {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
      duration_seconds: 0.4,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  process.exit(3)
}

// Issue #67: agy refuses the WHOLE invocation when `--effort` is passed to a
// model that does not accept one (agy 1.4.6 on Windows, model gemini-3.8-flash).
// The refusal carries the exact model id, and a run WITHOUT --effort succeeds —
// that is what the adapter has to learn from.
if (mode === 'effort-unsupported') {
  const at = argv.indexOf('--effort')
  if (at >= 0) {
    const effort = argv[at + 1] ?? ''
    const modelAt = argv.indexOf('--model')
    const model = modelAt >= 0 ? (argv[modelAt + 1] ?? '') : ''
    emit({
      event: 'result',
      result: {
        conversation_id: '',
        status: 'ERROR',
        response: '',
        error: 'invalid model selection (--model "' + model + '" --effort "' + effort + '"): --effort is not supported for model "' + model + '"',
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    process.exit(1)
  }
  // Without --effort the SAME call succeeds. Text-only steps (no tool step), so
  // the span ends as a plain `stop` and the test can tell a replay from a
  // tool-continuation.
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3.8-flash' })
  emit({ event: 'step_update', idx: 1, step_type: 'text', text: 'answered' })
  emit({ event: 'step_update', idx: 1, step_type: 'text', text: 'answered without --effort' })
  emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'answered without --effort', duration_seconds: 1, num_turns: 1, usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } } })
  process.exit(0)
}

// Google-side account/region eligibility refusal (issue #32).
if (mode === 'exit-eligible') {
  emit({
    event: 'result',
    result: {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'Eligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location.',
      duration_seconds: 0.4,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  process.exit(1)
}

// "Eligibility check failed:" wrapping a pure TRANSPORT error (observed live:
// "failed to get profile picture: … net/http: TLS handshake timeout"). Not a
// region refusal — must classify as NETWORK, not ELIGIBILITY.
if (mode === 'exit-eligible-network') {
  emit({
    event: 'result',
    result: {
      conversation_id: '',
      status: 'ERROR',
      response: '',
      error: 'Eligibility check failed: failed to get profile picture: Get "https://lh3.googleusercontent.com/a/ACg8ocMec37sVbokmmQmoQfiAxrgAt_t2vTgleK30Fa8qMMWfA=s96-c": net/http: TLS handshake timeout',
      duration_seconds: 0.4,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  process.exit(1)
}

// Real failure shape seen in the wild (silent server-side errors): agy
// writes ONLY a result envelope with a human-readable error to stdout and
// exits 1 with empty stderr. Used to regress the bare "exited with code 1"
// message that hid the actual cause.
if (mode === 'exit-error') {
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'upstream request failed while generating (request id 8f3ac2)', duration_seconds: 8.2, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } } })
  process.exit(1)
}

await sleep(Number(process.env.FAKE_AGY_DELAY_MS ?? 0))

if (mode === 'auth') {
  process.stderr.write('Please sign in. Visit https://accounts.google.com/o/oauth2/auth?access_type=offline&code=4/AbCdEf123 to authenticate, then paste the authorization code.\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'authentication failed or timed out' } })
  process.exit(0)
}

// Auth-shaped refusal wrapped in a TRANSPORT failure — the live 2026-10-10
// shape: the stored token could not be validated because the token endpoint
// died, so agy reports "not logged into Antigravity" for a healthy login.
if (mode === 'auth-network') {
  process.stderr.write('Print mode: token validation failed due to network error (token may still be valid): Post "https://oauth2.googleapis.com/token": EOF\n')
  process.stdout.write('Print mode: silent auth failed\n')
  process.stdout.write('Please sign in\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'You are not logged into Antigravity.' } })
  process.exit(1)
}

// Auth-shaped refusal whose agy log proves a STORED credential could not be
// validated over the network (keyring auth missed its 10s window). The stderr
// banner is byte-identical to a real sign-out; only the log separates them —
// this is the exact shape that sticky-quarantined three healthy accounts on
// 2026-10-16.
if (mode === 'auth-jitter') {
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) {
    try {
      const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, `cli-${Date.now()}.log`), [
        'I1016 17:29:16.281503       1 printmode.go:403] Print mode: not authenticated, trying silent auth',
        'I1016 17:29:16.708947     291 keyring.go:64] keyringAuth: loaded token, expiry=2026-10-16 09:38:48.745 +0000 UTC expired=false',
        'W1016 17:29:26.284604       1 keyring.go:111] keyringAuth: timed out after 10s, skipping keyring auth',
        'I1016 17:29:26.284725       1 printmode.go:409] Print mode: silent auth failed',
      ].join('\n'))
    } catch { /* evidence is best-effort in a fake */ }
  }
  process.stderr.write('Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline\nError: authentication timed out.\n')
  emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: 'You are not logged into Antigravity.' } })
  process.exit(1)
}

// Streams its conversation id, then stays busy long enough for a caller to
// abort mid-flight (interrupted-turn bookkeeping tests).
if (mode === 'slow-init') {
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'working' } })
  await sleep(Number(process.env.FAKE_AGY_DELAY_MS ?? 200))
  emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'late answer', duration_seconds: 2, num_turns: 1, usage: { input_tokens: 10, output_tokens: 2 } } })
  process.exit(0)
}

if (mode === 'noise') {
  process.stdout.write('\u26a0 fetching model catalog\n')
  emit({ event: 'init', conversation_id: conv, model: 'gemini-3-6-flash' })
  process.stdout.write('some progress noise\n')
} else if (mode === 'real' || mode === 'real-error' || mode === 'real-denied' || mode === 'real-fail' || mode === 'real-quota' || mode === 'real-bare' || mode === 'quota-once') {
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
  const toolError = mode === 'real-denied'
    ? 'Permission denied automatically in headless plan mode: read_file ~/.agents'
    : 'Find command timed out.'
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 4, state: 'ERROR', step_type: 'tool', duration_seconds: 30, tool_name: 'find_by_name', tool_info: { name: 'find_by_name', parameters: { Pattern: 'note*.txt' }, error: { type: 'TOOL_ERROR', message: toolError } } } })
  // AGY 1.2.2 can report SUCCESS and no final text despite a failed tool.
  // This synthetic envelope mirrors that shape without private session data.
  if (mode === 'real-denied') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: '', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
    process.exit(0)
  }
  // streamed answer: sequential text_delta fragments across ACTIVE -> DONE
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'There are ' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: '2 files, ' } })
  emit({ event: 'step_update', step_update: { conversation_id: conv, step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '6 words total.', duration_seconds: 2, usage: { input_tokens: 900, output_tokens: 60, thinking_tokens: 15, cache_read_tokens: 200, total_tokens: 960 } } })
  if (mode === 'real-quota') {
    // Real server hard-quota refusal (observed live): the account is spent, so
    // the adapter must cool it down and let the retry use another account.
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h54m14s.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'quota-once' && invocation === 0) {
    // First invocation spends the account AFTER a tool step, so the failure
    // surfaces in a tool-continuation span (the shape that used to replay the
    // dead recording instead of failing over). Later invocations succeed.
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h54m14s.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'real-bare') {
    // Bare result error with NO response — must still surface a diagnosable
    // code (not a bare "exited 1"), and it is NOT account-scoped.
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'upstream request failed while generating (request id 8f3ac2)', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'real-fail') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: '', error: 'model overloaded', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 100, output_tokens: 0 } } })
  } else if (mode === 'real') {
    emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'There are 2 files, 6 words total.', duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
  } else if (mode === 'quota-once') {
    // Second and later invocations: the account that survived the failover
    // answers normally.
    emit({ event: 'result', result: { conversation_id: conv, status: 'DONE', response: 'answered after failover', duration_seconds: 2, num_turns: 1, usage: { input_tokens: 700, output_tokens: 40, total_tokens: 740 } } })
  } else {
    emit({ event: 'result', result: { conversation_id: conv, status: 'ERROR', response: 'There are 2 files, 6 words total.', error: toolError, duration_seconds: 5, num_turns: 1, usage: { input_tokens: 900, output_tokens: 100, thinking_tokens: 95, cache_read_tokens: 200, total_tokens: 1000 } } })
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
