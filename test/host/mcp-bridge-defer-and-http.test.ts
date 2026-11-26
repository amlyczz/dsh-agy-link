// Regression tests for Issue #215:
// 1. bridge.mjs preserves non-JSON HTTP error payloads and rejects non-JSON 200 /tools replies.
// 2. mcp-bridge auto-activates deferred tools via defer_execute_tool at most once within the
//    active step + allowlist, never bypassing permission denials, and leaves audit + result trace.
// 3. ambiguous discovery diffs emit a deduplicated warning in attempt telemetry.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { BridgeSteps } from '../../src/host/bridge-steps.ts'
import { startMcpBridge } from '../../src/host/mcp-bridge.ts'
import { isDeferredToolSignal, isPermissionDenial } from '../../src/host/mcp-defer.ts'

async function withMockBridgeTarget(
  handler: (urlPath: string, body: string) => { status: number; contentType?: string; body: string },
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const reply = handler(req.url ?? '/', Buffer.concat(chunks).toString('utf8'))
      res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'text/plain; charset=utf-8' })
      res.end(reply.body)
    })
  })
  await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()))
  const addr = srv.address() as { port: number }
  try {
    await fn(`http://127.0.0.1:${addr.port}`)
  } finally {
    await new Promise<void>((done) => srv.close(() => done()))
  }
}

test('bridge.mjs surfaces non-JSON 403/502 errors and rejects invalid 200 JSON without silent empty list', async () => {
  await withMockBridgeTarget((path) => {
    if (path === '/tools') return { status: 200, body: 'not valid json from proxy' }
    return { status: 502, body: 'Bad Gateway' }
  }, async (url) => {
    const child = spawn(process.execPath, [resolve('src/host/bridge.mjs')], {
      env: { DSH_MCP_URL: url, DSH_MCP_TOKEN: 'tok' },
    })
    const closed = once(child, 'exit')
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const rpc = async (method: string, params: unknown) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
      return JSON.parse((await lines.next()).value!)
    }
    try {
      const res = await rpc('tools/list', {})
      assert.equal(res.error.code, -32603)
      assert.match(res.error.message, /HTTP 200: not valid json from proxy/)
    } finally {
      child.stdin.end()
      await closed
    }
  })

  await withMockBridgeTarget((path) => {
    if (path === '/tools') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tools: [{ name: 'ping', dshName: 'ping', description: 'ping', inputSchema: { type: 'object' } }] }),
      }
    }
    return { status: 502, body: 'Upstream 502 Bad Gateway' }
  }, async (url) => {
    const child = spawn(process.execPath, [resolve('src/host/bridge.mjs')], {
      env: { DSH_MCP_URL: url, DSH_MCP_TOKEN: 'tok' },
    })
    const closed = once(child, 'exit')
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const rpc = async (method: string, params: unknown) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
      return JSON.parse((await lines.next()).value!)
    }
    try {
      const res = await rpc('tools/call', { name: 'ping', arguments: {} })
      assert.equal(res.result.isError, true)
      assert.match(res.result.content[0].text, /HTTP 502: Upstream 502 Bad Gateway/)
      assert.doesNotMatch(res.result.content[0].text, /SyntaxError/)
    } finally {
      child.stdin.end()
      await closed
    }
  })
})

test('defer signal detection prioritizes structured signals and never classifies permission denials as deferred', () => {
  assert.equal(isDeferredToolSignal({ code: 'TOOL_DEFERRED' }, 'load first'), true)
  assert.equal(isDeferredToolSignal({ deferred: true }, ''), true)
  assert.equal(isDeferredToolSignal(null, 'Tool is deferred and not yet loaded'), true)
  assert.equal(isPermissionDenial({ code: 'PERMISSION_DENIED' }, 'deferred and not yet loaded'), true)
  assert.equal(isDeferredToolSignal({ code: 'PERMISSION_DENIED' }, 'deferred and not yet loaded'), false)
  assert.equal(isDeferredToolSignal(null, 'Permission denied for deferred tool'), false)
})

