// MCP reverse bridge (v0.2): lets the spawned agy process call DSH-side
// tools. Design: the plugin runs a loopback-only HTTP endpoint
// (127.0.0.1, ephemeral port, bearer token) exposing tool schemas and
// execution; a tiny standalone stdio MCP server (dist/bridge.mjs, plain
// node, zero deps) is registered in the workspace .mcp.json and forwards
// MCP tool calls to that endpoint. Loopback + token keeps the surface
// private to this machine and this plugin.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const MCP_SERVER_KEY = 'dsh-tools'

/** Minimal structural view of the DSH tool registry we need. */
export interface ToolsServiceLike {
  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  execute(input: { callId: string; name: string; arguments: unknown }): Promise<unknown>
}

/** MCP tool names are [a-zA-Z0-9_-]; DSH names may contain dots. */
export function toMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export interface McpBridge {
  /** Absolute path of the bridge script (dist/bridge.mjs). */
  bridgeScript: string
  /** Bearer token the bridge script must present. */
  token: string
  /** Base URL of the loopback endpoint. */
  url: string
  port: number
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

/** Best-effort extraction of readable text from an execution result. */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  const r = result as { content?: unknown; output?: unknown; text?: unknown }
  if (Array.isArray(r.content)) {
    const parts: string[] = []
    for (const b of r.content) {
      const blk = b as { type?: string; text?: unknown }
      if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof r.text === 'string') return r.text
  if (typeof r.output === 'string') return r.output
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/**
 * Start the loopback endpoint. Resolves once listening. The tools service
 * may arrive later (optional service): pass a thunk.
 */
export function startMcpBridge(opts: {
  bridgeScript: string
  tools: () => ToolsServiceLike | undefined
  allowlist: () => string
  log?: (msg: string) => void
}): Promise<McpBridge> {
  const token = randomBytes(24).toString('hex')
  let callSeq = 0
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const auth = String(req.headers['authorization'] ?? '')
      if (auth !== 'Bearer ' + token) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      if ((req.method === 'GET' || req.method === 'POST') && (url === '/tools' || url === '/mcp/tools')) {
        const svc = opts.tools()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
        const allowSet = new Set(allow)
        const seen = new Set<string>()
        const tools = svc.schemas()
          .filter((t) => allow.length === 0 || allowSet.has(t.name))
          .filter((t) => {
            // internal transports and our own ask tool are not bridgeable
            if (t.name === 'run_code' || t.name === 'agy_ask') return false
            const mapped = toMcpName(t.name)
            if (seen.has(mapped)) return false // collision after mapping
            seen.add(mapped)
            return true
          })
          .map((t) => ({
            name: toMcpName(t.name),
            dshName: t.name,
            description: t.description,
            inputSchema: { type: 'object', ...t.parameters },
          }))
        sendJson(res, 200, { tools })
        return;
      }
      if (req.method === 'POST' && (url === '/call' || url === '/mcp/call')) {
        const body = await readBody(req)
        let parsed: { dshName?: unknown; arguments?: unknown } = {}
        try {
          parsed = JSON.parse(body) as typeof parsed
        } catch {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const svc = opts.tools()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const dshName = typeof parsed.dshName === 'string' ? parsed.dshName : ''
        if (dshName === '' || dshName === 'run_code' || dshName === 'agy_ask') {
          sendJson(res, 400, { error: 'bad tool name' })
          return;
        }
        callSeq++
        try {
          const result = await svc.execute({ callId: 'agy-mcp-' + callSeq, name: dshName, arguments: parsed.arguments ?? {} })
          sendJson(res, 200, { ok: true, text: resultText(result) })
        } catch (e) {
          sendJson(res, 200, { ok: false, error: String(e) })
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' })
    })().catch(() => {
      try { sendJson(res, 500, { error: 'internal' }) } catch { /* closed */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      opts.log?.('mcp bridge listening on 127.0.0.1:' + port)
      resolve({
        bridgeScript: opts.bridgeScript,
        token,
        url: 'http://127.0.0.1:' + port,
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/**
 * Merge our server entry into the workspace .mcp.json. Returns a restore
 * function that puts the previous content back (or deletes the file we
 * created). Never throws.
 */
export function writeMcpConfig(workspaceRoot: string, bridge: McpBridge): () => void {
  const file = join(workspaceRoot, '.mcp.json')
  let previous: string | null = null
  try {
    if (existsSync(file)) previous = readFileSync(file, 'utf8')
  } catch {
    previous = null
  }
  let root: Record<string, unknown> = {}
  if (previous !== null) {
    try {
      const v = JSON.parse(previous)
      if (v && typeof v === 'object') root = v as Record<string, unknown>
    } catch {
      root = {}
    }
  }
  const servers = (root.mcpServers && typeof root.mcpServers === 'object' ? root.mcpServers : {}) as Record<string, unknown>
  servers[MCP_SERVER_KEY] = {
    type: 'stdio',
    command: process.execPath,
    args: [bridge.bridgeScript],
    env: {
      DSH_MCP_URL: bridge.url,
      DSH_MCP_TOKEN: bridge.token,
    },
  }
  root.mcpServers = servers
  try {
    writeFileSync(file, JSON.stringify(root, null, 2) + '\n', 'utf8')
  } catch {
    return () => {}
  }
  return () => {
    try {
      if (previous === null) {
        if (existsSync(file)) unlinkSync(file)
      } else {
        writeFileSync(file, previous, 'utf8')
      }
    } catch {
      /* best effort */
    }
  }
}
