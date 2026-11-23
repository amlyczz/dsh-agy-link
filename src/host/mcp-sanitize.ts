// Third-party MCP servers registered for `agy` are declared to Google VERBATIM
// by the ACP server, so ONE malformed schema kills the whole turn:
//
//   INVALID_ARGUMENT (code 400): GenerateContentRequest.tools[0]
//   .function_declarations[100].parameters.properties[vertices].items: missing field.
//
// `mcp-schema.ts` only hardens the tools DSH exposes through the reverse bridge
// (`dsh-tools-<port>`). Servers that the user registered directly in
// `~/.gemini/config/mcp_config.json` (godot, blender, chrome-devtools, …) never
// pass through the bridge, so their schemas reach Gemini untouched. `godot-mcp`
// 3.1.0 alone ships 12 such tools (`game_procedural_mesh`, `create_script`,
// `game_call_method`, `game_path_2d`, …), each declaring `{"type":"array"}`
// with no `items` — every turn died with the 400 above even though the tools
// were never called.
//
// This module turns any stdio server entry into a wrapped entry that routes
// through `dist/mcp-sanitize.mjs` (a transparent JSON-RPC proxy that repairs
// `tools/list` results with the SAME sanitizer the bridge uses) and can unwrap
// it again from the wrapper alone — no sidecar state, so a stale file, another
// host, or an uninstall can always be restored.
import { enforceArrayItems, sanitizeMcpSchema } from './mcp-schema.ts'

/** Env var carrying the ORIGINAL server spec inside a wrapper entry. */
export const SANITIZE_TARGET_ENV = 'DSH_AGY_MCP_TARGET'
/** Wrapper script name, resolved next to the bridge script in `dist/`. */
export const SANITIZE_SHIM_NAME = 'mcp-sanitize.mjs'
/** Refuse to wrap specs whose JSON would not fit comfortably in an env var. */
export const MAX_WRAPPED_SPEC_CHARS = 6_000

/** Minimal shape of one `mcpServers` entry (`agy` accepts extra keys; keep them). */
export interface StdioServerSpec {
  command: string
  args?: unknown[]
  env?: Record<string, unknown>
  [key: string]: unknown
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** True when `spec` is a wrapper WE created (marker env present and parseable). */
export function isSanitizeWrapper(spec: unknown): boolean {
  if (!isPlainObj(spec)) return false
  const env = spec.env
  if (!isPlainObj(env)) return false
  const raw = env[SANITIZE_TARGET_ENV]
  if (typeof raw !== 'string' || raw === '') return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObj(parsed) && typeof parsed.command === 'string'
  } catch {
    return false
  }
}

/** Recover the original server spec from a wrapper entry, or null when absent. */
export function unwrapServerSpec(spec: unknown): StdioServerSpec | null {
  if (!isPlainObj(spec)) return null
  const env = spec.env
  if (!isPlainObj(env)) return null
  const raw = env[SANITIZE_TARGET_ENV]
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isPlainObj(parsed) || typeof parsed.command !== 'string') return null
    return parsed as StdioServerSpec
  } catch {
    return null
  }
}

export interface WrapOptions {
  /** Absolute path of `dist/mcp-sanitize.mjs`. */
  shimScript: string
  /** Node/Electron binary that runs the shim. */
  nodeBin: string
  /** On Electron, the same binary only acts as Node with this flag set. */
  isElectron: boolean
}

/**
 * Wrap one stdio entry so its `tools/list` output is repaired on the way to
 * `agy`. Everything else about the entry (extra keys, env, args) is preserved
 * for `agy`'s own config parser, and the ORIGINAL spec travels in the wrapper's
 * env so `unwrapServerSpec` can always undo this.
 */
export function wrapServerSpec(spec: StdioServerSpec, opts: WrapOptions): StdioServerSpec | null {
  if (typeof spec.command !== 'string' || spec.command === '') return null
  if (isSanitizeWrapper(spec)) return spec
  const original: StdioServerSpec = { ...spec }
  const serialized = JSON.stringify(original)
  if (serialized.length > MAX_WRAPPED_SPEC_CHARS) return null
  const env: Record<string, unknown> = isPlainObj(spec.env) ? { ...spec.env } : {}
  env[SANITIZE_TARGET_ENV] = serialized
  if (opts.isElectron) env.ELECTRON_RUN_AS_NODE = '1'
  return {
    ...spec,
    type: 'stdio',
    command: opts.nodeBin,
    args: [opts.shimScript],
    env,
  }
}

