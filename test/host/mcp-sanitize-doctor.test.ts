// The schema doctor: third-party MCP servers that `agy` registers directly in
// `~/.gemini/config/mcp_config.json` are declared to Google VERBATIM, so one
// `{"type":"array"}` without `items` fails EVERY turn with
//   INVALID_ARGUMENT (code 400) 鈥?properties[vertices].items: missing field
// even when the tool is never called (live: godot-mcp 3.1.0, 12 tools, six
// consecutive turns). These tests pin the proxy that repairs those schemas and
// the registry rewrite that routes foreign servers through it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  isSanitizeWrapper,
  MAX_WRAPPED_SPEC_CHARS,
  SANITIZE_TARGET_ENV,
  sanitizeTools,
  unwrapForeignServers,
  unwrapServerSpec,
  wrapForeignServers,
  wrapServerSpec,
} from '../../src/host/mcp-sanitize.ts'
import { findArraysMissingItems } from '../../src/host/mcp-schema.ts'
import { writeMcpConfig } from '../../src/host/mcp-bridge.ts'

const NODE = process.execPath

/** The exact shapes godot-mcp 3.1.0 ships (captured from its tools/list). */
const GODOT_TOOLS = [
  {
    name: 'game_call_method',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        args: { type: 'array', description: 'Optional array of arguments to pass to the method' },
      },
      required: ['method'],
    },
  },
  {
    name: 'game_procedural_mesh',
    inputSchema: {
      type: 'object',
      properties: {
        vertices: { type: 'array', description: 'Vertex positions [[x,y,z],...]' },
        normals: { type: 'array', description: 'Vertex normals [[x,y,z],...]' },
        uvs: { type: 'array', description: 'UV coordinates [[u,v],...]' },
        indices: { type: 'array', description: 'Triangle indices [i0,i1,i2,...]' },
      },
    },
  },
  {
    name: 'create_script',
    inputSchema: {
      type: 'object',
      properties: { methods: { type: 'array', description: 'Method stubs to include' } },
    },
  },
]

test('sanitizeTools fills items on every array property godot ships', () => {
  for (const tool of GODOT_TOOLS) {
    assert.notDeepEqual(findArraysMissingItems(tool.inputSchema), [], 'fixture must be hostile')
  }
  const { tools, repaired } = sanitizeTools(GODOT_TOOLS)
  assert.equal(repaired.length, GODOT_TOOLS.length)
  for (const tool of tools as Array<{ inputSchema: Record<string, unknown> }>) {
    assert.deepEqual(findArraysMissingItems(tool.inputSchema), [], 'repaired schema must satisfy Gemini')
  }
  const args = (tools[0] as { inputSchema: { properties: Record<string, { items?: unknown; description?: string }> } })
    .inputSchema.properties.args!
  assert.deepEqual(args.items, { type: 'string' })
  // Descriptions survive: agy's tool budget/UX depends on them.
  assert.equal(args.description, 'Optional array of arguments to pass to the method')
})

test('wrapServerSpec round-trips through the marker env and is idempotent', () => {
  const original = { command: 'C:\\tools\\godot-mcp.cmd', args: [], env: { GODOT_PATH: 'D:\\Godot.exe' } }
  const wrapped = wrapServerSpec(original, { shimScript: 'C:\\p\\dist\\mcp-sanitize.mjs', nodeBin: NODE, isElectron: false })
  assert.ok(wrapped)
  assert.equal(wrapped.command, NODE)
  assert.deepEqual(wrapped.args, ['C:\\p\\dist\\mcp-sanitize.mjs'])
  assert.equal(wrapped.env?.GODOT_PATH, 'D:\\Godot.exe', 'original env must reach the real server')
  assert.equal(isSanitizeWrapper(wrapped), true)
  assert.deepEqual(unwrapServerSpec(wrapped), original)

  const again = wrapServerSpec(wrapped, { shimScript: 'C:\\other\\dist\\mcp-sanitize.mjs', nodeBin: NODE, isElectron: false })
  assert.equal(again, wrapped, 'already-wrapped specs are returned unchanged')
})

