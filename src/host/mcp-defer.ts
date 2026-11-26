// Helpers for Issue #215: safe one-shot activation of lazy-loaded (deferred)
// DSH tools inside the active step boundary, with structured-signal detection,
// permission-denial guards, and visible retry provenance.
import type { StepSchemas } from './bridge-steps.ts'

export const DEFER_EXECUTE_TOOL_NAME = 'defer_execute_tool'

/**
 * Structured error codes emitted by DSH tool loaders when a lazy-loaded tool
 * must be activated before execution.
 */
export const DEFERRED_ERROR_CODES: ReadonlySet<string> = new Set([
  'TOOL_DEFERRED',
  'DEFERRED_TOOL_NOT_LOADED',
  'TOOL_NOT_LOADED',
  'E_TOOL_DEFERRED',
])

/**
 * Text fallback observed in DSH host lazy-loaded tool plugins (reported in
 * issue #215 against v0.6.96) when structured flags are unavailable.
 */
export const DEFERRED_TEXT_PATTERNS: readonly RegExp[] = [
  /\bdeferred\s+and\s+not\s+yet\s+loaded\b/i,
  /\bnot\s+yet\s+loaded\b[\s\S]*\bdefer_execute_tool\b/i,
]

const PERMISSION_DENIAL_CODES: ReadonlySet<string> = new Set([
  'PERMISSION_DENIED',
  'E_PERMISSION_DENIED',
  'TOOL_DENIED',
  'POLICY_DENIED',
  'UNAUTHORIZED',
  'FORBIDDEN',
])

const PERMISSION_DENIAL_PATTERNS: readonly RegExp[] = [
  /\bpermission\s+denied\b/i,
  /\bpolicy\s+denied\b/i,
  /\bnot\s+allowed\b/i,
  /\bunauthorized\b/i,
  /\baccess\s+denied\b/i,
]

function upperCode(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase() : ''
}

function readRecords(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!value || typeof value !== 'object') return out
  const rec = value as Record<string, unknown>
  out.push(rec)
  if (rec.error && typeof rec.error === 'object') out.push(rec.error as Record<string, unknown>)
  if (rec.cause && typeof rec.cause === 'object') out.push(rec.cause as Record<string, unknown>)
  return out
}

/** Never treat a permission/policy denial as a retryable deferred-tool signal. */
export function isPermissionDenial(value: unknown, text: string): boolean {
  for (const rec of readRecords(value)) {
    if (rec.denied === true || rec.permissionDenied === true) return true
    if (PERMISSION_DENIAL_CODES.has(upperCode(rec.code))) return true
    if (PERMISSION_DENIAL_CODES.has(upperCode(rec.errorCode))) return true
    if (PERMISSION_DENIAL_CODES.has(upperCode(rec.reason))) return true
  }
  return PERMISSION_DENIAL_PATTERNS.some((re) => re.test(text))
}

/** Detect whether a failed tool execution indicates an unloaded deferred tool. */
export function isDeferredToolSignal(value: unknown, text: string): boolean {
  if (isPermissionDenial(value, text)) return false
  for (const rec of readRecords(value)) {
    if (rec.deferred === true || rec.isDeferred === true) return true
    if (DEFERRED_ERROR_CODES.has(upperCode(rec.code))) return true
    if (DEFERRED_ERROR_CODES.has(upperCode(rec.errorCode))) return true
    const reason = typeof rec.reason === 'string' ? rec.reason.trim().toLowerCase() : ''
    const status = typeof rec.status === 'string' ? rec.status.trim().toLowerCase() : ''
    if (reason === 'deferred' || reason === 'tool_deferred' || status === 'deferred') return true
  }
  return DEFERRED_TEXT_PATTERNS.some((re) => re.test(text))
}

/**
 * Resolve `defer_execute_tool` arguments only when it is present in the
 * caller's admitted schemas and permitted by the bridge allowlist.
 */
export function resolveDeferActivationArgs(opts: {
  targetToolName: string
  admittedSchemas: StepSchemas | Array<{ name: string; parameters?: Record<string, unknown> }>
  allows: (name: string) => boolean
}): Record<string, string> | null {
  const { targetToolName, admittedSchemas, allows } = opts
  if (targetToolName === DEFER_EXECUTE_TOOL_NAME || !allows(DEFER_EXECUTE_TOOL_NAME)) return null
  const schema = admittedSchemas.find((tool) => tool.name === DEFER_EXECUTE_TOOL_NAME)
  if (!schema) return null
  const props = (schema.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  const preferredKeys = ['name', 'tool_name', 'toolName', 'tool']
  const key = props && typeof props === 'object'
    ? (preferredKeys.find((k) => k in props) ?? 'name')
    : 'name'
  return { [key]: targetToolName }
}

export type McpBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/** Prefix recovered output so DSH tool cards and logs show the auto-activation. */
export function annotateDeferredRetry(
  text: string,
  content: McpBlock[] | undefined,
  toolName: string,
): { text: string; content?: McpBlock[] } {
  const note = `[mcp-bridge: first call to "${toolName}" was deferred; activated via ${DEFER_EXECUTE_TOOL_NAME} and retried once]`
  return {
    text: text !== '' ? `${note}\n${text}` : note,
    ...(content ? { content: [{ type: 'text', text: note }, ...content] } : {}),
  }
}
