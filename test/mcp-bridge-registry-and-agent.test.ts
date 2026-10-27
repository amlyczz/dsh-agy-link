// Issue #55: the reverse bridge is only usable when (a) the MCP entry lands in
// the registry agy 1.4+ actually reads and (b) a bridged call carries the
// identity of the session that spawned agy.
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
    join('/tmp/agy-home', '.gemini', 'config', 'mcp_config.json'),
    'GEMINI_CLI_HOME drives the isolated agy home',
  )
  assert.equal(
    agyMcpConfigPath('', { HOME: '/home/dev' }),
    join('/home/dev', '.gemini', 'config', 'mcp_config.json'),
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
    execute: async (input: { name: string; agent?: unknown }) => {
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
