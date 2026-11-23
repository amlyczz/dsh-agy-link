// Reverse MCP Bridge schema hardening for Google Antigravity (`agy`).
//
// `agy` validates MCP tool schemas with Go RE2, enforces a strict 20,000-token
// toolbox ceiling (`ceil(utf8Bytes / 3)`, dropping the largest tools when over
// budget), and hides large tools behind lazy-loading unless marked with
// `_meta: { "antigravity/alwaysLoad": true }`.
//
// This pure module hardens DSH tool definitions so `agy`'s "building toolbox"
// stage never crashes and no tool is silently dropped or hidden.

export interface McpToolDef {
  name: string
  dshName: string
  description: string
  inputSchema: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export const AGY_MCP_SAFE_TOKEN_BUDGET = 18_000
export const AGY_ALWAYS_LOAD_META: Readonly<Record<string, boolean>> = {
  'antigravity/alwaysLoad': true,
}

const RE2_UNSUPPORTED_RE = /\(\?[=!<]|(^|[^\\])(?:\\\\)*\\[1-9]/

/**
 * Translate a JS regex pattern into Go RE2 syntax, or downgrade unsupported
 * features (lookarounds, backreferences) into a description note so `agy`
 * never aborts in "building toolbox".
 */
export function sanitizeRe2Pattern(raw: string): { pattern?: string; note?: string } {
  if (raw === '') return {}
  // Decode UTF-16 surrogate pairs `\uD800-\uDBFF\uDC00-\uDFFF` -> `\x{CODEPOINT}`
  let converted = raw.replace(
    /\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})/g,
    (_m, hiHex: string, loHex: string) => {
      const hi = Number.parseInt(hiHex, 16)
      const lo = Number.parseInt(loHex, 16)
      const cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
      return `\\x{${cp.toString(16).toUpperCase()}}`
    },
  )
  // Convert remaining BMP `\uXXXX` escapes to Go RE2 `\x{XXXX}`
  converted = converted.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => `\\x{${hex.toUpperCase()}}`)
  // Convert ES2015 `\u{XXXX}` to Go RE2 `\x{XXXX}`
  converted = converted.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, hex: string) => `\\x{${hex.toUpperCase()}}`)

  if (RE2_UNSUPPORTED_RE.test(converted)) {
    return { note: `Pattern: /${raw}/` }
  }
  return { pattern: converted }
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function resolveRef(
  ref: string,
  rootDefs: Record<string, unknown>,
  seen: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (seen.has(ref)) return null
  const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
  if (!m?.[1]) return null
  const key = m[1].replace(/~1/g, '/').replace(/~0/g, '~')
  const target = rootDefs[key]
  return isPlainObj(target) ? target : null
}

function mergeObjects(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base, ...extra }
  if (isPlainObj(base.properties) && isPlainObj(extra.properties)) {
    out.properties = { ...base.properties, ...extra.properties }
  }
  if (Array.isArray(base.required) || Array.isArray(extra.required)) {
    const req = new Set<string>([
      ...(Array.isArray(base.required) ? base.required.filter((x): x is string => typeof x === 'string') : []),
      ...(Array.isArray(extra.required) ? extra.required.filter((x): x is string => typeof x === 'string') : []),
    ])
    if (req.size > 0) out.required = [...req]
  }
  return out
}

