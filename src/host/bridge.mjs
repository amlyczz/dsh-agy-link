#!/usr/bin/env node
// dsh-agy-link MCP bridge script: a minimal stdio MCP server with zero
// dependencies. agy launches it per the workspace .mcp.json; it forwards
// tools/list and tools/call to the plugin loopback endpoint whose URL and
// token arrive via env. Protocol: newline-delimited JSON-RPC 2.0.
import { request as httpRequest } from 'node:http'
import process from 'node:process'
import { createInterface } from 'node:readline'

const URL_BASE = process.env.DSH_MCP_URL || ''
const TOKEN = process.env.DSH_MCP_TOKEN || ''
const PROTOCOL = '2024-11-05'

function post(path, body) {
  return new Promise((resolve, reject) => {
    if (URL_BASE === '' || TOKEN === '') {
      reject(new Error('bridge not configured (missing DSH_MCP_URL/DSH_MCP_TOKEN)'))
      return;
    }
    const data = JSON.stringify(body)
    const u = new URL(URL_BASE)
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port || 80,
      method: 'POST',
      path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + TOKEN,
      },
      timeout: 600000,
    });
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (e) {
          reject(e)
        }
      })
    });
    req.on('timeout', () => req.destroy(new Error('bridge request timed out')))
    req.on('error', reject)
    req.end(data)
  })
}

let toolCache = null;

async function listTools() {
  if (toolCache) return toolCache;
  const res = await post('/tools', {})
  if (res.status !== 200) throw new Error('bridge /tools failed: ' + JSON.stringify(res.body))
  toolCache = (res.body.tools || []).map((t) => ({
    name: t.name,
    description: t.description || t.dshName,
    inputSchema: t.inputSchema || { type: 'object' },
    _dshName: t.dshName,
  }))
  return toolCache;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(id, method, params) {
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'dsh-agy-link-bridge', version: '0.2.0' } } })
    return;
  }
  if (method.startsWith('notifications/')) return;
  if (method === 'tools/list') {
    const tools = await listTools()
    send({ jsonrpc: '2.0', id, result: { tools: tools.map(({ _dshName, ...t }) => t) } })
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    const tools = await listTools()
    const hit = tools.find((t) => t.name === name)
    if (!hit) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + name } })
      return;
    }
    try {
      const res = await post('/call', { dshName: hit._dshName, arguments: args })
      if (res.status !== 200 || res.body.ok !== true) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + JSON.stringify(res.body) }], isError: true } })
        return;
      }
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: res.body.text || '' }] } })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + String(e) }], isError: true } })
    }
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let msg;
  try {
    msg = JSON.parse(text)
  } catch {
    return;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return
  if (msg.id === undefined) {
  void handle(null, msg.method, msg.params).catch(() => {})
    return;
  }
  void handle(msg.id, msg.method, msg.params).catch((e) => {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } })
  })
})
process.stdin.on('end', () => process.exit(0))
