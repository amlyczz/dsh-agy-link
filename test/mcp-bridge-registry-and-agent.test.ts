// Issue #55: the reverse bridge is only usable when (a) the MCP entry lands in
// the registry agy 1.4+ actually reads and (b) a bridged call carries the
// identity of the session that spawned agy.
//
// The third blocker found on a real host (0.4.72 still unusable): `svc.execute`
// was called without `exec.signal`, which DSH declares required, so every tool
// that reads it threw `Cannot read properties of undefined (reading 'aborted')`.
// The session key also arrives in two shapes - `session-<uuid>` for top-level
// web sessions and a bare `<uuid>` for sub-agent/fork sessions - and both must
// resolve without rewriting the bare form.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agyMcpConfigPath, mcpServerKey, startMcpBridge, writeMcpConfig } from '../src/host/mcp-bridge.ts'

const BRIDGE_SCRIPT = '/nonexistent/bridge.mjs'

test('agyMcpConfigPath targets the global registry agy 1.4+ reads', () => {
  assert.equal(
    agyMcpConfigPath('', { GEMINI_CLI_HOME: '/tmp/agy-home' }),
    '/tmp/agy-home/.gemini/config/mcp_config.json',
    'GEMINI_CLI_HOME drives the isolated agy home',
  )
  assert.equal(
    agyMcpConfigPath('', { HOME: '/home/dev' }),
    '/home/dev/.gemini/config/mcp_config.json',
    'HOME is the fallback',
  )
  assert.equal(
    agyMcpConfigPath('/custom/mcp.json', { HOME: '/home/dev' }),
    '/custom/mcp.json',
    'an explicit override wins',
  )
})

test('each bridge publishes under its own key and leaves foreign entries alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-registry-'))
  const file = join(dir, 'gemini', 'mcp_config.json')
  writeFileSync(join(dir, 'keep.txt'), 'x')
  try {
    const restoreA = writeMcpConfig(file, { bridgeScript: BRIDGE_SCRIPT, token: 'tk-a', url: 'http://127.0.0.1:4101', port: 4101, close: async () => undefined })
    const restoreB = writeMcpConfig(file, { bridgeScript: BRIDGE_SCRIPT, token: 'tk-b', url: 'http://127.0.0.1:4102', port: 4102, close: async () => undefined })

    const read = (): Record<string, { env?: Record<string, string> }> =>
      (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, { env?: Record<string, string> }> }).mcpServers

    const afterA = read()
    assert.equal(afterA[mcpServerKey(4101)]?.env?.DSH_MCP_URL, 'http://127.0.0.1:4101')
    assert.equal(afterA[mcpServerKey(4102)]?.env?.DSH_MCP_URL, 'http://127.0.0.1:4102')

    // Disposing one bridge while the other already rewrote the file must not
    // take the live host's entry down with it.
    restoreA()
    const afterRestoreA = read()
    assert.equal(mcpServerKey(4101) in afterRestoreA, false)
    assert.equal(afterRestoreA[mcpServerKey(4102)]?.env?.DSH_MCP_URL, 'http://127.0.0.1:4102')

    // Scope disposal is LIFO, which is what lets the last one restore the
    // original bytes: the file it created disappears entirely.
    restoreB()
    assert.equal(existsSync(file), false, 'the file we created is removed once nothing of ours remains')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeMcpConfig preserves an existing registry and its foreign servers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-registry-merge-'))
  const file = join(dir, 'mcp_config.json')
  const original = '{\n  "mcpServers": {\n    "other": {\n      "command": "other-bin"\n    }\n  },\n  "sentinel": "keep exact bytes"\n}\n'
  writeFileSync(file, original)
  try {
    const restore = writeMcpConfig(file, { bridgeScript: BRIDGE_SCRIPT, token: 'tk', url: 'http://127.0.0.1:4200', port: 4200, close: async () => undefined })
    const merged = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown>; sentinel: string }
    assert.equal(merged.sentinel, 'keep exact bytes')
    assert.ok('other' in merged.mcpServers, 'foreign servers survive the merge')
    assert.ok(mcpServerKey(4200) in merged.mcpServers)
    restore()
    assert.equal(readFileSync(file, 'utf8'), original, 'restore puts the previous bytes back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bridged call carries the agent of the spawning session', async () => {
  const received: Array<{ name: string; agent?: unknown }> = []
  const tools = {
    schemas: () => [
      { name: 'agent_teams_status', description: 'status', parameters: { type: 'object', properties: {} } },
    ],
    execute: async (input: { name: string; agent?: unknown; signal: AbortSignal }) => {
      // DSH tools read `exec.signal`; a call without one throws inside the tool.
      assert.ok(input.signal instanceof AbortSignal, 'bridged calls must carry an abort signal')
      assert.equal(input.signal.aborted, false)
      received.push({ name: input.name, agent: input.agent })
      if (input.agent === undefined) throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
      return { content: [{ type: 'text', text: 'ok:' + String((input.agent as { id?: string }).id) }] }
    },
  }
  const bridge = await startMcpBridge({
    bridgeScript: BRIDGE_SCRIPT,
    tools: () => tools,
    allowlist: () => 'agent_teams_status',
    resolveAgent: (sessionId) => (sessionId === 'session-42' ? { id: 'agent-42', session: sessionId } : undefined),
  })
  try {
    const call = async (headers: Record<string, string>) => {
      const res = await fetch(bridge.url + '/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, ...headers },
        body: JSON.stringify({ dshName: 'agent_teams_status', arguments: {} }),
      })
      return (await res.json()) as { ok: boolean; text?: string; error?: string }
    }

    // agy hands its env to the MCP server, so a run started by session-42
    // reaches the host with that session in the header.
    const ok = await call({ 'X-DSH-Session': 'session-42' })
    assert.equal(ok.ok, true)
    assert.equal(ok.text, 'ok:agent-42')
    assert.deepEqual(received.at(-1)?.agent, { id: 'agent-42', session: 'session-42' })

    // Unknown session: no agent, and the tool's own guard rejects the call.
    const anonymous = await call({})
    assert.equal(anonymous.ok, false)
    assert.match(String(anonymous.error), /require a calling agent/)
    assert.equal(received.at(-1)?.agent, undefined)
  } finally {
    await bridge.close()
  }
})

