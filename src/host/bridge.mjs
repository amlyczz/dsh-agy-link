#!/usr/bin/env node
// dsh-agy-link MCP bridge script: a minimal stdio MCP server with zero
// dependencies. agy launches it from its MCP registry; it forwards
// tools/list and tools/call to the plugin loopback endpoint whose URL and
// token arrive via env. DSH_MCP_SESSION carries the spawning DSH session so
// the host can resolve the calling agent (issue #55).
// Protocol: newline-delimited JSON-RPC 2.0.
import { request as httpRequest } from 'node:http'
import process from 'node:process'
import { createInterface } from 'node:readline'

const URL_BASE = process.env.DSH_MCP_URL || ''
const TOKEN = process.env.DSH_MCP_TOKEN || ''
const SESSION = process.env.DSH_MCP_SESSION || ''
const PROTOCOL = '2024-11-05'
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

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
        ...(SESSION === '' ? {} : { 'X-DSH-Session': SESSION }),
      },
      timeout: 600000,
    });
    req.on('response', (res) => {
      const chunks = []
      let size = 0
      res.on('error', reject)
      res.on('aborted', () => reject(new Error('bridge response aborted')))
      res.on('data', (c) => {
        size += c.length
        if (size > MAX_RESPONSE_BYTES) {
          const error = new Error('bridge response exceeds 16 MiB')
          reject(error)
          res.destroy(error)
          req.destroy(error)
          return
        }
        chunks.push(c)
      })
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
let generation = 0

function invalidateTools() {
  generation += 1
  toolCache = null
}

async function listTools(force = false) {
  if (force) invalidateTools()
  if (toolCache) return toolCache;
  const started = generation
  const res = await post('/tools', {})
  if (res.status !== 200) throw new Error('bridge /tools failed: ' + JSON.stringify(res.body))
  const tools = (res.body.tools || []).map((t) => ({
    name: t.name,
    description: t.description || t.dshName,
    inputSchema: t.inputSchema || { type: 'object' },
    _dshName: t.dshName,
  }))
  // A response from before an unlock must never repopulate the new cache.
  if (started !== generation) return listTools()
  toolCache = tools
  return tools;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(id, method, params) {
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'dsh-agy-link-bridge', version: '0.2.0' } } })
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
    let tools = await listTools()
    let hit = tools.find((t) => t.name === name)
    if (!hit) {
      tools = await listTools(true)
      hit = tools.find((t) => t.name === name)
    }
    if (!hit) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + name } })
      return;
    }
    try {
      const res = await post('/call', { dshName: hit._dshName, arguments: args })
      if (res.status !== 200 || (res.body.ok !== true && !Array.isArray(res.body.content))) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + JSON.stringify(res.body) }], isError: true } })
        return;
      }
      const result = {
        content: Array.isArray(res.body.content) ? res.body.content : [{ type: 'text', text: res.body.text || '' }],
        ...(res.body.structuredContent !== undefined ? { structuredContent: res.body.structuredContent } : {}),
        ...(res.body.ok !== true ? { isError: true } : res.body.isError !== undefined ? { isError: res.body.isError } : {}),
      }
      send({ jsonrpc: '2.0', id, result })
      if (hit._dshName === 'dev_tool_search' && res.body.ok === true && res.body.isError !== true) {
        invalidateTools()
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
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

let pending = 0
let inputClosed = false
function finishIfDrained() {
  if (inputClosed && pending === 0) process.stdout.write('', () => process.exit(0))
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
  if (msg.id === undefined) return
  pending += 1
  void handle(msg.id, msg.method, msg.params).catch((e) => {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } })
  }).finally(() => {
    pending -= 1
    finishIfDrained()
  })
})
rl.on('close', () => {
  inputClosed = true
  finishIfDrained()
})