function sanitizeNode(
  node: Record<string, unknown>,
  rootDefs: Record<string, unknown>,
  seenRefs: ReadonlySet<string>,
  depth: number,
): Record<string, unknown> {
  if (depth > 16) return { type: 'object' }
  let current: Record<string, unknown> = { ...node }

  if (typeof current.$ref === 'string') {
    const ref = current.$ref
    const resolved = resolveRef(ref, rootDefs, seenRefs)
    delete current.$ref
    if (resolved) {
      const nextSeen = new Set(seenRefs)
      nextSeen.add(ref)
      current = mergeObjects(sanitizeNode(resolved, rootDefs, nextSeen, depth + 1), current)
    }
  }

  if (Array.isArray(current.allOf)) {
    const branches = current.allOf
    delete current.allOf
    for (const b of branches) {
      if (isPlainObj(b)) {
        current = mergeObjects(current, sanitizeNode(b, rootDefs, seenRefs, depth + 1))
      }
    }
  }

  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(current[unionKey])) {
      const branches = (current[unionKey] as unknown[]).filter(isPlainObj)
      delete current[unionKey]
      const nonNull = branches.filter((b) => b.type !== 'null')
      if (nonNull.length === 1) {
        current = mergeObjects(sanitizeNode(nonNull[0]!, rootDefs, seenRefs, depth + 1), current)
      } else if (nonNull.length > 1) {
        let merged: Record<string, unknown> = {}
        const enumVals: unknown[] = []
        let allEnum = true
        for (const b of nonNull) {
          const clean = sanitizeNode(b, rootDefs, seenRefs, depth + 1)
          if (Array.isArray(clean.enum)) enumVals.push(...clean.enum)
          else allEnum = false
          merged = mergeObjects(merged, clean)
        }
        if (allEnum && enumVals.length > 0) merged.enum = [...new Set(enumVals)]
        current = mergeObjects(merged, current)
      }
    }
  }

  // Strip JSON Schema meta-keywords that waste token budget or confuse Go validators
  delete current.$schema
  delete current.$id
  delete current.$comment
  delete current.examples
  delete current.$defs
  delete current.definitions

  // Nullable type array `["string", "null"]` -> `"string"`
  if (Array.isArray(current.type)) {
    const nonNull = current.type.filter((t): t is string => typeof t === 'string' && t !== 'null')
    current.type = nonNull[0] ?? 'string'
  }

  // `const` -> single-value `enum`
  if ('const' in current) {
    if (current.enum === undefined) current.enum = [current.const]
    delete current.const
  }

  // Gemini rejects empty-string (and null) enum members with
  // `400 INVALID_ARGUMENT ... enum[N]: cannot be empty`, failing the whole
  // GenerateContentRequest even when the tool is never called. Drop them.
  if (Array.isArray(current.enum)) {
    current.enum = current.enum.filter((v) => v !== '' && v !== null)
  }

  // Drop empty `enum: []`
  if (Array.isArray(current.enum) && current.enum.length === 0) {
    delete current.enum
  }

  // Go RE2 pattern sanitization
  if (typeof current.pattern === 'string') {
    const checked = sanitizeRe2Pattern(current.pattern)
    if (checked.pattern !== undefined) {
      current.pattern = checked.pattern
    } else {
      delete current.pattern
      if (checked.note) {
        const prevDesc = typeof current.description === 'string' ? current.description.trim() : ''
        current.description = prevDesc ? `${prevDesc} (${checked.note})` : checked.note
      }
    }
  }

  // Recurse into object properties
  if (isPlainObj(current.properties)) {
    const nextProps: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(current.properties)) {
      nextProps[k] = isPlainObj(v) ? sanitizeNode(v, rootDefs, seenRefs, depth + 1) : v
    }
    current.properties = nextProps
  }

  // Ensure arrays always define `items`
  if (current.type === 'array') {
    if (isPlainObj(current.items)) {
      current.items = sanitizeNode(current.items, rootDefs, seenRefs, depth + 1)
    } else {
      current.items = { type: 'string' }
    }
  } else if (isPlainObj(current.items)) {
    current.items = sanitizeNode(current.items, rootDefs, seenRefs, depth + 1)
  }

  if (isPlainObj(current.additionalProperties)) {
    current.additionalProperties = sanitizeNode(current.additionalProperties, rootDefs, seenRefs, depth + 1)
  }

  return current
}

/**
 * Every path in `node` where a node claims `type: "array"` but carries no
 * `items`. Empty means the schema is safe to hand to Google's validator.
 *
 * Exported for the bridge self-check and for tests: Gemini rejects the WHOLE
 * request (`GenerateContentRequest.tools[0].function_declarations[N].parameters
 * .properties[args].items: missing field`) when a single declaration is
 * malformed, so "one bad tool kills the turn" is the failure mode to prevent.
 */