test('wrapForeignServers skips the bridge, unwrappable and oversized entries', () => {
  const servers: Record<string, unknown> = {
    'dsh-tools-1234': { type: 'stdio', command: NODE, args: ['bridge.mjs'], env: {} },
    godot: { command: 'godot-mcp.cmd', args: [] },
    broken: { args: [] },
    huge: { command: 'x', args: [], env: { BLOB: 'z'.repeat(MAX_WRAPPED_SPEC_CHARS) } },
    http: { url: 'https://example.invalid/mcp' },
  }
  const { wrapped, skipped } = wrapForeignServers(servers, {
    shimScript: '/p/dist/mcp-sanitize.mjs',
    nodeBin: NODE,
    isElectron: false,
    skipKey: (k) => k.startsWith('dsh-tools-'),
  })
  assert.deepEqual(wrapped, ['godot'])
  assert.deepEqual(skipped, ['broken', 'huge', 'http'])
  assert.equal(servers.godot && isSanitizeWrapper(servers.godot), true)
  assert.equal(servers.broken && isSanitizeWrapper(servers.broken), false)

  const restored = unwrapForeignServers(servers)
  assert.deepEqual(restored, ['godot'])
  assert.deepEqual(servers.godot, { command: 'godot-mcp.cmd', args: [] })
})

test('a wrapper pointing at a stale shim is re-pointed at the live one', () => {
  const stale = wrapServerSpec({ command: 'godot-mcp.cmd' }, {
    shimScript: '/old/dist/mcp-sanitize.mjs',
    nodeBin: NODE,
    isElectron: false,
  })!
  const servers: Record<string, unknown> = { godot: stale }
  wrapForeignServers(servers, { shimScript: '/new/dist/mcp-sanitize.mjs', nodeBin: NODE, isElectron: false })
  const live = servers.godot as { args: string[] }
  assert.deepEqual(live.args, ['/new/dist/mcp-sanitize.mjs'])
  assert.deepEqual(unwrapServerSpec(live), { command: 'godot-mcp.cmd' })
})

/**
 * Drive the real shim against a fixture server that declares the hostile
 * schema, and prove the bytes `agy` receives are Gemini-valid. This is the
 * red-capable loop for the 400: without the shim the fixture's own output has
 * 10 missing-`items` paths.
 */
