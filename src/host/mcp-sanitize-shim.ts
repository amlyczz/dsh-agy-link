// Standalone stdio MCP "schema doctor": a transparent JSON-RPC proxy that
// repairs `tools/list` results on their way from a third-party MCP server to
// `agy` (and therefore to Google's GenerateContent validator).
//
// `agy` hands every registered MCP tool's JSON Schema to Gemini unchanged. A
// single `{"type":"array"}` without `items` makes Google reject the WHOLE
// request — `400 INVALID_ARGUMENT … properties[vertices].items: missing field`
// — which surfaced as a turn that could never complete, no matter how often it
// was retried (godot-mcp 3.1.0 ships 12 such tools).
//
// The host registers each foreign server as
//   command: <node>  args: [this file]  env: { DSH_AGY_MCP_TARGET: <original> }
// so this process can start the real server and stay invisible otherwise.
// Everything except `tools/list` responses is forwarded byte for byte.
import { spawn, type ChildProcess } from 'node:child_process'
import { SANITIZE_TARGET_ENV, sanitizeTools, unwrapServerSpec } from './mcp-sanitize.ts'

/** Strip wrapper-only keys before the real server inherits the environment. */
function childEnv(extra: Record<string, unknown> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (typeof v === 'string') env[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v)
  }
  delete env[SANITIZE_TARGET_ENV]
  // `ELECTRON_RUN_AS_NODE` was set so that OUR launcher (the Electron binary)
  // behaves as Node. A child that happens to be Electron must not inherit it.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function log(message: string): void {
  try {
    process.stderr.write('[dsh-mcp-sanitize] ' + message + '\n')
  } catch {
    /* a broken stderr must not break the proxy */
  }
}

const spec = unwrapServerSpec({ env: { [SANITIZE_TARGET_ENV]: process.env[SANITIZE_TARGET_ENV] } })
if (spec === null) {
  log('missing ' + SANITIZE_TARGET_ENV + ': nothing to proxy')
  process.exit(2)
}

const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command)
let child: ChildProcess
try {
  child = spawn(spec.command, Array.isArray(spec.args) ? (spec.args as string[]) : [], {
    env: childEnv(spec.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    // `.cmd`/`.bat` launchers (npx.cmd and friends) need the shell on Windows.
    shell: isWinCmd,
    windowsHide: true,
  })
} catch (err) {
  log('failed to start ' + spec.command + ': ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
}

child.on('error', (err) => {
  log('child error: ' + err.message)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null && signal !== undefined) {
    log('child exited on signal ' + signal)
    process.exit(0)
  }
  process.exit(typeof code === 'number' ? code : 0)
})

// stderr is diagnostics for agy's log: pass it through untouched.
child.stderr?.on('data', (chunk: Buffer | string) => {
  try {
    process.stderr.write(chunk)
  } catch {
    /* ignore */
  }
})

// Client -> server: byte-for-byte, including notifications.
process.stdin.on('data', (chunk: Buffer) => {
  child.stdin?.write(chunk)
})
process.stdin.on('end', () => {
  try {
    child.stdin?.end()
  } catch {
    /* ignore */
  }
})
process.stdin.on('error', () => {
  try {
    child.stdin?.end()
  } catch {
    /* ignore */
  }
})

let repairedReports = 0
let pending = ''
child.stdout?.on('data', (chunk: Buffer | string) => {
  pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  let nl: number
  while ((nl = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, nl)
    pending = pending.slice(nl + 1)
    forward(line)
  }
})
child.stdout?.on('end', () => {
  if (pending !== '') {
    const line = pending
    pending = ''
    forward(line)
  }
})

function forward(line: string): void {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed === '') {
    safeWrite(line + '\n')
    return
  }
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    safeWrite(line + '\n')
    return
  }
  if (msg.method === undefined && msg.result !== undefined) {
    const result = msg.result
    if (result !== null && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)) {
      const { tools, repaired } = sanitizeTools((result as { tools: unknown[] }).tools)
      if (repaired.length > 0) {
        repairedReports += 1
        log(
          'repaired ' + String(repaired.length) + ' tool schema(s) for Gemini'
            + (repairedReports === 1 ? ': ' + repaired.slice(0, 12).join(', ') : ''),
        )
        msg.result = { ...(result as Record<string, unknown>), tools }
      }
    }
  }
  safeWrite(JSON.stringify(msg) + '\n')
}

function safeWrite(text: string): void {
  try {
    process.stdout.write(text)
  } catch {
    /* the client went away; the child exit handler decides the fate */
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try {
      child.kill(sig)
    } catch {
      /* ignore */
    }
  })
}