// MCP reverse bridge (v0.3): lets the spawned agy process call DSH-side
// tools. Design: the plugin runs a loopback-only HTTP endpoint
// (127.0.0.1, ephemeral port, bearer token) exposing tool schemas and
// execution; a tiny standalone stdio MCP server (dist/bridge.mjs, plain
// node, zero deps) is registered in the agy MCP registry and forwards MCP
// tool calls to that endpoint. Loopback + token keeps the surface private
// to this machine and this plugin.
//
// Two things matter for the bridge to be usable at all (issue #55):
//  1. `agy` 1.4+ reads MCP servers only from `~/.gemini/config/mcp_config.json`
//     (or a plugin's own `mcp_config.json`) — a workspace `.mcp.json` is
//     silently ignored, so that is where the entry has to go.
//  2. The host grants the step's tools to a session-specific subprocess using
//     an opaque capability. A process ID or declared session ID is not proof
//     of ownership of a model step.

import type { BridgeStep, StepToolSet } from './bridge-steps.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readJsonBody } from './read-json-body.ts'
import { extractMcpContentBlocks, prepareMcpTools } from './mcp-schema.ts'
import {
  applySchemaDoctor,
  BRIDGE_SERVER_KEY,
  invalidateToolStateCaches,
  makeRegistryRestore,
  sanitizeShimPath,
  writePrivateMcpFile,
} from './mcp-registry.ts'
import { homedir } from 'node:os'

const MCP_SERVER_KEY = BRIDGE_SERVER_KEY

/**
 * Tools that must NEVER be exposed to an external MCP client. These are
 * internal transports / loopback-only helpers of the plugin itself:
 *  - `agy_ask`   — the plugin's own ask tool (would recurse into agy).
 *  - `agy_tool`  — replays recorded agy tool activity back into DSH; calling it
 *                   over the bridge would let the agy child re-enter the bridge.
 * Kept in one place so the /tools listing and the /call guard can never drift.
 */
const INTERNAL_TOOL_NAMES = new Set(['agy_ask', 'agy_tool', 'agy_image'])

