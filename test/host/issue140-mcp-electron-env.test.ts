// Regression tests for issue #140: on the DSH desktop build `process.execPath`
// is the Electron binary, so Antigravity launching our stdio MCP server span up
// a second Electron instance — its window stole focus on every start. Setting
// ELECTRON_RUN_AS_NODE=1 makes that same binary behave as plain Node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpServerEntry } from '../../src/host/mcp-bridge.ts'

const bridge = { url: 'http://127.0.0.1:1234', token: 't', port: 1234, bridgeScript: '/app/bridge.mjs' }

test('issue #140: an Electron host runs the bridge as Node instead of opening a window', () => {
  const entry = mcpServerEntry(bridge as never, '/Applications/DSH.app/Contents/MacOS/DSH', true) as {
    command: string
    env: Record<string, string>
  }
  assert.equal(entry.command, '/Applications/DSH.app/Contents/MacOS/DSH')
  assert.equal(entry.env.ELECTRON_RUN_AS_NODE, '1')
  // The existing contract is untouched.
  assert.equal(entry.env.DSH_MCP_URL, bridge.url)
  assert.equal(entry.env.DSH_MCP_TOKEN, bridge.token)
  assert.ok(entry.env.DSH_MCP_PID)
})

test('issue #140: a plain Node host gets no Electron-specific variable', () => {
  const entry = mcpServerEntry(bridge as never, '/usr/local/bin/node', false) as { env: Record<string, string> }
  assert.equal('ELECTRON_RUN_AS_NODE' in entry.env, false)
  assert.equal(entry.env.DSH_MCP_URL, bridge.url)
})
