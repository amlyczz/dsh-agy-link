import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

type Message = { id?: number; method?: string; result?: any; error?: any }
const schema = (name: string) => ({ name, dshName: name, inputSchema: { type: 'object' } })
async function fixture(handler: (path: string, body: any, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => handler(req.url!, JSON.parse(body), res))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/host/bridge.mjs', import.meta.url))], {
    env: { ...process.env, DSH_MCP_URL: `http://127.0.0.1:${address.port}`, DSH_MCP_TOKEN: 'synthetic-test-only', DSH_MCP_SESSION: 'synthetic-session' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const messages: Message[] = []
  const waiters = new Set<() => void>()
  createInterface({ input: child.stdout }).on('line', line => { messages.push(JSON.parse(line)); for (const wake of waiters) wake() })
  const exit = new Promise<number | null>(resolve => child.on('exit', resolve))
  const send = (id: number, method: string, params?: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  const wait = (predicate: (m: Message) => boolean): Promise<Message> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('stdio reply timeout')) }, 5000)
    const check = () => { const m = messages.find(predicate); if (m) { clearTimeout(timer); waiters.delete(check); resolve(m) } }
    waiters.add(check); check()
  })
  return { child, messages, send, wait, exit, async close() { child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
function reply(res: ServerResponse, body: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }

test('generation refresh rejects a late old list; unknown calls refresh and EOF drains native image', async () => {
  let listed = 0
  let old: ServerResponse | undefined
  let oldArrived!: () => void
  const arrived = new Promise<void>(resolve => { oldArrived = resolve })
  const content = [{ type: 'image', mimeType: 'image/png', data: 'AAECAw==' }]
  const f = await fixture((path, body, res) => {
    if (path === '/tools') {
      listed += 1
      if (listed === 1) { old = res; oldArrived(); return }
      reply(res, { tools: [schema('dev_tool_search'), ...(listed >= 3 ? [schema('read_image')] : [])] }); return
    }
    if (body.dshName === 'dev_tool_search') { reply(res, { ok: true, text: 'unlocked' }); return }
    setTimeout(() => reply(res, { ok: true, content, structuredContent: { preserved: true }, isError: false }), 40)
  })
  try {
    f.send(1, 'initialize'); assert.equal((await f.wait(m => m.id === 1)).result.capabilities.tools.listChanged, true)
    f.send(2, 'tools/list'); await arrived
    f.send(3, 'tools/call', { name: 'dev_tool_search' }); await f.wait(m => m.id === 3)
    await f.wait(m => m.method === 'notifications/tools/list_changed')
    f.send(4, 'tools/list'); await f.wait(m => m.id === 4)
    reply(old!, { tools: [schema('dev_tool_search')] })
    assert.ok((await f.wait(m => m.id === 2)).result.tools.some((t: any) => t.name === 'read_image'))
    f.send(5, 'tools/call', { name: 'read_image' }); f.child.stdin.end()
    const result = (await f.wait(m => m.id === 5)).result
    assert.deepEqual(result, { content, structuredContent: { preserved: true }, isError: false })
    assert.equal(await f.exit, 0)
  } finally { await f.close() }
})

test('unknown tool refreshes once and legacy text is preserved', async () => {
  let count = 0
  const f = await fixture((path, _body, res) => {
    if (path === '/tools') reply(res, { tools: ++count === 1 ? [] : [schema('late')] })
    else reply(res, { ok: true, text: 'legacy' })
  })
  try { f.send(1, 'tools/call', { name: 'late' }); assert.deepEqual((await f.wait(m => m.id === 1)).result.content, [{ type: 'text', text: 'legacy' }]); assert.equal(count, 2) } finally { await f.close() }
})

for (const failure of ['tool', 'http', 'transport'] as const) test(`failed search (${failure}) does not invalidate or notify`, async () => {
  let count = 0
  const f = await fixture((path, _body, res) => {
    if (path === '/tools') { count += 1; reply(res, { tools: [schema('dev_tool_search')] }); return }
    if (failure === 'transport') { res.destroy(); return }
    reply(res, { ok: failure !== 'http', content: [{ type: 'text', text: 'denied' }], isError: true }, failure === 'http' ? 503 : 200)
  })
  try {
    f.send(1, 'tools/call', { name: 'dev_tool_search' }); assert.equal((await f.wait(m => m.id === 1)).result.isError, true)
    f.send(2, 'tools/list'); await f.wait(m => m.id === 2)
    assert.equal(count, 1); assert.ok(!f.messages.some(m => m.method === 'notifications/tools/list_changed'))
  } finally { await f.close() }
})

test('HTTP 200 host failure preserves native blocks and structured content without refresh', async () => {
  const content = [{ type: 'text', text: 'permission denied: synthetic detail' }, { type: 'image', mimeType: 'image/png', data: 'AAECAw==' }]
  const structuredContent = { error: 'permission_denied', message: 'synthetic detail', retryable: false }
  let count = 0
  const f = await fixture((path, _body, res) => {
    if (path === '/tools') { count += 1; reply(res, { tools: [schema('dev_tool_search')] }); return }
    reply(res, { ok: false, content, structuredContent, isError: false })
  })
  try {
    f.send(1, 'tools/call', { name: 'dev_tool_search' })
    assert.deepEqual((await f.wait(m => m.id === 1)).result, { content, structuredContent, isError: true })
    f.send(2, 'tools/list'); await f.wait(m => m.id === 2)
    assert.equal(count, 1); assert.ok(!f.messages.some(m => m.method === 'notifications/tools/list_changed'))
  } finally { await f.close() }
})

test('HTTP 200 host failure without native content retains error details in fallback', async () => {
  const f = await fixture((path, _body, res) => {
    if (path === '/tools') reply(res, { tools: [schema('failed')] })
    else reply(res, { ok: false, error: 'permission_denied', message: 'synthetic detail' })
  })
  try {
    f.send(1, 'tools/call', { name: 'failed' })
    const result = (await f.wait(m => m.id === 1)).result
    assert.equal(result.isError, true)
    assert.deepEqual(JSON.parse(result.content[0].text.slice('ERROR: '.length)), { ok: false, error: 'permission_denied', message: 'synthetic detail' })
  } finally { await f.close() }
})

test('HTTP response exceeding 16 MiB is rejected as a tool error', async () => {
  const f = await fixture((path, _body, res) => {
    if (path === '/tools') reply(res, { tools: [schema('large')] })
    else reply(res, { ok: true, text: 'x'.repeat(16 * 1024 * 1024) })
  })
  try { f.send(1, 'tools/call', { name: 'large' }); const result = (await f.wait(m => m.id === 1)).result; assert.equal(result.isError, true); assert.match(result.content[0].text, /16 MiB/) } finally { await f.close() }
})
