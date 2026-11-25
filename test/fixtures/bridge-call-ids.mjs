// Start a fresh reverse bridge, submit two calls for the same durable session, and exit.
import { startMcpBridge } from '../../src/host/mcp-bridge.ts'

const bridge = await startMcpBridge({
  bridgeScript: process.argv[1],
  tools: () => ({
    schemas: () => [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }],
    execute: async ({ calls }) => ({
      results: calls.map(({ id }) => ({ callId: id, result: { content: [{ type: 'text', text: id }] } })),
    }),
  }),
  allowlist: () => 'echo',
  resolveAgent: () => ({ id: 'agent' }),
})
try {
  const ids = []
  for (let i = 0; i < 2; i++) {
    const res = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json', 'x-dsh-session': 'same-session' },
      body: JSON.stringify({ dshName: 'echo', arguments: {} }),
    })
    const body = await res.json()
    if (!res.ok || !body.ok) throw Error('Fixture bridge call failed')
    ids.push(body.text)
  }
  console.log(JSON.stringify(ids))
} finally {
  await bridge.close()
}