export interface WrapServersOptions extends WrapOptions {
  /** Bridge entries are ours already: never wrap them. */
  skipKey?: (key: string) => boolean
  onSkip?: (key: string, reason: 'unwrappable' | 'too-large' | 'missing-shim') => void
}

/**
 * Wrap every foreign stdio entry in place and return the wrapped names.
 * Idempotent: an entry that is already a wrapper is left untouched, so a
 * second host (or a second boot) does not nest proxies.
 */
export function wrapForeignServers(
  servers: Record<string, unknown>,
  opts: WrapServersOptions,
): { wrapped: string[]; skipped: string[] } {
  const wrapped: string[] = []
  const skipped: string[] = []
  const skipKey = opts.skipKey ?? (() => false)
  for (const [key, value] of Object.entries(servers)) {
    if (skipKey(key)) continue
    if (isSanitizeWrapper(value)) {
      // A wrapper from an older install may point at a shim that no longer
      // exists (plugin upgraded / moved). Re-point it at the live one.
      const live = isPlainObj(value) && Array.isArray(value.args) ? value.args[0] : undefined
      if (live === opts.shimScript && isPlainObj(value) && value.command === opts.nodeBin) {
        wrapped.push(key)
        continue
      }
      const original = unwrapServerSpec(value)
      const reWrapped = original === null ? null : wrapServerSpec(original, opts)
      if (reWrapped === null) {
        skipped.push(key)
        opts.onSkip?.(key, 'unwrappable')
        continue
      }
      servers[key] = reWrapped
      wrapped.push(key)
      continue
    }
    if (!isPlainObj(value) || typeof value.command !== 'string') {
      skipped.push(key)
      opts.onSkip?.(key, 'unwrappable')
      continue
    }
    if (JSON.stringify(value).length > MAX_WRAPPED_SPEC_CHARS) {
      skipped.push(key)
      opts.onSkip?.(key, 'too-large')
      continue
    }
    const next = wrapServerSpec(value as StdioServerSpec, opts)
    if (next === null) {
      skipped.push(key)
      opts.onSkip?.(key, 'unwrappable')
      continue
    }
    servers[key] = next
    wrapped.push(key)
  }
  return { wrapped, skipped }
}

/** Put every wrapper entry back to the original spec it carries. Returns restored keys. */
export function unwrapForeignServers(servers: Record<string, unknown>): string[] {
  const restored: string[] = []
  for (const [key, value] of Object.entries(servers)) {
    if (!isSanitizeWrapper(value)) continue
    const original = unwrapServerSpec(value)
    if (original === null) continue
    servers[key] = original
    restored.push(key)
  }
  return restored
}

/**
 * Repair one tool's schema the way Gemini's validator demands. Exported
 * separately so the shim and the tests share exactly one implementation.
 */
export function sanitizeToolSchema(raw: unknown): Record<string, unknown> {
  const schema = isPlainObj(raw) ? raw : {}
  const clean = sanitizeMcpSchema(schema)
  if (clean.type === undefined) clean.type = 'object'
  return enforceArrayItems(clean)
}

export interface SanitizedTools {
  tools: unknown[]
  /** Names whose schema actually changed (log once per `tools/list`). */
  repaired: string[]
}

/** Rewrite `tools[].inputSchema` in a `tools/list` payload. */
export function sanitizeTools(tools: unknown): SanitizedTools {
  if (!Array.isArray(tools)) return { tools: [], repaired: [] }
  const repaired: string[] = []
  const out = tools.map((tool) => {
    if (!isPlainObj(tool)) return tool
    const before = JSON.stringify(tool.inputSchema ?? {})
    const inputSchema = sanitizeToolSchema(tool.inputSchema)
    if (JSON.stringify(inputSchema) !== before) {
      repaired.push(typeof tool.name === 'string' ? tool.name : '(unnamed)')
    }
    return { ...tool, inputSchema }
  })
  return { tools: out, repaired }
}