export function findArraysMissingItems(node: unknown, path = ''): string[] {
  const out: string[] = []
  const walk = (value: unknown, at: string, depth: number): void => {
    if (depth > 40 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`, depth + 1))
      return
    }
    const rec = value as Record<string, unknown>
    if (rec.type === 'array' && rec.items === undefined) out.push(at === '' ? '(root)' : at)
    for (const [k, v] of Object.entries(rec)) walk(v, at === '' ? k : `${at}.${k}`, depth + 1)
  }
  walk(node, path, 0)
  return out
}

/**
 * Last-line normalization: fill `items` for every array node, wherever it hides
 * (inside `anyOf` branches, `$ref` targets, `additionalProperties`…). Applied
 * AFTER `sanitizeMcpSchema` so no future sanitizer change can let a malformed
 * array escape the bridge.
 */
export function enforceArrayItems<T>(node: T): T {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 40 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const rec = value as Record<string, unknown>
    if (rec.type === 'array' && rec.items === undefined) rec.items = { type: 'string' }
    for (const v of Object.values(rec)) walk(v, depth + 1)
  }
  walk(node, 0)
  return node
}

/** Sanitize a single tool's JSON Schema for agy Go/RE2 compatibility. */
export function sanitizeMcpSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const defs: Record<string, unknown> = {
    ...(isPlainObj(raw.definitions) ? raw.definitions : {}),
    ...(isPlainObj(raw.$defs) ? raw.$defs : {}),
  }
  const clean = sanitizeNode(raw, defs, new Set(), 0)
  if (clean.type === undefined) clean.type = 'object'
  return clean
}

/** Match agy's internal token-budget estimator: `ceil(utf8Bytes / 3)`. */
export function estimateMcpToolsTokens(tools: readonly McpToolDef[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(tools), 'utf8') / 3)
}

function stripTitles(node: unknown): unknown {
  if (!isPlainObj(node)) return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'title') continue
    if (k === 'properties' && isPlainObj(v)) {
      const nextProps: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v)) nextProps[pk] = stripTitles(pv)
      out[k] = nextProps
    } else if (isPlainObj(v)) {
      out[k] = stripTitles(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function trimDescriptions(node: unknown, maxLen: number): unknown {
  if (!isPlainObj(node)) return node
  const out: Record<string, unknown> = { ...node }
  // Preserve contract-like descriptions on untyped/property-less objects slightly longer
  const isContractLeaf = !isPlainObj(out.properties) && (out.type === 'object' || out.type === undefined)
  const cap = isContractLeaf ? Math.max(maxLen, 120) : maxLen
  if (typeof out.description === 'string' && out.description.length > cap) {
    out.description = out.description.slice(0, Math.max(12, cap - 1)).trimEnd() + '…'
  }
  if (isPlainObj(out.properties)) {
    const nextProps: Record<string, unknown> = {}
    for (const [pk, pv] of Object.entries(out.properties)) {
      nextProps[pk] = trimDescriptions(pv, maxLen)
    }
    out.properties = nextProps
  }
  if (isPlainObj(out.items)) {
    out.items = trimDescriptions(out.items, maxLen)
  }
  return out
}

/**
 * Sanitize every tool's schema, attach `_meta: { 'antigravity/alwaysLoad': true }`,
 * and progressively trim verbose descriptions if the serialized toolbox exceeds
 * `maxTokens` (default 18,000, safely under agy's 20,000 hard drop ceiling).
 */
export function prepareMcpTools(
  rawTools: readonly McpToolDef[],
  maxTokens = AGY_MCP_SAFE_TOKEN_BUDGET,
): McpToolDef[] {
  let tools: McpToolDef[] = rawTools.map((t) => ({
    ...t,
    // `enforceArrayItems` is a post-condition, not a nicety: agy forwards these
    // schemas to Google verbatim, and one array without `items` fails the whole
    // turn with INVALID_ARGUMENT (see findArraysMissingItems).
    inputSchema: enforceArrayItems(sanitizeMcpSchema(t.inputSchema)),
    _meta: { ...AGY_ALWAYS_LOAD_META, ...(t._meta ?? {}) },
  }))

  if (estimateMcpToolsTokens(tools) <= maxTokens) return tools

  // Stage 1: strip `title` fields across schemas
  tools = tools.map((t) => ({ ...t, inputSchema: stripTitles(t.inputSchema) as Record<string, unknown> }))
  if (estimateMcpToolsTokens(tools) <= maxTokens) return tools

  // Stage 2: progressive description trimming (never drops any tool!)
  const caps = [320, 180, 100, 60, 32]
  for (const cap of caps) {
    tools = tools.map((t) => ({
      ...t,
      description: t.description.length > cap ? t.description.slice(0, cap - 1).trimEnd() + '…' : t.description,
      inputSchema: trimDescriptions(t.inputSchema, cap) as Record<string, unknown>,
    }))
    if (estimateMcpToolsTokens(tools) <= maxTokens) return tools
  }

  return tools
}

/** Extract MCP-compatible content blocks (text + image) when a tool returns image blocks. */
export function extractMcpContentBlocks(
  result: unknown,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> | undefined {
  if (result === null || result === undefined) return undefined
  const r = result as { content?: unknown }
  if (!Array.isArray(r.content)) return undefined
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
  let hasImage = false
  for (const b of r.content) {
    if (!b || typeof b !== 'object') continue
    const blk = b as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; mediaType?: unknown }
    if (blk.type === 'text' && typeof blk.text === 'string') {
      blocks.push({ type: 'text', text: blk.text })
    } else if (blk.type === 'image' && typeof blk.data === 'string' && blk.data !== '') {
      const mimeType = typeof blk.mimeType === 'string' && blk.mimeType !== ''
        ? blk.mimeType
        : (typeof blk.mediaType === 'string' && blk.mediaType !== '' ? blk.mediaType : 'image/png')
      blocks.push({ type: 'image', data: blk.data, mimeType })
      hasImage = true
    }
  }
  return hasImage ? blocks : undefined
}