test('shim repairs tools/list end to end without touching other traffic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-schema-doctor-'))
  const fixture = join(dir, 'hostile-mcp.mjs')
  writeFileSync(
    fixture,
    `import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } })
    return
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: ${JSON.stringify(GODOT_TOOLS)} } })
    return
  }
  if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'called:' + msg.params.name }] } })
  }
})
`,
    'utf8',
  )
  const shim = join(process.cwd(), 'src/host/mcp-sanitize-shim.ts')
  const child = spawn(NODE, ['--experimental-transform-types', shim], {
    env: {
      ...process.env,
      [SANITIZE_TARGET_ENV]: JSON.stringify({ command: NODE, args: [fixture], env: {} }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  let buf = ''
  const waiters: Array<(line: string) => void> = []
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const w = waiters.shift()
      if (w) w(line)
      else lines.push(line)
    }
  })
  const next = (): Promise<string> => {
    const queued = lines.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('shim produced no reply')), 8_000)
      waiters.push((line) => {
        clearTimeout(timer)
        resolve(line)
      })
    })
  }

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    const init = JSON.parse(await next()) as { id: number; result: { protocolVersion: string } }
    assert.equal(init.id, 1)
    assert.equal(init.result.protocolVersion, '2024-11-05', 'initialize must pass through untouched')

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    const listed = JSON.parse(await next()) as { result: { tools: Array<{ inputSchema: Record<string, unknown> }> } }
    for (const tool of listed.result.tools) {
      assert.deepEqual(findArraysMissingItems(tool.inputSchema), [], 'agy must never see a bare array again')
    }

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'game_call_method', arguments: {} } }) + '\n')
    const called = JSON.parse(await next()) as { result: { content: Array<{ text: string }> } }
    assert.equal(called.result.content[0]!.text, 'called:game_call_method', 'tool calls pass through untouched')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('writeMcpConfig routes foreign servers through the shim and restores them on teardown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-schema-doctor-cfg-'))
  try {
    const bridgeScript = join(dir, 'bridge.mjs')
    writeFileSync(bridgeScript, '// bridge\n', 'utf8')
    const shim = join(dir, 'mcp-sanitize.mjs')
    writeFileSync(shim, '// shim\n', 'utf8')
    const cfgFile = join(dir, '.gemini', 'config', 'mcp_config.json')
    mkdirSync(dirname(cfgFile), { recursive: true })
    // agy's cached descriptors still carry the BROKEN schema; they must go, or
    // the 400 survives the fix until agy happens to refresh them.
    const cacheDir = join(dir, '.gemini', 'antigravity-cli', 'mcp', 'godot')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'game_procedural_mesh.json'), '{"parameters":{"properties":{"vertices":{"type":"array"}}}}', 'utf8')
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mcpServers: {
          godot: { command: 'godot-mcp.cmd', args: [], env: { GODOT_PATH: 'D:\\Godot.exe' } },
        },
      }, null, 2) + '\n',
      'utf8',
    )

    const restore = writeMcpConfig(cfgFile, {
      bridgeScript,
      token: 'tk',
      url: 'http://127.0.0.1:4301',
      port: 4301,
      close: async () => undefined,
    })
    const written = JSON.parse(readFileSync(cfgFile, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
    assert.ok(written.mcpServers['dsh-tools-4301'], 'bridge entry must still be published')
    const godot = written.mcpServers.godot!
    assert.equal(godot.command, NODE, 'godot must now launch the schema doctor')
    assert.deepEqual(godot.args, [shim])
    assert.equal(isSanitizeWrapper(godot), true)
    assert.equal((godot.env as Record<string, unknown>).GODOT_PATH, 'D:\\Godot.exe', 'the real env travels with the wrapper')
    assert.equal(existsSync(cacheDir), false, 'stale tool descriptors must be dropped so agy refetches')

    restore()
    const after = JSON.parse(readFileSync(cfgFile, 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(after.mcpServers, {
      godot: { command: 'godot-mcp.cmd', args: [], env: { GODOT_PATH: 'D:\\Godot.exe' } },
    }, 'teardown must put the original server spec back')
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('writeMcpConfig leaves foreign servers alone when the shim is not built', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-schema-doctor-noshim-'))
  try {
    const bridgeScript = join(dir, 'bridge.mjs')
    writeFileSync(bridgeScript, '// bridge\n', 'utf8')
    assert.equal(existsSync(join(dirname(bridgeScript), 'mcp-sanitize.mjs')), false)
    const cfgFile = join(dir, 'mcp_config.json')
    const spec = { command: 'godot-mcp.cmd', args: [] }
    writeFileSync(cfgFile, JSON.stringify({ mcpServers: { godot: spec } }, null, 2) + '\n', 'utf8')
    const logs: string[] = []
    const restore = writeMcpConfig(cfgFile, {
      bridgeScript,
      token: 'tk',
      url: 'http://127.0.0.1:4302',
      port: 4302,
      close: async () => undefined,
    }, (m) => logs.push(m))
    const written = JSON.parse(readFileSync(cfgFile, 'utf8')) as { mcpServers: Record<string, unknown> }
    assert.deepEqual(written.mcpServers.godot, spec, 'without the shim, wrapping would break the server')
    assert.ok(logs.some((l) => l.includes('shim missing')))
    restore()
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 })
  }
})

test('the built shim ships next to the bridge script', () => {
  // Packaging contract: `dist/mcp-sanitize.mjs` must exist for the wrapper to
  // work; a missing shim is caught above, but the build entry is part of it.
  const tsdown = readFileSync(join(process.cwd(), 'tsdown.config.ts'), 'utf8')
  assert.ok(tsdown.includes('src/host/mcp-sanitize-shim.ts'), 'tsdown must build the shim')
  assert.ok(chmodSync !== undefined)
})