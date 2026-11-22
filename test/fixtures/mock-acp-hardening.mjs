// Minimal `agy acp` stand-in for the ACP hardening tests.
//
// `session/resume` fails and `session/load` "succeeds" without replaying
// anything — exactly the silent-failure shape the real binary shows for an id
// it cannot restore. MOCK_ACP_MODE selects the prompt behaviour:
//   chat        -> one agent_message_chunk, then a normal end_turn
//   empty-proxy -> writes a proxy/network error to --log-file, empty end_turn
//   empty-auth  -> writes an auth error to --log-file, empty end_turn
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.MOCK_ACP_MODE ?? 'chat'
const argv = process.argv.slice(2)
const logIdx = argv.indexOf('--log-file')
const logFile = logIdx >= 0 ? argv[logIdx + 1] : ''
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let closed = false

function send(obj) {
  if (!closed) process.stdout.write(JSON.stringify(obj) + '\n')
}

function note(line) {
  if (!logFile) return
  try { appendFileSync(logFile, line + '\n') } catch { /* the probe reads what it can */ }
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }

  if (msg.method === 'initialize') {
    // Gate 2 reads the identity agy resolves, exactly like the real binary.
    if (process.env.MOCK_ACP_EMAIL) note('applyAuthResult: email=' + process.env.MOCK_ACP_EMAIL + ', authMethod=consumer')
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })
    return
  }
  if (msg.method === 'session/resume') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'resume failed' } })
    return
  }
  if (msg.method === 'session/load') {
    // No replay at all: the id does not exist and agy still reports success.
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } })
    return
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-new' } })
    return
  }
  if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    return
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId
    if (mode === 'empty-proxy') {
      note('proxyconnect tcp: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.')
      note('failed to construct executor: plan model not specified')
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (mode === 'banner') {
      // The real binary's unreachable-upstream shape: agy prints its own failure
      // banner as the only message and closes the turn normally.
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ failed to construct executor: plan model not specified; you must specify a valid model\n' } } } })
      note('proxyconnect tcp: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.')
      note('failed to construct executor: plan model not specified')
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (mode === 'empty-auth') {
      note('oauth: authentication required before the model can be called')
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 1 } } })
  }
})

rl.on('close', () => {
  closed = true
  process.exit(0)
})