test('both DSH session key forms resolve without rewriting a bare id', async () => {
  const lookups: string[] = []
  const seen: Array<unknown> = []
  // DSH registers `session-<uuid>` for top-level web sessions and the bare
  // `<uuid>` for sub-agent/fork sessions. Switch which form is registered to
  // exercise both directions against one bridge.
  let registered = new Set<string>()
  const tools = {
    schemas: () => [
      { name: 'agent_teams_status', description: 'status', parameters: { type: 'object', properties: {} } },
    ],
    execute: async (input: { name: string; agent?: unknown; signal: AbortSignal }) => {
      assert.ok(input.signal instanceof AbortSignal, 'bridged calls must carry an abort signal')
      // Mirror the real tools: no caller -> the tool itself rejects the call.
      if (input.agent === undefined) throw new Error('agent_teams tools require a calling agent (exec.agent was undefined)')
      seen.push(input.agent)
      return { content: [{ type: 'text', text: 'ok:' + String((input.agent as { id?: string }).id) }] }
    },
  }
  const bridge = await startMcpBridge({
    bridgeScript: BRIDGE_SCRIPT,
    tools: () => tools,
    allowlist: () => 'agent_teams_status',
    resolveAgent: (sessionId) => {
      lookups.push(sessionId)
      return registered.has(sessionId) ? { id: 'agent:' + sessionId, session: sessionId } : undefined
    },
  })
  try {
    const call = async (headers: Record<string, string>) => {
      const res = await fetch(bridge.url + '/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, ...headers },
        body: JSON.stringify({ dshName: 'agent_teams_status', arguments: {} }),
      })
      return (await res.json()) as { ok: boolean; text?: string; error?: string }
    }

    // 1. A bare uuid a sub-agent/fork session is registered under: the value
    //    resolves as given, so the prefix retry must NOT run (rewriting it
    //    would break that session's identity).
    registered = new Set(['313ce201'])
    lookups.length = 0
    const direct = await call({ 'X-DSH-Session': '313ce201' })
    assert.equal(direct.ok, true)
    assert.equal(direct.text, 'ok:agent:313ce201')
    assert.deepEqual(lookups, ['313ce201'], 'a resolvable bare id must not be retried with the prefix')
    assert.deepEqual(seen.at(-1), { id: 'agent:313ce201', session: '313ce201' })

    // 2. Only the prefixed form registered (top-level web session reaching us
    //    with the bare uuid): raw misses, then `session-` + raw resolves.
    registered = new Set(['session-313ce201'])
    lookups.length = 0
    const fallback = await call({ 'X-DSH-Session': '313ce201' })
    assert.equal(fallback.ok, true)
    assert.equal(fallback.text, 'ok:agent:session-313ce201')
    assert.deepEqual(lookups, ['313ce201', 'session-313ce201'], 'raw id first, then the session- prefix')
    assert.deepEqual(seen.at(-1), { id: 'agent:session-313ce201', session: 'session-313ce201' })

    // 3. An already-prefixed id resolves on the first try and is never
    //    prefixed twice (`session-session-...`).
    lookups.length = 0
    const canonical = await call({ 'X-DSH-Session': 'session-313ce201' })
    assert.equal(canonical.ok, true)
    assert.deepEqual(lookups, ['session-313ce201'])

    // 4. An unknown id is retried exactly once and then still surfaces the
    //    tool's own guard.
    registered = new Set()
    lookups.length = 0
    const unknown = await call({ 'X-DSH-Session': 'deadbeef' })
    assert.equal(unknown.ok, false)
    assert.match(String(unknown.error), /require a calling agent/)
    assert.deepEqual(lookups, ['deadbeef', 'session-deadbeef'])
  } finally {
    await bridge.close()
  }
})