/** Minimal structural view of the DSH tool registry we need. */
export interface ToolsServiceLike {
  /**
   * `scope` is a DSH Agent. Passing it matters for PTC detection: a native
   * scope has no `run_code` tool, while a PTC scope exposes it.
   */
  schemas(scope?: unknown): Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  /**
   * DSH 0.2.2+ settles a whole *batch* (`{ calls, signal, agent }`); 0.2.1 took
   * a single call (`{ callId, name, arguments, ... }`). The bridge sends a
   * payload carrying both shapes — each version ignores the fields it does not
   * read — so an upgrade or downgrade cannot silently break the bridge again.
   * (0.2.1 -> 0.2.2 did: the missing `calls` array made every bridged call die
   * inside `executeToolBatch` with `ToolBatchExecutionError`.)
   */
  execute(input: {
    /** DSH 0.2.2+ batch shape; `arguments` is the raw model JSON text. */
    calls: Array<{ type: 'tool-call'; id: string; name: string; arguments: string }>
    /** DSH 0.2.1 single-call shape; ignored by 0.2.2+. */
    callId?: string
    name?: string
    arguments?: unknown
    toolSet?: StepToolSet
    agent?: unknown
    /**
     * DSH 0.2.1 PTC nested-dispatch token (#66). 0.2.2 gates PTC on the
     * execution source instead, so native calls never set it; a PTC scope keeps
     * it so a 0.2.1 host still treats the bridged call as a nested dispatch.
     */
    parent?: symbol
    /**
     * Caller-owned cancellation, required by DSH's `ToolExecutionInput`. Tools
     * read `exec.signal` before/while they settle, so a call without one throws
     * `Cannot read properties of undefined (reading 'aborted')`.
     */
    signal: AbortSignal
  }): Promise<unknown>
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

/** Loopback request-body cap for /call. Tool arguments are tiny; this only
 * exists so a token-holding (possibly prompt-injected) agy child cannot OOM the
 * host by streaming an unbounded body. The bounded reader itself is shared with
 * the plugin's web routes (see ./read-json-body.ts). */
const MCP_MAX_BODY_BYTES = 8 * 1024 * 1024

/** Constant-time bearer comparison (the token is a shared secret). */
function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
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
 * Project one settled call out of a DSH 0.2.2 `ToolBatchResult`
 * (`{ results: [{ callId, result }] }`). A 0.2.1 single `ToolExecutionResult`
 * (no `results` array) passes through untouched, so the same bridge serves both
 * API shapes.
 */
function settledToolResult(result: unknown, callId: string): unknown {
  const results = (result as { results?: unknown } | null | undefined)?.results
  if (!Array.isArray(results)) return result
  const settled = results.find((entry) => (entry as { callId?: unknown } | null)?.callId === callId)
  const inner = (settled as { result?: unknown } | undefined)?.result
  if (inner == null) throw new Error('No settled result for this tool call')
  return inner
}

/**
 * Start the loopback endpoint. Resolves once listening. The tools service
 * may arrive later (optional service): pass a thunk.
 */
export function startMcpBridge(opts: {
  bridgeScript: string
  tools: () => ToolsServiceLike | undefined
  allowlist: () => string
  /** Map the spawning DSH session id to the agent the call runs on behalf of. */
  resolveAgent?: (sessionId: string) => unknown | Promise<unknown>
  resolveStep?: (token: string) => BridgeStep | undefined
  log?: (msg: string) => void
  /** Max buffered request-body bytes (tests use a small value). */
  maxBodyBytes?: number
}): Promise<McpBridge> {
  const resolveSessionAgent = async (req: IncomingMessage): Promise<unknown> => {
    const sessionHeader = String(req.headers['x-dsh-session'] ?? '')
    const resolveSession = async (id: string): Promise<unknown> =>
      id === '' ? undefined : await Promise.resolve(opts.resolveAgent?.(id))
    const agent = await resolveSession(sessionHeader)
    if (agent === undefined && sessionHeader !== '' && !sessionHeader.startsWith('session-')) {
      return await resolveSession('session-' + sessionHeader)
    }
    return agent
  }
  const token = randomBytes(24).toString('hex')
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0]
      const auth = String(req.headers['authorization'] ?? '')
      if (!bearerMatches(auth, 'Bearer ' + token)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      const step = opts.resolveStep?.(String(req.headers['x-dsh-route'] ?? ''))
      const noStep = !!opts.resolveStep && !step
      if ((req.method === 'GET' || req.method === 'POST') && (url === '/tools' || url === '/mcp/tools')) {
        const svc = opts.tools()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
        const allowSet = new Set(allow)
        const used = new Set<string>()
        // List the CALLER's surface: without a scope the whole preset-registered
        // tool set is filtered out (issue #150).
        const schemas = step?.schemas ?? (noStep ? [] : svc.schemas(await resolveSessionAgent(req)))
        const rawTools = schemas
          .filter((t) => allow.length === 0 || allowSet.has(t.name))
          // internal transports / loopback-only helpers are not bridgeable
          .filter((t) => !INTERNAL_TOOL_NAMES.has(t.name) && (t.name !== 'run_code' || step !== undefined))
          .map((t) => {
            const base = toMcpName(t.name)
            let name = base
            for (let i = 2; used.has(name); i++) name = base + '__' + i
            used.add(name)
            return {
              name,
              dshName: t.name,
              description: t.description,
              inputSchema: { type: 'object', ...t.parameters },
            }
          })
        const tools = prepareMcpTools(rawTools)
        sendJson(res, 200, { tools })
        return;
      }
      if (req.method === 'POST' && (url === '/call' || url === '/mcp/call')) {
        const body = await readJsonBody(req, { maxBytes: opts.maxBodyBytes ?? MCP_MAX_BODY_BYTES })
        if (body.tooLarge) {
          sendJson(res, 413, { error: 'request body too large' })
          return
        }
        if (body.invalid) {
          sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const parsed = body.value as { dshName?: unknown; arguments?: unknown }
        const svc = opts.tools()
        if (!svc) {
          sendJson(res, 503, { error: 'tools service unavailable' })
          return
        }
        const dshName = typeof parsed.dshName === 'string' ? parsed.dshName : ''
        if (dshName === '' || INTERNAL_TOOL_NAMES.has(dshName) || (dshName === 'run_code' && !step)) {
          sendJson(res, 400, { error: 'bad tool name' })
          return;
        }
        if (noStep || (step && !step.schemas.some(tool => tool.name === dshName))) {
          sendJson(res, 403, { error: 'tool unavailable for this session step' })
          return
        }
        const callId = 'agy-mcp-' + randomUUID()
        // Audit trail: the bridge is the only path from an external agent
        // runtime into DSH tools, and it used to log nothing per call, so a
        // failed run could only be reconstructed from transcripts. Log the
        // tool, the caller and the outcome - never the arguments, which may
        // carry file contents or secrets.
        const startedAt = Date.now()
        const audit = (outcome: string): void => {
          try {
            opts.log?.('mcp call ' + dshName + ' [' + outcome + '] ' + (Date.now() - startedAt) + 'ms')
          } catch {
            /* logging must never break the call */
          }
        }
        // Enforce the allowlist at EXECUTION time, not just when listing tools.
        // The agy child holds the bridge token, so it is exactly the party that
        // mcpToolAllowlist constrains; filtering only /tools would let a
        // (possibly prompt-injected) child POST /call with an arbitrary dshName
        // and reach tools outside the allowlist. Empty allowlist = all allowed.
        const allow = opts.allowlist().split(',').map((s) => s.trim()).filter(Boolean)
        if (allow.length > 0 && !allow.includes(dshName)) {
          audit('denied: not in allowlist')
          sendJson(res, 403, { error: 'tool not allowed' })
          return
        }
        try {
          // Carry the caller: the session that spawned agy is the agent on
          // whose behalf this call runs (issue #55). Without it, tools that
          // enforce `exec.agent` reject the call.
          // The spawning session's agent (see resolveSessionAgent): without it
          // a call runs anonymously and `agent_teams` tools reject it.
          const agent = step?.agent ?? await resolveSessionAgent(req)
          // Every DSH tool receives `exec.signal`; tools that await inside their
          // body read it, so a call without one throws
          // `Cannot read properties of undefined (reading 'aborted')`.
          // Abort when the MCP client goes away so the tool can stop early.
          const controller = new AbortController()
          const abortIfOpen = (): void => {
            if (!res.writableEnded) controller.abort()
          }
          req.once('aborted', abortIfOpen)
          res.once('close', () => {
            if (!res.writableEnded) controller.abort()
          })
          // PTC mode rejects model-direct tool calls. 0.2.1 gates that on a
          // per-call `parent` token, 0.2.2 on the execution source, so keep the
          // token only for a PTC surface: native calls must not carry it (a
          // pre-execute hook treats any parent as a PTC dispatch and then looks
          // for a session-log start that a native call does not have).
          const isPtc = !step && svc.schemas(agent).some((tool) => tool.name === 'run_code')
          const result = await svc.execute({
            calls: [{
              type: 'tool-call',
              id: callId,
              name: dshName,
              // The batch API expects the raw model JSON text; it parses it and
              // keeps malformed input for tool-owned diagnostics.
              arguments: JSON.stringify(parsed.arguments ?? {}),
            }],
            signal: step ? AbortSignal.any([controller.signal, step.signal]) : controller.signal,
            ...(step && { toolSet: {
              view: (scope?: unknown) => new Map([...step.toolSet.view(scope)].filter(([name]) =>
                !INTERNAL_TOOL_NAMES.has(name) && (allow.length === 0 || allow.includes(name)))),
            } }),
            ...(agent === undefined ? {} : { agent }),
            // DSH 0.2.1 compatibility (ignored by 0.2.2+).
            callId,
            name: dshName,
            arguments: parsed.arguments ?? {},
            ...(isPtc ? { parent: Symbol(callId) } : {}),
          })
          if (step && !Array.isArray((result as { results?: unknown } | null)?.results)) {
            throw new Error('The host returned no tool batch for this step')
          }
          const settled = settledToolResult(result, callId)
          if ((settled as { isError?: boolean } | null)?.isError) {
            audit('tool returned error')
            sendJson(res, 422, { ok: false, error: resultText(settled) })
            return
          }
          audit('ok caller=' + (agent === undefined ? 'none' : 'agent'))
          const content = extractMcpContentBlocks(settled)
          sendJson(res, 200, {
            ok: true,
            text: resultText(settled),
            ...(content ? { content } : {}),
          })
        } catch (e) {
          audit('failed: ' + String(e).slice(0, 200))
          sendJson(res, 422, { ok: false, error: String(e) })
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
      server.unref()
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

/** `agy` home the CLI reads its configs from (mirrors the runner's isolated-home rule). */
export function agyConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GEMINI_CLI_HOME
  if (typeof home === 'string' && home !== '') return home
  const plain = env.HOME
  if (typeof plain === 'string' && plain !== '') return plain
  return homedir()
}

/**
 * Absolute path of the MCP server registry `agy` 1.4+ actually loads.
 * `override` wins so callers can target a specific file.
 * Correctly distinguishes between a home dir (`/path/to/home`) and a
 * direct .gemini dir (`/path/to/home/.gemini`).
 */
export function agyMcpConfigPath(override = '', env: NodeJS.ProcessEnv = process.env): string {
  if (override !== '') return override
  const gch = env.GEMINI_CLI_HOME
  if (typeof gch === 'string' && gch !== '') {
    return basename(gch) === '.gemini'
      ? join(gch, 'config', 'mcp_config.json')
      : join(gch, '.gemini', 'config', 'mcp_config.json')
  }
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
  return join(home, '.gemini', 'config', 'mcp_config.json')
}

/** Registry key for one bridge instance: unique per port so two DSH hosts sharing a global file never clobber each other. */
export function mcpServerKey(port: number): string {
  return MCP_SERVER_KEY + '-' + String(port)
}

/**
 * Merge our server entry into the MCP registry file at `file` (`agy` 1.4+
 * reads the global one; a workspace `.mcp.json` is ignored, see issue #55).
 * Returns a restore function that puts the previous content back (or deletes
 * the file we created). Never throws.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * The `mcpServers` entry that points Antigravity at our stdio bridge.
 *
 * On the DSH desktop build `execPath` is the ELECTRON binary, so launching the
 * bridge that way started a second Electron instance whose window stole focus
 * every time a tool call spawned the server (issue #140). `ELECTRON_RUN_AS_NODE`
 * makes that same binary behave as a plain Node process; a real `node` binary
 * ignores it, so it is only added when the host actually is Electron.
 */
export function mcpServerEntry(
  bridge: McpBridge,
  execPath: string,
  isElectron: boolean,
): { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } {
  return {
    type: 'stdio',
    command: execPath,
    args: [bridge.bridgeScript],
    env: {
      DSH_MCP_URL: bridge.url,
      DSH_MCP_TOKEN: bridge.token,
      DSH_MCP_PID: String(process.pid),
      ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  }
}

export interface BridgeRegistryState {
  bridge: McpBridge | null
  restores: Array<() => void>
  /** Optional host logger (schema-doctor wrap decisions are worth a line). */
  log?: (message: string) => void
}

/** Absolute path of the schema-doctor shim that ships next to the bridge. */
export { sanitizeShimPath }

const registeredFilesByBridge = new WeakMap<McpBridge, Set<string>>()

/**
 * Idempotently register the MCP bridge into `file` and record its restore
 * hook on `state.restores` at most once per `(state.bridge, file)` pair.
 */
export function registerBridgeMcpConfig(state: BridgeRegistryState, file: string): void {
  const bridge = state.bridge
  if (bridge === null) return
  let files = registeredFilesByBridge.get(bridge)
  if (files === undefined) {
    files = new Set<string>()
    registeredFilesByBridge.set(bridge, files)
  }
  if (files.has(file)) return
  files.add(file)
  state.restores.push(writeMcpConfig(file, bridge, state.log))
}

/** Restore every registered MCP config file and close the active bridge. */
export async function teardownBridgeState(state: BridgeRegistryState): Promise<void> {
  for (const undo of state.restores) undo()
  const bridge = state.bridge
  state.bridge = null
  state.restores = []
  if (bridge !== null) {
    registeredFilesByBridge.delete(bridge)
    await bridge.close()
  }
}

export function writeMcpConfig(file: string, bridge: McpBridge, log?: (message: string) => void): () => void {
  const key = mcpServerKey(bridge.port)
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
  if (MCP_SERVER_KEY in servers) {
    delete servers[MCP_SERVER_KEY]
  }
  // Prune stale dsh-tools-<port> entries left behind by crashed host PIDs while
  // keeping live concurrent hosts untouched.
  for (const [existingKey, val] of Object.entries(servers)) {
    if (existingKey === key || !existingKey.startsWith(MCP_SERVER_KEY + '-')) continue
    const envObj = (val as { env?: Record<string, unknown> } | null)?.env
    const rawPid = envObj?.DSH_MCP_PID
    // Entries written before DSH_MCP_PID existed can never be proven alive, so
    // they were never pruned and piled up (8-9 per account seen in the wild).
    // agy waits for EVERY registered server before sending the turn, so dead
    // bridges stall each warmup probe until `--print-timeout` with 0 tokens
    // used, and the quota window is never activated. Treat them as stale.
    const legacyWithoutPid = rawPid === undefined
    const deadPid = typeof rawPid === 'string' && /^\d+$/.test(rawPid) && !isPidAlive(Number(rawPid))
    if (legacyWithoutPid || deadPid) {
      delete servers[existingKey]
    }
  }
  servers[key] = mcpServerEntry(bridge, process.execPath, process.versions.electron !== undefined)
  // Foreign stdio servers (godot, blender, chrome-devtools, …) are declared to
  // Google verbatim by `agy`: ONE array without `items` fails every turn with
  // `400 INVALID_ARGUMENT … items: missing field`, so they are routed through
  // the schema doctor that ships next to the bridge (see mcp-registry.ts).
  const wrappedNames = applySchemaDoctor(servers, {
    shimScript: sanitizeShimPath(bridge.bridgeScript),
    nodeBin: process.execPath,
    isElectron: process.versions.electron !== undefined,
    ...(log === undefined ? {} : { log }),
  })
  root.mcpServers = servers
  let writtenBytes = ''
  try {
    mkdirSync(dirname(file), { recursive: true })
    writtenBytes = JSON.stringify(root, null, 2) + '\n'
    writePrivateMcpFile(file, writtenBytes)
    const cleared = invalidateToolStateCaches(file, wrappedNames)
    if (cleared.length > 0) {
      log?.('[mcp] dropped stale agy tool state for: ' + cleared.join(','))
    }
  } catch {
    return () => {}
  }
  return makeRegistryRestore({ file, key, previous, writtenBytes })
}
