// MCP bridge wiring reachable through the HTTP surface.
//
// Pins /pool/add publishing the bridge config into the new account home and the
// idempotent registerBridgeMcpConfig hook that /config relies on.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeReq, invoke, poolDouble, setup } from './http-contract-helpers.ts'

test('/pool/add publishes the bridge MCP config into the account home when a bridge is active', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-contract-add-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bridge = { port: 4321, bridgeScript: '/tmp/bridge.mjs', url: 'http://127.0.0.1:4321', token: 'secret', close: async () => undefined }
  const pool = poolDouble({ createAccountSlot: () => ({ id: 'acc-x', dir }) })
  const s = setup({
    pool: pool.pool,
    bridgeState: { bridge, restores: [] as Array<() => void> },
  }, { mcpConfigScope: 'global' })

  const captured = await invoke(s.route('/plugins/agy-link/pool/add'), fakeReq('POST', '/', { autoOpenTerminal: false }))
  assert.equal(captured.status(), 200)
  const registered = s.services.bridgeState as unknown as { restores: Array<() => void> }
  assert.equal(registered.restores.length, 1, 'a restore hook is recorded for the new account home')
  const configFile = join(dir, '.gemini', 'config', 'mcp_config.json')
  assert.ok(existsSync(configFile), 'mcp config written under the account home')
  assert.match(readFileSync(configFile, 'utf8'), /mcpServers/)
})

test('/config validates permissionMode enum and registerBridgeMcpConfig is idempotent', async () => {
  const s = setup()
  const route = s.route('/plugins/agy-link/config')
  const badMode = await invoke(route, fakeReq('POST', '/', { key: 'permissionMode', value: 'yolo' }))
  assert.equal(badMode.status(), 400)
  assert.match((badMode.json() as { error?: string }).error ?? '', /permissionMode/)

  const goodMode = await invoke(route, fakeReq('POST', '/', { key: 'permissionMode', value: 'accept-edits' }))
  assert.equal(goodMode.status(), 200)

  const { startMcpBridge, registerBridgeMcpConfig, teardownBridgeState } = await import('../../src/host/mcp-bridge.ts')
  const dir = mkdtempSync(join(tmpdir(), 'agy-mcp-idem-'))
  try {
    const bridge = await startMcpBridge({ bridgeScript: 'fake-bridge.mjs', tools: () => undefined, allowlist: () => '' })
    const cfgFile = join(dir, 'mcp_config.json')
    const state = { bridge, restores: [] as Array<() => void> }
    registerBridgeMcpConfig(state, cfgFile)
    registerBridgeMcpConfig(state, cfgFile)
    assert.equal(state.restores.length, 1, 'registerBridgeMcpConfig must not duplicate restores for the same file')
    teardownBridgeState(state)
    assert.equal(state.bridge, null)
    assert.equal(state.restores.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