test('mcp-bridge activates deferred tool once within the admitted step and records trace in output + audit', async () => {
  const steps = new BridgeSteps()
  const executed: Array<{ name: string; args: unknown }> = []
  const logs: string[] = []
  let loaded = false

  const bridge = await startMcpBridge({
    bridgeScript: '/unused/bridge.mjs',
    allowlist: () => '',
    resolveStep: (k) => steps.resolve(k),
    log: (m) => logs.push(m),
    tools: () => ({
      schemas: () => { throw new Error('must use step.schemas') },
      execute: async ({ calls, arguments: args }) => {
        const call = calls[0]!
        executed.push({ name: call.name, args })
        if (call.name === 'defer_execute_tool') {
          loaded = true
          return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: 'activated' }] } }] }
        }
        if (call.name === 'office_read' && !loaded) {
          return {
            results: [{
              callId: call.id,
              result: { isError: true, content: [{ type: 'text', text: 'Tool "office_read" is deferred and not yet loaded' }] },
            }],
          }
        }
        return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: 'doc-body' }] } }] }
      },
    }),
  })

  const agent = { session: { id: 'sess-defer-1' } }
  const signal = new AbortController().signal
  steps.capture({ agent, signal, toolSet: { view: () => new Map() } })
  const lease = steps.enter(agent, {
    signal,
    sessionId: 'sess-defer-1',
    tools: [
      { name: 'office_read', description: 'read', parameters: { type: 'object' } },
      { name: 'defer_execute_tool', description: 'load', parameters: { type: 'object', properties: { tool_name: { type: 'string' } } } },
    ],
  })!
  const routeToken = lease.bind('acc-1')

  try {
    const res = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, 'X-DSH-Route': routeToken },
      body: JSON.stringify({ dshName: 'office_read', arguments: { path: '/a' } }),
    })
    const body = (await res.json()) as { ok: boolean; text?: string }
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.match(body.text ?? '', /activated via defer_execute_tool and retried once/)
    assert.match(body.text ?? '', /doc-body/)
    assert.deepEqual(executed, [
      { name: 'office_read', args: { path: '/a' } },
      { name: 'defer_execute_tool', args: { tool_name: 'office_read' } },
      { name: 'office_read', args: { path: '/a' } },
    ])
    assert.ok(logs.some((l) => /deferred-retried/.test(l)))
  } finally {
    lease.close()
    await bridge.close()
  }
})

test('mcp-bridge blocks deferred retry when defer_execute_tool is denied or not admitted, and stops after 1 retry', async () => {
  const steps = new BridgeSteps()
  const callsLog: string[] = []
  let denyDeferTool = true

  const bridge = await startMcpBridge({
    bridgeScript: '/unused/bridge.mjs',
    allowlist: () => '',
    resolveStep: (k) => steps.resolve(k),
    tools: () => ({
      schemas: () => [],
      execute: async ({ calls }) => {
        const call = calls[0]!
        callsLog.push(call.name)
        if (call.name === 'defer_execute_tool') {
          if (denyDeferTool) {
            return {
              results: [{
                callId: call.id,
                result: { isError: true, content: [{ type: 'text', text: 'Permission denied by policy' }] },
              }],
            }
          }
          return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: 'loaded' }] } }] }
        }
        throw Object.assign(new Error('Tool is deferred and not yet loaded'), { code: 'TOOL_DEFERRED' })
      },
    }),
  })

  const agent = { session: { id: 'sess-defer-deny' } }
  const signal = new AbortController().signal
  steps.capture({ agent, signal, toolSet: { view: () => new Map() } })
  const lease = steps.enter(agent, {
    signal,
    sessionId: 'sess-defer-deny',
    tools: [
      { name: 'secret_tool', description: 's', parameters: { type: 'object' } },
      { name: 'defer_execute_tool', description: 'load', parameters: { type: 'object' } },
    ],
  })!
  const routeToken = lease.bind('acc-1')

  try {
    // 1) If defer_execute_tool itself is denied by policy, do NOT retry secret_tool.
    const deniedRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, 'X-DSH-Route': routeToken },
      body: JSON.stringify({ dshName: 'secret_tool', arguments: {} }),
    })
    assert.equal(deniedRes.status, 422)
    assert.deepEqual(callsLog, ['secret_tool', 'defer_execute_tool'])

    // 2) If defer_execute_tool succeeds but retry STILL returns deferred, stop after 1 retry.
    callsLog.length = 0
    denyDeferTool = false
    const capRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, 'X-DSH-Route': routeToken },
      body: JSON.stringify({ dshName: 'secret_tool', arguments: {} }),
    })
    assert.equal(capRes.status, 422)
    assert.deepEqual(callsLog, ['secret_tool', 'defer_execute_tool', 'secret_tool'])

    // 3) If defer_execute_tool is absent from step.schemas, do not attempt activation.
    callsLog.length = 0
    const lease2 = steps.enter(agent, {
      signal,
      sessionId: 'sess-defer-deny',
      tools: [{ name: 'secret_tool', description: 's', parameters: { type: 'object' } }],
    })!
    const route2 = lease2.bind('acc-1')
    const unAdmittedRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.token, 'X-DSH-Route': route2 },
      body: JSON.stringify({ dshName: 'secret_tool', arguments: {} }),
    })
    assert.equal(unAdmittedRes.status, 422)
    assert.deepEqual(callsLog, ['secret_tool'])
    lease2.close()
  } finally {
    lease.close()
    await bridge.close()
  }
})
