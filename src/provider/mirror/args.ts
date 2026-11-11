// Recorded-tool argument reading and normalization helpers.
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h). agy serializes some
// tool args as a JSON string and MCP tools arrive wrapped; every helper here
// normalizes those shapes for the cards and the executor.
export interface UnwrappedToolCall {
  tool: string
  input: Record<string, unknown>
  server?: string
  isMcp: boolean
}

/** agy serializes some tool args as a JSON string; presenters get an object. */
export function toolInput(args: { input?: unknown }): Record<string, unknown> {
  const raw = args.input
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed }
    } catch {
      return { value: raw }
    }
  }
  return { value: raw }
}

export function cleanString(val: unknown): string {
  if (typeof val !== 'string') return ''
  let s = val.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  return s
}

export function parseInnerArgs(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    let s = raw.trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      try {
        const unquoted = JSON.parse(s) as unknown
        if (typeof unquoted === 'string') s = unquoted.trim()
      } catch {
        // ignore
      }
    }
    try {
      const parsed = JSON.parse(s) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { value: parsed }
    } catch {
      return { value: raw }
    }
  }
  return { value: raw }
}

export function unwrapMcpTool(toolName: string, rawArgs: unknown): UnwrappedToolCall {
  const input = toolInput({ input: rawArgs })
  const isMetaMcp = /^(call_mcp_tool|callMcpTool|call_mcp|mcp_call)$/i.test(toolName)
  if (isMetaMcp) {
    const server = cleanString(pick(input, 'ServerName', 'server_name', 'serverName', 'server'))
    const innerTool = cleanString(pick(input, 'ToolName', 'tool_name', 'toolName', 'name', 'tool'))
    const rawInner = input.Arguments ?? input.arguments ?? input.args ?? input.parameters ?? input.params ?? input.input
    const innerInput = parseInnerArgs(rawInner)
    if (innerTool !== '') {
      return {
        tool: innerTool,
        input: innerInput,
        ...(server !== '' ? { server } : {}),
        isMcp: true,
      }
    }
  }

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__')
    if (parts.length >= 2) {
      const server = parts[0]
      const innerTool = parts.slice(1).join('__')
      return { tool: innerTool, input, ...(server ? { server } : {}), isMcp: true }
    }
  }

  return { tool: toolName, input, isMcp: false }
}

export function cleanResultText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as { content?: unknown }
      if (Array.isArray(obj?.content)) {
        const parts: string[] = []
        for (const item of obj.content) {
          const blk = item as { type?: string; text?: unknown }
          if (blk?.type === 'text' && typeof blk.text === 'string') {
            parts.push(blk.text)
          }
        }
        if (parts.length > 0) return parts.join('\n')
      }
    } catch {
      // not JSON
    }
  }
  return text
}

/**
 * agy serializes tool args with PascalCase keys (CommandLine, AbsolutePath,
 * SearchDirectory, TargetFile, TargetContent, ReplacementContent, CodeContent…);
 * pick() accepts all casing spellings so cards always read the real field
 * instead of falling back to raw JSON.
 */
export function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

export function resultText(content: unknown): string {
  const parts: string[] = []
  for (const b of Array.isArray(content) ? content : []) {
    const blk = b as { type?: string; text?: unknown }
    if (blk && blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
  }
  return parts.join('\n')
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '… (+' + (s.length - max) + ' chars)' : s
}